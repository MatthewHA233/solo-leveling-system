// ══════════════════════════════════════════════
// DatePickerPopover — Neon Brutalism 风格日历
// 锚定到顶部栏 DATE 触发器下方，外部点击关闭
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { theme, hud } from '../theme'
import { fetchManicTimeSpans, fetchBiliDayCounts } from '../lib/local-api'
import type { BiliDayCount } from '../lib/local-api'
import Tooltip from './Tooltip'

interface Props {
  readonly anchorRef: React.RefObject<HTMLElement | null>
  readonly value: Date
  readonly onChange: (d: Date) => void
  readonly onClose: () => void
  /**
   * 'tags'  → 默认模式，圆环显示当日 ManicTime 标签时段（用于全局日期选择）
   * 'bili'  → 显示当日 B 站观看数 / 已下载数（用于 BiliHistoryDialog）
   */
  readonly mode?: 'tags' | 'bili'
}

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate()
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 解析 "YYYY-MM-DD HH:MM:SS" → 当日相对分钟（裁剪到 [0, 1440]）
function dtToDayMinute(s: string, dayStr: string): number | null {
  if (!s.startsWith(dayStr)) return null
  const t = s.slice(11)
  const [h = '0', m = '0'] = t.split(':')
  return Number(h) * 60 + Number(m)
}

// 一段标签时间区间（当日相对分钟，已裁剪到 [0,1440]）
type TagRange = readonly [number, number]

