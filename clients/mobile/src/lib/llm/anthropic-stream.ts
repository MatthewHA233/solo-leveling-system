// ══════════════════════════════════════════════
// Anthropic 流式聊天（Messages API）：把内部消息转成 Anthropic 格式，发请求并解析 SSE
//   POST https://api.anthropic.com/v1/messages
//   头：x-api-key（Key 存 model_api_keys，provider = anthropic）、anthropic-version: 2023-06-01
//   返回的事件形状和 queryModel 一致（textDelta / toolCallDelta / done / error）
//   每次调用记进 model_call_log（api_key_id 归属这把 Key）
//
// 桌面端分在三处：anthropic-stream.ts（组 body）、anthropic_stream.rs（发流式请求、解析、记审计）、
// anthropic.rs（非流式调用、模型种子、测试连接）。手机端没有 Rust 侧，都放在这个文件里，顺序同桌面端。
//   - 请求用 XMLHttpRequest（同 api.ts）：RN 的 fetch 拿不到流式 response.body
//   - 代理：桌面端要在 Rust 里走「网络代理」设置的本机端口（WebView 的 fetch 走不了代理）。
//     手机端没有这个设置：RN 的 XHR 走 OkHttp，默认遵守系统代理，VPN 在系统层接管流量，都不需要 App 配置。
//   - 取消：桌面端的 Rust 请求取消不了，会在后台跑完。手机端 xhr.abort() 真的断开连接。
// ══════════════════════════════════════════════

import { Stream } from './stream'
import { normalizeMessagesForAPI } from './normalize'
import { logModelUsage } from './model-usage'
import { isSolevupDbAvailable, solevupGetActiveModelApiKey } from '../solevupdb'
import type { ModelApiKeyInfo } from '../solevupdb'
import type { ModelDef } from '../models/registry'
import type { ApiStreamChunk, QueryOptions } from './api'
import type { AssistantMessage, ContentBlock, Message, UserMessage } from './types'

const PROVIDER_ANTHROPIC = 'anthropic'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'
/** 连接 / 读取的空闲上限，不是总时长：流式长回复可以超过它 */
const TIMEOUT_MS = 120_000
/** 测试连接用最便宜的模型 */
export const TEST_MODEL = 'claude-haiku-5-5'
const ERROR_BODY_CHARS = 300

export interface AnthropicReply {
  text: string
  model: string
  input_tokens: number
  output_tokens: number
  latency_ms: number
}

/** 目前按模型 id 前缀识别 Anthropic（claude-*） */
export function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith('claude-')
}

type AnthropicBlock =
  | { type: 'text'; text: string }
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

// ── 请求公共部分（对应 anthropic.rs 的 build_client / explain_send_error / truncate）──

function openRequest(apiKey: string): XMLHttpRequest {
  const xhr = new XMLHttpRequest()
  xhr.open('POST', ENDPOINT)
  xhr.setRequestHeader('Content-Type', 'application/json')
  xhr.setRequestHeader('x-api-key', apiKey.trim())
  xhr.setRequestHeader('anthropic-version', API_VERSION)
  // RN 的 XHR 需要显式 text 才能在 onprogress 读 responseText
  xhr.responseType = 'text'
  return xhr
}

function isConnectError(detail: string): boolean {
  return /resolve host|failed to connect|unable to connect|connection refused|unreachable|handshake|no address/i.test(detail)
}

/** 手机端没有代理端口可查，连不上时提示的是系统层的 VPN / 代理 */
function explainSendError(detail: string, timedOut = false): string {
  if (timedOut) return 'Anthropic 超时没响应（线路通了但对面慢，或者线路不稳）'
  if (isConnectError(detail)) return `连不上 Anthropic。确认手机的 VPN 或系统代理开着：${detail}`
  return `请求 Anthropic 失败：${detail}`
}

/** 按字符截断（不切断代理对），同 Rust 的 s.chars().take(max) */
function truncate(s: string, max: number): string {
  return Array.from(s).slice(0, max).join('')
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

function asInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) ? v : fallback
}

