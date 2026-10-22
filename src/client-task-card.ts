import type { MemoryTask } from './task-journal.js'

export const TASK_CARD_CSS = `
[data-meow-task-markdown] { color: var(--dsw-alias-label-primary); font-size: 13px; }
[data-meow-task-markdown] :is(p, ul, ol, blockquote, pre) { margin: .5em 0; }
[data-meow-task-markdown] :is(ul, ol) { padding-left: 1.8em; }
[data-meow-task-markdown] :is(h1, h2, h3, h4, h5, h6) { margin: .8em 0 .35em; font-weight: 600; line-height: 1.35; }
[data-meow-task-markdown] h1 { font-size: 1.35em; }
[data-meow-task-markdown] h2 { font-size: 1.2em; }
[data-meow-task-markdown] blockquote { padding-left: .8em; border-left: 3px solid var(--dsw-alias-label-tertiary, #888); color: var(--dsw-alias-label-secondary); }
[data-meow-task-markdown] pre { overflow-x: auto; padding: .6em .8em; border-radius: 6px; background: rgba(127,127,127,.1); }
[data-meow-task-markdown] code { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; background: rgba(127,127,127,.1); border-radius: 3px; padding: .1em .2em; }
[data-meow-task-markdown] pre code { background: none; padding: 0; }
[data-meow-task-markdown] a { color: var(--dsw-alias-link, #629cf6); text-decoration: underline; }
`

const pendingOpens = new WeakMap<HTMLElement, number>()

/** Display durable review immediately; process loading/failure must not hide it. */
export function openTaskCard(task: Pick<MemoryTask, 'result'>, body: HTMLElement,
  readProcess: () => Promise<Array<{ type: string; text: string }>>): void {
  const generation = (pendingOpens.get(body) ?? 0) + 1
  pendingOpens.set(body, generation)
  const summary = task.result ? `## 反思结果\n\n${task.result}` : ''
  const show = (process: string): void => {
    if (body.isConnected && pendingOpens.get(body) === generation) {
      renderTaskMarkdown(body, [summary, `## 执行过程\n\n${process}`].filter(Boolean).join('\n\n'))
    }
  }
  show('读取子任务过程…')
  void Promise.resolve().then(readProcess).then(process => {
    show(process.length ? process.map(e => e.type === 'tool-call' ? `> 工具：${e.text}` : e.type === 'tool/result' ? `> 工具结果：${e.text}` : e.text).join('\n\n') : '无可读取的子任务过程')
  }).catch(() => { show('子任务过程暂不可读取') })
}

/** Render basic Markdown as DOM nodes; never interpret raw HTML. */
export function renderTaskMarkdown(container: HTMLElement, source: string): void {
  container.replaceChildren()
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let code: string[] | null = null
  let codeNode: HTMLElement | null = null
  let fenceMark = ''
  let fenceLength = 0
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const node = document.createElement('p')
    appendTaskInline(node, paragraph.join('\n'))
    container.appendChild(node)
    paragraph = []
  }
  const flushCode = (): void => {
    if (code === null || codeNode === null) return
    const node = document.createElement('code')
    node.textContent = code.join('\n')
    codeNode.appendChild(node)
    code = null
    codeNode = null
  }
  for (const line of lines) {
    if (code !== null) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (closing && closing[1][0] === fenceMark && closing[1].length >= fenceLength) flushCode()
      else code.push(line)
      continue
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
        flushParagraph()
        code = []
        fenceMark = opening[1][0]
        fenceLength = opening[1].length
        codeNode = document.createElement('pre')
        container.appendChild(codeNode)
        continue
    }
    if (line.trim() === '') { flushParagraph(); continue }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      const node = document.createElement(`h${heading[1].length}`)
      appendTaskInline(node, heading[2])
      container.appendChild(node)
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (ordered || bullet) {
      flushParagraph()
      const tag = ordered ? 'ol' : 'ul'
      const last = container.lastElementChild
      const list = last?.tagName === tag.toUpperCase() ? last : document.createElement(tag)
      if (list !== last) container.appendChild(list)
      const item = document.createElement('li')
      appendTaskInline(item, (ordered ?? bullet)![1])
      list.appendChild(item)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph()
      const quote = document.createElement('blockquote')
      appendTaskInline(quote, line.replace(/^\s*>\s?/, ''))
      container.appendChild(quote)
      continue
    }
    paragraph.push(line)
  }
  flushCode()
  flushParagraph()
}

