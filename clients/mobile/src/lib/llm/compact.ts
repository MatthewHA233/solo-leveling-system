// ══════════════════════════════════════════════
// 让模型写压缩摘要。desktop 与 mobile 两份逐字一致，改要两端一起改
//   和正常聊天同一个模型、同样的系统提示词和工具定义，末尾追加整理请求。
//   工具定义要带上（换掉会让缓存前缀对不上），但这次不执行工具，模型调了也只取文字。
//
// 两种发法（照 Claude Code compact.ts：压缩请求借聊天的缓存，自己不往缓存里写）：
//   带完整历史（传 keptTail）：缓存还热的时候用。整段历史原样在前面，和上一次聊天请求的前缀一模一样，
//     按读取价算；提示词里说明只整理到哪句话之前。断点标在共用前缀的末尾（cacheMark: prefix）。
//   只带要整理的部分（不传 keptTail）：缓存已经凉了、或者整段太长放不下的时候用。
//     这段历史马上要被摘要换掉，不值得付写入价，消息里不标断点（cacheMark: system）。
// ══════════════════════════════════════════════

import { compactionPrompt } from '../ai/prompt-templates'
import { queryModel, type QueryOptions } from './api'
import { summaryTextOf } from './context-window'
import { createUserMessage, type Message } from './types'

/** 推理模型会先花掉一部分输出预算（Cline 的教训：4096 太小，返回空摘要） */
const SUMMARY_MAX_TOKENS = 8_000
/** 后台请求卡住时放弃，免得之后一直等它 */
const SUMMARY_TIMEOUT_MS = 120_000
const MIN_SUMMARY_CHARS = 40
/** 提示词里引用保留部分第一句话的开头，够模型认出是哪句就行 */
const KEPT_FROM_CHARS = 40

/** 去掉 <analysis> 草稿，取 <summary> 里的正文；没写标签就用整段 */
export function parseSummary(raw: string): string {
  let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
  const unclosed = text.indexOf('<analysis>')
  if (unclosed >= 0) text = text.slice(0, unclosed)
  const match = text.match(/<summary>([\s\S]*?)(?:<\/summary>|$)/)
  return (match ? match[1] : text).trim()
}

/** 保留部分第一句话的开头（去掉拼在前面的实时背景）；没有文字返回空字符串 */
function keptFromText(first: Message | undefined): string {
  if (!first || first.type !== 'user') return ''
  const content = first.message.content
  const text = typeof content === 'string' ? content : content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  const plain = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').replace(/\s+/g, ' ').trim()
  return plain.length > KEPT_FROM_CHARS ? plain.slice(0, KEPT_FROM_CHARS) : plain
}

/**
 * head：要整理成摘要的部分。keptTail：之后原样保留的最近几轮，传了就把它接在 head 后面一起发（见文件头）。
 */
export async function summarizeForCompaction(
  head: readonly Message[],
  options: QueryOptions,
  agentCallUser: string,
  keptTail?: readonly Message[],
): Promise<string> {
  const hasPrevious = head[0] ? summaryTextOf(head[0]) !== null : false
  const prompt = compactionPrompt(hasPrevious, agentCallUser, keptTail ? keptFromText(keptTail[0]) : undefined)
  const request: Message[] = [...head, ...(keptTail ?? []), createUserMessage(prompt, { isMeta: true })]
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), SUMMARY_TIMEOUT_MS)
  let raw = ''
  try {
    const requestOptions: QueryOptions = {
      ...options,
      maxTokens: SUMMARY_MAX_TOKENS,
      signal: timeout.signal,
      cacheMark: keptTail ? 'prefix' : 'system',
    }
    for await (const chunk of queryModel(request, requestOptions)) {
      if (chunk.type === 'textDelta') raw += chunk.delta
      else if (chunk.type === 'error') throw new Error(chunk.message)
    }
  } finally {
    clearTimeout(timer)
  }
  if (timeout.signal.aborted) throw new Error('写摘要超时')
  const summary = parseSummary(raw)
  if (summary.length < MIN_SUMMARY_CHARS) throw new Error(raw.trim() ? '摘要格式不对' : '模型没有返回摘要')
  return summary
}