async function activeAnthropicKey(): Promise<ModelApiKeyInfo> {
  const key = await solevupGetActiveModelApiKey(PROVIDER_ANTHROPIC)
  if (!key) throw new Error('还没填 Anthropic 的 API Key（模型库 → Key 里添加）')
  return key
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── 非流式调用（对应 anthropic.rs 的 messages / call）──

/**
 * 发一次 Messages 请求：text 为用户消息；jpegBase64 有值时作为图片块放在文字前面；system 可选。
 * 成功失败都记进模型审计（feature = 这次用的功能位）。
 * 桌面端收 JPEG 字节再编码；RN 没有 Buffer，调用方直接给 base64。
 */
export async function anthropicMessages(args: {
  feature: string
  model: string
  system?: string | null
  text: string
  jpegBase64?: string | null
  maxTokens: number
}): Promise<AnthropicReply> {
  const key = await activeAnthropicKey()

  const content: unknown[] = []
  if (args.jpegBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: args.jpegBase64 },
    })
  }
  content.push({ type: 'text', text: args.text })
  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: args.maxTokens,
    messages: [{ role: 'user', content }],
  }
  if (args.system) body.system = args.system

  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  let reply: AnthropicReply | null = null
  let failure: string | null = null
  try {
    reply = await call(key.apiKey, body)
  } catch (e) {
    failure = errorText(e)
  }
  const latencyMs = Date.now() - t0

  const inputTokens = reply?.input_tokens ?? 0
  const outputTokens = reply?.output_tokens ?? 0
  const hasImage = !!args.jpegBase64
  await logModelUsage({
    apiKeyId: key.id,
    feature: args.feature,
    modelId: args.model,
    startedAt,
    durationMs: latencyMs,
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      prompt_tokens_details: {
        text_tokens: hasImage ? 0 : inputTokens,
        image_tokens: hasImage ? inputTokens : 0,
      },
    },
    success: reply !== null,
    errorMessage: failure,
  })

  if (!reply) throw new Error(failure ?? '请求 Anthropic 失败')
  return { ...reply, latency_ms: latencyMs }
}

function call(apiKey: string, body: Record<string, unknown>): Promise<AnthropicReply> {
  return new Promise((resolve, reject) => {
    const xhr = openRequest(apiKey)
    // RN Android 把 xhr.timeout 设成 OkHttp 的 callTimeout（总时长）；非流式请求要到回复写完才有字节，正合适
    xhr.timeout = TIMEOUT_MS
    xhr.onload = () => {
      const raw = xhr.responseText ?? ''
      if (!isSuccess(xhr.status)) {
        reject(new Error(`Anthropic 返回 ${xhr.status}：${truncate(raw, ERROR_BODY_CHARS)}`))
        return
      }
      let json: {
        content?: { type?: string; text?: unknown }[]
        model?: unknown
        usage?: { input_tokens?: unknown; output_tokens?: unknown }
      }
      try {
        json = JSON.parse(raw)
      } catch {
        reject(new Error(`Anthropic 返回的不是 JSON：${truncate(raw, ERROR_BODY_CHARS)}`))
        return
      }
      // content 是一组块，文字块拼起来
      const text = Array.isArray(json?.content)
        ? json.content
            .filter((b) => b.type === 'text')
            .map((b) => (typeof b.text === 'string' ? b.text : ''))
            .join('')
        : ''
      resolve({
        text,
        model: typeof json?.model === 'string' ? json.model : '',
        input_tokens: asInt(json?.usage?.input_tokens, 0),
        output_tokens: asInt(json?.usage?.output_tokens, 0),
        latency_ms: 0,
      })
    }
    xhr.onerror = () => reject(new Error(explainSendError(xhr.responseText || '网络请求失败')))
    xhr.ontimeout = () => reject(new Error(explainSendError('', true)))
    xhr.send(JSON.stringify(body))
  })
}