// 模块级缓存：跨打开/关闭日历保留已抓数据
const tagRangesCache = new Map<string, TagRange[]>()
const inflight = new Map<string, Promise<TagRange[]>>()
async function getTagRangesForDay(d: Date): Promise<TagRange[]> {
  const key = dayKey(d)
  if (tagRangesCache.has(key)) return tagRangesCache.get(key)!
  if (inflight.has(key)) return inflight.get(key)!
  const p = (async () => {
    try {
      const spans = await fetchManicTimeSpans(d)
      const out: TagRange[] = []
      for (const s of spans) {
        if (s.track !== 'tags') continue
        const a = dtToDayMinute(s.start_at, key)
        const b = dtToDayMinute(s.end_at, key)
        if (a == null || b == null) continue
        const lo = Math.max(0, a)
        const hi = Math.min(1440, b)
        if (hi > lo) out.push([lo, hi])
      }
      tagRangesCache.set(key, out)
      return out
    } catch {
      tagRangesCache.set(key, [])
      return []
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

// 周一为一周第一天
function buildMonthGrid(viewYear: number, viewMonth: number): Date[] {
  const first = new Date(viewYear, viewMonth, 1)
  // 0=Sun → 6, 1=Mon → 0 ... 周一为首列
  const dow = (first.getDay() + 6) % 7
  const start = new Date(viewYear, viewMonth, 1 - dow)
  const cells: Date[] = []
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  }
  return cells
}

// ── 月度 B 站日计数缓存（按 "YYYY-MM" 缓存整月，跨打开复用） ──
const biliMonthCache = new Map<string, Map<string, BiliDayCount>>()
const biliMonthInflight = new Map<string, Promise<Map<string, BiliDayCount>>>()
async function getBiliCountsForMonth(y: number, m: number): Promise<Map<string, BiliDayCount>> {
  const key = `${y}-${String(m + 1).padStart(2, '0')}`
  if (biliMonthCache.has(key)) return biliMonthCache.get(key)!
  if (biliMonthInflight.has(key)) return biliMonthInflight.get(key)!
  const from = `${key}-01`
  const lastDay = new Date(y, m + 1, 0).getDate()
  const to = `${key}-${String(lastDay).padStart(2, '0')}`
  const p = (async () => {
    try {
      const rows = await fetchBiliDayCounts(from, to)
      const map = new Map<string, BiliDayCount>()
      for (const r of rows) map.set(r.day, r)
      biliMonthCache.set(key, map)
      return map
    } catch {
      const empty = new Map<string, BiliDayCount>()
      biliMonthCache.set(key, empty)
      return empty
    } finally {
      biliMonthInflight.delete(key)
    }
  })()
  biliMonthInflight.set(key, p)
  return p
}

export default function DatePickerPopover({ anchorRef, value, onChange, onClose, mode = 'tags' }: Props) {
  const [viewMonth, setViewMonth] = useState(() => ({ y: value.getFullYear(), m: value.getMonth() }))
  const popRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // 计算锚点位置
  useEffect(() => {
    const update = () => {
      const a = anchorRef.current
      if (!a) return
      const r = a.getBoundingClientRect()
      setPos({ left: Math.round(r.left + r.width / 2), top: Math.round(r.bottom + 8) })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef])

  // 外部点击 / Esc 关闭
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  const today = useMemo(() => startOfDay(new Date()), [])
  const cells = useMemo(() => buildMonthGrid(viewMonth.y, viewMonth.m), [viewMonth])

  // 每个可见日期的标签时间段（tags 模式）
  const [tagRanges, setTagRanges] = useState<Record<string, TagRange[]>>(() => {
    const init: Record<string, TagRange[]> = {}
    for (const [k, v] of tagRangesCache) init[k] = v
    return init
  })
  useEffect(() => {
    if (mode !== 'tags') return
    let cancelled = false
    const todayKey = dayKey(today)
    const targets = cells.filter((d) => dayKey(d) <= todayKey)
    ;(async () => {
      for (const d of targets) {
        if (cancelled) return
        const k = dayKey(d)
        if (tagRangesCache.has(k)) {
          if (tagRanges[k] === undefined) setTagRanges((p) => ({ ...p, [k]: tagRangesCache.get(k)! }))
          continue
        }
        const v = await getTagRangesForDay(d)
        if (cancelled) return
        setTagRanges((p) => ({ ...p, [k]: v }))
      }
    })()
    return () => { cancelled = true }
  }, [cells, today, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // B 站日计数（bili 模式） — 一次性按月拉取，覆盖当前 viewMonth
  const [biliCounts, setBiliCounts] = useState<Map<string, BiliDayCount>>(() => new Map())
  useEffect(() => {
    if (mode !== 'bili') return
    let cancelled = false
    ;(async () => {
      const map = await getBiliCountsForMonth(viewMonth.y, viewMonth.m)
      if (cancelled) return
      setBiliCounts(map)
    })()
    return () => { cancelled = true }
  }, [viewMonth, mode])

  const goPrevMonth = () => setViewMonth((p) => p.m === 0 ? { y: p.y - 1, m: 11 } : { y: p.y, m: p.m - 1 })
  const goNextMonth = () => setViewMonth((p) => p.m === 11 ? { y: p.y + 1, m: 0 } : { y: p.y, m: p.m + 1 })
  const goPrevYear  = () => setViewMonth((p) => ({ y: p.y - 1, m: p.m }))
  const goNextYear  = () => setViewMonth((p) => ({ y: p.y + 1, m: p.m }))
  const goToday     = () => {
    setViewMonth({ y: today.getFullYear(), m: today.getMonth() })
    onChange(new Date())
    onClose()
  }

  if (!pos) return null

  return (
    <>
      <style>{`
        @keyframes dpp-pop {
          from { opacity: 0; transform: translate(-50%, -4px) scale(0.96); }
          to   { opacity: 1; transform: translate(-50%, 0)   scale(1);    }
        }
        .dpp-cell {
          position: relative;
          width: 30px; height: ${mode === 'bili' ? 38 : 28}px;
          display: flex;
          flex-direction: ${mode === 'bili' ? 'column' : 'row'};
          align-items: center; justify-content: center;
          gap: ${mode === 'bili' ? 1 : 0}px;
          padding-top: ${mode === 'bili' ? 2 : 0}px;
          font-family: ${theme.fontMono};
          font-size: 11px; font-weight: 600;
          letter-spacing: 0.3px;
          background: transparent;
          border: 1px solid transparent;
          color: ${theme.textPrimary};
          cursor: pointer;
          transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
          border-radius: 4px;
        }
        .dpp-cell:hover { background: ${theme.glassHover}; border-color: ${theme.glassBorder}; }
        .dpp-cell.muted { color: ${theme.textMuted}; }
        .dpp-cell.today {
          color: ${theme.electricBlue};
          text-shadow: 0 0 6px ${theme.electricBlue}AA;
        }
        .dpp-cell.selected {
          background: rgba(0,229,255,0.18);
          border-color: ${theme.electricBlue};
          color: ${theme.electricBlue};
          text-shadow: 0 0 8px ${theme.electricBlue}AA;
          box-shadow: 0 0 10px ${theme.electricBlue}55, inset 0 0 6px rgba(0,229,255,0.18);
        }
        .dpp-nav {
          display: flex; align-items: center; justify-content: center;
          width: 22px; height: 22px;
          background: transparent;
          border: 1px solid ${theme.glassBorder};
          color: ${theme.textSecondary};
          cursor: pointer;
          border-radius: 3px;
          transition: all 0.12s ease;
        }
        .dpp-nav:hover { color: ${theme.electricBlue}; border-color: ${theme.hudFrame}; box-shadow: 0 0 6px ${theme.electricBlue}55; }
      `}</style>
      <div
        ref={popRef}
        style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          transform: 'translateX(-50%)',
          zIndex: 1000,
          width: 260,
          padding: 12,
          background: theme.hudFill,
          border: `1px solid ${theme.hudFrame}`,
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          clipPath: hud.chamfer8,
          boxShadow: `0 8px 32px rgba(0,0,0,0.6), 0 0 24px ${theme.hudHalo}, inset 0 1px 0 rgba(255,255,255,0.04)`,
          animation: 'dpp-pop 0.14s ease-out',
          color: theme.textPrimary,
        }}
      >
        {/* 扫描线叠加 */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: hud.scanlines, opacity: 0.6, clipPath: hud.chamfer8,
        }} />

        {/* Header: 年月 + 导航 */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <Tooltip content="上一年"><button className="dpp-nav" onClick={goPrevYear}>«</button></Tooltip>
            <Tooltip content="上个月">
            <button className="dpp-nav" onClick={goPrevMonth}>
              <ChevronLeft size={12} />
            </button>
            </Tooltip>
          </div>
          <div style={{
            fontFamily: theme.fontDisplay,
            fontSize: 12, fontWeight: 700, letterSpacing: 2,
            color: theme.electricBlue,
            textShadow: `0 0 8px ${theme.electricBlue}88`,
          }}>
            {viewMonth.y} · {String(viewMonth.m + 1).padStart(2, '0')}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <Tooltip content="下个月">
            <button className="dpp-nav" onClick={goNextMonth}>
              <ChevronRight size={12} />
            </button>
            </Tooltip>
            <Tooltip content="下一年"><button className="dpp-nav" onClick={goNextYear}>»</button></Tooltip>
          </div>
        </div>

        {/* Weekday labels */}
        <div style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 2,
          marginBottom: 4,
          paddingBottom: 6,
          borderBottom: `1px solid ${theme.glassBorder}`,
        }}>
          {WEEK_LABELS.map((w, i) => (
            <div key={w} style={{
              textAlign: 'center',
              fontSize: 9,
              letterSpacing: 1,
              fontWeight: 700,
              color: i >= 5 ? theme.shadowPurple : theme.textMuted,
              fontFamily: theme.fontBody,
            }}>{w}</div>
          ))}
        </div>

        {/* Days grid */}
        <div style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 2,
          marginTop: 4,
        }}>
          {cells.map((d) => {
            const isCurMonth = d.getMonth() === viewMonth.m
            const isToday = isSameDay(d, today)
            const isSel = isSameDay(d, value)
            const k = dayKey(d)
            const cls = [
              'dpp-cell',
              !isCurMonth && 'muted',
              isToday && 'today',
              isSel && 'selected',
            ].filter(Boolean).join(' ')

            if (mode === 'bili') {
              const c = biliCounts.get(k)
              const watched = c?.watched ?? 0
              const downloaded = c?.downloaded ?? 0
              const tip = watched > 0
                ? `观看 ${watched}${downloaded > 0 ? ` · 下载 ${downloaded}` : ''}`
                : ''
              return (
                <Tooltip key={d.toISOString()} content={tip} disabled={!tip}>
                <button className={cls} onClick={() => { onChange(new Date(d)); onClose() }}>
                  <span style={{ position: 'relative', zIndex: 1, lineHeight: 1 }}>{d.getDate()}</span>
                  <BiliCountBadge watched={watched} downloaded={downloaded} active={isSel || isToday} />
                </button>
                </Tooltip>
              )
            }

            const ranges = tagRanges[k] ?? []
            const totalMin = ranges.reduce((sum, [a, b]) => sum + (b - a), 0)
            return (
              <Tooltip
                key={d.toISOString()}
                content={totalMin > 0 ? `已记录 ${Math.floor(totalMin / 60)}h ${totalMin % 60}m` : ''}
                disabled={totalMin === 0}
              >
              <button
                className={cls}
                onClick={() => { onChange(new Date(d)); onClose() }}
              >
                {ranges.length > 0 && <DayRing ranges={ranges} active={isSel || isToday} />}
                <span style={{ position: 'relative', zIndex: 1 }}>{d.getDate()}</span>
              </button>
              </Tooltip>
            )
          })}
        </div>

        {/* Footer: TODAY 快捷 */}
        <div style={{
          position: 'relative',
          marginTop: 10, paddingTop: 8,
          borderTop: `1px solid ${theme.glassBorder}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{
            fontFamily: theme.fontMono, fontSize: 9.5,
            color: theme.textMuted, letterSpacing: 0.5,
          }}>
            {today.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })}
          </span>
          <button
            onClick={goToday}
            style={{
              fontFamily: theme.fontDisplay,
              fontSize: 10, fontWeight: 700, letterSpacing: 1.8,
              color: theme.electricBlue,
              background: `${theme.electricBlue}10`,
              border: `1px solid ${theme.electricBlue}55`,
              padding: '4px 10px',
              cursor: 'pointer',
              textShadow: `0 0 6px ${theme.electricBlue}AA`,
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = `${theme.electricBlue}22`
              e.currentTarget.style.boxShadow = `0 0 10px ${theme.electricBlue}77`
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = `${theme.electricBlue}10`
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            TODAY
          </button>
        </div>
      </div>
    </>
  )
}

// 单元格底部的 B 站计数：watched · downloaded
// 没有观看 → 不渲染；只有观看 → 单个青色数字；有下载 → 青·绿
function BiliCountBadge({ watched, downloaded, active }: {
  watched: number; downloaded: number; active: boolean
}) {
  if (watched === 0) return null
  const cyan = active ? theme.electricBlue : `${theme.electricBlue}cc`
  const green = theme.expGreen
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      fontFamily: theme.fontMono, fontSize: 8.5, fontWeight: 700,
      letterSpacing: 0.2, lineHeight: 1,
      position: 'relative', zIndex: 1,
    }}>
      <span style={{ color: cyan, textShadow: active ? `0 0 4px ${cyan}` : undefined }}>
        {watched}
      </span>
      {downloaded > 0 && (
        <>
          <span style={{ color: theme.textMuted, opacity: 0.5 }}>·</span>
          <span style={{ color: green, textShadow: `0 0 4px ${green}99` }}>
            {downloaded}
          </span>
        </>
      )}
    </span>
  )
}

// 单元格背后的环形：把当日标签时间段作为多段弧绘制
// 24h 表盘布局：正午（720min）在顶部，午夜（0/1440min）在底部，
// 顺时针推进 → 06:00 在左、18:00 在右（白天=上半圈，夜间=下半圈）
function DayRing({ ranges, active }: { ranges: readonly TagRange[]; active: boolean }) {
  const SIZE = 26
  const STROKE = 1.6
  const R = (SIZE - STROKE) / 2
  const C = 2 * Math.PI * R
  const color = active ? theme.electricBlue : theme.flameTeal

  // SVG <circle> 的 dash 起点在 3 点钟（最右），顺时针推进。
  // 加上 rotate(-90deg) 后起点变为 12 点钟。
  // 时间分钟 m → dash 偏移：noon(720) 映到 0，时间正向流逝顺时针走。
  const minToOffset = (m: number) => ((m - 720 + 1440) % 1440) / 1440 * C

  return (
    <svg
      width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}
      style={{
        position: 'absolute',
        left: '50%', top: '50%',
        transform: 'translate(-50%, -50%) rotate(-90deg)',
        pointerEvents: 'none',
        zIndex: 0,
        filter: `drop-shadow(0 0 4px ${color}77)`,
      }}
    >
      {/* 底环：极淡，作为时间表盘背景 */}
      <circle
        cx={SIZE / 2} cy={SIZE / 2} r={R}
        fill="none"
        stroke={`${color}1f`}
        strokeWidth={STROKE * 0.6}
      />
      {/* 多段弧：每个 range 一段 */}
      {ranges.map(([a, b], i) => {
        const arcLen = (b - a) / 1440 * C
        const off = minToOffset(a)
        return (
          <circle
            key={i}
            cx={SIZE / 2} cy={SIZE / 2} r={R}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${arcLen} ${C}`}
            strokeDashoffset={-off}
            opacity={active ? 1 : 0.85}
          />
        )
      })}
    </svg>
  )
}
