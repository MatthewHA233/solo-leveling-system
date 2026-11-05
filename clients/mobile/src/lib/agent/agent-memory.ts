// ══════════════════════════════════════════════
// Agent Memory — 移植自 macOS AgentMemory.swift
// 会话消息管理 + LLM 消息构建
//
// 与 desktop src/lib/agent/agent-memory.ts 同名同语义。desktop 的 Session API 走本机 HTTP，
// 手机端直接读写本地 SQLite（src/lib/solevupdb.ts 的聊天桥接），同步由增量通道负责。
// ══════════════════════════════════════════════

import {
  solevupAppendChatMessages,
  solevupCleanupEmptyChatSessions,
  solevupCreateChatSession,
  solevupDeleteChatSession,
  solevupGetChatMessages,
  solevupGetPref,
  solevupListChatSessions,
  solevupPatchChatSession,
  solevupSearchChatSessions,
  solevupSetPref,
  type ChatAppendResult,
  type ChatMessageDbRow,
  type ChatSessionRow,
  type ModelCallLog,
} from '../solevupdb'
import { randomUUID } from '../llm/uuid'

const STORAGE_KEY = 'solevup-memory'
const MAX_MESSAGES = 40

// ── Types ──

export interface ToolCallRecord {
  readonly id: string
  readonly name: string
  readonly arguments: string   // JSON string
}

export interface SessionMessage {
  /**
   * 手机端多的字段：桥接要求消息自带 id，同一条重复写入时按它合并（desktop 由后端生成）。
   * 要回写的消息必须带上，见 persistMessages。
   */
  readonly id?: string
  readonly role: 'user' | 'assistant' | 'tool'
  readonly content: string | null
  readonly toolCalls: readonly ToolCallRecord[] | null
  readonly toolCallId: string | null
  readonly name: string | null
  readonly timestamp: string    // ISO string
  readonly audioPath?: string | null   // 相对路径 "{sessionId}/{filename}.wav"
  readonly durationMs?: number | null  // 录音时长（毫秒）
  readonly usage?: ModelCallLog | null // assistant 消息对应的模型调用审计快照
  readonly reasoning?: string | null   // 思考模型的推演过程（assistant 专用，回看用）
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
    id: randomUUID(),
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

/**
 * 时间戳转毫秒。desktop 同步来的 chat_* 时间是 chrono to_rfc3339（可能带微秒），
 * Hermes 的 Date 解析对超过 3 位小数没有保证；解析失败得到 NaN 时，判断「4 小时内」会恒为假，
 * 每次启动都新建会话。所以解析不了时按固定格式自己算。
 */
export function timestampMs(value: string): number {
  const direct = new Date(value).getTime()
  if (Number.isFinite(direct)) return direct
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value)
  if (!m) return NaN
  const [, y, mo, d, h, mi, s, tz] = m
  if (!tz) {
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime()
  }
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (tz === 'Z') return utc
  const sign = tz[0] === '-' ? -1 : 1
  const digits = tz.slice(1).replace(':', '')
  const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))
  return utc - sign * offsetMin * 60_000
}

