// ══════════════════════════════════════════════
// Session Title — 用 LLM 给会话生成简短标题
// 参考 Claude Code sessionTitle.ts 的设计：
//   · tail-slice 最近 1000 字对话
//   · 强 prompt + JSON 回复
//   · 3-7 字句型标题
// ══════════════════════════════════════════════

import type { AgentConfig } from '../agent/agent-config'
import type { SessionMessage } from '../agent/agent-memory'
import { chat } from './ai-client'

const MAX_INPUT_CHARS = 1000

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
    const reply = await chat(
      config,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
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
  } catch {
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
