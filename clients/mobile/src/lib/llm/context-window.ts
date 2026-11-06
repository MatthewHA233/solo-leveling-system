// ══════════════════════════════════════════════
// 上下文窗口：静态前缀 + 每轮实时背景 + 压缩
// desktop 与 mobile 两份逐字一致，改要两端一起改。方案见 docs/AI系统/上下文压缩与长期记忆-调研交接.md 第九节
//
// 前缀稳定：系统提示词每轮不变，实时背景只附在当轮那条消息上，存进历史的是原话。
//   平时只往后追加；超门槛才一次改一大块（清理旧工具结果 / 换成摘要），缓存只断这一次。
//
// 体量按 token 算：上一次回复的真实用量（输入 + 输出），加上之后新消息的粗估。
//   历史被改过（清理、压缩、从库里恢复）就没有可信的真实用量，整段按粗估。
//   报的用量不到粗估的一半也不信（多半没算缓存命中的部分），按粗估。
//
// 图片不等门槛：每轮结束只留最近 8 张原图，更早的换成一句说明。
//
// 超门槛时依次：
//   1. 较早轮次的工具结果换成一句说明（不调模型；查询类工具可以重新调用）
//   2. 还超：较早的轮次交给模型写成摘要，最近约 2 万 token 原样保留（chat-compaction.ts 在后台做）
//   3. 摘要写不成：退回机械摘要（每轮一行）
// ══════════════════════════════════════════════

import { createUserMessage, getMessageText, isAssistantMessage, isHumanTurn } from './types'
import type { AssistantMessage, Message, UserMessage } from './types'

/** 当轮实时背景附在主人这句话前面；历史里存不带背景的原话，前缀才能跨轮不变 */
export function withSystemReminder(text: string, reminder: string): string {
  if (!reminder.trim()) return text
  return `<system-reminder>\n以下是这条消息发出时系统自动附上的实时背景，不是主人说的话：\n\n${reminder}\n</system-reminder>\n\n${text}`
}

// ── 粗估 ──

/** 一张图大约的 token（千问 / Claude 的 1024² 图都在 1300~1600） */
const IMAGE_TOKENS = 1600
/** 每条消息的格式开销 */
const MESSAGE_OVERHEAD_TOKENS = 4

/** 中日韩文字一字约一 token，其余约 3.5 个字符一 token。偏保守：宁可早压，不能超窗口 */
export function roughTokens(text: string): number {
  let wide = 0
  let narrow = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) >= 0x2e80) wide += 1
    else narrow += 1
  }
  return Math.ceil(wide + narrow / 3.5)
}

const roughCache = new WeakMap<Message, number>()

function messageRoughTokens(m: Message): number {
  const cached = roughCache.get(m)
  if (cached !== undefined) return cached
  let n = 0
  if (m.type === 'user') {
    const content = m.message.content
    if (typeof content === 'string') n = roughTokens(content)
    else for (const b of content) n += b.type === 'image' ? IMAGE_TOKENS : b.type === 'text' ? roughTokens(b.text) : 0
  } else if (m.type === 'assistant') {
    for (const b of m.message.content) {
      if (b.type === 'text') n += roughTokens(b.text)
      else if (b.type === 'tool_use') n += roughTokens(b.name + JSON.stringify(b.input))
    }
  }
  if (m.type !== 'system') n += MESSAGE_OVERHEAD_TOKENS
  roughCache.set(m, n)
  return n
}

export function roughMessagesTokens(messages: readonly Message[]): number {
  let n = 0
  for (const m of messages) n += messageRoughTokens(m)
  return n
}

function realUsage(m: AssistantMessage): number {
  const u = m.message.usage
  return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + u.output_tokens
}

/** 报的用量不到同一段粗估的这个比例就不信它（粗估偏保守，正常情况下真实用量不会低这么多） */
const MIN_TRUSTED_USAGE_RATIO = 0.5

