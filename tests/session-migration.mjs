import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  SessionMigrationCoordinator,
  processSessionFile,
  readSessionMigrationState,
  runSessionMigration,
  sessionMigrationPaths,
  tryAcquireSessionMigrationLock,
} from '../lib/index.js'

const ZSTD_MAGIC = 0xfd2fb528
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function frameRanges(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    assert.equal(buffer.readUInt32LE(offset), ZSTD_MAGIC)
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

function decompressContainer(buffer) {
  return Buffer.concat(frameRanges(buffer).map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)))).toString('utf8')
}

function legacySnapshot(id) {
  return {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: `memory-${id}` }],
      source: {
        kind: 'plugin',
        plugin: 'meow-memory',
        form: 'snapshot',
        memory: { kind: 'initial', ids: [id] },
        sections: [{ name: 'long-term-memory', text: `memory-${id}` }],
      },
    },
  }
}

function normalEvent(id) {
  return { type: 'user/message', data: { content: [{ type: 'text', text: id }], source: { kind: 'user' } } }
}

function createSession(home, rootName, project, sessionId, events, oneFramePerEvent = false) {
  const file = join(home, rootName, project, sessionId, 'session.jsonl.zstd')
  mkdirSync(dirname(file), { recursive: true })
  const header = `${JSON.stringify({ version: 0, id: sessionId })}\n`
  const eventLines = events.map(event => `${JSON.stringify(event)}\n`)
  const parts = [zstdCompressSync(Buffer.from(header), CHECKSUM_OPTIONS)]
  if (oneFramePerEvent) {
    for (const line of eventLines) parts.push(zstdCompressSync(Buffer.from(line), CHECKSUM_OPTIONS))
  } else if (eventLines.length > 0) {
    parts.push(zstdCompressSync(Buffer.from(eventLines.join('')), CHECKSUM_OPTIONS))
  }
  writeFileSync(file, Buffer.concat(parts))
  return file
}

function identity(file) {
  const stat = statSync(file)
  return { size: stat.size, mtimeMs: stat.mtimeMs }
}