// ── 模型库种子（Anthropic 官网价目，2026-10 核对；单位美元 / 百万 token，入库保留美元原价，currency = USD）──

type AnthropicTier = readonly [min: number, max: number | null, inUsd: number, outUsd: number]

/** (模型 id, 显示名, 价格阶梯 (min, max, 输入 $, 输出 $), 备注) */
const MODELS: readonly (readonly [string, string, readonly AnthropicTier[], string])[] = [
  ['claude-opus-5-5', 'Claude Opus 5.5', [[0, null, 4.0, 20.0]],
    '智能体主力（官网推荐的默认）。缓存写入 5 分钟 $5 / 1 小时 $8，缓存命中 $0.20（每百万 token）；上下文 100 万，最多输出 12.8 万'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5', [[0, null, 2.0, 10.0]],
    '速度与智能的平衡。缓存写入 5 分钟 $2.5 / 1 小时 $4，缓存命中 $0.10；上下文 100 万，最多输出 12.8 万'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5', [[0, 100_000, 0.10, 0.50], [100_000, null, 0.50, 2.50]],
    '最便宜；分类、抽取、路由。按输入长度两档（≤10 万 / >10 万）。缓存命中 $0.01 / $0.05'],
  ['claude-fable-5-1', 'Claude Fable 5.1', [[0, null, 10.0, 50.0]],
    '最贵；高难推理、长程智能体，Opus 不够时再用。缓存写入 5 分钟 $12.5 / 1 小时 $20，缓存命中 $0.25'],
]

/**
 * 模型种子展开成模型库的行（字段同 anthropic.rs 的 seed_anthropic_models 写入的列）。
 * 这里只产出数据：手机端模型库的写入在 SolevupDb，由模型库那层决定何时合并。
 */
export function anthropicCatalogRows(now: string = new Date().toISOString()): (ModelDef & { currency: string })[] {
  const modalities = JSON.stringify(['text', 'image'])
  return MODELS.map(([id, displayName, tiers, note]) => ({
    id,
    category: 'text' as const,
    provider: PROVIDER_ANTHROPIC,
    display_name: displayName,
    modalities,
    context_window: 1_000_000,
    notes: note,
    deprecated: false,
    updated_at: now,
    currency: 'USD',
    pricing: tiers.map(([min, max, inUsd, outUsd]) => ({
      tier_min_tokens: min,
      tier_max_tokens: max,
      price_input_text: inUsd,
      price_input_image: inUsd,
      price_input_video: null,
      price_input_audio: null,
      price_output_text: outUsd,
      price_output_text_thinking: outUsd,
      price_output_audio: null,
    })),
  }))
}

// ── 测试连接（桌面端的 POST /api/anthropic/test，手机端没有这条 HTTP 路由，直接调函数）──

export interface AnthropicTestResult {
  model: string
  reply: string
  latency_ms: number
  input_tokens: number
  output_tokens: number
}

/** 发一句很短的话验证线路和 Key；model 缺省用最便宜的 Haiku 5.5。失败时 reject，message 可直接展示 */
export async function testAnthropicConnection(model?: string | null): Promise<AnthropicTestResult> {
  const r = await anthropicMessages({
    feature: 'anthropic_test',
    model: model ?? TEST_MODEL,
    system: null,
    text: '只回一个字：好',
    jpegBase64: null,
    maxTokens: 16,
  })
  return {
    model: r.model,
    reply: r.text,
    latency_ms: r.latency_ms,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
  }
}

// ── 流式（对应 anthropic_stream.rs）──

interface Usage {
  input: number
  output: number
  /** 手机端专有：请求被取消，token 数只到取消那一刻 */
  aborted?: boolean
}

/** 块的种类：文字块 / 工具块（工具块带上它在 toolCallDelta 里的序号） */
type Block = { kind: 'text' } | { kind: 'tool'; index: number }

interface SseEvent {
  type?: string
  index?: unknown
  message?: { usage?: { input_tokens?: unknown } }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: unknown; partial_json?: unknown; stop_reason?: unknown }
  usage?: { output_tokens?: unknown }
  error?: { message?: unknown }
}

