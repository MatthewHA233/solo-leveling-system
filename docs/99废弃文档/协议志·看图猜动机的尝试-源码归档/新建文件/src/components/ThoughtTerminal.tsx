// 协议志 · 协议：思维终端——系统感知内核每一步在想什么（看了哪一眼、挑了哪颗、核实几分、提议了什么、问了什么），带耗时
//   每看一眼算一轮，轮与轮之间一条刻线写着这一轮一共花了多久；慢在哪一步一眼能看出来
//   停在底部时跟着滚；往上翻就不打扰你看

import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { fetchThoughts, mapThought, THOUGHT_EVENT, type RawThought, type Thought, type ThoughtKind } from '../../../lib/system-api'

const KEEP = 300
/** 这一步超过这么久就标出来 */
const SLOW_MS = 2000
/** 离底部这么近算「停在底部」 */
const STICK_PX = 24

const KIND_LABEL: Record<ThoughtKind, string> = {
  look: '看一眼',
  pick: '挑选',
  fit: '核实',
  propose: '提议',
  ask: '问你',
  skip: '跳过',
  error: '出错',
}

interface Round {
  readonly key: string
  readonly atMs: number
  readonly totalMs: number
  readonly lines: readonly Thought[]
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** 每个「看一眼」开一轮；开头不成轮的零散行（感知已关、前台是自己…）各自成一轮 */
function toRounds(lines: readonly Thought[]): Round[] {
  const rounds: Thought[][] = []
  for (const line of lines) {
    if (line.kind === 'look' || rounds.length === 0) rounds.push([line])
    else rounds[rounds.length - 1].push(line)
  }
  return rounds.map((r) => ({
    key: `${r[0].atMs}-${r[0].kind}`,
    atMs: r[0].atMs,
    totalMs: r.reduce((sum, l) => sum + (l.ms ?? 0), 0),
    lines: r,
  }))
}

export default function ThoughtTerminal() {
  const [lines, setLines] = useState<readonly Thought[]>([])
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | undefined
    fetchThoughts()
      .then((all) => { if (alive) setLines(all.slice(-KEEP)) })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    listen<RawThought>(THOUGHT_EVENT, (e) => {
      setLines((prev) => [...prev.slice(-(KEEP - 1)), mapThought(e.payload)])
    })
      .then((u) => { if (alive) unlisten = u; else u() })
      .catch((e: unknown) => console.warn('[thoughts] 监听失败', e))
    return () => { alive = false; unlisten?.() }
  }, [])

  // 停在底部就跟着新行滚
  useEffect(() => {
    const el = bodyRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const rounds = useMemo(() => toRounds(lines), [lines])

  const onScroll = () => {
    const el = bodyRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
  }

  return (
    <div className="tt-root">
      <div className="tt-head">
        <div className="pl-section-title">思维终端</div>
        <span className="pl-hint">系统每 10 秒看一眼当前窗口；每一步想了什么、花了多久都在这里</span>
      </div>
      {error && <div className="pl-error">{error}</div>}
      <div ref={bodyRef} className="tt-body ti-well" onScroll={onScroll}>
        {rounds.length === 0 && <div className="tt-empty">还没有动静：切到别的窗口待 10 秒试试</div>}
        {rounds.map((r) => (
          <div key={r.key} className="tt-round">
            <div className="tt-rule">
              <span>{clock(r.atMs)}</span>
              {r.totalMs > 0 && <span data-slow={r.totalMs > SLOW_MS * 2 ? '1' : undefined}>这一轮 {seconds(r.totalMs)}</span>}
            </div>
            {r.lines.map((l, i) => (
              <div key={i} className="tt-line" data-kind={l.kind}>
                <span className="tt-kind">{KIND_LABEL[l.kind] ?? l.kind}</span>
                <span className="tt-text">{l.text}</span>
                <span className="tt-ms" data-slow={l.ms !== null && l.ms > SLOW_MS ? '1' : undefined}>
                  {l.ms !== null ? `${l.ms}ms` : ''}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
