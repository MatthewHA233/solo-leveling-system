// ══════════════════════════════════════════════
// Anthropic 流式聊天（Messages API）：把内部消息转成 Anthropic 格式，请求交给 Rust 发（走网络代理）
//   Key 在 Rust 侧从模型库读，前端不接触；返回的事件形状和 queryModel 一致（textDelta / toolCallDelta / done / error）
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Stream } from './stream'
import { normalizeMessagesForAPI } from './normalize'
import type { ApiStreamChunk, QueryOptions } from './api'
import type { AssistantMessage, ContentBlock, Message, UserMessage } from './types'

/** 目前按模型 id 前缀识别 Anthropic（claude-*） */
export function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith('claude-')
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/** 内部消息 → Anthropic messages：同角色相邻的合并；tool_result 挂在 user 消息里 */
function toAnthropicMessages(messages: (UserMessage | AssistantMessage)[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const m of messages) {
    if (m.type === 'user') {
      if (m.toolUseResult !== undefined) {
        push('user', [{ type: 'tool_result', tool_use_id: m.sourceToolCallId ?? 'unknown', content: m.toolUseResult }])
      } else {
        const text = textOf(m.message.content)
        if (Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (b.type === 'image') push('user', [{ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } }])
          }
        }
        if (text.trim()) push('user', [{ type: 'text', text }])
      }
    } else {
      const text = textOf(m.message.content)
      if (text.trim()) push('assistant', [{ type: 'text', text }])
      if (Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === 'tool_use') push('assistant', [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }])
        }
      }
    }
  }
  // Anthropic 要求第一条是 user
  if (out.length > 0 && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '请继续。' }] })
  }
  return out
}

export function buildAnthropicBody(messages: Message[], options: QueryOptions): Record<string, unknown> {
  const normalized = normalizeMessagesForAPI(messages)
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxTokens ?? 8000,
    messages: toAnthropicMessages(normalized),
    stream: true,
  }
  if (options.systemPrompt) body.system = options.systemPrompt
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }))
  }
  return body
}

/** 发起一次 Anthropic 流式请求，返回和 queryModel 同一形状的 Stream */
export function streamAnthropic(messages: Message[], options: QueryOptions): Stream<ApiStreamChunk> {
  let unlisten: UnlistenFn | null = null
  let finished = false
  const stop = () => {
    finished = true
    unlisten?.()
    unlisten = null
  }
  const stream = new Stream<ApiStreamChunk>(stop)
  const streamId = crypto.randomUUID()

  const finish = (chunk: ApiStreamChunk) => {
    if (finished) return
    stream.enqueue(chunk)
    stop()
    stream.done()
  }

  void (async () => {
    try {
      unlisten = await listen<ApiStreamChunk>(`anthropic-stream-${streamId}`, (e) => {
        const p = e.payload
        if (p.type === 'done' || p.type === 'error') finish(p)
        else if (!finished) stream.enqueue(p)
      })
      if (options.signal?.aborted) {
        stop()
        stream.done()
        return
      }
      options.signal?.addEventListener('abort', () => { stop(); stream.done() }, { once: true })
      await invoke('anthropic_stream_start', {
        streamId,
        feature: options.feature ?? 'fairy_chat',
        body: buildAnthropicBody(messages, options),
      })
    } catch (e) {
      finish({ type: 'error', status: 0, message: e instanceof Error ? e.message : String(e) })
    }
  })()

  return stream
}
