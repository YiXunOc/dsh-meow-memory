import assert from 'node:assert/strict'
import { build } from 'esbuild'
const { outputFiles } = await build({ entryPoints: ['src/client-task-card.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { taskAnchorKey, applyTaskCards, readTaskProcess } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'))
const task = { id: 'a', parentId: 'p', turn: 7, kind: 'reflect', status: 'running', childIds: ['child'], reviewedChild: 'child' }
const nodes = new Map([
  ['assistant', { kind: 'assistant-step', location: { turn: { turn: 7 } } }],
  ['tail', { kind: 'turn-tail', location: { turn: { turn: 7 } } }],
  ['other', { kind: 'turn-tail', location: { turn: { turn: 8 } } }],
])
const chat = { nodes, locations: { getTurn: n => n === 7 ? ['assistant', 'tail'] : ['other'] } }
assert.equal(taskAnchorKey(task, chat), 'tail')
assert.equal(taskAnchorKey({ ...task, turn: 9 }, chat), undefined)
assert.equal(taskAnchorKey({ ...task, turn: undefined }, chat), undefined)
assert.equal(taskAnchorKey(task, { nodes, locations: { getTurn: () => ['assistant'] } }), 'assistant')
class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.style = {}; this.textContent = ''; this.parentElement = null; this.handlers = {} }
  setAttribute(k,v) { this.attrs[k] = v }
  getAttribute(k) { return this.attrs[k] ?? null }
  append(...items) { for(const item of items) { item.remove(); this.children.push(item); item.parentElement = this } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); this.parentElement = null }
  after(item) { item.remove(); const a = this.parentElement.children; a.splice(a.indexOf(this)+1, 0, item); item.parentElement = this.parentElement }
  get previousElementSibling() { const a = this.parentElement?.children ?? []; return a[a.indexOf(this)-1] ?? null }
  addEventListener(type, fn) { this.handlers[type] = fn }
  querySelectorAll(sel) { const attr = /^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(sel); const matches = e => attr ? (attr[2] === undefined ? e.attrs[attr[1]] !== undefined : e.attrs[attr[1]] === attr[2]) : e.tag === sel; const walk = e => e.children.flatMap(c => [ ...(matches(c) ? [c] : []), ...walk(c)]); return walk(this) }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null }
}
const container = new El('div'), row = new El('div'), next = new El('div')
row.setAttribute('data-chat-flow-key', 'tail'); next.setAttribute('data-chat-flow-key','other')
container.append(row, next)
globalThis.CSS = { escape: x => x }
globalThis.document = { createElement: tag => new El(tag), querySelectorAll: () => [container] }
let opened = 0
let openedTask
const open = (_task, body) => { opened++; openedTask = _task; body.textContent = '<script>literal</script>' }
applyTaskCards([task], chat, open)
assert.equal(container.children[0], row)
assert.equal(container.children[1].getAttribute('data-meow-task-card'), task.id)
assert.equal(container.children[2], next)
assert.equal(row.getAttribute('data-meow-memory-folded'), null)
applyTaskCards([{ ...task, status: 'done' }], chat, open)
assert.equal(container.children.length, 3)
const card = container.children[1]
assert.match(card.querySelector('button').textContent, /已完成/)
card.querySelector('button').handlers.click()
assert.equal(opened, 1)
assert.equal(card.querySelector('[data-meow-task-markdown]').textContent, '<script>literal</script>')
assert.match(card.querySelector('button').textContent, /不代表新增记忆/, 'done describes review, not a write')
applyTaskCards([{ ...task, status: 'done', result: 'Reviewed; no new memory needed.', childIds: ['new-child'] }], chat, open)
assert.match(card.querySelector('button').textContent, /已完成/)
assert.ok(!card.querySelector('button').textContent.includes('Reviewed; no new memory needed.'), 'long result stays out of the collapsed label')
card.querySelector('button').handlers.click()
card.querySelector('button').handlers.click()
assert.equal(openedTask.result, 'Reviewed; no new memory needed.', 'reopened card uses latest polled task')
assert.deepEqual(openedTask.childIds, ['new-child'])
row.remove()
applyTaskCards([{ ...task, status: 'done' }], chat, open)
assert.equal(container.querySelector('[data-meow-task-card]'), null, 'paged-out anchor removes old card')
applyTaskCards([], chat, open)
assert.equal(container.children.length, 1)

