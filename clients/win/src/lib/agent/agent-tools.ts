// ══════════════════════════════════════════════
// Agent Tools — Fairy 可调用的工具
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { fetchManicTimeSpans, fetchBiliSpans } from '../local-api'
import type { MtSpan, BiliSpan } from '../local-api'
import type { ToolDefinition } from '../llm/types'

// ── 内部 Tool 接口 ──

interface Tool {
  readonly definition: ToolDefinition
  execute(args: Record<string, unknown>): Promise<string>
}

// ── 工具辅助函数 ──

function toLocalDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** YYYY-MM-DD → Date（当地时间 0:00），无效/缺省返回今天 */
function parseDateArg(dateArg: unknown): Date {
  if (typeof dateArg === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    return new Date(dateArg + 'T00:00:00')
  }
  return new Date()
}

/**
 * 将时间参数解析为可比较的字符串（"YYYY-MM-DD HH:MM"）。
 * 接受两种格式：
 *   "HH:MM"            → 补全今天日期，用于 date+days 场景的简单过滤
 *   "YYYY-MM-DD HH:MM" → 直接使用，用于跨天精确范围
 */
function normalizeDateTime(raw: unknown, fallbackDate: Date, isCeil: boolean): string | null {
  if (!raw || typeof raw !== 'string') return null
  if (/^\d{2}:\d{2}$/.test(raw)) {
    // 只有时间，补上 fallbackDate 的日期
    return `${toLocalDateStr(fallbackDate)} ${raw}`
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) {
    return raw
  }
  return null
}

/**
 * 按时间段过滤 span，支持跨天范围。
 * span 与查询时间段有重叠即保留（而非完全包含）。
 * start/end 均为 "YYYY-MM-DD HH:MM" 或 null（表示无限制）。
 */
function filterByTime<T extends { start_at: string; end_at: string }>(
  spans: T[],
  fromDT: string | null,
  toDT: string | null,
): T[] {
  if (!fromDT && !toDT) return spans
  // span 的 start_at/end_at 格式是 "2026-04-09 14:32:00"，取前16位做字符串比较
  return spans.filter(s => {
    const spanStart = s.start_at.slice(0, 16)
    const spanEnd   = s.end_at.slice(0, 16)
    const afterFrom  = !fromDT || spanEnd   >= fromDT
    const beforeTo   = !toDT   || spanStart <= toDT
    return afterFrom && beforeTo
  })
}

/** 按关键词过滤（大小写不敏感子串匹配） */
function filterByKeyword<T>(
  spans: T[],
  keyword: unknown,
  getFields: (s: T) => string[],
): T[] {
  if (!keyword || typeof keyword !== 'string') return spans
  const kw = keyword.toLowerCase()
  return spans.filter(s => getFields(s).some(f => f.toLowerCase().includes(kw)))
}

/**
 * 根据 date/days 或 start_datetime/end_datetime 推导出需要查哪几天。
 * 返回需要查询的日期列表（升序）。
 */
