import { Worker } from 'node:worker_threads'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  readSessionMigrationState,
  tryAcquireSessionMigrationLock,
  type SessionMigrationLock,
  type SessionMigrationFileState,
  type SessionMigrationState,
  type SessionMigrationTotals,
} from './migration-state.js'

export type MigrationCoordinatorPhase =
  | 'idle'
  | 'scheduled'
  | 'waiting'
  | 'starting'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed-with-errors'
  | 'failed'
  | 'disposed'

export interface MigrationCoordinatorStatus {
  phase: MigrationCoordinatorPhase
  state?: SessionMigrationState
  error?: string
}

export interface MigrationLogger {
  info(message: string): void
  warn(message: string): void
}

export interface MigrationCoordinatorOptions {
  dshHome?: string
  startDelayMs?: number
  lockRetryMs?: number
  stopTimeoutMs?: number
  workerUrl?: URL
  logger?: MigrationLogger
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'progress'; totals: SessionMigrationTotals; file: SessionMigrationFileState }
  | { type: 'paused'; state: SessionMigrationState }
  | { type: 'completed'; state: SessionMigrationState }
  | { type: 'failed'; error: string }

const DEFAULT_START_DELAY_MS = 5_000
const DEFAULT_LOCK_RETRY_MS = 30_000
const DEFAULT_STOP_TIMEOUT_MS = 2_000

/** Host-side lifecycle owner. It never scans or decompresses session files. */
export class SessionMigrationCoordinator {
  readonly dshHome: string
  private readonly startDelayMs: number
  private readonly lockRetryMs: number
  private readonly stopTimeoutMs: number
  private readonly workerUrl: URL
  private readonly logger: MigrationLogger | undefined
  private phase: MigrationCoordinatorPhase = 'idle'
  private error: string | undefined
  private latestState: SessionMigrationState | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private worker: Worker | undefined
  private lock: SessionMigrationLock | undefined
  private disposed = false

  constructor(options: MigrationCoordinatorOptions = {}) {
    this.dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    this.startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
    this.workerUrl = options.workerUrl ?? new URL('./migration-worker.js', import.meta.url)
    this.logger = options.logger
  }

  schedule(): void {
    if (this.disposed || this.worker !== undefined || this.timer !== undefined) return
    this.phase = 'scheduled'
    this.armTimer(this.startDelayMs)
  }

  retry(): boolean {
    if (this.disposed || this.worker !== undefined) return false
    this.clearTimer()
    this.error = undefined
    return this.launch()
  }

  pause(): boolean {
    if (this.disposed) return false
    if (this.worker !== undefined) {
      this.worker.postMessage({ type: 'pause' })
      return true
    }
    if (this.timer !== undefined || this.phase === 'waiting' || this.phase === 'scheduled') {
      this.clearTimer()
      this.phase = 'paused'
      return true
    }
    return this.phase === 'paused'
  }

  status(): MigrationCoordinatorStatus {
    const persisted = readSessionMigrationState(this.dshHome)
    return {
      phase: this.phase,
      ...(persisted === undefined ? (this.latestState === undefined ? {} : { state: this.latestState }) : { state: persisted }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    this.phase = 'disposed'
    const worker = this.worker
    if (worker === undefined) {
      this.releaseLock()
      return
    }

    worker.postMessage({ type: 'stop' })
    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
      }
      const timeout = setTimeout(() => {
        void worker.terminate().finally(finish)
      }, this.stopTimeoutMs)
      worker.once('exit', finish)
    })
    this.finishWorker()
  }

  private armTimer(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.launch()
    }, Math.max(0, delayMs))
    this.timer.unref()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private launch(): boolean {
    if (this.disposed || this.worker !== undefined) return false
    try {
      this.lock = tryAcquireSessionMigrationLock(this.dshHome)
    } catch (error) {
      this.fail(`could not acquire migration lock: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }

    if (this.lock === undefined) {
      this.phase = 'waiting'
      this.armTimer(this.lockRetryMs)
      return false
    }

    this.phase = 'starting'
    let worker: Worker
    try {
      worker = new Worker(this.workerUrl, { workerData: { dshHome: this.dshHome } })
    } catch (error) {
      this.releaseLock()
      this.fail(`could not start migration worker: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    this.worker = worker
    worker.unref()
    worker.on('message', message => this.onWorkerMessage(message as WorkerMessage))
    worker.on('error', error => this.fail(`migration worker error: ${error.stack ?? error.message}`))
    worker.on('exit', code => {
      if (!this.disposed && code !== 0 && this.phase !== 'failed') this.fail(`migration worker exited with code ${code}`)
      this.finishWorker()
    })
    return true
  }

  private onWorkerMessage(message: WorkerMessage): void {
    if (this.disposed) return
    if (message.type === 'ready') {
      this.phase = 'running'
      this.logger?.info('meow-memory: background session migration started')
      return
    }
    if (message.type === 'progress') {
      this.phase = 'running'
      return
    }
    if (message.type === 'paused') {
      this.latestState = message.state
      this.phase = 'paused'
      this.logger?.info('meow-memory: background session migration paused')
      return
    }
    if (message.type === 'completed') {
      this.latestState = message.state
      this.phase = message.state.status === 'completed-with-errors' ? 'completed-with-errors' : 'completed'
      this.logger?.info(`meow-memory: background session migration ${message.state.status}`)
      return
    }
    this.fail(message.error)
  }

  private fail(message: string): void {
    this.error = message
    this.phase = 'failed'
    this.logger?.warn(`meow-memory: ${message}`)
  }

  private finishWorker(): void {
    this.worker = undefined
    this.releaseLock()
  }

  private releaseLock(): void {
    this.lock?.release()
    this.lock = undefined
  }
}

export interface MigrationCommandDefinition {
  readonly name: 'memory_migration'
  readonly description: string
  readonly input: { hint: string }
  readonly handler: (invocation: { rawInput?: string }) => { kind: 'success' | 'error'; text: string }
}

function formatStatus(status: MigrationCoordinatorStatus): string {
  const totals = status.state?.totals
  const detail = totals === undefined
    ? '尚无迁移检查点。'
    : `发现 ${totals.discovered}，完成 ${totals.done}，已改写 ${totals.migratedFiles}，失败 ${totals.failed}，延后 ${totals.deferred}。`
  return `会话迁移状态：${status.phase}。${detail}${status.error === undefined ? '' : ` 错误：${status.error}`}`
}

export function migrationCommandDefinition(coordinator: SessionMigrationCoordinator): MigrationCommandDefinition {
  return {
    name: 'memory_migration',
    description: '查看、重试或暂停 meow-memory 历史会话后台迁移。',
    input: { hint: 'status | retry | pause' },
    handler(invocation) {
      const action = invocation.rawInput?.trim().toLowerCase() || 'status'
      if (action === 'status') return { kind: 'success', text: formatStatus(coordinator.status()) }
      if (action === 'retry') {
        return coordinator.retry()
          ? { kind: 'success', text: '历史会话迁移已请求启动。' }
          : { kind: 'error', text: `当前无法重试。${formatStatus(coordinator.status())}` }
      }
      if (action === 'pause') {
        return coordinator.pause()
          ? { kind: 'success', text: '历史会话迁移将在当前文件处理完成后暂停。' }
          : { kind: 'error', text: `当前没有可暂停的迁移。${formatStatus(coordinator.status())}` }
      }
      return { kind: 'error', text: '用法：/memory_migration status | retry | pause' }
    },
  }
}