// Official sessions face: parent catalog evidence, addressed child, gated history.
const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } })
const entries = [
  event(0, 'assistant/message', { message: { content: [{ type: 'text', text: 'PARENT_PRIVATE' }] } }),
  event(1, 'subagent/descriptor', { mode: 'one-shot' }),
  event(2, 'user/message', { content: [{ type: 'text', text: 'CHILD_PROMPT_PRIVATE' }] }),
  event(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'Actual child result' }, { type: 'tool-call', name: 'memory_remember', argsRaw: 'SECRET_ARGS' }] } }),
  event(4, 'tool/result', { message: { isError: true, content: [{ type: 'text', text: 'Actual failure' }] } }),
]
let calls = 0
let catalog = [{ id: 'child', mode: 'one-shot' }]
let address = { parentSessionId: 'p', childSessionId: 'child', mode: 'unknown' }
const binding = { session: { getSnapshot: () => ({ openState: 'open', subagent: { address }, hasMore: false }) }, eventSource: { getSnapshot: () => ({ entries, hasMore: false }) } }
const sessions = {
  list: { getSnapshot: () => ({ projectionsBySession: { p: { state: 'ready', values: { subagentCatalog: catalog } }, child: { state: 'ready', values: { subagent: { seq: 1 } } } } }) },
  async refreshProjections(id) { assert.ok(['p', 'child'].includes(id)) },
  async using(target, opts, operation) {
    calls++
    assert.deepEqual(target, { parentSessionId: 'p', childSessionId: 'child', mode: 'unknown' })
    assert.equal(opts.source, 'plugin')
    return operation({ binding })
  },
}
let result = await readTaskProcess(task, sessions)
assert.deepEqual(result.map(e => e.text), ['Actual child result', 'memory_remember', 'Actual failure'])
assert.ok(!JSON.stringify(result).includes('PARENT_PRIVATE'))
assert.ok(!JSON.stringify(result).includes('CHILD_PROMPT_PRIVATE'))
assert.ok(!JSON.stringify(result).includes('SECRET_ARGS'))
assert.equal(calls, 1)
entries.splice(2, entries.length - 2, ...Array.from({ length: 130 }, (_, i) => event(i + 2, 'assistant/message', { message: { content: [{ type: 'text', text: `step-${i}` }] } })), event(132, 'assistant/message', { message: { content: [{ type: 'text', text: 'FINAL_REVIEW_NO_NEW_MEMORY' }] } }))
result = await readTaskProcess(task, sessions)
assert.ok(result.length <= 120)
assert.equal(result.at(-1).text, 'FINAL_REVIEW_NO_NEW_MEMORY', 'result survives process truncation')
assert.equal(result.at(-1).type, 'result', 'terminal assistant answer is an explicit result')
assert.ok(!result.some(e => e.text === 'step-0'), 'bounded tail drops earliest work')
entries.splice(2, entries.length - 2, ...Array.from({ length: 499 }, (_, i) => event(i + 2, 'assistant/message', { message: { content: [{ type: 'text', text: `window-${i}` }] } })), event(501, 'assistant/message', { message: { content: [{ type: 'text', text: 'LATEST_RESULT' }] } }))
result = await readTaskProcess(task, sessions)
assert.equal(result.at(-1).text, 'LATEST_RESULT', '500-event window includes terminal result')
assert.equal(result.at(-1).type, 'result')
catalog = []
await assert.rejects(readTaskProcess(task, sessions), /catalog|unavailable|unauthorized/i)
assert.equal(calls, 3)
catalog = [{ id: 'child', mode: 'one-shot' }]
address = { parentSessionId: 'wrong', childSessionId: 'child', mode: 'unknown' }
await assert.rejects(readTaskProcess(task, sessions), /address|unavailable|unauthorized/i)
address = { parentSessionId: 'p', childSessionId: 'child', mode: 'unknown' }
entries.splice(1, 1)
sessions.list.getSnapshot = () => ({ projectionsBySession: { p: { state: 'ready', values: { subagentCatalog: catalog } }, child: { state: 'ready', values: { subagent: null } } } })
await assert.rejects(readTaskProcess(task, sessions), /descriptor|boundary|unavailable/i)
sessions.list.getSnapshot = () => ({ projectionsBySession: { p: { state: 'ready', values: { subagentCatalog: catalog } }, child: { state: 'ready', values: { subagent: { seq: 1 } } } } })
await assert.rejects(readTaskProcess(task, sessions), /descriptor|boundary|unavailable/i)
console.log('task card and authorized child-only process: passed')
