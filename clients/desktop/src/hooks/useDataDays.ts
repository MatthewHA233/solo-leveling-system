// ══════════════════════════════════════════════
// useDataDays — 给前后日切换按钮判断"目标日是否有数据"
// 围绕当前日 ±14 天预取一个窗口；命中缓存即同步返回
// source = 'all'  → /api/activities/data-days   (chronos+bili+presence)
// source = 'bili' → /api/bilibili/day-counts    (watched > 0 的日期)
// ══════════════════════════════════════════════

import { useEffect, useState, useMemo } from 'react'
import { fetchDataDays, fetchBiliDayCounts } from '../lib/local-api'

export type DataDaySource = 'all' | 'bili'

const cache = new Map<string, Set<string>>()
const inflight = new Map<string, Promise<Set<string>>>()

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function shift(d: Date, days: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + days)
  x.setHours(0, 0, 0, 0)
  return x
}

const WINDOW_DAYS = 14

async function fetchWindow(source: DataDaySource, from: string, to: string): Promise<Set<string>> {
  if (source === 'bili') {
    const rows = await fetchBiliDayCounts(from, to)
    return new Set(rows.filter((r) => r.watched > 0).map((r) => r.day))
  }
  const days = await fetchDataDays(from, to)
  return new Set(days)
}

/**
 * 返回一个 Set，包含 center ± WINDOW_DAYS 范围内"有数据"的日期 key。
 * 注意：返回值在窗口加载完成前可能为空 Set；调用方据此置灰按钮即可。
 */
export function useDataDays(centerDate: Date, source: DataDaySource = 'all'): Set<string> {
  // 用 14 天窗口的起始日做缓存 key（每 14 天滚动一次窗口，避免每次切日都重抓）
  const center = useMemo(() => {
    const c = new Date(centerDate); c.setHours(0, 0, 0, 0); return c
  }, [centerDate])

  const windowKey = useMemo(() => {
    const days = Math.floor(center.getTime() / 86400000)
    const bucket = Math.floor(days / WINDOW_DAYS) * WINDOW_DAYS
    const start = new Date(bucket * 86400000)
    const from = dayKey(shift(start, -WINDOW_DAYS))
    const to   = dayKey(shift(start, WINDOW_DAYS * 2))
    return `${source}:${from}~${to}`
  }, [center, source])

  const [data, setData] = useState<Set<string>>(() => cache.get(windowKey) ?? new Set())

  useEffect(() => {
    const cached = cache.get(windowKey)
    if (cached) { setData(cached); return }

    const [, range] = windowKey.split(':')
    const [from, to] = range.split('~')

    let cancelled = false
    const existing = inflight.get(windowKey)
    const p = existing ?? fetchWindow(source, from, to)
      .then((s) => { cache.set(windowKey, s); inflight.delete(windowKey); return s })
      .catch(() => { inflight.delete(windowKey); return new Set<string>() })
    if (!existing) inflight.set(windowKey, p)

    p.then((s) => { if (!cancelled) setData(s) })
    return () => { cancelled = true }
  }, [windowKey, source])

  return data
}

/** 工具函数：判断给定日期是否有数据（today 始终视为可达） */
export function hasDataOrIsToday(date: Date, dataDays: Set<string>): boolean {
  const k = dayKey(date)
  const today = dayKey(new Date())
  if (k === today) return true
  return dataDays.has(k)
}
