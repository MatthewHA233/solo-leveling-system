// ══════════════════════════════════════════════
// normalizeMessagesForAPI
// 精简移植自 Claude Code utils/messages.ts
//
// 原版7阶段：attachments → error-strip → merge → tool-relocation →
//           thinking-filters → smoosh → sanitize
//
// 我们的精简版（无 tools/thinking/MCP/attachments）：
//   1. 过滤不发给 API 的消息（system、isVirtual）
//   2. 合并连续同角色消息（user+user / assistant+assistant）
//   3. joinTextAtSeam（text 连接处加 \n，加在 a 尾，不加在 b 头）
//   4. sanitize（空内容过滤）
// ══════════════════════════════════════════════

import type {
  UserMessage,
  AssistantMessage,
  Message,
  ContentBlock,
  TextBlock,
} from './types'

// ── Step 1：过滤 ──

function shouldInclude(m: Message): m is UserMessage | AssistantMessage {
  if (m.type === 'system') return false      // UI 专用，不发 API
  if (m.isVirtual) return false              // 虚拟消息，不发 API
  return true
}

// ── Step 2 & 3：合并连续同角色消息 ──

/**
 * 合并两条连续 UserMessage 的内容。
 *
 * joinTextAtSeam 反直觉点：
 * \n 加在 a 的尾部文本块，而不是 b 的头部。
 * 原版注释（Claude Code L2500-2503）：
 * "Blocks stay separate; the \n goes on a's side so no block's startsWith
 *  changes — smooshSystemReminderSiblings classifies via startsWith('<system-reminder>'),
 *  and prepending to b would break that when b is an SR-wrapped attachment."
 *
 * 我们的 app 没有 system-reminder，但保留这个约定，语义更干净。
 */
function joinTextAtSeam(a: ContentBlock[], b: ContentBlock[]): ContentBlock[] {
  const lastA = a.at(-1)
  const firstB = b[0]
  if (lastA?.type === 'text' && firstB?.type === 'text') {
    // 在 a 的最后一个 text block 尾部加 \n，保持 b 的 startsWith 不变
    return [
      ...a.slice(0, -1),
      { ...lastA, text: lastA.text + '\n' } as TextBlock,
      ...b,
    ]
  }
  return [...a, ...b]
}

function normalizeContent(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return content
}

function mergeUserMessages(a: UserMessage, b: UserMessage): UserMessage {
  const aContent = normalizeContent(a.message.content)
  const bContent = normalizeContent(b.message.content)
  return {
    ...a,
    // 保留非 meta 消息的 uuid（meta 消息每次调用都是新 uuid，非 meta 才是稳定锚点）
    uuid: a.isMeta ? b.uuid : a.uuid,
    message: {
      ...a.message,
      content: joinTextAtSeam(aContent, bContent),
    },
  }
}

function mergeAssistantMessages(
  a: AssistantMessage,
  b: AssistantMessage,
): AssistantMessage {
  return {
    ...a,
    message: {
      ...a.message,
      content: [...a.message.content, ...b.message.content],
    },
  }
}

// ── Step 4：sanitize ──

const EMPTY_PLACEHOLDER = '(empty)'

function sanitizeUserMessage(m: UserMessage): UserMessage | null {
  const content = m.message.content
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (!trimmed) return null
    return trimmed === content ? m : {
      ...m,
      message: { ...m.message, content: trimmed },
    }
  }
  // ContentBlock[] — 过滤空 text blocks
  const filtered = content.filter(
    (b) => !(b.type === 'text' && !b.text.trim()),
  )
  if (filtered.length === 0) return null
  return filtered.length === content.length
    ? m
    : { ...m, message: { ...m.message, content: filtered } }
}

function sanitizeAssistantMessage(m: AssistantMessage): AssistantMessage | null {
  const filtered = m.message.content.filter(
    (b) => !(b.type === 'text' && !(b as TextBlock).text.trim()),
  )
  if (filtered.length === 0) {
    // 保留一个空占位，避免发送完全空的 assistant 消息
    return {
      ...m,
      message: {
        ...m.message,
        content: [{ type: 'text', text: EMPTY_PLACEHOLDER }],
      },
    }
  }
  return filtered.length === m.message.content.length
    ? m
    : { ...m, message: { ...m.message, content: filtered } }
}

// ── 主函数 ──

/**
 * 将内部 Message[] 规范化为可发给 API 的消息列表。
 *
 * 保证：
 * - 无 SystemMessage（UI 专用）
 * - 无 isVirtual 消息
 * - 无连续 user+user（合并）
 * - 无连续 assistant+assistant（合并）
 * - 无空内容消息
 */
export function normalizeMessagesForAPI(
  messages: Message[],
): (UserMessage | AssistantMessage)[] {
  // Step 1：过滤
  const filtered = messages.filter(shouldInclude)

  // Step 2+3：合并连续同角色（工具结果消息不合并，每个 call 需独立 tool_call_id）
  const merged: (UserMessage | AssistantMessage)[] = []
  for (const m of filtered) {
    const prev = merged.at(-1)
    if (
      m.type === 'user' && prev?.type === 'user' &&
      !m.toolUseResult && !prev.toolUseResult
    ) {
      merged[merged.length - 1] = mergeUserMessages(prev, m)
    } else if (m.type === 'assistant' && prev?.type === 'assistant') {
      merged[merged.length - 1] = mergeAssistantMessages(prev, m)
    } else {
      merged.push(m)
    }
  }

  // Step 4：sanitize
  const sanitized: (UserMessage | AssistantMessage)[] = []
  for (const m of merged) {
    if (m.type === 'user') {
      const clean = sanitizeUserMessage(m)
      if (clean) sanitized.push(clean)
    } else {
      const clean = sanitizeAssistantMessage(m)
      if (clean) sanitized.push(clean)
    }
  }

  return sanitized
}
