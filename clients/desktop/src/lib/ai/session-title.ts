// ══════════════════════════════════════════════
// Session Title — 用 LLM 给会话生成简短标题
// 参考 Claude Code sessionTitle.ts 的设计：
//   · tail-slice 最近 1000 字对话
//   · 强 prompt + JSON 回复
//   · 3-7 字句型标题
// ══════════════════════════════════════════════

import type { AgentConfig } from '../agent/agent-config'
import { getDashScopeApiKey } from '../agent/agent-config'
import type { LLMMessage, SessionMessage } from '../agent/agent-memory'
import { getFeatureModel, logModelUsage, type DashScopeUsage } from '../model-audit'

const MAX_INPUT_CHARS = 1000

// 一次性非流式调用——只有标题生成这种短同步场景需要
async function chatOnce(
  config: AgentConfig,
  messages: readonly LLMMessage[],
  model: string,
  feature: string,
): Promise<string> {
  const apiKey = config.aiProvider === 'gemini'
    ? config.geminiApiKey
    : getDashScopeApiKey(config)
  if (!apiKey) throw new Error('API Key 未配置')

  const baseUrl = config.aiProvider === 'gemini'
    ? config.geminiApiBase
    : config.openaiApiBase
  const url = `${baseUrl}/v1/chat/completions`

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`AI API 错误 ${response.status}: ${text.slice(0, 200)}`)
  }

  const result = await response.json() as {
    choices: { message: { content: string } }[]
    usage?: DashScopeUsage
  }

  if (config.aiProvider !== 'gemini' && result.usage) {
    void logModelUsage({
      feature,
      modelId: model,
      startedAt,
      durationMs: Date.now() - startedMs,
      usage: result.usage,
      success: true,
      metadata: { source: 'session-title' },
    })
  }

  return result.choices[0]?.message?.content ?? ''
}

function flattenForTitle(messages: readonly SessionMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'tool') continue       // 工具结果对标题无帮助
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

/**
 * 生成会话标题。失败时返回 null（调用方保留现有标题）。
 */
export async function generateSessionTitle(
  messages: readonly SessionMessage[],
  config: AgentConfig,
): Promise<string | null> {
  const text = flattenForTitle(messages)
  if (!text.trim()) return null

  try {
    const titleModel = await getFeatureModel('session_title', 'qwen3.6-flash')
    const reply = await chatOnce(
      config,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      titleModel,
      'session_title',
    )

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
