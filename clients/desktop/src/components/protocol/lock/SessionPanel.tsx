// 协议志 · 协议：进行中的这一局——主舞台只放「现在这一局在做什么」；
// 今天的有效时长 / 拦下几次默认收起（不当记分牌，想看再点开）；结束按强度走：软 / 中先申请再冷却，硬锁到点前没有结束键

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { PerceptionSpan } from '../../../lib/local-api'
import type { LockSession } from '../../../lib/protocol-api'
import { formatClock, formatDuration, parseLocalTime, STRENGTH_META, tallyFocus } from './lock-model'

const FOLD_KEY = 'slu.protocol.lock.tallyOpen'
const EXT_CHECK_MS = 15_000
const SLOW_TICK_MS = 30_000
const FAST_TICK_MS = 1_000

interface ExtStatus {
  connected: boolean
}

export interface SessionPanelProps {
  readonly session: LockSession
  /** 这份协议的每日目标（分钟）；协议被删了就是 null */
  readonly dailyTargetMin: number | null
  readonly todaySessions: readonly LockSession[]
  readonly todaySpans: readonly PerceptionSpan[]
  readonly onStop: () => Promise<void>
  readonly onCancel: () => Promise<void>
  /** 改这份协议的白名单（下一局生效） */
  readonly onEdit: () => void
}

function loadFold(): boolean {
  try { return localStorage.getItem(FOLD_KEY) === '1' } catch { return false }
}

/** 浏览器那一半靠扩展执行：扩展不在线时提醒一句 */
function useExtensionOnline(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const check = () => {
      invoke<ExtStatus>('focus_lock_ext_status')
        .then((s) => { if (alive) setOnline(s.connected) })
        .catch(() => { if (alive) setOnline(null) })
    }
    check()
    const timer = window.setInterval(check, EXT_CHECK_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  return online
}

export default function SessionPanel({ session, dailyTargetMin, todaySessions, todaySpans, onStop, onCancel, onEdit }: SessionPanelProps) {
  const [open, setOpen] = useState(loadFold)
  const [now, setNow] = useState(() => new Date())
  const [busy, setBusy] = useState(false)
  const extOnline = useExtensionOnline()

  const canStopAt = session.canStopAt ? parseLocalTime(session.canStopAt) : null
  const cooling = session.strength !== 'hard' && session.stopRequestedAt !== null && canStopAt !== null && now < canStopAt

  // 冷却倒计时要按秒走，平时半分钟走一格就够（已进行多久只显示到分钟）
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), cooling ? FAST_TICK_MS : SLOW_TICK_MS)
    return () => window.clearInterval(timer)
  }, [cooling])

  const toggle = () => {
    const next = !open
    setOpen(next)
    try { localStorage.setItem(FOLD_KEY, next ? '1' : '0') } catch { /* 记不住就算了 */ }
  }

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }

  const started = parseLocalTime(session.startedAt)
  const elapsed = (now.getTime() - started.getTime()) / 1000
  const plannedEnd = session.plannedEndAt ? parseLocalTime(session.plannedEndAt) : null
  const remaining = plannedEnd ? (plannedEnd.getTime() - now.getTime()) / 1000 : null
  const tally = open ? tallyFocus(now, todaySpans, todaySessions, now) : null
  const coolLeft = cooling && canStopAt ? Math.ceil((canStopAt.getTime() - now.getTime()) / 1000) : 0
  const intercepts = todaySessions.reduce((s, x) => s + x.interceptCount, 0)

  return (
    <div>
      <div className="pl-live-label">这一局</div>
      <div className="pl-live-name">{session.protocolName}</div>
      <div className="pl-live-meta">
        <span><b>{formatClock(session.startedAt)}</b> 开局 · 已进行 <b>{formatDuration(elapsed)}</b></span>
        {plannedEnd && remaining !== null && (
          <span>到 <b>{formatClock(session.plannedEndAt ?? '')}</b> · 还剩 <b>{formatDuration(remaining)}</b></span>
        )}
        <span>强度 <b>{STRENGTH_META[session.strength].label}</b></span>
      </div>
      {extOnline === false && (
        <div className="pl-warn" style={{ marginTop: 10 }}>
          专注锁扩展不在线：浏览器里的网站这会儿没拦（应用照常拦）。在 Chrome 里打开扩展就好
        </div>
      )}

      <div className="pl-stop">
        {session.strength === 'hard' ? (
          <span className="pl-hint">硬锁：{formatClock(session.plannedEndAt ?? '')} 之前不能结束</span>
        ) : session.stopRequestedAt === null ? (
          <button type="button" className="ti-key" disabled={busy} style={{ height: 30, padding: '0 14px', fontSize: 12.5 }} onClick={() => act(onStop)}>
            结束这一局
          </button>
        ) : (
          <>
            {cooling ? (
              <span className="pl-hint">冷却中，还要等 {Math.floor(coolLeft / 60)}:{String(coolLeft % 60).padStart(2, '0')}</span>
            ) : (
              <button type="button" className="ti-key ti-key-danger" disabled={busy} style={{ height: 30, padding: '0 14px', fontSize: 12.5 }} onClick={() => act(onStop)}>
                确认结束
              </button>
            )}
            <button type="button" className="ti-key" disabled={busy} style={{ height: 30, padding: '0 14px', fontSize: 12.5 }} onClick={() => act(onCancel)}>
              撤回，接着做
            </button>
          </>
        )}
        <button type="button" className="pl-fold" style={{ marginLeft: 'auto', letterSpacing: 0, fontSize: 12 }} onClick={onEdit}>
          改白名单（下一局生效）
        </button>
      </div>

      <div className="pl-rule" />
      <div className="pl-section">
        <button type="button" className="pl-fold" aria-expanded={open} onClick={toggle}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          今天
        </button>
        {tally && (
          <div className="pl-tally">
            <span>专注 <b>{formatDuration(tally.focusSeconds)}</b>{dailyTargetMin ? <> / {formatDuration(dailyTargetMin * 60)}</> : null}</span>
            {tally.graySeconds > 0 && <span>灰色地带 <b>{formatDuration(tally.graySeconds)}</b></span>}
            <span>开了 <b>{todaySessions.length}</b> 局</span>
            {intercepts > 0 && <span>拦下 <b>{intercepts}</b> 次</span>}
          </div>
        )}
      </div>
    </div>
  )
}
