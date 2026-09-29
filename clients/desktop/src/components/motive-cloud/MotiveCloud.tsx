// ══════════════════════════════════════════════
// 协议志 · 动机云
//   舞台是一张共振膜（membrane.ts）。动机是停在膜上的光点，各自轻轻颤动。
//   · 入场：动机一颗接一颗落到膜上，每颗激起一圈涟漪，彼此干涉
//   · 选中：动机滑到中央，到位那一刻才「敲响」—— 波荡开，其余动机退远变暗
//   · 展开成行动：AI 思考时动机有节奏地共振；蓝图到手后再敲一次，方向与步骤沿波前结晶
//   · 留作愿望：沿外圈的暗琥珀轨道慢慢绕行；放下：化作颗粒沉进膜里（归档不删）
//   同一时间只聚焦一件事；没有分数、进度条。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { saveMotiveProtocol } from '../../lib/local-api'
import type { BlueprintDirection, MotiveBlueprint, MotiveDestiny, MotiveProtocol } from '../../lib/local-api'
import { projectAnchors } from '../../lib/anchor-map-layout'
import { Membrane } from './membrane'
import type { KeepOut } from './membrane'
import { layoutBlueprint } from './blueprint-layout'
import type { Pt } from './blueprint-layout'
import BlueprintLayer from './BlueprintLayer'
import type { BlueprintEdits } from './BlueprintLayer'
import FocusBar from './FocusBar'
import { generateBlueprint } from './motive-blueprint-ai'
import { LABEL_FAMILY, TIERS, loadLabelFonts, measureLabel, placeLabels, spreadByLabel } from './motive-label-layout'
import type { MeasuredLabel, PlacedLabel, Tier } from './motive-label-layout'
import { useMotiveData } from './use-motive-data'
import type { Motive } from './use-motive-data'

// ── 可调旋钮 ──────────────────────────────────
const MOTIVE_RGB = '255,153,51'   // 动机橙（锚点域同色）
const WISH_RGB = '160,124,78'     // 愿望：沉下去的琥珀
const CORE_RGB = '255,226,189'
/** 蓝图结晶跟随的波前速度（px/s）：略慢于膜上真实波速，像在波的尾迹里析出 */
const CRYSTAL_SPEED = 260
/** 滑到中央所需时间（ms），到位才敲响 */
const GLIDE_MS = 650
const GLIDE_RATE = 6
/** 漂浮幅度（px）：小一点，标签避让才不会被漂浮破坏 */
const DRIFT = 6
/** 每颗动机作为持续声源的振幅 / 频率范围（Hz）；聚焦时只剩它一个声源、振幅加大 */
const SOURCE_AMP = 0.12
const FOCUS_SOURCE_AMP = 0.28
const SOURCE_HZ_MIN = 0.85
const SOURCE_HZ_SPAN = 0.7
/** 愿望绕外圈一圈的秒数 */
const WISH_PERIOD = 420
/** 入场：相邻动机落下的间隔（ms） */
const ENTRANCE_STAGGER = 150
/** AI 思考时的共振节拍（ms）；聚焦但无事时的心跳（ms） */
const THINK_BEAT = 900
const HEART_BEAT = 2600
/** 放下：消散时长（ms） */
const DISSOLVE_MS = 1300
const MAX_DIRECTIONS = 5

interface Body {
  x: number
  y: number
  phase: number
  f1: number
  f2: number
  /** 作为声源的频率（Hz） */
  hz: number
  appearAt: number
  appeared: boolean
}

interface Particle { x: number; y: number; vx: number; vy: number; born: number; wish: boolean }

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

const cloudCenter = (w: number, h: number): Pt => ({ x: w / 2, y: h * 0.45 })
const focusPoint = (w: number, h: number): Pt => ({ x: w / 2, y: h * 0.42 })
const wishOrbit = (w: number, h: number) => ({ cx: w / 2, cy: h / 2, rx: w * 0.46, ry: h * 0.44 })
const dotRadius = (refs: number) => 2.4 + Math.min(refs, 5) * 0.45

