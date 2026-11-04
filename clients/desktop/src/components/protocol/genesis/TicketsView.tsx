// ══════════════════════════════════════════════
// 协议志 · 开局 ⑤ 未来车票：把金字塔放到时间上
//   每个锚点 = 一张车票：左边票根是日期，撕线右边手写「开往」那天的样子，红印章盖着还剩几天
//   车票沿一条铁轨排下去，起点是今天；点「改」票面直接变成手写栏
// ══════════════════════════════════════════════

import { useState, type CSSProperties, type ReactNode } from 'react'
import { Chapter, System } from './genesis-parts'
import { daysUntil, normalizeTimeline, type Milestone } from './genesis-model'
import { toLocalDateStr } from '../../../lib/local-api'
import { STRIP_PAPERS, hash, jitter } from './notebook-ink'
import './tickets.css'

const WHEN = /^\d{4}-\d{2}(-\d{2})?$/

/** 写了一半的票：日期不成样子、或者没写开往哪儿（整张空着的不算，存的时候直接撕掉） */
const halfWritten = (m: Milestone) => (m.when.trim() !== '' || m.what.trim() !== '') && (!WHEN.test(m.when) || m.what.trim() === '')

/** 老年表里 AI 写的「到那天，」开头，票面上不要 */
const destination = (what: string) => what.replace(/^到那天[，,、：:\s]*/, '')

/** 印章上的字：还剩几天 / 就是今天 / 已经过了 */
function stampText(when: string): { readonly text: string; readonly past: boolean } | null {
  if (!WHEN.test(when)) return null
  const d = daysUntil(when)
  if (d > 0) return { text: `D-${d}`, past: false }
  if (d === 0) return { text: '今天', past: false }
  return { text: '已过', past: true }
}

function Ticket({ index, m, editing, onSet, onRemove }: {
  readonly index: number
  readonly m: Milestone
  readonly editing: boolean
  readonly onSet: (patch: Partial<Milestone>) => void
  readonly onRemove: () => void
}) {
  const seed = hash(`${m.when}${index}`)
  const [year, month = '', day = ''] = m.when.split('-')
  const stamp = stampText(m.when)
  const style = {
    '--rot': `${jitter(seed, 0.9).toFixed(2)}deg`,
    '--stub': STRIP_PAPERS[index % STRIP_PAPERS.length],
    '--stamp-rot': `${Math.round(jitter(seed, 14, 7)) - 8}deg`,
  } as CSSProperties
  return (
    <li className="tk-ticket" style={style}>
      <span className="tk-station" aria-hidden />
      <div className="tk-face">
        <div className="tk-stub">
          {editing
            ? <input className="nb-field tk-when-field" value={m.when} placeholder="YYYY-MM-DD" aria-label={`第 ${index + 1} 张车票的日期`} data-bad={m.when && !WHEN.test(m.when) ? '1' : undefined} onChange={(e) => onSet({ when: e.target.value.trim() })} />
            : (
              <>
                <span className="tk-year">{year}</span>
                <span className="tk-date">{month}{day && `.${day}`}</span>
              </>
            )}
          <span className="tk-no">No.{String(index + 1).padStart(2, '0')}</span>
        </div>
        <div className="tk-body">
          <span className="tk-label">开往</span>
          {editing
            ? <input className="nb-field tk-what" value={destination(m.what)} placeholder="那天是什么样子" aria-label={`第 ${index + 1} 张车票开往哪儿`} onChange={(e) => onSet({ what: e.target.value })} />
            : <span className="tk-what">{destination(m.what)}</span>}
        </div>
      </div>
      {editing
        ? <button type="button" className="nb-pencil-btn tk-remove" aria-label="撕掉这张车票" onClick={onRemove}>×</button>
        : stamp && <span className="nb-stamp tk-stamp" data-past={stamp.past ? '1' : undefined}>{stamp.text}</span>}
    </li>
  )
}

function Line({ timeline, editing, onChange }: {
  readonly timeline: readonly Milestone[]
  readonly editing: boolean
  readonly onChange: (t: Milestone[]) => void
}) {
  const set = (i: number, patch: Partial<Milestone>) => onChange(timeline.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  return (
    <div className="tk-line">
      <span className="tk-rail" aria-hidden />
      <div className="tk-origin"><span className="tk-station" aria-hidden />今天 · {toLocalDateStr(new Date()).replace(/-/g, '.')} 出发</div>
      <ol className="tk-tickets">
        {timeline.map((m, i) => (
          <Ticket key={i} index={i} m={m} editing={editing} onSet={(p) => set(i, p)} onRemove={() => onChange(timeline.filter((_, j) => j !== i))} />
        ))}
      </ol>
      {editing && <button type="button" className="nb-pencil-btn tk-add" onClick={() => onChange([...timeline, { when: '', what: '' }])}>+ 加一张车票</button>}
      {editing && timeline.some(halfWritten) && <p className="gn-hint">日期写成 2027-03-01 这样，开往哪儿也要写上，才收得好</p>}
    </div>
  )
}

export default function TicketsView({ timeline, now, busy, locked, onChange, onPropose, next }: {
  readonly timeline: readonly Milestone[] | null
  readonly now: boolean
  readonly busy: boolean
  /** 别的章的 AI 正在跑：这一章的 AI 按钮先按不了 */
  readonly locked: boolean
  readonly onChange: (t: Milestone[]) => void
  readonly onPropose: () => void
  /** 这一章是当前步骤时，车票下面的「收下」 */
  readonly next?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const halfDone = editing && (timeline?.some(halfWritten) ?? false)
  /** 改好了：按存进去的规矩整理一遍（空票撕掉、按日期排好），看到的就是存下的 */
  const toggle = () => {
    if (editing && timeline) onChange(normalizeTimeline(timeline) ?? [])
    setEditing((v) => !v)
  }
  return (
    <Chapter
      n={5}
      title="未来车票"
      sub="从最近的一站，倒推回今天"
      now={now}
      actions={timeline && !busy && (
        <>
          <button type="button" className="gn-head-btn" disabled={locked} onClick={onPropose}>重新提议</button>
          <button type="button" className="gn-head-btn" data-on={editing ? '1' : undefined} disabled={halfDone} onClick={toggle}>{editing ? '改好了' : '改'}</button>
        </>
      )}
    >
      {now && <System>把塔放到时间上：几张有日期的车票，从最近的一站倒推回今天。第一站，一个月内就要到得了。</System>}
      {busy && <System><span className="gn-busy">系统正在把它们放到时间上……</span></System>}
      {timeline && !busy && <Line timeline={timeline} editing={editing} onChange={onChange} />}
      {!timeline && !busy && <div className="gn-actions"><button type="button" className="ti-key gn-go" disabled={locked} onClick={onPropose}>让系统画车票</button></div>}
      {timeline && !busy && next}
    </Chapter>
  )
}
