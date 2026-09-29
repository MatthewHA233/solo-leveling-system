// ══════════════════════════════════════════════
// 动机标签排版（@chenglou/pretext）
//   · 测量：pretext 按真实字体折行，长句折成 ≤2 行的紧凑块，渲染按同一折行输出 → 所见即所测
//   · 分级：被引用越多字越大越亮，其余退后 —— 有主次，不是一堵字墙
//   · 摆位：先按「光点 + 标签块」的体积把光点互相推开，再给每个标签在光点周围 8 个候选位里
//     挑代价最小的（撞字 / 压别的光点 / 出框 / 方位偏好）
// ══════════════════════════════════════════════

import { prepareWithSegments, layoutWithLines, clearCache } from '@chenglou/pretext'
import type { Pt } from './blueprint-layout'

export const LABEL_FAMILY = "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif"
export const labelFont = (size: number) => `${size}px ${LABEL_FAMILY}`

/** 三档字号 + 愿望档：[字号, 颜色] */
export const TIERS = {
  major: { size: 16.5, color: '#EDE4D8' },
  minor: { size: 14.5, color: '#C9C1B6' },
  faint: { size: 13, color: '#9E968C' },
  wish: { size: 12, color: '#A89276' },
} as const
export type Tier = keyof typeof TIERS

/** 折行宽度 = 字号 × 这个倍数（约一行 12 个字） */
const WRAP_EM = 12.5
const LINE_HEIGHT = 1.45
/** 标签离光点的距离 */
const GAP = 13
/** 光点的"禁压"半径 */
const DOT_GUARD = 9
/** 舞台留边（上方给标题留更多） */
const MARGIN = { top: 48, right: 18, bottom: 22, left: 18 }

export interface MeasuredLabel {
  readonly lines: readonly string[]
  readonly w: number
  readonly h: number
  readonly size: number
  readonly lineHeight: number
}

export interface PlacedLabel {
  /** 标签块左上角相对光点的偏移 */
  readonly dx: number
  readonly dy: number
  readonly align: 'left' | 'right' | 'center'
  readonly measured: MeasuredLabel
  readonly tier: Tier
}

interface Box { x0: number; y0: number; x1: number; y1: number }

const cache = new Map<string, MeasuredLabel>()

/** 字体换了（加载完成）之后必须清缓存，否则 pretext 会一直用回退字体量出的宽度 */
export function resetLabelMeasure(): void {
  cache.clear()
  clearCache()
}

export function measureLabel(text: string, tier: Tier): MeasuredLabel {
  const { size } = TIERS[tier]
  const key = `${tier}|${text}`
  const hit = cache.get(key)
  if (hit) return hit
  const lineHeight = Math.round(size * LINE_HEIGHT)
  const res = layoutWithLines(prepareWithSegments(text, labelFont(size)), size * WRAP_EM, lineHeight)
  const w = Math.ceil(Math.max(...res.lines.map((l) => l.width), 1))
  const out: MeasuredLabel = { lines: res.lines.map((l) => l.text), w, h: res.lineCount * lineHeight, size, lineHeight }
  cache.set(key, out)
  return out
}

