// ══════════════════════════════════════════════
// 对话上下文窗口 —— 借鉴 Claude Code 的上下文管理（attachments / compact / microcompact）
//
// 1. 前缀稳定：系统提示词只放不变的部分；每轮变化的实时背景（时间、最近活动、正在看的卡片）
//    包成 <system-reminder> 只附在「本轮」用户消息上，存进历史时剥掉。
//    百炼隐式缓存按前缀命中（qwen3.8-max 命中价约为原价 1/8），前缀每轮都变就一次也命中不了。
// 2. 保留工具链：工具调用与结果留在历史里，下一轮还能引用刚查到的数据。
// 3. 分批压缩而非逐轮滑动：超过高水位才一次性按整轮裁到低水位（不拆散 tool_use / tool_result），
//    两次压缩之间前缀不变、缓存持续命中；逐轮 slice(-N) 会让前缀每轮都变。
// 4. 折叠旧工具结果：只在压缩时把较早轮次的长工具结果折叠成开头一段。
// ══════════════════════════════════════════════

import { createUserMessage, isHumanTurn } from './types'
import type { Message, UserMessage, ContentBlock } from './types'

/** 超过这个体量才压缩（按字符粗估；中文约 1 字 ≈ 1 token） */
export const HIGH_WATER_CHARS = 48_000
/** 压缩后保留的目标体量 */
export const LOW_WATER_CHARS = 24_000
/** 无论多长，至少保留最近几轮完整对话 */
const MIN_KEEP_TURNS = 2
/** 最近几轮的工具结果保持原样，更早的折叠 */
const FULL_TOOL_TURNS = 2
const TOOL_FOLD_CHARS = 600
const TOOL_FOLD_KEEP = 300
const SUMMARY_LINE_CHARS = 60
const SUMMARY_MAX_LINES = 24
/**
 * 一张图按多少字符算。实际约 1000~2500 token，这里故意算高：图片按原样留在历史里每轮都要重发，
 * 算高了攒到七八张就会触发压缩，请求体和内存里的 base64 才有上限
 */
const IMAGE_CHARS = 6000

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

// ── 本轮实时背景 ──

/** 把实时背景附在本轮用户消息前面（只发给模型，不进历史） */
export function withSystemReminder(text: string, reminder: string): string {
  if (!reminder.trim()) return text
  return `${REMINDER_OPEN}\n以下是这条消息发出时系统自动附上的实时背景，不是主人说的话：\n\n${reminder.trim()}\n${REMINDER_CLOSE}\n\n${text}`
}

// ── 体量估算 ──

function blockChars(b: ContentBlock): number {
  if (b.type === 'text') return b.text.length
  if (b.type === 'image') return IMAGE_CHARS
  if (b.type === 'tool_use') return b.name.length + JSON.stringify(b.input).length
  return b.content.length
}

function messageChars(m: Message): number {
  if (m.type === 'system') return 0
  if (m.type === 'user' && m.toolUseResult !== undefined) return m.toolUseResult.length
  const content = m.message.content
  return typeof content === 'string' ? content.length : content.reduce((n, b) => n + blockChars(b), 0)
}

export function estimateChars(messages: readonly Message[]): number {
  return messages.reduce((n, m) => n + messageChars(m), 0)
}

// ── 按轮切分：一轮从一条真实人类消息开始，包含其后的助手回复、工具调用与工具结果 ──

function splitTurns(messages: readonly Message[]): Message[][] {
  const turns: Message[][] = []
  for (const m of messages) {
    if (m.type === 'system') continue // UI 专用，不进历史
    if (isHumanTurn(m) || turns.length === 0) turns.push([m])
    else turns[turns.length - 1].push(m)
  }
  return turns
}

// ── 压缩 ──

function foldToolResult(m: UserMessage): UserMessage {
  const result = m.toolUseResult ?? ''
  if (result.length <= TOOL_FOLD_CHARS) return m
  const folded = `${result.slice(0, TOOL_FOLD_KEEP)}\n…（较早的工具结果已折叠，需要细节就重新调用工具）`
  return { ...m, toolUseResult: folded, message: { ...m.message, content: folded } }
}

function firstText(m: Message): string {
  if (m.type === 'system') return ''
  const content = m.message.content
  const text = typeof content === 'string'
    ? content
    : content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[图片]' : '')).join('')
  return text.replace(/\s+/g, ' ').trim()
}

function clip(s: string): string {
  return s.length > SUMMARY_LINE_CHARS ? `${s.slice(0, SUMMARY_LINE_CHARS)}…` : s
}

/** 被裁掉的轮次 → 一条要点摘要（每轮：主人说了什么 / Fairy 最后怎么答）；上一次的摘要原样并入 */
function summarizeDropped(turns: readonly Message[][]): UserMessage | null {
  const lines: string[] = []
  for (const turn of turns) {
    const head = turn[0]
    if (head.type === 'user' && head.isCompactSummary) {
      lines.push(firstText(head))
      continue
    }
    const said = clip(firstText(head))
    const lastReply = [...turn].reverse().find((m) => m.type === 'assistant' && firstText(m))
    const reply = lastReply ? clip(firstText(lastReply)) : ''
    if (said) lines.push(reply ? `- 主人：${said}　→ 回应：${reply}` : `- 主人：${said}`)
  }
  if (lines.length === 0) return null
  const body = lines.slice(-SUMMARY_MAX_LINES).join('\n')
  const summary = createUserMessage(
    `${REMINDER_OPEN}\n更早的对话已压缩，以下是要点（按时间顺序）：\n${body}\n${REMINDER_CLOSE}`,
    { isMeta: true },
  )
  return { ...summary, isCompactSummary: true }
}

/**
 * 体量没超过高水位时内容原样返回（只去掉 UI 专用的 system 消息，前缀不变）；
 * 超过时按整轮从旧往新裁到低水位，被裁部分变成一条摘要，较早轮次的长工具结果折叠。
 */
export function compactHistory(messages: readonly Message[]): Message[] {
  const clean = messages.filter((m) => m.type !== 'system')
  if (estimateChars(clean) <= HIGH_WATER_CHARS) return clean

  const turns = splitTurns(clean)
  let keepFrom = turns.length
  let kept = 0
  while (keepFrom > 0) {
    const size = estimateChars(turns[keepFrom - 1])
    const mustKeep = turns.length - keepFrom < MIN_KEEP_TURNS
    if (!mustKeep && kept + size > LOW_WATER_CHARS) break
    kept += size
    keepFrom--
  }

  const keptTurns = turns.slice(keepFrom).map((turn, i, all) =>
    i < all.length - FULL_TOOL_TURNS
      ? turn.map((m) => (m.type === 'user' && m.toolUseResult !== undefined ? foldToolResult(m) : m))
      : turn,
  )
  const summary = summarizeDropped(turns.slice(0, keepFrom))
  return [...(summary ? [summary] : []), ...keptTurns.flat()]
}