function resolveDatesToFetch(args: Record<string, unknown>): Date[] {
  const startDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
  const endDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null

  if (startDT && endDT) {
    // 精确范围模式：从 start 日期到 end 日期，逐天列出
    const startDay = new Date(startDT.slice(0, 10) + 'T00:00:00')
    const endDay   = new Date(endDT.slice(0, 10) + 'T00:00:00')
    const dates: Date[] = []
    const cursor = new Date(startDay)
    while (cursor <= endDay) {
      dates.push(new Date(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }
    return dates
  }

  // 简单模式：date + days
  const baseDate = parseDateArg(args.date)
  const days = typeof args.days === 'number' && args.days > 1 ? Math.min(args.days, 30) : 1
  const dates: Date[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(baseDate)
    d.setDate(d.getDate() - i)
    dates.push(d)
  }
  return dates
}

/** 查询指定日期列表的所有 ManicTime spans，合并排序 */
async function fetchManicTimeSpansRange(dates: Date[]): Promise<MtSpan[]> {
  const results = await Promise.all(dates.map(d => fetchManicTimeSpans(d).catch(() => [])))
  return results.flat().sort((a, b) => a.start_at.localeCompare(b.start_at))
}

/** 查询指定日期列表的所有 BiliSpans，合并排序 */
async function fetchBiliSpansRange(dates: Date[]): Promise<BiliSpan[]> {
  const results = await Promise.all(dates.map(d => fetchBiliSpans(d).catch(() => [])))
  return results.flat().sort((a, b) => a.start_at.localeCompare(b.start_at))
}

// ── 三个 DB 工具共用的参数 schema ──

const TIME_RANGE_PARAMS = {
  date:           { type: 'string', description: '查询日期，格式 YYYY-MM-DD，默认今天。与 days 配合使用' },
  days:           { type: 'number', description: '往前查几天（含 date 当天），默认 1。查"这周"传 7' },
  start_datetime: { type: 'string', description: '精确起始时间，格式 "YYYY-MM-DD HH:MM"。提供此参数则忽略 date/days' },
  end_datetime:   { type: 'string', description: '精确结束时间，格式 "YYYY-MM-DD HH:MM"。与 start_datetime 配对使用，支持跨天（如昨晚18:00到今晨05:00）' },
} as const

// ── GetAppUsage ──

const getAppUsage: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetAppUsage',
      description:
        '查询 ManicTime 应用使用记录（哪个 app、哪个窗口标题、什么时间段）。' +
        '支持按日期、精确时间范围（含跨天）、关键词过滤。' +
        '适用于："今天下午用了什么软件""这周有没有打开 VSCode""昨晚在干嘛"等查询。',
      parameters: {
        type: 'object',
        properties: {
          ...TIME_RANGE_PARAMS,
          keyword: { type: 'string', description: '按应用名或窗口标题过滤（大小写不敏感子串）' },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const dates = resolveDatesToFetch(args)
    const fromDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
    const toDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null

    const all = await fetchManicTimeSpansRange(dates)
    let apps = all.filter(s => s.track === 'apps')
    apps = filterByTime(apps, fromDT, toDT)
    apps = filterByKeyword(apps, args.keyword, s => [s.title, s.group_name ?? ''])

    if (apps.length === 0) return '无匹配的应用使用记录'
    return apps
      .map(s => `${s.start_at.slice(0, 16)} - ${s.end_at.slice(11, 16)}  [${s.title}] ${s.group_name ?? ''}`)
      .join('\n')
  },
}

// ── GetActivityTags ──

const getActivityTags: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetActivityTags',
      description:
        '查询 ManicTime 活动标签（如"工作""学习""娱乐"等手动打的分类标签）。' +
        '支持按日期、精确时间范围（含跨天）、关键词过滤。' +
        '适用于："今天学习了多久""这周工作时间怎么分布"等查询。',
      parameters: {
        type: 'object',
        properties: {
          ...TIME_RANGE_PARAMS,
          keyword: { type: 'string', description: '按标签名过滤（大小写不敏感子串）' },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const dates = resolveDatesToFetch(args)
    const fromDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
    const toDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null

    const all = await fetchManicTimeSpansRange(dates)
    let tags = all.filter(s => s.track === 'tags')
    tags = filterByTime(tags, fromDT, toDT)
    tags = filterByKeyword(tags, args.keyword, s => [s.title, s.group_name ?? ''])

    if (tags.length === 0) return '无匹配的活动标签记录'
    return tags
      .map(s => `${s.start_at.slice(0, 16)} - ${s.end_at.slice(11, 16)}  [${s.title}]${s.group_name ? ` / ${s.group_name}` : ''}`)
      .join('\n')
  },
}

// ── GetBiliHistory ──

const getBiliHistory: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetBiliHistory',
      description:
        '查询主人 B 站观看历史（视频标题、URL、观看时间）。' +
        '支持按日期、精确时间范围（含跨天）、关键词过滤。' +
        '适用于："今晚看了什么视频""这周看过什么游戏视频""昨晚的B站记录"等查询。',
      parameters: {
        type: 'object',
        properties: {
          ...TIME_RANGE_PARAMS,
          keyword: { type: 'string', description: '按视频标题过滤（大小写不敏感子串）' },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const dates = resolveDatesToFetch(args)
    const fromDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
    const toDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null

    const all = await fetchBiliSpansRange(dates)
    let spans = filterByTime(all, fromDT, toDT)
    spans = filterByKeyword(spans, args.keyword, s => [s.title])

    if (spans.length === 0) return '无匹配的 B 站观看记录'
    return spans
      .map(s => `${s.start_at.slice(0, 16)}  《${s.title}》  https://www.bilibili.com/video/${s.bvid}`)
      .join('\n')
  },
}

// ── Read ──

const readFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'Read',
      description: '读取本地文件内容，返回文本。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件的绝对路径' },
        },
        required: ['file_path'],
      },
    },
  },
  async execute(args) {
    const path = args.file_path as string
    if (!path) return '缺少参数：file_path'
    return await invoke<string>('read_file', { path })
  },
}

// ── Write ──

const writeFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'Write',
      description: '将内容写入本地文件（完全覆盖）。写入前确认路径正确。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件的绝对路径' },
          content:   { type: 'string', description: '要写入的文件内容' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  async execute(args) {
    const path = args.file_path as string
    const content = args.content as string
    if (!path) return '缺少参数：file_path'
    await invoke('write_file', { path, content })
    return `已写入：${path}`
  },
}

// ── Edit ──

const editFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'Edit',
      description: '在文件中执行精确字符串替换。old_string 必须在文件中唯一存在，否则报错。',
      parameters: {
        type: 'object',
        properties: {
          file_path:  { type: 'string', description: '文件的绝对路径' },
          old_string: { type: 'string', description: '要替换的原始字符串（必须唯一存在）' },
          new_string: { type: 'string', description: '替换后的新字符串' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  async execute(args) {
    const path = args.file_path as string
    const oldStr = args.old_string as string
    const newStr = args.new_string as string
    if (!path || oldStr === undefined) return '缺少参数：file_path 或 old_string'

    const content = await invoke<string>('read_file', { path })
    const count = content.split(oldStr).length - 1
    if (count === 0) return `未找到要替换的字符串：${oldStr.slice(0, 80)}`
    if (count > 1) return `字符串不唯一（出现 ${count} 次），请提供更多上下文`

    const newContent = content.replace(oldStr, newStr)
    await invoke('write_file', { path, content: newContent })
    return `已替换：${path}`
  },
}

// ── Registry ──

const ALL_TOOLS: readonly Tool[] = [
  getAppUsage,
  getActivityTags,
  getBiliHistory,
  readFile,
  writeFile,
  editFile,
]

/** 发给 AI 的工具定义列表（OpenAI function calling 格式） */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = ALL_TOOLS.map(t => t.definition)

/** 按名称执行工具，返回结果字符串 */
export async function executeAgentTool(name: string, argsJson: string): Promise<string> {
  const tool = ALL_TOOLS.find(t => t.definition.function.name === name)
  if (!tool) return `未知工具：${name}`

  try {
    const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    return await tool.execute(args)
  } catch (err) {
    return `工具执行失败：${err instanceof Error ? err.message : String(err)}`
  }
}
