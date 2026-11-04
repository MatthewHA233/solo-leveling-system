// ══════════════════════════════════════════════
// 协议志 · 开局 ④ 人生金字塔：以终为始（照熊谷正寿的「梦想·人生金字塔」）
//   一页点阵纸上用铅笔画一座三层的塔：底层 精神｜健康｜教养 是地基（健康在正中、红笔框起来），
//   中层 工作｜家庭，塔尖 资产是前面几层长出来的结果；人生理念写在塔尖上方
//   目标直接写在格子里，字顺着塔的斜边排；点「改」塔下面出六个手写栏，塔跟着变
// ══════════════════════════════════════════════

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Chapter, System } from './genesis-parts'
import { AREAS, normalizePyramid, type Area, type AreaKey, type Pyramid } from './genesis-model'
import './pyramid.css'

/** 三层的分界线在塔高的哪里（塔尖 0，塔底 1） */
const T1 = 0.36
const T2 = 0.68
/** 健康那一格的左右边（占塔宽的百分比） */
const HEALTH_L = 35
const HEALTH_R = 65
/** 塔的左斜边在高度 t 处离左边多远（占塔宽的百分比） */
const edge = (t: number) => 50 * (1 - t)

/** 一格在塔里的位置（百分比）；lean = 哪边是斜边，slope = 斜边在格子顶上吃掉多宽，skip = 顶上太窄、先空出来的高度 */
interface Cell {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly lean: 'both' | 'left' | 'right' | null
  readonly slope: number
  readonly skip: number
}

const CELLS: Readonly<Record<AreaKey, Cell>> = {
  wealth: { left: edge(T1), top: 0, width: 100 - 2 * edge(T1), height: T1, lean: 'both', slope: 0.5, skip: 0.3 },
  work: { left: edge(T2), top: T1, width: 50 - edge(T2), height: T2 - T1, lean: 'left', slope: (edge(T1) - edge(T2)) / (50 - edge(T2)), skip: 0.08 },
  family: { left: 50, top: T1, width: 50 - edge(T2), height: T2 - T1, lean: 'right', slope: (edge(T1) - edge(T2)) / (50 - edge(T2)), skip: 0.08 },
  spirit: { left: 0, top: T2, width: HEALTH_L, height: 1 - T2, lean: 'left', slope: edge(T2) / HEALTH_L, skip: 0.08 },
  health: { left: HEALTH_L, top: T2, width: HEALTH_R - HEALTH_L, height: 1 - T2, lean: null, slope: 0, skip: 0.1 },
  culture: { left: HEALTH_R, top: T2, width: 100 - HEALTH_R, height: 1 - T2, lean: 'right', slope: edge(T2) / (100 - HEALTH_R), skip: 0.08 },
}

const TIERS = [
  { name: '第三层', label: '结果', top: 0 },
  { name: '第二层', label: '实现', top: T1 },
  { name: '第一层', label: '基本', top: T2 },
]

/** 人生理念按逗号分行，读起来像两句诗 */
const missionLines = (mission: string) => mission.split(/(?<=[，,；;])/).map((l) => l.trim()).filter(Boolean)

const FONT_MAX = 15
const FONT_MIN = 11

/** 格子大小是死的：哪一格字多装不下，整座塔的字号一起一点点调小（各格一样大，才像一个人写的） */
function useFitFont(content: string) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const tower = ref.current
    if (!tower) return
    const overflows = () => [...tower.querySelectorAll<HTMLElement>('.py-cell')].some((c) => c.scrollHeight > c.clientHeight + 1)
    const fit = () => {
      let size = FONT_MAX
      tower.style.setProperty('--fs', `${size}px`)
      while (size > FONT_MIN && overflows()) {
        size -= 0.5
        tower.style.setProperty('--fs', `${size}px`)
      }
    }
    fit()
    // 手写字体是后到的，到了字宽会变，再量一次
    document.fonts.ready.then(fit).catch(() => undefined)
    const ro = new ResizeObserver(fit)
    ro.observe(tower)
    return () => ro.disconnect()
  }, [content])
  return ref
}