export function shouldStartNewSession(state: AgentMemoryState): boolean {
  if (state.messages.length === 0) return false
  const last = state.messages[state.messages.length - 1]
  const elapsed = Date.now() - timestampMs(last.timestamp)
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

// ── Persist (SharedPreferences fallback；desktop 是 localStorage) ──

export async function saveMemory(state: AgentMemoryState): Promise<void> {
  await solevupSetPref(STORAGE_KEY, JSON.stringify(state))
}

export async function loadMemory(): Promise<AgentMemoryState> {
  try {
    const raw = await solevupGetPref(STORAGE_KEY, '')
    if (raw) {
      return JSON.parse(raw) as AgentMemoryState
    }
  } catch {
    // fall through
  }
  return createAgentMemory()
}

// ── Session API (SQLite via SolevupDb) ──

export interface ChatSessionInfo {
  readonly id: string
  readonly title: string
  readonly summary: string | null
  readonly created_at: string
  readonly updated_at: string
}

function toSessionInfo(row: ChatSessionRow): ChatSessionInfo {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function parseJsonOrNull<T>(json: string | null | undefined): T | null {
  if (!json) return null
  try { return JSON.parse(json) as T } catch { return null }
}

function fromDbMessage(m: ChatMessageDbRow): SessionMessage {
  return {
    id: m.id,
    // 旧版手机端可能写过 agent；库里统一是 assistant，读出来也归一
    role: (m.role === 'agent' ? 'assistant' : m.role) as SessionMessage['role'],
    content: m.content,
    toolCalls: parseJsonOrNull<ToolCallRecord[]>(m.toolCalls),
    toolCallId: m.toolCallId ?? null,
    name: m.name ?? null,
    timestamp: m.timestamp,
    audioPath: m.audioPath ?? null,
    durationMs: m.durationMs ?? null,
    usage: parseJsonOrNull<ModelCallLog>(m.usageJson),
    reasoning: m.reasoning ?? null,
  }
}

export async function createChatSession(): Promise<ChatSessionInfo> {
  const row = await solevupCreateChatSession()
  if (!row) throw new Error('创建会话失败')
  return toSessionInfo(row)
}

export async function getRecentChatSessions(limit = 1): Promise<ChatSessionInfo[]> {
  const rows = await solevupListChatSessions(limit)
  return rows.map(toSessionInfo)
}

export interface MessageSnippet {
  readonly role: string
  readonly excerpt: string    // 关键词上下文片段（前后约 60 字符）
  readonly timestamp: string  // 用于切会话后定位气泡
}

export interface SessionSearchHit {
  readonly session: ChatSessionInfo
  readonly snippets: readonly MessageSnippet[]
}

/**
 * 全文搜索会话（title / summary / 任意一条 messages.content LIKE）
 * 每个匹配会话附带最多 3 条 message 命中片段
 */
export async function searchChatSessions(query: string, limit = 50): Promise<SessionSearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const hits = await solevupSearchChatSessions(q, limit)
  return hits.map((h) => ({ session: toSessionInfo(h.session), snippets: h.snippets }))
}

export async function fetchSessionMessages(sessionId: string): Promise<SessionMessage[]> {
  const rows = await solevupGetChatMessages(sessionId)
  return rows.map(fromDbMessage)
}

/**
 * 写入消息。调用方要带稳定的 id（appendUser 这几个函数已经带了）：
 * 桥接按 id 合并，没带 id 的这里现生成一个，同一条消息回写第二次就成了两条。
 * 返回消息实际落到的会话：会话在另一台设备被删时，新消息会改道到新会话，
 * 返回的 sessionId 和传入的不同，调用方要切过去。
 */
export async function persistMessages(
  sessionId: string,
  messages: readonly SessionMessage[],
): Promise<ChatAppendResult> {
  const rows: ChatMessageDbRow[] = messages.map((m) => ({
    id: m.id ?? randomUUID(),
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
    toolCallId: m.toolCallId,
    name: m.name,
    timestamp: m.timestamp,
    audioPath: m.audioPath ?? null,
    durationMs: m.durationMs ?? null,
    usageJson: m.usage ? JSON.stringify(m.usage) : null,
    reasoning: m.reasoning ?? null,
  }))
  return solevupAppendChatMessages(sessionId, rows)
}

export async function patchSession(
  sessionId: string,
  updates: { title?: string; summary?: string },
): Promise<void> {
  await solevupPatchChatSession(sessionId, updates.title ?? null, updates.summary ?? null)
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  await solevupDeleteChatSession(sessionId)
}

/** 清理所有没有任何消息的空白会话（exceptId 排除当前会话）。返回被删 id 列表 */
export async function cleanupEmptyChatSessions(exceptId: string | null): Promise<string[]> {
  return solevupCleanupEmptyChatSessions(exceptId)
}

/** 应用启动时调用：恢复最近会话（4h内）或创建新会话 */
export async function initChatSession(): Promise<{
  sessionId: string
  state: AgentMemoryState
}> {
  const sessions = await getRecentChatSessions(1)

  if (sessions.length > 0) {
    const recent = sessions[0]
    const elapsed = Date.now() - timestampMs(recent.updated_at)
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