/**
 * 这段历史发出去大约多少 token。
 * overheadTokens：系统提示词 + 工具定义的粗估，只在没有真实用量时加（真实用量里已经含了）。
 */
export function estimateContextTokens(messages: readonly Message[], overheadTokens = 0): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isAssistantMessage(m) && m.message.usage.input_tokens > 0) {
      const later = roughMessagesTokens(messages.slice(i + 1))
      const real = realUsage(m)
      // 接口报的输入不含缓存命中的部分（Anthropic 的 input_tokens），或者中转没报全：按粗估，免得一直不压
      const rough = overheadTokens + roughMessagesTokens(messages.slice(0, i + 1))
      return (real >= rough * MIN_TRUSTED_USAGE_RATIO ? real : rough) + later
    }
  }
  return overheadTokens + roughMessagesTokens(messages)
}

/** 历史改过之后，旧的真实用量不再对应现在的前缀：清掉，改用粗估 */
function dropUsage(messages: readonly Message[]): Message[] {
  return messages.map((m) => {
    if (!isAssistantMessage(m) || m.message.usage.input_tokens === 0) return m
    return { ...m, message: { ...m.message, usage: { input_tokens: 0, output_tokens: 0 } } }
  })
}

// ── 门槛 ──

export interface ContextBudget {
  /** 超过就压缩（回复结束后在后台做） */
  readonly trigger: number
  /** 超过就不能发，必须先压完 */
  readonly hardLimit: number
  /** 写摘要时原样保留的最近部分 */
  readonly keepRecent: number
}

/** 模型库里和门槛有关的字段（desktop / mobile 的 ModelDef 都有） */
export interface ModelWindowInfo {
  readonly context_window: number | null
  readonly pricing?: readonly { readonly tier_min_tokens: number; readonly tier_max_tokens: number | null }[]
}

/** 和请求里的 max_tokens 一致 */
const OUTPUT_RESERVE = 8_000
/** 离窗口留的余量（Claude Code 的自动压缩缓冲） */
const WINDOW_MARGIN = 13_000
/**
 * 质量上限：长上下文实测有效长度多在 8K～32K，各家默认门槛 10 万～20 万。
 * 陪伴聊天轮数多、每轮都把整段历史再发一遍，取 6.4 万：压完约 3 万，够放下最近二十来轮原话。
 */
const QUALITY_CAP = 64_000
/** 模型库里没有窗口信息时按 12.8 万算 */
const DEFAULT_WINDOW = 128_000
/** 价格阶梯的第一档比这还小（如 qwen3.7-flash 的 3.2 万）就不迁就它，否则压得太勤，丢的比省的多 */
const MIN_TIER_TO_RESPECT = 48_000
/** 原样保留的最近部分（opencode 1.5 万、Cline / Codex 2 万） */
const KEEP_RECENT = 20_000

export function contextBudget(model?: ModelWindowInfo | null): ContextBudget {
  const window = model?.context_window && model.context_window > 0 ? model.context_window : DEFAULT_WINDOW
  const usable = window - OUTPUT_RESERVE
  // 窗口很小的模型留不出 1.3 万余量：至少用到可用部分的六成
  let trigger = Math.min(Math.max(usable - WINDOW_MARGIN, Math.floor(usable * 0.6)), QUALITY_CAP)
  // 阶梯按单次请求的输入总量计价：跨过第一档，整次请求都按贵的那档算
  const tiers = [...(model?.pricing ?? [])].sort((a, b) => a.tier_min_tokens - b.tier_min_tokens)
  const firstTierMax = tiers.length > 1 ? tiers[0].tier_max_tokens : null
  if (firstTierMax && firstTierMax >= MIN_TIER_TO_RESPECT) trigger = Math.min(trigger, Math.floor(firstTierMax * 0.9))
  return {
    trigger,
    hardLimit: Math.max(trigger, usable - 2_000),
    keepRecent: Math.min(KEEP_RECENT, Math.floor(trigger * 0.35)),
  }
}

// ── 工具结果 ──

