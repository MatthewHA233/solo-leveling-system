// ══════════════════════════════════════════════
// 界面上的工具调用：聊天里每次调用单独一行，点开看参数和结果，可以复制。
// 这里只管数据和文字，desktop 与 mobile 两份逐字一致，改要两端一起改。
// 样子各画各的：桌面端 components/ToolCallRow.tsx，手机端 components/fairy/ToolCallRow.tsx
// ══════════════════════════════════════════════

export interface ToolCallView {
  readonly id: string
  readonly name: string
  /** 参数，模型给的 JSON 文本原样 */
  readonly arguments: string
  /** 结果；还在跑时没有 */
  readonly result?: string
  /** 开始的时刻（毫秒时间戳）：这次运行里发起的调用才有，用来算耗时 */
  readonly startedAt?: number
  /** 耗时（毫秒）；从库里恢复的没有 */
  readonly durationMs?: number
}

export type ToolCallStatus = 'running' | 'done' | 'failed'

/** 界面上留的结果上限：太长的渲染和复制都没意义，要全文让 Fairy 重新查 */
const VIEW_RESULT_MAX_CHARS = 4_000
const SUMMARY_VALUE_MAX_CHARS = 40
const SUMMARY_MAX_CHARS = 200

// 工具的中文名：聊天里那一行显示这个，函数名留在点开后的详情和复制内容里。
// 新加工具时在这里补一行；没补的显示函数名
const TOOL_LABELS: Record<string, string> = {
  GetAppUsage: '查应用使用记录',
  GetActivityTags: '查活动标签',
  GetComputerStatus: '查电脑状态',
  GetBiliHistory: '查 B 站观看历史',
  GetThoughtCards: '查想法卡',
  CreateThoughtCard: '新建想法卡',
  UpdateThoughtCard: '修改想法卡',
  ListBrokenThoughtCards: '列出断链的想法卡',
  RepairBrokenThoughtCard: '修复断链的想法卡',
  GetVideoTranscript: '读视频转录',
  GetAnchors: '查锚点句',
  UpdateAnchor: '修改锚点句',
  Read: '读文件',
  Write: '写文件',
  Edit: '编辑文件',
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

// 工具没跑成时结果的开头：查询循环和 executeAgentTool 写的那几种
const FAILED_RESULT = /^(未知工具|工具执行失败|工具执行错误|已被主人打断)/

export function startToolCall(id: string, name: string, args: string, now: number = Date.now()): ToolCallView {
  return { id, name, arguments: args, startedAt: now }
}

/** 调用结束：记下结果（过长截断）和耗时 */
export function finishToolCall(call: ToolCallView, result: string, now: number = Date.now()): ToolCallView {
  const clipped = result.length > VIEW_RESULT_MAX_CHARS
    ? `${result.slice(0, VIEW_RESULT_MAX_CHARS)}\n……（只显示前 ${VIEW_RESULT_MAX_CHARS} 字，全文约 ${result.length} 字）`
    : result
  return {
    ...call,
    result: clipped,
    ...(call.startedAt !== undefined ? { durationMs: Math.max(0, now - call.startedAt) } : {}),
  }
}

export function toolCallStatus(call: ToolCallView): ToolCallStatus {
  if (call.result === undefined) return 'running'
  return FAILED_RESULT.test(call.result) ? 'failed' : 'done'
}

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args || '{}')
  } catch {
    return undefined
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function summaryValue(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : JSON.stringify(value) ?? ''
  return clip(text, SUMMARY_VALUE_MAX_CHARS)
}

/** 折叠时那一行里的参数摘要：`键: 值` 用 · 隔开，值太长截断；参数不是对象就压成一行 */
export function toolArgsSummary(args: string): string {
  const parsed = parseArgs(args)
  if (parsed === undefined) return clip(args.replace(/\s+/g, ' ').trim(), SUMMARY_MAX_CHARS)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return clip(summaryValue(parsed), SUMMARY_MAX_CHARS)
  const parts = Object.entries(parsed).map(([key, value]) => `${key}: ${summaryValue(value)}`)
  return clip(parts.join(' · '), SUMMARY_MAX_CHARS)
}

/** 点开后显示的参数：能解析就排成带缩进的 JSON，否则原样 */
export function prettyToolArgs(args: string): string {
  const parsed = parseArgs(args)
  return parsed === undefined ? args : JSON.stringify(parsed, null, 2)
}

/** 耗时的写法：不到 1 秒写毫秒，否则写秒（一位小数） */
export function formatToolDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 不画工具行的地方用的一行文字（消息的 content） */
export function toolCallLine(call: ToolCallView): string {
  const parsed = parseArgs(call.arguments)
  return `⚙ ${call.name}(${parsed === undefined ? call.arguments : JSON.stringify(parsed)})`
}

/** 「复制全部」的内容 */
export function toolCallCopyText(call: ToolCallView): string {
  const label = toolLabel(call.name)
  const lines = [`工具：${label === call.name ? label : `${label}（${call.name}）`}`, '参数：', prettyToolArgs(call.arguments)]
  if (call.durationMs !== undefined) lines.push(`耗时：${formatToolDuration(call.durationMs)}`)
  lines.push('结果：', call.result ?? '（还在运行）')
  return lines.join('\n')
}
