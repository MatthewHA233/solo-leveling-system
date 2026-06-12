// ══════════════════════════════════════════════
// queryModel — LLM API 调用层（mobile 版）
// 与 desktop 的 src/lib/llm/api.ts 保持同一接口形状：
//   queryModel(messages, options) → Stream<ApiStreamChunk>
//
// 两处平台适配：
//   1. RN 的 fetch 不支持流式 response.body → 用 XMLHttpRequest
//      onprogress 增量读 responseText 解析 SSE
//   2. desktop 的 logModelUsage 依赖 Tauri command → mobile 通过
//      onUsageLogged 回传轻量 UsageInfo，由上层决定怎么记
// ══════════════════════════════════════════════

import { Stream } from './stream'
import { normalizeMessagesForAPI } from './normalize'
import type { Message, UserMessage, AssistantMessage, ContentBlock, ToolDefinition } from './types'

// ── 流式事件类型（与 desktop 完全一致） ──

export type ApiStreamChunk =
  | { type: 'textDelta'; delta: string }
  | { type: 'reasoningDelta'; delta: string }   // 思考模型（enable_thinking）的推理流
  | { type: 'toolCallDelta'; index: number; id: string | null; name: string | null; argsDelta: string | null }
  | { type: 'done'; stopReason: string; inputTokens: number; outputTokens: number }
  | { type: 'error'; status: number; message: string }

// ── DashScope usage（与 desktop model-audit 的 DashScopeUsage 同形） ──

export interface DashScopeUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface UsageInfo {
  feature: string
  modelId: string
  startedAt: string
  durationMs: number
  usage: DashScopeUsage
}

// ── API 请求选项 ──

export interface ApiRequestSnapshot {
  iteration: number
  model: string
  maxTokens: number
  messages: Array<{
    role: string
    content: string | null
    tool_calls?: unknown[]
    tool_call_id?: string
  }>
  tools?: unknown[]
  timestamp: string
}

export interface QueryOptions {
  apiKey: string
  apiBase: string      // e.g. 'https://dashscope.aliyuncs.com/compatible-mode'
  model: string        // e.g. 'qwen-plus'
  systemPrompt?: string
  maxTokens?: number   // 默认 8000
  signal?: AbortSignal
  tools?: readonly ToolDefinition[]
  feature?: string
  onRequestSnapshot?: (snapshot: ApiRequestSnapshot) => void
  onUsageLogged?: (info: UsageInfo) => void
  // 内部：当前 queryLoop 迭代编号（由 query-loop.ts 注入）
  _iteration?: number
}

// ── OpenAI 格式消息 ──

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

function contentBlocksToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function userMessageToOpenAI(m: UserMessage): OpenAIMessage | OpenAIMessage[] {
  const content = m.message.content

  if (m.toolUseResult !== undefined) {
    return {
      role: 'tool',
      content: m.toolUseResult,
      tool_call_id: m.sourceToolCallId ?? 'unknown',
    }
  }

  return {
    role: 'user',
    content: contentBlocksToText(content),
  }
}

function assistantMessageToOpenAI(m: AssistantMessage): OpenAIMessage {
  const textContent = contentBlocksToText(m.message.content)

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
      reasoning_content?: string   // 思考模型的推理增量（content 之前到达）
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: DashScopeUsage
}

// ── 核心：queryModel（XHR 流式版） ──

