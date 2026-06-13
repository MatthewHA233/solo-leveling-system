// ══════════════════════════════════════════════
// OCR 缝合 — 把逐帧 OCR（滚动重叠）交给文本大模型，还原成「按时间戳分段的字幕」
//
// 时间戳语义：以"新文本首次进入滚动视窗的时刻"为段边界——连续多帧无新增不切段，
// 底部冒出新文本时才以最早出现它的帧时间落一个新段。去重 + 去 UI 噪声 + 修明显错字。
// ══════════════════════════════════════════════

import { queryModel } from './llm/api'
import { createUserMessage } from './llm/types'
import { loadConfig, getDashScopeApiKey } from './agent/agent-config'
import { getFeatureModel } from './model-audit'

export const OCR_STITCH_FEATURE = 'ocr_article_stitch'

export interface OcrSegment {
  /** 该段文本首次出现的帧时间（秒） */
  start: number
  text: string
}

const STITCH_SYSTEM = `你会收到同一篇文章在屏幕上"自上而下滚动"时、按时间顺序逐帧 OCR 出的文本。每帧标注了它在视频里出现的时间（秒）。
相邻帧大量重叠（滚动重叠区），也夹带 OCR 错字和与正文无关的页面 UI 文字（点赞/评论/关注/转发/导航/作者卡片/广告/水印/时间戳等）。

请把它们还原成按阅读顺序排列的文章，并切成若干段，规则：
- 以"新文本首次进入视窗的时刻"为该段时间戳：连续多帧没有新增内容时不切段；一旦底部出现新文本，就以最早出现它的那一帧时间作为新段起点。
- 去掉滚动重叠造成的重复，保证全文不重不漏、顺序正确。
- 删除与正文无关的页面 UI 噪声；可在不改变原意的前提下修正明显的 OCR 错别字；不要翻译、不要总结、不要润色文风。
- 每段是一小段连续正文（通常几句到一个自然段），不要太碎，也不要整篇挤成一段。

只输出 JSON 数组，不要任何额外文字、解释或代码块标记：
[{"ts": 0, "text": "……"}, {"ts": 18, "text": "……"}]
ts 为秒（整数或小数），对应该段文本首次出现的帧时间。`

export interface StitchResult {
  segments: OcrSegment[]
  model: string
}

/**
 * 把逐帧 OCR 文本缝合成「带时间戳的字幕段」。
 * @param frames 按时间顺序的帧 { ts(秒), text }
 */
export async function stitchOcrToSegments(
  frames: { ts: number; text: string }[],
  opts: { signal?: AbortSignal; onPartial?: (raw: string) => void } = {},
): Promise<StitchResult> {
  const config = loadConfig()
  const apiKey = getDashScopeApiKey(config) ?? ''
  if (!apiKey) throw new Error('未配置 DashScope API Key（设置 → AI 模型）')

  const model = await getFeatureModel(OCR_STITCH_FEATURE, config.openaiCardModel || 'qwen-plus')

  const joined = frames
    .map((f) => `【@${Math.round(f.ts)}s】\n${f.text.trim()}`)
    .join('\n\n')
  const userMsg = createUserMessage(`以下是逐帧 OCR 文本（含滚动重叠），请按规则缝合成带时间戳的字幕段：\n\n${joined}`)

  const stream = queryModel([userMsg], {
    apiKey,
    apiBase: config.openaiApiBase,
    model,
    systemPrompt: STITCH_SYSTEM,
    maxTokens: 8000,
    signal: opts.signal,
    feature: OCR_STITCH_FEATURE,
  })

  let full = ''
  for await (const chunk of stream) {
    if (chunk.type === 'textDelta') { full += chunk.delta; opts.onPartial?.(full) }
    else if (chunk.type === 'error') throw new Error(chunk.message || '缝合模型调用失败')
  }

  return { segments: parseSegments(full), model }
}

/** 容错解析：抽出第一个 JSON 数组，过滤合法 {ts,text} 项，按 ts 升序。 */
export function parseSegments(raw: string): OcrSegment[] {
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .map((x) => {
        if (!x || typeof x !== 'object') return null
        const o = x as Record<string, unknown>
        const ts = typeof o.ts === 'number' ? o.ts : Number(o.ts)
        const text = typeof o.text === 'string' ? o.text.trim() : ''
        if (!Number.isFinite(ts) || !text) return null
        return { start: ts, text }
      })
      .filter((x): x is OcrSegment => x !== null)
      .sort((a, b) => a.start - b.start)
  } catch {
    return []
  }
}
