/**
 * migrate-v0.ts — zstd FRAME-AWARE rewrite (v2, 2026-09-10).
 *
 * v1 的两个致命问题（真机实证）：
 *  1. zstdDecompressSync(whole file) 只解第一个 zstd 帧 —— dsh 的 .jsonl.zstd 是多帧容器
 *     （帧1=header 行、帧2+=事件批次），v1 于是"看不到"任何事件，files 恒 0（侥幸未写坏数据）；
 *  2. 写回时整体重压缩成单帧 —— 破坏 dsh 的 assertZstdHeaderFrame 物理校验，启动即
 *     "corrupt Zstandard session log"（独立脚本版就是这个原因写坏了 35 个文件，已全部从备份恢复）。
 *
 * v2 正确姿势（与 dsh-session-persistence-jsonl 物理层同构）：
 *  - 读：按 zstd 魔数扫描帧边界（同 scanZstdFrames），逐帧解压得到明文行集合；
 *  - 改：仅对明文行做手术式改写（逐行、canonical 校验、行内字符串手术）；
 *  - 写：帧1 = header 行（含尾 \n）单独成帧（保持 assertZstdHeaderFrame 通过），
 *        帧2 = 全部事件行拼接单独成帧（dsh 的 encodeMaterialization 同构）；
 *        每帧带 checksum（ZSTD_c_checksumFlag，与 dsh CHECKSUM_OPTIONS 一致）；
 *  - 幂等/备份/原子替换由逐文件检查点保证；处理前与替换前复核 identity，
 *    活动文件 deferred，损坏文件 failed，后续 Worker run 从检查点继续。
 */
import { randomUUID } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, lstatSync, linkSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import {
  emptySessionMigrationState,
  migrationTotals,
  readSessionMigrationState,
  writeSessionMigrationState,
  type SessionFileIdentity,
  type SessionMigrationFileState,
  type SessionMigrationState,
} from './migration-state.js'

const PLUGIN = 'meow-memory'
const META_SECTION_NAME = '__meta__'
const PLUGIN_MARKER = `"plugin":"${PLUGIN}"`
const MEMORY_KEY = '"memory":'
const SECTIONS_KEY = '"sections":['
const ZSTD_MAGIC = 0xfd2fb528 // 4247762216 LE
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/* ---------------- frame scanning（同 dsh scanZstdFrames 的边界定位语义） ---------------- */

interface Frame { start: number; end: number }

function scanFrames(buf: Buffer): Frame[] {
  const frames: Frame[] = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) throw new Error('torn frame header')
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buf.length) throw new Error('torn frame after magic')
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) throw new Error('torn frame header fields')
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) throw new Error('torn block header')
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('reserved block type')
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) throw new Error('torn block payload')
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) throw new Error('torn checksum')
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** 逐帧解压整个容器，返回拼接明文（等价 zstd CLI -d -c）。 */
function decompressAllFrames(buf: Buffer): Buffer {
  const frames = scanFrames(buf)
  const parts: Buffer[] = []
  for (const f of frames) parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)))
  return Buffer.concat(parts)
}

const compressFrame = (input: Buffer): Buffer => zstdCompressSync(input, CHECKSUM_OPTIONS)

/* ---------------- 行手术（与独立脚本同源，已 35/35 dry-run 验证） ---------------- */

interface MemoryHit { form?: string; memory: unknown }

function collectPluginMemories(node: unknown, hits: MemoryHit[]): void {
  if (Array.isArray(node)) { for (const v of node) collectPluginMemories(v, hits); return }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    if (o.kind === 'plugin' && o.plugin === PLUGIN && Object.prototype.hasOwnProperty.call(o, 'memory')) {
      hits.push({ form: o.form as string | undefined, memory: o.memory })
    }
    for (const k of Object.keys(o)) collectPluginMemories(o[k], hits)
  }
}

function balancedObjectAt(line: string, fromIdx: number): { objStart: number; objText: string } | null {
  const objStart = line.lastIndexOf('{', fromIdx)
  if (objStart < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = objStart; i < line.length; i++) {
    const ch = line[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return { objStart, objText: line.slice(objStart, i + 1) }
    }
  }
  return null
}

