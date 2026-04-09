// ══════════════════════════════════════════════
// queryModel — LLM API 调用层
// 精简移植自 Claude Code services/api/claude.ts
//
// 适配 OpenAI-compatible API（Qwen/dashscope）
// 输入：新 Message 类型系统
// 输出：Stream<ApiStreamChunk>（含 textDelta / toolCallDelta / done）
// ══════════════════════════════════════════════

import { Stream } from './stream'
import { normalizeMessagesForAPI } from './normalize'
import type { Message, UserMessage, AssistantMessage, ContentBlock, ToolDefinition } from './types'

// ── 流式事件类型 ──

export type ApiStreamChunk =
  | { type: 'textDelta'; delta: string }
  | { type: 'toolCallDelta'; index: number; id: string | null; name: string | null; argsDelta: string | null }
  | { type: 'done'; stopReason: string; inputTokens: number; outputTokens: number }
  | { type: 'error'; status: number; message: string }

// ── API 请求选项 ──

export interface QueryOptions {
  apiKey: string
  apiBase: string      // e.g. 'https://dashscope.aliyuncs.com/compatible-mode'
  model: string        // e.g. 'qwen-plus'
  systemPrompt?: string
  maxTokens?: number   // 默认 8000（Claude Code 的 CAPPED_DEFAULT_MAX_TOKENS 设计：保守槽位保留）
  signal?: AbortSignal
  tools?: readonly ToolDefinition[]  // function calling tools
}

// ── OpenAI 格式消息（发给 API 的） ──

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
  tool_call_id?: string
  name?: string
}

// ── Message 类型 → OpenAI 格式转换 ──

function contentBlocksToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function userMessageToOpenAI(m: UserMessage): OpenAIMessage | OpenAIMessage[] {
  const content = m.message.content

  // 工具结果消息（toolUseResult 字段不为空）→ OpenAI role:'tool'
  if (m.toolUseResult !== undefined) {
    return {
      role: 'tool',
      content: m.toolUseResult,
      tool_call_id: m.sourceToolCallId ?? 'unknown',
    }
  }

  // 普通用户消息
  return {
    role: 'user',
    content: contentBlocksToText(content),
  }
}

function assistantMessageToOpenAI(m: AssistantMessage): OpenAIMessage {
  const textContent = contentBlocksToText(m.message.content)

  // 如果有 tool_use blocks，转为 tool_calls
  const toolUseBlocks = Array.isArray(m.message.content)
    ? m.message.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )
    : []

  if (toolUseBlocks.length > 0) {
    return {
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolUseBlocks.map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      })),
    }
  }

  return { role: 'assistant', content: textContent }
}

function messagesToOpenAI(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt?: string,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const m of messages) {
    if (m.type === 'user') {
      const converted = userMessageToOpenAI(m)
      if (Array.isArray(converted)) {
        result.push(...converted)
      } else {
        result.push(converted)
      }
    } else {
      result.push(assistantMessageToOpenAI(m))
    }
  }

  return result
}

// ── SSE 解析 ──

interface SSEChunk {
  choices?: {
    delta?: {
      content?: string
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

// ── 核心：queryModel ──

/**
 * 发起 streaming API 请求，返回 Stream<ApiStreamChunk>。
 *
 * max_tokens 默认 8000（而非模型最大值）：
 * 原则来自 Claude Code context.ts CAPPED_DEFAULT_MAX_TOKENS = 8_000：
 * 服务端为 max_tokens 预留槽位，过大的值在高并发时会占用其他请求的限额。
 * 8k 是"够用但不浪费"的保守估计。
 */
export function queryModel(
  messages: Message[],
  options: QueryOptions,
): Stream<ApiStreamChunk> {
  const abortController = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal

  const stream = new Stream<ApiStreamChunk>(() => {
    // for-await break 时触发 cleanup
    abortController.abort()
  })

  // 异步执行，不 await（让调用方通过 stream 消费）
  void (async () => {
    try {
      // 规范化消息（合并连续同角色、过滤 system/virtual）
      const normalized = normalizeMessagesForAPI(messages)
      const openAIMessages = messagesToOpenAI(normalized, options.systemPrompt)

      const url = `${options.apiBase}/v1/chat/completions`
      const maxTokens = options.maxTokens ?? 8000

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: openAIMessages,
          stream: true,
          max_tokens: maxTokens,
          ...(options.tools && options.tools.length > 0 && { tools: options.tools }),
        }),
        signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '(无响应体)')
        stream.enqueue({
          type: 'error',
          status: response.status,
          message: `API 错误 ${response.status}: ${text.slice(0, 300)}`,
        })
        stream.done()
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        stream.error(new Error('无法获取响应流'))
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let inputTokens = 0
      let outputTokens = 0
      let stopReason = 'stop'

      try {
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
            if (data === '[DONE]') {
              stream.enqueue({ type: 'done', stopReason, inputTokens, outputTokens })
              stream.done()
              return
            }

            try {
              const parsed = JSON.parse(data) as SSEChunk
              const choice = parsed.choices?.[0]

              // 更新 token 计数（部分 API 在每个 chunk 都返回）
              if (parsed.usage) {
                inputTokens = parsed.usage.prompt_tokens ?? inputTokens
                outputTokens = parsed.usage.completion_tokens ?? outputTokens
              }

              if (!choice) continue

              const delta = choice.delta

              if (delta?.content) {
                stream.enqueue({ type: 'textDelta', delta: delta.content })
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  stream.enqueue({
                    type: 'toolCallDelta',
                    index: tc.index ?? 0,
                    id: tc.id ?? null,
                    name: tc.function?.name ?? null,
                    argsDelta: tc.function?.arguments ?? null,
                  })
                }
              }

              if (choice.finish_reason) {
                stopReason = choice.finish_reason
              }
            } catch {
              // 跳过格式异常的 SSE 行
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      // 流结束但未遇到 [DONE]（部分 API 省略 [DONE]）
      stream.enqueue({ type: 'done', stopReason, inputTokens, outputTokens })
      stream.done()
    } catch (err) {
      if (signal.aborted) {
        stream.done() // 用户主动取消，不算错误
      } else {
        stream.error(err)
      }
    }
  })()

  return stream
}
