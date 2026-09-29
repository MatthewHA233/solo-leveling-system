// ══════════════════════════════════════════════
// 动机 → 行动蓝图（AI 先长，用户再改）
//   输入：动机原话 + 它被记录时的语境片段（绑定这条动机的原文 / 用户原话）
//   输出：2~4 个方向 × 2~4 个步骤
// ══════════════════════════════════════════════

import { queryModel } from '../../lib/llm/api'
import { createUserMessage } from '../../lib/llm/types'
import { loadConfig, getDashScopeApiKey } from '../../lib/agent/agent-config'
import { getFeatureModel } from '../../lib/model-audit'
import type { MotiveBlueprint } from '../../lib/local-api'

const FEATURE = 'motive_blueprint'
const DEFAULT_MODEL = 'qwen3.6-plus'
/** 语境片段最多几条、每条最多几个字 */
const MAX_CONTEXTS = 4
const MAX_CONTEXT_CHARS = 140

const SYSTEM_PROMPT = `你在帮用户把一条「动机」展开成行动蓝图。动机是他自己的原话；语境是这条动机被记录时，他正在看的内容或当时说的话。

输出 2~4 个「方向」，每个方向 2~4 个「步骤」：
- 方向：推进这条动机的一条路径，名词短语，不超过 10 个字
- 步骤：具体、可以直接开始的动作，以动词开头，不超过 18 个字
- 第一个方向的第一步，必须是今天 15 分钟内就能做完的事
- 如果动机是远期愿望（比如"财富自由以后……"），第一个方向写"现在就能碰到它"的最小练习，不要劝他先去赚钱
- 贴着语境写，不要写放之四海皆准的套话
- 不评价这条动机，不说教，不写鼓励的话

只输出 JSON，不要代码块，不要解释：
{"directions":[{"title":"……","steps":["……","……"]}]}`

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 从模型输出里抠出 JSON 并校验成蓝图；不合规返回 null */
function parseBlueprintReply(reply: string): MotiveBlueprint | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(reply.slice(start, end + 1)) as { directions?: unknown }
    if (!Array.isArray(raw.directions)) return null
    const directions = raw.directions
      .map((d) => {
        const dir = d as { title?: unknown; steps?: unknown }
        const title = typeof dir.title === 'string' ? dir.title.trim() : ''
        const steps = Array.isArray(dir.steps)
          ? dir.steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
          : []
        return { title, steps: steps.slice(0, 4) }
      })
      .filter((d) => d.title !== '')
      .slice(0, 4)
    return directions.length > 0 ? { directions } : null
  } catch {
    return null
  }
}

export async function generateBlueprint(motive: string, contexts: readonly string[]): Promise<MotiveBlueprint> {
  const config = loadConfig()
  const apiKey = getDashScopeApiKey(config) ?? ''
  if (!apiKey) throw new Error('还没配置 DashScope API Key：在「模型」里填好后再展开')

  const model = await getFeatureModel(FEATURE, DEFAULT_MODEL)
  const contextLines = contexts
    .map((c) => clip(c, MAX_CONTEXT_CHARS))
    .filter((c) => c !== '')
    .slice(0, MAX_CONTEXTS)
  const userText = contextLines.length > 0
    ? `动机：${motive}\n\n记录这条动机时的语境：\n${contextLines.map((c) => `- ${c}`).join('\n')}`
    : `动机：${motive}`

  const stream = queryModel([createUserMessage(userText)], {
    apiKey,
    apiBase: config.openaiApiBase,
    model,
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 800,
    feature: FEATURE,
  })

  let full = ''
  for await (const chunk of stream) {
    if (chunk.type === 'textDelta') full += chunk.delta
    else if (chunk.type === 'error') throw new Error(`模型调用失败（${model}）：${chunk.message}`)
  }
  const blueprint = parseBlueprintReply(full)
  if (!blueprint) throw new Error('模型没有按格式给出蓝图，再展开一次试试')
  return blueprint
}
