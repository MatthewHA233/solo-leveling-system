// ══════════════════════════════════════════════
// B 站转录读取 — 从本地缓存文件拉逐句结构 / 纯文本
// 供三处共用：语境库逐句展示（带时间戳跳播）、"注视即锚定"全文注入、锚定定位
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'

export interface BiliTranscriptCacheResp {
  readonly visual: string | null
  readonly audio: string | null
  readonly combined: string | null
}

export interface TranscriptSentence {
  readonly text: string
  readonly start: number | null   // 句首时间戳（秒）；非 JSONL 行没有
  readonly offset: number         // 在拼接全文（jsonlToPlain）里的起始下标，锚点高亮按它切片
}

/** ASR 转录是逐句 JSONL（{"start","end","text"}），解析成句子数组；非 JSON 行原样保留（无时间戳） */
export function jsonlToSentences(raw: string): TranscriptSentence[] {
  const out: TranscriptSentence[] = []
  let offset = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let text = t
    let start: number | null = null
    try {
      const obj = JSON.parse(t) as { text?: unknown; start?: unknown }
      if (typeof obj.text === 'string') {
        text = obj.text
        start = typeof obj.start === 'number' && Number.isFinite(obj.start) ? obj.start : null
      }
    } catch { /* 非 JSON 行 */ }
    if (!text) continue
    out.push({ text, start, offset })
    offset += text.length
  }
  return out
}

/** 拼接纯文本——必须与 jsonlToSentences 的 offset 严格一致（锚点高亮坐标基于它） */
export function jsonlToPlain(raw: string): string {
  return jsonlToSentences(raw).map((s) => s.text).join('')
}

// 按 refPath 记忆化：同一张卡反复展开/锚定不重复读盘
const sentenceCache = new Map<string, TranscriptSentence[]>()

/** 读 ref_path 对应的逐句转录；无文件/无文本/失败返回 null */
export async function fetchBiliTranscriptSentences(refPath: string | null | undefined): Promise<TranscriptSentence[] | null> {
  if (!refPath) return null
  const hit = sentenceCache.get(refPath)
  if (hit !== undefined) return hit.length ? hit : null
  try {
    const resp = await invoke<BiliTranscriptCacheResp>('get_bili_transcripts', { filePath: refPath })
    const raw = resp.combined || resp.audio || resp.visual || ''
    const sentences = raw ? jsonlToSentences(raw) : []
    sentenceCache.set(refPath, sentences)
    return sentences.length ? sentences : null
  } catch (e) {
    console.error('[BiliTranscript] 读取转录失败', e)
    return null
  }
}

/** 读 ref_path 对应的转录纯文本；无文件/无文本/失败返回 null */
export async function fetchBiliTranscriptPlain(refPath: string | null | undefined): Promise<string | null> {
  const sentences = await fetchBiliTranscriptSentences(refPath)
  return sentences ? sentences.map((s) => s.text).join('') : null
}
