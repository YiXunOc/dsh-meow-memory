import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMemoryChild, startWindowDream, closeAllDbs } from '../lib/index.js'

// A real Cordis plugin context rejects undeclared ctx.subagents property access.
const root = new Context()
const workspace = mkdtempSync(join(tmpdir(), 'meow-optional-subagents-'))
try {
  await root.plugin({
    name: 'meow-optional-subagents-probe',
    apply(ctx) {
      ctx.effect(() => {
        const child = runMemoryChild(ctx, {}, 'reflection', 'reflect')
        const dream = startWindowDream(ctx, { session: { header: { id: 'probe-window' } } }, workspace)
        return () => {
          // No child is present: neither path should schedule parent work.
          assert.equal(dream, false)
          return child.then(ok => { assert.equal(ok, false) })
        }
      })
    },
  })
  await root.fiber.dispose()
  console.log('optional subagents Cordis context: passed')
} finally {
  closeAllDbs()
  rmSync(workspace, { recursive: true, force: true })
}
