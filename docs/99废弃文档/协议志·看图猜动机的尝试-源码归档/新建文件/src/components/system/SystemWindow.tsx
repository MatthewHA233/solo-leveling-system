// ══════════════════════════════════════════════
// 系统窗口 —— 协议志的「系统」：悬浮在桌面右上角，平时只显示、不挡鼠标（整窗穿透）
//   平时：一颗冰蓝小菱形 + 一行小字（此刻在推进云里的哪一颗 · 连续多久）
//   浮出（6 秒后收起）：开局 / 局结束 / 有把握地换了小目标 / 心流满 25 · 50 · 90 分钟
//   发问：内核提议了一颗新动机（system:ask）→ 浮出「要把……收进动机云吗？」+ 是 / 不是 / 聊聊——只有这时窗口可以点
//         「聊聊」把这个问题带进主窗口的聊天，在对话里协商
//   克制：细线、玻璃、字和光；不放分数，不评判
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { fetchCurrentSession, fetchSessionsForDate, SESSION_CHANGED_EVENT, type LockSession } from '../../lib/protocol-api'
import {
  answerMotive, ASK_EVENT, DISCUSS_EVENT, fetchSense, mapSense, SENSE_EVENT,
  type AskPayload, type GoalAnswer, type SenseState,
} from '../../lib/system-api'
import { flowMessage, formatSince, glyphGoal, senseMessage, sessionMessage, SHOW_MS, type SystemMessage } from './system-model'
import './system-window.css'

const FLOW_CHECK_MS = 30_000
const CLOCK_TICK_MS = 30_000
/** 问了没人理，这么久后收起（不算回答，过一阵还会再问） */
const ASK_TIMEOUT_MS = 25_000
const ACK: Record<GoalAnswer, string> = { yes: '收进云里了', no: '好，不收', chat: '去聊聊' }

type RawSense = Parameters<typeof mapSense>[0]

function setClickable(clickable: boolean) {
  getCurrentWindow().setIgnoreCursorEvents(!clickable).catch((e: unknown) => console.warn('[system] 设置鼠标穿透失败', e))
}

