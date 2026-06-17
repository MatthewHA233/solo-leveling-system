// ══════════════════════════════════════════════
// anchor-label-layout — 锚点域标签测量 + 流式避让（集成 @chenglou/pretext）
//
//   · 测量：prepareWithSegments + layoutWithLines 一次拿「真实折行」+「每行宽度」，
//     替代旧 splitTwoLines 的按字数盲拆。坐标系下 1 世界单位 == 1px 数值，
//     故用世界字号 measure 出来的宽高直接是世界单位。
//   · 避让：不整块挪标签，而是「逐行绕障碍流式排版」——只有压到障碍（山峰/山名）的那一行
//     横向挪开镶进空隙，其余行保持原位（Pretext 招牌的文字绕形排版思路）。
//   · 字体竞态：'Exo 2' 400/600 是两张独立 face + display:swap，Pretext 按 font 串缓存度量；
//     必须 fontReady（含 600 单独 load + clearCache）后才测，否则 fallback 宽被钉死。
// ══════════════════════════════════════════════

import { prepareWithSegments, layoutWithLines, layoutNextLine, clearCache } from '@chenglou/pretext'

// ── 字体（必须与 SVG <text> 渲染属性逐字段一致；canvas shorthand：[weight] [size] [family]）──
export const FONT_MOUNTAIN = "600 11.5px 'Exo 2', sans-serif"
export const FONT_BALL = "8px 'Exo 2', sans-serif"

// ── 折行 maxWidth / lineHeight（世界单位；lineHeight 必须 == 渲染时相邻行 y 差值）──
const MOUNT_MAXW = 84            // 山名折行宽上限（旧 splitTwoLines(name,10) 视觉宽，鼓励 ≤2 行）
export const MOUNT_LH = 13       // 山名行距（沿用旧 y=16+li*13）
const BALL_MAXW = 72             // 球标签折行宽上限（旧 splitTwoLines(kw,13)）
export const BALL_LH = 10        // 球标签行距（沿用旧 y=r+10+li*10）
const MOUNT_RELAX_MAXW = 1.7     // 山名折出 >2 行时放宽 maxWidth 重测一次（用户要「不出省略号」）

// ── 锚定 ──
export const MOUNT_ANCHOR_DY = 16   // 山名首行基线相对山心 y（沿用旧 y=16）
export const BALL_GAP = 4           // 球缘 → 标签首行盒顶间隙

// ── 逐行变宽流排旋钮 ──
const WORLD_MARGIN = 8     // 标签离世界边缘最小留白
const OBST_GAP = 4         // 标签与障碍（山名/别的标签/卡片）间气隙
const MIN_LINE_W = 28      // 单行最小可用宽（再窄也按它折，免得一字一行/死循环）
const MAX_FLOW_LINES = 24  // 流排行数上限（防御）

// ── 可见性阈值 ──
// view.w < 此值才显示球标签。view.w 越大=越缩小，所以「调大此值」=缩得更小也还显示文本。
// 旧 680 → 约 147% 缩放才出文本；1300 → 约 77% 就出（继续缩小也看得到）。要一直显示设到 WORLD_W*1.6=1600。
export const BALL_LABEL_ZOOM = 1300

// ── 测量层 ───────────────────────────────────

export interface WrappedLabel {
  readonly lines: readonly string[]       // 真实折行（渲染用，替代 splitTwoLines）
  readonly lineWidths: readonly number[]  // 每行实测宽（世界单位）——逐行避让要按行宽判碰撞
  readonly w: number                      // 墨水盒宽 = max 行宽
  readonly h: number                      // 墨水盒高 = lineCount*lineHeight
}

// font|maxWidth|lineHeight|text 为 key；fontReady 翻 true 时整体 clear（含 Pretext 全局缓存）
const wrapCache = new Map<string, WrappedLabel>()
export function clearWrapCache() {
  wrapCache.clear()
  clearCache()
}

function measure(text: string, font: string, maxWidth: number, lineHeight: number): WrappedLabel {
  const key = `${font} ${maxWidth} ${lineHeight} ${text}`
  const hit = wrapCache.get(key)
  if (hit) return hit
  const prep = prepareWithSegments(text, font)
  let r = layoutWithLines(prep, maxWidth, lineHeight)
  // 山名鼓励 ≤2 行：折出 3+ 行时放宽 maxWidth 重测一次（宁可宽也不截断/省略）
  if (r.lineCount > 2 && font === FONT_MOUNTAIN) {
    r = layoutWithLines(prep, maxWidth * MOUNT_RELAX_MAXW, lineHeight)
  }
  const lineWidths = r.lines.map((l) => l.width)
  let w = 0
  for (const lw of lineWidths) if (lw > w) w = lw
  const out: WrappedLabel = { lines: r.lines.map((l) => l.text), lineWidths, w, h: r.height }
  wrapCache.set(key, out)
  return out
}

export function measureMountain(text: string): WrappedLabel {
  return measure(text, FONT_MOUNTAIN, MOUNT_MAXW, MOUNT_LH)
}
export function measureBall(text: string): WrappedLabel {
  return measure(text, FONT_BALL, BALL_MAXW, BALL_LH)
}
/** 按指定可用宽度重测球标签——空间不够时折出更多更窄的行（行数可超原本，镶进窄缝）*/
export function measureBallAt(text: string, maxWidth: number): WrappedLabel {
  return measure(text, FONT_BALL, Math.max(24, maxWidth), BALL_LH)
}

// ── 整块避让排版（连贯不撕裂）────────────────

