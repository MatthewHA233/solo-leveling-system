// ══════════════════════════════════════════════
// LLM Message Types
// 精简移植自 Claude Code types/message.ts
// 去掉：tools、thinking blocks、MCP、permission、compact
// 保留：核心结构 + 关键判别字段
// ══════════════════════════════════════════════

// ── Content Blocks ──

export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

export interface ToolResultBlock {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

// ── ToolDefinition (OpenAI function calling wire format) ──

export interface ToolDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

// ── Usage ──

export interface TokenUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
}

// ── UserMessage ──
//
// 注意：type='user' 不等于"人类说的话"，需要三重判别：
//   isHumanTurn = type==='user' && !isMeta && toolUseResult===undefined
//
// - isMeta=true       → 系统注入（context 更新、reminder），不作为人类输入
// - toolUseResult     → 工具结果消息（OpenAI 格式里叫 role:'tool'，这里统一 type:'user'）
// - isVirtual=true    → 仅 UI 展示，不进入 API
// - origin=undefined  → 键盘输入；'voice' → 语音转写

export type MessageOrigin = 'voice' | 'programmatic'

export interface UserMessage {
  readonly type: 'user'
  readonly uuid: string
  readonly timestamp: string
  readonly message: {
    readonly role: 'user'
    readonly content: string | ContentBlock[]
  }
  readonly isMeta?: true
  readonly isVirtual?: true
  readonly isCompactSummary?: true
  readonly toolUseResult?: string          // 工具执行结果（tool_result 内容）
  readonly sourceToolCallId?: string       // 对应的 tool call ID（用于 OpenAI tool_call_id）
  readonly origin?: MessageOrigin
}

// ── AssistantMessage ──
//
// 外层是我们自己的元数据（uuid/timestamp/错误信息）
// 内层 message 是 API response 的原始结构（保持接近 Anthropic SDK）

export type StopReason = 'end_turn' | 'stop_sequence' | 'max_tokens' | 'tool_use'

export interface AssistantMessage {
  readonly type: 'assistant'
  readonly uuid: string
  readonly timestamp: string
  readonly message: {
    readonly role: 'assistant'
    readonly content: ContentBlock[]
    readonly stop_reason: StopReason | null
    readonly usage: TokenUsage
    readonly model: string
  }
  readonly requestId?: string
  readonly isApiErrorMessage?: boolean
  readonly apiError?: {
    readonly status: number
    readonly message: string
  }
  readonly isVirtual?: true
}

// ── SystemMessage（UI 专用，不进入 API） ──

export type SystemMessageLevel = 'info' | 'error' | 'warning'

export interface SystemMessage {
  readonly type: 'system'
  readonly uuid: string
  readonly timestamp: string
  readonly content: string
  readonly level: SystemMessageLevel
}

// ── Message union ──

export type Message = UserMessage | AssistantMessage | SystemMessage

// ── Predicates ──

/**
 * 真实的人类输入。
 * 注意：不能只判断 type==='user'！
 * 历史上4个PR都因为只判断 type 而引入了 bug（工具结果/meta 注入被误当人类消息）。
 */
export function isHumanTurn(m: Message): m is UserMessage {
  return m.type === 'user' && !m.isMeta && m.toolUseResult === undefined
}

export function isToolResult(m: Message): m is UserMessage {
  return m.type === 'user' && m.toolUseResult !== undefined
}

export function isAssistantMessage(m: Message): m is AssistantMessage {
  return m.type === 'assistant'
}

// ── Helpers ──

export function createUserMessage(
  content: string,
  opts: {
    uuid?: string
    origin?: MessageOrigin
    isMeta?: true
    isVirtual?: true
  } = {},
): UserMessage {
  return {
    type: 'user',
    uuid: opts.uuid ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: content || '(empty)' },
    isMeta: opts.isMeta,
    isVirtual: opts.isVirtual,
    origin: opts.origin,
  }
}

export function createAssistantMessage(
  content: string,
  opts: {
    uuid?: string
    model?: string
    usage?: TokenUsage
    stop_reason?: StopReason
    requestId?: string
  } = {},
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: opts.uuid ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      stop_reason: opts.stop_reason ?? 'end_turn',
      usage: opts.usage ?? { input_tokens: 0, output_tokens: 0 },
      model: opts.model ?? '',
    },
    requestId: opts.requestId,
  }
}

export function createSystemMessage(
  content: string,
  level: SystemMessageLevel = 'info',
): SystemMessage {
  return {
    type: 'system',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    content,
    level,
  }
}

/**
 * 从 Message 中提取文本（用于 UI 显示）
 */
export function getMessageText(m: AssistantMessage): string {
  return m.message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
