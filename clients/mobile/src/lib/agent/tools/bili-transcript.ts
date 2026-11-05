// ══════════════════════════════════════════════
// B 站转录读取 — 经局域网从桌面端拉逐句结构 / 纯文本（desktop src/lib/bili-transcript.ts）
// 数据来源 ② 桌面端：desktop 走 Tauri 命令 get_bili_transcripts，手机端走同语义的 /api/bilibili/transcripts。
//
// 和 desktop 的两点不同：
//   · 读取失败往外抛，不收口成 null。desktop 读的是本机数据库，几乎不会失败；手机端隔着局域网，
//     收口成 null 后工具会说「该视频没有转录句子」，模型就把连不上说成没有转录。
//   · 空结果不缓存。转录在桌面端跑，手机端这边进程常驻，缓存了空结果就要重启才能看到新转录。
// ══════════════════════════════════════════════

import { fetchBiliTranscripts } from '../../desktop-api'

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

// 按 refPath 记忆化：同一张卡反复展开/锚定不重复请求
const sentenceCache = new Map<string, TranscriptSentence[]>()

/** 读 ref_path 对应的逐句转录；无文件/无文本返回 null；连不上或桌面端报错时抛错 */
export async function fetchBiliTranscriptSentences(refPath: string | null | undefined): Promise<TranscriptSentence[] | null> {
  if (!refPath) return null
  const hit = sentenceCache.get(refPath)
  if (hit !== undefined) return hit
  const resp = await fetchBiliTranscripts(refPath)
  const raw = resp.combined || resp.audio || resp.visual || ''
  const sentences = raw ? jsonlToSentences(raw) : []
  if (sentences.length === 0) return null
  sentenceCache.set(refPath, sentences)
  return sentences
}

/** 读 ref_path 对应的转录纯文本；无文件/无文本返回 null；连不上或桌面端报错时抛错 */
export async function fetchBiliTranscriptPlain(refPath: string | null | undefined): Promise<string | null> {
  const sentences = await fetchBiliTranscriptSentences(refPath)
  return sentences ? sentences.map((s) => s.text).join('') : null
}
