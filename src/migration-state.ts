import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const SESSION_MIGRATION_ID = 'source-memory-v2'
export const SESSION_MIGRATION_SCHEMA_VERSION = 1

export type SessionMigrationStatus =
  | 'idle'
  | 'scheduled'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'completed-with-errors'

export interface SessionFileIdentity {
  size: number
  mtimeMs: number
}

export interface SessionMigrationFileState {
  relativePath: string
  identity: SessionFileIdentity
  status: 'done' | 'failed' | 'deferred'
  result?: 'unchanged' | 'migrated'
  migratedLines: number
  attempts: number
  error?: string
  updatedAt: string
}

export interface SessionMigrationTotals {
  discovered: number
  done: number
  migratedFiles: number
  migratedLines: number
  failed: number
  deferred: number
}

export interface SessionMigrationState {
  schemaVersion: 1
  migration: typeof SESSION_MIGRATION_ID
  dshHomeFingerprint: string
  status: SessionMigrationStatus
  runId?: string
  startedAt?: string
  updatedAt: string
  completedAt?: string
  totals: SessionMigrationTotals
  files: Record<string, SessionMigrationFileState>
}

export interface SessionMigrationPaths {
  root: string
  state: string
  lock: string
  log: string
}

export interface SessionMigrationLock {
  ownerId: string
  release(): void
}

export function sessionMigrationPaths(dshHome: string): SessionMigrationPaths {
  const root = join(resolve(dshHome), 'meow-memory')
  return {
    root,
    state: join(root, 'migrations', `${SESSION_MIGRATION_ID}.json`),
    lock: join(root, 'migrations', `${SESSION_MIGRATION_ID}.lock`),
    log: join(root, 'logs', 'migration.log'),
  }
}

export function dshHomeFingerprint(dshHome: string, platform: NodeJS.Platform = process.platform): string {
  const canonical = platform === 'win32' ? resolve(dshHome).toLowerCase() : resolve(dshHome)
  return createHash('sha256').update(canonical).digest('hex')
}

export function emptySessionMigrationState(dshHome: string): SessionMigrationState {
  return {
    schemaVersion: SESSION_MIGRATION_SCHEMA_VERSION,
    migration: SESSION_MIGRATION_ID,
    dshHomeFingerprint: dshHomeFingerprint(dshHome),
    status: 'idle',
    updatedAt: new Date().toISOString(),
    totals: { discovered: 0, done: 0, migratedFiles: 0, migratedLines: 0, failed: 0, deferred: 0 },
    files: {},
  }
}

