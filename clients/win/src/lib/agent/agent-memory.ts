// ══════════════════════════════════════════════
// Agent Memory — 移植自 macOS AgentMemory.swift
// 会话消息管理 + LLM 消息构建
// ══════════════════════════════════════════════

const STORAGE_KEY = 'solo-agent-memory'
const MAX_MESSAGES = 40

// ── Types ──

export interface ToolCallRecord {
  readonly id: string
  readonly name: string
  readonly arguments: string   // JSON string
}

export interface SessionMessage {
  readonly role: 'user' | 'assistant' | 'tool'
  readonly content: string | null
  readonly toolCalls: readonly ToolCallRecord[] | null
  readonly toolCallId: string | null
  readonly name: string | null
  readonly timestamp: string    // ISO string
}

export interface LLMMessage {
  readonly role: string
  readonly content?: string | null
  readonly tool_calls?: readonly {
    readonly id: string
    readonly type: 'function'
    readonly function: { readonly name: string; readonly arguments: string }
  }[]
  readonly tool_call_id?: string
  readonly name?: string
}

// ── Agent Memory ──

export interface AgentMemoryState {
  readonly messages: readonly SessionMessage[]
  readonly sessionSummary: string | null
}

export function createAgentMemory(): AgentMemoryState {
  return { messages: [], sessionSummary: null }
}

// ── Build LLM Messages ──

export function buildLLMMessages(
  state: AgentMemoryState,
  systemPrompt: string,
): LLMMessage[] {
  const result: LLMMessage[] = [{ role: 'system', content: systemPrompt }]

  if (state.sessionSummary) {
    result.push({
      role: 'system',
      content: `本轮会话开始前的历史摘要：${state.sessionSummary}`,
    })
  }

  for (const msg of state.messages) {
    switch (msg.role) {
      case 'user':
        if (msg.content) {
          result.push({ role: 'user', content: msg.content })
        }
        break

      case 'assistant': {
        const entry: LLMMessage = {
          role: 'assistant',
          content: msg.content ?? null,
          ...(msg.toolCalls && msg.toolCalls.length > 0
            ? {
                tool_calls: msg.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
            : {}),
        }
        result.push(entry)
        break
      }

      case 'tool':
        result.push({
          role: 'tool',
          content: msg.content ?? '',
          tool_call_id: msg.toolCallId ?? undefined,
          name: msg.name ?? undefined,
        })
        break
    }
  }

  return result
}

// ── Append Operations ──

function createMessage(
  role: SessionMessage['role'],
  opts: {
    content?: string | null
    toolCalls?: readonly ToolCallRecord[]
    toolCallId?: string
    name?: string
  } = {},
): SessionMessage {
  return {
    role,
    content: opts.content ?? null,
    toolCalls: opts.toolCalls ?? null,
    toolCallId: opts.toolCallId ?? null,
    name: opts.name ?? null,
    timestamp: new Date().toISOString(),
  }
}

export function appendUser(state: AgentMemoryState, content: string): AgentMemoryState {
  return {
    ...state,
    messages: [...state.messages, createMessage('user', { content })],
  }
}

export function appendAssistant(
  state: AgentMemoryState,
  text: string | null,
  toolCalls: readonly ToolCallRecord[] | null,
): AgentMemoryState {
  return {
    ...state,
    messages: [
      ...state.messages,
      createMessage('assistant', { content: text, toolCalls: toolCalls ?? undefined }),
    ],
  }
}

export function appendToolResult(
  state: AgentMemoryState,
  toolCallId: string,
  name: string,
  result: string,
): AgentMemoryState {
  return {
    ...state,
    messages: [
      ...state.messages,
      createMessage('tool', { content: result, toolCallId, name }),
    ],
  }
}

// ── Session Management ──

export function shouldStartNewSession(state: AgentMemoryState): boolean {
  if (state.messages.length === 0) return false
  const last = state.messages[state.messages.length - 1]
  const elapsed = Date.now() - new Date(last.timestamp).getTime()
  return elapsed > 4 * 3600 * 1000
}

export function resetForNewSession(state: AgentMemoryState): AgentMemoryState {
  if (state.messages.length === 0) return state
  const count = state.messages.length
  const firstTs = state.messages[0].timestamp
  const dateStr = new Date(firstTs).toLocaleString()
  return {
    messages: [],
    sessionSummary: `上次会话（${dateStr}）共 ${count} 条消息。`,
  }
}

// ── Trim ──

export function trimIfNeeded(state: AgentMemoryState): AgentMemoryState {
  if (state.messages.length <= MAX_MESSAGES) return state
  const dropCount = Math.floor(MAX_MESSAGES / 2)
  const firstTs = state.messages[0].timestamp
  const dateStr = new Date(firstTs).toLocaleString()
  const existing = state.sessionSummary ? `${state.sessionSummary} ` : ''
  return {
    messages: state.messages.slice(dropCount),
    sessionSummary: `${existing}（${dateStr} 起的 ${dropCount} 条早期消息已压缩）`,
  }
}

// ── Persist ──

export function saveMemory(state: AgentMemoryState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function loadMemory(): AgentMemoryState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      return JSON.parse(raw) as AgentMemoryState
    }
  } catch {
    // fall through
  }
  return createAgentMemory()
}
