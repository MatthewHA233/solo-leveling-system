// ══════════════════════════════════════════════
// 日期 / 分钟坐标工具
// ══════════════════════════════════════════════

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Date → 'YYYY-MM-DD'（本地时区） */
export function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 一天内的分钟数 → 'HH:MM' */
export function fmtMinute(m: number): string {
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime())
  x.setDate(x.getDate() + n)
  return x
}

export function isSameDay(a: Date, b: Date): boolean {
  return toLocalDateStr(a) === toLocalDateStr(b)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Date → '5月16日 周五' */
export function fmtDateLabel(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`
}

/** 毫秒 → 'M:SS' */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`
}

/** 时钟时刻 → 'HH:MM'（用于聊天气泡时间戳） */
export function fmtClock(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
