import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export interface MemoryTask {
  id: string
  parentId: string
  kind: 'reflect' | 'dream'
  turn?: number
  anchorSeq?: number
  childIds: string[]
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  toolError?: boolean
  result?: string
  reviewedChild?: string
}

type StoredTask = MemoryTask & { ownerPid?: number; ownerId?: string }
const TASK_LEASE_MS = 24 * 3600_000

export function registerTaskMetadataRoute(connection: {
  fetch: { register: (route: { path: string; methods: string[]; requestBody: 'buffered'; fetch: (request: Request) => Promise<Response> }) => () => Promise<void> }
}, journal: TaskJournal): () => Promise<void> {
  return connection.fetch.register({
    path: '/api/meow-memory/tasks', methods: ['GET'], requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      const parentId = new URL(request.url).searchParams.get('parentId')
      if (!parentId || parentId.length > 256) return Response.json({ error: 'parentId required' }, { status: 400 })
      return Response.json({ tasks: journal.list(parentId) }, { headers: { 'Cache-Control': 'no-store' } })
    },
  })
}

/** A task is a single SQLite row; mutations are serialized across plugin instances. */
export class TaskJournal {
  private db!: DatabaseSync
  private path = ''
  private readonly ownerId = randomUUID()
  constructor(private readonly directory: string | (() => string)) { this.ensureOpen() }

  private ensureOpen(): void {
    const dir = typeof this.directory === 'function' ? this.directory() : this.directory
    if (this.path === dir) return
    this.close() // a home switch retires this fiber's pending task rows before rebinding
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'memory-tasks.sqlite'), { timeout: 5000 })
    db.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, parentId TEXT NOT NULL, childIds TEXT NOT NULL, status TEXT NOT NULL, ownerPid INTEGER, ownerId TEXT, data TEXT NOT NULL)')
    db.exec('CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parentId)')
    this.db = db
    this.path = dir
    const legacy = join(dir, 'memory-tasks.json')
    if (existsSync(legacy)) {
      const tasks = JSON.parse(readFileSync(legacy, 'utf8')) as MemoryTask[]
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const task of tasks) this.put({ ...task, ...(task.status === 'running' ? { status: 'failed' as const, endedAt: Date.now() } : {}) }, true)
        db.exec('COMMIT')
        renameSync(legacy, `${legacy}.migrated`)
      } catch (error) { db.exec('ROLLBACK'); throw error }
    }
    // A PID can be reused. Even a live owner cannot hold a task past the persisted bound.
    for (const row of db.prepare("SELECT data, ownerPid FROM tasks WHERE status = 'running'").all() as Array<{ data: string; ownerPid: number | null }>) {
      const task = JSON.parse(row.data) as StoredTask
      let alive = false
      if (row.ownerPid && row.ownerPid !== process.pid) {
        try { process.kill(row.ownerPid, 0); alive = true } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM' }
      } else if (row.ownerPid === process.pid) alive = true
      if (!alive || Date.now() - task.startedAt >= TASK_LEASE_MS) this.finish(task.id, false)
    }
  }
  private put(task: StoredTask, ignore = false): void {
    this.db.prepare(`${ignore ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE'} INTO tasks (id,parentId,childIds,status,ownerPid,ownerId,data) VALUES (?,?,?,?,?,?,?)`)
      .run(task.id, task.parentId, JSON.stringify(task.childIds), task.status, task.ownerPid ?? null, task.ownerId ?? null, JSON.stringify(task))
  }
  private read(id: string): StoredTask | undefined {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) as StoredTask : undefined
  }
  private transaction<T>(operation: () => T): T {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  start(spec: { parentId: string; kind: MemoryTask['kind']; turn?: number; anchorSeq?: number; childId: string; taskId?: string }): MemoryTask {
    return this.transaction(() => {
      let task = spec.taskId ? this.read(spec.taskId) : undefined
      if (task && task.parentId !== spec.parentId) throw new Error('task owner mismatch')
      if (!task) task = { id: spec.taskId ?? randomUUID(), parentId: spec.parentId, kind: spec.kind,
        turn: spec.turn, anchorSeq: spec.anchorSeq, childIds: [], status: 'running', startedAt: Date.now(), ownerPid: process.pid, ownerId: this.ownerId }
      if (!task.childIds.includes(spec.childId)) {
        task.childIds.push(spec.childId)
        task.reviewedChild = undefined
      }
      this.put(task)
      return task
    })
  }
  private expire(task: StoredTask | undefined): StoredTask | undefined {
    if (task?.status === 'running' && Date.now() - task.startedAt >= TASK_LEASE_MS) {
      this.finish(task.id, false)
      return this.read(task.id)
    }
    return task
  }
  get(id: string): MemoryTask | undefined { this.ensureOpen(); return this.expire(this.read(id)) }
  list(parentId: string): MemoryTask[] {
    this.ensureOpen()
    return (this.db.prepare('SELECT data FROM tasks WHERE parentId = ? ORDER BY rowid').all(parentId) as Array<{ data: string }>).map(row => this.expire(JSON.parse(row.data) as StoredTask)!)
  }
  taskForChild(id: string): MemoryTask | undefined {
    this.ensureOpen()
    const row = this.db.prepare("SELECT data FROM tasks WHERE EXISTS (SELECT 1 FROM json_each(tasks.childIds) WHERE value = ?) LIMIT 1").get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) as MemoryTask : undefined
  }
  recordChildEvent(id: string, event: { type?: string; data?: { message?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } } }): void {
    const content = event.data?.message?.content
    const text = event.type === 'assistant/message' && !content?.some(b => b.type === 'tool-call') ? content?.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim() : undefined
    if (!text && event.type !== 'tool/result' && event.type !== 'assistant/message') return
    this.transaction(() => {
      const task = this.taskForChild(id) as StoredTask | undefined
      if (task?.status === 'running') {
        if (event.type === 'assistant/message') {
          task.reviewedChild = text ? id : undefined
          if (text) task.result = text.slice(0, 1200)
        }
        if (event.type === 'tool/result') task.reviewedChild = undefined
        if (event.type === 'tool/result' && event.data?.message?.isError === true) task.toolError = true
        this.put(task)
      }
    })
  }
  finish(id: string, ok: boolean): void {
    this.transaction(() => {
      const task = this.read(id)
      if (!task || task.status !== 'running') return
      task.status = ok && !task.toolError && task.reviewedChild === task.childIds.at(-1) && Date.now() - task.startedAt < TASK_LEASE_MS ? 'done' : 'failed'
      if (!task.reviewedChild) task.result = '子任务未提供审查结论；不能确认已完成审查。'
      task.endedAt = Date.now()
      this.put(task)
    })
  }
  close(): void {
    if (!this.path) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of this.db.prepare("SELECT data FROM tasks WHERE status='running' AND ownerId=?").all(this.ownerId) as Array<{ data: string }>) {
        const task = JSON.parse(row.data) as StoredTask
        task.status = 'failed'; task.endedAt = Date.now()
        this.put(task)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.db.close()
    this.path = ''
  }
}
