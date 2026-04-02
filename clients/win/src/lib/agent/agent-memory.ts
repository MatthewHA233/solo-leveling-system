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

// ── Persist (localStorage fallback) ──

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

// ── Session API (SQLite via Axum) ──

const API_BASE = 'http://localhost:3000'

export interface ChatSessionInfo {
  readonly id: string
  readonly title: string
  readonly summary: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface ApiChatMessage {
  id: string
  session_id: string
  role: string
  content: string | null
  tool_calls: string | null
  tool_call_id: string | null
  name: string | null
  timestamp: string
}

function fromApiMessage(m: ApiChatMessage): SessionMessage {
  return {
    role: m.role as SessionMessage['role'],
    content: m.content,
    toolCalls: m.tool_calls ? (JSON.parse(m.tool_calls) as ToolCallRecord[]) : null,
    toolCallId: m.tool_call_id,
    name: m.name,
    timestamp: m.timestamp,
  }
}

export async function createChatSession(): Promise<ChatSessionInfo> {
  const res = await fetch(`${API_BASE}/api/sessions`, { method: 'POST' })
  const json = await res.json() as { success: boolean; data: ChatSessionInfo; error?: string }
  if (!json.success) throw new Error(json.error ?? '创建会话失败')
  return json.data
}

export async function getRecentChatSessions(limit = 1): Promise<ChatSessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions?limit=${limit}`)
  const json = await res.json() as { success: boolean; data: ChatSessionInfo[] }
  return json.success ? json.data : []
}

export async function fetchSessionMessages(sessionId: string): Promise<SessionMessage[]> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`)
  const json = await res.json() as { success: boolean; data: ApiChatMessage[] }
  return json.success ? json.data.map(fromApiMessage) : []
}

export async function persistMessages(
  sessionId: string,
  messages: readonly SessionMessage[],
): Promise<void> {
  const body = {
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
      tool_call_id: m.toolCallId,
      name: m.name,
      timestamp: m.timestamp,
    })),
  }
  await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchSession(
  sessionId: string,
  updates: { title?: string; summary?: string },
): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
}

/** 应用启动时调用：恢复最近会话（4h内）或创建新会话 */
export async function initChatSession(): Promise<{
  sessionId: string
  state: AgentMemoryState
}> {
  const sessions = await getRecentChatSessions(1)

  if (sessions.length > 0) {
    const recent = sessions[0]
    const elapsed = Date.now() - new Date(recent.updated_at).getTime()
    if (elapsed < 4 * 3600 * 1000) {
      const msgs = await fetchSessionMessages(recent.id)
      return {
        sessionId: recent.id,
        state: {
          messages: msgs.slice(-MAX_MESSAGES),
          sessionSummary: recent.summary,
        },
      }
    }
  }

  const session = await createChatSession()
  return { sessionId: session.id, state: createAgentMemory() }
}