export function queryModel(
  messages: Message[],
  options: QueryOptions,
): Stream<ApiStreamChunk> {
  let currentXhr: XMLHttpRequest | null = null
  let finished = false

  const stream = new Stream<ApiStreamChunk>(() => {
    // for-await break 时触发 cleanup
    if (!finished) currentXhr?.abort()
  })

  try {
    const normalized = normalizeMessagesForAPI(messages)
    const openAIMessages = messagesToOpenAI(normalized, options.systemPrompt)

    const url = `${options.apiBase}/v1/chat/completions`
    const maxTokens = options.maxTokens ?? 8000

    options.onRequestSnapshot?.({
      iteration: options._iteration ?? 0,
      model: options.model,
      maxTokens,
      messages: openAIMessages,
      tools: options.tools ? [...options.tools] : undefined,
      timestamp: new Date().toISOString(),
    })

    const startedAt = new Date().toISOString()
    const startedMs = Date.now()

    // enable_thinking=false 给普通 Qwen3.x 降首 token 延迟与成本；
    // 思考特化模型（qwen3.7-max 等）只许 true，发 false 会 400 —— 收到该错误剥掉参数重试一次
    const startAttempt = (withThinkingOff: boolean) => {
      const xhr = new XMLHttpRequest()
      currentXhr = xhr

      let parsedIndex = 0       // responseText 已解析到的位置
      let lineBuffer = ''       // 不完整行缓冲
      let inputTokens = 0
      let outputTokens = 0
      let stopReason = 'stop'
      let usageLogged = false
      let sawDone = false

      const handleSSELine = (trimmed: string) => {
        if (!trimmed || !trimmed.startsWith('data: ')) return
        const data = trimmed.slice(6)
        if (data === '[DONE]') {
          if (!sawDone) {
            sawDone = true
            stream.enqueue({ type: 'done', stopReason, inputTokens, outputTokens })
            stream.done()
          }
          return
        }
        try {
          const parsed = JSON.parse(data) as SSEChunk
          const choice = parsed.choices?.[0]

          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens ?? inputTokens
            outputTokens = parsed.usage.completion_tokens ?? outputTokens
            if (!usageLogged && (parsed.usage.prompt_tokens || parsed.usage.completion_tokens)) {
              usageLogged = true
              options.onUsageLogged?.({
                feature: options.feature ?? 'fairy_chat',
                modelId: options.model,
                startedAt,
                durationMs: Date.now() - startedMs,
                usage: parsed.usage,
              })
            }
          }

          if (!choice) return
          const delta = choice.delta

          if (delta?.reasoning_content) {
            stream.enqueue({ type: 'reasoningDelta', delta: delta.reasoning_content })
          }

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

      const consumeNewText = () => {
        const text = xhr.responseText
        if (text.length <= parsedIndex) return
        lineBuffer += text.slice(parsedIndex)
        parsedIndex = text.length
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) handleSSELine(line.trim())
      }

      xhr.open('POST', url)
      xhr.setRequestHeader('Content-Type', 'application/json')
      xhr.setRequestHeader('Authorization', `Bearer ${options.apiKey}`)
      // RN 的 XHR 需要显式 text 才能在 onprogress 读 responseText
      xhr.responseType = 'text'

      xhr.onprogress = () => {
        if (xhr.status && xhr.status >= 400) return // 错误体留给 onload 统一处理
        consumeNewText()
      }

      xhr.onload = () => {
        if (xhr.status >= 400) {
          const errText = xhr.responseText || ''
          // enable_thinking 自愈：剥掉参数重发一次（与 desktop api.ts 同语义）
          if (xhr.status === 400 && withThinkingOff && errText.includes('enable_thinking')) {
            startAttempt(false)
            return
          }
          finished = true
          stream.enqueue({
            type: 'error',
            status: xhr.status,
            message: `API 错误 ${xhr.status}: ${(errText || '(无响应体)').slice(0, 300)}`,
          })
          stream.done()
          return
        }
        finished = true
        consumeNewText()
        if (lineBuffer.trim()) handleSSELine(lineBuffer.trim())
        if (!sawDone) {
          // 流结束但未遇到 [DONE]（部分 API 省略）
          stream.enqueue({ type: 'done', stopReason, inputTokens, outputTokens })
          stream.done()
        }
      }

      xhr.onerror = () => {
        finished = true
        stream.error(new Error('网络请求失败'))
      }

      xhr.onabort = () => {
        finished = true
        stream.done() // 主动取消，不算错误
      }

      xhr.send(
        JSON.stringify({
          model: options.model,
          messages: openAIMessages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: maxTokens,
          ...(withThinkingOff && { enable_thinking: false }),
          ...(options.tools && options.tools.length > 0 && { tools: options.tools }),
        }),
      )
    }

    if (options.signal) {
      if (options.signal.aborted) {
        finished = true
        stream.done()
        return stream
      }
      options.signal.addEventListener('abort', () => currentXhr?.abort(), { once: true })
    }

    startAttempt(true)
  } catch (err) {
    stream.error(err)
  }

  return stream
}