function balancedValueEnd(text: string, valueStart: number): number {
  let depth = 0, inStr = false, esc = false
  for (let i = valueStart; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      if (depth === 0) return i
      depth--
      if (depth === 0) return i + 1
    } else if (ch === ',' && depth === 0) return i
  }
  return -1
}

interface MemoryLoc {
  memoryStart: number; memoryEnd: number; valueText: string
  hasSections: boolean; sectionsInsertAt: number; sectionsEmpty: boolean
  form?: string; refusal?: string
}

function locateNextMemory(out: string): MemoryLoc | null {
  let searchFrom = 0
  for (let guard = 0; guard < 50; guard++) {
    const pluginIdx = out.indexOf(PLUGIN_MARKER, searchFrom)
    if (pluginIdx < 0) return null
    searchFrom = pluginIdx + 1
    const obj = balancedObjectAt(out, pluginIdx)
    if (!obj) continue
    let parsedObj: Record<string, unknown>
    try { parsedObj = JSON.parse(obj.objText) as Record<string, unknown> } catch { continue }
    if (!parsedObj || parsedObj.plugin !== PLUGIN || !Object.prototype.hasOwnProperty.call(parsedObj, 'memory')) continue
    const memKeyRel = obj.objText.indexOf(MEMORY_KEY)
    if (memKeyRel < 0) continue
    const valStartRel = memKeyRel + MEMORY_KEY.length
    const valEndRel = balancedValueEnd(obj.objText, valStartRel)
    if (valEndRel < 0) continue
    const valueText = obj.objText.slice(valStartRel, valEndRel)
    const hasSections = Array.isArray(parsedObj.sections)
    let sectionsInsertAt = -1
    let sectionsEmpty = false
    if (hasSections) {
      const sKeyRel = obj.objText.indexOf(SECTIONS_KEY, valEndRel)
      if (sKeyRel < 0) return { memoryStart: -1, memoryEnd: -1, valueText: '', hasSections, sectionsInsertAt: -1, sectionsEmpty, refusal: 'sections-array-but-no-key-after-memory' }
      sectionsInsertAt = obj.objStart + sKeyRel + SECTIONS_KEY.length
      sectionsEmpty = out[sectionsInsertAt] === ']'
      if (sectionsInsertAt < obj.objStart + valEndRel) return { memoryStart: -1, memoryEnd: -1, valueText: '', hasSections, sectionsInsertAt: -1, sectionsEmpty, refusal: 'sections-before-memory' }
    }
    return { memoryStart: obj.objStart + memKeyRel, memoryEnd: obj.objStart + valEndRel, valueText, hasSections, sectionsInsertAt, sectionsEmpty, form: parsedObj.form as string | undefined }
  }
  return null
}

function removeMemberAt(line: string, memStart: number, memEnd: number): string {
  if (line[memEnd] === ',') return line.slice(0, memStart) + line.slice(memEnd + 1)
  if (line[memStart - 1] === ',') return line.slice(0, memStart - 1) + line.slice(memEnd)
  return line.slice(0, memStart) + line.slice(memEnd)
}

