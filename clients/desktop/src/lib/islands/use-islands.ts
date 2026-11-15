// ══════════════════════════════════════════════
// 昼夜表 · 浮岛与约束：取规则、当天勾选、近几天记录，算出当天各条的落点
//   规则 / 勾选变了调 reload；实际记录变了（activityBlocks 是参数）落点自动重算
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActivityBlock, ActivityPalette } from '../../types'
import { fetchActivityBlocksRange, fetchIslandChecks, fetchIslands } from './island-api'
import { ESTIMATE_LOOKBACK_DAYS, addDays, computePlacements, toDateKey } from './island-model'
import type { Island, IslandPlacement } from './island-model'

/** 「此刻」多久更新一次：只影响进行中 / 已错过的判断，不用太勤 */
const NOW_TICK_MS = 60_000

interface State {
  readonly islands: readonly Island[]
  readonly checks: ReadonlyMap<string, ReadonlySet<string>>
  readonly history: ReadonlyMap<string, readonly ActivityBlock[]>
  /** 上面三样是给哪一天取的 */
  readonly dateKey: string
}

const EMPTY: State = { islands: [], checks: new Map(), history: new Map(), dateKey: '' }

export interface UseIslands {
  readonly islands: readonly Island[]
  readonly placements: readonly IslandPlacement[]
  readonly error: string | null
  readonly reload: () => void
}

function nowMinuteOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

export function useIslands(selectedDate: Date, activityBlocks: readonly ActivityBlock[], palette: ActivityPalette): UseIslands {
  const [state, setState] = useState<State>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [now, setNow] = useState(() => new Date())
  const dateKey = toDateKey(selectedDate)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), NOW_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    const day = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate())
    Promise.all([
      fetchIslands(),
      fetchIslandChecks(day),
      fetchActivityBlocksRange(addDays(day, -ESTIMATE_LOOKBACK_DAYS), addDays(day, -1)),
    ])
      .then(([islands, checks, history]) => {
        if (cancelled) return
        setState({ islands, checks, history, dateKey: toDateKey(day) })
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '读取浮岛失败')
      })
    return () => { cancelled = true }
    // selectedDate 每次渲染可能是新对象，用 dateKey 判断是不是换了一天
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey, version])

  const placements = useMemo(() => {
    // 换了日期、新数据还没到：先不画，免得把前一天的勾选套到这一天
    if (state.dateKey !== dateKey) return []
    const todayKey = toDateKey(now)
    const dayOffset = dateKey < todayKey ? -1 : dateKey > todayKey ? 1 : 0
    return computePlacements({
      islands: state.islands,
      palette,
      blocks: activityBlocks,
      historyByDate: state.history,
      checks: state.checks,
      dayOffset,
      nowMinute: nowMinuteOf(now),
    })
  }, [state, dateKey, activityBlocks, palette, now])

  const reload = useCallback(() => setVersion((v) => v + 1), [])

  return { islands: state.islands, placements, error, reload }
}
