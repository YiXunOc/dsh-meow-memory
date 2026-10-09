import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'meow-packed-worker-'))
try {
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', root], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.equal(pack.status, 0, pack.stderr || pack.stdout)
  const [{ filename }] = JSON.parse(pack.stdout)
  const archive = join(root, filename)
  const extract = spawnSync('tar', ['-xzf', archive, '-C', root], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(extract.status, 0, extract.stderr)

  const workerFile = join(root, 'package', 'lib', 'migration-worker.js')
  assert.equal(existsSync(workerFile), true, 'migration worker must be present in the npm package')
  const dshHome = join(root, 'dsh-home')
  const worker = new Worker(pathToFileURL(workerFile), { workerData: { dshHome } })
  const messages = []
  worker.on('message', message => messages.push(message))
  const code = await new Promise((resolve, reject) => {
    worker.once('error', reject)
    worker.once('exit', resolve)
  })
  assert.equal(code, 0)
  assert.equal(messages.at(-1)?.type, 'completed')
  assert.equal(existsSync(join(dshHome, 'meow-memory', 'migrations', 'source-memory-v2.json')), true)
  console.log('packed migration worker contract passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}