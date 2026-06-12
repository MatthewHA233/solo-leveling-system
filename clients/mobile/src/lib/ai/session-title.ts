// ══════════════════════════════════════════════
// 会话标题 AI 生成（mobile 版）— 对齐 desktop src/lib/ai/session-title.ts
// 模型走 feature binding 'session_title'（默认 qwen3.6-flash，低价）
// ══════════════════════════════════════════════

import { queryModel } from '../llm/api'
import { createUserMessage } from '../llm/types'
import type { ChatMessage } from '../../types'

const SYSTEM_PROMPT = `你是会话标题生成器。根据用户与助手的对话，产出一个 3-8 字的中文短标题。
要求：
- 3-8 个字，名词短语，不要句号
- 抓住主题而非寒暄；如果只是闲聊，可用「日常闲聊」
- 只输出 JSON，格式严格：{"title": "..."}`

// 平铺最近对话，截取 1000 字（对齐 desktop flattenForTitle）
function flattenForTitle(messages: readonly ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const text = m.content || m.audio?.transcript || ''
    if (!text.trim()) continue
    lines.push(`${m.role === 'user' ? '用户' : '助手'}: ${text}`)
  }
  const joined = lines.join('\n\n')
  return joined.length > 1000 ? joined.slice(-1000) : joined
}

function sanitize(title: unknown): string | null {
  if (typeof title !== 'string') return null
  const t = title.trim().replace(/[。．.]/g, '')
  if (t.length < 2 || t.length > 12) return null
  return t
}

/** 手动/自动重生成指定会话的标题（对齐 desktop SessionPicker「重新生成标题」） */
export async function regenerateTitleForSession(
  sessionId: string,
  opts: { fallbackApiKey: string | null; apiBase: string },
): Promise<string | null> {
  const { solevupGetActiveModelApiKey, solevupGetChatMessages, solevupGetFeatureBinding, solevupPatchChatSession } =
    await import('../solevupdb')
  const rows = await solevupGetChatMessages(sessionId).catch(() => [])
  if (!rows.length) return null
  const msgs = rows.map((r) => ({
    id: r.id,
    role: (r.role === 'user' || r.role === 'agent' ? r.role : 'system') as ChatMessage['role'],
    content: r.content ?? '',
    timestamp: Date.parse(r.timestamp) || 0,
  })) as ChatMessage[]

  const syncedKey = await solevupGetActiveModelApiKey().catch(() => null)
  const apiKey = syncedKey?.apiKey || opts.fallbackApiKey
  if (!apiKey) return null
  const model = (await solevupGetFeatureBinding('session_title').catch(() => null)) || 'qwen3.6-flash'
  const title = await generateSessionTitle(msgs, { apiKey, apiBase: opts.apiBase, model })
  if (title) await solevupPatchChatSession(sessionId, title, null).catch(() => {})
  return title
}

export async function generateSessionTitle(
  messages: readonly ChatMessage[],
  opts: { apiKey: string; apiBase: string; model: string },
): Promise<string | null> {
  const text = flattenForTitle(messages)
  if (!text.trim()) return null

  try {
    // 非流式语义：消费完整流拼出回复
    let reply = ''
    const stream = queryModel([createUserMessage(text)], {
      apiKey: opts.apiKey,
      apiBase: opts.apiBase,
      model: opts.model,
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: 100,
      feature: 'session_title',
    })
    for await (const chunk of stream) {
      if (chunk.type === 'textDelta') reply += chunk.delta
      else if (chunk.type === 'error') return null
    }

    // 容错解析：JSON → 正则 → 首行（对齐 desktop）
    const trimmed = reply.trim()
    try {
      const parsed = JSON.parse(trimmed) as { title?: string }
      const t = sanitize(parsed.title)
      if (t) return t
    } catch {}
    const m = trimmed.match(/"title"\s*:\s*"([^"]+)"/)
    if (m) {
      const t = sanitize(m[1])
      if (t) return t
    }
    return sanitize(trimmed.split('\n')[0])
  } catch {
    return null
  }
}
