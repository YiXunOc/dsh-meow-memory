import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'meow-task-journal-'))
const { outputFiles } = await build({ entryPoints: ['src/task-journal.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { TaskJournal, registerTaskMetadataRoute } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'))
try {
  const journal = new TaskJournal(dir)
  const peer = new TaskJournal(dir)
  const task = journal.start({ parentId: 'parent', kind: 'reflect', turn: 7, anchorSeq: 42, childId: 'child' })
  const sibling = peer.start({ parentId: 'parent', kind: 'dream', childId: 'other' })
  assert.deepEqual(journal.list('parent').map(t => t.id).sort(), [task.id, sibling.id].sort())
  journal.start({ parentId: 'parent', kind: 'reflect', childId: 'child-2', taskId: task.id })
  assert.deepEqual(peer.get(task.id).childIds, ['child', 'child-2'])
  peer.recordChildEvent('child', { type: 'tool/result', data: { message: { isError: true } } })
  journal.finish(task.id, true)
  assert.equal(peer.get(task.id).status, 'failed')
  peer.recordChildEvent('other', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Reviewed; no change.' }] } } })
  peer.finish(sibling.id, true)
  assert.equal(journal.get(sibling.id).status, 'done')
  const continuing = peer.start({ parentId: 'parent', kind: 'dream', childId: 'continuing' })
  peer.recordChildEvent('continuing', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Thinking before tool call' }, { type: 'tool-call', name: 'memory_search' }] } } })
  peer.recordChildEvent('continuing', { type: 'tool/result', data: { message: { isError: false } } })
  peer.finish(continuing.id, true)
  assert.equal(peer.get(continuing.id).status, 'failed', 'tool preface without final answer is not a reviewed outcome')
  const partial = peer.start({ parentId: 'parent', kind: 'dream', childId: 'first' })
  peer.recordChildEvent('first', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'First round reviewed' }] } } })
  peer.start({ parentId: 'parent', kind: 'dream', childId: 'second', taskId: partial.id })
  peer.finish(partial.id, true)
  assert.equal(peer.get(partial.id).status, 'failed', 'earlier round outcome cannot justify a silent later round')
  assert.deepEqual(journal.list('elsewhere'), [])
  assert.throws(() => peer.start({ parentId: 'elsewhere', kind: 'reflect', childId: 'x', taskId: task.id }), /owner mismatch/)
  const pending = peer.start({ parentId: 'parent', kind: 'dream', childId: 'pending' })
  const recycled = peer.start({ parentId: 'parent', kind: 'reflect', childId: 'recycled' })
  const stale = { ...recycled, startedAt: Date.now() - 25 * 3600_000, ownerPid: process.pid }
  peer.db.prepare('UPDATE tasks SET ownerPid=?, data=? WHERE id=?').run(process.pid, JSON.stringify(stale), recycled.id)
  assert.equal(peer.list('parent').find(t => t.id === recycled.id).status, 'failed', 'expired owner lease must not trust a reused live PID')
  assert.ok(peer.get(recycled.id).endedAt)
  const overdue = peer.start({ parentId: 'parent', kind: 'reflect', childId: 'overdue' })
  peer.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({ ...overdue, startedAt: Date.now() - 25 * 3600_000 }), overdue.id)
  peer.finish(overdue.id, true)
  assert.equal(peer.get(overdue.id).status, 'failed', 'late child completion cannot revive expired task')
  // A new instance must not mark work owned by a still-live instance failed.
  const live = new TaskJournal(dir)
  assert.equal(live.get(pending.id).status, 'running')
  live.close()
  const dead = peer.start({ parentId: 'parent', kind: 'dream', childId: 'dead' })
  // A crashed process cannot close its journal; startup must reconcile its row.
  peer.db.prepare('UPDATE tasks SET ownerPid=? WHERE id=?').run(2147483647, dead.id)
  peer.close()
  journal.close()
  const restored = new TaskJournal(dir)
  assert.equal(restored.get(dead.id).status, 'failed')
  assert.ok(restored.get(dead.id).endedAt)
  assert.equal(restored.get(pending.id).status, 'failed')
  assert.ok(restored.get(pending.id).endedAt)
  assert.equal(restored.get(task.id).status, 'failed')
  // Metadata route only; even a hostile taskId must not cause a transcript read.
  const routes = new Map()
  const connection = { fetch: { register(route) {
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } }
  const root = new Context()
  root.reflect.provide('connection', connection, undefined)
  const scope = root.plugin({
    name: 'meow-task-metadata-route',
    apply(ctx) { ctx.effect(() => registerTaskMetadataRoute(connection, journal)) }
  })
  await scope
  const route = routes.get('/api/meow-memory/tasks')
  assert.equal(route?.requestBody, 'buffered')
  assert.deepEqual(route?.methods, ['GET'])
  const response = await route.fetch(new Request(`http://localhost/api/meow-memory/tasks?parentId=parent&taskId=${task.id}`))
  assert.ok(!JSON.stringify(await response.json()).includes('process'))
  await root.fiber.dispose()
  assert.equal(routes.size, 0)
  restored.close()
  const firstHome = join(dir, 'home-a'), secondHome = join(dir, 'home-b')
  let currentHome = firstHome
  const switched = new TaskJournal(() => currentHome)
  const changing = switched.start({ parentId: 'p', kind: 'reflect', childId: 'switch-child' })
  currentHome = secondHome
  assert.deepEqual(switched.list('p'), [], 'hot home switch reads new location')
  assert.equal(new TaskJournal(firstHome).get(changing.id).status, 'failed', 'hot switch retires old pending work')
  switched.close()
  const legacy = join(dir, 'legacy')
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'memory-tasks.json'), JSON.stringify([{ id: 'legacy-id', parentId: 'p', kind: 'dream', childIds: ['old-child'], status: 'running', startedAt: 1 }]))
  const imported = new TaskJournal(legacy)
  assert.equal(imported.get('legacy-id').status, 'failed')
  imported.close()
  assert.equal(new TaskJournal(legacy).get('legacy-id').status, 'failed')
  console.log('task journal concurrent owners, persistence and reconciliation: passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
