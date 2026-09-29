// ══════════════════════════════════════════════
// 蓝图几何 —— 行动方向与步骤从动机向外长成卷须
//   · 方向均布在一段弧上，避开正下方（那里是动机原话与操作栏）
//   · 每个方向上的步骤一格格往外，并顺同一旋向微微打旋 → 卷须，不是僵直放射线
//   · 步距按该方向到舞台边缘的余量自动收缩，保证不出框
//   · 每个节点带半径 r：波前扫过 r 时它才"结晶"出现
// ══════════════════════════════════════════════

import type { MotiveBlueprint } from '../../lib/local-api'

export interface Pt { readonly x: number; readonly y: number }

export interface LaidStep {
  readonly text: string
  readonly p: Pt
  readonly r: number
  /** 文字放在点的左侧（按文字宽度判断：放右边会出框就翻到左边，反之亦然） */
  readonly textLeft: boolean
}

export interface LaidDirection {
  readonly title: string
  readonly p: Pt
  readonly r: number
  /** 标题位置：接近水平的方向放在节点上方（让开沿同一条线往外长的步骤），其余放在侧边 */
  readonly titlePos: 'above' | 'side'
  /** titlePos 为 side 时，文字放在点的左侧 */
  readonly textLeft: boolean
  /** 动机 → 方向 的主干 */
  readonly trunk: string
  readonly trunkR: readonly [number, number]
  /** 方向 → 各步骤 的卷须（没有步骤时为 null） */
  readonly tendril: string | null
  readonly tendrilR: readonly [number, number]
  readonly steps: readonly LaidStep[]
  /** 「加一步」按钮的位置 */
  readonly addAt: Pt
}

/** 可用弧：150° → 390°（屏幕坐标 y 向下，90° 是正下方） */
const ARC_FROM = 150
const ARC_SPAN = 240
/** 动机点半径外才开始画主干 */
const CORE_GAP = 16
/** 每一步额外打旋的角度（度） */
const CURL = 7
/** 离舞台边缘至少留的距离 */
const EDGE_MARGIN = 56
const GAP_MAX = 62
const GAP_MIN = 34
/** 与 BlueprintLayer 的字号一致，用来估算文字宽度 */
const TITLE_FONT = 14.5
const STEP_FONT = 12.5
/** 文字离节点 / 离舞台边缘的距离 */
const TEXT_GAP = 14
const TEXT_EDGE = 10

/** 估算单行文字宽度：中日韩全角按 1em，其余按 0.56em（够用来判断会不会出框） */
function textWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += /[⺀-鿿豈-﫿＀-￯]/.test(ch) ? size : size * 0.56
  return w
}

/** 偏好方向放不下就翻到另一侧 */
function chooseLeft(p: Pt, preferLeft: boolean, width: number, stageW: number): boolean {
  const fitsLeft = p.x - TEXT_GAP - width >= TEXT_EDGE
  const fitsRight = p.x + TEXT_GAP + width <= stageW - TEXT_EDGE
  if (preferLeft) return fitsLeft || !fitsRight
  return !fitsRight && fitsLeft
}

const rad = (deg: number) => (deg * Math.PI) / 180

function polar(c: Pt, r: number, deg: number): Pt {
  return { x: c.x + Math.cos(rad(deg)) * r, y: c.y + Math.sin(rad(deg)) * r }
}

/** 从 c 沿 deg 方向到舞台边框的距离 */
function roomAlong(c: Pt, deg: number, w: number, h: number): number {
  const dx = Math.cos(rad(deg))
  const dy = Math.sin(rad(deg))
  const tx = dx > 1e-6 ? (w - c.x) / dx : dx < -1e-6 ? -c.x / dx : Infinity
  const ty = dy > 1e-6 ? (h - c.y) / dy : dy < -1e-6 ? -c.y / dy : Infinity
  return Math.min(tx, ty) - EDGE_MARGIN
}

/** 过一串点的平滑曲线：用中点做二次贝塞尔（折线的圆角化） */
function smoothPath(points: readonly Pt[]): string {
  if (points.length < 2) return ''
  const f = (n: number) => n.toFixed(1)
  let d = `M${f(points[0].x)},${f(points[0].y)}`
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 }
    d += ` Q${f(points[i].x)},${f(points[i].y)} ${f(mid.x)},${f(mid.y)}`
  }
  const last = points[points.length - 1]
  return `${d} L${f(last.x)},${f(last.y)}`
}

export function layoutBlueprint(
  blueprint: MotiveBlueprint,
  center: Pt,
  stage: { readonly w: number; readonly h: number },
): LaidDirection[] {
  const dirs = blueprint.directions
  const n = dirs.length
  if (n === 0) return []
  const minDim = Math.min(stage.w, stage.h)

  return dirs.map((dir, di) => {
    // 单个方向朝正上方；多个方向在弧上均分
    const angle = n === 1 ? 270 : ARC_FROM + (ARC_SPAN * (di + 0.5)) / n
    const spin = di % 2 === 0 ? 1 : -1
    const room = Math.max(120, roomAlong(center, angle, stage.w, stage.h))
    const r1 = Math.min(minDim * 0.19, room * 0.42)
    const stepCount = Math.max(dir.steps.length, 1)
    const gap = Math.max(GAP_MIN, Math.min(GAP_MAX, (room - r1) / (stepCount + 0.8)))

    const p = polar(center, r1, angle)
    // 主干：从动机边缘出发，中段往旋向偏一点再落到方向点
    const trunkPts = [
      polar(center, CORE_GAP, angle - spin * CURL * 2),
      polar(center, r1 * 0.55, angle - spin * CURL * 1.4),
      p,
    ]

    const outwardLeft = Math.cos(rad(angle)) < -0.15
    const steps: LaidStep[] = dir.steps.map((text, si) => {
      const r = r1 + gap * (si + 1)
      const sp = polar(center, r, angle + spin * CURL * (si + 1))
      return { text, r, p: sp, textLeft: chooseLeft(sp, outwardLeft, textWidth(text, STEP_FONT), stage.w) }
    })
    const addR = r1 + gap * (dir.steps.length + 1)
    const addAt = polar(center, Math.min(addR, room), angle + spin * CURL * (dir.steps.length + 1))

    const lastR = steps.length > 0 ? steps[steps.length - 1].r : r1
    return {
      title: dir.title,
      p,
      r: r1,
      titlePos: Math.abs(Math.cos(rad(angle))) > 0.6 ? 'above' : 'side',
      textLeft: chooseLeft(p, outwardLeft, textWidth(dir.title, TITLE_FONT), stage.w),
      trunk: smoothPath(trunkPts),
      trunkR: [CORE_GAP, r1],
      tendril: steps.length > 0 ? smoothPath([p, ...steps.map((s) => s.p)]) : null,
      tendrilR: [r1, lastR],
      steps,
      addAt,
    }
  })
}