function mapStopReason(r: string): string {
  switch (r) {
    case 'tool_use': return 'tool_calls'
    case 'max_tokens': return 'length'
    default: return 'stop'
  }
}

/** 一个事件里 data: 那一行（可能有多行 data 时拼起来） */
function dataLine(event: string): string | null {
  const parts = event
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * 发请求并解析 SSE。resolve = 正常结束或被取消（usage.aborted），reject = 失败（message 可直接展示）。
 * 超时按「多久没收到新数据」算：RN 的 xhr.timeout 是总时长，会把长回复从中间截断，所以用 JS 计时器。
 */
function run(
  apiKey: string,
  body: Record<string, unknown>,
  emit: (chunk: ApiStreamChunk) => void,
  onXhr: (xhr: XMLHttpRequest) => void,
): Promise<Usage> {
  return new Promise((resolve, reject) => {
    const xhr = openRequest(apiKey)
    onXhr(xhr)

    let buf = ''   // 事件以 \n\n 结束；RN 已按 UTF-8 解好，不会切断汉字
    let parsedIndex = 0
    const blocks = new Map<number, Block>()
    let toolCount = -1
    const usage: Usage = { input: 0, output: 0 }
    let stopReason = 'stop'
    let settled = false
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
      }, TIMEOUT_MS)
    }
    const succeed = (value: Usage) => {
      if (settled) return
      settled = true
      clearIdle()
      resolve(value)
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearIdle()
      reject(new Error(message))
    }
    const emitDone = () => emit({
      type: 'done', stopReason,
      inputTokens: usage.input, outputTokens: usage.output,
    })

    const handleEvent = (ev: SseEvent) => {
      switch (ev.type) {
        case 'message_start':
          usage.input = asInt(ev.message?.usage?.input_tokens, usage.input)
          break
        case 'content_block_start': {
          const index = asInt(ev.index, 0)
          const block = ev.content_block
          if (block?.type === 'tool_use') {
            toolCount += 1
            blocks.set(index, { kind: 'tool', index: toolCount })
            emit({
              type: 'toolCallDelta', index: toolCount,
              id: block.id ?? null, name: block.name ?? null, argsDelta: null,
            })
          } else {
            blocks.set(index, { kind: 'text' })
          }
          break
        }
        case 'content_block_delta': {
          const entry = blocks.get(asInt(ev.index, 0))
          const delta = ev.delta
          if (delta?.type === 'text_delta') {
            if (typeof delta.text === 'string') emit({ type: 'textDelta', delta: delta.text })
          } else if (delta?.type === 'input_json_delta' && entry?.kind === 'tool') {
            emit({
              type: 'toolCallDelta', index: entry.index, id: null, name: null,
              argsDelta: typeof delta.partial_json === 'string' ? delta.partial_json : null,
            })
          }
          break
        }
        case 'message_delta':
          if (typeof ev.delta?.stop_reason === 'string') stopReason = mapStopReason(ev.delta.stop_reason)
          usage.output = asInt(ev.usage?.output_tokens, usage.output)
          break
        case 'message_stop':
          emitDone()
          succeed(usage)
          break
        case 'error': {
          const msg = typeof ev.error?.message === 'string' ? ev.error.message : '未知错误'
          fail(`Anthropic 流错误：${msg}`)
          break
        }
      }
    }

    const consumeNewText = () => {
      const text = xhr.responseText
      if (text.length <= parsedIndex) return
      buf += text.slice(parsedIndex)
      parsedIndex = text.length
      while (!settled) {
        const pos = buf.indexOf('\n\n')
        if (pos === -1) break
        const raw = buf.slice(0, pos + 2)
        buf = buf.slice(pos + 2)
        const data = dataLine(raw)
        if (data === null) continue
        let ev: SseEvent
        try {
          ev = JSON.parse(data) as SseEvent
        } catch {
          continue
        }
        handleEvent(ev)
      }
    }

    xhr.onprogress = () => {
      if (settled) return
      armIdle()
      if (xhr.status && !isSuccess(xhr.status)) return // 错误体留给 onload 统一处理
      consumeNewText()
    }

    xhr.onload = () => {
      if (settled) return
      if (!isSuccess(xhr.status)) {
        fail(`Anthropic 返回 ${xhr.status}：${truncate(xhr.responseText ?? '', ERROR_BODY_CHARS)}`)
        return
      }
      consumeNewText()
      if (settled) return
      // 流结束但没收到 message_stop：也按完成处理
      emitDone()
      succeed(usage)
    }

    xhr.onerror = () => {
      const detail = xhr.responseText || '网络请求失败'
      // status 为 0 = 还没拿到响应头，等同 send() 失败；否则是读流时断了
      fail(xhr.status ? `读 Anthropic 流失败：${detail}` : explainSendError(detail))
    }

    xhr.onabort = () => {
      if (timedOut) fail(explainSendError('', true))
      else succeed({ ...usage, aborted: true })
    }

    armIdle()
    xhr.send(JSON.stringify(body))
  })
}

