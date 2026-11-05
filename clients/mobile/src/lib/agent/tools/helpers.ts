// ══════════════════════════════════════════════
// 工具辅助函数（逐段对齐 desktop agent-tools.ts 的同名函数）
// ══════════════════════════════════════════════

/**
 * YYYY-MM-DD → Date（当地时间 0:00），无效/缺省返回今天。
 * desktop 用 new Date(`${date}T00:00:00`)，手机端直接按年月日构造，不依赖 Hermes 对这种字符串的时区判断。
 */
export function parseDateArg(dateArg: unknown): Date {
  if (typeof dateArg === 'string') {
    const day = localDayFromKey(dateArg)
    if (!Number.isNaN(day.getTime())) return day
  }
  return new Date()
}

/** 不是合法的 YYYY-MM-DD 就返回 Invalid Date。Date 构造函数会把 13 月 45 日进位成别的日子，所以要反查一遍 */
function localDayFromKey(key: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return new Date(NaN)
  const month = Number(key.slice(5, 7)) - 1
  const dayOfMonth = Number(key.slice(8, 10))
  const day = new Date(Number(key.slice(0, 4)), month, dayOfMonth)
  return day.getMonth() === month && day.getDate() === dayOfMonth ? day : new Date(NaN)
}

/**
 * 将时间参数解析为可比较的字符串（"YYYY-MM-DD HH:MM"）。
 * 接受两种格式：
 *   "HH:MM"            → 补全今天日期，用于 date+days 场景的简单过滤
 *   "YYYY-MM-DD HH:MM" → 直接使用，用于跨天精确范围
 */
/**
 * 按时间段过滤 span，支持跨天范围。
 * span 与查询时间段有重叠即保留（而非完全包含）。
 * start/end 均为 "YYYY-MM-DD HH:MM" 或 null（表示无限制）。
 */
export function filterByTime<T extends { start_at: string; end_at: string }>(
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

/** keyword 参数 → 小写关键词列表。
 *  防御 Qwen 函数调用的双重编码毛病：数组会被序列化成字符串 '["a","b"]' 传进来，
 *  直接拿这串字面量做子串匹配永远查不到（曾导致 AI 误判"没有匹配的想法卡"而重复建卡）。*/
export function normalizeKeywords(keyword: unknown): string[] {
  if (typeof keyword === 'string') {
    const t = keyword.trim()
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(t)
        if (Array.isArray(parsed)) return normalizeKeywords(parsed)
      } catch { /* 不是合法 JSON 数组就按普通子串处理 */ }
    }
    return t ? [t.toLowerCase()] : []
  }
  if (Array.isArray(keyword)) {
    return keyword.flatMap((k) => (typeof k === 'string' && k.trim() ? [k.trim().toLowerCase()] : []))
  }
  return []
}

/** 按关键词过滤（大小写不敏感子串匹配，支持单个字符串或字符串数组取并集） */
export function filterByKeyword<T>(
  spans: T[],
  keyword: unknown,
  getFields: (s: T) => string[],
): T[] {
  const kws = normalizeKeywords(keyword)
  if (kws.length === 0) return spans
  return spans.filter(s => {
    const fields = getFields(s).map(f => f.toLowerCase())
    return kws.some(kw => fields.some(f => f.includes(kw)))
  })
}

/**
 * 根据 date/days 或 start_datetime/end_datetime 推导出需要查哪几天。
 * 返回需要查询的日期列表（升序）。
 */
export function resolveDatesToFetch(args: Record<string, unknown>): Date[] {
  const startDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
  const endDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null

  if (startDT || endDT) {
    // 精确范围模式：从 start 日期到 end 日期，逐天列出。只给起点查到今天，只给终点查那一天
    const startDay = localDayFromKey((startDT || endDT || '').slice(0, 10))
    const endDay   = endDT ? localDayFromKey(endDT.slice(0, 10)) : new Date()
    // 格式不对时一天都不查，工具会回"无匹配"，模型就告诉主人没有记录
    // filterByTime 按 "YYYY-MM-DD HH:MM" 比较字符串，别的写法（T 分隔、只有日期、斜杠）比出来全错，同样要报错
    const wellFormed = [startDT, endDT].every((dt) => !dt || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(dt))
    if (!wellFormed || Number.isNaN(startDay.getTime()) || Number.isNaN(endDay.getTime())) throw new Error('start_datetime / end_datetime 格式应为 "YYYY-MM-DD HH:MM"')
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

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function minuteToHHmm(minute: number): string {
  const m = Math.max(0, Math.min(1440, minute))
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// ── 三个 DB 工具共用的参数 schema ──

export const TIME_RANGE_PARAMS = {
  date:           { type: 'string', description: '查询日期，格式 YYYY-MM-DD，默认今天。与 days 配合使用' },
  days:           { type: 'number', description: '往前查几天（含 date 当天），默认 1。查"这周"传 7' },
  start_datetime: { type: 'string', description: '精确起始时间，格式 "YYYY-MM-DD HH:MM"。提供此参数则忽略 date/days' },
  end_datetime:   { type: 'string', description: '精确结束时间，格式 "YYYY-MM-DD HH:MM"。与 start_datetime 配对使用，支持跨天（如昨晚18:00到今晨05:00）' },
} as const
