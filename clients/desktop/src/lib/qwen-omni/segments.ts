// ══════════════════════════════════════════════
// Transcript segment 类型 + 解析器
// 统一兼容两种格式：
//   - 新版 JSONL：每行一条 JSON 对象 {start, end, text, ...}
//   - 老版文本：以 [mm:ss.xxx – mm:ss.xxx] 时间戳开头的多行段落
// ══════════════════════════════════════════════

import type { TranscribeKind } from './transcribe'

export interface TranscriptSegment {
  start: number   // 秒（小数）
  end: number     // 秒
  text: string
  tags?: string[]
  speaker?: string | null
  kind?: 'speech' | 'bgm' | 'sfx' | 'ambient' | 'scene' | 'slide'
}

/** 把 mm:ss(.xxx) 转秒数 */
export function parseTimecode(s: string): number {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (!m) return NaN
  const min = Number(m[1]), sec = Number(m[2])
  const frac = m[3] ? Number(`0.${m[3]}`) : 0
  return min * 60 + sec + frac
}

/** 秒数转 mm:ss.xxx */
export function formatTimecode(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

/** 嗅探格式：JSONL 以 `{` 开头；其它走老文本 */
export function isJsonl(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('{')
}

/** 剥掉 ```json ``` 围栏（模型偶尔会偷加） */
export function stripFence(text: string): string {
  return text
    .replace(/^\s*```(?:jsonl?|JSONL?)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
}

/** 解析 JSONL 单行；非法返回 null */
export function parseJsonlLine(
  line: string,
  kind: TranscribeKind,
): TranscriptSegment | null {
  const t = line.trim()
  if (!t || !t.startsWith('{')) return null
  try {
    const j = JSON.parse(t) as Record<string, unknown>
    const start = Number(j.start)
    const end = Number(j.end)
    const text = typeof j.text === 'string' ? j.text : ''
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    const seg: TranscriptSegment = { start, end, text }
    if (kind !== 'audio' && Array.isArray(j.tags)) {
      seg.tags = (j.tags as unknown[]).filter((x): x is string => typeof x === 'string')
    }
    if (kind !== 'visual') {
      if (typeof j.speaker === 'string' || j.speaker === null) {
        seg.speaker = j.speaker as string | null
      }
      const VALID_KINDS = ['speech', 'bgm', 'sfx', 'ambient', 'scene', 'slide'] as const
      if (VALID_KINDS.includes(j.kind as (typeof VALID_KINDS)[number])) {
        seg.kind = j.kind as TranscriptSegment['kind']
      }
    }
    return seg
  } catch {
    return null
  }
}

function extractJsonObjects(text: string): string[] {
  const stripped = stripFence(text)
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      if (depth > 0) depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(stripped.slice(start, i + 1))
        start = -1
      }
    }
  }

  return objects
}

/** 解析整段 JSONL 文本（已存 DB 或流结束后） */
export function parseJsonl(text: string, kind: TranscribeKind): TranscriptSegment[] {
  const stripped = stripFence(text)
  const segs: TranscriptSegment[] = []
  for (const line of stripped.split('\n')) {
    const seg = parseJsonlLine(line, kind)
    if (seg) segs.push(seg)
  }
  if (segs.length === 0) {
    for (const obj of extractJsonObjects(stripped)) {
      const seg = parseJsonlLine(obj, kind)
      if (seg) segs.push(seg)
    }
  }
  return segs
}

const TIMESTAMP_RE = /^\[?\s*(\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*[–—-]\s*(\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*\]?\s*$/

/** 解析老版文本（以时间戳行分段） */
export function parseLegacyText(text: string, _kind: TranscribeKind): TranscriptSegment[] {
  const segs: TranscriptSegment[] = []
  let cur: { start: number; end: number; body: string[] } | null = null
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    const m = trimmed.match(TIMESTAMP_RE)
    if (m) {
      if (cur && cur.body.length) {
        segs.push({ start: cur.start, end: cur.end, text: cur.body.join(' ').trim() })
      }
      cur = { start: parseTimecode(m[1]), end: parseTimecode(m[2]), body: [] }
    } else if (cur && trimmed) {
      cur.body.push(trimmed)
    }
  }
  if (cur && cur.body.length) {
    segs.push({ start: cur.start, end: cur.end, text: cur.body.join(' ').trim() })
  }
  return segs
}

/** 统一入口：嗅探格式后分发（支持 JSONL / JSON 数组 / 旧版时间戳文本） */
export function parseTranscript(text: string, kind: TranscribeKind): TranscriptSegment[] {
  if (!text || !text.trim()) return []
  // 先剥围栏，判断实际内容格式
  const stripped = stripFence(text.trim())
  // JSON 数组格式（模型忽略了"不要外层数组"指令）
  if (stripped.startsWith('[')) {
    try {
      const arr = JSON.parse(stripped)
      if (Array.isArray(arr)) {
        return arr.flatMap((item) => {
          const seg = parseJsonlLine(JSON.stringify(item), kind)
          return seg ? [seg] : []
        })
      }
    } catch { /* fall through */ }
  }
  return isJsonl(text) ? parseJsonl(text, kind) : parseLegacyText(text, kind)
}

// ══════════════════════════════════════════════
// JSONL 流式行缓冲（SSE delta 拼接 → 完整行 → segment）
// ══════════════════════════════════════════════

export interface JsonlLineBuffer {
  /** 推入新的 delta 文本，返回此次新解析出的 segments */
  push: (delta: string) => TranscriptSegment[]
  /** 流结束后 flush 最后一段（无 \n 收尾的情况） */
  flush: () => TranscriptSegment[]
}

export function createJsonlLineBuffer(kind: TranscribeKind): JsonlLineBuffer {
  let buf = ''
  let stripped = false
  return {
    push(delta) {
      buf += delta
      // 第一次见到内容时尝试剥围栏
      if (!stripped && buf.includes('\n')) {
        const idx = buf.indexOf('\n')
        const head = buf.slice(0, idx).trim()
        if (head.startsWith('```')) {
          buf = buf.slice(idx + 1)
        }
        stripped = true
      }
      const out: TranscriptSegment[] = []
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const seg = parseJsonlLine(line, kind)
        if (seg) out.push(seg)
      }
      return out
    },
    flush() {
      const out: TranscriptSegment[] = []
      const tail = buf.trim().replace(/```$/, '').trim()
      if (tail) {
        const segs = parseJsonl(tail, kind)
        out.push(...segs)
      }
      buf = ''
      return out
    },
  }
}