export default function SystemWindow() {
  const [sense, setSense] = useState<SenseState | null>(null)
  const [session, setSession] = useState<LockSession | null>(null)
  const [message, setMessage] = useState<SystemMessage | null>(null)
  const [ask, setAsk] = useState<AskPayload | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const senseRef = useRef<SenseState | null>(null)
  const sessionRef = useRef<LockSession | null>(null)
  const saidRef = useRef<Set<string>>(new Set())
  const hideTimer = useRef<number | undefined>(undefined)
  const askTimer = useRef<number | undefined>(undefined)

  const say = useCallback((m: SystemMessage | null) => {
    if (!m || saidRef.current.has(m.id)) return
    saidRef.current.add(m.id)
    setMessage(m)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setMessage(null), SHOW_MS)
  }, [])

  const closeAsk = useCallback(() => {
    window.clearTimeout(askTimer.current)
    setAsk(null)
    setClickable(false)
  }, [])

  // 平时整窗鼠标穿透：系统只负责被看见，不挡你点东西
  useEffect(() => { setClickable(false) }, [])

  // 感知：先拉一次当前状态，再跟着广播走
  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | undefined
    fetchSense()
      .then((s) => { if (alive) { senseRef.current = s; setSense(s) } })
      .catch(() => { /* 后端还没起来：等广播 */ })
    listen<RawSense>(SENSE_EVENT, (e) => {
      const next = mapSense(e.payload)
      say(senseMessage(senseRef.current, next))
      senseRef.current = next
      setSense(next)
    })
      .then((u) => { if (alive) unlisten = u; else u() })
      .catch((e: unknown) => console.warn('[system] 监听感知失败', e))
    return () => { alive = false; unlisten?.() }
  }, [say])

  // 发问：浮出问句，这时窗口可以点；没人理就收起
  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | undefined
    listen<AskPayload>(ASK_EVENT, (e) => {
      setMessage(null)
      setAsk(e.payload)
      setClickable(true)
      window.clearTimeout(askTimer.current)
      askTimer.current = window.setTimeout(closeAsk, ASK_TIMEOUT_MS)
    })
      .then((u) => { if (alive) unlisten = u; else u() })
      .catch((e: unknown) => console.warn('[system] 监听发问失败', e))
    return () => { alive = false; unlisten?.(); window.clearTimeout(askTimer.current) }
  }, [closeAsk])

  // 局：开局 / 结束各说一句（「第几局」按今天开过的局数）
  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | undefined
    const refresh = async (announce: boolean) => {
      const [current, today] = await Promise.all([fetchCurrentSession(), fetchSessionsForDate(new Date())])
      if (!alive) return
      if (announce) say(sessionMessage(sessionRef.current, current, today.length))
      sessionRef.current = current
      setSession(current)
    }
    refresh(false).catch(() => { /* 后端还没起来 */ })
    listen(SESSION_CHANGED_EVENT, () => { refresh(true).catch(() => {}) })
      .then((u) => { if (alive) unlisten = u; else u() })
      .catch((e: unknown) => console.warn('[system] 监听局变化失败', e))
    return () => { alive = false; unlisten?.() }
  }, [say])

  // 心流里程碑 + 小字里的「连续多久」
  useEffect(() => {
    const flow = window.setInterval(() => say(flowMessage(senseRef.current, Date.now(), saidRef.current)), FLOW_CHECK_MS)
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => { window.clearInterval(flow); window.clearInterval(clock); window.clearTimeout(hideTimer.current) }
  }, [say])

  const answer = async (a: GoalAnswer) => {
    if (!ask) return
    const asked = ask
    closeAsk()
    say({ id: `ack-${asked.key}-${Date.now()}`, line: ACK[a], sub: a === 'chat' ? asked.question : null })
    try {
      await answerMotive(asked, a)
      if (a === 'chat') await emitTo('main', DISCUSS_EVENT, { question: asked.question })
    } catch (e) {
      console.warn('[system] 回答没送到', e)
    }
  }

  if (sense?.source === 'off' && !session) return null

  // 系统提议、你还没答的动机只是猜测：后面带个问号
  const doing = sense?.source === 'self'
    ? 'Solevup'
    : sense?.goal ? `${glyphGoal(sense.goal)}${sense.confirmed ? '' : '？'}` : null
  const glyphText = [doing, sense?.sure && sense.sinceMs > 0 ? formatSince(now, sense.sinceMs) : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="sys-root">
      <div className="sys-glyph" data-live={session ? '1' : undefined}>
        <span className="sys-diamond" aria-hidden />
        {glyphText && <span className="sys-glyph-text">{glyphText}</span>}
      </div>
      {ask ? (
        <div className="sys-panel sys-ask" role="dialog" aria-label="系统发问">
          <div className="sys-head">
            <span className="sys-diamond sys-diamond-sm" aria-hidden />
            <span className="sys-label">系统</span>
          </div>
          <div className="sys-rule" />
          <div className="sys-line">{ask.question}</div>
          <div className="sys-actions">
            <button type="button" className="sys-btn sys-btn-main" onClick={() => void answer('yes')}>是</button>
            <button type="button" className="sys-btn" onClick={() => void answer('no')}>不是</button>
            <button type="button" className="sys-btn" onClick={() => void answer('chat')}>聊聊</button>
          </div>
        </div>
      ) : message && (
        <div key={message.id} className="sys-panel" role="status">
          <div className="sys-head">
            <span className="sys-diamond sys-diamond-sm" aria-hidden />
            <span className="sys-label">系统</span>
          </div>
          <div className="sys-rule" />
          <div className="sys-line">{message.line}</div>
          {message.sub && <div className="sys-sub">{message.sub}</div>}
        </div>
      )}
    </div>
  )
}