const SESSION_STATUSES = new Set<SessionMigrationStatus>([
  'idle',
  'scheduled',
  'running',
  'waiting',
  'paused',
  'failed',
  'completed',
  'completed-with-errors',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false
  return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

function validIdentity(value: unknown): value is SessionFileIdentity {
  if (!isRecord(value)) return false
  return isNonNegativeInteger(value.size)
    && typeof value.mtimeMs === 'number'
    && Number.isFinite(value.mtimeMs)
    && value.mtimeMs >= 0
}

function validFileState(key: string, value: unknown): value is SessionMigrationFileState {
  if (!isRecord(value) || !isRelativePath(key) || key.includes('\\') || value.relativePath !== key) return false
  if (!validIdentity(value.identity)) return false
  if (value.status !== 'done' && value.status !== 'failed' && value.status !== 'deferred') return false
  if (value.status === 'done' && value.result !== 'unchanged' && value.result !== 'migrated') return false
  if (value.status !== 'done' && value.result !== undefined) return false
  if (value.result === 'unchanged' && value.migratedLines !== 0) return false
  return isNonNegativeInteger(value.migratedLines)
    && isNonNegativeInteger(value.attempts)
    && value.attempts > 0
    && typeof value.updatedAt === 'string'
    && (value.error === undefined || typeof value.error === 'string')
}

function validTotals(value: unknown): value is SessionMigrationTotals {
  if (!isRecord(value)) return false
  return isNonNegativeInteger(value.discovered)
    && isNonNegativeInteger(value.done)
    && isNonNegativeInteger(value.migratedFiles)
    && isNonNegativeInteger(value.migratedLines)
    && isNonNegativeInteger(value.failed)
    && isNonNegativeInteger(value.deferred)
}

function validState(value: unknown): value is SessionMigrationState {
  if (!isRecord(value)) return false
  const state = value as Partial<SessionMigrationState>
  if (state.schemaVersion !== SESSION_MIGRATION_SCHEMA_VERSION
    || state.migration !== SESSION_MIGRATION_ID
    || typeof state.dshHomeFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(state.dshHomeFingerprint)
    || typeof state.status !== 'string'
    || !SESSION_STATUSES.has(state.status as SessionMigrationStatus)
    || typeof state.updatedAt !== 'string'
    || !validTotals(state.totals)
    || !isRecord(state.files)) return false
  if (state.runId !== undefined && typeof state.runId !== 'string') return false
  if (state.startedAt !== undefined && typeof state.startedAt !== 'string') return false
  if (state.completedAt !== undefined && typeof state.completedAt !== 'string') return false
  const files = state.files as Record<string, SessionMigrationFileState>
  if (!Object.entries(files).every(([key, file]) => validFileState(key, file))) return false
  const computed = migrationTotals(files, state.totals.discovered)
  return Object.entries(computed).every(([key, value]) => state.totals?.[key as keyof SessionMigrationTotals] === value)
}

export function readSessionMigrationState(dshHome: string): SessionMigrationState | undefined {
  try {
    const state = JSON.parse(readFileSync(sessionMigrationPaths(dshHome).state, 'utf8')) as unknown
    if (!validState(state) || state.dshHomeFingerprint !== dshHomeFingerprint(dshHome)) return undefined
    return state
  } catch {
    return undefined
  }
}

export function writeSessionMigrationState(dshHome: string, state: SessionMigrationState): void {
  const path = sessionMigrationPaths(dshHome).state
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function migrationTotals(
  files: Record<string, SessionMigrationFileState>,
  discovered: number,
): SessionMigrationTotals {
  const values = Object.values(files)
  return {
    discovered,
    done: values.filter(file => file.status === 'done').length,
    migratedFiles: values.filter(file => file.status === 'done' && file.result === 'migrated').length,
    migratedLines: values.reduce((total, file) => total + (file.status === 'done' ? file.migratedLines : 0), 0),
    failed: values.filter(file => file.status === 'failed').length,
    deferred: values.filter(file => file.status === 'deferred').length,
  }
}

export function appendMigrationLog(dshHome: string, message: string): void {
  const path = sessionMigrationPaths(dshHome).log
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `[${new Date().toISOString()}] ${message}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' })
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

function existingLockState(path: string): 'live' | 'stale' | 'unknown' {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1) return 'unknown'
    return processIsAlive(value.pid) ? 'live' : 'stale'
  } catch {
    return 'unknown'
  }
}

export function tryAcquireSessionMigrationLock(dshHome: string): SessionMigrationLock | undefined {
  const path = sessionMigrationPaths(dshHome).lock
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const ownerId = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | undefined
    let created = false
    try {
      descriptor = openSync(path, 'wx', 0o600)
      created = true
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, ownerId, startedAt: new Date().toISOString() })}\n`)
      closeSync(descriptor)
      descriptor = undefined
      return {
        ownerId,
        release(): void {
          try {
            const value = JSON.parse(readFileSync(path, 'utf8')) as { ownerId?: unknown }
            if (value.ownerId === ownerId) rmSync(path, { force: true })
          } catch {
            // A missing or replaced lock no longer belongs to this owner.
          }
        },
      }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      if (created) {
        rmSync(path, { force: true })
        throw error
      }
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error
      // Atomically claim the stale inode before replacing it. With two contenders,
      // only one rename can succeed; the other sees ENOENT and stays out.
      if (existingLockState(path) !== 'stale') return undefined
      const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`
      try {
        renameSync(path, stalePath)
      } catch {
        return undefined
      }
      if (existingLockState(stalePath) !== 'stale') {
        try {
          renameSync(stalePath, path)
        } catch {
          // Keep the isolated lock instead of deleting an owner we cannot prove stale.
        }
        return undefined
      }
      rmSync(stalePath, { force: true })
    }
  }
  return undefined
}