function appendTaskInline(parent: HTMLElement, source: string): void {
  const tokens = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  for (let match = tokens.exec(source); match !== null; match = tokens.exec(source)) {
    if (match.index > last) parent.appendChild(document.createTextNode(source.slice(last, match.index)))
    const raw = match[0]
    if (raw.startsWith('`')) {
      const node = document.createElement('code'); node.textContent = raw.slice(1, -1); parent.appendChild(node)
    } else if (raw.startsWith('**') || raw.startsWith('__')) {
      const node = document.createElement('strong'); node.textContent = raw.slice(2, -2); parent.appendChild(node)
    } else if (raw.startsWith('*') || raw.startsWith('_')) {
      const node = document.createElement('em'); node.textContent = raw.slice(1, -1); parent.appendChild(node)
    } else if (match[2] !== undefined && /^https?:\/\/[^\s]+$/i.test(match[3] ?? '')) {
      const node = document.createElement('a')
      node.textContent = match[2]
      node.href = match[3]!
      node.target = '_blank'
      node.rel = 'noopener noreferrer'
      parent.appendChild(node)
    } else parent.appendChild(document.createTextNode(raw))
    last = match.index + raw.length
  }
  if (last < source.length) parent.appendChild(document.createTextNode(source.slice(last)))
}

/** Read only the child's own durable suffix through the official addressed session face. */
export async function readTaskProcess(task: MemoryTask, sessions: {
  list: { getSnapshot: () => { projectionsBySession?: Record<string, { state?: string; values?: { subagentCatalog?: Array<{ id: string; mode?: string }>; subagent?: { seq?: number } | null } }> } }
  refreshProjections: (id: string) => Promise<void>
  using: (address: { parentSessionId: string; childSessionId: string; mode: 'unknown' }, options: { source: 'plugin' }, callback: (reference: any) => Promise<Array<{ type: string; text: string }>>) => Promise<Array<{ type: string; text: string }>>
}): Promise<Array<{ type: string; text: string }>> {
  if (!sessions?.list?.getSnapshot || !sessions.refreshProjections || !sessions.using) throw new Error('sessions unavailable')
  await sessions.refreshProjections(task.parentId)
  if (!Array.isArray(task.childIds) || task.childIds.length > 8) throw new Error('task children unavailable')
  await Promise.all(task.childIds.map(id => sessions.refreshProjections(id)))
  const catalog = sessions.list.getSnapshot().projectionsBySession?.[task.parentId]
  const children = catalog?.values?.subagentCatalog
  if (catalog?.state !== 'ready' || !Array.isArray(children)) throw new Error('parent catalog unavailable')
  if (task.childIds.some(id => !children.some(row => row.id === id && row.mode !== 'external'))) throw new Error('child not in parent catalog')
  const out: Array<{ type: string; text: string }> = []
  for (const childId of task.childIds) {
    const own = await sessions.using({ parentSessionId: task.parentId, childSessionId: childId, mode: 'unknown' }, { source: 'plugin' }, async reference => {
      const binding = reference.binding
      const state = binding.session.getSnapshot()
      const address = state?.subagent?.address
      if (state?.openState !== 'open' || address?.parentSessionId !== task.parentId || address?.childSessionId !== childId) throw new Error('child address unavailable')
      const descriptorSeq = sessions.list.getSnapshot().projectionsBySession?.[childId]?.values?.subagent?.seq
      if (!Number.isSafeInteger(descriptorSeq) || descriptorSeq! < 0) throw new Error('child descriptor unavailable')
      let window = binding.eventSource.getSnapshot()
      if (!Array.isArray(window.entries)) throw new Error('child history unavailable')
      // Descriptor seq is the host's validated identity watermark. It is
      // strictly after the inherited fork prefix; never infer it from text.
      while (window.hasMore && (window.entries[0]?.event?.seq ?? Infinity) > descriptorSeq!) {
        await binding.session.loadOlder()
        const next = binding.eventSource.getSnapshot()
        if (next.entries.length <= window.entries.length) throw new Error('child history unavailable')
        window = next
      }
      if ((window.entries[0]?.event?.seq ?? Infinity) > descriptorSeq!) throw new Error('child boundary unavailable')
      if (!window.entries.some((entry: any) => entry.type === 'event' && entry.event?.seq === descriptorSeq && entry.event?.type === 'subagent/descriptor')) throw new Error('child descriptor unavailable')
      const events = window.entries.filter((entry: any) => entry.type === 'event' && entry.event?.seq > descriptorSeq!).map((entry: any) => entry.event)
      const process: Array<{ type: string; text: string }> = []
      for (const event of events.slice(-500)) {
        if (event?.type !== 'assistant/message' && event?.type !== 'tool/result') continue
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') process.push({ type: event.type, text: block.text.slice(0, 1200) })
          else if (event.type === 'assistant/message' && block?.type === 'tool-call' && typeof block.name === 'string') process.push({ type: 'tool-call', text: block.name.slice(0, 80) })
        }
      }
      const last = process.at(-1)
      if (last?.type === 'assistant/message' && task.reviewedChild === childId) last.type = 'result'
      return process.slice(-120)
    })
    out.push(...own)
  }
  const tail = out.slice(-120).reverse()
  let remaining = 32_000
  const bounded: typeof out = []
  for (const row of tail) {
    if (remaining <= 0) break
    const text = row.text.slice(-remaining)
    bounded.push({ type: row.type, text })
    remaining -= text.length
  }
  return bounded.reverse()
}