/** 目标最后两个字粘在一起（U+2060 不许在这断行），折行时不会只剩一个字掉到下一行 */
const keepTail = (goal: string) => (goal.length > 4 ? goal.replace(/(.)(.)$/u, '$1⁠$2') : goal)

function AreaCell({ area, goals }: { readonly area: Area; readonly goals: readonly string[] }) {
  const cell = CELLS[area.key]
  const written = goals.filter((g) => g.trim())
  const style = {
    left: `${cell.left}%`, top: `${cell.top * 100}%`, width: `${cell.width}%`, height: `${cell.height * 100}%`,
    '--slope': `${cell.slope * 100}%`, '--skip': `${cell.skip * 100}%`,
  } as CSSProperties
  return (
    <div className="py-cell" data-area={area.key} style={style}>
      {(cell.lean === 'left' || cell.lean === 'both') && <span className="py-slant py-slant-l" aria-hidden />}
      {(cell.lean === 'right' || cell.lean === 'both') && <span className="py-slant py-slant-r" aria-hidden />}
      <span className="py-skip" aria-hidden />
      <h4 className="py-area"><span className="py-no">{area.no}</span>{area.name}</h4>
      {written.length > 0
        ? <ul className="py-goals">{written.map((g, i) => <li key={i}>{keepTail(g)}</li>)}</ul>
        : <p className="py-scope">{area.scope}</p>}
    </div>
  )
}

/** 铅笔画的塔：三层淡彩、轮廓描两遍、层线伸出塔外，健康那格用红笔框起来 */
function Drawing() {
  const id = useId().replace(/:/g, '')
  const y1 = T1 * 300
  const y2 = T2 * 300
  const x = (pct: number) => pct * 4
  return (
    <svg className="py-drawing" viewBox="0 0 400 300" preserveAspectRatio="none" aria-hidden>
      <defs>
        <filter id={`${id}c`} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9 0.6" numOctaves="2" seed="5" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.8 1.6" result="a" />
          <feComposite in="SourceGraphic" in2="a" operator="in" result="g" />
          <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="2" result="w" />
          <feDisplacementMap in="g" in2="w" scale="2.4" />
        </filter>
      </defs>
      <g filter={`url(#${id}c)`}>
        <polygon className="py-wash py-wash-3" points={`200,4 ${x(100 - edge(T1)) - 3},${y1 - 2} ${x(edge(T1)) + 3},${y1 - 2}`} />
        <polygon className="py-wash py-wash-2" points={`${x(edge(T1)) + 2},${y1 + 2} ${x(100 - edge(T1)) - 2},${y1 + 2} ${x(100 - edge(T2)) - 3},${y2 - 2} ${x(edge(T2)) + 3},${y2 - 2}`} />
        <polygon className="py-wash py-wash-1" points={`${x(edge(T2)) + 2},${y2 + 2} ${x(100 - edge(T2)) - 2},${y2 + 2} 396,298 4,298`} />

        <path className="py-reach" d={`M0 ${y1} H${x(edge(T1))} M${x(100 - edge(T1))} ${y1} H400 M0 ${y2} H${x(edge(T2))} M${x(100 - edge(T2))} ${y2} H400`} />
        <path className="py-pencil" d="M200 1 L399.5 299 L0.5 299 Z" />
        <path className="py-pencil py-pencil-2" d="M199 2.5 L398 298.2 L1.6 298.6 L199.6 1.2" />
        <path className="py-pencil" d={`M${x(edge(T1))} ${y1} H${x(100 - edge(T1))} M${x(edge(T2))} ${y2} H${x(100 - edge(T2))} M200 ${y1} V${y2}`} />
        <path className="py-red" d={`M${x(HEALTH_L) + 2} ${y2 + 3} H${x(HEALTH_R) - 2} V297 H${x(HEALTH_L) + 2} Z`} />
        <path className="py-red py-red-2" d={`M${x(HEALTH_L) + 4} ${y2 + 1.5} L${x(HEALTH_R) - 0.5} ${y2 + 4.5} L${x(HEALTH_R) - 3} 298.5 L${x(HEALTH_L) + 0.5} 296 Z`} />
      </g>
    </svg>
  )
}

