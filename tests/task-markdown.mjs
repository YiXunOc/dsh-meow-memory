import assert from 'node:assert/strict'
import { build } from 'esbuild'

const { outputFiles } = await build({ entryPoints: ['src/client-task-card.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { renderTaskMarkdown, openTaskCard, TASK_CARD_CSS } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'))
for (const selector of ['h1', 'ul', 'ol', 'blockquote', 'pre', 'code', 'a']) {
  assert.match(TASK_CARD_CSS, new RegExp(`\\[data-meow-task-markdown\\][^{}]*\\b${selector}\\b`))
}
assert.match(TASK_CARD_CSS, /overflow-x: auto/)

class Node {
  constructor(tag = '#text', text = '') { this.tagName = tag.toUpperCase(); this.text = text; this.children = []; this.attrs = {} }
  appendChild(child) { this.children.push(child); return child }
  replaceChildren(...children) { this.children = [...children] }
  set textContent(value) { this.children = []; this.text = value }
  get textContent() { return this.text + this.children.map(child => child.textContent).join('') }
  set href(value) { this.attrs.href = value }
  set target(value) { this.attrs.target = value }
  set rel(value) { this.attrs.rel = value }
  get lastElementChild() { return [...this.children].reverse().find(child => child.tagName !== '#TEXT') ?? null }
  get parentElement() { return this.parent ?? null }
  get isConnected() { return true }
  querySelector(tag) { return this.children.find(child => child.tagName === tag.toUpperCase()) ?? null }
}
globalThis.document = {
  createElement: tag => new Node(tag),
  createTextNode: text => new Node('#text', text),
}
const root = new Node('div')
renderTaskMarkdown(root, '# 记忆整理\n\n**新增两条**\n1. 第一条\n2. 第二条\n\n```ts\nconst x = 1\n```')
assert.deepEqual(root.children.map(node => node.tagName), ['H1', 'P', 'OL', 'PRE'])
assert.equal(root.children[1].children[0].tagName, 'STRONG')
assert.equal(root.children[1].textContent, '新增两条')
assert.deepEqual(root.children[2].children.map(item => item.textContent), ['第一条', '第二条'])
assert.equal(root.children[3].querySelector('code').textContent.trim(), 'const x = 1')
renderTaskMarkdown(root, '<script>alert(1)</script> [bad](javascript:alert(1)) [ok](https://example.com)')
assert.equal(root.textContent.includes('<script>alert(1)</script>'), true)
assert.equal(root.children[0].children.filter(node => node.tagName === 'A').length, 1)
assert.equal(root.children[0].children.find(node => node.tagName === 'A').attrs.href, 'https://example.com')
renderTaskMarkdown(root, '~~~js\n```ts\ninside\n~~~js\n~~~\nend')
assert.deepEqual(root.children.map(node => node.tagName), ['PRE', 'P'])
assert.equal(root.children[0].textContent, '```ts\ninside\n~~~js')
assert.equal(root.children[1].textContent, 'end')
renderTaskMarkdown(root, '````ts\n```\ninside\n````\nafter')
assert.equal(root.children[0].textContent, '```\ninside')
assert.equal(root.children[1].textContent, 'after')
let rejectProcess
openTaskCard({ result: '**已保存**' }, root, () => new Promise((_, reject) => { rejectProcess = reject }))
assert.match(root.textContent, /已保存/)
await Promise.resolve()
rejectProcess(new Error('unavailable'))
await new Promise(resolve => setTimeout(resolve, 0))
assert.match(root.textContent, /已保存/)
assert.match(root.textContent, /子任务过程暂不可读取/)
let firstResolve, secondResolve
openTaskCard({ result: 'old' }, root, () => new Promise(resolve => { firstResolve = resolve }))
openTaskCard({ result: 'new' }, root, () => new Promise(resolve => { secondResolve = resolve }))
await Promise.resolve()
secondResolve([{ type: 'assistant/message', text: 'current process' }])
await new Promise(resolve => setTimeout(resolve, 0))
firstResolve([{ type: 'assistant/message', text: 'stale process' }])
await new Promise(resolve => setTimeout(resolve, 0))
assert.match(root.textContent, /new/)
assert.match(root.textContent, /current process/)
assert.ok(!root.textContent.includes('stale process'))
assert.ok(!root.textContent.includes('old'))
console.log('memory task Markdown semantic rendering and unsafe link fallback: passed')