/** 按引用次数分主次：前 30% 大、中间 40% 中、其余小 */
function assignTiers(motives: readonly Motive[]): Map<string, Tier> {
  const ranked = [...motives].sort((a, b) => b.refs - a.refs || b.text.length - a.text.length)
  const major = Math.ceil(ranked.length * 0.3)
  const minor = Math.ceil(ranked.length * 0.7)
  return new Map(ranked.map((m, i) => [m.id, i < major ? 'major' : i < minor ? 'minor' : 'faint']))
}

export default function MotiveCloud() {
  const { motives, protocols, vectors, status, error, reload, putProtocol } = useMotiveData()

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blueprintRef = useRef<HTMLDivElement>(null)
  const labelEls = useRef(new Map<string, HTMLDivElement>())
  const bodies = useRef(new Map<string, Body>())
  const seeds = useRef(new Map<string, Pt>())
  const membrane = useRef(new Membrane())
  const particles = useRef<Particle[]>([])
  const dissolving = useRef(new Map<string, number>())
  const clock = useRef({ strikeAt: 0, strikePending: false, nextBeat: 0 })
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const sizeRef = useRef({ w: 0, h: 0 })

  const [size, setSize] = useState({ w: 0, h: 0 })
  const [focusId, setFocusId] = useState<string | null>(null)
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showReleased, setShowReleased] = useState(false)
  const [autoEditKey, setAutoEditKey] = useState<string | null>(null)
  /** 宋体加载完成的次数：变了就重新测量排版 */
  const [fontVersion, setFontVersion] = useState(0)
  const [labelLayout, setLabelLayout] = useState<ReadonlyMap<string, PlacedLabel>>(new Map())
  const layoutRef = useRef(labelLayout)
  layoutRef.current = labelLayout
  /** 系统开了「减少动态效果」时不整个关掉——这个视图的意义就在振动里——只把幅度收到六成 */
  const calm = useMemo(() => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.6 : 1), [])

  // 动机文字变了 → 按实际要显示的字加载宋体，完成后触发重新测量
  const motiveTexts = useMemo(() => motives.map((m) => m.text).join('\u0000'), [motives])
  useEffect(() => {
    if (!motiveTexts) return
    let alive = true
    loadLabelFonts(motiveTexts.split('\u0000'))
      .catch(() => { /* 字体加载失败就用回退字体量，仍然不会重叠 */ })
      .finally(() => { if (alive) setFontVersion((v) => v + 1) })
    return () => { alive = false }
  }, [motiveTexts])

  const destinyOf = useCallback(
    (id: string): MotiveDestiny => protocols.get(id)?.destiny ?? 'cloud',
    [protocols],
  )
  const live = useMemo(() => motives.filter((m) => destinyOf(m.id) !== 'released'), [motives, destinyOf])
  const released = useMemo(() => motives.filter((m) => destinyOf(m.id) === 'released'), [motives, destinyOf])
  const focused = focusId ? motives.find((m) => m.id === focusId) ?? null : null
  const blueprint = focusId ? protocols.get(focusId)?.blueprint ?? null : null
  const hasBlueprint = !!blueprint && blueprint.directions.length > 0

  // 动画循环读最新状态（不随渲染重建循环）
  const stateRef = useRef({ motives, focusId, generatingId, destinyOf })
  stateRef.current = { motives, focusId, generatingId, destinyOf }

  // ── 舞台只占窗口里看得见的高度：窗口比应用整体布局矮时，面板底部会落到窗口外，
  //    动机和底部聚焦栏都得在看得见的范围里 ──
  const [visibleH, setVisibleH] = useState<number | null>(null)
  useEffect(() => {
    const parent = stageRef.current?.parentElement
    if (!parent) return
    const update = () => {
      const r = parent.getBoundingClientRect()
      if (r.height === 0) return
      setVisibleH(Math.max(320, Math.min(r.height, window.innerHeight - r.top)))
    }
    const ro = new ResizeObserver(update)
    ro.observe(parent)
    window.addEventListener('resize', update)
    update()
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  // ── 舞台尺寸 ──
  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      if (w === 0 || h === 0) return // 视图隐藏时不动
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

  // ── 动机在云里的锚位：语义近 = 空间近（复用锚点域的向量投影），再按标签体积推开并摆标签 ──
  useEffect(() => {
    const { w, h } = size
    if (w === 0 || fontVersion === 0) return
    const c = cloudCenter(w, h)
    const sideW = w * 0.62
    const sideH = h * 0.62
    const withVec = motives
      .filter((m) => vectors.has(m.id))
      .map((m) => ({ id: m.id, vector: vectors.get(m.id) as number[] }))
    const projected = projectAnchors(withVec, { w: sideW, h: sideH, pad: 0 })
    const next = new Map<string, Pt>()
    for (const m of motives) {
      const p = projected.get(m.id)
      if (p) {
        next.set(m.id, { x: c.x - sideW / 2 + p.x, y: c.y - sideH / 2 + p.y })
      } else {
        const a = hash01(m.id) * Math.PI * 2
        const r = (0.18 + hash01(`${m.id}r`) * 0.3) * Math.min(sideW, sideH)
        next.set(m.id, { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * 0.8 })
      }
    }

    // 云里的动机：测量 → 推开 → 贪心摆标签；愿望在外圈轨道上，标签随位置动态朝内
    const inCloud = motives.filter((m) => {
      const d = destinyOf(m.id)
      return d !== 'wish' && d !== 'released'
    })
    const tiers = assignTiers(inCloud)
    const measured = new Map<string, MeasuredLabel>()
    for (const m of motives) {
      measured.set(m.id, measureLabel(m.text, destinyOf(m.id) === 'wish' ? 'wish' : tiers.get(m.id) ?? 'minor'))
    }
    const cloudPos = new Map(inCloud.map((m) => [m.id, next.get(m.id) as Pt]))
    spreadByLabel(cloudPos, measured, { w, h })
    for (const [id, p] of cloudPos) next.set(id, p)
    const order = [...inCloud].sort((a, b) => b.refs - a.refs).map((m) => m.id)
    const placed = placeLabels(order, cloudPos, measured, tiers, { w, h })
    for (const m of motives) {
      if (destinyOf(m.id) !== 'wish') continue
      const mm = measured.get(m.id) as MeasuredLabel
      placed.set(m.id, { dx: 13, dy: -mm.h / 2, align: 'left', measured: mm, tier: 'wish' })
    }
    setLabelLayout(placed)
    seeds.current = next

    // 新动机：入场时依次落下；之后新来的立刻落下
    const now = performance.now()
    const isEntrance = bodies.current.size === 0
    motives.forEach((m, i) => {
      if (bodies.current.has(m.id)) return
      const seed = next.get(m.id) as Pt
      bodies.current.set(m.id, {
        x: seed.x,
        y: seed.y,
        phase: hash01(`${m.id}p`) * Math.PI * 2,
        f1: 0.05 + hash01(`${m.id}f`) * 0.07,
        f2: 0.11 + hash01(`${m.id}g`) * 0.09,
        hz: SOURCE_HZ_MIN + hash01(`${m.id}h`) * SOURCE_HZ_SPAN,
        appearAt: now + (isEntrance ? 280 + i * ENTRANCE_STAGGER : 0),
        appeared: false,
      })
    })
  }, [size, motives, vectors, destinyOf, fontVersion])

  // ── 动画循环 ──
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
      const fp = focusPoint(w, h)
      const orbit = wishOrbit(w, h)
      const clk = clock.current

      // 敲响：滑到中央、到位的那一刻
      if (s.focusId && clk.strikePending && now >= clk.strikeAt) {
        mem.drop(fp.x, fp.y, 6.5 * calm, 2.6)
        clk.strikePending = false
      }
      // 共振节拍：思考中密、平时聚焦是慢心跳
      if (s.focusId && now >= clk.nextBeat && !clk.strikePending) {
        const thinking = s.generatingId === s.focusId
        mem.drop(fp.x, fp.y, (thinking ? 2.4 : 0.9) * calm, thinking ? 1.8 : 1.3)
        clk.nextBeat = now + (thinking ? THINK_BEAT : HEART_BEAT)
      }

      // 点阵避让区：每个看得见的动机标签 + 聚焦时底部的原话栏
      const keepOut: KeepOut[] = []
      for (const m of s.motives) {
        const b = bodies.current.get(m.id)
        const pl = layoutRef.current.get(m.id)
        if (!b || !pl || !b.appeared || m.id === s.focusId) continue
        if (s.focusId) continue // 有焦点时其余标签几乎透明，不必让
        const destiny = s.destinyOf(m.id)
        if (destiny === 'released') continue
        const dx = destiny === 'wish' && b.x > w / 2 ? -13 - pl.measured.w : pl.dx
        keepOut.push({
          x0: b.x + dx - 6, y0: b.y + pl.dy - 4,
          x1: b.x + dx + pl.measured.w + 6, y1: b.y + pl.dy + pl.measured.h + 4,
        })
      }
      if (s.focusId) keepOut.push({ x0: w / 2 - 390, y0: h - 170, x1: w / 2 + 390, y1: h })

      ctx.clearRect(0, 0, w, h)
      mem.advance(dt)
      mem.render(ctx, keepOut)

      // 愿望轨道：一圈极淡的虚线地平线
      const wishCount = s.motives.filter((m) => s.destinyOf(m.id) === 'wish').length
      ctx.save()
      ctx.setLineDash([1.4, 7])
      ctx.strokeStyle = `rgba(${WISH_RGB},${wishCount > 0 ? 0.32 : 0.14})`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.ellipse(orbit.cx, orbit.cy, orbit.rx, orbit.ry, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      const k = 1 - Math.exp(-dt * GLIDE_RATE)
      for (const m of s.motives) {
        const b = bodies.current.get(m.id)
        const seed = seeds.current.get(m.id)
        const el = labelEls.current.get(m.id)
        if (!b || !seed) continue
        const destiny = s.destinyOf(m.id)
        const dissolveAt = dissolving.current.get(m.id)
        if (destiny === 'released' && dissolveAt === undefined) {
          if (el) el.style.opacity = '0'
          continue
        }

        // 目标位置
        const isFocus = m.id === s.focusId
        const isWish = destiny === 'wish'
        let tx: number
        let ty: number
        if (isFocus) {
          tx = fp.x
          ty = fp.y
        } else if (isWish) {
          const ang = hash01(m.id) * Math.PI * 2 + (t * Math.PI * 2) / WISH_PERIOD
          tx = orbit.cx + Math.cos(ang) * orbit.rx
          ty = orbit.cy + Math.sin(ang) * orbit.ry
        } else {
          const drift = DRIFT * calm
          tx = seed.x + Math.sin(t * b.f1 + b.phase) * drift + Math.sin(t * b.f2 + b.phase * 1.7) * drift * 0.5
          ty = seed.y + Math.cos(t * b.f1 * 0.9 + b.phase) * drift * 0.8 + Math.cos(t * b.f2 * 1.1 + b.phase) * drift * 0.4
          if (s.focusId) {
            // 有焦点时其余动机退远一点
            tx = fp.x + (tx - fp.x) * 1.14
            ty = fp.y + (ty - fp.y) * 1.14
          }
        }
        b.x += (tx - b.x) * k
        b.y += (ty - b.y) * k

        // 落到膜上
        if (!b.appeared && now >= b.appearAt) {
          b.appeared = true
          mem.drop(b.x, b.y, 2.6 * calm, 1.6)
        }
        // 持续声源：平时每颗云里的动机都在轻轻振动（频率各异 → 膜上流动的干涉纹）；
        // 有焦点时全场静音，只剩被选中的那一颗在响
        if (b.appeared && dissolveAt === undefined && !isWish) {
          if (isFocus) mem.vibrate(b.x, b.y, FOCUS_SOURCE_AMP * calm, b.hz, b.phase, t, dt)
          else if (!s.focusId) mem.vibrate(b.x, b.y, SOURCE_AMP * calm, b.hz, b.phase, t, dt)
        }

        // 透明度
        let alpha = b.appeared ? (isWish ? 0.7 : 1) : 0
        if (dissolveAt !== undefined) alpha *= Math.max(0, 1 - (now - dissolveAt) / DISSOLVE_MS)
        else if (s.focusId && !isFocus) alpha *= 0.1

        // 标签跟着光点走（偏移在排版时已算好）；愿望的标签朝轨道内侧
        if (el) {
          el.style.transform = `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px)`
          el.style.opacity = String(isFocus ? 0 : alpha)
          if (isWish) {
            const side = b.x > w / 2 ? 'l' : 'r'
            if (el.dataset.side !== side) el.dataset.side = side
          }
        }

        // 光点：清晰的小核心 + 一圈很淡的晕（不做大光斑）
        const dotA = isFocus ? 1 : s.focusId ? Math.max(alpha, 0.16) : alpha
        if (dotA <= 0.01) continue
        const r = dotRadius(m.refs) * (isFocus ? 1.5 : 1)
        const rgb = isWish ? WISH_RGB : MOTIVE_RGB
        const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r * 3.4)
        glow.addColorStop(0, `rgba(${rgb},${0.42 * dotA})`)
        glow.addColorStop(1, `rgba(${rgb},0)`)
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(b.x, b.y, r * 3.4, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = `rgba(${isWish ? WISH_RGB : CORE_RGB},${dotA})`
        ctx.beginPath()
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2)
        ctx.fill()
        // 已经有蓝图的动机：一圈细环
        if (destiny === 'action' && !isFocus) {
          ctx.strokeStyle = `rgba(${MOTIVE_RGB},${0.45 * dotA})`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(b.x, b.y, r + 4.5, 0, Math.PI * 2)
          ctx.stroke()
        }
        if (isFocus) {
          const breathe = Math.sin(t * 2.2) * 2
          ctx.strokeStyle = `rgba(${MOTIVE_RGB},0.35)`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(b.x, b.y, r + 10 + breathe, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // 放下时的颗粒：散开、下沉、熄灭
      const alive: Particle[] = []
      for (const p of particles.current) {
        const age = (now - p.born) / 1000
        if (age > 1.6) continue
        p.vy += 26 * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        ctx.fillStyle = `rgba(${p.wish ? WISH_RGB : MOTIVE_RGB},${(1 - age / 1.6) * 0.85})`
        ctx.fillRect(p.x - 0.8, p.y - 0.8, 1.6, 1.6)
        alive.push(p)
      }
      particles.current = alive

      // 蓝图结晶：波前扫过的卷须画出来、节点凝结
      const layer = blueprintRef.current
      if (layer) {
        const frontR = clk.strikePending ? -1 : ((now - clk.strikeAt) / 1000) * CRYSTAL_SPEED
        layer.querySelectorAll<SVGPathElement>('path[data-r0]').forEach((path) => {
          const r0 = Number(path.dataset.r0)
          const r1 = Number(path.dataset.r1)
          const prog = Math.max(0, Math.min(1, (frontR - r0) / Math.max(1, r1 - r0)))
          path.style.strokeDashoffset = String(1 - prog)
        })
        layer.querySelectorAll<HTMLElement>('.mc-node').forEach((node) => {
          const on = frontR >= Number(node.dataset.r)
          if (on && node.dataset.on !== '1') {
            node.dataset.on = '1'
            if (node.dataset.quiet !== '1') mem.drop(Number(node.dataset.x), Number(node.dataset.y), 1.5 * calm, 1.3)
          } else if (!on && node.dataset.on === '1') {
            node.dataset.on = '0'
          }
        })
      }
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [calm])

  // ── 交互 ──
  const strike = useCallback((delay: number) => {
    const now = performance.now()
    clock.current = { strikeAt: now + delay, strikePending: true, nextBeat: now + delay + 400 }
  }, [])

  const focusMotive = useCallback((id: string) => {
    setActionError(null)
    setShowReleased(false)
    setFocusId(id)
    strike(GLIDE_MS)
  }, [strike])

  const unfocus = useCallback(() => {
    setFocusId(null)
    setActionError(null)
    setShowReleased(false)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      unfocus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [unfocus])

  const localProtocol = useCallback((id: string, patch: Partial<Pick<MotiveProtocol, 'destiny' | 'blueprint'>>) => {
    const prev = protocols.get(id)
    putProtocol({
      anchor_id: id,
      destiny: patch.destiny ?? prev?.destiny ?? 'cloud',
      blueprint: patch.blueprint !== undefined ? patch.blueprint : prev?.blueprint ?? null,
      updated_at: new Date().toISOString(),
    })
  }, [protocols, putProtocol])

  const setDestiny = useCallback(async (m: Motive, destiny: MotiveDestiny) => {
    localProtocol(m.id, { destiny })
    try {
      putProtocol(await saveMotiveProtocol(m.id, { destiny }))
    } catch (e) {
      setActionError(`没保存上：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [localProtocol, putProtocol])

  const expand = useCallback(async (m: Motive) => {
    setActionError(null)
    setGeneratingId(m.id)
    clock.current = { ...clock.current, nextBeat: performance.now() }
    try {
      const bp = await generateBlueprint(m.text, m.contexts)
      putProtocol(await saveMotiveProtocol(m.id, { destiny: 'action', blueprint: bp }))
      if (stateRef.current.focusId === m.id) strike(0) // 再敲一次，蓝图沿波前结晶
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setGeneratingId(null)
    }
  }, [putProtocol, strike])

  const release = useCallback((m: Motive) => {
    const b = bodies.current.get(m.id)
    const now = performance.now()
    const wish = destinyOf(m.id) === 'wish'
    dissolving.current.set(m.id, now)
    if (b) {
      membrane.current.drop(b.x, b.y, -4.5 * calm, 2.2)
      const spray: Particle[] = Array.from({ length: 34 }, () => {
        const a = Math.random() * Math.PI * 2
        const v = 18 + Math.random() * 52
        return { x: b.x, y: b.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6, born: now, wish }
      })
      particles.current = [...particles.current, ...spray]
    }
    setFocusId(null)
    setTimeout(() => {
      void setDestiny(m, 'released').finally(() => dissolving.current.delete(m.id))
    }, DISSOLVE_MS)
  }, [destinyOf, calm, setDestiny])

  const recover = useCallback((m: Motive) => {
    const b = bodies.current.get(m.id)
    if (b) {
      b.appeared = false
      b.appearAt = performance.now() + 120
    }
    void setDestiny(m, protocols.get(m.id)?.blueprint ? 'action' : 'cloud')
  }, [protocols, setDestiny])

  // 蓝图编辑：本地立即生效，停手 450ms 后落库
  const saveBlueprint = useCallback((id: string, next: MotiveBlueprint) => {
    localProtocol(id, { blueprint: next, destiny: 'action' })
    const timers = saveTimers.current
    const pending = timers.get(id)
    if (pending) clearTimeout(pending)
    timers.set(id, setTimeout(() => {
      timers.delete(id)
      saveMotiveProtocol(id, { blueprint: next }).catch((e) => {
        setActionError(`蓝图没保存上：${e instanceof Error ? e.message : String(e)}`)
      })
    }, 450))
  }, [localProtocol])

  const edits = useMemo<BlueprintEdits>(() => {
    const mutate = (fn: (dirs: readonly BlueprintDirection[]) => BlueprintDirection[]) => {
      if (!focusId || !blueprint) return
      saveBlueprint(focusId, { directions: fn(blueprint.directions) })
    }
    return {
      renameDirection: (di, title) => mutate((ds) => ds.map((d, i) => (i === di ? { ...d, title } : d))),
      editStep: (di, si, text) => mutate((ds) => ds.map((d, i) => (i === di ? { ...d, steps: d.steps.map((s, j) => (j === si ? text : s)) } : d))),
      removeDirection: (di) => mutate((ds) => ds.filter((_, i) => i !== di)),
      removeStep: (di, si) => mutate((ds) => ds.map((d, i) => (i === di ? { ...d, steps: d.steps.filter((_, j) => j !== si) } : d))),
      addStep: (di) => {
        const count = blueprint?.directions[di]?.steps.length ?? 0
        mutate((ds) => ds.map((d, i) => (i === di ? { ...d, steps: [...d.steps, '新的一步'] } : d)))
        setAutoEditKey(`s${di}-${count}`)
      },
    }
  }, [focusId, blueprint, saveBlueprint])

  const addDirection = useCallback(() => {
    if (!focusId || !blueprint || blueprint.directions.length >= MAX_DIRECTIONS) return
    saveBlueprint(focusId, { directions: [...blueprint.directions, { title: '新方向', steps: [] }] })
    setAutoEditKey(`d${blueprint.directions.length}`)
  }, [focusId, blueprint, saveBlueprint])

  const clearAutoEdit = useCallback(() => setAutoEditKey(null), [])

  const laid = useMemo(
    () => (focusId && hasBlueprint && blueprint && size.w > 0 ? layoutBlueprint(blueprint, focusPoint(size.w, size.h), size) : []),
    [focusId, hasBlueprint, blueprint, size],
  )

  return (
    <div
      ref={stageRef}
      className={`mc-stage${focusId ? ' is-focused' : ''}`}
      style={{ height: visibleH ?? '100%' }}
      onClick={unfocus}
    >
      <canvas ref={canvasRef} className="mc-canvas" />

      <header className="mc-head">协议志<span className="mc-head-sep">/</span>动机云</header>

      {released.length > 0 && (
        <button
          type="button"
          className="mc-released-toggle"
          onClick={(e) => { e.stopPropagation(); setShowReleased((v) => !v) }}
        >
          已放下 {released.length}
        </button>
      )}
      {showReleased && (
        <div className="mc-released" onClick={(e) => e.stopPropagation()}>
          {released.map((m) => (
            <div key={m.id} className="mc-released-row">
              <span>{m.text}</span>
              <button type="button" onClick={() => recover(m)}>拾回</button>
            </div>
          ))}
        </div>
      )}

      <div className="mc-labels">
        {live.map((m) => {
          const pl = labelLayout.get(m.id)
          const isWish = destinyOf(m.id) === 'wish'
          const onPick = (e: React.MouseEvent) => { e.stopPropagation(); focusMotive(m.id) }
          return (
            <div
              key={m.id}
              className="mc-anchor"
              data-side="r"
              style={{ opacity: 0 }}
              ref={(el) => {
                if (el) labelEls.current.set(m.id, el)
                else labelEls.current.delete(m.id)
              }}
            >
              <button
                type="button"
                className={`mc-motive${isWish ? ' is-wish' : ''}`}
                tabIndex={focusId ? -1 : 0}
                aria-label={m.text}
                onClick={onPick}
                style={pl ? {
                  left: pl.dx,
                  top: pl.dy,
                  width: pl.measured.w + 2,
                  fontSize: pl.measured.size,
                  lineHeight: `${pl.measured.lineHeight}px`,
                  color: TIERS[pl.tier].color,
                  textAlign: pl.align,
                } : { visibility: 'hidden' }}
              >
                {pl ? pl.measured.lines.map((line, i) => <span key={i} className="mc-line">{line}</span>) : m.text}
              </button>
              <button type="button" className="mc-hit" tabIndex={-1} aria-hidden="true" onClick={onPick} />
            </div>
          )
        })}
      </div>

      <div ref={blueprintRef} className="mc-blueprint">
        {laid.length > 0 && (
          <BlueprintLayer
            key={focusId ?? ''}
            laid={laid}
            width={size.w}
            height={size.h}
            edits={edits}
            autoEditKey={autoEditKey}
            onAutoEditConsumed={clearAutoEdit}
          />
        )}
      </div>

      {status === 'ready' && live.length === 0 && (
        <p className="mc-empty">
          {released.length > 0
            ? '云里的动机都放下了。右上角可以把它们拾回来。'
            : '还没有动机。跟 Fairy 聊天时说出「我想……」，它会作为一颗光点落到这里。'}
        </p>
      )}
      {status === 'error' && (
        <div className="mc-empty" onClick={(e) => e.stopPropagation()}>
          读不到动机数据：{error}
          <button type="button" className="mc-retry" onClick={() => void reload()}>重试</button>
        </div>
      )}

      {focused && (
        <FocusBar
          text={focused.text}
          contextCount={focused.contexts.length}
          destiny={destinyOf(focused.id)}
          hasBlueprint={hasBlueprint}
          canAddDirection={(blueprint?.directions.length ?? 0) < MAX_DIRECTIONS}
          generating={generatingId === focused.id}
          error={actionError}
          onExpand={() => void expand(focused)}
          onAddDirection={addDirection}
          onWish={() => { void setDestiny(focused, 'wish'); setFocusId(null) }}
          onReturnToCloud={() => void setDestiny(focused, hasBlueprint ? 'action' : 'cloud')}
          onRelease={() => release(focused)}
        />
      )}

      <style>{`
        .mc-stage {
          position: relative; width: 100%; overflow: hidden;
          background: #050505; user-select: none; cursor: default;
        }
        .mc-canvas { position: absolute; inset: 0; display: block; }
        .mc-head {
          position: absolute; top: 18px; left: 22px; margin: 0;
          font-family: 'Exo 2', 'Microsoft YaHei', sans-serif; font-size: 11px; font-weight: 600;
          letter-spacing: 0.34em; color: #5E6873;
        }
        .mc-head-sep { margin: 0 0.6em; color: #39424B; }
        .mc-labels, .mc-blueprint { position: absolute; inset: 0; pointer-events: none; }
        .mc-blueprint .mc-node { pointer-events: auto; }
        .mc-anchor { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform, opacity; }
        /* 字距必须为 0、字重 400：pretext 按这个量的，渲染要和测量一致 */
        .mc-motive {
          position: absolute; padding: 0; margin: 0; background: transparent; border: none;
          cursor: pointer; pointer-events: auto; font-family: ${LABEL_FAMILY}; font-weight: 400;
          letter-spacing: 0; transition: color 0.2s;
        }
        .mc-line { display: block; white-space: nowrap; }
        .mc-motive:hover { color: #FFE2BD !important; }
        .mc-motive:focus-visible { outline: 1px solid #FFE2BD; outline-offset: 3px; }
        .mc-anchor[data-side="l"] .mc-motive.is-wish { left: auto !important; right: 13px; text-align: right !important; }
        .mc-hit {
          position: absolute; left: -12px; top: -12px; width: 24px; height: 24px; border-radius: 50%;
          background: transparent; border: none; padding: 0; cursor: pointer; pointer-events: auto;
        }
        .is-focused .mc-motive, .is-focused .mc-hit { pointer-events: none; }
        .mc-released-toggle {
          position: absolute; top: 14px; right: 20px; background: transparent; border: none; cursor: pointer;
          font-family: 'Exo 2', 'Microsoft YaHei', sans-serif; font-size: 11.5px; color: #6F7B86; letter-spacing: 0.12em;
          padding: 4px 2px;
        }
        .mc-released-toggle:hover { color: #BFB3A4; }
        .mc-released {
          position: absolute; top: 42px; right: 20px; width: min(340px, 80%); max-height: 50%; overflow: auto;
          padding: 10px 14px; background: rgba(8,9,11,0.94); border: 1px solid #222A33;
        }
        .mc-released-row {
          display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0;
          font-family: ${LABEL_FAMILY}; font-size: 13px; color: #8E847A; border-bottom: 1px solid #14181D;
        }
        .mc-released-row:last-child { border-bottom: none; }
        .mc-released-row button {
          flex: none; background: transparent; border: none; cursor: pointer; padding: 2px 0;
          font-family: 'Exo 2', 'Microsoft YaHei', sans-serif; font-size: 12px; color: #FF9933;
        }
        .mc-empty {
          position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%); margin: 0;
          width: min(460px, 86%); text-align: center; line-height: 1.8;
          font-family: ${LABEL_FAMILY}; font-size: 15px; color: #7C8792;
        }
        .mc-retry {
          margin-left: 10px; background: transparent; border: none; border-bottom: 1px solid #7C8792;
          color: #BFB3A4; cursor: pointer; font-size: 13px;
        }
      `}</style>
    </div>
  )
}
