// ══════════════════════════════════════════════
// Session Title — 用 LLM 给会话生成简短标题（对齐 desktop src/lib/ai/session-title.ts）
// 参考 Claude Code sessionTitle.ts 的设计：
//   · tail-slice 最近 1000 字对话
//   · 强 prompt + JSON 回复
//   · 3-7 字句型标题
// ══════════════════════════════════════════════

import { getDashScopeApiKey, type AgentConfig } from '../agent/agent-config'
import { isAnthropicModel } from '../llm/anthropic-stream'
import { queryModel } from '../llm/api'
import { createUserMessage } from '../llm/types'
import { getFeatureModel } from '../models/model-audit'
import { solevupGetActiveModelApiKey } from '../solevupdb'

const MAX_INPUT_CHARS = 1000

/**
 * 起标题只看这几个字段，会话消息和数据库行都满足。
 * role：user / assistant（库里的旧行和界面可能还叫 agent）/ tool / system。
 */
export interface TitleMessage {
  readonly role: string
  readonly content?: string | null
}

interface TitleCall {
  readonly apiKey: string
  readonly apiBase: string
  readonly model: string
}

// 一次性调用——只有标题生成这种短同步场景需要。
// desktop 是非流式 fetch；手机端统一走 queryModel，把流拼完就是整段回复。
// 用量已由 api 层按 feature 记账（Anthropic 通道同样），这里再记一次就算成两笔了。
// desktop 没传 max_tokens，这里也不传（走 queryModel 默认值）：思考模型的推理也占额度，压太低回复会被截断。
async function chatOnce(call: TitleCall, text: string, feature: string): Promise<string> {
  if (!call.apiKey && !isAnthropicModel(call.model)) throw new Error('API Key 未配置')

  let reply = ''
  const stream = queryModel([createUserMessage(text)], {
    apiKey: call.apiKey,
    apiBase: call.apiBase,
    model: call.model,
    systemPrompt: SYSTEM_PROMPT,
    feature,
  })
  for await (const chunk of stream) {
    if (chunk.type === 'textDelta') reply += chunk.delta
    else if (chunk.type === 'error') throw new Error(chunk.message)
  }
  return reply
}

function flattenForTitle(messages: readonly TitleMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    // 工具结果对标题无帮助；system 是手机端本地的界面提示，不是对话
    if (m.role === 'tool' || m.role === 'system') continue
    const content = (m.content ?? '').trim()
    if (!content) continue
    const tag = m.role === 'user' ? '用户' : '助手'
    parts.push(`${tag}: ${content}`)
  }
  const joined = parts.join('\n\n')
  return joined.length > MAX_INPUT_CHARS
    ? joined.slice(joined.length - MAX_INPUT_CHARS)
    : joined
}

const SYSTEM_PROMPT = `你是会话标题生成器。根据用户与助手的对话，产出一个 3-8 字的中文短标题，精炼地概括这次会话的主题或目标。

要求：
- 3-8 个字，名词短语，不要句号
- 抓住主题而非寒暄；如果只是闲聊，可用「日常闲聊」这类通用词
- 只输出 JSON，格式严格：{"title": "..."}`

async function resolveCall(config: AgentConfig): Promise<TitleCall> {
  const synced = await solevupGetActiveModelApiKey().catch(() => null)
  return {
    apiKey: synced?.apiKey || getDashScopeApiKey(config) || '',
    apiBase: config.openaiApiBase,
    model: await getFeatureModel('session_title', 'qwen3.6-flash'),
  }
}

/**
 * 生成会话标题。失败时返回 null（调用方保留现有标题）。
 */
export async function generateSessionTitle(
  messages: readonly TitleMessage[],
  config: AgentConfig,
): Promise<string | null> {
  const text = flattenForTitle(messages)
  if (!text.trim()) return null

  try {
    const reply = await chatOnce(await resolveCall(config), text, 'session_title')

    // 容错解析：优先 JSON，其次正则抓 title 字段，最后兜底取首行
    const raw = reply.trim()

    // 1) 直接 JSON.parse
    try {
      const parsed = JSON.parse(raw) as { title?: unknown }
      if (typeof parsed.title === 'string' && parsed.title.trim()) {
        return sanitize(parsed.title)
      }
    } catch {
      // fall through
    }

    // 2) 从文本中抽出 {"title": "..."}
    const match = raw.match(/"title"\s*:\s*"([^"]+)"/)
    if (match) return sanitize(match[1])

    // 3) 兜底：取第一行非空文本
    const firstLine = raw.split('\n').map((s) => s.trim()).find((s) => s.length > 0)
    return firstLine ? sanitize(firstLine) : null
  } catch (e) {
    // 不能静默吞掉：免费额度耗尽（403）曾让标题生成断了三周毫无声息
    console.error('[SessionTitle] 标题生成失败', e)
    return null
  }
}

function sanitize(title: string): string {
  return title
    .replace(/^["'《「]+|["'》」]+$/g, '')
    .replace(/[。！？!?.\s]+$/, '')
    .slice(0, 24)
    .trim()
}