/** 单条工具结果的上限：再大就只留头尾（Gemini CLI 4 万字符） */
const TOOL_RESULT_MAX_CHARS = 40_000

export function capToolResult(result: string): string {
  if (result.length <= TOOL_RESULT_MAX_CHARS) return result
  const head = result.slice(0, Math.floor(TOOL_RESULT_MAX_CHARS * 0.75))
  const tail = result.slice(-Math.floor(TOOL_RESULT_MAX_CHARS * 0.2))
  const omitted = result.length - head.length - tail.length
  return `${head}\n\n……（中间约 ${omitted} 字太长，没有放进来；要看这部分就缩小查询范围再调一次）……\n\n${tail}`
}

/** 最近几轮的工具结果不动：正在聊的事可能还要用 */
const KEEP_TOOL_TURNS = 3
/** 本来就短的结果不清，清了也省不了多少 */
const CLEAR_MIN_CHARS = 400
const CLEARED_PREFIX = '[这条较早的工具结果已清理'

function clearedNote(chars: number): string {
  return `${CLEARED_PREFIX}（原文约 ${chars} 字）。需要时重新调用这个工具。]`
}

/** 按主人说的话切成轮次；第一句之前的（摘要）单独成一组放在最前 */
function splitTurns(messages: readonly Message[]): Message[][] {
  const turns: Message[][] = []
  let current: Message[] = []
  for (const m of messages) {
    if (isHumanTurn(m) && current.length > 0) {
      turns.push(current)
      current = []
    }
    current.push(m)
  }
  if (current.length > 0) turns.push(current)
  return turns
}

/** 第一步（不调模型）：较早轮次的长工具结果换成一句说明。工具调用本身还在，模型知道查过什么 */
export function clearOldToolResults(messages: readonly Message[]): { messages: Message[]; cleared: number } {
  const turns = splitTurns(messages)
  const protectFrom = turns.length - KEEP_TOOL_TURNS
  let cleared = 0
  const out = turns.flatMap((turn, i) => {
    if (i >= protectFrom) return turn
    return turn.map((m) => {
      if (m.type !== 'user' || m.toolUseResult === undefined) return m
      const result = m.toolUseResult
      if (result.length < CLEAR_MIN_CHARS || result.startsWith(CLEARED_PREFIX)) return m
      cleared += 1
      const note = clearedNote(result.length)
      return { ...m, message: { ...m.message, content: note }, toolUseResult: note }
    })
  })
  return { messages: cleared > 0 ? dropUsage(out) : out, cleared }
}

// ── 图片 ──

/**
 * 历史里最多留几张原图，和重新打开会话时带回的张数一样（chat-images.ts MAX_RESTORED_IMAGES）。
 * 原图每次请求都要再发一遍，不按门槛等：每轮回复结束都只留最近这几张，请求体和内存里的 base64 才有上限。
 */
const MAX_HISTORY_IMAGES = 8

/** 较早消息里的图片换成一句说明（和重新打开会话时没带回的图同一句话）。从最新的往回数，一条消息的图不拆开 */
export function dropOldImages(messages: readonly Message[]): { messages: Message[]; dropped: number } {
  const out = [...messages]
  let kept = 0
  let dropped = 0
  let full = false
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.type !== 'user' || typeof m.message.content === 'string') continue
    const images = m.message.content.filter((b) => b.type === 'image').length
    if (images === 0) continue
    if (!full && kept + images <= MAX_HISTORY_IMAGES) {
      kept += images
      continue
    }
    full = true
    const text = m.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const note = `（主人发过 ${images} 张图片，已经不在上下文里）`
    out[i] = { ...m, message: { ...m.message, content: text ? `${note}\n${text}` : note } }
    dropped += images
  }
  return { messages: dropped > 0 ? dropUsage(out) : out, dropped }
}

/** 回复出错时 query-loop 会追加界面用的 system 消息，不留在历史里 */
export function withoutSystemMessages(messages: readonly Message[]): Message[] {
  return messages.filter((m) => m.type !== 'system')
}

