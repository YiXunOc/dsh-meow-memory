import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if (process.argv[2] === '--child') {
  const { apply } = await import('../lib/index.js')
  const ctx = {
    inject() {},
    tools: { register() { return () => {} } },
    logger: { info() {}, warn() {} },
    effect(setup) { return setup() },
    on() { return () => {} },
    get() { return undefined },
  }
  const started = performance.now()
  await apply(ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
  const applyMs = performance.now() - started
  const timerStarted = performance.now()
  await new Promise(resolve => setTimeout(resolve, 0))
  process.stdout.write(`${JSON.stringify({ applyMs, timerMs: performance.now() - timerStarted })}\n`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'meow-startup-nonblocking-'))
try {
  const home = join(root, 'home')
  const dshHome = join(root, 'dsh-home')
  const historicalWorkspace = join(root, 'historical-workspace')
  const windowIndex = join(home, '.dsh-meow', 'window-index.json')
  mkdirSync(dirname(windowIndex), { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(windowIndex, JSON.stringify({ 'historical-session': historicalWorkspace }))
  for (let index = 0; index < 1_000; index += 1) {
    const sessionFile = join(dshHome, 'sessions', 'bulk-project', `session-${index}`, 'session.jsonl.zstd')
    mkdirSync(dirname(sessionFile), { recursive: true })
    writeFileSync(sessionFile, 'intentionally unreadable; startup must not inspect this')
  }

  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dshHome },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr || `child exited ${String(result.status)}`)
  const timing = JSON.parse(result.stdout.trim())
  assert.ok(timing.applyMs < 1_000, `apply took ${timing.applyMs}ms with 1000 historical sessions`)
  assert.ok(timing.timerMs < 250, `event-loop timer was delayed ${timing.timerMs}ms after apply`)
  assert.equal(
    existsSync(join(historicalWorkspace, '.dsh-meow', 'memory.db')),
    false,
    'plugin startup must not open or create databases from the historical window index',
  )
  assert.equal(
    existsSync(join(home, '.dsh-meow', 'migrate-v0-state.json')),
    false,
    'plugin startup must not run the v0 session migration',
  )
  assert.equal(
    existsSync(join(dshHome, 'meow-memory', 'migrations', 'source-memory-v2.json')),
    false,
    'delayed worker must not scan sessions before apply returns',
  )
  console.log('startup nonblocking contract passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
