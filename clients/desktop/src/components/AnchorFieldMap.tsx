// ══════════════════════════════════════════════
// AnchorFieldMap — 锚点域：开放世界认知地图（flomo 认知地图架构）
//   · 球 = 锚点句：位置由语义嵌入（PCA 投影）决定，语义近 = 空间近；三类只做染色
//   · 山 = 聚簇（≥2 球挤成一团）：山名由 AI 起（不是任何锚点原文），按成员缓存
//   · 等高线 = 球与山的密度场等值线（marching squares）——纯视觉地貌氛围，不承载语义（聚集看山、类别看区带）
//   · 左侧区域导航 = 已命名的簇，点击飞行聚焦；滚轮缩放 + 拖拽平移 + 底部工具条
//   · 无 API key / 向量未就绪时回退共现 force 布局，地图始终可用
// ══════════════════════════════════════════════

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, Ref } from 'react'
import { Check, ChevronLeft, ChevronRight, HelpCircle, Minus, Pencil, Plus, RotateCcw } from 'lucide-react'
import { theme } from '../theme'
import type { AnchorBinding, AnchorCategory, AnchorRef, ContextFeedItem } from '../lib/local-api'
import { fetchCardBindings, updateAnchorKeyword } from '../lib/local-api'
import { ensureAnchorEmbeddings } from '../lib/anchor-embedding'
import { clusterByCosine, clusterByDistance, clusterMemberHash, projectAnchors, relaxOverlap, resolveClusterNames } from '../lib/anchor-map-layout'
import {
  measureMountain, measureBall, layoutBallFlow, clearWrapCache,
  type WrappedLabel, type Obstacle, type PlacedLine,
  MOUNT_ANCHOR_DY, MOUNT_LH, BALL_GAP, BALL_LH, BALL_LABEL_ZOOM,
} from '../lib/anchor-label-layout'
import { ANCHOR_CAT_COLOR } from './AnchorTextRenderer'
import Tooltip from './Tooltip'

// ── 数据聚合 ──────────────────────────────────

interface AnchorNode {
  readonly anchor: AnchorRef
  readonly bindings: AnchorBinding[]   // 引用该锚点的所有绑定
}

interface MapData {
  readonly nodes: AnchorNode[]
  readonly bindings: AnchorBinding[]   // 全部绑定（去重）
  readonly edges: Array<{ a: string; b: string; w: number }> // 锚点共现（仅回退布局用）
}

function aggregate(perCard: AnchorBinding[][]): MapData {
  const nodeMap = new Map<string, { anchor: AnchorRef; bindings: AnchorBinding[] }>()
  const bindingMap = new Map<string, AnchorBinding>()
  const edgeMap = new Map<string, { a: string; b: string; w: number }>()

  const link = (a: string, b: string, w: number) => {
    if (a === b) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    const prev = edgeMap.get(key)
    if (prev) edgeMap.set(key, { ...prev, w: prev.w + w })
    else edgeMap.set(key, { a, b, w })
  }

  for (const cardBindings of perCard) {
    const cardAnchorIds = new Set<string>()
    for (const binding of cardBindings) {
      if (bindingMap.has(binding.id)) continue
      bindingMap.set(binding.id, binding)
      for (const anchor of binding.anchors) {
        const node = nodeMap.get(anchor.id)
        if (node) node.bindings.push(binding)
        else nodeMap.set(anchor.id, { anchor, bindings: [binding] })
        cardAnchorIds.add(anchor.id)
      }
      const ids = binding.anchors.map((a) => a.id)
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) link(ids[i], ids[j], 3)
    }
    const ids = Array.from(cardAnchorIds)
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) link(ids[i], ids[j], 1)
  }

  return {
    nodes: Array.from(nodeMap.values()),
    bindings: Array.from(bindingMap.values()),
    edges: Array.from(edgeMap.values()),
  }
}

// ── 确定性伪随机（同一锚点每次落在同一位置）──────

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

// ── 回退布局：共现 force（向量未就绪 / 无 key 时）──

const WORLD_W = 1000
const WORLD_H = 620
const WORLD_PAD = 90
const CLUSTER_LINK_DIST = 135

// 山体填充透明度：半透明让身后的节点与标签透出来（hover/聚焦时更实，强调当前山）
const MOUNTAIN_FILL_OPACITY = 0.4
const MOUNTAIN_FILL_OPACITY_HOT = 0.7

// ── 详情 callout 悬浮层可调旋钮 ──────────────────
//   面板锚定在被选中球的右侧（放不下翻左），随平移/缩放实时跟随；半透明 HUD 玻璃靶心
const PANEL_W = 268            // 面板宽
const PANEL_MAX_H = 'min(72%, 520px)' // CSS maxHeight（字符串）
const PANEL_MAX_H_PX = 520     // panelH 未实测时的垂直钳制估值
const PANEL_GAP = 44           // 球缘 → 面板缘水平间隙（也是连接折线伸展空间）
const PANEL_MARGIN = 12        // 面板离容器边的最小留白
const CARD_BG_ALPHA = 0.42     // 玻璃底默认更透（看清背后地图）；hover 只加 HUD 边框、不改透明
const CARD_BLUR = 13           // backdrop blur 半径(px)
const CARD_SAT = 130           // backdrop saturate(%)，让背后地图透出活色
const BRACKET_LEN = 13         // 四角括号臂长
const CONNECTOR_Z = 39         // 连接线 z（地图之上、面板之下）
const PANEL_Z = 40             // 面板 z

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// ── 类区带：三类各占一片纵向区带（橙动机 / 蓝观点 / 绿实践）────
//    投影与聚簇都只在类内进行，山不会跨类生长

const ZONE_ORDER: readonly AnchorCategory[] = ['motive', 'view', 'practice']
const ZONE_GAP = 18 // 区带间留白

interface CatZone { readonly cat: AnchorCategory; readonly x0: number; readonly w: number }

/** 按出现的类划分纵向区带，宽度 ∝ √成员数（大类多给空间，小类不被挤死）*/
function computeZones(counts: ReadonlyMap<AnchorCategory, number>): CatZone[] {
  const present = ZONE_ORDER.filter((c) => (counts.get(c) ?? 0) > 0)
  if (present.length === 0) return []
  const weights = present.map((c) => Math.sqrt(counts.get(c) ?? 1))
  const sum = weights.reduce((a, b) => a + b, 0)
  const usable = WORLD_W - ZONE_GAP * (present.length - 1)
  let x = 0
  return present.map((cat, i) => {
    const w = (weights[i] / sum) * usable
    const zone: CatZone = { cat, x0: x, w }
    x += w + ZONE_GAP
    return zone
  })
}

function countByCategory(
  ids: readonly string[],
  catOf: ReadonlyMap<string, AnchorCategory>,
): Map<AnchorCategory, number> {
  const counts = new Map<AnchorCategory, number>()
  for (const id of ids) {
    const cat = catOf.get(id)
    if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1)
  }
  return counts
}

function layoutNodes(nodes: AnchorNode[], edges: MapData['edges']): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    pos.set(n.anchor.id, {
      x: WORLD_W / 2 + (hash01(n.anchor.id) * 2 - 1) * WORLD_W * 0.32,
      y: WORLD_H / 2 + (hash01(n.anchor.id + 'y') * 2 - 1) * WORLD_H * 0.32,
    })
  }
  const ids = nodes.map((n) => n.anchor.id)
  for (let iter = 0; iter < 280; iter++) {
    const temp = 1 - iter / 280
    const disp = new Map<string, { x: number; y: number }>(ids.map((id) => [id, { x: 0, y: 0 }]))
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pa = pos.get(ids[i])!
        const pb = pos.get(ids[j])!
        let dx = pa.x - pb.x
        let dy = pa.y - pb.y
        const d2 = Math.max(dx * dx + dy * dy, 1)
        const d = Math.sqrt(d2)
        const f = 14000 / d2
        dx = (dx / d) * f
        dy = (dy / d) * f
        const da = disp.get(ids[i])!
        const db = disp.get(ids[j])!
        disp.set(ids[i], { x: da.x + dx, y: da.y + dy })
        disp.set(ids[j], { x: db.x - dx, y: db.y - dy })
      }
    }
    for (const e of edges) {
      const pa = pos.get(e.a)
      const pb = pos.get(e.b)
      if (!pa || !pb) continue
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
      const f = ((d - 110) / d) * 0.015 * Math.min(e.w, 5)
      const da = disp.get(e.a)!
      const db = disp.get(e.b)!
      disp.set(e.a, { x: da.x + dx * f, y: da.y + dy * f })
      disp.set(e.b, { x: db.x - dx * f, y: db.y - dy * f })
    }
    for (const id of ids) {
      const p = pos.get(id)!
      const d = disp.get(id)!
      const cx = (WORLD_W / 2 - p.x) * 0.004
      const cy = (WORLD_H / 2 - p.y) * 0.004
      const limit = 18 * temp + 2
      const mx = Math.max(-limit, Math.min(limit, d.x + cx))
      const my = Math.max(-limit, Math.min(limit, d.y + cy))
      pos.set(id, {
        x: Math.max(60, Math.min(WORLD_W - 60, p.x + mx)),
        y: Math.max(50, Math.min(WORLD_H - 50, p.y + my)),
      })
    }
  }
  return pos
}

// ── 等高线地形：密度场 + marching squares ──────────

