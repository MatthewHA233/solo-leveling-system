// ══════════════════════════════════════════════
// AnchorFieldMap — 锚点域：开放世界认知地图（flomo 认知地图架构）
//   · 球 = 锚点句：位置由语义嵌入（PCA 投影）决定，语义近 = 空间近；三类只做染色
//   · 山 = 聚簇（≥2 球挤成一团）：山名由 AI 起（不是任何锚点原文），按成员缓存
//   · 等高线 = 球与山的密度场等值线（marching squares）——纯视觉地貌氛围，不承载语义（聚集看山、类别看区带）
//   · 左侧区域导航 = 已命名的簇，点击飞行聚焦；滚轮缩放 + 拖拽平移 + 底部工具条
//   · 无 API key / 向量未就绪时回退共现 force 布局，地图始终可用
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Check, HelpCircle, Minus, Pencil, Plus, RotateCcw, X } from 'lucide-react'
import { theme } from '../theme'
import type { AnchorBinding, AnchorCategory, AnchorRef, ContextFeedItem } from '../lib/local-api'
import { fetchCardBindings, updateAnchorKeyword } from '../lib/local-api'
import { ensureAnchorEmbeddings } from '../lib/anchor-embedding'
import { clusterByCosine, clusterByDistance, clusterMemberHash, projectAnchors, relaxOverlap, resolveClusterNames } from '../lib/anchor-map-layout'
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
  const clientToWorld = (cx: number, cy: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const r = svg.getBoundingClientRect()
    return {
      x: view.x + ((cx - r.left) / r.width) * view.w,
      y: view.y + ((cy - r.top) / r.height) * view.w * (WORLD_H / WORLD_W),
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
    const scale = view.w / r.width
    setView((v) => ({ ...v, x: d.vx - (e.clientX - d.sx) * scale, y: d.vy - (e.clientY - d.sy) * scale }))
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
  const showBallLabels = view.w < 680 // 放大后才显示锚点句（地图式按缩放出细节）

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
    <div style={styles.root}>
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

        {/* 山（簇）：实心双面地标 + AI 起的主题名（计数只在左侧导航，地图保持干净）*/}
        {clusters.map((c) => {
          const s = mountainSize(c.members.length)
          const h = s * 0.95
          const hot = hoverCluster === c.hash || focusedCluster === c.hash
          const name = clusterNames.get(c.hash)
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
                stroke="rgba(6,14,26,0.9)"
                strokeWidth={0.8}
                strokeLinejoin="round"
              />
              {/* 右侧暗面，给山体一点体积感 */}
              <path d={`M ${s * 0.32},${-h} L ${s},0 L 0,0 Z`} fill="rgba(10,24,40,0.30)" />
              {splitTwoLines(name ?? '起名中…', 10).map((line, li) => (
                <text
                  key={li}
                  y={16 + li * 13}
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

        {/* 球（锚点句）：三类低饱和染色，越亮越近期；悬浮放大提亮，点击看绑定详情 */}
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
                onClick={(e) => { e.stopPropagation(); setSelected(n) }}
                onMouseEnter={() => setHoverBall(n.anchor.id)}
                onMouseLeave={() => setHoverBall((prev) => (prev === n.anchor.id ? null : prev))}
              />
              {(showBallLabels || hovered) && splitTwoLines(n.anchor.keyword, 13).map((line, li) => (
                <text
                  key={li}
                  y={r + 10 + li * 10}
                  textAnchor="middle"
                  fill={hovered ? '#f4d896' : theme.textMuted}
                  fontSize={8}
                  fontFamily={theme.fontBody}
                  pointerEvents="none"
                  style={{ paintOrder: 'stroke', stroke: 'rgba(0,6,16,0.85)', strokeWidth: 2.5 }}
                >
                  {line}
                </text>
              ))}
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

      {/* 右侧详情面板（点球弹出）*/}
      {selected && (
        <AnchorDetail
          node={selected}
          cardById={cardById}
          onClose={() => setSelected(null)}
          onJumpToCard={onJumpToCard}
        />
      )}
    </div>
  )
}

// ── 详情面板 ──────────────────────────────────

function catShort(cat: AnchorCategory): string {
  return cat === 'motive' ? '动机' : cat === 'view' ? '观点' : '实践'
}

function AnchorDetail({ node, cardById, onClose, onJumpToCard }: {
  readonly node: AnchorNode
  readonly cardById: Map<string, ContextFeedItem>
  readonly onClose: () => void
  readonly onJumpToCard: (cardId: string) => void
}) {
  const c = ANCHOR_CAT_COLOR[node.anchor.category]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.anchor.keyword)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

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

  return (
    <aside style={styles.detail}>
      <div style={styles.detailHead}>
        <span style={{ ...styles.detailCat, color: c, borderColor: `${c}66`, background: `${c}14` }}>
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
            style={styles.detailEditInput}
          />
        ) : (
          <strong style={styles.detailKeyword}>{node.anchor.keyword}</strong>
        )}
        {editing ? (
          <Tooltip content="保存（Enter）">
            <button
              type="button"
              onClick={() => void saveKeyword()}
              disabled={saving || !draft.trim()}
              style={{ ...styles.detailClose, color: theme.expGreen, opacity: saving ? 0.4 : 1 }}
            >
              <Check size={13} />
            </button>
          </Tooltip>
        ) : (
          <Tooltip content="编辑锚点句">
            <button
              type="button"
              onClick={() => { setDraft(node.anchor.keyword); setEditing(true) }}
              style={styles.detailClose}
            >
              <Pencil size={12} />
            </button>
          </Tooltip>
        )}
        <button type="button" onClick={onClose} style={styles.detailClose}><X size={13} /></button>
      </div>
      {editError && <div style={styles.detailError}>{editError}</div>}
      <div style={styles.detailList}>
        {node.bindings.map((b) => {
          const card = cardById.get(b.card_id)
          const sourceTitle = card ? (card.kind === 'bili_transcript' ? (card.title ?? card.bvid ?? 'B站转录') : '想法卡') : '已删除的卡'
          return (
            <div key={b.id} style={styles.detailItem}>
              <div style={styles.detailMeta}>
                <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{sourceTitle}</span>
                <span style={{ flexShrink: 0 }}>{fmtDate(parseTs(b.created_at))}</span>
              </div>
              <div style={styles.detailSpeech}>{b.user_speech}</div>
              {b.selected_text && b.selected_text !== b.user_speech && (
                <div style={{ ...styles.detailQuote, borderLeftColor: `${c}66` }}>
                  {b.selected_text}
                </div>
              )}
              {card && (
                <button type="button" style={styles.detailJump} onClick={() => onJumpToCard(b.card_id)}>
                  → 跳到语境
                </button>
              )}
            </div>
          )
        })}
      </div>
    </aside>
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
  detail: {
    position: 'absolute',
    right: 10,
    top: 10,
    bottom: 10,
    width: 264,
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(5, 13, 27, 0.92)',
    border: `1px solid ${theme.hudFrameSoft}`,
    borderRadius: 6,
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
  },
  detailHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 10px 8px 12px',
    borderBottom: `1px solid ${theme.hudFrameSoft}`,
  },
  detailCat: {
    fontSize: 10,
    fontFamily: theme.fontMono,
    border: '1px solid',
    borderRadius: 3,
    padding: '1px 6px',
    flexShrink: 0,
  },
  // 锚点句完整展示不截断（超长自然折行）
  detailKeyword: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
  },
  detailClose: {
    display: 'flex',
    border: 'none',
    background: 'transparent',
    color: theme.textMuted,
    cursor: 'pointer',
    padding: 2,
  },
  detailEditInput: {
    flex: 1,
    minWidth: 0,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,0,0,0.35)',
    borderRadius: 3,
    padding: '3px 7px',
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    fontSize: 12.5,
    outline: 'none',
  },
  detailError: {
    padding: '6px 12px 0',
    fontSize: 11,
    color: theme.dangerRed,
  },
  detailList: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '10px 12px',
  },
  detailItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    paddingBottom: 10,
    borderBottom: `1px dashed ${theme.hudFrameSoft}`,
  },
  detailMeta: {
    display: 'flex',
    gap: 8,
    fontFamily: theme.fontMono,
    fontSize: 9.5,
    color: theme.textMuted,
    letterSpacing: '0.06em',
  },
  detailSpeech: {
    fontSize: 12.5,
    color: theme.textPrimary,
    lineHeight: 1.65,
    whiteSpace: 'pre-wrap',
  },
  detailQuote: {
    fontSize: 11,
    color: theme.textSecondary,
    fontStyle: 'italic',
    lineHeight: 1.55,
    borderLeft: '2px solid',
    paddingLeft: 7,
  },
  detailJump: {
    alignSelf: 'flex-start',
    border: 'none',
    background: 'transparent',
    color: theme.electricBlue,
    fontSize: 11,
    fontFamily: theme.fontBody,
    cursor: 'pointer',
    padding: 0,
  },
}
