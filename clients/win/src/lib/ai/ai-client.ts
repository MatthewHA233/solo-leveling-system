// ══════════════════════════════════════════════
// AI Client — 移植自 macOS AIClient.swift
// OpenAI-compatible streaming (千问/Gemini)
// ══════════════════════════════════════════════

import type { AgentConfig } from '../agent/agent-config'
import type { LLMMessage } from '../agent/agent-memory'
import type { ToolDefinition } from '../llm/types'

// ── Stream Chunk Types ──

export type StreamChunk =
  | { type: 'textDelta'; delta: string }
  | { type: 'toolCallDelta'; index: number; id: string | null; name: string | null; argsDelta: string | null }
  | { type: 'finishReason'; reason: string }

// ── Streaming Chat ──

export async function* streamChat(
  config: AgentConfig,
  messages: readonly LLMMessage[],
  tools?: readonly ToolDefinition[],
): AsyncGenerator<StreamChunk> {
  const apiKey = config.aiProvider === 'gemini'
    ? config.geminiApiKey
    : config.openaiApiKey

  if (!apiKey) {
    throw new Error('API Key 未配置')
  }

  const baseUrl = config.aiProvider === 'gemini'
    ? config.geminiApiBase
    : config.openaiApiBase

  const model = config.aiProvider === 'gemini'
    ? config.geminiModel
    : config.openaiCardModel

  const url = `${baseUrl}/v1/chat/completions`

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    enable_thinking: false,  // 统一关闭思考模式，减少首 token 延迟
  }

  if (tools && tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`AI API 错误 ${response.status}: ${text.slice(0, 200)}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('无法获取响应流')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return

      try {
        const parsed = JSON.parse(data) as SSEChunk
        const choice = parsed.choices?.[0]
        if (!choice) continue

        const delta = choice.delta

        // Text content
        if (delta?.content) {
          yield { type: 'textDelta', delta: delta.content }
        }

        // Tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            yield {
              type: 'toolCallDelta',
              index: tc.index ?? 0,
              id: tc.id ?? null,
              name: tc.function?.name ?? null,
              argsDelta: tc.function?.arguments ?? null,
            }
          }
        }

        // Finish reason
        if (choice.finish_reason) {
          yield { type: 'finishReason', reason: choice.finish_reason }
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }
}

// ── Non-streaming Chat ──

export async function chat(
  config: AgentConfig,
  messages: readonly LLMMessage[],
  model?: string,
): Promise<string> {
  const apiKey = config.aiProvider === 'gemini'
    ? config.geminiApiKey
    : config.openaiApiKey

  if (!apiKey) throw new Error('API Key 未配置')

  const baseUrl = config.aiProvider === 'gemini'
    ? config.geminiApiBase
    : config.openaiApiBase

  const useModel = model ?? (config.aiProvider === 'gemini'
    ? config.geminiModel
    : config.openaiCardModel)

  const url = `${baseUrl}/v1/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: useModel, messages }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`AI API 错误 ${response.status}: ${text.slice(0, 200)}`)
  }

  const result = await response.json() as {
    choices: { message: { content: string } }[]
  }

  return result.choices[0]?.message?.content ?? ''
}

// ── SSE Types ──

interface SSEChunk {
  choices?: {
    delta?: {
      content?: string
      tool_calls?: {
        index?: number
        id?: string
        function?: {
          name?: string
          arguments?: string
        }
      }[]
    }
    finish_reason?: string
  }[]
}