function migrateLine(line: string): { line: string; changed: number; note?: string } {
  if (!line.includes(PLUGIN_MARKER) || !line.includes(MEMORY_KEY)) return { line, changed: 0 }
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return { line, changed: 0, note: 'unparsable-line' } }
  const pre: MemoryHit[] = []
  collectPluginMemories(parsed, pre)
  if (pre.length === 0) return { line, changed: 0 }
  const preCanons = new Set(pre.map((p) => JSON.stringify(p.memory)))

  let out = line
  let changed = 0
  for (let guard = 0; guard < 10; guard++) {
    const loc = locateNextMemory(out)
    if (!loc) break
    if (loc.refusal) return { line, changed, note: 'refused:' + loc.refusal }
    let memVal: unknown
    try { memVal = JSON.parse(loc.valueText) } catch { return { line, changed, note: 'memory-value-unparsable' } }
    if (!preCanons.has(JSON.stringify(memVal))) return { line, changed, note: 'byte-structure-mismatch' }

    if (loc.hasSections) {
      if (loc.form !== 'snapshot') return { line, changed, note: 'sections-with-form-' + loc.form }
      const metaSection = `{"name":"${META_SECTION_NAME}","text":${JSON.stringify(loc.valueText)}}`
      out = out.slice(0, loc.sectionsInsertAt) + metaSection + (loc.sectionsEmpty ? '' : ',') + out.slice(loc.sectionsInsertAt)
      out = removeMemberAt(out, loc.memoryStart, loc.memoryEnd)
    } else if (loc.form === 'notice') {
      out = removeMemberAt(out, loc.memoryStart, loc.memoryEnd)
    } else {
      return { line, changed, note: 'unsupported-form-' + loc.form }
    }
    changed++
  }
  if (changed === 0) return { line, changed: 0, note: 'located-but-not-migrated' }
  let reparsed: unknown
  try { reparsed = JSON.parse(out) } catch { return { line, changed: 0, note: 'post-parse-failed' } }
  const leftover: MemoryHit[] = []
  collectPluginMemories(reparsed, leftover)
  if (leftover.length > 0) return { line, changed: 0, note: 'post-memory-remains' }
  return { line: out, changed }
}

/* ---------------- 文件枚举与帧级处理 ---------------- */

export function listSessionFiles(home: string): string[] {
  const files: string[] = []
  for (const rootName of ['sessions', 'archived-sessions']) {
    const root = join(home, rootName)
    try {
      if (!lstatSync(root).isDirectory()) continue
    } catch {
      continue
    }
    let projects
    try { projects = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const project of projects) {
      // Session roots are owned directories. Do not follow user-created links outside DSH_HOME.
      if (!project.isDirectory()) continue
      const projectDir = join(root, project.name)
      let sessions
      try { sessions = readdirSync(projectDir, { withFileTypes: true }) } catch { continue }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const file = join(projectDir, session.name, 'session.jsonl.zstd')
        try {
          if (lstatSync(file).isFile()) files.push(file)
        } catch {
          // A disappearing or unreadable entry is retried on a later run.
        }
      }
    }
  }
  return files.sort()
}

function backupPathFor(home: string, file: string): string {
  const rel = relative(home, file)
  if (rel.startsWith('..')) return file + '.pre-migrate.bak'
  return join(home, 'pre-migrate-backup', rel)
}

