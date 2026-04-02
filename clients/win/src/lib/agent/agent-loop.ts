// ══════════════════════════════════════════════
// Agent Loop — 移植自 macOS AgentLoop.swift
// ReAct: 推理 → 工具调用 → 观察 → 再推理
// ══════════════════════════════════════════════

import type { ToolCallRecord, AgentMemoryState } from './agent-memory'
import {
  appendUser, appendAssistant, appendToolResult,
  trimIfNeeded, buildLLMMessages, persistMessages, patchSession,
} from './agent-memory'
import type { ToolContext } from './agent-tools'
import { ALL_TOOLS, toToolDefinition, executeTool } from './agent-tools'
import type { StreamChunk } from '../ai/ai-client'
import { streamChat } from '../ai/ai-client'
import type { AgentConfig } from './agent-config'

// ── Events ──

export type AgentLoopEvent =
  | { type: 'textDelta'; delta: string }
  | { type: 'toolCallStarted'; name: string; args: string }
  | { type: 'toolCallResult'; name: string; result: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

// ── Run ──

export async function runAgentLoop(
  userMessage: string,
  systemPrompt: string,
  memory: AgentMemoryState,
  config: AgentConfig,
  toolContext: ToolContext,
  onEvent: (event: AgentLoopEvent) => void,
  maxIterations = 8,
  sessionId: string | null = null,
): Promise<AgentMemoryState> {
  const initialCount = memory.messages.length
  let state = appendUser(memory, userMessage)
  state = trimIfNeeded(state)

  const toolDefs = ALL_TOOLS.map(toToolDefinition)

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const messages = buildLLMMessages(state, systemPrompt)

    let stream: AsyncIterable<StreamChunk>
    try {
      stream = streamChat(config, messages, toolDefs)
    } catch {
      onEvent({ type: 'error', message: 'AI 未配置或不可用' })
      onEvent({ type: 'done' })
      return state
    }

    // Accumulate text and tool calls
    let accText = ''
    const pendingCalls = new Map<number, { id: string; name: string; args: string }>()
    let finishReason = ''

    try {
      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'textDelta':
            accText += chunk.delta
            onEvent({ type: 'textDelta', delta: chunk.delta })
            break

          case 'toolCallDelta': {
            const existing = pendingCalls.get(chunk.index)
            if (!existing) {
              pendingCalls.set(chunk.index, {
                id: chunk.id ?? '',
                name: chunk.name ?? '',
                args: '',
              })
            }
            const entry = pendingCalls.get(chunk.index)!
            if (chunk.id) entry.id = chunk.id
            if (chunk.name) entry.name = chunk.name
            if (chunk.argsDelta) entry.args += chunk.argsDelta
            break
          }

          case 'finishReason':
            finishReason = chunk.reason
            break
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onEvent({ type: 'error', message: `AI 响应错误: ${msg}` })
      onEvent({ type: 'done' })
      return state
    }

    // Build tool call records
    const sortedEntries = [...pendingCalls.entries()].sort((a, b) => a[0] - b[0])
    const toolCalls: ToolCallRecord[] = sortedEntries.map(([, v]) => ({
      id: v.id || `call_${crypto.randomUUID().slice(0, 8)}`,
      name: v.name,
      arguments: v.args,
    }))

    // Save assistant message
    state = appendAssistant(
      state,
      accText || null,
      toolCalls.length > 0 ? toolCalls : null,
    )

    // No tool calls → AI is done
    if (toolCalls.length === 0 || finishReason === 'stop') {
      break
    }

    // Execute all tool calls
    for (const tc of toolCalls) {
      onEvent({ type: 'toolCallStarted', name: tc.name, args: tc.arguments })

      const result = await executeTool(tc.name, tc.arguments, toolContext)

      onEvent({ type: 'toolCallResult', name: tc.name, result })
      state = appendToolResult(state, tc.id, tc.name, result)
    }
  }

  if (sessionId) {
    const newMessages = state.messages.slice(initialCount)
    if (newMessages.length > 0) {
      persistMessages(sessionId, newMessages).catch((err) =>
        console.error('[AgentLoop] 消息持久化失败:', err),
      )
      // 用第一条用户消息作为标题（截断至 30 字）
      const firstUser = newMessages.find((m) => m.role === 'user')
      if (firstUser?.content && initialCount === 0) {
        patchSession(sessionId, { title: firstUser.content.slice(0, 30) }).catch(() => {})
      }
    }
  }

  onEvent({ type: 'done' })
  return state
}