// ── 摘要 ──

export interface CompactionPlan {
  /** 要换成摘要的较早部分（开头可能是上一份摘要） */
  readonly head: Message[]
  /** 原样保留的最近几轮，第一条是主人说的话 */
  readonly tail: Message[]
}

/** 从后往前留整轮，留到 keepRecent 为止（至少留最后一轮）；工具调用和它的结果不会被拆开 */
export function planCompaction(messages: readonly Message[], keepRecent: number): CompactionPlan | null {
  const turns = splitTurns(withoutSystemMessages(messages))
  let keepFrom = turns.length
  let kept = 0
  while (keepFrom > 0) {
    const turn = turns[keepFrom - 1]
    if (!isHumanTurn(turn[0])) break
    const size = roughMessagesTokens(turn)
    if (keepFrom < turns.length && kept + size > keepRecent) break
    kept += size
    keepFrom -= 1
  }
  const head = turns.slice(0, keepFrom).flat()
  const tail = turns.slice(keepFrom).flat()
  // 要压的部分里没有主人说的话（只有上一份摘要），没东西可压
  if (tail.length === 0 || !head.some(isHumanTurn)) return null
  return { head, tail }
}

/**
 * 交给模型写摘要的部分最多约 maxTokens：更早的先压成机械摘要放在最前面，当作旧摘要让模型接着更新。
 * 平时要压的开头本来就不到门槛，用不上；这次改动之前的老会话没有摘要行，恢复后整段都在，第一次压缩时靠它不超窗口。
 */
export function fitSummaryInput(head: readonly Message[], maxTokens: number): Message[] {
  if (roughMessagesTokens(head) <= maxTokens) return [...head]
  const turns = splitTurns(head)
  // 先留出机械摘要最大可能的体量（截短的旧摘要 + 最多 40 行，按一字一 token 算），剩下的放最新的整轮
  const fallbackMax = FALLBACK_PREVIOUS_MAX_CHARS + FALLBACK_MAX_LINES * (FALLBACK_LINE_CHARS * 2 + 40)
  const budget = Math.max(0, maxTokens - fallbackMax)
  let keepFrom = turns.length
  let kept = 0
  while (keepFrom > 0) {
    const turn = turns[keepFrom - 1]
    if (!isHumanTurn(turn[0])) break
    const size = roughMessagesTokens(turn)
    if (kept + size > budget) break
    kept += size
    keepFrom -= 1
  }
  const older = turns.slice(0, keepFrom).flat()
  if (!older.some(isHumanTurn)) return [...head]
  const last = older[older.length - 1]
  return [compactSummaryMessage(fallbackSummaryText(older), { timestamp: last.timestamp }), ...turns.slice(keepFrom).flat()]
}

const SUMMARY_OPEN = '<summary>'
const SUMMARY_CLOSE = '</summary>'

/** 换掉较早轮次的那条摘要消息。不嵌套 system-reminder，下次压缩能整份取出来更新 */
export function compactSummaryMessage(summaryText: string, opts: { timestamp?: string } = {}): UserMessage {
  const content = `前面的对话太长，已经整理成下面这份摘要；摘要之后是最近几轮的原话。摘要里的事都发生过，接着聊就行，不用提起这份摘要。\n\n${SUMMARY_OPEN}\n${summaryText.trim()}\n${SUMMARY_CLOSE}`
  return { ...createUserMessage(content, { isMeta: true, timestamp: opts.timestamp }), isCompactSummary: true }
}

/** 取出摘要消息里的摘要正文 */
export function summaryTextOf(m: Message): string | null {
  if (m.type !== 'user' || !m.isCompactSummary) return null
  const content = m.message.content
  const text = typeof content === 'string' ? content : content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  const start = text.indexOf(SUMMARY_OPEN)
  const end = text.lastIndexOf(SUMMARY_CLOSE)
  if (start < 0 || end <= start) return text.trim()
  return text.slice(start + SUMMARY_OPEN.length, end).trim()
}

