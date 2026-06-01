export type DayPeriodInfo = {
  label: string
  accent: string
  text: string
}

export const DAY_PERIOD_START_HOURS = [0, 6, 12, 18, 20] as const

export function dayPeriodForHour(hour: number): DayPeriodInfo {
  if (hour < 6) return { label: '凌晨', accent: '#787CFF', text: '#626BDF' }
  if (hour < 12) return { label: '上午', accent: '#DCEB64', text: '#8A940F' }
  if (hour < 18) return { label: '下午', accent: '#FACC15', text: '#B7791F' }
  if (hour < 20) return { label: '黄昏', accent: '#FF8140', text: '#D65F20' }
  return { label: '夜晚', accent: '#A06EFF', text: '#7C3AED' }
}

export function dayPeriodForMinute(minute: number): DayPeriodInfo {
  return dayPeriodForHour(Math.max(0, Math.min(23, Math.floor(minute / 60))))
}

export function dayPeriodForTs(ts: number): DayPeriodInfo {
  return dayPeriodForHour(new Date(ts).getHours())
}