const GRID_CELL = 10
const GRID_W = Math.floor(WORLD_W / GRID_CELL) + 1
const GRID_H = Math.floor(WORLD_H / GRID_CELL) + 1
// 多级嵌套等值线（flomo 式层叠地形：外圈疏淡 → 内圈密实，自带渐变感）
const CONTOUR_LEVELS: Array<{ level: number; opacity: number; dash?: string }> = [
  { level: 0.16, opacity: 0.13 },
  { level: 0.30, opacity: 0.18 },
  { level: 0.48, opacity: 0.24 },
  { level: 0.72, opacity: 0.30 },
  { level: 1.02, opacity: 0.36 },
  { level: 1.40, opacity: 0.42, dash: '3 5' },
]

interface DensitySource { x: number; y: number; sigma: number; amp: number }

function densityField(sources: DensitySource[]): Float64Array {
  const field = new Float64Array(GRID_W * GRID_H)
  for (const s of sources) {
    const reach = s.sigma * 3
    const x0 = Math.max(0, Math.floor((s.x - reach) / GRID_CELL))
    const x1 = Math.min(GRID_W - 1, Math.ceil((s.x + reach) / GRID_CELL))
    const y0 = Math.max(0, Math.floor((s.y - reach) / GRID_CELL))
    const y1 = Math.min(GRID_H - 1, Math.ceil((s.y + reach) / GRID_CELL))
    const inv = 1 / (2 * s.sigma * s.sigma)
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx * GRID_CELL - s.x
        const dy = gy * GRID_CELL - s.y
        field[gy * GRID_W + gx] += s.amp * Math.exp(-(dx * dx + dy * dy) * inv)
      }
    }
  }
  return field
}

function marchingSquares(field: Float64Array, level: number): string {
  const at = (x: number, y: number) => field[y * GRID_W + x]
  const lerp = (a: number, b: number) => (b === a ? 0.5 : (level - a) / (b - a))
  let d = ''
  for (let y = 0; y < GRID_H - 1; y++) {
    for (let x = 0; x < GRID_W - 1; x++) {
      const tl = at(x, y)
      const tr = at(x + 1, y)
      const br = at(x + 1, y + 1)
      const bl = at(x, y + 1)
      let idx = 0
      if (tl >= level) idx |= 8
      if (tr >= level) idx |= 4
      if (br >= level) idx |= 2
      if (bl >= level) idx |= 1
      if (idx === 0 || idx === 15) continue
      const px = x * GRID_CELL
      const py = y * GRID_CELL
      const top: [number, number] = [px + lerp(tl, tr) * GRID_CELL, py]
      const right: [number, number] = [px + GRID_CELL, py + lerp(tr, br) * GRID_CELL]
      const bottom: [number, number] = [px + lerp(bl, br) * GRID_CELL, py + GRID_CELL]
      const left: [number, number] = [px, py + lerp(tl, bl) * GRID_CELL]
      const seg = (p: [number, number], q: [number, number]) => {
        d += `M${p[0].toFixed(1)},${p[1].toFixed(1)}L${q[0].toFixed(1)},${q[1].toFixed(1)}`
      }
      switch (idx) {
        case 1: case 14: seg(left, bottom); break
        case 2: case 13: seg(bottom, right); break
        case 3: case 12: seg(left, right); break
        case 4: case 11: seg(top, right); break
        case 6: case 9: seg(top, bottom); break
        case 7: case 8: seg(left, top); break
        case 5: seg(left, top); seg(bottom, right); break
        case 10: seg(top, right); seg(left, bottom); break
        default: break
      }
    }
  }
  return d
}

// ── 簇（山）──────────────────────────────────

interface BallCluster {
  readonly hash: string
  readonly members: AnchorNode[]   // 按绑定数降序
  readonly cx: number
  readonly cy: number
  readonly r: number
  readonly color: string
  readonly bindingCount: number
}

function mountainSize(memberCount: number): number {
  return 17 + Math.min(22, (memberCount - 2) * 6)
}

/** 双峰山形（主峰 + 侧峰），s 为半宽 */
function mountainPath(s: number): string {
  const h = s * 0.95
  return [
    `M ${-s},0`,
    `L ${-s * 0.3},${-h * 0.92}`,
    `L ${-s * 0.05},${-h * 0.5}`,
    `L ${s * 0.32},${-h}`,
    `L ${s},0`,
    'Z',
  ].join(' ')
}

function ballRadius(bindingCount: number): number {
  return 3.5 + Math.min(3.5, (bindingCount - 1) * 1.2)
}

/** 近期度 0..1：最近被锚定越近越亮（30 天线性衰减，flomo「越亮代表越近期」）*/
function freshnessOf(node: AnchorNode): number {
  let latest = 0
  for (const b of node.bindings) {
    const t = parseTs(b.created_at).getTime()
    if (t > latest) latest = t
  }
  if (!latest) return 0.5
  const ageDays = (Date.now() - latest) / 86_400_000
  return Math.max(0, Math.min(1, 1 - ageDays / 30))
}

/** 0..1 → 两位十六进制 alpha */
function alphaHex(a: number): string {
  return Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')
}

/** 锚点域不出现省略号：超长文本对半拆成均衡的两行（SVG text 不会自动换行）*/
function splitTwoLines(s: string, max: number): string[] {
  if (s.length <= max) return [s]
  const mid = Math.ceil(s.length / 2)
  return [s.slice(0, mid), s.slice(mid)]
}

// ── 时间工具（与 TorrentFieldPanel.parseTs 同语义）──

function parseTs(s: string): Date {
  let v = s.includes('T') ? s : s.replace(' ', 'T')
  if (v.length > 10 && !/[Z+]/.test(v.slice(10))) v += 'Z'
  return new Date(v)
}

function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── 主组件 ────────────────────────────────────

interface Props {
  readonly cards: readonly ContextFeedItem[]
  readonly onJumpToCard: (cardId: string) => void
}

