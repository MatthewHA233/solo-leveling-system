// ══════════════════════════════════════════════
// useBiliHistory — 轮询同步 Hook（数据入 DB，不持有列表状态）
// ══════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { fetchBiliHistoryDb } from '../local-api'
import type { DbBiliItem } from '../local-api'

export interface BiliCursor {
  max: number
  viewAt: number
}

export interface UseBiliHistoryOptions {
  intervalSeconds?: number
  enabled?: boolean
  ps?: number
}

export interface UseBiliHistoryReturn {
  newItems: DbBiliItem[]           // 今日未关联活动的新条目，供 App.tsx 自动建档
  isLoading: boolean
  error: string | null
  lastUpdated: Date | null
  countdown: number
  intervalSeconds: number
  isPaused: boolean
  windowClosed: boolean
  cursor: BiliCursor | null        // 最旧 cursor，用于加载更早历史
  hasMoreRemote: boolean           // B站 API 侧是否还有更旧的记录
  pause: () => void
  resume: () => void
  refresh: () => void
  loadOlderHistory: () => Promise<void>  // 用 cursor 拉更旧的记录入 DB
  clearNew: () => void
  setIntervalSeconds: (s: number) => void
}

export function useBiliHistory(options: UseBiliHistoryOptions = {}): UseBiliHistoryReturn {
  const { intervalSeconds: initInterval = 60, enabled = true, ps = 30 } = options

  const [newItems, setNewItems] = useState<DbBiliItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [windowClosed, setWindowClosed] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [countdown, setCountdown] = useState(initInterval)
  const [isPaused, setIsPaused] = useState(false)
  const [intervalSeconds, setIntervalSeconds] = useState(initInterval)
  const [cursor, setCursor] = useState<BiliCursor | null>(null)
  const [hasMoreRemote, setHasMoreRemote] = useState(true)
  const loadingOlderRef = useRef(false)

  const countdownRef = useRef(initInterval)
  const isPausedRef = useRef(false)
  isPausedRef.current = isPaused

  const doFetch = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await invoke<{ upserted: number; cursor_max: number; cursor_view_at: number }>(
        'fetch_bili_history', { ps, cursorMax: 0, cursorViewAt: 0 },
      )
      setCursor({ max: result.cursor_max, viewAt: result.cursor_view_at })
      setHasMoreRemote(result.cursor_max > 0)
      setWindowClosed(false)
      setLastUpdated(new Date())

      // 查询今日未关联活动的条目，触发 App.tsx 自动建档
      const now = new Date()
      const todayStartSec = Math.floor(
        new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000,
      )
      const page = await fetchBiliHistoryDb(0, 50, true)
      const todayUnlinked = page.items.filter((i) => i.view_at >= todayStartSec && i.event_id === null)
      if (todayUnlinked.length > 0) {
        setNewItems(todayUnlinked)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'BILI_WIN_CLOSED') {
        setWindowClosed(true)
        setError(null)
      } else if (msg === 'BILI_HISTORY_BUSY') {
        // 双触发被去重 → 静默吞掉，不影响 UI
      } else {
        setError(msg)
        setWindowClosed(false)
      }
    } finally {
      setIsLoading(false)
    }
  }, [ps])

  // 初次加载
  useEffect(() => {
    if (enabled) doFetch()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // 倒计时 + 自动刷新
  useEffect(() => {
    if (!enabled || intervalSeconds === 0) return
    countdownRef.current = intervalSeconds
    setCountdown(intervalSeconds)

    const timer = setInterval(() => {
      if (isPausedRef.current) return
      countdownRef.current -= 1
      setCountdown(countdownRef.current)
      if (countdownRef.current <= 0) {
        doFetch()
        countdownRef.current = intervalSeconds
        setCountdown(intervalSeconds)
      }
    }, 1000)

    return () => clearInterval(timer)
  }, [intervalSeconds, enabled, doFetch])

  const pause = useCallback(() => setIsPaused(true), [])
  const resume = useCallback(() => setIsPaused(false), [])
  const clearNew = useCallback(() => setNewItems([]), [])

  const refresh = useCallback(() => {
    countdownRef.current = intervalSeconds
    setCountdown(intervalSeconds)
    doFetch()
  }, [doFetch, intervalSeconds])

  // 用当前 cursor 拉取更旧的 B站历史存入 DB，完成后触发 lastUpdated 刷新列表
  const loadOlderHistory = useCallback(async () => {
    if (!cursor || loadingOlderRef.current) return
    loadingOlderRef.current = true
    setIsLoading(true)
    setError(null)
    try {
      const result = await invoke<{ upserted: number; cursor_max: number; cursor_view_at: number }>(
        'fetch_bili_history', { ps, cursorMax: cursor.max, cursorViewAt: cursor.viewAt },
      )
      const newCursor = { max: result.cursor_max, viewAt: result.cursor_view_at }
      setCursor(newCursor)
      setHasMoreRemote(result.cursor_max > 0)
      setLastUpdated(new Date())  // 触发 BiliHistoryMonitor 刷新列表
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg !== 'BILI_HISTORY_BUSY') setError(msg)
    } finally {
      setIsLoading(false)
      loadingOlderRef.current = false
    }
  }, [cursor, ps])

  return {
    newItems, isLoading, error, lastUpdated,
    countdown, intervalSeconds, isPaused, windowClosed, cursor, hasMoreRemote,
    pause, resume, refresh, loadOlderHistory, clearNew, setIntervalSeconds,
  }
}