/** 对应 anthropic_stream.rs 的 start_stream：跑完这条流，用量记进 model_call_log，失败时推一个 error */
async function startStream(
  key: ModelApiKeyInfo,
  feature: string,
  body: Record<string, unknown>,
  emit: (chunk: ApiStreamChunk) => void,
  onXhr: (xhr: XMLHttpRequest) => void,
  onUsageLogged: QueryOptions['onUsageLogged'],
): Promise<void> {
  const model = typeof body.model === 'string' ? body.model : ''
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  let usage: Usage | null = null
  let failure: string | null = null
  try {
    usage = await run(key.apiKey, body, emit, onXhr)
  } catch (e) {
    failure = errorText(e)
  }
  const durationMs = Date.now() - t0

  // 取消时一个 token 都没看到就不记：请求大概率还没到对面
  const nothingToLog = usage?.aborted === true && usage.input === 0 && usage.output === 0
  if (!nothingToLog) {
    const call = await logModelUsage({
      apiKeyId: key.id,
      feature,
      modelId: model,
      startedAt,
      durationMs,
      usage: { prompt_tokens: usage?.input ?? 0, completion_tokens: usage?.output ?? 0 },
      success: failure === null,
      errorMessage: failure,
      metadata: usage?.aborted ? { aborted: true } : null,
    })
    if (call) onUsageLogged?.(call)
  }

  if (failure !== null) emit({ type: 'error', status: 0, message: failure })
}

/** 发起一次 Anthropic 流式请求，返回和 queryModel 同一形状的 Stream */
export function streamAnthropic(messages: Message[], options: QueryOptions): Stream<ApiStreamChunk> {
  let xhr: XMLHttpRequest | null = null
  let finished = false
  const stop = () => {
    finished = true
  }
  const stream = new Stream<ApiStreamChunk>(() => {
    stop()
    xhr?.abort()
  })

  const finish = (chunk: ApiStreamChunk) => {
    if (finished) return
    stream.enqueue(chunk)
    stop()
    stream.done()
  }

  void (async () => {
    try {
      if (!isSolevupDbAvailable()) throw new Error('数据库还没就绪')
      const key = await activeAnthropicKey()
      if (options.signal?.aborted) {
        stop()
        stream.done()
        return
      }
      options.signal?.addEventListener('abort', () => {
        stop()
        stream.done()
        xhr?.abort()
      }, { once: true })
      await startStream(
        key,
        options.feature ?? 'fairy_chat',
        buildAnthropicBody(messages, options),
        (p) => {
          if (p.type === 'done' || p.type === 'error') finish(p)
          else if (!finished) stream.enqueue(p)
        },
        (x) => { xhr = x },
        options.onUsageLogged,
      )
    } catch (e) {
      finish({ type: 'error', status: 0, message: errorText(e) })
    }
  })()

  return stream
}