/** 等宋体真的加载完（Google Fonts 按字切片：必须把要显示的字一起传进去，否则只下了一部分字形） */
export async function loadLabelFonts(texts: readonly string[]): Promise<void> {
  const sample = [...new Set(texts.join(''))].join('') || '动机'
  await Promise.all(Object.values(TIERS).map((t) => document.fonts.load(labelFont(t.size), sample)))
  await document.fonts.ready
  resetLabelMeasure()
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

function outside(b: Box, stage: { w: number; h: number }): number {
  const x0 = MARGIN.left
  const y0 = MARGIN.top
  const x1 = stage.w - MARGIN.right
  const y1 = stage.h - MARGIN.bottom
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  const inW = Math.max(0, Math.min(b.x1, x1) - Math.max(b.x0, x0))
  const inH = Math.max(0, Math.min(b.y1, y1) - Math.max(b.y0, y0))
  return w * h - inW * inH
}

/** 候选位：[偏移函数, 对齐, 方位偏好代价]（右 > 左 > 斜 > 正上下） */
const CANDIDATES: ReadonlyArray<[(w: number, h: number) => [number, number], PlacedLabel['align'], number]> = [
  [(_w, h) => [GAP, -h / 2], 'left', 0],
  [(w, h) => [-GAP - w, -h / 2], 'right', 0.4],
  [(_w, h) => [GAP * 0.6, -h - 3], 'left', 1.1],
  [() => [GAP * 0.6, 3], 'left', 1.1],
  [(w, h) => [-GAP * 0.6 - w, -h - 3], 'right', 1.4],
  [(w) => [-GAP * 0.6 - w, 3], 'right', 1.4],
  [(w, h) => [-w / 2, -h - GAP], 'center', 2],
  [(w) => [-w / 2, GAP], 'center', 2],
]

/**
 * 按标签体积把光点推开（原地修改 positions）：每条动机看成一个「光点 + 标签」大小的圆，
 * 重叠就沿连线各退一半；同时拉回舞台内。几十次迭代足够 10~50 个动机。
 */
export function spreadByLabel(
  positions: Map<string, Pt>,
  sizes: ReadonlyMap<string, MeasuredLabel>,
  stage: { w: number; h: number },
): void {
  const ids = [...positions.keys()]
  const radius = (id: string) => {
    const m = sizes.get(id)
    return m ? Math.sqrt((m.w + GAP) * (m.h + 8)) * 0.62 : 24
  }
  for (let iter = 0; iter < 80; iter++) {
    let moved = false
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i]) as Pt
        const b = positions.get(ids[j]) as Pt
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.hypot(dx, dy) || 0.01
        const need = radius(ids[i]) + radius(ids[j])
        if (dist >= need) continue
        const push = (need - dist) / 2
        const ux = dx / dist
        const uy = dy / dist
        positions.set(ids[i], { x: a.x - ux * push, y: a.y - uy * push })
        positions.set(ids[j], { x: b.x + ux * push, y: b.y + uy * push })
        moved = true
      }
    }
    for (const id of ids) {
      const p = positions.get(id) as Pt
      const r = radius(id) * 0.6
      positions.set(id, {
        x: Math.min(stage.w - MARGIN.right - r, Math.max(MARGIN.left + r, p.x)),
        y: Math.min(stage.h - MARGIN.bottom - r, Math.max(MARGIN.top + r, p.y)),
      })
    }
    if (!moved) break
  }
}

/** 贪心摆标签：重要的先挑位置，后面的避开已摆好的 */
export function placeLabels(
  order: readonly string[],
  positions: ReadonlyMap<string, Pt>,
  measured: ReadonlyMap<string, MeasuredLabel>,
  tiers: ReadonlyMap<string, Tier>,
  stage: { w: number; h: number },
): Map<string, PlacedLabel> {
  const placed: Box[] = []
  const dots: Box[] = [...positions.values()].map((p) => ({
    x0: p.x - DOT_GUARD, y0: p.y - DOT_GUARD, x1: p.x + DOT_GUARD, y1: p.y + DOT_GUARD,
  }))
  const out = new Map<string, PlacedLabel>()
  for (const id of order) {
    const p = positions.get(id)
    const m = measured.get(id)
    if (!p || !m) continue
    let best: { box: Box; dx: number; dy: number; align: PlacedLabel['align']; cost: number } | null = null
    for (const [offset, align, pref] of CANDIDATES) {
      const [dx, dy] = offset(m.w, m.h)
      const box = { x0: p.x + dx, y0: p.y + dy, x1: p.x + dx + m.w, y1: p.y + dy + m.h }
      let cost = pref * 60
      for (const q of placed) cost += overlap(box, q) * 1.2
      for (const d of dots) {
        // 自己的光点不算
        if (d.x0 === p.x - DOT_GUARD && d.y0 === p.y - DOT_GUARD) continue
        cost += overlap(box, d) * 4
      }
      cost += outside(box, stage) * 3
      if (!best || cost < best.cost) best = { box, dx, dy, align, cost }
    }
    if (!best) continue
    placed.push(best.box)
    out.set(id, { dx: best.dx, dy: best.dy, align: best.align, measured: m, tier: tiers.get(id) ?? 'minor' })
  }
  return out
}