async function waitFor(test, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function runWorker(workerUrl, dshHome) {
  const worker = new Worker(workerUrl, { workerData: { dshHome } })
  const messages = []
  worker.on('message', message => messages.push(message))
  const code = await new Promise((resolve, reject) => {
    worker.once('error', reject)
    worker.once('exit', resolve)
  })
  assert.equal(code, 0)
  return messages
}

async function runPausedWorker(workerUrl, dshHome) {
  const worker = new Worker(workerUrl, { workerData: { dshHome } })
  const messages = []
  worker.on('message', message => {
    messages.push(message)
    if (message.type === 'ready') worker.postMessage({ type: 'pause' })
  })
  const code = await new Promise((resolve, reject) => {
    worker.once('error', reject)
    worker.once('exit', resolve)
  })
  assert.equal(code, 0)
  return messages
}

const root = mkdtempSync(join(tmpdir(), 'meow-session-migration-'))
try {
  // Multi-frame migration, per-file failure isolation, and checkpoint retry.
  const home = join(root, 'primary')
  const migratedFile = createSession(home, 'sessions', 'p1', 'legacy', [legacySnapshot('legacy')], true)
  const unchangedFile = createSession(home, 'archived-sessions', 'p2', 'clean', [normalEvent('clean')])
  const corruptFile = join(home, 'sessions', 'p3', 'corrupt', 'session.jsonl.zstd')
  mkdirSync(dirname(corruptFile), { recursive: true })
  writeFileSync(corruptFile, 'not-zstd')
  const original = readFileSync(migratedFile)

  const first = await runSessionMigration(home)
  assert.equal(first.status, 'completed-with-errors')
  assert.deepEqual(first.totals, { discovered: 3, done: 2, migratedFiles: 1, migratedLines: 1, failed: 1, deferred: 0 })
  assert.deepEqual(Object.keys(first.files), [
    'archived-sessions/p2/clean/session.jsonl.zstd',
    'sessions/p1/legacy/session.jsonl.zstd',
    'sessions/p3/corrupt/session.jsonl.zstd',
  ])
  const migratedKey = 'sessions/p1/legacy/session.jsonl.zstd'
  const cleanKey = 'archived-sessions/p2/clean/session.jsonl.zstd'
  const corruptKey = 'sessions/p3/corrupt/session.jsonl.zstd'
  assert.equal(first.files[migratedKey].attempts, 1)
  assert.equal(first.files[cleanKey].result, 'unchanged')
  assert.equal(first.files[corruptKey].status, 'failed')

  const output = readFileSync(migratedFile)
  assert.equal(frameRanges(output).length, 2, 'rewritten session keeps a dedicated header frame')
  const migratedLines = decompressContainer(output).trimEnd().split('\n').map(line => JSON.parse(line))
  const migratedSource = migratedLines[1].data.source
  assert.equal(Object.hasOwn(migratedSource, 'memory'), false)
  assert.equal(migratedSource.sections[0].name, '__meta__')
  assert.deepEqual(JSON.parse(migratedSource.sections[0].text), { kind: 'initial', ids: ['legacy'] })
  assert.deepEqual(readFileSync(join(home, 'pre-migrate-backup', migratedKey)), original)

  const second = await runSessionMigration(home)
  assert.equal(second.files[migratedKey].attempts, 1, 'done file with same identity is skipped')
  assert.equal(second.files[cleanKey].attempts, 1, 'unchanged done file is skipped')
  assert.equal(second.files[corruptKey].attempts, 2, 'failed file is retried')

  createSession(home, 'sessions', 'p3', 'corrupt', [legacySnapshot('fixed')])
  const third = await runSessionMigration(home)
  assert.equal(third.status, 'completed')
  assert.deepEqual(third.totals, { discovered: 3, done: 3, migratedFiles: 2, migratedLines: 2, failed: 0, deferred: 0 })
  assert.equal(third.files[migratedKey].attempts, 1)
  assert.equal(third.files[corruptKey].attempts, 3)
  assert.deepEqual(readSessionMigrationState(home), third)

  // Structurally invalid JSON state is ignored instead of poisoning resume.
  const invalidStateHome = join(root, 'invalid-state')
  mkdirSync(dirname(sessionMigrationPaths(invalidStateHome).state), { recursive: true })
  writeFileSync(sessionMigrationPaths(invalidStateHome).state, JSON.stringify({
    ...third,
    dshHomeFingerprint: 'not-a-fingerprint',
    files: { '../escape': { status: 'done' } },
  }))
  assert.equal(readSessionMigrationState(invalidStateHome), undefined)

  // Enumeration must not follow project/session/file symlinks outside DSH_HOME.
  const linkedHome = join(root, 'linked')
  const outsideHome = join(root, 'outside')
  const outsideFile = createSession(outsideHome, 'sessions', 'p', 'outside', [legacySnapshot('outside')])
  mkdirSync(join(linkedHome, 'sessions'), { recursive: true })
  symlinkSync(join(outsideHome, 'sessions', 'p'), join(linkedHome, 'sessions', 'linked-project'), 'dir')
  const linkedState = await runSessionMigration(linkedHome)
  assert.equal(linkedState.totals.discovered, 0)
  assert.ok(decompressContainer(readFileSync(outsideFile)).includes('"memory"'))

  // Pause at a file boundary, then resume without reprocessing completed files.
  const pauseHome = join(root, 'pause')
  createSession(pauseHome, 'sessions', 'p', 'a', [normalEvent('a')])
  createSession(pauseHome, 'sessions', 'p', 'b', [normalEvent('b')])
  createSession(pauseHome, 'sessions', 'p', 'c', [normalEvent('c')])
  let pause = false
  const paused = await runSessionMigration(pauseHome, {
    shouldStop: () => pause ? 'pause' : false,
    onProgress: () => { pause = true },
  })
  assert.equal(paused.status, 'paused')
  assert.equal(paused.totals.done, 1)
  const completedBeforeResume = Object.values(paused.files).find(file => file.status === 'done')
  assert.equal(completedBeforeResume?.attempts, 1)
  const resumed = await runSessionMigration(pauseHome)
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.totals.done, 3)
  assert.equal(resumed.files[completedBeforeResume.relativePath].attempts, 1)

  // An active session changed immediately before replacement must not be overwritten.
  const activeHome = join(root, 'active')
  const activeFile = createSession(activeHome, 'sessions', 'p', 'active', [legacySnapshot('active')])
  const activeBefore = readFileSync(activeFile)
  const activeResult = processSessionFile(activeHome, activeFile, {
    expectedIdentity: identity(activeFile),
    beforeReplace: file => appendFileSync(file, 'active-append'),
  })
  assert.equal(activeResult.status, 'deferred')
  assert.deepEqual(readFileSync(activeFile), Buffer.concat([activeBefore, Buffer.from('active-append')]))
  assert.equal(existsSync(join(activeHome, 'pre-migrate-backup', 'sessions/p/active/session.jsonl.zstd')), false)

  // State and locks are scoped to DSH_HOME.
  assert.notEqual(sessionMigrationPaths(home).state, sessionMigrationPaths(pauseHome).state)
  assert.notEqual(third.dshHomeFingerprint, resumed.dshHomeFingerprint)

  const lockHome = join(root, 'locks')
  const firstLock = tryAcquireSessionMigrationLock(lockHome)
  assert.ok(firstLock)
  assert.equal(tryAcquireSessionMigrationLock(lockHome), undefined)
  firstLock.release()
  const replacementLock = tryAcquireSessionMigrationLock(lockHome)
  assert.ok(replacementLock)
  replacementLock.release()

  const lockPath = sessionMigrationPaths(lockHome).lock
  writeFileSync(lockPath, `${JSON.stringify({ pid: 99_999_999, ownerId: 'dead' })}\n`)
  const reclaimed = tryAcquireSessionMigrationLock(lockHome)
  assert.ok(reclaimed, 'dead-owner lock is reclaimed')
  reclaimed.release()
  writeFileSync(lockPath, 'malformed')
  assert.equal(tryAcquireSessionMigrationLock(lockHome), undefined, 'unknown lock ownership is not reclaimed')
  rmSync(lockPath, { force: true })

  // The packaged worker contract runs independently of the host bundle.
  const workerHome = join(root, 'worker')
  createSession(workerHome, 'sessions', 'p', 'worker', [legacySnapshot('worker')], true)
  const workerMessages = await runWorker(new URL('../lib/migration-worker.js', import.meta.url), workerHome)
  assert.ok(workerMessages.some(message => message.type === 'ready'))
  assert.equal(workerMessages.at(-1)?.type, 'completed')
  assert.equal(readSessionMigrationState(workerHome)?.status, 'completed')

  const workerPauseHome = join(root, 'worker-pause')
  for (let index = 0; index < 20; index += 1) {
    createSession(workerPauseHome, 'sessions', 'p', `worker-${index}`, [normalEvent(`worker-${index}`)])
  }
  const pausedMessages = await runPausedWorker(new URL('../lib/migration-worker.js', import.meta.url), workerPauseHome)
  assert.equal(pausedMessages.at(-1)?.type, 'paused')
  const workerPausedState = readSessionMigrationState(workerPauseHome)
  assert.equal(workerPausedState?.status, 'paused')
  assert.ok(workerPausedState.totals.done < workerPausedState.totals.discovered)

  // Two coordinators for one home cannot both acquire the process-level lock.
  const coordinatorHome = join(root, 'coordinator')
  const firstCoordinator = new SessionMigrationCoordinator({ dshHome: coordinatorHome, startDelayMs: 60_000, lockRetryMs: 60_000 })
  const secondCoordinator = new SessionMigrationCoordinator({ dshHome: coordinatorHome, startDelayMs: 60_000, lockRetryMs: 60_000 })
  assert.equal(firstCoordinator.retry(), true)
  assert.equal(secondCoordinator.retry(), false)
  assert.equal(secondCoordinator.status().phase, 'waiting')
  await waitFor(() => ['completed', 'completed-with-errors'].includes(firstCoordinator.status().phase))
  await firstCoordinator.dispose()
  await secondCoordinator.dispose()
  assert.equal(existsSync(sessionMigrationPaths(coordinatorHome).lock), false)

  const disposeHome = join(root, 'dispose')
  createSession(disposeHome, 'sessions', 'p', 'dispose', [normalEvent('dispose')])
  const disposingCoordinator = new SessionMigrationCoordinator({ dshHome: disposeHome, startDelayMs: 60_000 })
  assert.equal(disposingCoordinator.retry(), true)
  await disposingCoordinator.dispose()
  assert.equal(disposingCoordinator.status().phase, 'disposed')
  assert.equal(existsSync(sessionMigrationPaths(disposeHome).lock), false)

  console.log('session migration contracts passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}