// 今日动机云的明暗：今天推进得越久越亮；立约了还没推进的次亮；今天没碰的暗着（不消失、不评判）
//   亮度是相对今天最亮那一颗的（对数刻度：推进 5 分钟和 2 小时都看得出来，又不会差到看不见）

import type { SenseMotive, TodayView } from '../../lib/system-api'
import type { Tier } from '../motive-cloud/motive-label-layout'

/** 0..1；1 = 今天最亮的那颗 */
export interface Glow {
  readonly level: number
  readonly tier: Tier
  readonly seconds: number
  readonly declared: boolean
}

/** 立约了、今天还没推进 */
const PLEDGED = 0.42
/** 今天没碰 */
const QUIET = 0.16
/** 推进过的最暗也有这么亮（比立约的亮） */
const LIVED_FLOOR = 0.5
const BRIGHT_AT = 0.75
const DIM_AT = 0.4

const tierOf = (level: number): Tier => (level >= BRIGHT_AT ? 'major' : level >= DIM_AT ? 'minor' : 'faint')

export function glowOf(motives: readonly SenseMotive[], today: TodayView | null): Map<string, Glow> {
  const secondsOf = (id: string) => today?.motiveSeconds.get(id) ?? 0
  const max = Math.max(0, ...motives.map((m) => secondsOf(m.id)))
  return new Map(motives.map((m) => {
    const seconds = secondsOf(m.id)
    const declared = today?.declared.includes(m.id) ?? false
    const level = seconds > 0
      ? LIVED_FLOOR + (1 - LIVED_FLOOR) * (Math.log1p(seconds / 60) / Math.log1p(max / 60))
      : declared ? PLEDGED : QUIET
    return [m.id, { level, tier: tierOf(level), seconds, declared }]
  }))
}

/** 「今天推进了 23 分钟」 */
export function livedText(seconds: number): string {
  if (seconds <= 0) return '今天还没碰'
  if (seconds < 60) return '今天推进了不到 1 分钟'
  const min = Math.round(seconds / 60)
  return min < 60 ? `今天推进了 ${min} 分钟` : `今天推进了 ${Math.floor(min / 60)} 小时 ${min % 60} 分钟`
}