function ensureOriginalBackup(home: string, file: string, raw: Buffer): void {
  const backup = backupPathFor(home, file)
  mkdirSync(dirname(backup), { recursive: true })
  if (existsSync(backup)) {
    // A prior complete backup is intentionally immutable. Validate its physical
    // zstd structure so a crash-truncated legacy backup cannot bless a rewrite.
    decompressAllFrames(readFileSync(backup))
    return
  }

  // Publish only a fully written inode. Hard-link installation is an atomic
  // no-replace operation; filesystems without hard links use rename under the
  // migration's single-instance lock.
  const temporary = `${backup}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, raw, { flag: 'wx', mode: 0o600 })
    try {
      linkSync(temporary, backup)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'EEXIST') return
      if (code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EPERM' && code !== 'EXDEV') throw error
    }
    if (!existsSync(backup)) renameSync(temporary, backup)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function identityOf(file: string): SessionFileIdentity {
  const stat = statSync(file)
  return { size: stat.size, mtimeMs: stat.mtimeMs }
}

function sameIdentity(left: SessionFileIdentity, right: SessionFileIdentity): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs
}

function relativeSessionPath(home: string, file: string): string {
  return relative(home, file).split(sep).join('/')
}

export interface ProcessSessionFileOptions {
  expectedIdentity: SessionFileIdentity
  log?: (message: string) => void
  /** Test/instrumentation hook run immediately before the final identity check. */
  beforeReplace?: (file: string) => void
}

export interface ProcessSessionFileResult {
  status: 'done' | 'deferred'
  result?: 'unchanged' | 'migrated'
  migratedLines: number
  identity: SessionFileIdentity
  error?: string
}

/** Process one session without throwing for normal activity races. */
export function processSessionFile(
  home: string,
  file: string,
  options: ProcessSessionFileOptions,
): ProcessSessionFileResult {
  const initialIdentity = identityOf(file)
  if (!sameIdentity(initialIdentity, options.expectedIdentity)) {
    return {
      status: 'deferred',
      migratedLines: 0,
      identity: initialIdentity,
      error: 'file changed before processing',
    }
  }

  const rawBuf = readFileSync(file)
  // 快速预筛：直接在压缩字节里找不了明文——逐帧解压第一帧（header）太便宜但事件在后面帧；
  // 折中：先全帧解压（与 zstd CLI 等价），无标记即刻返回。
  const raw = decompressAllFrames(rawBuf).toString('utf8')
  if (!raw.includes(PLUGIN_MARKER) || !raw.includes(MEMORY_KEY)) {
    const finalIdentity = identityOf(file)
    if (!sameIdentity(initialIdentity, finalIdentity)) {
      return { status: 'deferred', migratedLines: 0, identity: finalIdentity, error: 'file changed while processing' }
    }
    return { status: 'done', result: 'unchanged', migratedLines: 0, identity: finalIdentity }
  }

  const lines = raw.split('\n')
  let changed = 0
  const outLines = lines.map((l) => {
    if (!l.includes(PLUGIN_MARKER) || !l.includes(MEMORY_KEY)) return l
    const result = migrateLine(l)
    if (result.note !== undefined) throw new Error(`refused session line: ${result.note}`)
    if (result.changed > 0) {
      changed += result.changed
      return result.line
    }
    return l
  })
  if (changed === 0) {
    const finalIdentity = identityOf(file)
    if (!sameIdentity(initialIdentity, finalIdentity)) {
      return { status: 'deferred', migratedLines: 0, identity: finalIdentity, error: 'file changed while processing' }
    }
    return { status: 'done', result: 'unchanged', migratedLines: 0, identity: finalIdentity }
  }

  // 帧级重编码（dsh encodeMaterialization 同构）：帧1 = header 行（独立、含尾\n），帧2 = 事件体
  // 明文行结构：lines[0] 必为 header 行（含尾随空元素——split 产物）。重建时保留原始行集合，
  // 仅确保 header 独立成帧、其余行合为一帧；行间 \n 与原文件一致（split/join 抵消）。
  const headerLine = outLines[0] ?? ''
  const bodyText = outLines.length > 1 ? outLines.slice(1).join('\n') : ''
  const headerFrame = compressFrame(Buffer.from(headerLine + '\n', 'utf8'))
  const frames: Buffer[] = [headerFrame]
  if (bodyText.length > 0) frames.push(compressFrame(Buffer.from(bodyText, 'utf8')))
  const outBuf = Buffer.concat(frames)

  const tmpOut = `${file}.migrated-${process.pid}-${randomUUID()}.tmp.zst`
  try {
    writeFileSync(tmpOut, outBuf, { flag: 'wx' })
    options.beforeReplace?.(file)
    const beforeReplaceIdentity = identityOf(file)
    if (!sameIdentity(initialIdentity, beforeReplaceIdentity)) {
      return {
        status: 'deferred',
        migratedLines: 0,
        identity: beforeReplaceIdentity,
        error: 'file changed before atomic replacement',
      }
    }

    ensureOriginalBackup(home, file, rawBuf)

    // Recheck after the backup write as it can take long enough for an active session to append.
    const afterBackupIdentity = identityOf(file)
    if (!sameIdentity(initialIdentity, afterBackupIdentity)) {
      return {
        status: 'deferred',
        migratedLines: 0,
        identity: afterBackupIdentity,
        error: 'file changed before atomic replacement',
      }
    }
    renameSync(tmpOut, file)
  } finally {
    rmSync(tmpOut, { force: true })
  }

  const migratedIdentity = identityOf(file)
  options.log?.(`migrated ${changed} line(s) in ${file}`)
  return { status: 'done', result: 'migrated', migratedLines: changed, identity: migratedIdentity }
}

/* ---------------- 入口 ---------------- */

export type SessionMigrationStopReason = 'pause' | 'stop'

export interface RunSessionMigrationOptions {
  shouldStop?: () => SessionMigrationStopReason | false
  onProgress?: (state: SessionMigrationState, file: SessionMigrationFileState) => void
  log?: (message: string) => void
  beforeReplace?: (file: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function checkpoint(
  dshHome: string,
  state: SessionMigrationState,
  discovered: number,
  status: SessionMigrationState['status'] = state.status,
): void {
  state.status = status
  state.updatedAt = new Date().toISOString()
  state.totals = migrationTotals(state.files, discovered)
  writeSessionMigrationState(dshHome, state)
}

/** Run one resumable migration pass. Heavy work belongs in a Worker Thread. */
export async function runSessionMigration(
  dshHome: string,
  options: RunSessionMigrationOptions = {},
): Promise<SessionMigrationState> {
  const home = join(dshHome)
  const runId = randomUUID()
  const startedAt = new Date().toISOString()
  const state = readSessionMigrationState(home) ?? emptySessionMigrationState(home)
  const files = listSessionFiles(home)
  const discoveredKeys = new Set(files.map(file => relativeSessionPath(home, file)))

  state.files = Object.fromEntries(Object.entries(state.files).filter(([key]) => discoveredKeys.has(key)))
  state.runId = runId
  state.startedAt = startedAt
  delete state.completedAt
  checkpoint(home, state, files.length, 'running')

  options.log?.(`migration ${runId} started; discovered=${files.length}`)
  for (const file of files) {
    const stopReason = options.shouldStop?.() ?? false
    if (stopReason !== false) {
      checkpoint(home, state, files.length, 'paused')
      options.log?.(`migration ${runId} ${stopReason === 'pause' ? 'paused' : 'stopped'} at a file boundary`)
      return state
    }

    const relativePath = relativeSessionPath(home, file)
    let discoveredIdentity: SessionFileIdentity
    try {
      discoveredIdentity = identityOf(file)
    } catch (error) {
      const now = new Date().toISOString()
      const previous = state.files[relativePath]
      const entry: SessionMigrationFileState = {
        relativePath,
        identity: previous?.identity ?? { size: 0, mtimeMs: 0 },
        status: 'failed',
        migratedLines: 0,
        attempts: (previous?.attempts ?? 0) + 1,
        error: errorMessage(error),
        updatedAt: now,
      }
      state.files[relativePath] = entry
      checkpoint(home, state, files.length)
      options.onProgress?.(state, entry)
      await new Promise<void>(resolve => setImmediate(resolve))
      continue
    }

    const previous = state.files[relativePath]
    if (previous?.status === 'done' && sameIdentity(previous.identity, discoveredIdentity)) continue

    const attempts = (previous?.attempts ?? 0) + 1
    let entry: SessionMigrationFileState
    try {
      const result = processSessionFile(home, file, {
        expectedIdentity: discoveredIdentity,
        log: options.log,
        beforeReplace: options.beforeReplace,
      })
      entry = {
        relativePath,
        identity: result.identity,
        status: result.status,
        ...(result.result === undefined ? {} : { result: result.result }),
        migratedLines: result.migratedLines,
        attempts,
        ...(result.error === undefined ? {} : { error: result.error }),
        updatedAt: new Date().toISOString(),
      }
    } catch (error) {
      let currentIdentity = discoveredIdentity
      try { currentIdentity = identityOf(file) } catch { /* retain discovered identity */ }
      entry = {
        relativePath,
        identity: currentIdentity,
        status: 'failed',
        migratedLines: 0,
        attempts,
        error: errorMessage(error),
        updatedAt: new Date().toISOString(),
      }
      options.log?.(`failed ${relativePath}: ${entry.error ?? 'unknown error'}`)
    }

    state.files[relativePath] = entry
    checkpoint(home, state, files.length)
    options.onProgress?.(state, entry)
    // Let the Worker receive pause/stop messages between files.
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  state.completedAt = new Date().toISOString()
  const totals = migrationTotals(state.files, files.length)
  checkpoint(home, state, files.length, totals.failed === 0 && totals.deferred === 0 ? 'completed' : 'completed-with-errors')
  options.log?.(
    `migration ${runId} finished; status=${state.status} discovered=${state.totals.discovered} `
    + `done=${state.totals.done} migratedFiles=${state.totals.migratedFiles} `
    + `failed=${state.totals.failed} deferred=${state.totals.deferred}`,
  )
  return state
}
