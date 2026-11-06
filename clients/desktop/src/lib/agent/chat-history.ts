// ══════════════════════════════════════════════
// 库里的聊天行 ↔ 发给模型的历史。desktop 与 mobile 两份逐字一致，改要两端一起改
//
// chat_messages 里除了主人和 Fairy 的话，还有两种 role='tool' 的行（旧版本读到 tool 行一律跳过，不受影响）：
//   · compact_summary：压缩摘要。行的时间 = 保留段第一条的时间 − 1 毫秒，比它早的行都已经在摘要里
//   · tool_trace：一轮里的工具调用和结果（JSON），时间 = 主人那句 + 1 毫秒。切会话、重启后工具记录还在
// 两种行都跟着聊天增量同步到另一台设备。
// ══════════════════════════════════════════════

import { compactSummaryMessage, type CompactionResult } from '../llm/context-window'
import {
  createAssistantMessage,
  createToolResultMessage,
  createToolUseMessage,
  createUserMessage,
  isAssistantMessage,
  type ImageBlock,
  type Message,
} from '../llm/types'
import type { SessionMessage } from './agent-memory'
import { describeImagesForModel, parseImageMarker } from './chat-images'

export const COMPACT_SUMMARY_ROW = 'compact_summary'
export const TOOL_TRACE_ROW = 'tool_trace'

/** 存进库的工具结果只留前面这些：库和同步都不背大块数据，要全文让模型重新查 */
const TRACE_RESULT_MAX_CHARS = 4_000

export function isCompactSummaryRow(m: SessionMessage): boolean {
  return m.role === 'tool' && m.name === COMPACT_SUMMARY_ROW
}

/** 聊天里那条压缩提示（点开能看摘要） */
export function compactNotice(kind: CompactionResult['kind'] = 'model'): string {
  return kind === 'model'
    ? '前面的对话已整理成摘要，之后带着摘要和最近几轮原话接着聊'
    : '前面的对话太长，摘要没写成，先压成了简略记录'
}

interface ToolTraceStep {
  readonly text?: string
  readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[]
  readonly results: readonly { readonly id: string; readonly result: string }[]
}

interface ToolTrace {
  readonly v: 1
  readonly steps: readonly ToolTraceStep[]
}

function rowBase(content: string, name: string, timestamp: string): SessionMessage {
  return { role: 'tool', content, toolCalls: null, toolCallId: null, name, timestamp }
}

function shiftMs(timestamp: string, deltaMs: number): string {
  const ms = new Date(timestamp).getTime()
  return new Date((Number.isFinite(ms) ? ms : Date.now()) + deltaMs).toISOString()
}

/** 压缩摘要的那一行（只存模型写的摘要；机械摘要不存，下次还能用原话重新压） */
export function compactSummaryRow(result: CompactionResult): SessionMessage {
  return rowBase(result.summaryText, COMPACT_SUMMARY_ROW, result.summaryTimestamp)
}

/**
 * 一轮的工具记录。turn 是主人那句之后模型和工具产生的消息（含最后的回复，回复本身另存一行）。
 * 没调工具返回 null。
 */
export function toolTraceRow(turn: readonly Message[], userTimestamp: string): SessionMessage | null {
  const steps: ToolTraceStep[] = []
  let current: { text?: string; calls: ToolTraceStep['calls'][number][]; results: ToolTraceStep['results'][number][] } | null = null
  for (const m of turn) {
    if (isAssistantMessage(m)) {
      const calls = m.message.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }] : [])
      if (calls.length === 0) continue
      const text = m.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
      current = { ...(text ? { text } : {}), calls, results: [] }
      steps.push(current)
    } else if (m.type === 'user' && m.toolUseResult !== undefined && current) {
      const full = m.toolUseResult
      const result = full.length > TRACE_RESULT_MAX_CHARS
        ? `${full.slice(0, TRACE_RESULT_MAX_CHARS)}\n……（恢复会话时只留了前 ${TRACE_RESULT_MAX_CHARS} 字，原文约 ${full.length} 字；要看全文重新调用这个工具）`
        : full
      current.results.push({ id: m.sourceToolCallId ?? 'unknown', result })
    }
  }
  if (steps.length === 0) return null
  const trace: ToolTrace = { v: 1, steps }
  return rowBase(JSON.stringify(trace), TOOL_TRACE_ROW, shiftMs(userTimestamp, 1))
}

function traceToMessages(row: SessionMessage): Message[] {
  let trace: ToolTrace
  try {
    trace = JSON.parse(row.content ?? '') as ToolTrace
  } catch {
    return []
  }
  const steps: readonly ToolTraceStep[] = Array.isArray(trace?.steps) ? trace.steps : []
  const out: Message[] = []
  for (const step of steps) {
    if (!step?.calls?.length) continue
    const calls = step.calls.map((c) => {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(c.arguments || '{}') as Record<string, unknown> } catch { /* 参数坏了就当没参数 */ }
      return { id: c.id, name: c.name, input }
    })
    out.push(createToolUseMessage(step.text ?? '', calls, { timestamp: row.timestamp }))
    // 每个调用都要有结果，否则接口报错
    for (const c of step.calls) {
      const result = step.results?.find((r) => r.id === c.id)?.result ?? '（没有记录到这次调用的结果）'
      out.push(createToolResultMessage(c.id, result, { timestamp: row.timestamp }))
    }
  }
  return out
}

/** 一段行转成历史：主人和 Fairy 的话 + 工具记录；摘要行跳过（同步进来的增量用这个） */
export function rowsToLLMMessages(
  rows: readonly SessionMessage[],
  images?: ReadonlyMap<string, ImageBlock>,
): Message[] {
  const out: Message[] = []
  for (const m of rows) {
    if (m.role === 'tool') {
      if (m.name === TOOL_TRACE_ROW) out.push(...traceToMessages(m))
      continue
    }
    const content = (m.content ?? '').trim()
    if (!content) continue
    if (m.role === 'user') {
      const blocks = parseImageMarker(content).ids.flatMap((id) => images?.get(id) ?? [])
      out.push(createUserMessage(describeImagesForModel(content, blocks.length), { images: blocks, timestamp: m.timestamp }))
    } else if (m.role === 'assistant') {
      out.push(createAssistantMessage(content, { timestamp: m.timestamp }))
    }
  }
  return out
}

/** 整个会话恢复成历史：从最新的一份摘要接着往后，摘要之前的行都已经在摘要里 */
export function restoreLLMHistory(
  rows: readonly SessionMessage[],
  images?: ReadonlyMap<string, ImageBlock>,
): Message[] {
  let start = 0
  let summary: SessionMessage | null = null
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isCompactSummaryRow(rows[i]) && (rows[i].content ?? '').trim()) {
      summary = rows[i]
      start = i + 1
      break
    }
  }
  const out = rowsToLLMMessages(rows.slice(start), images)
  return summary ? [compactSummaryMessage(summary.content ?? '', { timestamp: summary.timestamp }), ...out] : out
}
