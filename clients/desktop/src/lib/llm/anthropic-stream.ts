// ══════════════════════════════════════════════
// Anthropic 流式聊天（Messages API）：把内部消息转成 Anthropic 格式，请求交给 Rust 发（走网络代理）
//   Key 在 Rust 侧从模型库读，前端不接触；返回的事件形状和 queryModel 一致（textDelta / toolCallDelta / done / error）
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Stream } from './stream'
import { normalizeMessagesForAPI } from './normalize'
import { getModelCallLog } from '../model-audit'
import type { ApiStreamChunk, QueryOptions } from './api'
import type { AssistantMessage, ContentBlock, Message, UserMessage } from './types'

/** 目前按模型 id 前缀识别 Anthropic（claude-*） */
export function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith('claude-')
}

// ── 实时背景发成只在当轮有效的 system 消息 ──
// 背景每轮都变。拼在当轮那句话里、下一轮再删掉，等于改历史：从那句话往后的缓存全对不上。
// 新模型可以在 messages 里放 role: 'system' 的消息，带 clear_at: 'next_user_message' 时只在当轮生效，
// 之后原样留在历史里（不占 token、不算进缓存键），历史就只追加不删改。

/** clear_at 还是测试版，要带这个请求头 */
const CLEAR_AT_BETA = 'mid-conversation-system-clear-at-2026-08-21'
/** 支持对话中 system 消息的模型（Sonnet 5 和更早的不支持） */
const TURN_REMINDER_MODELS = /^claude-(fable-5|mythos-5|opus-5|opus-4-8|sonnet-5-5|haiku-5-5)/
/** 接口拒收过一次（请求头失效、换了不支持的线路）就在这次运行里停用，退回拼在当轮那句话里的老办法 */
let turnReminderRejected = false

/** 这个模型的实时背景是否走 system 消息（UserMessage.turnReminder）。调用方按它决定背景放哪 */
export function usesTurnReminder(modelId: string): boolean {
  return !turnReminderRejected && TURN_REMINDER_MODELS.test(modelId)
}

/** 请求失败时看一眼原因：是这种消息被拒收就停用，下一句话起走老办法 */
function noteAnthropicFailure(message: string): void {
  if (message.includes('clear_at') || message.includes("role 'system'")) turnReminderRejected = true
}

/** 这次请求要带的测试版请求头：body 里有背景消息才带 */
export function anthropicBetas(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string }[]) : []
  return messages.some((m) => m.role === 'system') ? [CLEAR_AT_BETA] : []
}

/** 提示缓存断点：不写 ttl 是 5 分钟档（写入 1.25 倍），1h 是 1 小时档（写入 2 倍）；命中都按读取价 */
type CacheControl = { type: 'ephemeral'; ttl?: '1h' }
const CACHE_1H: CacheControl = { type: 'ephemeral', ttl: '1h' }
const CACHE_5M: CacheControl = { type: 'ephemeral' }

type AnthropicBlock = (
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
) & { cache_control?: CacheControl }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

/** 只在当轮有效的背景消息：紧跟在一条 user 消息后面，后面只能接 assistant 或者什么都没有 */
interface AnthropicTurnReminder {
  role: 'system'
  content: string
  clear_at: 'next_user_message'
}

type AnthropicEntry = AnthropicMessage | AnthropicTurnReminder

const isTurnReminder = (e: AnthropicEntry | undefined): e is AnthropicTurnReminder => e?.role === 'system'

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * 内部消息 → Anthropic messages：同角色相邻的合并；tool_result 挂在 user 消息里。
 * 带实时背景的 user 消息（turnReminder）后面跟一条背景消息。asSystem = false（模型不支持）时
 * 不发背景消息，只把最新那份拼在最后一条 user 消息末尾。
 */
