// ══════════════════════════════════════════════
// queryModel — LLM API 调用层（mobile 版）
// 精简移植自 Claude Code services/api/claude.ts
//
// 适配 OpenAI-compatible API（Qwen/dashscope）
// 输入：新 Message 类型系统
// 输出：Stream<ApiStreamChunk>（含 textDelta / toolCallDelta / done）
//
// 与 desktop lib/llm/api.ts 逐段对应，一处平台适配：
//   RN 的 fetch 不支持流式 response.body → 用 XMLHttpRequest
//   onprogress 增量读 responseText 解析 SSE
// ══════════════════════════════════════════════

import { Stream } from './stream'
import { isAnthropicModel, streamAnthropic } from './anthropic-stream'
import { hideImagesFromModel, normalizeMessagesForAPI } from './normalize'
import { logModelUsage, type DashScopeUsage, type ModelCallLog } from './model-usage'
import type { Message, UserMessage, AssistantMessage, ContentBlock, ToolDefinition } from './types'

export type { DashScopeUsage, ModelCallLog } from './model-usage'

const IDLE_TIMEOUT_MS = 120_000

// ── 流式事件类型 ──

export type ApiStreamChunk =
  | { type: 'textDelta'; delta: string }
  | { type: 'reasoningDelta'; delta: string }   // 思考模型（enable_thinking）的推理流
  | { type: 'toolCallDelta'; index: number; id: string | null; name: string | null; argsDelta: string | null }
  | { type: 'done'; stopReason: string; inputTokens: number; outputTokens: number }
  | { type: 'error'; status: number; message: string }

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
  maxTokens?: number   // 默认 8000（Claude Code 的 CAPPED_DEFAULT_MAX_TOKENS 设计：保守槽位保留）
  signal?: AbortSignal
  tools?: readonly ToolDefinition[]  // function calling tools
  // 当前模型看不了图：把历史里的图换成说明再发（见 normalize.ts）
  hideImages?: boolean
  feature?: string
  // 调试：每次实际发出 API 请求前调用，传入完整 payload 快照
  onRequestSnapshot?: (snapshot: ApiRequestSnapshot) => void
  // 模型审计：本轮 logModelUsage 完成后回传 ModelCallLog（供调用方贴到 agent 气泡）
  onUsageLogged?: (call: ModelCallLog) => void
  // 内部：当前 queryLoop 迭代编号（由 query-loop.ts 注入）
  _iteration?: number
}

// ── OpenAI 格式消息（发给 API 的） ──

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | OpenAIContentPart[]
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

function userContentToOpenAI(content: string | ContentBlock[]): string | OpenAIContentPart[] {
  if (typeof content === 'string' || !content.some((b) => b.type === 'image')) return contentBlocksToText(content)
  const parts: OpenAIContentPart[] = []
  for (const b of content) {
    if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } })
    else if (b.type === 'text') parts.push({ type: 'text', text: b.text })
  }
  return parts
}

