// ══════════════════════════════════════════════
// 协议志 · 今日动机云
//   星星 = 这个月自嗨开发的动机（sense_motives：你自己敲的，或系统提议、你收下的），停在共振膜上轻轻飘
//   明暗 = 今天的真实（today-glow.ts）：系统有把握判中它越久越亮、越往中间靠；立约了还没推进的次亮；没碰的暗着
//   冰蓝细环 = 今天立约（理想）；系统觉得你此刻在推进哪一颗，那一颗就一下一下敲响膜
//   旧的动机锚点云（motive-cloud/MotiveCloud）暂时不挂出来
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react'
import { Membrane, type KeepOut } from '../motive-cloud/membrane'
import type { Pt } from '../motive-cloud/blueprint-layout'
import {
  loadLabelFonts, measureLabel, placeLabels, spreadByLabel, TIERS,
  type MeasuredLabel, type PlacedLabel, type Tier,
} from '../motive-cloud/motive-label-layout'
import { glowOf, livedText, type Glow } from './today-glow'
import { useTodayCloud } from './use-today-cloud'
import './today-cloud.css'

// ── 可调旋钮 ──────────────────────────────────
const MOTIVE_RGB = '255,153,51'
const CORE_RGB = '255,226,189'
const SYSTEM_RGB = '158,216,242'
/** 漂浮幅度（px） */
const DRIFT = 9
const GLIDE_RATE = 3
/** 每颗星作为声源的振幅：越亮振得越强 */
const SOURCE_AMP = 0.16
/** 此刻在推进的那颗多久敲一下膜（ms） */
const NOW_BEAT_MS = 2400
const ENTRANCE_STAGGER = 140
/** 越亮离中心越近：最亮的那颗半径只剩这么多 */
const BRIGHT_PULL = 0.55

interface Body { x: number; y: number; phase: number; f1: number; f2: number; hz: number; appearAt: number; appeared: boolean }

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

const QUIET_GLOW: Glow = { level: 0.16, tier: 'faint', seconds: 0, declared: false }
const NO_LABELS: ReadonlyMap<string, PlacedLabel> = new Map()

/** 种子位：按 id 定方位，越亮越靠中心 */
function seedOf(id: string, level: number, w: number, h: number): Pt {
  const a = hash01(id) * Math.PI * 2
  const r = (0.3 + hash01(`${id}r`) * 0.7) * (1 - BRIGHT_PULL * level)
  return { x: w / 2 + Math.cos(a) * w * 0.4 * r, y: h * 0.47 + Math.sin(a) * h * 0.34 * r }
}

function drawStar(ctx: CanvasRenderingContext2D, b: Body, g: Glow, alpha: number, isNow: boolean, selected: boolean, t: number) {
  const r = 1.8 + g.level * 3.2
  const halo = r * (3 + g.level * 4)
  const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, halo)
  glow.addColorStop(0, `rgba(${MOTIVE_RGB},${(0.08 + 0.6 * g.level) * alpha})`)
  glow.addColorStop(1, `rgba(${MOTIVE_RGB},0)`)
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(b.x, b.y, halo, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = `rgba(${CORE_RGB},${(0.35 + 0.65 * g.level) * alpha})`
  ctx.beginPath()
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2)
  ctx.fill()
  const ring = (rgb: string, a: number, radius: number, width: number) => {
    ctx.strokeStyle = `rgba(${rgb},${a * alpha})`
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.arc(b.x, b.y, radius, 0, Math.PI * 2)
    ctx.stroke()
  }
  if (g.declared) ring(SYSTEM_RGB, g.seconds > 0 ? 0.9 : 0.5, r + 7, g.seconds > 0 ? 1.4 : 1)
  if (isNow) ring(MOTIVE_RGB, 0.32 + 0.18 * Math.sin(t * 2.4), r + 12 + Math.sin(t * 2.4) * 2, 1)
  if (selected) ring(CORE_RGB, 0.55, r + 16, 1)
}

