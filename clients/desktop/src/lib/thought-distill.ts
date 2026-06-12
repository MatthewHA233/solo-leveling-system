// ══════════════════════════════════════════════
// 想法沉淀 — 日常聊天里，AI 判断哪段话值得记成想法卡 + 锚点
//
// 正文：尽可能接近原话表述、只轻微润色，不总结不改写核心。
// 复用 queryModel + DashScope 配置；纯 prompt + JSON parse。
// ══════════════════════════════════════════════

import { queryModel } from './llm/api'
import { createUserMessage } from './llm/types'
import { loadConfig, getDashScopeApiKey } from './agent/agent-config'
import { getFeatureModel } from './model-audit'
import type { AnchorCategory } from './local-api'
import { ANCHOR_TAXONOMY } from './anchor-taxonomy'

export interface DistilledThought {
  cardText: string
  anchors: Array<{ keyword: string; category: AnchorCategory }>
}

const SYSTEM_PROMPT = `你是「想法沉淀器」。主人在日常聊天里偶尔会说出值得长期记录的经验、发现、技巧、教训、观点。你的职责是把这些**极少数**瞬间挑出来——**宁可漏掉，绝不误记**：绝大多数聊天都不值得记，默认答案是 worth=false。

只有同时满足这三条才值得：
1. 主人在陈述自己的东西（亲身经验/发现/观点/打算），不是在让你做事
2. 内容具体、有信息量，几周后回看仍有价值
3. 这段话本身完整、可独立理解

以下一律不值得（worth=false）：
- 提问、查询、计算请求、测试性指令（"23乘17等于多少""随便想一个…""这张卡片说了什么"）
- 给你的命令/任务（"帮我改一下""查一下""把那个…"）
- 对你或本软件界面/功能的评价反馈（"现在的界面不错""你回复太啰嗦"）
- 闲聊寒暄、情绪宣泄、简短确认（"好的""不错""嗯嗯"）

若值得，整理成想法卡：
- 正文：尽可能贴近主人的原话表述，只去掉口语啰嗦、轻微润色通顺即可，不总结、不改写核心、不替换术语、不加你的评论或建议
- 锚点：${ANCHOR_TAXONOMY}

只输出 JSON，无任何额外文字或代码块标记：
- 值得：{"worth":true,"card":"<想法卡正文>","anchors":[{"keyword":"开启secret scanning","category":"practice"}]}
- 不值得：{"worth":false}`

/** 判断并沉淀一段聊天为想法卡。不值得 / 失败返回 null。 */
export async function distillThought(userText: string): Promise<DistilledThought | null> {
  const text = userText.trim()
  if (text.length < 8) return null // 太短的话直接跳过，省一次调用

  const config = loadConfig()
  const apiKey = getDashScopeApiKey(config) ?? ''
  if (!apiKey) return null

  const model = await getFeatureModel('thought_distill', 'qwen3.6-flash')
  const userMsg = createUserMessage(`主人说：\n${text}`)

  const stream = queryModel([userMsg], {
    apiKey,
    apiBase: config.openaiApiBase,
    model,
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 600,
    feature: 'thought_distill',
  })

  let full = ''
  for await (const chunk of stream) {
    if (chunk.type === 'textDelta') full += chunk.delta
    else if (chunk.type === 'error') return null
  }

  return parseDistill(full)
}

function parseDistill(raw: string): DistilledThought | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>
    if (obj.worth !== true) return null
    const cardText = typeof obj.card === 'string' ? obj.card.trim() : ''
    if (!cardText) return null
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
    return { cardText, anchors }
  } catch {
    return null
  }
}