/** 调试快照一直留在气泡上：图片只记大小，不留 base64 */
function snapshotMessages(messages: OpenAIMessage[]): ApiRequestSnapshot['messages'] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return { ...m, content: m.content }
    const content = m.content
      .map((p) => (p.type === 'text' ? p.text : `[图片 ${Math.round((p.image_url.url.length * 3) / 4 / 1024)} KB]`))
      .join('\n')
    return { ...m, content }
  })
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
    content: userContentToOpenAI(content),
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
  if (options.hideImages) messages = hideImagesFromModel(messages)

  // Anthropic（claude-*）走自己的通道，见 anthropic-stream.ts
  if (isAnthropicModel(options.model)) return streamAnthropic(messages, options)

  let currentXhr: XMLHttpRequest | null = null
  let finished = false

  const stream = new Stream<ApiStreamChunk>(() => {
    // for-await break 时触发 cleanup
    if (!finished) currentXhr?.abort()
  })

  try {
    // 规范化消息（合并连续同角色、过滤 system/virtual）
    const normalized = normalizeMessagesForAPI(messages)
    const openAIMessages = messagesToOpenAI(normalized, options.systemPrompt)

    const url = `${options.apiBase}/v1/chat/completions`
    const maxTokens = options.maxTokens ?? 8000

    // 调试快照：发请求前暴露完整 payload（不含 apiKey）
    options.onRequestSnapshot?.({
      iteration: options._iteration ?? 0,
      model: options.model,
      maxTokens,
      messages: snapshotMessages(openAIMessages),
      tools: options.tools ? [...options.tools] : undefined,
      timestamp: new Date().toISOString(),
    })

    const startedAt = new Date().toISOString()
    const startedMs = Date.now()

    // enable_thinking=false 给普通 Qwen3.x 降首 token 延迟与成本；
    // 但思考特化模型（如 qwen3.7-max）只允许 true，发 false 会 400 —— 收到该错误就剥掉参数重试一次
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

      // RN 给 OkHttp 的读超时是 0（不限时）。Wi-Fi 切蜂窝这类静默断线收不到任何事件，这轮会一直卡在处理中，
      // 所以按「多久没收到新数据」算超时，值和 anthropic-stream.ts 相同
      let timedOut = false
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const clearIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = null
      }
      const armIdle = () => {
        clearIdle()
        idleTimer = setTimeout(() => {
          timedOut = true
          xhr.abort()
        }, IDLE_TIMEOUT_MS)
      }

      const handleSSELine = (trimmed: string) => {
        if (sawDone) return // desktop 在 [DONE] 处直接 return 出读循环，之后的行都不看
        if (!trimmed || !trimmed.startsWith('data: ')) return
        const data = trimmed.slice(6)
        if (data === '[DONE]') {
          sawDone = true
          clearIdle()
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
            if (!usageLogged) {
              usageLogged = true
              void logModelUsage({
                feature: options.feature ?? 'fairy_chat',
                modelId: options.model,
                startedAt,
                durationMs: Date.now() - startedMs,
                usage: parsed.usage,
                success: true,
                metadata: {
                  iteration: options._iteration ?? 0,
                  maxTokens,
                  toolCount: options.tools?.length ?? 0,
                },
              }).then((call) => {
                if (call) options.onUsageLogged?.(call)
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
            console.log('[API] finish_reason=', choice.finish_reason, 'tool_calls=', !!(delta?.tool_calls?.length))
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

      const isOk = () => xhr.status >= 200 && xhr.status < 300 // 同 fetch 的 response.ok

      xhr.onprogress = () => {
        if (!sawDone) armIdle()
        if (xhr.status && !isOk()) return // 错误体留给 onload 统一处理
        consumeNewText()
      }

      xhr.onload = () => {
        clearIdle()
        if (!isOk()) {
          const errText = xhr.responseText || ''
          // enable_thinking 自愈：剥掉参数重发一次（与 desktop api.ts 同语义）
          if (xhr.status === 400 && withThinkingOff && errText.includes('enable_thinking')) {
            // desktop 第二次 fetch 带同一个 signal，已取消时直接抛错 → stream.done()
            if (options.signal?.aborted) {
              finished = true
              stream.done()
              return
            }
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
        if (!sawDone) {
          // 流结束但未遇到 [DONE]（部分 API 省略 [DONE]）
          stream.enqueue({ type: 'done', stopReason, inputTokens, outputTokens })
          stream.done()
        }
      }

      xhr.onerror = () => {
        clearIdle()
        finished = true
        // 与 desktop 的 fetch 一样抛 TypeError，retry.ts 的 toRetryableError 据此认网络错误
        stream.error(new TypeError('网络请求失败'))
      }

      xhr.onabort = () => {
        clearIdle()
        finished = true
        // 超时不抛 TypeError：主人已经等了 2 分钟，不再自动重试（重试 3 次要再等 6 分钟）
        if (timedOut) stream.error(new Error('网络请求失败：模型超过 2 分钟没有返回新内容'))
        else stream.done() // 主动取消，不算错误
      }

      armIdle()
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
