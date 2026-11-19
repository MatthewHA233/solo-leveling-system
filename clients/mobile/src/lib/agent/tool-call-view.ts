// ══════════════════════════════════════════════
// 界面上的工具调用：聊天里每次调用单独一行，点开看参数和结果，可以复制。
// 上下文整理留在聊天里的行也画成同样的一行（文件末尾）。
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
  FindVideoTranscript: '找视频转录',
  TranscribeVideos: '下载并转录视频',
  TranscribeProgress: '看转录进度',
  GetAnchors: '查锚点句',
  UpdateAnchor: '修改锚点句',
  Read: '读文件',
  Write: '写文件',
  Edit: '编辑文件',
  RecordActivity: '记到昼夜表',
  GetIslands: '查浮岛与日程',
  SaveIsland: '保存浮岛 / 日程',
  DeleteIsland: '删除浮岛 / 日程',
  CheckIslandItem: '勾掉浮岛里的事',
  CreatePlanTask: '新建计划任务',
  RememberTagAlias: '记住标签说法',
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

// ── 上下文整理留在聊天里的行 ──
// 两种，都和工具调用同样的一行：
//   · 分界处的压缩提示（消息带 summary）：「整理上下文」+ 一句说明 + 摘要字数，点开看摘要。
//     模型写的摘要存库，重开会话还在原处（chat-history.ts）
//   · 当时在底部加的一行（消息带 context）：清掉了较早的工具结果（点开看清了哪些）、压完了（点它跳到分界那条）。
//     只在界面上、不存库：清理和机械摘要只改这台设备内存里的历史，重开会话后历史从库里重建，就不作数了

export const COMPACT_ROW_LABEL = '整理上下文'

/** 分界处那条压缩提示的说明；fallback = 模型没写成摘要，用的机械摘要 */
export function compactRowSummary(fallback: boolean): string {
  return fallback ? '摘要没写成，先压成了简略记录' : '这条以上的对话已整理成摘要'
}

/** 分界处的压缩提示点开后，摘要下面那句说明 */
export const COMPACT_ROW_NOTE = '之后每轮发给模型的是这份摘要加最近几轮原话；这条以上的原话还在，只是不再发给模型'

export interface ContextEventView {
  /** cleared：清掉了较早的工具结果；compacted：较早的对话写成了摘要；fallback：摘要没写成，压成了简略记录 */
  readonly kind: 'cleared' | 'compacted' | 'fallback'
  /** 整段历史的体量（token），整理前后 */
  readonly beforeTokens: number
  readonly afterTokens: number
  /** cleared：清掉的那几条结果（工具的函数名、原文字数） */
  readonly items?: readonly { readonly name: string; readonly chars: number }[]
  /** compacted / fallback：分界处那条压缩提示的时间，点这行跳过去 */
  readonly boundary?: string
}

/** 大数写成「3.2 万」，几千的取整到百 */
export function approxCount(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')} 万`
  if (n >= 1_000) return String(Math.round(n / 100) * 100)
  return String(Math.max(0, Math.round(n)))
}

export function contextEventLabel(e: ContextEventView): string {
  return e.kind === 'cleared' ? '清理工具结果' : COMPACT_ROW_LABEL
}

/** 那一行中间的说明 */
export function contextEventSummary(e: ContextEventView): string {
  if (e.kind === 'cleared') {
    const items = e.items ?? []
    return `${items.length} 次，约 ${approxCount(items.reduce((n, item) => n + item.chars, 0))} 字`
  }
  return e.kind === 'compacted' ? '较早的对话写成了摘要' : '摘要没写成，先压成简略记录'
}

/** 右边那一小段：上下文从多少降到多少（token） */
export function contextEventSize(e: ContextEventView): string {
  return `${approxCount(e.beforeTokens)} → ${approxCount(e.afterTokens)}`
}

/** 清掉的结果按工具合并，字数多的在前 */
export function clearedToolGroups(e: ContextEventView): { label: string; count: number; chars: number }[] {
  const groups = new Map<string, { label: string; count: number; chars: number }>()
  for (const item of e.items ?? []) {
    const label = item.name ? toolLabel(item.name) : '工具'
    const group = groups.get(label) ?? { label, count: 0, chars: 0 }
    group.count += 1
    group.chars += item.chars
    groups.set(label, group)
  }
  return [...groups.values()].sort((a, b) => b.chars - a.chars)
}

/** 清理那一行点开后的说明 */
export function contextEventNote(e: ContextEventView): string {
  if (e.kind !== 'cleared') return '点这行跳到分界那条，点开能看摘要'
  return `上下文约 ${contextEventSize(e)} token。较早几轮的长工具结果换成了一句说明，调用本身还在，模型知道查过什么，要用时会重新查；最近几轮的没动。只改了这台设备上的上下文，重开会话后不作数`
}

/** 不画成一行的地方用的文字（消息的 content，长按复制的就是它） */
export function contextEventLine(e: ContextEventView): string {
  return `${contextEventLabel(e)} · ${contextEventSummary(e)} · 上下文约 ${contextEventSize(e)} token`
}
