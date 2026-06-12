// ══════════════════════════════════════════════
// 锚点提取 — 从「你贴在语境上的原话」里提取锚点关键词并归三类
//
// 硬约束：AI 绝不改写/总结用户原话，只抽取关键词。
// 复用现有 queryModel + DashScope 配置；纯 prompt + JSON parse（不走 tool calling）。
// ══════════════════════════════════════════════

import { queryModel } from './llm/api'
import { createUserMessage } from './llm/types'
import { loadConfig, getDashScopeApiKey } from './agent/agent-config'
import { getFeatureModel } from './model-audit'
import type { AnchorCategory } from './local-api'
import { ANCHOR_TAXONOMY } from './anchor-taxonomy'

export interface ExtractedAnchor {
  keyword: string
  category: AnchorCategory
}

const SYSTEM_PROMPT = `你是「锚点提取器」。用户先框选一段语境文本，再说出自己对它的想法（原话）。
你的唯一任务：从用户的【原话】里提取锚点。${ANCHOR_TAXONOMY}

只输出 JSON 数组，不要任何额外文字、解释或代码块标记：
[{"keyword":"检查API Key泄露","category":"motive"}]
提不出有意义的锚点就输出 []`

/** 从原话 + 框选文段提取锚点关键词。失败抛错，无锚点返回 []。 */
export async function extractAnchors(userSpeech: string, selectedText: string): Promise<ExtractedAnchor[]> {
  const speech = userSpeech.trim()
  if (!speech) return []

  const config = loadConfig()
  const apiKey = getDashScopeApiKey(config) ?? ''
  if (!apiKey) throw new Error('未配置 DashScope API Key，无法提取锚点')

  const model = await getFeatureModel('anchor_extract', 'qwen3.6-flash')
  const userMsg = createUserMessage(
    `【语境文段】\n${selectedText}\n\n【我说的话】\n${speech}\n\n请从「我说的话」里提取锚点关键词。`,
  )

  const stream = queryModel([userMsg], {
    apiKey,
    apiBase: config.openaiApiBase,
    model,
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 600,
    feature: 'anchor_extract',
  })

  let full = ''
  for await (const chunk of stream) {
    if (chunk.type === 'textDelta') full += chunk.delta
    else if (chunk.type === 'error') throw new Error(chunk.message || '模型调用失败')
  }

  return parseAnchorJson(full)
}

/** 容错解析：抽出第一个 JSON 数组，过滤合法项。 */
function parseAnchorJson(raw: string): ExtractedAnchor[] {
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) return []
  const valid: AnchorCategory[] = ['motive', 'view', 'practice']
  try {
    const arr = JSON.parse(m[0]) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .map((x) => {
        if (!x || typeof x !== 'object') return null
        const o = x as Record<string, unknown>
        const keyword = typeof o.keyword === 'string' ? o.keyword.trim() : ''
        const category = o.category as AnchorCategory
        if (!keyword || !valid.includes(category)) return null
        return { keyword, category }
      })
      .filter((x): x is ExtractedAnchor => x !== null)
      .slice(0, 6)
  } catch {
    return []
  }
}
