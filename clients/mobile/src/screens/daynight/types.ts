import type { ActivityBlock } from '../../types'
import type { ActivityCategory, ActivityTag } from '../../types'

export const GUTTER = 46
export const GAP = 4
export const R_ACTIVITY = 14
export const R_EMPTY = 5

export type ZoomCols = 12 | 6 | 4 | 3
export const ZOOM_LEVELS: readonly ZoomCols[] = [12, 6, 4, 3] as const
export const TOTAL_ROWS_LEVELS = [24, 22, 20, 18, 16, 14] as const
export type TotalRows = typeof TOTAL_ROWS_LEVELS[number]

export const COLS_R_FACTOR: Record<ZoomCols, number> = { 12: 1, 6: 2, 4: 3, 3: 4 }
export const MAX_HOURS_PER_TIER = 6
export const DAY_PERIOD_START_HOURS = [0, 6, 12, 18, 20] as const

export interface RowConfig { focusRows: number }

export interface Span {
  startMin: number
  endMin: number
  tagId: number
  note: string | null
}

export type Row =
  | { kind: 'full'; startMin: number; cols: number }
  | { kind: 'compressed'; hours: number[] }

export type DayPeriodInfo = {
  label: string
  accent: string
  text: string
}

export type DayPeriodSegment = DayPeriodInfo & {
  key: string
  hours: number
}

export type HitCell =
  | { kind: 'full'; hour: number; col: number; minute: number }
  | { kind: 'compressed'; hour: number }

export interface PlannedTask {
  id: string
  title: string
  icon: string
  color: string
  durationMin: number
  scheduledStartMin: number | null
}

export type DayNightSummary = {
  total: number
  rows: {
    cat: ActivityCategory
    mins: number
    tags: { tag: ActivityTag; mins: number }[]
  }[]
}

export interface PlanMeta {
  icon: string
  color: string
  label: string
}

export interface Interaction {
  editMode: boolean
  selectedTagId: number | null
  rows: Row[]
  blocks: ActivityBlock[]
  blockByMinute: Map<number, ActivityBlock>
  spans: Span[]
  selectedDate: Date
}

export interface DragState {
  mode: 'paint' | 'erase'
  startMin: number | null
  lastMin: number | null
  painted: Set<number>
  paintMins: Set<number>
  eraseMins: Set<number>
  snapshot: ActivityBlock[]
  moved: boolean
  tapCell: HitCell | null
  grantTs: number
}