function Tower({ pyramid }: { readonly pyramid: Pyramid }) {
  const ref = useFitFont(JSON.stringify(pyramid.areas))
  return (
    <div ref={ref} className="py-tower">
      <Drawing />
      {TIERS.map((t) => (
        <span key={t.name} className="py-tier" style={{ top: `${t.top * 100}%` }}>{t.name}<b>{t.label}</b></span>
      ))}
      {AREAS.map((a) => <AreaCell key={a.key} area={a} goals={pyramid.areas[a.key]} />)}
    </div>
  )
}

function Sheet({ pyramid, editing, onChange }: {
  readonly pyramid: Pyramid
  readonly editing: boolean
  readonly onChange: (p: Pyramid) => void
}) {
  const setGoals = (key: AreaKey, text: string) =>
    // 编辑时原样按行切（空行留着，回车才能换行）；点「改好了」再整理
    onChange({ ...pyramid, areas: { ...pyramid.areas, [key]: text.split('\n') } })
  return (
    <div className="py-page">
      <span className="nb-tape py-tape" aria-hidden />
      <header className="py-mission-block">
        <span className="py-caption">人生理念</span>
        {editing
          ? <textarea className="nb-field py-mission" rows={1} aria-label="人生理念" value={pyramid.mission} placeholder="一句话：这辈子到底想成为什么样的人" onChange={(e) => onChange({ ...pyramid, mission: e.target.value })} />
          : <p className="py-mission nb-ink">{missionLines(pyramid.mission).map((l, i) => <span key={i} className="nb-line"><span className="nb-mark nb-underline">{l}</span></span>)}</p>}
      </header>
      <Tower pyramid={pyramid} />
      {editing && (
        <div className="py-edit">
          {AREAS.map((a) => (
            <label key={a.key} className="py-edit-area">
              <span className="py-edit-name"><span className="py-no">{a.no}</span>{a.name}<small>{a.scope}</small></span>
              <textarea
                className="nb-field py-edit-field"
                value={pyramid.areas[a.key].join('\n')}
                placeholder="一行一个目标"
                onChange={(e) => setGoals(a.key, e.target.value)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PyramidSheet({ pyramid, now, busy, locked, onChange, onPropose, next }: {
  readonly pyramid: Pyramid | null
  readonly now: boolean
  readonly busy: boolean
  /** 别的章的 AI 正在跑：这一章的 AI 按钮先按不了 */
  readonly locked: boolean
  readonly onChange: (p: Pyramid) => void
  readonly onPropose: () => void
  /** 这一章是当前步骤时，塔下面的「继续」 */
  readonly next?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  /** 改好了：按存进去的规矩整理一遍（空行去掉、每格最多 5 个），看到的就是存下的 */
  const toggle = () => {
    if (editing && pyramid) onChange(normalizePyramid(pyramid) ?? pyramid)
    setEditing((v) => !v)
  }
  return (
    <Chapter
      n={4}
      title="人生金字塔"
      sub="以终为始：先想清楚终点"
      now={now}
      actions={pyramid && !busy && (
        <>
          <button type="button" className="gn-head-btn" disabled={locked} onClick={onPropose}>重新提议</button>
          <button type="button" className="gn-head-btn" data-on={editing ? '1' : undefined} onClick={toggle}>{editing ? '改好了' : '改'}</button>
        </>
      )}
    >
      {now && <System>先想清楚终点，再动手。我照熊谷正寿的「梦想·人生金字塔」，把你想做成的事分进六个格子：最底下的健康、精神、教养是地基，中间是工作和家庭，塔尖的资产是前面几层长出来的结果。哪里不对，点「改」直接改。</System>}
      {busy && <System><span className="gn-busy">系统正在把愿望分进金字塔……</span></System>}
      {pyramid && !busy && <Sheet pyramid={pyramid} editing={editing} onChange={onChange} />}
      {!pyramid && !busy && <div className="gn-actions"><button type="button" className="ti-key gn-go" disabled={locked} onClick={onPropose}>让系统提议金字塔</button></div>}
      {pyramid && !busy && next}
    </Chapter>
  )
}
