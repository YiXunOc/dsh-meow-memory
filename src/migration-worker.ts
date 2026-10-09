import { parentPort, workerData } from 'node:worker_threads'
import { runSessionMigration, type SessionMigrationStopReason } from './migrate-v0.js'
import { appendMigrationLog, emptySessionMigrationState, readSessionMigrationState, writeSessionMigrationState } from './migration-state.js'

interface MigrationWorkerData {
  dshHome: string
}

const port = parentPort
if (port === null) throw new Error('migration-worker must run in a Worker Thread')

const data = workerData as MigrationWorkerData
if (typeof data?.dshHome !== 'string' || data.dshHome.length === 0) {
  throw new Error('migration-worker requires dshHome')
}

let stopReason: SessionMigrationStopReason | false = false
port.on('message', (message: unknown) => {
  const type = (message as { type?: unknown } | null)?.type
  if (type === 'pause' || type === 'stop') stopReason = type
})

port.postMessage({ type: 'ready' })

try {
  const state = await runSessionMigration(data.dshHome, {
    shouldStop: () => stopReason,
    log: message => appendMigrationLog(data.dshHome, message),
    onProgress: (nextState, file) => {
      port.postMessage({ type: 'progress', totals: nextState.totals, file })
    },
  })
  port.postMessage({ type: state.status === 'paused' ? 'paused' : 'completed', state })
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  try {
    const state = readSessionMigrationState(data.dshHome) ?? emptySessionMigrationState(data.dshHome)
    state.status = 'failed'
    state.updatedAt = new Date().toISOString()
    writeSessionMigrationState(data.dshHome, state)
    appendMigrationLog(data.dshHome, `migration worker failed: ${message}`)
  } catch {
    // Preserve the original failure when state/log persistence also fails.
  }
  port.postMessage({ type: 'failed', error: message })
} finally {
  port.close()
}