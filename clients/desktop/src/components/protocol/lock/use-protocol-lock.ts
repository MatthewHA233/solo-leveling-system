// 协议志 · 协议的数据：协议列表 + 进行中的一局 + 今天的各局 + 今天的感知（算有效时长）
// 改协议先落本地状态（界面立刻有反应）再写后端，失败整表重拉；局的状态以后端为准（后端执行拦截、到点结束）

import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { fetchPerceptionSpans, type PerceptionSpan } from '../../../lib/local-api'
import {
  cancelStop, createProtocol, deleteProtocol, fetchCurrentSession, fetchProtocols, fetchSessionsForDate,
  requestStop, SESSION_CHANGED_EVENT, startSession, updateProtocol,
  type LockProtocol, type LockProtocolPatch, type LockSession,
} from '../../../lib/protocol-api'

/** 今天有局时，感知数据隔多久重拉一次（有效时长跟着涨） */
const SPANS_REFRESH_MS = 60_000

export interface ProtocolLockData {
  readonly protocols: readonly LockProtocol[]
  readonly session: LockSession | null
  readonly todaySessions: readonly LockSession[]
  readonly todaySpans: readonly PerceptionSpan[]
  readonly loading: boolean
  readonly error: string | null
  readonly clearError: () => void
  readonly create: (name: string) => Promise<LockProtocol | null>
  readonly update: (id: string, patch: LockProtocolPatch) => void
  readonly remove: (id: string) => Promise<void>
  readonly start: (protocolId: string, minutes: number | null) => Promise<void>
  readonly stop: () => Promise<void>
  readonly cancel: () => Promise<void>
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useProtocolLock(): ProtocolLockData {
  const [protocols, setProtocols] = useState<readonly LockProtocol[]>([])
  const [session, setSession] = useState<LockSession | null>(null)
  const [todaySessions, setTodaySessions] = useState<readonly LockSession[]>([])
  const [todaySpans, setTodaySpans] = useState<readonly PerceptionSpan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const report = useCallback((e: unknown) => setError(errorText(e)), [])

  const refreshSessions = useCallback(async () => {
    const [current, today] = await Promise.all([fetchCurrentSession(), fetchSessionsForDate(new Date())])
    setSession(current)
    setTodaySessions(today)
  }, [])

  // 感知数据只用来算有效时长：拉不到就等下一轮，不打扰界面
  const pullSpans = useCallback(async () => {
    try {
      setTodaySpans(await fetchPerceptionSpans(new Date()))
    } catch {
      /* 下一轮再拉 */
    }
  }, [])

  const loadAll = useCallback(async () => {
    try {
      const [list] = await Promise.all([fetchProtocols(), refreshSessions()])
      setProtocols(list)
    } catch (e) {
      report(e)
    } finally {
      setLoading(false)
    }
  }, [refreshSessions, report])

  useEffect(() => { void loadAll() }, [loadAll])

  // 后端广播：开局 / 结束 / 申请结束 / 定时局到点
  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | undefined
    listen(SESSION_CHANGED_EVENT, () => { refreshSessions().catch(report) })
      .then((u) => { if (alive) unlisten = u; else u() })
      .catch(report)
    return () => {
      alive = false
      unlisten?.()
    }
  }, [refreshSessions, report])

  // 今天开过局才需要感知数据（算有效时长）；没有局就不拉
  const hasToday = todaySessions.length > 0
  useEffect(() => {
    if (!hasToday) return
    void pullSpans()
    const timer = window.setInterval(() => { void pullSpans() }, SPANS_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [hasToday, pullSpans])

  const reloadProtocols = useCallback(() => {
    fetchProtocols().then(setProtocols).catch(report)
  }, [report])

  const create = useCallback(async (name: string) => {
    try {
      const p = await createProtocol(name)
      setProtocols((prev) => [...prev, p])
      return p
    } catch (e) {
      report(e)
      return null
    }
  }, [report])

  const update = useCallback((id: string, patch: LockProtocolPatch) => {
    setProtocols((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
    updateProtocol(id, patch)
      .then((saved) => setProtocols((prev) => prev.map((p) => (p.id === id ? saved : p))))
      .catch((e) => {
        report(e)
        reloadProtocols()
      })
  }, [report, reloadProtocols])

  const remove = useCallback(async (id: string) => {
    try {
      await deleteProtocol(id)
      setProtocols((prev) => prev.filter((p) => p.id !== id))
    } catch (e) {
      report(e)
    }
  }, [report])

  // 局的变化都以后端为准：调完再整体刷新一次（后端也会广播，重复刷新无害）
  const runSession = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action()
      await refreshSessions()
    } catch (e) {
      report(e)
    }
  }, [refreshSessions, report])

  const start = useCallback((protocolId: string, minutes: number | null) =>
    runSession(() => startSession(protocolId, minutes)), [runSession])
  const stop = useCallback(() => runSession(requestStop), [runSession])
  const cancel = useCallback(() => runSession(cancelStop), [runSession])
  const clearError = useCallback(() => setError(null), [])

  return {
    protocols, session, todaySessions, todaySpans, loading, error, clearError,
    create, update, remove, start, stop, cancel,
  }
}