function toAnthropicMessages(messages: (UserMessage | AssistantMessage)[], asSystem: boolean): AnthropicEntry[] {
  const out: AnthropicEntry[] = []
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return
    // 背景消息后面紧接着又是 user（上一轮被打断，没有回复）：接口不收，把它拿掉，两段 user 合成一条
    if (role === 'user' && isTurnReminder(out[out.length - 1])) out.pop()
    const last = out[out.length - 1]
    if (last && !isTurnReminder(last) && last.role === role) last.content.push(...blocks)
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
      if (m.turnReminder && out[out.length - 1]?.role === 'user') {
        out.push({ role: 'system', content: m.turnReminder, clear_at: 'next_user_message' })
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
  if (asSystem) return out

  // 模型不支持背景消息（中途换了模型，或接口拒收后停用）：只留最新那份，拼在最后一条 user 消息末尾
  const current = out[out.length - 1]
  const plain = out.filter((e): e is AnthropicMessage => !isTurnReminder(e))
  const lastPlain = plain[plain.length - 1]
  if (isTurnReminder(current) && lastPlain?.role === 'user') {
    lastPlain.content.push({ type: 'text', text: `<system-reminder>\n${current.content}\n</system-reminder>` })
  }
  return plain
}

const hasToolResult = (m: AnthropicMessage) => m.content.some((b) => b.type === 'tool_result')

function withBreakpoint(m: AnthropicMessage, cache: CacheControl): AnthropicMessage {
  const last = m.content.length - 1
  return { ...m, content: m.content.map((b, i) => (i === last ? { ...b, cache_control: cache } : b)) }
}

/**
 * 在消息里标缓存断点（缓存是前缀匹配，只在断点处写入；system 末尾另有一个，见 buildAnthropicBody）：
 *   1. 这一轮开头那句话之前的最后一块（1 小时）。那句话带着当轮的实时背景，下一轮就换回原话，
 *      所以含它的前缀下一轮对不上；它之前的历史跨轮不变，下一轮从这里读、只补写上一轮新增的部分。
 *   2. 末尾是工具结果时的最后一块（5 分钟）。同一轮的工具循环里前缀不变，下一次请求从这里读。
 * 压缩、清理旧工具结果、丢旧图片会改动较早的消息，那一次从改动处往后重写，system 和工具定义的缓存不受影响。
 *
 * 实时背景走背景消息时（entries 里有 role: 'system'），历史只追加不删改，上面两处都用不着：
 * 只在最后一条 user 消息的最后一块标一个（1 小时），下一次请求从这里读，每段内容只写一次。
 * 背景消息本身不能标断点，也不算进缓存键。
 */
export function markCacheBreakpoints(entries: AnthropicEntry[]): AnthropicEntry[] {
  if (entries.some(isTurnReminder)) {
    let lastUser = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === 'user') {
        lastUser = i
        break
      }
    }
    return entries.map((e, i) => (i === lastUser && !isTurnReminder(e) ? withBreakpoint(e, CACHE_1H) : e))
  }
  const messages = entries.filter((e): e is AnthropicMessage => !isTurnReminder(e))
  let turnStart = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !hasToolResult(messages[i])) {
      turnStart = i
      break
    }
  }
  const last = messages.length - 1
  return messages.map((m, i) => {
    if (i === turnStart - 1) return withBreakpoint(m, CACHE_1H)
    if (i === last && i > turnStart && hasToolResult(m)) return withBreakpoint(m, CACHE_5M)
    return m
  })
}

export function buildAnthropicBody(messages: Message[], options: QueryOptions): Record<string, unknown> {
  const normalized = normalizeMessagesForAPI(messages)
  // 带工具的请求（Fairy 聊天、写压缩摘要）才开缓存：工具定义 + 系统提示词每次都一样，历史一轮轮往后接。
  // 一次性的短请求（提炼、起标题）前缀用不到第二次，开了只是白付写入价
  const cached = !!options.tools && options.tools.length > 0
  const apiMessages = toAnthropicMessages(normalized, usesTurnReminder(options.model))
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxTokens ?? 8000,
    messages: cached ? markCacheBreakpoints(apiMessages) : apiMessages,
    stream: true,
  }
  if (options.systemPrompt) {
    // 渲染顺序是 tools → system → messages：system 末尾的断点把工具定义和系统提示词一起缓存
    body.system = cached
      ? [{ type: 'text', text: options.systemPrompt, cache_control: CACHE_1H }]
      : options.systemPrompt
  }
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
      // Rust 记完账先推 usageLogged（带日志 id），再推 done：取回这条记录交给界面（气泡上的费用），取完才收尾
      let usageReady: Promise<void> = Promise.resolve()
      unlisten = await listen<ApiStreamChunk | { type: 'usageLogged'; id: string }>(`anthropic-stream-${streamId}`, (e) => {
        const p = e.payload
        if (p.type === 'usageLogged') {
          usageReady = getModelCallLog(p.id)
            .then((row) => {
              if (!row) return
              window.dispatchEvent(new CustomEvent('model-usage-logged', { detail: row }))
              options.onUsageLogged?.(row)
            })
            .catch((err) => console.warn('[Anthropic] 取调用记录失败', err))
          return
        }
        if (p.type === 'error') noteAnthropicFailure(p.message)
        if (p.type === 'done' || p.type === 'error') void usageReady.then(() => finish(p))
        else if (!finished) stream.enqueue(p)
      })
      if (options.signal?.aborted) {
        stop()
        stream.done()
        return
      }
      options.signal?.addEventListener('abort', () => { stop(); stream.done() }, { once: true })
      const body = buildAnthropicBody(messages, options)
      await invoke('anthropic_stream_start', {
        streamId,
        feature: options.feature ?? 'fairy_chat',
        body,
        betas: anthropicBetas(body),
      })
    } catch (e) {
      finish({ type: 'error', status: 0, message: e instanceof Error ? e.message : String(e) })
    }
  })()

  return stream
}
