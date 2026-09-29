// ══════════════════════════════════════════════
// 语音识别提示：即时热词 + 最近几轮对话上下文
// 借鉴 Claude Code services/voiceKeyterms.ts：把领域词、项目名告诉识别服务，免得听错；
// 百炼流式识别还能吃对话上下文（最近 5 轮），模型知道在聊什么，同音词更不容易认错。
// ══════════════════════════════════════════════

import { isAssistantMessage, isHumanTurn, getMessageText } from '../llm/types'
import type { Message } from '../llm/types'

export interface AsrContextTurn {
  readonly user: string
  readonly assistant: string
}

export interface AsrHints {
  readonly vocabulary: readonly string[]
  readonly context: readonly AsrContextTurn[]
}

/** 产品里常被听错的词（人不会照字面念的缩写就别放） */
const PRODUCT_TERMS: readonly string[] = [
  'Solevup', 'Fairy', '洪流域', '锚点', '锚点域', '锚点句', '协议志', '动机云', '想法卡', '语境卡', '表征', 'B站', 'UP主',
]
const MAX_TERM_CHARS = 12
const MAX_TERMS = 60
const MAX_CONTEXT_TURNS = 5
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g

export interface VocabularySources {
  readonly agentName?: string
  readonly goalTitles?: readonly string[]
  readonly appNames?: readonly string[]
}

/** 去重、去空、只留短词（热词是词不是句子），上限 MAX_TERMS */
export function buildAsrVocabulary(sources: VocabularySources): string[] {
  const candidates = [
    ...(sources.agentName ? [sources.agentName] : []),
    ...PRODUCT_TERMS,
    ...(sources.goalTitles ?? []),
    ...(sources.appNames ?? []),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of candidates) {
    const term = raw.trim()
    const key = term.toLowerCase()
    if (!term || term.length > MAX_TERM_CHARS || seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= MAX_TERMS) break
  }
  return out
}

function userText(m: Message): string {
  if (m.type !== 'user') return ''
  const content = m.message.content
  const text = typeof content === 'string' ? content : content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return text.replace(REMINDER_RE, '').trim()
}

/** 最近几轮「主人说的 → Fairy 最后怎么答的」，给识别服务当上下文 */
export function buildAsrContext(history: readonly Message[]): AsrContextTurn[] {
  const turns: AsrContextTurn[] = []
  let current: { user: string; assistant: string } | null = null
  for (const m of history) {
    if (isHumanTurn(m) && !m.isCompactSummary) {
      if (current?.user) turns.push(current)
      current = { user: userText(m), assistant: '' }
    } else if (current && isAssistantMessage(m)) {
      const reply = getMessageText(m).trim()
      if (reply) current.assistant = reply
    }
  }
  if (current?.user) turns.push(current)
  return turns.slice(-MAX_CONTEXT_TURNS)
}
