import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskJournal, setMemoryTaskJournal, runMemoryChild, startWindowDream, getDb, closeAllDbs } from '../lib/index.js'
const dir = mkdtempSync(join(tmpdir(), 'meow-task-live-'))
const journal = new TaskJournal(join(dir, 'journal'))

const events = [{ type: 'turn/start', seq: 1, data: { turn: 7 } }, { type: 'turn/end', seq: 2, data: {} }]
const parent = { session: { header: { id: 'parent', cwd: dir }, ownEvents: () => events } }
const service = { async startActivation(spec) {
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.parent, parent)
  assert.equal(spec.request.prompt[0].text.includes('reflection'), true)
  journal.recordChildEvent(spec.childId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Reviewed; no new memory needed.' }] } } })
  return { childId: spec.childId, result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }
} }
const ctx = { get: name => name === 'subagents' ? service : undefined }
setMemoryTaskJournal(journal, ctx)
try {
  assert.equal(await runMemoryChild(ctx, parent, 'reflection', 'meow-memory reflect'), true)
  const reflect = journal.list('parent')[0]
  assert.equal(reflect.kind, 'reflect')
  assert.equal(reflect.turn, 7)
  assert.equal(reflect.anchorSeq, 2)
  assert.equal(reflect.status, 'done')
  assert.equal(reflect.result, 'Reviewed; no new memory needed.')
  const silentCtx = { get: name => name === 'subagents' ? { startActivation: async spec => ({ childId: spec.childId, result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }) } : undefined }
  setMemoryTaskJournal(journal, silentCtx)
  assert.equal(await runMemoryChild(silentCtx, parent, 'silence', 'meow-memory reflect'), false)
  const silent = journal.list('parent').at(-1)
  assert.equal(silent.status, 'failed')
  assert.match(silent.result, /未提供审查结论/)
  assert.equal(events.length, 2)
  assert.equal(journal.list('parent').length, 2)
  assert.equal(await runMemoryChild({ get: () => undefined }, parent, 'reflection', 'meow-memory reflect'), false)
  assert.equal(journal.list('parent').length, 2)
  getDb(dir).touchWindow('parent', dir, Date.now())
  // No atomic rows still executes the topic round, on an independent child.
  const dreamService = { async startActivation(spec) {
    journal.recordChildEvent(spec.childId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Topic reviewed; no new memory needed.' }] } } })
    return { childId: spec.childId, result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }
  } }
  const dreamCtx = { get: name => name === 'subagents' ? dreamService : undefined }
  setMemoryTaskJournal(journal, dreamCtx)
  assert.equal(startWindowDream(dreamCtx, parent, dir), true)
  for (let n = 0; n < 20 && journal.list('parent').filter(t => t.kind === 'dream')[0]?.status !== 'done'; n++) await new Promise(r => setTimeout(r, 10))
  const dream = journal.list('parent').filter(t => t.kind === 'dream')[0]
  assert.equal(dream.status, 'done')
  assert.equal(dream.result, 'Topic reviewed; no new memory needed.')
  assert.equal(dream.turn, 7)
  assert.equal(dream.childIds.length, 1)
  assert.equal(events.length, 2)
  assert.equal(new TaskJournal(join(dir, 'journal')).get(dream.id).status, 'done')
  const newer = new TaskJournal(join(dir, 'newer'))
  const older = new TaskJournal(join(dir, 'older'))
  const oldCtx = { get: name => name === 'subagents' ? service : undefined }
  const newCtx = { get: name => name === 'subagents' ? service : undefined }
  setMemoryTaskJournal(older, oldCtx)
  setMemoryTaskJournal(newer, newCtx)
  setMemoryTaskJournal(undefined, oldCtx)
  await runMemoryChild(newCtx, parent, 'reflection', 'meow-memory reflect')
  assert.equal(newer.list('parent').length, 1, 'old reload cleanup must not erase newer journal')
  assert.equal(older.list('parent').length, 0)
  setMemoryTaskJournal(undefined, newCtx)
  older.close(); newer.close()
  console.log('reflect/dream fork lifecycle leaves parent events unchanged: passed')
} finally { closeAllDbs(); rmSync(dir, { recursive: true, force: true }) }