export default function AnchorFieldMap({ cards, onJumpToCard }: Props) {
  const [data, setData] = useState<MapData | null>(null)
  const [vectors, setVectors] = useState<Map<string, number[]> | null>(null)
  const [selected, setSelected] = useState<AnchorNode | null>(null)
  const [focusedCluster, setFocusedCluster] = useState<string | null>(null)
  const [hoverCluster, setHoverCluster] = useState<string | null>(null)
  const [hoverBall, setHoverBall] = useState<string | null>(null)
  const [showLegend, setShowLegend] = useState(false)
  const [clusterNames, setClusterNames] = useState<Map<string, string>>(new Map())
  // 视口：viewBox = [x, y, w, w*aspect]
  const [view, setView] = useState({ x: 0, y: 0, w: WORLD_W })
  const viewRef = useRef(view)
  viewRef.current = view
  const animRef = useRef<number | null>(null)
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  // 详情 callout 跟随用：容器像素尺寸（观测 root 自身——无 padding/border，客户区 == SVG 渲染框）
  // 用 callback ref 在节点真正挂载时装 ResizeObserver：组件首帧 data=null 走 empty 分支、
  // 真正的 root 后挂载，空依赖 useEffect 会错过它，callback ref 不受条件渲染影响。
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 })
  const roRef = useRef<ResizeObserver | null>(null)
  const setRootRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect
      setHostSize({ w: cr.width, h: cr.height })
    })
    ro.observe(el)
    setHostSize({ w: el.clientWidth, h: el.clientHeight })
    roRef.current = ro
  }, [])
  const cardRef = useRef<HTMLDivElement>(null)
  const [panelH, setPanelH] = useState(0)
  // 标签测量用：'Exo 2' 400/600 是两张独立 face + display:swap，Pretext 按 font 串缓存度量，
  // 字体没就绪就测会把 fallback 宽永久缓存 → 必须等就绪（600 单独 load）再测，并清掉占位缓存
  const [fontReady, setFontReady] = useState(false)
  useEffect(() => {
    let alive = true
    Promise.all([
      document.fonts.load(`600 11.5px 'Exo 2'`), // 山名 face（600 必须单独 load）
      document.fonts.load(`8px 'Exo 2'`),         // 球标签 face（400）
    ]).then(() => document.fonts.ready).then(() => {
      if (alive) { clearWrapCache(); setFontReady(true) }
    }).catch(() => { if (alive) setFontReady(true) }) // 加载失败也放行，退化用系统字测量
    return () => { alive = false }
  }, [])

  const animateViewTo = useCallback((target: { x: number; y: number; w: number }) => {
    if (animRef.current) cancelAnimationFrame(animRef.current)
    const from = { ...viewRef.current }
    const t0 = performance.now()
    const dur = 480
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      const e = 1 - Math.pow(1 - k, 3)
      setView({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        w: from.w + (target.w - from.w) * e,
      })
      if (k < 1) animRef.current = requestAnimationFrame(step)
      else animRef.current = null
    }
    animRef.current = requestAnimationFrame(step)
  }, [])

  const stopAnim = () => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current)
      animRef.current = null
    }
  }
  useEffect(() => () => stopAnim(), [])

  const reload = useCallback(async () => {
    try {
      const perCard = await Promise.all(cards.map((c) => fetchCardBindings(c.id).catch(() => [])))
      setData(aggregate(perCard))
    } catch (e) {
      console.error('[AnchorField] 加载锚点失败', e)
    }
  }, [cards])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    const onUpdate = () => { void reload() }
    window.addEventListener('solevup:context-updated', onUpdate)
    return () => window.removeEventListener('solevup:context-updated', onUpdate)
  }, [reload])

  // 选中面板实测高度：selected 变（内容变）才量一次缓存，不每帧读 offsetHeight（避免强制 reflow）；
  // 内容超高由 calloutList 的 overflowY:auto 兜底
  useLayoutEffect(() => {
    if (cardRef.current) setPanelH(cardRef.current.offsetHeight)
  }, [selected])

  // 语义嵌入：缺失的增量嵌入并回存（每条锚点只嵌一次）
  useEffect(() => {
    if (!data || data.nodes.length === 0) return
    let alive = true
    ;(async () => {
      const v = await ensureAnchorEmbeddings(
        data.nodes.map((n) => ({ id: n.anchor.id, keyword: n.anchor.keyword })),
      )
      if (alive) setVectors(v)
    })()
    return () => { alive = false }
  }, [data])

  // 球的位置：语义投影优先；向量不足时整体回退共现 force
  // 两种模式都按类分区带：区带内做投影/聚簇，最后整体平移进区带（山不跨类）
  const semantic = useMemo(() => {
    const empty = { positions: new Map<string, { x: number; y: number }>(), usingEmbedding: false, groups: null as string[][] | null, zones: [] as CatZone[] }
    if (!data || data.nodes.length === 0) return empty
    const catOf = new Map(data.nodes.map((n) => [n.anchor.id, n.anchor.category]))
    const withVec = data.nodes
      .filter((n) => vectors?.has(n.anchor.id))
      .map((n) => ({ id: n.anchor.id, vector: vectors!.get(n.anchor.id)! }))
    if (withVec.length >= 2 && withVec.length >= data.nodes.length * 0.6) {
      const zones = computeZones(countByCategory(withVec.map((e) => e.id), catOf))
      const proj = new Map<string, { x: number; y: number }>()
      const groups: string[][] = []
      for (const zone of zones) {
        const entries = withVec.filter((e) => catOf.get(e.id) === zone.cat)
        const zonePad = Math.min(WORLD_PAD, zone.w * 0.22)
        const world = { w: zone.w, h: WORLD_H, pad: zonePad }
        const local = projectAnchors(entries, world)
        // 余弦聚簇（嵌入空间）→ 同簇成员向簇心收拢：簇内紧凑成团，簇间保持语义距离
        const zoneGroups = clusterByCosine(entries)
        for (const g of zoneGroups) {
          if (g.length < 2) continue
          let cx = 0
          let cy = 0
          for (const id of g) {
            const p = local.get(id)!
            cx += p.x
            cy += p.y
          }
          cx /= g.length
          cy /= g.length
          for (const id of g) {
            const p = local.get(id)!
            local.set(id, { x: cx + (p.x - cx) * 0.45, y: cy + (p.y - cy) * 0.45 })
          }
        }
        relaxOverlap(local, 56, world)
        // 山体禁区：成员球推到山脚之外，球和标签不再压在山名上
        for (const g of zoneGroups) {
          if (g.length < 2) continue
          let cx = 0
          let cy = 0
          for (const id of g) {
            const p = local.get(id)!
            cx += p.x
            cy += p.y
          }
          cx /= g.length
          cy /= g.length
          const excl = mountainSize(g.length) + 30
          for (const id of g) {
            const p = local.get(id)!
            const dx = p.x - cx
            const dy = p.y - cy
            const d = Math.hypot(dx, dy)
            if (d < excl) {
              const ang = d < 1e-3 ? hash01(id) * Math.PI * 2 : Math.atan2(dy, dx)
              local.set(id, { x: cx + Math.cos(ang) * excl, y: cy + Math.sin(ang) * excl })
            }
          }
        }
        for (const [id, p] of local) proj.set(id, { x: zone.x0 + p.x, y: p.y })
        groups.push(...zoneGroups)
      }
      // 过渡态：尚无向量的锚点沿底边按 hash 暂放
      for (const n of data.nodes) {
        if (!proj.has(n.anchor.id)) {
          proj.set(n.anchor.id, { x: 80 + hash01(n.anchor.id) * (WORLD_W - 160), y: WORLD_H - 56 })
        }
      }
      return { positions: proj, usingEmbedding: true, groups, zones }
    }
    // 回退：共现 force 同样按类分带（全图布局后横向压进各自区带）
    const zones = computeZones(countByCategory(data.nodes.map((n) => n.anchor.id), catOf))
    const pos = new Map<string, { x: number; y: number }>()
    for (const zone of zones) {
      const subset = data.nodes.filter((n) => n.anchor.category === zone.cat)
      const idSet = new Set(subset.map((n) => n.anchor.id))
      const subEdges = data.edges.filter((e) => idSet.has(e.a) && idSet.has(e.b))
      for (const [id, p] of layoutNodes(subset, subEdges)) {
        pos.set(id, { x: zone.x0 + (p.x / WORLD_W) * zone.w, y: p.y })
      }
    }
    return { positions: pos, usingEmbedding: false, groups: null, zones }
  }, [data, vectors])
  const positions = semantic.positions

  // 聚簇：≥2 球的簇成山（山名 AI 起）；单球独立存在不成山
  // 语义模式在嵌入空间按余弦聚（PCA 归一化会拉伸 2D 距离，不能在投影上聚）；回退模式按 2D 距离聚
  const clusters = useMemo<BallCluster[]>(() => {
    if (!data || data.nodes.length === 0) return []
    const nodeById = new Map(data.nodes.map((n) => [n.anchor.id, n]))
    let groups: string[][]
    if (semantic.groups) {
      groups = semantic.groups
    } else {
      const items = data.nodes
        .map((n) => {
          const p = positions.get(n.anchor.id)
          return p ? { id: n.anchor.id, x: p.x, y: p.y } : null
        })
        .filter((x): x is { id: string; x: number; y: number } => x !== null)
      groups = clusterByDistance(items, CLUSTER_LINK_DIST)
    }
    const out: BallCluster[] = []
    for (const g of groups) {
      if (g.length < 2) continue
      const members = g
        .map((id) => nodeById.get(id)!)
        .sort((a, b) => b.bindings.length - a.bindings.length)
      let cx = 0
      let cy = 0
      for (const id of g) {
        const p = positions.get(id)!
        cx += p.x
        cy += p.y
      }
      cx /= g.length
      cy /= g.length
      let r = 70
      for (const id of g) {
        const p = positions.get(id)!
        const d = Math.hypot(p.x - cx, p.y - cy)
        if (d + 55 > r) r = d + 55
      }
      out.push({
        hash: clusterMemberHash(g),
        members,
        cx,
        cy,
        r,
        color: ANCHOR_CAT_COLOR[members[0].anchor.category],
        bindingCount: members.reduce((acc, m) => acc + m.bindings.length, 0),
      })
    }
    return out.sort((a, b) => b.bindingCount - a.bindingCount)
  }, [data, positions, semantic.groups])

  // 簇命名：缓存命中即出，未命中逐个 AI 起名（增量回填）
  // 等向量加载结束（vectors 非 null）才起名，避免给嵌入前的过渡簇白白起名
  useEffect(() => {
    if (clusters.length === 0 || vectors === null) return
    let alive = true
    void resolveClusterNames(
      clusters.map((c) => ({
        hash: c.hash,
        keywords: c.members.slice(0, 8).map((m) => m.anchor.keyword),
      })),
      (hash, name) => {
        if (alive) setClusterNames((prev) => new Map(prev).set(hash, name))
      },
    )
    return () => { alive = false }
  }, [clusters, vectors])

  // 等高线：球 + 山（簇心）共同构成密度场——纯视觉地貌氛围，
  // 不承载"同主题聚集"语义（聚集由山表达、类别由区带表达）
  const contourPaths = useMemo(() => {
    if (!data || data.nodes.length === 0) return []
    const sources: DensitySource[] = data.nodes.flatMap((n) => {
      const p = positions.get(n.anchor.id)
      if (!p) return []
      return [{ x: p.x, y: p.y, sigma: 24 + n.bindings.length * 4, amp: 0.6 + n.bindings.length * 0.15 }]
    })
    for (const c of clusters) {
      sources.push({ x: c.cx, y: c.cy, sigma: mountainSize(c.members.length) * 1.7, amp: 1.1 })
    }
    const field = densityField(sources)
    return CONTOUR_LEVELS.map((c) => ({ ...c, d: marchingSquares(field, c.level) }))
  }, [data, positions, clusters])

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])

  const stats = useMemo(() => {
    if (!data || data.bindings.length === 0) return null
    const days = new Set(data.bindings.map((b) => fmtDate(parseTs(b.created_at))))
    const earliest = data.bindings
      .map((b) => parseTs(b.created_at))
      .reduce((a, b) => (b < a ? b : a))
    return { anchors: data.nodes.length, bindings: data.bindings.length, days: days.size, since: fmtDate(earliest) }
  }, [data])

  // ── 缩放（围绕鼠标）+ 平移 + 飞行 ──
  // letterbox-aware：与 worldToScreen 同源（meet 缩放 + 居中偏移），是它的精确逆。
  // 旧版直接 r.width/r.height 线性映射，仅当容器宽高比 == 1.613 时正确；实际容器多为其它比例
  // → 会有 letterbox 偏移，造成「围绕鼠标缩放」焦点漂移、平移轴向不一致。
  const clientToWorld = (cx: number, cy: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const r = svg.getBoundingClientRect()
    const vh = view.w * (WORLD_H / WORLD_W)
    const meet = Math.min(r.width / view.w, r.height / vh)
    const offX = (r.width - view.w * meet) / 2
    const offY = (r.height - vh * meet) / 2
    return {
      x: view.x + ((cx - r.left) - offX) / meet,
      y: view.y + ((cy - r.top) - offY) / meet,
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    stopAnim()
    const factor = e.deltaY > 0 ? 1.16 : 1 / 1.16
    const w = Math.max(220, Math.min(WORLD_W * 1.6, view.w * factor))
    const p = clientToWorld(e.clientX, e.clientY)
    const k = w / view.w
    setView({ x: p.x - (p.x - view.x) * k, y: p.y - (p.y - view.y) * k, w })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    stopAnim()
    dragRef.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const svg = svgRef.current
    if (!d || !svg) return
    const r = svg.getBoundingClientRect()
    // 与 letterbox 缩放一致：每屏幕像素 = 1/meet 个世界单位（x/y 同尺度），消除轴向漂移
    const vh = view.w * (WORLD_H / WORLD_W)
    const k = 1 / Math.min(r.width / view.w, r.height / vh)
    setView((v) => ({ ...v, x: d.vx - (e.clientX - d.sx) * k, y: d.vy - (e.clientY - d.sy) * k }))
  }
  const onPointerUp = () => { dragRef.current = null }

  const focusCluster = (c: BallCluster) => {
    setFocusedCluster(c.hash)
    const w = Math.max(320, Math.min(WORLD_W, c.r * 2.8))
    animateViewTo({ x: c.cx - w / 2, y: c.cy - (w * (WORLD_H / WORLD_W)) / 2, w })
  }
  const resetView = () => {
    setFocusedCluster(null)
    animateViewTo({ x: 0, y: 0, w: WORLD_W })
  }
  const zoomBy = (factor: number) => {
    const v = viewRef.current
    const w = Math.max(220, Math.min(WORLD_W * 1.6, v.w * factor))
    const cx = v.x + v.w / 2
    const cy = v.y + (v.w * (WORLD_H / WORLD_W)) / 2
    animateViewTo({ x: cx - w / 2, y: cy - (w * (WORLD_H / WORLD_W)) / 2, w })
  }

  const viewH = view.w * (WORLD_H / WORLD_W)
  const showBallLabels = view.w < BALL_LABEL_ZOOM // 放大后才显示锚点句（地图式按缩放出细节）

  // 世界→容器像素（letterbox-aware，复刻 SVG 默认 xMidYMid meet）。
  // 纯函数：与 SVG viewBox 同源、同帧渲染期计算 → 详情面板跟随节点零滞后、无需读 getScreenCTM。
  // 注意：不放进 positions/clusters/contourPaths 的 useMemo（那会让平移每帧重算 marchingSquares）。
  const worldToScreen = (wx: number, wy: number) => {
    const { w: cw, h: ch } = hostSize
    if (cw === 0 || ch === 0) return null
    const scale = Math.min(cw / view.w, ch / viewH) // meet = min
    const offX = (cw - view.w * scale) / 2
    const offY = (ch - viewH * scale) / 2
    return { sx: offX + (wx - view.x) * scale, sy: offY + (wy - view.y) * scale, scale }
  }

  // 选中球的屏幕几何（render 期算，view 每帧变 → 面板自动跟随）
  const calloutGeom = (() => {
    if (!selected) return null
    const p = positions.get(selected.anchor.id)
    const s = p && worldToScreen(p.x, p.y)
    if (!s) return null
    // 球屏幕半径补 1.4 余量 + 2px：盖住 hover 1.35 放大与 glow 外扩，贴边时面板不压光晕
    const ballScreenR = ballRadius(selected.bindings.length) * s.scale * 1.4 + 2
    return { sx: s.sx, sy: s.sy, ballScreenR }
  })()

  // 放置：右优先 → 翻左 → 取空间大侧并钳制；垂直居中对齐球心后钳制；节点完全出界则隐藏
  const calloutPlace = (() => {
    if (!calloutGeom) return null
    const { sx, sy, ballScreenR } = calloutGeom
    const cw = hostSize.w
    const ch = hostSize.h
    const effH = panelH || PANEL_MAX_H_PX
    const ballOut =
      sx + ballScreenR < 0 || sx - ballScreenR > cw ||
      sy + ballScreenR < 0 || sy - ballScreenR > ch
    const roomRight = cw - (sx + ballScreenR)
    const roomLeft = sx - ballScreenR
    const needW = PANEL_W + PANEL_GAP + PANEL_MARGIN
    let arrowSide: 'left' | 'right'
    let left: number
    if (roomRight >= needW) {
      arrowSide = 'left'
      left = sx + ballScreenR + PANEL_GAP
    } else if (roomLeft >= needW) {
      arrowSide = 'right'
      left = sx - ballScreenR - PANEL_GAP - PANEL_W
    } else if (roomRight >= roomLeft) {
      arrowSide = 'left'
      left = sx + ballScreenR + PANEL_GAP
    } else {
      arrowSide = 'right'
      left = sx - ballScreenR - PANEL_GAP - PANEL_W
    }
    left = clamp(left, PANEL_MARGIN, Math.max(PANEL_MARGIN, cw - PANEL_W - PANEL_MARGIN))
    const top = effH > ch - 2 * PANEL_MARGIN
      ? PANEL_MARGIN
      : clamp(sy - effH / 2, PANEL_MARGIN, ch - effH - PANEL_MARGIN)
    return { sx, sy, ballScreenR, left, top, arrowSide, ballOut }
  })()

  // 悬浮卡片的世界坐标矩形（屏幕矩形逆变换回世界）：球标签整列「横移」避开它（不当避让障碍 → 不被推远）
  const cardWorldRect = (() => {
    if (!calloutPlace || calloutPlace.ballOut) return null
    const { w: cw, h: ch } = hostSize
    if (cw === 0 || ch === 0) return null
    const scale = Math.min(cw / view.w, ch / viewH)
    const offX = (cw - view.w * scale) / 2
    const offY = (ch - viewH * scale) / 2
    const toWX = (px: number) => view.x + (px - offX) / scale
    const toWY = (py: number) => view.y + (py - offY) / scale
    const effH = panelH || PANEL_MAX_H_PX
    return {
      x0: toWX(calloutPlace.left), x1: toWX(calloutPlace.left + PANEL_W),
      y0: toWY(calloutPlace.top), y1: toWY(calloutPlace.top + effH),
    }
  })()
  const cardX0 = cardWorldRect?.x0, cardX1 = cardWorldRect?.x1, cardY0 = cardWorldRect?.y0, cardY1 = cardWorldRect?.y1
  const selectedId = selected?.anchor.id ?? null

  // 标签整块避让排版：只对「文本」避障——山体半透明、峰形不算障碍；障碍集 =
  // 山名文本盒（地标固定）+ 已放置的球标签块（球-球互避）。
  // 弹出的详情卡片只让「选中球 + 它附近一圈的球」整列横移避开（卡片就在选中球旁，只有这一圈会压到它）；
  // 离得远的球一律不避、留在球旁——节点多时全体避卡片太复杂，只保卡片附近这一小圈整洁即可。
  const labelLayout = useMemo<{ mountainWraps: Map<string, WrappedLabel>; ballLines: Map<string, PlacedLine[]> }>(() => {
    const mountainWraps = new Map<string, WrappedLabel>()
    const ballLines = new Map<string, PlacedLine[]>()
    if (!data || !fontReady) return { mountainWraps, ballLines }
    const card: Obstacle | null = (cardX0 != null && cardX1 != null && cardY0 != null && cardY1 != null)
      ? { x0: cardX0, x1: cardX1, y0: cardY0, y1: cardY1 } : null
    // 避让范围按「离选中球的距离」判：x 很窄、y 宽松——卡片紧贴选中球纵向延展，
    // 只有跟选中球几乎同一竖列（x 近）、上下各种高度（y 宽）的标签才让它避卡片；
    // x 离选中球远的一律不避（即使压到卡片也留原位被遮，不被拉来挪动、飘过去）。
    const selPos = selectedId ? (positions.get(selectedId) ?? null) : null
    // x 避让阈值 = 选中球↔卡片连线的 x 跨度（球心 → 卡片近缘）+ 本节点半径：
    // 恰好「整个球塞得进选中球与卡片之间缝隙」的节点才算压到、才让它避；再偏一点缝隙放得下就不避。
    // 缝隙(spanX)与节点半径(r)都是世界量 → 缩放时缝隙相对节点大小会随之放大缩小（这正是想要的）。
    const spanX = (selPos && cardX0 != null && cardX1 != null)
      ? (cardX0 >= selPos.x ? cardX0 - selPos.x : cardX1 <= selPos.x ? selPos.x - cardX1 : 0)
      : 0
    const NEAR_DY = 150  // y 宽松：离选中球纵向 ≤150 都算（卡片高）
    const obstacles: Obstacle[] = []
    for (const c of clusters) {
      const name = clusterNames.get(c.hash) ?? '起名中…'
      const m = measureMountain(name)
      mountainWraps.set(c.hash, m)
      // 山名盒收紧到文字实际范围（首行基线 cy+DY，向上一个 ascent、向下到末行 + descent）
      const nameLines = Math.max(1, Math.round(m.h / MOUNT_LH))
      obstacles.push({
        x0: c.cx - m.w / 2, x1: c.cx + m.w / 2,
        y0: c.cy + MOUNT_ANCHOR_DY - 9, y1: c.cy + MOUNT_ANCHOR_DY + (nameLines - 1) * MOUNT_LH + 3,
      })
    }
    // 球标签：按绑定数降序放置（重要的先占位）；整列避山名 + 整块横移避卡片，放完把各行加入障碍 → 球-球互避
    if (showBallLabels) {
      const ordered = [...data.nodes].sort((a, b) => b.bindings.length - a.bindings.length)
      for (const n of ordered) {
        const p = positions.get(n.anchor.id)
        if (!p) continue
        const r = ballRadius(n.bindings.length)
        const topY = p.y + r + BALL_GAP
        const near = !!(card && selPos
          && Math.abs(p.x - selPos.x) < spanX + r
          && Math.abs(p.y - selPos.y) < NEAR_DY)
        const placed = layoutBallFlow(p.x, topY, n.anchor.keyword, obstacles, WORLD_W, near ? card : null)
        ballLines.set(n.anchor.id, placed)
        placed.forEach((ln) => obstacles.push({ x0: ln.cx - ln.w / 2, x1: ln.cx + ln.w / 2, y0: ln.y, y1: ln.y + BALL_LH }))
      }
    }
    return { mountainWraps, ballLines }
  }, [data, clusters, clusterNames, positions, showBallLabels, fontReady, cardX0, cardX1, cardY0, cardY1, selectedId])

  // 悬浮焦点（山或球）：用于等高线的局部逐层点亮
  const hoverFocus = (() => {
    if (hoverCluster) {
      const c = clusters.find((x) => x.hash === hoverCluster)
      if (c) {
        const s = mountainSize(c.members.length)
        return { x: c.cx, y: c.cy - s * 0.25, r: s * 4.6 }
      }
    }
    if (hoverBall && data) {
      const p = positions.get(hoverBall)
      const n = data.nodes.find((x) => x.anchor.id === hoverBall)
      if (p && n) return { x: p.x, y: p.y, r: ballRadius(n.bindings.length) * 5.5 }
    }
    return null
  })()

  if (!data) return <div style={styles.empty}>加载锚点域…</div>
  if (data.nodes.length === 0) {
    return <div style={styles.empty}>还没有锚点。在语境库展开转录聊一聊、或在日常聊天里说出值得记的想法，球与山会在这里生长。</div>
  }

  return (
    <div ref={setRootRef} style={styles.root}>
      <style>{`
        /* 详情 callout 从节点侧延展打开（clip 揭示，不挤压内容）*/
        @keyframes afCalloutRevealL {
          from { clip-path: inset(0 100% 0 0); opacity: 0.15; }
          to   { clip-path: inset(0 0 0 0); opacity: 1; }
        }
        @keyframes afCalloutRevealR {
          from { clip-path: inset(0 0 0 100%); opacity: 0.15; }
          to   { clip-path: inset(0 0 0 0); opacity: 1; }
        }
        .af-callout-srclink:hover { text-decoration: underline; }
      `}</style>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${viewH}`}
        style={{ width: '100%', height: '100%', cursor: dragRef.current ? 'grabbing' : 'grab', display: 'block' }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <defs>
          <pattern id="af-dots" width="34" height="34" patternUnits="userSpaceOnUse">
            <path d="M17 14.5 V19.5 M14.5 17 H19.5" stroke="rgba(120,200,255,0.07)" strokeWidth="1" />
          </pattern>
          <filter id="af-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* 山体亮面渐变（flomo 式实心地标）*/}
          <linearGradient id="af-peak" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f2f9ff" />
            <stop offset="100%" stopColor="#92accc" />
          </linearGradient>
          {/* 悬浮态暖色山体 */}
          <linearGradient id="af-peak-hot" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffeebc" />
            <stop offset="100%" stopColor="#e0b768" />
          </linearGradient>
          {/* 悬浮态暖光晕：点亮周围地形（screen 混合提亮等高线）*/}
          <radialGradient id="af-halo">
            <stop offset="0%" stopColor="rgba(255,228,160,0.30)" />
            <stop offset="55%" stopColor="rgba(255,219,150,0.11)" />
            <stop offset="100%" stopColor="rgba(255,219,150,0)" />
          </radialGradient>
          {/* 悬浮点亮等高线用的径向渐隐遮罩（中心实、边缘虚）*/}
          <radialGradient id="af-hover-mask-g">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="60%" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          {hoverFocus && (
            <mask id="af-hover-mask">
              <circle cx={hoverFocus.x} cy={hoverFocus.y} r={hoverFocus.r} fill="url(#af-hover-mask-g)" />
            </mask>
          )}
        </defs>

        <rect x={-WORLD_W} y={-WORLD_H} width={WORLD_W * 3} height={WORLD_H * 3} fill="url(#af-dots)" />

        {/* 类区带：三类各占一片（底色微染 + 顶部类名 + 区带分隔线）*/}
        {semantic.zones.map((z, zi) => {
          const zc = ANCHOR_CAT_COLOR[z.cat]
          return (
            <g key={`zone-${z.cat}`} pointerEvents="none">
              <rect x={z.x0} y={0} width={z.w} height={WORLD_H} fill={zc} opacity={0.03} />
              {/* 类名放区带右上角：左上角被统计浮层占着 */}
              <text
                x={z.x0 + z.w - 16}
                y={26}
                textAnchor="end"
                fill={zc}
                opacity={0.6}
                fontSize={12}
                fontWeight={600}
                fontFamily={theme.fontBody}
                style={{ letterSpacing: 6 }}
              >
                {catShort(z.cat)}
              </text>
              {zi < semantic.zones.length - 1 && (
                <line
                  x1={z.x0 + z.w + ZONE_GAP / 2}
                  y1={16}
                  x2={z.x0 + z.w + ZONE_GAP / 2}
                  y2={WORLD_H - 16}
                  stroke="rgba(120,200,255,0.10)"
                  strokeWidth={1}
                  strokeDasharray="2 7"
                />
              )}
            </g>
          )
        })}

        {/* 等高线地形 */}
        {contourPaths.map((c, i) => (
          <path
            key={`contour-${i}`}
            d={c.d}
            fill="none"
            stroke="rgb(168,212,240)"
            strokeOpacity={c.opacity}
            strokeWidth={1}
            strokeDasharray={c.dash}
            pointerEvents="none"
          />
        ))}

        {/* 悬浮时：焦点周围的等高线逐层暖色点亮（径向渐隐，越近越亮）*/}
        {hoverFocus && (
          <g mask="url(#af-hover-mask)" pointerEvents="none">
            {contourPaths.map((c, i) => (
              <path
                key={`contour-hot-${i}`}
                d={c.d}
                fill="none"
                stroke="rgb(255,224,166)"
                strokeOpacity={Math.min(0.9, c.opacity * 2.1)}
                strokeWidth={1.3}
                strokeDasharray={c.dash}
              />
            ))}
          </g>
        )}

        {/* 球（锚点句）：三类低饱和染色，越亮越近期；悬浮放大提亮，点击看绑定详情。
            先画球 + 球标签，山（地标）随后画压在最上层 */}
        {data.nodes.map((n) => {
          const p = positions.get(n.anchor.id)
          if (!p) return null
          const c = ANCHOR_CAT_COLOR[n.anchor.category]
          const hovered = hoverBall === n.anchor.id
          const active = selected?.anchor.id === n.anchor.id || hovered
          const fresh = freshnessOf(n)
          const r = ballRadius(n.bindings.length) * (hovered ? 1.35 : 1)
          const fillA = active ? 0.8 : 0.22 + 0.4 * fresh
          const strokeA = active ? 1 : 0.42 + 0.4 * fresh
          return (
            <g key={n.anchor.id} transform={`translate(${p.x}, ${p.y})`}>
              {hovered && (
                <circle r={r * 4.5} fill="url(#af-halo)" pointerEvents="none" style={{ mixBlendMode: 'screen' }} />
              )}
              <circle
                r={r}
                fill={`${c}${alphaHex(fillA)}`}
                stroke={`${c}${alphaHex(strokeA)}`}
                strokeWidth={active ? 1.4 : 0.8}
                style={{ cursor: 'pointer', transition: 'fill 0.15s, r 0.15s' }}
                filter={active ? 'url(#af-glow)' : undefined}
                // 再次点击同一球 → 收起面板（toggle）
                onClick={(e) => { e.stopPropagation(); setSelected((prev) => (prev?.anchor.id === n.anchor.id ? null : n)) }}
                onMouseEnter={() => setHoverBall(n.anchor.id)}
                onMouseLeave={() => setHoverBall((prev) => (prev === n.anchor.id ? null : prev))}
              />
              {/* 非高亮球标签：高亮(active)标签移到「山名之上、山体之下」的专门层画，这里只画非高亮 */}
              {showBallLabels && !active && (() => {
                const placed = labelLayout.ballLines.get(n.anchor.id)
                if (!placed) return null
                return placed.map((ln, li) => (
                  <text
                    key={li}
                    x={ln.cx - p.x}
                    y={(ln.y - p.y) + BALL_LH * 0.8}
                    textAnchor="middle"
                    fill={theme.textMuted}
                    fontSize={8}
                    fontFamily={theme.fontBody}
                    pointerEvents="none"
                    style={{ paintOrder: 'stroke', stroke: 'rgba(0,6,16,0.85)', strokeWidth: 2.5 }}
                  >
                    {ln.text}
                  </text>
                ))
              })()}
            </g>
          )
        })}

        {/* 山名文本层：先于高亮球标签画 → 高亮锚点句能盖过山名看清；纯展示，交互在下方山体图标层 */}
        {clusters.map((c) => {
          const hot = hoverCluster === c.hash || focusedCluster === c.hash
          const m = labelLayout.mountainWraps.get(c.hash)
          const lines = m ? m.lines : splitTwoLines(clusterNames.get(c.hash) ?? '起名中…', 10)
          return (
            <g key={`mname-${c.hash}`} transform={`translate(${c.cx}, ${c.cy})`} pointerEvents="none">
              {lines.map((line, li) => (
                <text
                  key={li}
                  y={16 + li * MOUNT_LH}
                  textAnchor="middle"
                  fill={hot ? '#f4d896' : '#e6f2fc'}
                  fontSize={11.5}
                  fontWeight={600}
                  fontFamily={theme.fontBody}
                  style={{ paintOrder: 'stroke', stroke: 'rgba(0,6,16,0.88)', strokeWidth: 3 }}
                >
                  {line}
                </text>
              ))}
            </g>
          )
        })}

        {/* 高亮球标签层：画在山名之上 → 选中/悬浮的锚点句盖过山名看得清；但被下面山体图标层压住（低于山体图标）*/}
        {data.nodes.map((n) => {
          const hovered = hoverBall === n.anchor.id
          const active = selected?.anchor.id === n.anchor.id || hovered
          if (!active) return null
          const p = positions.get(n.anchor.id)
          if (!p) return null
          const r = ballRadius(n.bindings.length) * (hovered ? 1.35 : 1)
          const placed = labelLayout.ballLines.get(n.anchor.id)
          const lines = placed
            ? placed
            : (hovered
              ? (fontReady ? measureBall(n.anchor.keyword).lines : splitTwoLines(n.anchor.keyword, 13))
                .map((text, li) => ({ text, cx: p.x, y: p.y + r + 10 + li * BALL_LH - BALL_LH * 0.8, w: 0 }))
              : [])
          return (
            <g key={`hl-${n.anchor.id}`} transform={`translate(${p.x}, ${p.y})`} pointerEvents="none">
              {lines.map((ln, li) => (
                <text
                  key={li}
                  x={ln.cx - p.x}
                  y={(ln.y - p.y) + BALL_LH * 0.8}
                  textAnchor="middle"
                  fill="#f4d896"
                  fontSize={8}
                  fontFamily={theme.fontBody}
                  style={{ paintOrder: 'stroke', stroke: 'rgba(0,6,16,0.85)', strokeWidth: 2.5 }}
                >
                  {ln.text}
                </text>
              ))}
            </g>
          )
        })}

        {/* 山体图标层：最后画、压在最上（含高亮标签）—— 三角是纯地标符号，盖住文本不损失信息（低于它=高亮文本仍清晰）*/}
        {clusters.map((c) => {
          const s = mountainSize(c.members.length)
          const h = s * 0.95
          const hot = hoverCluster === c.hash || focusedCluster === c.hash
          return (
            <g
              key={c.hash}
              transform={`translate(${c.cx}, ${c.cy})`}
              style={{ cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); focusCluster(c) }}
              onMouseEnter={() => setHoverCluster(c.hash)}
              onMouseLeave={() => setHoverCluster((prev) => (prev === c.hash ? null : prev))}
            >
              {/* 悬浮/聚焦：暖光晕点亮周围地形（flomo 式）*/}
              {hot && (
                <circle
                  r={s * 4.4}
                  cy={-h * 0.25}
                  fill="url(#af-halo)"
                  pointerEvents="none"
                  style={{ mixBlendMode: 'screen' }}
                />
              )}
              <path
                d={mountainPath(s)}
                fill={hot ? 'url(#af-peak-hot)' : 'url(#af-peak)'}
                fillOpacity={hot ? MOUNTAIN_FILL_OPACITY_HOT : MOUNTAIN_FILL_OPACITY}
                stroke="rgba(6,14,26,0.9)"
                strokeWidth={0.8}
                strokeLinejoin="round"
              />
              {/* 右侧暗面，给山体一点体积感 */}
              <path d={`M ${s * 0.32},${-h} L ${s},0 L 0,0 Z`} fill="rgba(10,24,40,0.30)" />
            </g>
          )
        })}
      </svg>

      {/* 左上统计 */}
      {stats && (
        <div style={styles.stats}>
          <div>ANCHORS {stats.anchors}</div>
          <div>BINDINGS {stats.bindings}</div>
          <div>TOPICS {clusters.length}</div>
          <div>DAYS {stats.days}</div>
          <div>SINCE {stats.since}</div>
          {!semantic.usingEmbedding && <div style={{ color: theme.warningOrange }}>语义定位待嵌入</div>}
        </div>
      )}

      {/* 左侧区域导航（簇 = 开放世界小区域）*/}
      {clusters.length > 0 && (
        <nav style={styles.regionNav}>
          <div style={styles.regionNavTitle}>区 域</div>
          <button
            type="button"
            onClick={resetView}
            style={{ ...styles.regionItem, ...(focusedCluster === null ? styles.regionItemActive : null) }}
          >
            <span style={{ ...styles.regionDot, background: theme.textMuted }} />
            <span style={styles.regionName}>全图</span>
          </button>
          {clusters.map((c) => (
            <button
              key={c.hash}
              type="button"
              onClick={() => focusCluster(c)}
              style={{ ...styles.regionItem, ...(focusedCluster === c.hash ? styles.regionItemActive : null) }}
            >
              <span style={{ ...styles.regionDot, background: c.color, boxShadow: `0 0 5px ${c.color}` }} />
              <span style={styles.regionName}>{clusterNames.get(c.hash) ?? '起名中…'}</span>
              <span style={styles.regionCount}>{c.members.length}锚·{c.bindingCount}定</span>
            </button>
          ))}
        </nav>
      )}

      {/* 底部缩放工具条 */}
      <div style={styles.toolbar}>
        <Tooltip content="缩小">
          <button type="button" style={styles.toolBtn} onClick={() => zoomBy(1.3)}>
            <Minus size={12} />
          </button>
        </Tooltip>
        <span style={styles.toolPct}>{Math.round((WORLD_W / view.w) * 100)}%</span>
        <Tooltip content="放大">
          <button type="button" style={styles.toolBtn} onClick={() => zoomBy(1 / 1.3)}>
            <Plus size={12} />
          </button>
        </Tooltip>
        <span style={styles.toolDivider} />
        <Tooltip content="图例">
          <button
            type="button"
            style={{ ...styles.toolBtn, color: showLegend ? theme.electricBlue : theme.textSecondary }}
            onClick={() => setShowLegend((v) => !v)}
          >
            <HelpCircle size={12} />
          </button>
        </Tooltip>
        <Tooltip content="复位视角">
          <button type="button" style={styles.toolBtn} onClick={resetView}>
            <RotateCcw size={12} />
          </button>
        </Tooltip>
      </div>

      {/* 图例（flomo 式说明）*/}
      {showLegend && (
        <div style={styles.legend}>
          <div style={styles.legendRow}>
            <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="3.5" fill={`${theme.electricBlue}99`} stroke={theme.electricBlue} strokeWidth="0.8" /></svg>
            圆点 = 一条锚点句，越亮代表越近期（橙动机 / 蓝观点 / 绿实践）
          </div>
          <div style={styles.legendRow}>
            <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke="rgba(150,220,255,0.6)" strokeWidth="1" /></svg>
            等高线 = 球与山勾出的地势起伏（视觉地貌氛围）
          </div>
          <div style={styles.legendRow}>
            <svg width="14" height="14" viewBox="-7 -11 14 12"><path d={mountainPath(6)} fill="#cfe2f3" /></svg>
            山峰 = AI 从锚点内容中提取的核心主题
          </div>
        </div>
      )}

      {/* 详情 callout：悬浮在被选中球右侧、随平移缩放跟随（放不下翻左）。
          容器未测量/位置缺失 → 退化固定右上角；节点完全移出可视区 → 隐藏（保留 selected，回到视野自动重现）*/}
      {selected && !calloutPlace && (
        <AnchorDetail key={selected.anchor.id} node={selected} cardById={cardById} cardRef={cardRef}
          onClose={() => setSelected(null)} onJumpToCard={onJumpToCard} placement={null} arrowSide="left"
          nodeHovered={hoverBall === selected.anchor.id} />
      )}
      {selected && calloutPlace && !calloutPlace.ballOut && (
        <>
          <ConnectorOverlay
            sx={calloutPlace.sx}
            sy={calloutPlace.sy}
            ballScreenR={calloutPlace.ballScreenR}
            left={calloutPlace.left}
            top={calloutPlace.top}
            panelH={panelH || PANEL_MAX_H_PX}
            arrowSide={calloutPlace.arrowSide}
            color={ANCHOR_CAT_COLOR[selected.anchor.category]}
          />
          <AnchorDetail key={selected.anchor.id} node={selected} cardById={cardById} cardRef={cardRef}
            onClose={() => setSelected(null)} onJumpToCard={onJumpToCard}
            placement={{ left: calloutPlace.left, top: calloutPlace.top }} arrowSide={calloutPlace.arrowSide}
            nodeHovered={hoverBall === selected.anchor.id} />
        </>
      )}
    </div>
  )
}

// ── 连接线：屏幕空间 overlay SVG（独立于地图 viewBox，线宽恒定不随缩放变形）──
//   球侧双环呼吸靶心 → 斜折线 → 面板侧锐角三角，左右镜像。终点对准球的纵坐标（与收起 chevron 同高）
function ConnectorOverlay({ sx, sy, ballScreenR, left, top, panelH, arrowSide, color }: {
  readonly sx: number
  readonly sy: number
  readonly ballScreenR: number
  readonly left: number
  readonly top: number
  readonly panelH: number
  readonly arrowSide: 'left' | 'right'
  readonly color: string
}) {
  const x0 = sx + (arrowSide === 'left' ? ballScreenR : -ballScreenR) // 起点 = 球缘（朝面板一侧）
  const y0 = sy
  const edge = arrowSide === 'left' ? left : left + PANEL_W           // 面板对应缘（收起条外缘，三角底边）
  const apexX = arrowSide === 'left' ? edge - 7 : edge + 7            // 三角朝向节点的顶点
  const y1 = top + panelH / 2                                         // 终点固定在收起条竖向中点（= 居中 chevron 处）
  // 短横线引出 + 斜线接三角 apex：节点旁先平出一小段（8px），再斜拉到三角尖。
  // 节点在中点时整体为水平线；偏离时为短横 + 斜线（无竖直段）
  const stub = arrowSide === 'left' ? x0 + 8 : x0 - 8
  const d = `M ${x0} ${y0} L ${stub} ${y0} L ${apexX} ${y1}`
  const tri = arrowSide === 'left'
    ? `M ${edge} ${y1 - 5} L ${apexX} ${y1} L ${edge} ${y1 + 5} Z`
    : `M ${edge} ${y1 - 5} L ${apexX} ${y1} L ${edge} ${y1 + 5} Z`
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: CONNECTOR_Z }}>
      <defs>
        <filter id="af-callout-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <path d={d} fill="none" stroke={color} strokeWidth={2.4} strokeOpacity={0.4} filter="url(#af-callout-glow)" />
      <path d={d} fill="none" stroke={color} strokeWidth={1.1} strokeOpacity={0.85} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x0} cy={y0} r={3.5} fill="none" stroke={color} strokeWidth={1.2} strokeOpacity={0.9}>
        <animate attributeName="r" values="3.2;5.4;3.2" dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="stroke-opacity" values="0.9;0.3;0.9" dur="2.4s" repeatCount="indefinite" />
      </circle>
      <circle cx={x0} cy={y0} r={1.6} fill={color} />
      <path d={tri} fill={color} fillOpacity={0.85} />
    </svg>
  )
}

// ── 四角括号帧（类别色版，沿用 TranscriptPlayerWindow 范式）──
function CornerBrackets({ color }: { readonly color: string }) {
  const L = BRACKET_LEN
  const base: CSSProperties = { position: 'absolute', width: L, height: L, pointerEvents: 'none', zIndex: 2 }
  const glow = `drop-shadow(0 0 3px ${color}aa)`
  return (
    <>
      <span style={{ ...base, left: -1, top: -1, borderLeft: `1.5px solid ${color}`, borderTop: `1.5px solid ${color}`, filter: glow }} />
      <span style={{ ...base, right: -1, top: -1, borderRight: `1.5px solid ${color}`, borderTop: `1.5px solid ${color}`, filter: glow }} />
      <span style={{ ...base, left: -1, bottom: -1, borderLeft: `1.5px solid ${color}`, borderBottom: `1.5px solid ${color}`, filter: glow }} />
      <span style={{ ...base, right: -1, bottom: -1, borderRight: `1.5px solid ${color}`, borderBottom: `1.5px solid ${color}`, filter: glow }} />
    </>
  )
}

// ── 详情面板 ──────────────────────────────────

function catShort(cat: AnchorCategory): string {
  return cat === 'motive' ? '动机' : cat === 'view' ? '观点' : '实践'
}

function AnchorDetail({ node, cardById, cardRef, onClose, onJumpToCard, placement, arrowSide, nodeHovered = false }: {
  readonly node: AnchorNode
  readonly cardById: Map<string, ContextFeedItem>
  readonly cardRef: Ref<HTMLDivElement>
  readonly onClose: () => void
  readonly onJumpToCard: (cardId: string) => void
  readonly placement: { left: number; top: number } | null
  // 收起条所在侧 = 朝向节点的那一侧：'left' = 面板在球右侧（条在左缘）/ 'right' = 面板在球左侧（条在右缘）
  readonly arrowSide: 'left' | 'right'
  // 鼠标是否正悬在「这张卡对应的节点」上（父级 hoverBall===selected）；与卡片自身 hover 一起触发 HUD 边框
  readonly nodeHovered?: boolean
}) {
  const c = ANCHOR_CAT_COLOR[node.anchor.category]
  const [editing, setEditing] = useState(false)
  const [cardHovered, setCardHovered] = useState(false)
  const hudOn = cardHovered || nodeHovered  // 鼠标在卡片或节点上 → 浮出 HUD 边框（否则只是透明玻璃卡）
  const [draft, setDraft] = useState(node.anchor.keyword)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // 最近锚定日期（与 freshnessOf 同源）
  const latestDate = useMemo(() => {
    let latest = 0
    for (const b of node.bindings) {
      const t = parseTs(b.created_at).getTime()
      if (t > latest) latest = t
    }
    return latest ? fmtDate(new Date(latest)) : '—'
  }, [node])

  const saveKeyword = async () => {
    const keyword = draft.trim()
    if (!keyword || keyword === node.anchor.keyword) {
      setEditing(false)
      return
    }
    setSaving(true)
    setEditError(null)
    try {
      await updateAnchorKeyword(node.anchor.id, keyword)
      setEditing(false)
      onClose() // 锚点句变了 → 重嵌入/重聚簇，旧详情已过期
      window.dispatchEvent(new CustomEvent('solevup:context-updated'))
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // 跟随定位（placement）或退化固定右上角（容器未测量/位置缺失）
  const shellPos: CSSProperties = placement
    ? { left: placement.left, top: placement.top }
    : { right: PANEL_MARGIN, top: PANEL_MARGIN }

  // 收起条：跨整条竖边，位于朝向节点的一侧。点击收起；chevron 指向节点（折回去）
  const collapseBar = (
    <Tooltip content="收起（或再次点击该节点）" display="flex">
      <button
        type="button"
        onClick={onClose}
        style={{
          ...styles.calloutCollapse,
          color: `${c}cc`,
          background: `${c}12`,
          ...(arrowSide === 'left'
            ? { borderRight: `1px solid ${c}33` }
            : { borderLeft: `1px solid ${c}33` }),
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = `${c}26`; e.currentTarget.style.color = c }}
        onMouseLeave={(e) => { e.currentTarget.style.background = `${c}12`; e.currentTarget.style.color = `${c}cc` }}
      >
        {arrowSide === 'left' ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
      </button>
    </Tooltip>
  )

  return (
    <div style={{ ...styles.calloutShell, ...shellPos }}>
      <div
        ref={cardRef}
        onWheel={(e) => e.stopPropagation()}        // 防穿透：在面板上滚动不触发地图缩放
        onPointerDown={(e) => e.stopPropagation()}  // 防穿透：在面板上按下不触发地图平移
        onMouseEnter={() => setCardHovered(true)}
        onMouseLeave={() => setCardHovered(false)}
        style={{
          ...styles.calloutCard,
          // 默认：弱中性细边，只留玻璃感、不抢镜；hover 节点/卡片才点亮成类别色 HUD 边框 + 光晕
          borderColor: hudOn ? `${c}aa` : 'rgba(150,200,255,0.14)',
          boxShadow: hudOn
            ? `0 16px 46px rgba(0,0,0,0.5), 0 0 22px ${c}55, inset 0 1px 0 rgba(255,255,255,0.06)`
            : '0 16px 40px rgba(0,0,0,0.45)',
          transition: 'border-color 0.18s, box-shadow 0.18s',
          // 从节点侧延展打开（arrowSide='left' 面板在球右侧→从左缘展开；'right' 反之）
          animation: `${arrowSide === 'left' ? 'afCalloutRevealL' : 'afCalloutRevealR'} 0.3s cubic-bezier(0.22,1,0.36,1)`,
        }}
      >
        {hudOn && <CornerBrackets color={c} />}

        {/* 收起条在朝向节点一侧（左缘 / 右缘） */}
        {arrowSide === 'left' && collapseBar}

        <div style={styles.calloutBody}>
          <div style={styles.calloutHead}>
            <span style={{ ...styles.calloutChip, color: c, borderColor: `${c}66`, background: `${c}1A` }}>
              {catShort(node.anchor.category)}
            </span>
            {editing ? (
              <input
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveKeyword()
                  if (e.key === 'Escape') { setEditing(false); setEditError(null) }
                }}
                style={styles.calloutEditInput}
              />
            ) : (
              <strong style={styles.calloutKeyword}>{node.anchor.keyword}</strong>
            )}
            {editing ? (
              <Tooltip content="保存（Enter）">
                <button
                  type="button"
                  onClick={() => void saveKeyword()}
                  disabled={saving || !draft.trim()}
                  style={{ ...styles.calloutIconBtn, color: theme.expGreen, opacity: saving ? 0.4 : 1 }}
                >
                  <Check size={13} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="编辑锚点句">
                <button
                  type="button"
                  onClick={() => { setDraft(node.anchor.keyword); setEditing(true) }}
                  style={styles.calloutIconBtn}
                >
                  <Pencil size={12} />
                </button>
              </Tooltip>
            )}
          </div>

          <div style={styles.calloutMetaStrip}>
            <span style={{ width: 6, height: 6, transform: 'rotate(45deg)', background: c, flexShrink: 0 }} />
            <span>{node.bindings.length} 次锚定 · 最近 {latestDate}</span>
          </div>

          {editError && <div style={styles.calloutError}>{editError}</div>}

          <div style={styles.calloutList}>
            {node.bindings.map((b) => {
              const card = cardById.get(b.card_id)
              // 视频语境卡：标题可点 → 跳到语境库并注视该视频；想法卡/已删除卡：纯文本
              const isVideo = card?.kind === 'bili_transcript'
              const sourceTitle = card ? (isVideo ? (card.title ?? card.bvid ?? 'B站转录') : '想法卡') : '已删除的卡'
              return (
                <div key={b.id} style={styles.calloutItem}>
                  <div style={styles.calloutMetaRow}>
                    {isVideo ? (
                      <Tooltip content="跳到语境并注视该视频" display="flex" wrapStyle={{ flex: 1, minWidth: 0 }}>
                        <button
                          type="button"
                          className="af-callout-srclink"
                          onClick={() => onJumpToCard(b.card_id)}
                          style={{ ...styles.calloutSourceLink, color: theme.electricBlue }}
                        >
                          {sourceTitle}
                        </button>
                      </Tooltip>
                    ) : (
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{sourceTitle}</span>
                    )}
                    <span style={{ flexShrink: 0 }}>{fmtDate(parseTs(b.created_at))}</span>
                  </div>
                  <div style={styles.calloutSpeech}>{b.user_speech}</div>
                  {b.selected_text && b.selected_text !== b.user_speech && (
                    <div style={{ ...styles.calloutQuote, borderLeftColor: `${c}66` }}>
                      {b.selected_text}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* 翻转时收起条在右缘 */}
        {arrowSide === 'right' && collapseBar}
      </div>
    </div>
  )
}

// ── styles ────────────────────────────────────

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.textMuted,
    fontSize: 12.5,
    fontStyle: 'italic',
    padding: '0 60px',
    textAlign: 'center',
    lineHeight: 1.8,
  },
  stats: {
    position: 'absolute',
    left: 12,
    top: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    fontFamily: theme.fontMono,
    fontSize: 10,
    letterSpacing: '0.14em',
    color: theme.textMuted,
    pointerEvents: 'none',
    textShadow: '0 0 6px rgba(0,0,0,0.8)',
  },
  regionNav: {
    position: 'absolute',
    left: 12,
    top: 104,
    maxHeight: 'calc(100% - 160px)',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '6px 6px',
    background: 'rgba(4, 12, 25, 0.72)',
    border: `1px solid ${theme.hudFrameSoft}`,
    borderRadius: 5,
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    scrollbarWidth: 'none',
  },
  regionNavTitle: {
    fontFamily: theme.fontMono,
    fontSize: 9,
    letterSpacing: '0.3em',
    color: theme.textMuted,
    padding: '1px 6px 4px',
  },
  regionItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    maxWidth: 180,
    border: 'none',
    background: 'transparent',
    color: theme.textSecondary,
    fontFamily: theme.fontBody,
    fontSize: 11,
    padding: '3px 6px',
    cursor: 'pointer',
    borderRadius: 3,
    textAlign: 'left',
  },
  regionItemActive: {
    background: 'rgba(0,229,255,0.10)',
    color: theme.textPrimary,
  },
  regionDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  // 区域名不截断：超长自然折行（一般是 AI 起的 2~6 字短名，回退时可能是整句）
  regionName: {
    overflowWrap: 'anywhere',
    lineHeight: 1.45,
  },
  regionCount: {
    marginLeft: 'auto',
    paddingLeft: 6,
    fontFamily: theme.fontMono,
    fontSize: 9,
    color: theme.textMuted,
    flexShrink: 0,
  },
  toolbar: {
    position: 'absolute',
    left: '50%',
    bottom: 10,
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    background: 'rgba(4, 12, 25, 0.78)',
    border: `1px solid ${theme.hudFrameSoft}`,
    borderRadius: 5,
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
  },
  toolBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 20,
    border: 'none',
    background: 'transparent',
    color: theme.textSecondary,
    cursor: 'pointer',
    borderRadius: 3,
  },
  toolPct: {
    minWidth: 40,
    textAlign: 'center',
    fontFamily: theme.fontMono,
    fontSize: 10,
    color: theme.textMuted,
    letterSpacing: '0.06em',
  },
  toolDivider: {
    width: 1,
    height: 12,
    background: theme.hudFrameSoft,
    margin: '0 2px',
  },
  legend: {
    position: 'absolute',
    left: '50%',
    bottom: 44,
    transform: 'translateX(-50%)',
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    padding: '10px 14px',
    background: 'rgba(4, 12, 25, 0.88)',
    border: `1px solid ${theme.hudFrameSoft}`,
    borderRadius: 6,
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  legendRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 11,
    color: theme.textSecondary,
    fontFamily: theme.fontBody,
    whiteSpace: 'nowrap',
  },
  // ── 详情 callout 悬浮层 ──
  // 外壳：屏幕定位容器（left/top 动态注入），只有卡片本体收指针事件
  calloutShell: {
    position: 'absolute',
    width: PANEL_W,
    maxHeight: PANEL_MAX_H,
    display: 'flex',
    flexDirection: 'column',
    pointerEvents: 'none',
    zIndex: PANEL_Z,
  },
  // 卡片本体：半透明玻璃（0.6 + blur + saturate），borderColor/boxShadow 由类别色内联。
  // 横向布局：收起条（朝节点侧） + 内容列
  calloutCard: {
    position: 'relative',
    pointerEvents: 'auto',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 0,
    maxHeight: '100%',
    background: `rgba(5, 12, 27, ${CARD_BG_ALPHA})`,
    backdropFilter: `blur(${CARD_BLUR}px) saturate(${CARD_SAT}%)`,
    WebkitBackdropFilter: `blur(${CARD_BLUR}px) saturate(${CARD_SAT}%)`,
    border: '1px solid',
    borderRadius: 7,
    overflow: 'hidden',
  },
  // 跨整条竖边的收起条（点击收起，chevron 指向节点）
  calloutCollapse: {
    flexShrink: 0,
    width: 22,
    alignSelf: 'stretch',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
  },
  // 内容列（头/计数条/列表纵向堆叠）
  calloutBody: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  calloutHead: {
    position: 'relative',
    zIndex: 2,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '11px 10px 9px 12px',
    borderBottom: `1px solid ${theme.hudFrameSoft}`,
  },
  calloutChip: {
    flexShrink: 0,
    marginTop: 1,
    fontSize: 10,
    fontFamily: theme.fontMono,
    letterSpacing: '0.08em',
    border: '1px solid',
    borderRadius: 3,
    padding: '2px 7px',
  },
  // 锚点句完整展示不截断（超长自然折行）；玻璃透明后给字压底阴影保可读
  calloutKeyword: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 1.5,
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    overflowWrap: 'anywhere',
    textShadow: '0 0 8px rgba(0,0,0,0.6)',
  },
  calloutEditInput: {
    flex: 1,
    minWidth: 0,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,0,0,0.4)',
    borderRadius: 3,
    padding: '3px 7px',
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    fontSize: 12.5,
    outline: 'none',
  },
  calloutIconBtn: {
    display: 'flex',
    flexShrink: 0,
    border: 'none',
    background: 'transparent',
    color: theme.textMuted,
    cursor: 'pointer',
    padding: 2,
    transition: 'color 0.15s',
  },
  // 头/体之间一条 mono 计数微条（呼号风）
  calloutMetaStrip: {
    position: 'relative',
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 12px',
    fontFamily: theme.fontMono,
    fontSize: 9.5,
    letterSpacing: '0.1em',
    color: theme.textMuted,
    borderBottom: `1px dashed ${theme.hudFrameSoft}`,
  },
  calloutError: {
    padding: '6px 12px 0',
    fontSize: 11,
    color: theme.dangerRed,
  },
  calloutList: {
    position: 'relative',
    zIndex: 2,
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '10px 12px',
    scrollbarWidth: 'none',
  },
  calloutItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    paddingBottom: 10,
    borderBottom: `1px dashed ${theme.hudFrameSoft}`,
  },
  calloutMetaRow: {
    display: 'flex',
    gap: 8,
    fontFamily: theme.fontMono,
    fontSize: 9.5,
    color: theme.textMuted,
    letterSpacing: '0.06em',
  },
  calloutSpeech: {
    fontSize: 12.5,
    lineHeight: 1.65,
    color: theme.textPrimary,
    whiteSpace: 'pre-wrap',
    textShadow: '0 0 6px rgba(0,0,0,0.55)',
  },
  calloutQuote: {
    fontSize: 11,
    lineHeight: 1.55,
    color: theme.textSecondary,
    fontStyle: 'italic',
    borderLeft: '2px solid',
    padding: '3px 7px',
    background: 'rgba(0,0,0,0.18)',
    borderRadius: '0 3px 3px 0',
  },
  // 视频语境卡标题（可点跳转+注视）：链接态，hover 下划线（CSS 在 root 的 <style> 里）
  calloutSourceLink: {
    flex: 1,
    minWidth: 0,
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    fontFamily: theme.fontMono,
    fontSize: 9.5,
    letterSpacing: '0.06em',
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
  },
}