/** Find the last rendered row of the initiating parent turn, never insert a new chat event. */
export function taskAnchorKey(task: MemoryTask, chat: {
  order?: readonly string[]
  nodes?: { get: (key: string) => { location?: { kind?: string; turn?: { turn?: number } }; kind?: string } | undefined }
  locations?: { getTurn: (turn: number) => readonly string[] }
} | undefined): string | undefined {
  if (!chat || !Number.isInteger(task.turn) || task.turn! < 0) return undefined
  const keys = chat.locations?.getTurn(task.turn!) ?? []
  const preferred = [...keys].reverse().find(key => {
    const n = chat.nodes?.get(key)
    return n?.kind === 'turn-tail' && n.location?.turn?.turn === task.turn
  })
  return preferred ?? [...keys].reverse().find(key => {
    const n = chat.nodes?.get(key)
    return n?.location?.turn?.turn === task.turn && n?.kind === 'assistant-step'
  })
}

export function applyTaskCards(
  tasks: readonly MemoryTask[], chat: Parameters<typeof taskAnchorKey>[1],
  onOpen: (task: MemoryTask, body: HTMLElement) => void,
): void {
  if (typeof document === 'undefined') return
  const containers = document.querySelectorAll<HTMLElement>('[data-chat-flow]')
  for (const container of containers) {
    const anchors = new Map(tasks.map(t => [t.id, taskAnchorKey(t, chat)]))
    for (const stale of container.querySelectorAll<HTMLElement>('[data-meow-task-card]')) {
      const id = stale.getAttribute('data-meow-task-card') ?? ''
      const key = anchors.get(id)
      if (!key || !container.querySelector(`[data-chat-flow-key="${CSS.escape(key)}"]`)) stale.remove()
    }
    for (const task of tasks) {
      const key = taskAnchorKey(task, chat)
      if (!key) continue // no verified parent row: never attach to a different turn
      const row = container.querySelector<HTMLElement>(`[data-chat-flow-key="${CSS.escape(key)}"]`)
      if (!row?.parentElement) continue
      let card = container.querySelector<HTMLElement>(`[data-meow-task-card="${CSS.escape(task.id)}"]`)
      if (!card) {
        card = document.createElement('div')
        card.setAttribute('data-meow-task-card', task.id)
        const button = document.createElement('button')
        button.type = 'button'
        button.style.cssText = 'display:block;width:100%;margin:4px 0;padding:5px 12px;text-align:left;cursor:pointer;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border:0'
        const body = document.createElement('div')
        body.setAttribute('data-meow-task-markdown', 'true')
        body.style.cssText = 'display:none;overflow:auto;max-height:70vh;padding:10px;word-break:break-word;line-height:1.7'
        body.style.display = 'none'
        button.addEventListener('click', () => {
          const open = body.style.display !== 'none'
          body.style.display = open ? 'none' : 'block'
          if (!open) onOpen((card as HTMLElement & { meowTask: MemoryTask }).meowTask, body)
        })
        card.append(button, body)
      }
      (card as HTMLElement & { meowTask: MemoryTask }).meowTask = task
      if (card.previousElementSibling !== row) row.after(card)
      const button = card.querySelector('button')!
      const label = `${task.kind === 'dream' ? '梦境整理' : '记忆反思'} · ${task.status === 'running' ? '进行中' : task.status === 'done' ? '审查已完成（不代表新增记忆）' : '失败'} · 查看过程与结果`
      if (button.textContent !== label) button.textContent = label
    }
  }
}