export interface CompactionResult {
  /** 被换掉的那段消息的 uuid：历史开头和它一致才套用（后台写摘要期间历史可能已经变了） */
  readonly replacedUuids: readonly string[]
  readonly summary: UserMessage
  readonly summaryText: string
  /** 摘要行的时间 = 保留段第一条的时间 − 1 毫秒。库里比它早的行都已经在摘要里 */
  readonly summaryTimestamp: string
  /** model：模型写的；fallback：机械摘要（模型没写成时） */
  readonly kind: 'model' | 'fallback'
  readonly beforeTokens: number
}

export function makeCompactionResult(
  plan: CompactionPlan,
  summaryText: string,
  kind: CompactionResult['kind'],
  beforeTokens: number,
): CompactionResult {
  const boundaryMs = new Date(plan.tail[0].timestamp).getTime()
  const summaryTimestamp = new Date((Number.isFinite(boundaryMs) ? boundaryMs : Date.now()) - 1).toISOString()
  return {
    replacedUuids: plan.head.map((m) => m.uuid),
    summary: compactSummaryMessage(summaryText, { timestamp: summaryTimestamp }),
    summaryText,
    summaryTimestamp,
    kind,
    beforeTokens,
  }
}

/** 把摘要套到历史上；开头对不上（会话换了、历史重建过）返回 null。已经套过的原样返回 */
export function applyCompaction(history: readonly Message[], result: CompactionResult): Message[] | null {
  if (history[0]?.uuid === result.summary.uuid) return [...history]
  const n = result.replacedUuids.length
  if (history.length < n) return null
  for (let i = 0; i < n; i++) {
    if (history[i].uuid !== result.replacedUuids[i]) return null
  }
  return dropUsage([result.summary, ...history.slice(n)])
}

// ── 机械摘要（模型没写成时兜底） ──

const FALLBACK_LINE_CHARS = 120
const FALLBACK_MAX_LINES = 40
const FALLBACK_PREVIOUS_MAX_CHARS = 6_000
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g

function clip(text: string, n: number): string {
  const t = text.replace(REMINDER_RE, '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function userTextOf(m: UserMessage): string {
  const content = m.message.content
  if (typeof content === 'string') return content
  const images = content.filter((b) => b.type === 'image').length
  const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return images > 0 ? `[${images} 张图片] ${text}` : text
}

/** 每轮一行「主人：… → 回应：…」。上一份摘要整份留在最前面，不截断 */
export function fallbackSummaryText(head: readonly Message[]): string {
  const parts: string[] = []
  const previous = head[0] ? summaryTextOf(head[0]) : null
  // 连着几次都退回机械摘要时，上一份会越滚越长：只留前面一截
  if (previous) parts.push(previous.length > FALLBACK_PREVIOUS_MAX_CHARS ? `${previous.slice(0, FALLBACK_PREVIOUS_MAX_CHARS)}…` : previous)
  const lines: string[] = []
  for (const turn of splitTurns(head)) {
    const first = turn[0]
    if (!isHumanTurn(first)) continue
    const tools = new Set<string>()
    let reply = ''
    for (const m of turn) {
      if (!isAssistantMessage(m)) continue
      for (const b of m.message.content) if (b.type === 'tool_use') tools.add(b.name)
      const text = getMessageText(m).trim()
      if (text) reply = text
    }
    const toolNote = tools.size > 0 ? `（查了 ${[...tools].join('、')}）` : ''
    lines.push(`- 主人：${clip(userTextOf(first), FALLBACK_LINE_CHARS)} → 回应${toolNote}：${clip(reply, FALLBACK_LINE_CHARS) || '（无）'}`)
  }
  const dropped = lines.length - FALLBACK_MAX_LINES
  if (dropped > 0) lines.splice(0, dropped, `- （更早的 ${dropped} 轮略）`)
  if (lines.length > 0) parts.push(`## 之后的对话（简略记录，细节没留下）\n${lines.join('\n')}`)
  return parts.join('\n\n')
}
