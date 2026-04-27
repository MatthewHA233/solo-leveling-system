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

export interface ScanProgress {
  pages: number       // 已抓取页数
  fetched: number     // 累计抓取条目数（含重复 upsert）
  done: boolean       // 是否到底
}

export interface ScanFeedItem {
  bvid: string
  cover: string
  view_at: number
  title: string
  author_name: string
  progress: number   // -1 = 看完哨兵 / 0 = 点开 / 正数 = 已看秒数
  duration: number   // 视频总时长（秒）
}

export interface ScanPageEvent {
  page: number                  // 第几页
  items: ScanFeedItem[]         // 这一页爬到的视频
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
  scanProgress: ScanProgress | null  // 完整扫描进行中的进度（null = 未在扫描）
  scanSnapshotBvids: Set<string> | null  // 扫描启动那一刻 DB 中所有 bvid 的快照
  scanLastPage: ScanPageEvent | null     // 深度扫描最近一页爬到的 items（每页 tick 一次）
  pause: () => void
  resume: () => void
  refresh: () => void
  loadOlderHistory: () => Promise<void>  // 用 cursor 拉更旧的记录入 DB
  fullScan: () => Promise<void>          // 完整扫描：翻页直到 cursor.max=0
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
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [scanSnapshotBvids, setScanSnapshotBvids] = useState<Set<string> | null>(null)
  const [scanLastPage, setScanLastPage] = useState<ScanPageEvent | null>(null)
  const loadingOlderRef = useRef(false)
  const scanningRef = useRef(false)

  const countdownRef = useRef(initInterval)
  const isPausedRef = useRef(false)
  isPausedRef.current = isPaused

  const doFetch = useCallback(async () => {
    // 深度扫描占用 fetch_bili_history 通道，轮询/手动同步先让位
    if (scanningRef.current) return
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

  // 单次抓一页（供 catchup / fullScan 复用，不动 lastUpdated/loading 状态由调用方掌控）
  const fetchPage = useCallback(async (cursorMax: number, cursorViewAt: number) => {
    return await invoke<{
      upserted: number
      cursor_max: number
      cursor_view_at: number
      items: ScanFeedItem[]
    }>(
      'fetch_bili_history',
      { ps, cursorMax, cursorViewAt },
    )
  }, [ps])

  // 查询 DB 里最大 view_at（=最近一次已知观看时间），无数据返回 0
  const getDbMaxViewAt = useCallback(async (): Promise<number> => {
    try {
      const page = await fetchBiliHistoryDb(0, 1, false)
      return page.items[0]?.view_at ?? 0
    } catch { return 0 }
  }, [])

  // 增量补齐：从最新页一直翻到 cursor_view_at <= 上次最大 view_at（或撞到底）
  // 仅在初始化时使用 — 默认 / 立即同步保持单页行为
  const catchupToKnown = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const knownMax = await getDbMaxViewAt()
      let cMax = 0, cVat = 0
      let pages = 0
      const PAGE_CAP = 30
      while (pages < PAGE_CAP) {
        const r = await fetchPage(cMax, cVat)
        pages += 1
        cMax = r.cursor_max
        cVat = r.cursor_view_at
        setCursor({ max: cMax, viewAt: cVat })
        setHasMoreRemote(cMax > 0)
        setLastUpdated(new Date())
        if (cMax === 0) break
        if (knownMax > 0 && cVat <= knownMax) break  // 已追上历史
      }

      // 触发自动建档
      const now = new Date()
      const todayStartSec = Math.floor(
        new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000,
      )
      const dbPage = await fetchBiliHistoryDb(0, 50, true)
      const todayUnlinked = dbPage.items.filter((i) => i.view_at >= todayStartSec && i.event_id === null)
      if (todayUnlinked.length > 0) setNewItems(todayUnlinked)
      setWindowClosed(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'BILI_WIN_CLOSED') { setWindowClosed(true); setError(null) }
      else if (msg !== 'BILI_HISTORY_BUSY') { setError(msg); setWindowClosed(false) }
    } finally {
      setIsLoading(false)
    }
  }, [fetchPage, getDbMaxViewAt])

  // 初次加载：增量翻页到上次最大 view_at（或 DB 为空时仅抓一页）
  useEffect(() => {
    if (enabled) catchupToKnown()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // 倒计时 + 自动刷新
  useEffect(() => {
    if (!enabled || intervalSeconds === 0) return
    countdownRef.current = intervalSeconds
    setCountdown(intervalSeconds)

    const timer = setInterval(() => {
      if (isPausedRef.current) return
      // 深度扫描中：冻结倒计时，等扫描结束后从头开始
      if (scanningRef.current) {
        countdownRef.current = intervalSeconds
        setCountdown(intervalSeconds)
        return
      }
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

  // 完整扫描：从最新一页一路翻到底（cursor.max=0）。每页结束都 setLastUpdated 让 UI 刷新。
  // 安全上限 200 页（约 6000 条）防止账号异常无限循环。
  const fullScan = useCallback(async () => {
    if (scanningRef.current) return
    scanningRef.current = true
    setIsLoading(true)
    setError(null)
    setScanProgress({ pages: 0, fetched: 0, done: false })

    // 启动前拍快照：当前 DB 中所有 bvid → 之后翻页发现不在此集合的就是"真·增量"
    // ⚠ 后端把 page_size clamp 到 [1,200]，所以这里必须 ≤200，否则 break 提前误触发
    const snapshot = new Set<string>()
    try {
      const PAGE_SIZE = 200
      const SAFETY = 1000  // 200 × 1000 = 20 万条上限
      for (let p = 0; p < SAFETY; p++) {
        const r = await fetchBiliHistoryDb(p, PAGE_SIZE, false)
        for (const it of r.items) snapshot.add(it.bvid)
        if (r.items.length < PAGE_SIZE) break
      }
    } catch { /* 拍快照失败 → 留空集合，所有都会被当作增量，无碍 */ }
    setScanSnapshotBvids(snapshot)

    try {
      let cMax = 0, cVat = 0
      let pages = 0, fetched = 0
      const PAGE_CAP = 2000
      while (pages < PAGE_CAP) {
        const r = await fetchPage(cMax, cVat)
        pages += 1
        fetched += r.upserted
        cMax = r.cursor_max
        cVat = r.cursor_view_at
        setCursor({ max: cMax, viewAt: cVat })
        setHasMoreRemote(cMax > 0)
        setScanProgress({ pages, fetched, done: false })
        setScanLastPage({ page: pages, items: r.items })
        setLastUpdated(new Date())
        if (cMax === 0) break
        // 轻微节流，避免触发风控
        await new Promise((res) => setTimeout(res, 250))
      }
      setScanProgress({ pages, fetched, done: true })
      setWindowClosed(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'BILI_WIN_CLOSED') { setWindowClosed(true); setError(null) }
      else if (msg !== 'BILI_HISTORY_BUSY') { setError(msg); setWindowClosed(false) }
      setScanProgress((p) => p ? { ...p, done: true } : null)
    } finally {
      scanningRef.current = false
      setIsLoading(false)
      // 快照保留到下次扫描启动再覆盖（让动画淡出期间仍能判定颜色）
    }
  }, [fetchPage])

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
    scanProgress, scanSnapshotBvids, scanLastPage,
    pause, resume, refresh, loadOlderHistory, fullScan, clearNew, setIntervalSeconds,
  }
}
