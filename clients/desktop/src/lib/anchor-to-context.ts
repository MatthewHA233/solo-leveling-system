// ══════════════════════════════════════════════
// 语境锚定 — 对着语境卡（视频转录/文章）聊天时，AI 把你的想法锚定回语境
//
//   输入：语境全文 + 你说的话
//   输出：① 从语境「复制」出最相关的原文片段（供前端 indexOf 定位，不报数字位置）
//         ② 想法卡正文（接近原话、轻润色）
//         ③ 锚点关键词（从你的想法提取，归三类）
//   复用 queryModel + DashScope 配置；纯 prompt + JSON parse。
// ══════════════════════════════════════════════

import { queryModel } from './llm/api'
import { createUserMessage } from './llm/types'
import { loadConfig, getDashScopeApiKey } from './agent/agent-config'
import { getFeatureModel } from './model-audit'
import type { AnchorCategory } from './local-api'
import { ANCHOR_TAXONOMY } from './anchor-taxonomy'

export interface ContextAnchorResult {
  segment: string   // 从语境复制的原文片段（前端用 indexOf 定位）
  thought: string   // 想法卡正文
  anchors: Array<{ keyword: string; category: AnchorCategory }>
}

const SYSTEM_PROMPT = `你是「语境锚定器」。主人正在看一段语境（视频转录 / 文章），并对你说了一句话。

你的任务，严格按顺序：
0. 先判断这句话值不值得记录：必须是主人对语境的**真实想法/反应**（亲身经验、观点、动机、收获）。若只是提问、查询、给你的指令、测试、闲聊寒暄、对本软件界面/功能的评论、或与语境无关——**直接输出 {"worth":false}，跳过后面所有步骤**。宁可漏掉，绝不误记：大多数话都不值得记。
1. 从【语境原文】里**逐字复制**出与主人想法最相关的一段原文（1~2 句、连续片段，必须和原文一字不差，用于定位高亮）
2. 把主人的想法整理成想法卡正文：尽量贴近主人原话表述，只去口语啰嗦、轻微润色通顺，不总结、不改写核心、不加你的评论
3. 从主人的想法里提取锚点。${ANCHOR_TAXONOMY}

只输出 JSON，无任何额外文字或代码块标记：
- 值得：{"worth":true,"segment":"<从语境逐字复制的原文片段>","thought":"<想法卡正文>","anchors":[{"keyword":"..","category":".."}]}
- 不值得：{"worth":false}

若想法值得记但和语境对不上具体段落，segment 留空字符串。`

/** 对着语境聊天 → 锚定结果。无法锚定 / 失败返回 null。 */
export async function anchorToContext(contextText: string, userText: string): Promise<ContextAnchorResult | null> {
  const speech = userText.trim()
  if (speech.length < 6) return null

  const config = loadConfig()
  const apiKey = getDashScopeApiKey(config) ?? ''
  if (!apiKey) return null

  // 不读 legacy openaiCardModel（可能存着已下架模型），固定现代默认
  const model = await getFeatureModel('context_anchor', 'qwen3.6-flash')
  // 语境全文可能很长，截断到合理长度喂给模型（保留前 ~6000 字）
  const ctx = contextText.length > 6000 ? contextText.slice(0, 6000) + '…' : contextText
  const userMsg = createUserMessage(`【语境原文】\n${ctx}\n\n【主人的想法】\n${speech}`)

  const stream = queryModel([userMsg], {
    apiKey,
    apiBase: config.openaiApiBase,
    model,
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 700,
    feature: 'context_anchor',
  })

  let full = ''
  for await (const chunk of stream) {
    if (chunk.type === 'textDelta') full += chunk.delta
    else if (chunk.type === 'error') return null
  }

  return parseResult(full)
}

function parseResult(raw: string): ContextAnchorResult | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>
    if (obj.worth !== true) return null // 值得性闸门：模型判不值得就什么都不记
    const segment = typeof obj.segment === 'string' ? obj.segment.trim() : ''
    const thought = typeof obj.thought === 'string' ? obj.thought.trim() : ''
    if (!thought) return null // 至少要有想法
    const valid: AnchorCategory[] = ['motive', 'view', 'practice']
    const anchors = Array.isArray(obj.anchors)
      ? obj.anchors
          .map((x) => {
            if (!x || typeof x !== 'object') return null
            const o = x as Record<string, unknown>
            const keyword = typeof o.keyword === 'string' ? o.keyword.trim() : ''
            const category = o.category as AnchorCategory
            if (!keyword || !valid.includes(category)) return null
            return { keyword, category }
          })
          .filter((x): x is { keyword: string; category: AnchorCategory } => x !== null)
          .slice(0, 3)
      : []
    return { segment, thought, anchors }
  } catch {
    return null
  }
}
