import type {
  DayPeriodInfo,
  DayPeriodSegment,
  Row,
  RowConfig,
  Span,
  ZoomCols,
} from './types'
import {
  COLS_R_FACTOR,
  DAY_PERIOD_START_HOURS,
  MAX_HOURS_PER_TIER,
} from './types'
import type { ActivityBlock } from '../../types'

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function snapMinute(minute: number): number {
  return clamp(Math.round(minute / 5) * 5, 0, 1435)
}

export function computeRowConfig(cols: ZoomCols, totalRows: number): RowConfig {
  const rFactor = COLS_R_FACTOR[cols]
  const rMax = Math.floor((24 * 12) / cols / rFactor) * rFactor
  for (let R = rMax; R >= 0; R -= rFactor) {
    const focusH = (R * cols) / 12
    const rest = 24 - focusH
    let worstTier = 0
    if (rest > 0) {
      for (let k = 0; k <= rest; k++) {
        const topTiers = k > 0 ? Math.ceil(k / MAX_HOURS_PER_TIER) : 0
        const botTiers = rest - k > 0 ? Math.ceil((rest - k) / MAX_HOURS_PER_TIER) : 0
        const sum = topTiers + botTiers
        if (sum > worstTier) worstTier = sum
      }
    }
    if (R + worstTier <= totalRows) {
      return { focusRows: R }
    }
  }
  return { focusRows: 0 }
}

export function zoomFocusHours(cols: ZoomCols, totalRows: number): number {
  return (computeRowConfig(cols, totalRows).focusRows * cols) / 12
}

export function buildSpans(blocks: ActivityBlock[]): Span[] {
  const sorted = [...blocks].sort((a, b) => a.minute - b.minute)
  const spans: Span[] = []
  for (const b of sorted) {
    const last = spans[spans.length - 1]
    if (last && last.tagId === b.tagId && b.minute === last.endMin) {
      last.endMin = b.minute + 5
      if (!last.note && b.note) last.note = b.note
    } else {
      spans.push({ startMin: b.minute, endMin: b.minute + 5, tagId: b.tagId, note: b.note })
    }
  }
  return spans
}

export function buildRows(focusStart: number, zoomCols: ZoomCols, totalRows: number): Row[] {
  const cfg = computeRowConfig(zoomCols, totalRows)
  const focusH = (cfg.focusRows * zoomCols) / 12
  const safeStart = clamp(focusStart, 0, 24 - focusH)
  const rows: Row[] = []

  const topHours: number[] = []
  for (let h = 0; h < safeStart; h++) topHours.push(h)
  if (topHours.length > 0) {
    const topTiers = Math.ceil(topHours.length / MAX_HOURS_PER_TIER)
    const chunk = Math.ceil(topHours.length / topTiers)
    for (let i = 0; i < topTiers; i++) {
      const slice = topHours.slice(i * chunk, (i + 1) * chunk)
      if (slice.length > 0) rows.push({ kind: 'compressed', hours: slice })
    }
  }

  const startMin = safeStart * 60
  const minutesPerRow = zoomCols * 5
  for (let i = 0; i < cfg.focusRows; i++) {
    rows.push({ kind: 'full', startMin: startMin + i * minutesPerRow, cols: zoomCols })
  }

  const botHours: number[] = []
  for (let h = safeStart + focusH; h < 24; h++) botHours.push(h)
  if (botHours.length > 0) {
    const botTiers = Math.ceil(botHours.length / MAX_HOURS_PER_TIER)
    const chunk = Math.ceil(botHours.length / botTiers)
    for (let i = 0; i < botTiers; i++) {
      const slice = botHours.slice(i * chunk, (i + 1) * chunk)
      if (slice.length > 0) rows.push({ kind: 'compressed', hours: slice })
    }
  }
  return rows
}

export function buildTorrentRows(anchorMinute: number): Row[] {
  const rowMinutes = 30
  const halfHourIdx = clamp(Math.floor(anchorMinute / rowMinutes), 0, 47)
  const startIdx = clamp(halfHourIdx - 1, 0, 44)
  const startMin = startIdx * rowMinutes
  return Array.from({ length: 4 }, (_, i) => ({
    kind: 'full' as const,
    startMin: startMin + i * rowMinutes,
    cols: 6,
  }))
}

export function minuteOfDayFloat(ts: number): number {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000
}

export function dayPeriodForHour(hour: number): DayPeriodInfo {
  if (hour < 6) return { label: '凌晨', accent: '#787CFF', text: '#626BDF' }
  if (hour < 12) return { label: '上午', accent: '#DCEB64', text: '#8A940F' }
  if (hour < 18) return { label: '下午', accent: '#FACC15', text: '#B7791F' }
  if (hour < 20) return { label: '黄昏', accent: '#FF8140', text: '#D65F20' }
  return { label: '夜晚', accent: '#A06EFF', text: '#7C3AED' }
}

export function rowStartHour(row: Row): number {
  return row.kind === 'full' ? Math.floor(row.startMin / 60) : row.hours[0]
}

export function shouldShowPeriodLabel(row: Row): boolean {
  if (row.kind === 'compressed') {
    return row.hours.some((h) => DAY_PERIOD_START_HOURS.includes(h as typeof DAY_PERIOD_START_HOURS[number]))
  }
  const h = Math.floor(row.startMin / 60)
  return row.startMin % 60 === 0 && DAY_PERIOD_START_HOURS.includes(h as typeof DAY_PERIOD_START_HOURS[number])
}

export function rowPeriodSegments(row: Row): DayPeriodSegment[] {
  const hours = row.kind === 'full' ? [Math.floor(row.startMin / 60)] : row.hours
  const segs: DayPeriodSegment[] = []
  for (const h of hours) {
    const info = dayPeriodForHour(h)
    const last = segs[segs.length - 1]
    if (last && last.label === info.label) {
      last.hours += 1
    } else {
      segs.push({ ...info, key: `${info.label}-${h}`, hours: 1 })
    }
  }
  return segs
}

export function periodLabelSegmentsForRow(row: Row): DayPeriodSegment[] {
  if (row.kind === 'compressed') return rowPeriodSegments(row)
  return shouldShowPeriodLabel(row) ? rowPeriodSegments(row) : []
}