export interface Obstacle {
  readonly x0: number; readonly x1: number   // 世界 x 区间
  readonly y0: number; readonly y1: number   // 世界 y 区间
}

export interface PlacedLine {
  readonly text: string
  readonly cx: number   // 该行中心的世界 x（textAnchor=middle）
  readonly y: number    // 该行盒顶的世界 y
  readonly w: number    // 该行宽度（世界单位）——后续作为障碍累加给别的标签
}

/** 锚点 ax 在 [y0,y1] 竖带里被左右障碍夹出的自由横向区间 [L,R] */
function freeIntervalAt(
  ax: number, y0: number, y1: number, obstacles: readonly Obstacle[], worldW: number,
): { L: number; R: number } {
  let L = WORLD_MARGIN
  let R = worldW - WORLD_MARGIN
  for (const ob of obstacles) {
    if (y1 <= ob.y0 || y0 >= ob.y1) continue // y 不相交
    if (ob.x1 <= ax) { if (ob.x1 + OBST_GAP > L) L = ob.x1 + OBST_GAP }       // 障碍在锚点左 → 抬左界
    else if (ob.x0 >= ax) { if (ob.x0 - OBST_GAP < R) R = ob.x0 - OBST_GAP }  // 在锚点右 → 压右界
    else { // 跨在锚点上：往空间大的一侧让
      if (R - ob.x1 >= ob.x0 - L) { if (ob.x1 + OBST_GAP > L) L = ob.x1 + OBST_GAP }
      else if (ob.x0 - OBST_GAP < R) R = ob.x0 - OBST_GAP
    }
  }
  return { L, R }
}

/**
 * 单张球标签的「逐行变宽流式排版」（Pretext 文字绕形）：从首行往下，每行按它自己 y 处的
 * 自由宽度即时折行——卡在山名/卡片层的行变窄（行数自然增多镶进窄缝），掉到障碍下方的行恢复宽度。
 * 每行在各自自由区间内尽量贴近锚点居中。返回每行绝对世界位置（行宽各异）。
 */
export function layoutBallFlow(
  ax: number, topY: number, text: string,
  obstacles: readonly Obstacle[], worldW: number,
  card?: Obstacle | null,
): PlacedLine[] {
  const prep = prepareWithSegments(text, FONT_BALL)
  const out: PlacedLine[] = []
  let cursor = { segmentIndex: 0, graphemeIndex: 0 }
  let y = topY
  // 整块同列：第一行在球正下方贴锚点定下「列心 colCx」，后续行一律对齐它——
  // 同一条锚点句的多行垂直堆成一列、整块跟着球走，绝不让某行被避让甩到很远（左右撕裂）。
  let colCx: number | null = null
  for (let guard = 0; guard < MAX_FLOW_LINES; guard++) {
    // 折行可用宽：首行按球 ax 处空隙，后续行按列心处空隙（窄处自然折更多行，但横向不甩散）
    const probe = colCx ?? ax
    const { L, R } = freeIntervalAt(probe, y, y + BALL_LH, obstacles, worldW)
    const availW = Math.max(MIN_LINE_W, Math.min(BALL_MAXW, R - L))
    const line = layoutNextLine(prep, cursor, availW)
    if (!line) break // 文本排完
    const lw = line.width
    if (colCx === null) {
      // 首行：球正下方自由区间里贴锚点居中，定为整列列心
      colCx = (R - L) <= lw ? (L + R) / 2 : Math.max(L + lw / 2, Math.min(R - lw / 2, ax))
    }
    // 整列对齐列心，只做世界边界钳制（不为障碍横向甩开 → 多行始终在一起、跟着球）
    const cx = Math.max(WORLD_MARGIN + lw / 2, Math.min(worldW - WORLD_MARGIN - lw / 2, colCx))
    out.push({ text: line.text, cx, y, w: lw })
    cursor = line.end
    y += BALL_LH
  }
  // 整列横移避开详情卡片：只有真正压到卡片的标签才整体就近平移出去——
  // 移动量 ≤ 一个卡片宽（绝不像逐行避让那样飘到很远），就近一侧越界就换另一侧，
  // 两侧都放不下（极少数深埋卡片中心的）才维持原位被遮。整块平移 → 多行依旧对齐、跟着球。
  if (card && out.length > 0) {
    let minX = Infinity
    let maxX = -Infinity
    for (const ln of out) {
      if (ln.y + BALL_LH > card.y0 && ln.y < card.y1) {
        if (ln.cx - ln.w / 2 < minX) minX = ln.cx - ln.w / 2
        if (ln.cx + ln.w / 2 > maxX) maxX = ln.cx + ln.w / 2
      }
    }
    if (minX < maxX && minX < card.x1 && maxX > card.x0) {
      const shiftL = (card.x0 - OBST_GAP) - maxX   // ≤0：整列挪到卡片左外
      const shiftR = (card.x1 + OBST_GAP) - minX   // ≥0：整列挪到卡片右外
      const inBounds = (sh: number) => out.every((ln) =>
        ln.cx + sh - ln.w / 2 >= WORLD_MARGIN && ln.cx + sh + ln.w / 2 <= worldW - WORLD_MARGIN)
      const near = Math.abs(shiftL) <= Math.abs(shiftR) ? shiftL : shiftR
      const far = near === shiftL ? shiftR : shiftL
      const shift = inBounds(near) ? near : inBounds(far) ? far : null
      if (shift !== null) return out.map((ln) => ({ ...ln, cx: ln.cx + shift }))
    }
  }
  return out
}