export default function TodayCloud() {
  const { motives, loaded, today, sense, error, add, drop, toggleDeclared, clearError } = useTodayCloud()
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelEls = useRef(new Map<string, HTMLDivElement>())
  const bodies = useRef(new Map<string, Body>())
  const seeds = useRef(new Map<string, Pt>())
  const membrane = useRef(new Membrane())
  const sizeRef = useRef({ w: 0, h: 0 })
  const beatAt = useRef(0)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [fontVersion, setFontVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const calm = useMemo(() => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.6 : 1), [])

  const glow = useMemo(() => glowOf(motives, today), [motives, today])
  // 系统此刻有把握地觉得你在推进的那一颗
  const nowId = sense?.sure && sense.goalKey?.startsWith('m:') ? sense.goalKey.slice(2) : null

  // 摆位：越亮越靠中心 → 按标签体积推开 → 贪心摆标签
  const placement = useMemo(() => {
    const { w, h } = size
    if (w === 0 || fontVersion === 0) return null
    const pos = new Map<string, Pt>()
    const tiers = new Map<string, Tier>()
    const measured = new Map<string, MeasuredLabel>()
    for (const m of motives) {
      const g = glow.get(m.id) ?? QUIET_GLOW
      pos.set(m.id, seedOf(m.id, g.level, w, h))
      tiers.set(m.id, g.tier)
      measured.set(m.id, measureLabel(m.text, g.tier))
    }
    spreadByLabel(pos, measured, { w, h })
    const order = [...motives].sort((a, b) => (glow.get(b.id)?.level ?? 0) - (glow.get(a.id)?.level ?? 0)).map((m) => m.id)
    return { pos, labels: placeLabels(order, pos, measured, tiers, { w, h }) }
  }, [size, motives, glow, fontVersion])
  const layout: ReadonlyMap<string, PlacedLabel> = placement?.labels ?? NO_LABELS

  // 动画循环读最新状态（每次渲染后同步，不随渲染重建循环）
  const stateRef = useRef({ motives, glow, nowId, selectedId, layout })
  useEffect(() => { stateRef.current = { motives, glow, nowId, selectedId, layout } })

  // 按要显示的字加载宋体，完成后重新测量
  const texts = useMemo(() => motives.map((m) => m.text).join('\u0000'), [motives])
  useEffect(() => {
    let alive = true
    loadLabelFonts(texts ? texts.split('\u0000') : [])
      .catch(() => { /* 字体加载失败就用回退字体量 */ })
      .finally(() => { if (alive) setFontVersion((v) => v + 1) })
    return () => { alive = false }
  }, [texts])

  // 舞台尺寸
  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
      membrane.current.resize(w, h)
      sizeRef.current = { w, h }
      setSize({ w, h })
    })
    ro.observe(stage)
    return () => ro.disconnect()
  }, [])

  // 星星飘向新的位置；新来的依次落下，拿走的移除
  useEffect(() => {
    if (!placement) return
    const { pos } = placement
    seeds.current = pos

    const now = performance.now()
    const entrance = bodies.current.size === 0
    motives.forEach((m, i) => {
      if (bodies.current.has(m.id)) return
      const p = pos.get(m.id) as Pt
      bodies.current.set(m.id, {
        x: p.x, y: p.y,
        phase: hash01(`${m.id}p`) * Math.PI * 2,
        f1: 0.06 + hash01(`${m.id}f`) * 0.08,
        f2: 0.12 + hash01(`${m.id}g`) * 0.1,
        hz: 0.85 + hash01(`${m.id}h`) * 0.7,
        appearAt: now + (entrance ? 250 + i * ENTRANCE_STAGGER : 0),
        appeared: false,
      })
    })
    for (const id of [...bodies.current.keys()]) if (!pos.has(id)) bodies.current.delete(id)
  }, [placement, motives])

  // 动画循环（读 stateRef，不随渲染重建）
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const { w, h } = sizeRef.current
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx || w === 0) return
      const s = stateRef.current
      const t = now / 1000
      const mem = membrane.current

      const nowBody = s.nowId ? bodies.current.get(s.nowId) : undefined
      if (nowBody?.appeared && now - beatAt.current > NOW_BEAT_MS) {
        mem.drop(nowBody.x, nowBody.y, 1.6 * calm, 1.5)
        beatAt.current = now
      }

      const keepOut: KeepOut[] = []
      for (const m of s.motives) {
        const b = bodies.current.get(m.id)
        const pl = s.layout.get(m.id)
        if (!b?.appeared || !pl) continue
        keepOut.push({ x0: b.x + pl.dx - 6, y0: b.y + pl.dy - 4, x1: b.x + pl.dx + pl.measured.w + 6, y1: b.y + pl.dy + pl.measured.h + 4 })
      }
      ctx.clearRect(0, 0, w, h)
      mem.advance(dt)
      mem.render(ctx, keepOut)

      const k = 1 - Math.exp(-dt * GLIDE_RATE)
      for (const m of s.motives) {
        const b = bodies.current.get(m.id)
        const seed = seeds.current.get(m.id)
        if (!b || !seed) continue
        const g = s.glow.get(m.id) ?? QUIET_GLOW
        const drift = DRIFT * calm
        const tx = seed.x + Math.sin(t * b.f1 + b.phase) * drift + Math.sin(t * b.f2 + b.phase * 1.7) * drift * 0.5
        const ty = seed.y + Math.cos(t * b.f1 * 0.9 + b.phase) * drift * 0.8 + Math.cos(t * b.f2 * 1.1 + b.phase) * drift * 0.4
        b.x += (tx - b.x) * k
        b.y += (ty - b.y) * k
        if (!b.appeared && now >= b.appearAt) {
          b.appeared = true
          mem.drop(b.x, b.y, 2.2 * calm, 1.5)
        }
        if (!b.appeared) continue
        mem.vibrate(b.x, b.y, SOURCE_AMP * calm * (0.2 + g.level), b.hz, b.phase, t, dt)

        const selected = m.id === s.selectedId
        const el = labelEls.current.get(m.id)
        if (el) {
          el.style.transform = `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px)`
          el.style.opacity = String(selected ? 1 : 0.5 + 0.5 * g.level)
        }
        drawStar(ctx, b, g, 1, m.id === s.nowId, selected, t)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [calm])

  const selected = motives.find((m) => m.id === selectedId) ?? null
  const selectedGlow = selected ? glow.get(selected.id) ?? QUIET_GLOW : null
  const nowText = !sense || sense.source === 'off'
    ? null
    : sense.source === 'self' || sense.source === 'private'
      ? '此刻 · 系统没在看'
      : sense.sure && sense.goal
        ? `此刻 · ${sense.goal}${sense.confirmed ? '' : '？'}`
        : '此刻 · 不在云里任何一颗上'

  const submit = async () => {
    const text = draft.trim()
    if (!text) return
    if (await add(text)) setDraft('')
  }

  return (
    <div ref={stageRef} className="tc-stage" onClick={() => setSelectedId(null)}>
      <canvas ref={canvasRef} className="tc-canvas" />
      <header className="tc-head">协议志<span className="tc-sep">/</span>今日动机云</header>
      <p className="tc-legend">
        越亮 = 今天推进得越久<span className="tc-sep">·</span><span className="tc-ring" aria-hidden />今天立约<span className="tc-sep">·</span>敲响膜的那颗 = 系统觉得你此刻在推进它
      </p>
      {nowText && <p className="tc-now">{nowText}</p>}

      <div className="tc-labels">
        {motives.map((m) => {
          const pl = layout.get(m.id)
          const pick = (e: React.MouseEvent) => { e.stopPropagation(); setSelectedId(m.id) }
          return (
            <div
              key={m.id}
              className="tc-anchor"
              style={{ opacity: 0 }}
              ref={(el) => { if (el) labelEls.current.set(m.id, el); else labelEls.current.delete(m.id) }}
            >
              <button
                type="button"
                className="tc-motive"
                aria-label={m.text}
                onClick={pick}
                style={pl ? {
                  left: pl.dx, top: pl.dy, width: pl.measured.w + 2,
                  fontSize: pl.measured.size, lineHeight: `${pl.measured.lineHeight}px`,
                  color: TIERS[pl.tier].color, textAlign: pl.align,
                } : { visibility: 'hidden' }}
              >
                {pl ? pl.measured.lines.map((line, i) => <span key={i} className="tc-line">{line}</span>) : m.text}
              </button>
              <button type="button" className="tc-hit" tabIndex={-1} aria-hidden="true" onClick={pick} />
            </div>
          )
        })}
      </div>

      {loaded && motives.length === 0 && (
        <p className="tc-empty">
          云还是空的。<br />
          在下面敲一句这个月想推进的事；或者照常干活——系统一分钟都对不上，会来问你要不要收下一颗。
        </p>
      )}
      {error && (
        <div className="tc-error" onClick={(e) => e.stopPropagation()}>
          {error}
          <button type="button" onClick={clearError}>知道了</button>
        </div>
      )}

      <div className="tc-bar" onClick={(e) => e.stopPropagation()}>
        {selected && selectedGlow ? (
          <>
            <span className="tc-bar-text">{selected.text}</span>
            <span className="tc-bar-meta">{livedText(selectedGlow.seconds)}{selected.origin === 'ai' ? ' · 系统提议、你收下的' : ''}</span>
            <button type="button" className="tc-btn tc-btn-sys" onClick={() => void toggleDeclared(selected.id)}>
              {selectedGlow.declared ? '今天先不推进它' : '今天推进它'}
            </button>
            <button type="button" className="tc-btn" onClick={() => { void drop(selected.id); setSelectedId(null) }}>拿出云</button>
          </>
        ) : (
          <input
            className="tc-input"
            value={draft}
            placeholder="加一颗动机：这个月想推进的事，回车"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit() }}
          />
        )}
      </div>
    </div>
  )
}
