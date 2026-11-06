// ══════════════════════════════════════════════
// 让模型写压缩摘要。desktop 与 mobile 两份逐字一致，改要两端一起改
//   和正常聊天同一个模型、同样的系统提示词和工具定义，末尾追加整理请求：前缀和上一轮一样，能吃缓存。
//   工具定义要带上（换掉会让缓存前缀对不上），但这次不执行工具，模型调了也只取文字。
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

/** 去掉 <analysis> 草稿，取 <summary> 里的正文；没写标签就用整段 */
export function parseSummary(raw: string): string {
  let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
  const unclosed = text.indexOf('<analysis>')
  if (unclosed >= 0) text = text.slice(0, unclosed)
  const match = text.match(/<summary>([\s\S]*?)(?:<\/summary>|$)/)
  return (match ? match[1] : text).trim()
}

export async function summarizeForCompaction(
  head: readonly Message[],
  options: QueryOptions,
  agentCallUser: string,
): Promise<string> {
  const hasPrevious = head[0] ? summaryTextOf(head[0]) !== null : false
  const request: Message[] = [...head, createUserMessage(compactionPrompt(hasPrevious, agentCallUser), { isMeta: true })]
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), SUMMARY_TIMEOUT_MS)
  let raw = ''
  try {
    for await (const chunk of queryModel(request, { ...options, maxTokens: SUMMARY_MAX_TOKENS, signal: timeout.signal })) {
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
