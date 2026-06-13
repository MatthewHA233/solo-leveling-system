import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { X } from 'lucide-react'
import type { ActivityBlock, ActivityPalette, PlanNode, PlannedBlock, RecordLayer } from '../types'
import type { PerceptionSpan, BiliSpan } from '../lib/local-api'
import { theme, hud } from '../theme'
import { HudFrameSkeleton, HudTabButton, CornerArt, ChartHeaderFrame, ChartHeaderButtons } from './hud'
import Tooltip from './Tooltip'

interface Props {
  /** 活动记录：5min 离散块 */
  activityBlocks: ActivityBlock[]
  /** 计划安排：5min 离散块 */
  plannedBlocks: PlannedBlock[]
  /** 当前项目下的计划节点树 */
  planNodes: PlanNode[]
  /** 标签库（颜色 / 路径查找） */
  activityPalette: ActivityPalette
  /** 当前正在查看/编辑的记录层 */
  recordLayer: RecordLayer
  onRecordLayerChange: (layer: RecordLayer) => void
  /** 编辑模式：可点击/拖刷涂块 */
  editMode: boolean
  /** 当前选中的画笔 tag id（叶子节点） */
  selectedTagId: number | null
  /** 当前选中的计划节点 id */
  selectedPlanNodeId: number | null
  onEditModeToggle: () => void
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** 提交一次拖拽：经过的格子按起始时刻的"原状态"取反 — 有记录就擦、空格用画笔涂 */
  onApplyDrag: (spec: {
    paintMinutes: number[]
    paintTagId: number | null
    eraseMinutes: number[]
    /** 从 dragRef 透传过来的当时所在层，handleApplyDrag 应优先用它而不是当前 recordLayer */
    layer: RecordLayer
    rangeStartMin: number
    rangeEndMin: number
  }) => void
  perceptionSpans?: PerceptionSpan[]
  biliSpans?: BiliSpan[]
  selectedDate: Date
  onSpanClick?: (span: PerceptionSpan) => void
  onSpanHover?: (span: PerceptionSpan | null) => void
  onAppSpanHover?: (span: PerceptionSpan | null, hoverMinute?: number | null) => void
  onBiliSpanHover?: (span: BiliSpan | null) => void
  trackMode?: 'apps' | 'bili'
  onTrackModeChange?: (mode: 'apps' | 'bili') => void
  pinnedPos?: { col: number; y: number; minute: number } | null
  onPinPos?: (pos: { col: number; y: number; minute: number } | null) => void
}

function getAppTrackLabel(): string {
  if (typeof navigator === 'undefined') return '应用'
  const ua = navigator.userAgent
  if (/Macintosh|Mac OS X/i.test(ua)) return '应用(Mac)'
  if (/Windows/i.test(ua)) return '应用(Win)'
  return '应用'
}

// ── 响应式密度模式（纵向驱动）──
// 每列行数决定列密度：12行/列=1列/小时，6行/列=2列/小时，4行/列=3列/小时，3行/列=4列/小时

const DENSITY_ROWS = [12, 6, 4, 3] as const
type RowsPerCol = (typeof DENSITY_ROWS)[number]

/** 小时组之间的间距（非 12行/列 模式下，相邻小时列之间留小间距） */
const HOUR_GROUP_GAP = 12

/** 区时边界（凌晨/上午/下午/黄昏/夜晚）处额外叠加的间距，所有密度模式均生效 */
const ZONE_GAP_EXTRA = 14

const COL_GAP_BY_ROWS: Record<RowsPerCol, number> = { 12: 2, 6: 2, 4: 1, 3: 1 }

/** 返回 hourGroup 之前（不含 0 点）累计的区时边界数量，用于叠加 ZONE_GAP_EXTRA */
function zoneGapsBefore(hourGroup: number): number {
  // 4 个边界：6 / 12 / 18 / 20（凌晨→上午、上午→下午、下午→黄昏、黄昏→夜晚）
  return [6, 12, 18, 20].filter(h => h <= hourGroup).length
}

/**
 * 根据可用高度选择最优密度模式，返回恰好填满高度的 cellH 和等比 cellW。
 * 优先用最少列数（格子最大），cellH 低于阈值时切换到更密模式。
 * cellW 始终随 cellH 等比缩放（基准比例 80:50 = 1.6）。
 */
const CELL_H_SWITCH = 40   // px：低于此高度时切换到更密模式
const CELL_ASPECT   = 80 / 50  // cellW / cellH 基准比例

/** 根据可用高度精确计算 cellH（两步收敛消除 rowGap 的循环依赖） */
function solveCellH(availGrid: number, rpc: number): number {
  // 第一步：忽略 rowGap 估算
  const h0 = availGrid / rpc
  const g0 = Math.max(2, Math.round(h0 * 0.14))
  // 第二步：用第一步的 rowGap 修正
  const h1 = (availGrid - g0 * (rpc - 1)) / rpc
  const g1 = Math.max(2, Math.round(h1 * 0.14))
  return (availGrid - g1 * (rpc - 1)) / rpc
}

function chooseModeByHeight(availH: number): { rowsPerCol: RowsPerCol; cellH: number; cellW: number } {
  const topPad = 28, bottomPad = 8
  const availGrid = availH - topPad - bottomPad

  for (const rpc of DENSITY_ROWS) {
    const cellH = solveCellH(availGrid, rpc)
    if (cellH >= CELL_H_SWITCH) {
      const cellW = Math.max(6, Math.round(cellH * CELL_ASPECT))
      return { rowsPerCol: rpc, cellH, cellW }
    }
  }

  // 已是最密模式仍不够高 → 用最密模式 + 最小高度（允许出现滚动条）
  const cellH = Math.max(CELL_H_SWITCH, solveCellH(availGrid, 3))
  const cellW = Math.max(6, Math.round(cellH * CELL_ASPECT))
  return { rowsPerCol: 3, cellH, cellW }
}

// ── Grid 参数 ──
function getGridParams(rowsPerCol: RowsPerCol, cellW: number, cellHOverride?: number) {
  const minutesPerCol = rowsPerCol * 5
  const cols = 1440 / minutesPerCol
  const rows = rowsPerCol
  const colsPerHour = 12 / rowsPerCol
  const colGap = COL_GAP_BY_ROWS[rowsPerCol]
  const hgGap = colsPerHour > 1 ? HOUR_GROUP_GAP : colGap

  const defaultCellH = Math.max(4, Math.round(cellW * 0.65))
  const cellH = cellHOverride ?? defaultCellH
  const rowGap = Math.max(2, Math.round(cellH * 0.14))
  const hPad = 4  // canvas 内 axis 让位由 wrapper.left 实现（不再让 hPad 让位）
  const topPad = 28
  const bottomPad = 8
  const minuteH = cellH / 5
  const traceBaseX = 0  // 管道贴单元格左边缘，无腾空
  const trackSp = Math.max(2, Math.round(cellW * 0.09))
  const colStride = cellW + colGap
  const rowStride = cellH + rowGap
  const gridH = rows * rowStride - rowGap
  // 每小时组内宽：colsPerHour 列宽 + (colsPerHour-1) 列间距
  const hourGroupInnerW = colsPerHour * colStride - colGap
  // 4 个区时边界（6,12,18,20 点）各额外加 ZONE_GAP_EXTRA
  const totalW = hPad + 24 * hourGroupInnerW + 23 * hgGap + 4 * ZONE_GAP_EXTRA + 16
  const totalH = topPad + gridH + bottomPad
  // 字体随 cellH 等比缩放（基准 cellH=50，不超过原始大小）
  const textScale = Math.min(1.0, cellH / 50)
  const fs = (base: number) => Math.max(6, Math.round(base * textScale))
  return {
    minutesPerCol, cols, rows, rowsPerCol, colsPerHour, colGap, rowGap,
    cellW, cellH, colStride, rowStride, gridH, totalW, totalH,
    hPad, topPad, bottomPad, minuteH, traceBaseX, trackSp,
    hourGroupInnerW, hgGap, fs,
  }
}

/** 列索引 → canvas X 坐标（考虑小时组间距 + 区时边界额外间距） */
function colX(col: number, p: ReturnType<typeof getGridParams>) {
  const hourGroup = Math.floor(col / p.colsPerHour)
  const colInGroup = col % p.colsPerHour
  return p.hPad + hourGroup * (p.hourGroupInnerW + p.hgGap) + colInGroup * p.colStride
    + zoneGapsBefore(hourGroup) * ZONE_GAP_EXTRA
}

/** canvas X → 列索引（colX 逆运算，用于鼠标事件） */
function xToCol(x: number, p: ReturnType<typeof getGridParams>): number {
  const relX = x - p.hPad
  if (relX < 0) return -1
  // 从高到低找第一个基准 X <= relX 的小时组
  for (let h = 23; h >= 0; h--) {
    const gx = h * (p.hourGroupInnerW + p.hgGap) + zoneGapsBefore(h) * ZONE_GAP_EXTRA
    if (relX >= gx) {
      const within = relX - gx
      // 落在组间隙 → 归该组末列
      const colInGroup = Math.min(p.colsPerHour - 1, Math.floor(within / p.colStride))
      return h * p.colsPerHour + colInGroup
    }
  }
  return 0
}

function fmt(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** 感知亮度（0–255），暗色自动朝白色方向拉亮到 minLum */
function brightenForDark(hex: string, minLum = 150): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (lum >= minLum) return hex
  const t = (minLum - lum) / (255 - lum)  // 向白色插值
  const nr = Math.round(r + (255 - r) * t)
  const ng = Math.round(g + (255 - g) * t)
  const nb = Math.round(b + (255 - b) * t)
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`
}

/** 斜切矩形路径（八角 HUD 风格），不 fill/stroke，由调用方决定 */
function chamferPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number) {
  const cx = Math.min(c, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + cx, y)
  ctx.lineTo(x + w - cx, y)
  ctx.lineTo(x + w, y + cx)
  ctx.lineTo(x + w, y + h - cx)
  ctx.lineTo(x + w - cx, y + h)
  ctx.lineTo(x + cx, y + h)
  ctx.lineTo(x, y + h - cx)
  ctx.lineTo(x, y + cx)
  ctx.closePath()
}

// ── 工具函数 ──

/** 将某分钟映射到 canvas Y 坐标（贯穿行间隙） */
function minuteToY(minute: number, col: number, p: ReturnType<typeof getGridParams>) {
  const localMin = minute - col * p.minutesPerCol
  const row = Math.floor(localMin / 5)
  const minuteInRow = localMin % 5
  return p.topPad + row * p.rowStride + minuteInRow * p.minuteH
}

/** 按字符换行，不超出 maxWidth */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return []
  const chars = [...text]
  const lines: string[] = []
  let line = ''
  for (const ch of chars) {
    const test = line + ch
    if (ctx.measureText(test).width > maxWidth && line.length > 0) {
      lines.push(line)
      line = ch
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

// ── 时区分区 ──

type ZoneInfo = { label: string; bgColor: [number, number, number]; bgAlpha: number; textColor: string }

function getZoneInfo(hour: number): ZoneInfo {
  if (hour < 6)  return { label: '凌晨', bgColor: [15,  10,  120], bgAlpha: 0.32, textColor: 'rgba(120,140,255,0.80)' }
  if (hour < 12) return { label: '上午', bgColor: [190, 200, 50],  bgAlpha: 0.18, textColor: 'rgba(220,240,100,0.85)' }
  if (hour < 18) return { label: '下午', bgColor: [220, 180, 20],  bgAlpha: 0.18, textColor: 'rgba(255,220,80,0.85)'  }
  if (hour < 20) return { label: '黄昏', bgColor: [220, 70,  20],  bgAlpha: 0.28, textColor: 'rgba(255,130,60,0.95)'  }
  return           { label: '夜晚', bgColor: [30,  10,  110], bgAlpha: 0.32, textColor: 'rgba(160,110,255,0.80)' }
}


// 阶段背景 hatching pattern 缓存：避免每帧重建
const _zoneHatchCache = new Map<string, CanvasPattern>()

/** 强制提亮：避免 hatching 在暗背景下接近黑色看不清（仅救治凌晨/夜晚等暗 zone） */
function ensureHatchBright(r: number, g: number, b: number, minLum = 100): [number, number, number] {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  if (lum >= minLum) return [r, g, b]
  // 保持色相，整体抬亮：先按比例拉伸，再加 60 的"地板"基底
  const factor = minLum / Math.max(lum, 1)
  return [
    Math.min(255, Math.round(r * factor + 60)),
    Math.min(255, Math.round(g * factor + 60)),
    Math.min(255, Math.round(b * factor + 60)),
  ]
}

/** 创建对角斜线填充 pattern（从右上 → 左下，~45°） */
function makeZoneHatchPattern(
  ctx: CanvasRenderingContext2D,
  r: number, g: number, b: number,
  lineAlpha: number,
  spacing = 7,
  lineW = 1,
): CanvasPattern | null {
  const key = `${r},${g},${b},${lineAlpha},${spacing},${lineW}`
  const cached = _zoneHatchCache.get(key)
  if (cached) return cached

  const off = document.createElement('canvas')
  off.width = off.height = spacing
  const oc = off.getContext('2d')
  if (!oc) return null
  oc.strokeStyle = `rgba(${r},${g},${b},${lineAlpha})`
  oc.lineWidth = lineW
  oc.lineCap = 'square'
  // 主对角线（右上 → 左下）
  oc.beginPath()
  oc.moveTo(-1, spacing + 1)
  oc.lineTo(spacing + 1, -1)
  oc.stroke()
  // 上/下角缝：让 pattern 在 tile 边界上仍连续
  oc.beginPath()
  oc.moveTo(-1, 1); oc.lineTo(1, -1)
  oc.moveTo(spacing - 1, spacing + 1); oc.lineTo(spacing + 1, spacing - 1)
  oc.stroke()

  const pat = ctx.createPattern(off, 'repeat')
  if (pat) _zoneHatchCache.set(key, pat)
  return pat
}

function drawZoneBands(ctx: CanvasRenderingContext2D, p: ReturnType<typeof getGridParams>) {
  // 按小时组绘制色带：阶段背景用斜线 hatching（透气，不遮 grid）
  // 在 hatching 之下加一层极淡的纯色底，保留色彩身份
  const zones: [number, number][] = [[0,6],[6,12],[12,18],[18,20],[20,24]]
  for (const [startH, endH] of zones) {
    const z = getZoneInfo(startH)
    const [r, g, b] = z.bgColor
    // hatching 线条颜色：强制提亮（暗 zone 如凌晨/夜晚原色接近黑，加亮度补偿后仍保留色相）
    const [hr, hg, hb] = ensureHatchBright(r, g, b)
    // hatching 线条透明度（淅淅沥沥感：略淡，让单条线不显眼）
    const lineAlpha = Math.min(0.75, z.bgAlpha * 1.5)
    const pattern = makeZoneHatchPattern(ctx, hr, hg, hb, lineAlpha, 10, 1)
    // 极淡纯色底用原色（保留色彩识别），原 alpha 的 1/12
    const baseAlpha = z.bgAlpha * 0.08
    for (let h = startH; h < endH; h++) {
      const firstCol = Math.floor(h * 60 / p.minutesPerCol)
      const lastCol  = Math.floor((h + 1) * 60 / p.minutesPerCol) - 1
      if (firstCol >= p.cols) continue
      const x0 = colX(firstCol, p)
      const x1 = colX(Math.min(lastCol, p.cols - 1), p) + p.cellW
      // 1) 极淡纯色底
      ctx.fillStyle = `rgba(${r},${g},${b},${baseAlpha})`
      ctx.fillRect(x0, 0, x1 - x0, p.totalH)
      // 2) 斜线 hatching 叠加
      if (pattern) {
        ctx.fillStyle = pattern
        ctx.fillRect(x0, 0, x1 - x0, p.totalH)
      }
    }
  }

  // 阶段分界竖线（每个阶段开始处：顶部 ┬ 标 + 向下半透虚线，让稀疏 hatching 下边界仍清晰）
  const boundaries = [6, 12, 18, 20]
  for (const h of boundaries) {
    const col = Math.floor(h * 60 / p.minutesPerCol)
    if (col >= p.cols) continue
    const x = colX(col, p)
    ctx.save()
    // 顶部 ┬：4px 横线 + 6px 实心竖线
    ctx.strokeStyle = `rgba(0,229,255,0.55)`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x - 5, 0.5); ctx.lineTo(x + 5, 0.5)
    ctx.moveTo(x, 0); ctx.lineTo(x, 6)
    ctx.stroke()
    // 向下虚线
    ctx.strokeStyle = `rgba(0,229,255,0.16)`
    ctx.lineWidth = 1
    ctx.setLineDash([3, 4])
    ctx.beginPath()
    ctx.moveTo(x, 6); ctx.lineTo(x, p.totalH)
    ctx.stroke()
    ctx.restore()
  }

  // 时段中文标签已由 ChartTopAxisRow 在 axis row 内渲染（随 scrollLeft 同步），
  // canvas 内不再绘制以避免重叠。
}

// ── Perception 感知轨道 ──

/** 从逗号分隔标签路径中分离路径部分和标记（以 : 开头为标记） */
function parseTagTitle(title: string): { parts: string[]; markers: string[] } {
  const all = title.split(',').map((s) => s.trim()).filter(Boolean)
  return {
    parts:   all.filter((s) => !s.startsWith(':')),
    markers: all.filter((s) => s.startsWith(':')).map((s) => s.slice(1)),
  }
}

/** "2026-04-04 13:30:30" → 分钟数（810.5）。保留秒级精度，避免短于 1 分钟的 span 被丢弃 */
function dtToMinute(dt: string): number {
  const parts = dt.split(' ')
  if (parts.length < 2) return 0
  const [h, m, s] = parts[1].split(':').map(Number)
  return h * 60 + m + (s || 0) / 60
}

const TRACE_GAP = 0  // 管道与活动矩形紧贴，无间隔

/** Perception 标签层 → 跨单元格高亮矩形 */
function drawTagFills(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  spans: PerceptionSpan[],
  hoveredSpanId: number | null,
  layer: RecordLayer,
) {
  const fillOffsetX = p.traceBaseX + traceWidth + TRACE_GAP

  for (const span of spans) {
    if (span.track !== 'tags') continue
    const startMin = dtToMinute(span.start_at)
    const endMin   = dtToMinute(span.end_at)
    if (endMin <= startMin) continue

    const color   = span.color ?? '#4488ff'
    const hovered = hoveredSpanId === span.id
    const alphaScale = layer === 'plan' ? 0.72 : 1

    const startCol = Math.floor(startMin / p.minutesPerCol)
    const endCol   = Math.floor((endMin - 1) / p.minutesPerCol)

    for (let c = startCol; c <= endCol && c < p.cols; c++) {
      const colStartMin = c * p.minutesPerCol
      const colEndMin   = (c + 1) * p.minutesPerCol
      const segStart    = Math.max(startMin, colStartMin)
      const segEnd      = Math.min(endMin, colEndMin)

      const y0 = minuteToY(segStart, c, p)
      const y1 = minuteToY(segEnd, c, p)
      const x  = colX(c, p) + fillOffsetX
      const w  = p.cellW - fillOffsetX
      const h  = y1 - y0
      if (h <= 0 || w <= 0) continue

      const isFirstCol = c === startCol
      const isLastCol  = c === endCol

      // 1) 填充：弱化半透渐变（参考图风格，整体更"透气"）
      const grad = ctx.createLinearGradient(x, 0, x + w, 0)
      grad.addColorStop(0, hexToRgba(color, (hovered ? 0.42 : 0.28) * alphaScale))
      grad.addColorStop(0.75, hexToRgba(color, (hovered ? 0.36 : 0.22) * alphaScale))
      grad.addColorStop(1, hexToRgba(color, (hovered ? 0.26 : 0.16) * alphaScale))
      ctx.fillStyle = grad
      ctx.fillRect(x, y0, w, h)

      // 2) 顶部高亮带（仅段首列顶部）
      if (isFirstCol) {
        ctx.fillStyle = hexToRgba(color, hovered ? 0.85 : 0.65)
        ctx.fillRect(x, y0, w, 1.2)
      }
      // 底部收口暗线（仅末列底部）
      if (isLastCol) {
        ctx.fillStyle = hexToRgba(color, hovered ? 0.45 : 0.3)
        ctx.fillRect(x, y1 - 1, w, 1)
      }

      // 3) 左侧能量亮边 + 发光
      ctx.save()
      if (hovered) {
        ctx.shadowColor = hexToRgba(color, 0.9)
        ctx.shadowBlur = 6
      }
      ctx.strokeStyle = hexToRgba(color, (hovered ? 1.0 : 0.9) * alphaScale)
      ctx.lineWidth = hovered ? 2.2 : 1.8
      if (layer === 'plan') ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(x + 0.5, y0)
      ctx.lineTo(x + 0.5, y1)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()

      // 4) 首/末列 L 形端盖（HUD 收口）
      const cornerLen = Math.min(8, Math.max(4, h * 0.22))
      const cornerW = 1.4
      ctx.strokeStyle = hexToRgba(color, hovered ? 1.0 : 0.85)
      ctx.lineWidth = cornerW
      ctx.lineCap = 'butt'
      if (isFirstCol) {
        ctx.beginPath()
        ctx.moveTo(x, y0 + cornerLen)
        ctx.lineTo(x, y0)
        ctx.lineTo(x + cornerLen, y0)
        ctx.stroke()
      }
      if (isLastCol) {
        ctx.beginPath()
        ctx.moveTo(x + w - cornerLen, y1)
        ctx.lineTo(x + w, y1)
        ctx.lineTo(x + w, y1 - cornerLen)
        ctx.stroke()
      }

      // 5) 悬浮：外发光描边（整段矩形）
      if (hovered) {
        ctx.save()
        ctx.shadowColor = hexToRgba(color, 0.7)
        ctx.shadowBlur = 10
        ctx.strokeStyle = hexToRgba(color, 0.5)
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y0 + 0.5, w - 1, h - 1)
        ctx.restore()
      }
    }
  }
}

// 管线左右轨 X 偏移（相对于列起点）
const PIPE_LEFT  = 0   // 左轨相对 traceBaseX 的偏移
const PIPE_RIGHT = 6   // 右轨相对 traceBaseX 的偏移（管道宽 6px）

/** 应用层管道：紧贴矩形 + 无悬空 inset + 每 60s 一道分隔条（=每张截图一格） */
function drawAppTraces(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  spans: PerceptionSpan[],
  highlightedSpanId?: number | null,
) {
  for (const span of spans) {
    if (span.track !== 'apps') continue
    const startMin = dtToMinute(span.start_at)
    const endMin   = dtToMinute(span.end_at)
    if (endMin <= startMin) continue

    const color = span.color ?? '#888888'
    const isHighlighted = highlightedSpanId != null && span.id === highlightedSpanId
    const startCol = Math.floor(startMin / p.minutesPerCol)
    const endCol   = Math.floor((endMin - 0.0001) / p.minutesPerCol)

    // 暗色自动提亮（紫色、深蓝等在暗背景下被吞没的颜色）
    const vivid = brightenForDark(color, 160)

    for (let c = startCol; c <= endCol && c < p.cols; c++) {
      const segStart = Math.max(startMin, c * p.minutesPerCol)
      const segEnd   = Math.min(endMin, (c + 1) * p.minutesPerCol)
      const cx = colX(c, p)
      const lx = cx + p.traceBaseX + PIPE_LEFT
      const rx = cx + p.traceBaseX + PIPE_RIGHT
      const py0 = minuteToY(segStart, c, p)
      const py1 = minuteToY(segEnd, c, p)
      if (py1 <= py0) continue

      const barX = lx + 1
      const barW = (rx - lx) - 1
      ctx.save()
      ctx.shadowColor = hexToRgba(vivid, isHighlighted ? 0.9 : 0.55)
      ctx.shadowBlur = isHighlighted ? 8 : 4
      ctx.fillStyle = vivid
      ctx.fillRect(barX, py0, barW, py1 - py0)
      ctx.restore()

      // 每 60s（= 1 分钟 = 一张截图）一道暗色横向分隔条，让管道视觉颗粒度对齐截图频率
      if (py1 - py0 >= 4) {
        ctx.save()
        ctx.fillStyle = 'rgba(0,0,0,0.32)'
        for (let mi = Math.ceil(segStart); mi < segEnd; mi++) {
          const ty = minuteToY(mi, c, p)
          if (ty <= py0 + 0.5 || ty >= py1 - 0.5) continue
          ctx.fillRect(barX, Math.round(ty), barW, 1)
        }
        ctx.restore()
      }
    }
  }
}

/** AFK 覆盖：在 apps 管道左半叠一条红色细线，标识"离开"时段 */
function drawAfkOverlay(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  spans: PerceptionSpan[],
) {
  const RED = '#ff4d4d'
  for (const span of spans) {
    if (span.track !== 'status') continue
    const status = (span.group_name ?? span.title ?? '').toLowerCase()
    if (status !== 'afk') continue
    const startMin = dtToMinute(span.start_at)
    const endMin   = dtToMinute(span.end_at)
    if (endMin <= startMin) continue

    const startCol = Math.floor(startMin / p.minutesPerCol)
    const endCol   = Math.floor((endMin - 0.0001) / p.minutesPerCol)

    for (let c = startCol; c <= endCol && c < p.cols; c++) {
      const segStart = Math.max(startMin, c * p.minutesPerCol)
      const segEnd   = Math.min(endMin, (c + 1) * p.minutesPerCol)
      const cx = colX(c, p)
      const rx = cx + p.traceBaseX + PIPE_RIGHT
      const py0 = minuteToY(segStart, c, p)
      const py1 = minuteToY(segEnd, c, p)
      if (py1 <= py0) continue

      // 完全在活动矩形里画 3px 红条，距管道留 1px 空隙
      ctx.save()
      ctx.fillStyle = RED
      ctx.shadowColor = hexToRgba(RED, 0.85)
      ctx.shadowBlur = 5
      ctx.fillRect(rx + 1, py0, 3, py1 - py0)
      ctx.restore()
    }
  }
}

/** B站观看历史 → 双轨管线（按列连续，穿越行间隙，左轨粉/黄交替） */
function drawBiliTracesInPipe(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  spans: BiliSpan[],
) {
  for (let si = 0; si < spans.length; si++) {
    const span = spans[si]
    const startMin = dtToMinute(span.start_at)
    const endMin   = dtToMinute(span.end_at)
    if (endMin <= startMin) continue

    const railColor = si % 2 === 0 ? BILI_COLOR : BILI_YELLOW
    const vivid = brightenForDark(railColor, 160)
    const startCol = Math.floor(startMin / p.minutesPerCol)
    const endCol   = Math.floor((endMin - 1) / p.minutesPerCol)

    for (let c = startCol; c <= endCol && c < p.cols; c++) {
      const segStart = Math.max(startMin, c * p.minutesPerCol)
      const segEnd   = Math.min(endMin, (c + 1) * p.minutesPerCol)
      const cx = colX(c, p)
      const lx = cx + p.traceBaseX + PIPE_LEFT
      const rx = cx + p.traceBaseX + PIPE_RIGHT
      const py0 = minuteToY(segStart, c, p)
      const py1 = minuteToY(segEnd, c, p)
      if (py1 - py0 < 1) continue

      const barX = lx + 1
      const barW = (rx - lx) - 1
      ctx.save()
      ctx.shadowColor = hexToRgba(vivid, 0.55)
      ctx.shadowBlur = 4
      ctx.fillStyle = vivid
      ctx.fillRect(barX, py0, barW, Math.max(1, py1 - py0))
      ctx.restore()
    }
  }
}

/** Perception 标签标题 */
function drawTagTitles(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  spans: PerceptionSpan[],
) {
  // tag 矩形 X 范围：紧贴管道右侧 ~ cell 右边
  const fillOffsetX = p.traceBaseX + traceWidth + TRACE_GAP
  const fillW       = p.cellW - fillOffsetX
  if (fillW <= 0) return

  const fontSize = p.fs(12)
  const lineH    = Math.max(8, Math.round(fontSize * 1.35))
  const innerW   = fillW - 6  // 左右各留 3px 内边距给文本

  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${fontSize}px 'JetBrains Mono', 'Courier New', monospace`

  for (const span of spans) {
    if (span.track !== 'tags') continue
    const startMin = dtToMinute(span.start_at)
    const endMin   = dtToMinute(span.end_at)
    if (endMin <= startMin) continue

    const { parts } = parseTagTitle(span.title)
    const label = parts[parts.length - 1] ?? ''
    if (!label) continue

    const startCol = Math.floor(startMin / p.minutesPerCol)
    const endCol   = Math.floor((endMin - 0.0001) / p.minutesPerCol)

    // 每列一个 "合并居中" 文本：跨该列内的全部行块，整体垂直居中绘制
    for (let c = startCol; c <= endCol && c < p.cols; c++) {
      const cx = colX(c, p)
      const centerX = cx + fillOffsetX + fillW / 2

      const colStartMin = c * p.minutesPerCol
      const segStart = Math.max(startMin, colStartMin)
      const segEnd   = Math.min(endMin, colStartMin + p.minutesPerCol)
      // 整列上的 y 范围（跨 row 时 minuteToY 自动算上 rowStride）
      const y0 = minuteToY(segStart, c, p)
      const y1 = minuteToY(segEnd, c, p)
      const hAvail = y1 - y0
      if (hAvail < Math.max(8, lineH * 0.6)) continue

      const lines = wrapText(ctx, label, innerW)
      const cy0 = y0
      const cy1 = y1
      if (hAvail < lines.length * lineH) {
        ctx.fillText(lines[0], centerX, (cy0 + cy1) / 2)
      } else {
        const totalH = lines.length * lineH
        let cy = (cy0 + cy1 - totalH) / 2 + lineH / 2
        for (const line of lines) {
          ctx.fillText(line, centerX, cy)
          cy += lineH
        }
      }
    }
  }
  ctx.restore()
}

const traceWidth = 6      // tag fill 区紧贴管道右侧（管道宽 = PIPE_RIGHT）
const BILI_COLOR    = '#FB7299'
const BILI_YELLOW   = '#F5C842'

// ── Canvas 绘制函数 ──

function drawGrid(ctx: CanvasRenderingContext2D, p: ReturnType<typeof getGridParams>) {
  const blue = theme.electricBlue
  // 区时边界精确分钟数（包括 0 点）
  const ZONE_BOUNDARY_MINS = new Set([0, 6*60, 12*60, 18*60, 20*60])
  const cornerLen = Math.min(8, p.cellW * 0.12, p.cellH * 0.15)

  // 绘制单个 bracket 角：side 控制绘制左侧还是右侧角
  function drawCorners(
    x: number, y: number, w: number, h: number,
    drawLeft: boolean, drawRight: boolean,
    color: string, lw: number, glow: boolean,
  ) {
    ctx.strokeStyle = color
    ctx.lineWidth = lw
    if (glow) { ctx.save(); ctx.shadowColor = blue; ctx.shadowBlur = 4 }
    if (drawLeft) {
      ctx.beginPath(); ctx.moveTo(x, y + cornerLen); ctx.lineTo(x, y); ctx.lineTo(x + cornerLen, y); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x, y + h - cornerLen); ctx.lineTo(x, y + h); ctx.lineTo(x + cornerLen, y + h); ctx.stroke()
    }
    if (drawRight) {
      ctx.beginPath(); ctx.moveTo(x + w - cornerLen, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + cornerLen); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x + w - cornerLen, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - cornerLen); ctx.stroke()
    }
    if (glow) ctx.restore()
  }

  for (let c = 0; c < p.cols; c++) {
    const startMin  = c * p.minutesPerCol
    const startHour = Math.floor(startMin / 60)
    const isNight = startHour < 6 || startHour >= 22
    const baseA = isNight ? 0.08 : 0.15

    // 该列起始分钟恰好是区时边界 → 左侧高亮
    const leftEdge  = ZONE_BOUNDARY_MINS.has(startMin)
    // 该列结束分钟恰好是区时边界 → 右侧高亮（即下一列是区时第一列）
    const rightEdge = ZONE_BOUNDARY_MINS.has(startMin + p.minutesPerCol)

    for (let r = 0; r < p.rows; r++) {
      const x = colX(c, p)
      const y = p.topPad + r * p.rowStride
      const w = p.cellW
      const h = p.cellH

      // 底色扫描线（每格交替微亮）
      if ((c + r) % 2 === 0) {
        ctx.fillStyle = hexToRgba(blue, 0.02)
        ctx.fillRect(x, y, w, h)
      }

      // 边框细线
      ctx.strokeStyle = hexToRgba(blue, baseA)
      ctx.lineWidth = 0.5
      ctx.strokeRect(x, y, w, h)

      // 普通四角（非边界侧）
      drawCorners(x, y, w, h, !leftEdge, !rightEdge, hexToRgba(blue, baseA * 2.5), 1, false)

      // 区时边界侧：更亮更粗有辉光
      if (leftEdge || rightEdge) {
        drawCorners(x, y, w, h, leftEdge, rightEdge, hexToRgba(blue, 0.75), 1.5, true)
      }
    }
  }

}

function drawTimeLabels(ctx: CanvasRenderingContext2D, p: ReturnType<typeof getGridParams>) {
  const ZONE_BOUNDARY_MINS = new Set([0, 6*60, 12*60, 18*60, 20*60])
  ctx.textAlign = 'center'
  for (let c = 0; c < p.cols; c++) {
    const x = colX(c, p) + p.cellW / 2
    const colStartMin = c * p.minutesPerCol
    const major = ZONE_BOUNDARY_MINS.has(colStartMin)
    ctx.font = `${major ? 'bold' : '500'} ${major ? p.fs(12) : p.fs(10)}px 'JetBrains Mono', 'Courier New', monospace`
    ctx.fillStyle = major ? theme.electricBlue : theme.textPrimary
    ctx.fillText(fmt(colStartMin), x, p.topPad - 8)
  }
  // 行间小标签
  for (let c = 0; c < p.cols; c++) {
    const cx = colX(c, p) + p.cellW / 2
    const colStartMin = c * p.minutesPerCol
    for (let r = 0; r < p.rows - 1; r++) {
      const boundaryMin = colStartMin + (r + 1) * 5
      const gapY = p.topPad + r * p.rowStride + p.cellH + p.rowGap / 2
      const isMajor = boundaryMin % 10 === 0
      ctx.font = `${isMajor ? 'bold' : 'normal'} ${isMajor ? p.fs(10) : p.fs(9)}px 'JetBrains Mono', 'Courier New', monospace`
      ctx.fillStyle = theme.textSecondary
      ctx.fillText(fmt(boundaryMin), cx, gapY + 3)
    }
  }
}


function drawNowTick(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  isToday: boolean,
) {
  if (!isToday) return
  const now = new Date()
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  const col = Math.floor(nowMinute / p.minutesPerCol)
  if (col >= p.cols) return
  const row = Math.floor((nowMinute % p.minutesPerCol) / 5)
  const localMin = nowMinute % 5
  if (row >= p.rows) return

  const cx = colX(col, p)
  const cy = p.topPad + row * p.rowStride
  const y = cy + localMin * p.minuteH
  const cyan = '#00E5FF'
  const seconds = now.getSeconds()
  // 每 3 秒 pulse 一次（用秒做静态强度调制，避免额外 rAF）
  const pulse = 0.7 + 0.3 * Math.abs(Math.sin((seconds / 60) * Math.PI * 2))

  // ── 全列纵向扫描光柱（居中在 y，上下渐隐） ──
  const colCx = cx + p.cellW / 2
  const sweepGrad = ctx.createLinearGradient(colCx, p.topPad, colCx, p.topPad + p.gridH)
  sweepGrad.addColorStop(0, 'rgba(0,229,255,0)')
  sweepGrad.addColorStop(Math.max(0, (y - p.topPad - 80) / p.gridH), 'rgba(0,229,255,0)')
  sweepGrad.addColorStop((y - p.topPad) / p.gridH, `rgba(0,229,255,${0.08 * pulse})`)
  sweepGrad.addColorStop(Math.min(1, (y - p.topPad + 80) / p.gridH), 'rgba(0,229,255,0)')
  sweepGrad.addColorStop(1, 'rgba(0,229,255,0)')
  ctx.fillStyle = sweepGrad
  ctx.fillRect(cx, p.topPad, p.cellW, p.gridH)

  // ── 外层大光晕条 ──
  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = 22
  ctx.beginPath()
  ctx.moveTo(cx - 14, y); ctx.lineTo(cx + p.cellW + 14, y)
  ctx.strokeStyle = hexToRgba(cyan, 0.22 * pulse)
  ctx.lineWidth = 10
  ctx.stroke()
  ctx.restore()

  // ── 主扫描线（三段渐变：透明 → 亮 → 透明反向）──
  const lineGrad = ctx.createLinearGradient(cx - 6, y, cx + p.cellW + 6, y)
  lineGrad.addColorStop(0,    'rgba(0,229,255,0)')
  lineGrad.addColorStop(0.15, cyan)
  lineGrad.addColorStop(0.5,  '#FFFFFF')
  lineGrad.addColorStop(0.85, cyan)
  lineGrad.addColorStop(1,    'rgba(0,229,255,0)')
  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = 2
  ctx.beginPath()
  // 右端在列末收尾，避免辉光蔓延到右侧 chip
  ctx.moveTo(cx - 6, y); ctx.lineTo(cx + p.cellW, y)
  ctx.strokeStyle = lineGrad
  ctx.lineWidth = 1.25
  ctx.stroke()
  ctx.restore()

  // ── 中段刻度（线上每 ~1/4 处一个小方点） ──
  ctx.save()
  ctx.fillStyle = hexToRgba(cyan, 0.7)
  for (const r of [0.25, 0.5, 0.75]) {
    const tx = cx + p.cellW * r
    ctx.fillRect(tx - 0.5, y - 2, 1, 4)
  }
  ctx.restore()

  // ── 两端 L 角端盖 ──
  ctx.save()
  ctx.strokeStyle = cyan
  ctx.lineWidth = 1
  const lArm = 5
  ctx.beginPath()
  // 左端
  ctx.moveTo(cx, y - lArm); ctx.lineTo(cx, y + lArm)
  // 右端
  ctx.moveTo(cx + p.cellW, y - lArm); ctx.lineTo(cx + p.cellW, y + lArm)
  ctx.stroke()
  ctx.restore()

  // ── 右侧 HUD 时间指示：chip 尺寸适中（时间数字略主导但不喧宾夺主） ──
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const timeFontSize = p.fs(13)
  const nowFontSize = p.fs(8)
  ctx.font = `800 ${timeFontSize}px 'JetBrains Mono', 'Courier New', monospace`
  const timeW = ctx.measureText(timeStr).width

  ctx.font = `700 ${nowFontSize}px 'JetBrains Mono', 'Courier New', monospace`
  const nowLabelW = ctx.measureText('NOW').width

  const padX = 8
  const dotSize = 5
  const gap = 6
  const nowTimeGap = 5
  const chipW = padX + dotSize + gap + nowLabelW + nowTimeGap + timeW + padX
  const chipH = 21

  // ── ① 圆环锚点（套在左侧管道中线 = cx + (PIPE_LEFT + PIPE_RIGHT)/2 = cx + 3） ──
  const anchorX = cx + 3
  const anchorR = 4.5
  const anchorGlow = 7 * pulse
  // 外圈呼吸环（更大更淡，alpha 随 pulse 变化）
  ctx.save()
  ctx.strokeStyle = hexToRgba(cyan, 0.15 + 0.18 * pulse)
  ctx.lineWidth = 0.7
  ctx.beginPath()
  ctx.arc(anchorX, y, anchorR + 3.2, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
  // 主环
  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = anchorGlow
  ctx.strokeStyle = cyan
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.arc(anchorX, y, anchorR, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
  // 4 向 crosshair 小刻度（主环与呼吸环之间）
  ctx.save()
  ctx.strokeStyle = hexToRgba(cyan, 0.92)
  ctx.lineWidth = 1
  const tIn = anchorR + 0.6
  const tOut = anchorR + 2.4
  ctx.beginPath()
  ctx.moveTo(anchorX + tIn, y); ctx.lineTo(anchorX + tOut, y)     // 右
  ctx.moveTo(anchorX - tIn, y); ctx.lineTo(anchorX - tOut, y)     // 左
  ctx.moveTo(anchorX, y + tIn); ctx.lineTo(anchorX, y + tOut)     // 下
  ctx.moveTo(anchorX, y - tIn); ctx.lineTo(anchorX, y - tOut)     // 上
  ctx.stroke()
  ctx.restore()
  // 左指三角 ▷（呼吸环外左侧）
  ctx.save()
  ctx.fillStyle = cyan
  ctx.shadowColor = cyan
  ctx.shadowBlur = 3
  const triRight = anchorX - anchorR - 4
  ctx.beginPath()
  ctx.moveTo(triRight, y - 2)
  ctx.lineTo(triRight - 2.5, y)
  ctx.lineTo(triRight, y + 2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
  // 中心实心圆
  ctx.save()
  ctx.fillStyle = cyan
  ctx.shadowColor = cyan
  ctx.shadowBlur = 4
  ctx.beginPath()
  ctx.arc(anchorX, y, 1.5, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // ── ② 列尾 → chip 的渐变连接线（cyan + 中心白心，管道感） ──
  const lineStartX = cx + p.cellW + 5
  const lineLen = 18
  const lineEndX = lineStartX + lineLen
  const chevronSize = 3.2
  const chevronGap = 1.8
  const chevronStartX = lineEndX + 2.5
  const chevronTotalW = 3 * chevronSize + 2 * chevronGap
  const chevronEndX = chevronStartX + chevronTotalW
  const chipX = chevronEndX + 4
  const chipY = y - chipH / 2

  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = 6
  const connGrad = ctx.createLinearGradient(lineStartX, y, lineEndX, y)
  connGrad.addColorStop(0, hexToRgba(cyan, 0.95))
  connGrad.addColorStop(1, hexToRgba(cyan, 0.32))
  ctx.strokeStyle = connGrad
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(lineStartX, y); ctx.lineTo(lineEndX, y)
  ctx.stroke()
  ctx.restore()
  // 中央高光（白心 0.55 厚，让线呈现"管道感"）
  ctx.save()
  ctx.strokeStyle = 'rgba(220,250,255,0.72)'
  ctx.lineWidth = 0.55
  ctx.beginPath()
  ctx.moveTo(lineStartX + 1, y); ctx.lineTo(lineEndX - 2, y)
  ctx.stroke()
  ctx.restore()

  // ── ③ ▶▶▶ 箭头（3 个实心三角填充，朝右） ──
  ctx.save()
  ctx.fillStyle = cyan
  ctx.shadowColor = cyan
  ctx.shadowBlur = 4
  for (let i = 0; i < 3; i++) {
    const cxArrow = chevronStartX + i * (chevronSize + chevronGap)
    ctx.beginPath()
    ctx.moveTo(cxArrow, y - chevronSize)
    ctx.lineTo(cxArrow + chevronSize, y)
    ctx.lineTo(cxArrow, y + chevronSize)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()

  // ④ 八边形 chip（左右长切角 + 上下短切角，胶囊感）
  const chamferX = 5
  const chamferY = 3.5
  const buildOctPath = (offset: number) => {
    const x0 = chipX - offset
    const y0 = chipY - offset
    const w = chipW + offset * 2
    const h = chipH + offset * 2
    ctx.beginPath()
    ctx.moveTo(x0 + chamferX, y0)
    ctx.lineTo(x0 + w - chamferX, y0)
    ctx.lineTo(x0 + w, y0 + chamferY)
    ctx.lineTo(x0 + w, y0 + h - chamferY)
    ctx.lineTo(x0 + w - chamferX, y0 + h)
    ctx.lineTo(x0 + chamferX, y0 + h)
    ctx.lineTo(x0, y0 + h - chamferY)
    ctx.lineTo(x0, y0 + chamferY)
    ctx.closePath()
  }

  // chip 底色（深青墨）+ inset cyan radial glow
  ctx.save()
  buildOctPath(0)
  ctx.fillStyle = 'rgba(0,30,42,0.82)'
  ctx.fill()
  const insetGrad = ctx.createRadialGradient(
    chipX + chipW / 2, chipY + chipH / 2, 1,
    chipX + chipW / 2, chipY + chipH / 2, Math.max(chipW, chipH) * 0.7,
  )
  insetGrad.addColorStop(0, hexToRgba(cyan, 0.22))
  insetGrad.addColorStop(0.55, hexToRgba(cyan, 0.07))
  insetGrad.addColorStop(1, 'rgba(0,229,255,0)')
  ctx.fillStyle = insetGrad
  ctx.fill()
  ctx.restore()

  // chip 主描边（cyan，带 glow）
  ctx.save()
  buildOctPath(0)
  ctx.strokeStyle = hexToRgba(cyan, 0.95)
  ctx.lineWidth = 1.4
  ctx.shadowColor = cyan
  ctx.shadowBlur = 5
  ctx.stroke()
  ctx.restore()
  // chip 外侧次描边（offset 2，模拟"双框/重影"）
  ctx.save()
  buildOctPath(2)
  ctx.strokeStyle = hexToRgba(cyan, 0.25)
  ctx.lineWidth = 0.7
  ctx.stroke()
  ctx.restore()

  // 脉冲小圆点（左端，落在 y 上）— 只在圆点上保留细微脉冲
  ctx.save()
  ctx.fillStyle = cyan
  ctx.shadowColor = cyan
  ctx.shadowBlur = 4 * pulse
  const dotCx = chipX + padX + dotSize / 2
  ctx.beginPath()
  ctx.arc(dotCx, y, dotSize / 2 * (0.78 + 0.22 * pulse), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // NOW 小标签（灰白次要色，让大字时间占主视觉）
  ctx.save()
  ctx.font = `700 ${nowFontSize}px 'JetBrains Mono', 'Courier New', monospace`
  ctx.fillStyle = 'rgba(200,225,235,0.68)'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('NOW', chipX + padX + dotSize + gap, y + 0.5)
  ctx.restore()

  // 时间主文本（大字号 + 加粗，纯白带轻微 cyan 内 glow）
  ctx.save()
  ctx.font = `800 ${timeFontSize}px 'JetBrains Mono', 'Courier New', monospace`
  ctx.fillStyle = '#FFFFFF'
  ctx.shadowColor = hexToRgba(cyan, 0.55)
  ctx.shadowBlur = 3
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(timeStr, chipX + padX + dotSize + gap + nowLabelW + nowTimeGap, y + 0.5)
  ctx.restore()

  // 防止全局 textBaseline 漏出
  ctx.textBaseline = 'alphabetic'
}

// ── 十字准线（只在当前列） ──

/** 绘制固定/悬浮横线 + 可选"固定"标签，返回标签命中区域（用于点击检测） */
function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  col: number,
  mouseY: number,
  spans: PerceptionSpan[],
  isPinned: boolean,
  getIcon?: (name: string) => HTMLImageElement | null,
  trackMode: 'apps' | 'bili' = 'apps',
  biliSpans: BiliSpan[] = [],
): { x: number; y: number; w: number; h: number; pin: { col: number; y: number; minute: number } } | null {
  if (col < 0 || col >= p.cols) return null
  const relY = mouseY - p.topPad
  if (relY < 0 || relY > p.gridH) return null

  const x0 = colX(col, p)
  const x1 = x0 + p.cellW

  // 当前列的分钟（含秒级小数，用于精确判定管道 / tag 命中）
  const rBlock = Math.floor(relY / p.rowStride)
  if (rBlock >= p.rows) return null
  const localY = relY - rBlock * p.rowStride
  const minuteFracInRow = Math.max(0, Math.min(5, localY / p.minuteH))
  const minute = col * p.minutesPerCol + rBlock * 5 + minuteFracInRow

  // 高亮该列内的 tag span 边框
  const fillOffsetX = p.traceBaseX + traceWidth + TRACE_GAP
  for (const span of spans) {
    if (span.track !== 'tags') continue
    const startMin = dtToMinute(span.start_at)
    const endMin = dtToMinute(span.end_at)
    if (minute < startMin || minute >= endMin) continue
    const segStart = Math.max(startMin, col * p.minutesPerCol)
    const segEnd = Math.min(endMin, (col + 1) * p.minutesPerCol)
    const y0 = minuteToY(segStart, col, p)
    const y1 = minuteToY(segEnd, col, p)
    const color = span.color ?? '#4488ff'
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 12
    ctx.strokeStyle = hexToRgba(color, 1.0)
    ctx.lineWidth = 1.5
    ctx.strokeRect(x0 + fillOffsetX + 0.5, y0 + 0.5, p.cellW - fillOffsetX - 1, y1 - y0 - 1)
    ctx.restore()
  }

  // 高亮该列内的管线 + 管口端盖 + 横线标签
  let pipeLabel: string | null = null    // 管线标签文本
  let pipeLabelIcon: HTMLImageElement | null = null

  // 跨列高亮管线辅助
  function highlightPipeSpan(startMin: number, endMin: number, _color: string) {
    // 固定高亮色：亮青 + 白，不随 span 颜色变化
    const frameColor = '#00E5FF'
    const frameGlow  = 'rgba(0,229,255,0.8)'

    const hStartCol = Math.floor(startMin / p.minutesPerCol)
    const hEndCol   = Math.floor((endMin - 1) / p.minutesPerCol)
    for (let hc = hStartCol; hc <= hEndCol && hc < p.cols; hc++) {
      const hcx  = colX(hc, p)
      const segS = Math.max(startMin, hc * p.minutesPerCol)
      const segE = Math.min(endMin, (hc + 1) * p.minutesPerCol)
      const sy0  = minuteToY(segS, hc, p)
      const sy1  = minuteToY(segE, hc, p)
      const lx   = hcx + p.traceBaseX + PIPE_LEFT
      const rx   = hcx + p.traceBaseX + PIPE_RIGHT

      ctx.save()
      ctx.shadowColor = frameGlow; ctx.shadowBlur = 10
      ctx.beginPath(); ctx.moveTo(lx, sy0); ctx.lineTo(lx, sy1)
      ctx.strokeStyle = frameColor
      ctx.lineWidth = 3.5; ctx.lineCap = 'butt'; ctx.stroke()
      ctx.beginPath(); ctx.moveTo(rx, sy0); ctx.lineTo(rx, sy1)
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1.5; ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.shadowColor = frameGlow; ctx.shadowBlur = 6
      ctx.strokeStyle = frameColor
      ctx.lineWidth = 1.5; ctx.lineCap = 'square'
      if (hc === hStartCol) {
        ctx.beginPath(); ctx.moveTo(lx - 1, sy0); ctx.lineTo(rx + 1, sy0); ctx.stroke()
      }
      if (hc === hEndCol) {
        ctx.beginPath(); ctx.moveTo(lx - 1, sy1); ctx.lineTo(rx + 1, sy1); ctx.stroke()
      }
      ctx.restore()
    }
  }

  if (trackMode === 'bili') {
    const hovBiliIdx = biliSpans.findIndex(s => {
      const s0 = dtToMinute(s.start_at), s1 = dtToMinute(s.end_at)
      return minute >= s0 && minute < s1
    })
    const hovBili = hovBiliIdx >= 0 ? biliSpans[hovBiliIdx] : null
    if (hovBili) {
      const railColor = hovBiliIdx % 2 === 0 ? BILI_COLOR : BILI_YELLOW
      highlightPipeSpan(dtToMinute(hovBili.start_at), dtToMinute(hovBili.end_at), railColor)
      pipeLabel = hovBili.title
    }
  } else {
    let hoveredAppSpan: PerceptionSpan | null = null
    for (const span of spans) {
      if (span.track !== 'apps') continue
      const startMin = dtToMinute(span.start_at)
      const endMin   = dtToMinute(span.end_at)
      if (minute < startMin || minute >= endMin) continue
      hoveredAppSpan = span
      // 高亮只覆盖鼠标所在的 1 分钟（= 一张截图）切片，被 span 自身的实际边界裁剪
      const sliceStart = Math.max(startMin, Math.floor(minute))
      const sliceEnd   = Math.min(endMin, Math.floor(minute) + 1)
      highlightPipeSpan(sliceStart, sliceEnd, span.color ?? '#888888')
      break
    }
    if (hoveredAppSpan) {
      const appName = hoveredAppSpan.group_name ?? hoveredAppSpan.title
      pipeLabel = appName
      pipeLabelIcon = getIcon?.(appName) ?? null
    }
  }

  // ── HUD 准星横线：主线 + 两端 L 角 + 中段刻度 ──
  const lineColor = isPinned ? 'rgba(255,180,60,0.95)' : 'rgba(220,240,255,0.65)'
  const glowColor = isPinned ? 'rgba(255,180,60,0.55)' : 'rgba(180,220,255,0.45)'
  const tickColor = isPinned ? 'rgba(255,180,60,0.85)' : 'rgba(200,230,255,0.55)'

  ctx.save()
  ctx.shadowColor = glowColor
  ctx.shadowBlur = isPinned ? 5 : 4
  ctx.beginPath()
  ctx.moveTo(x0, mouseY)
  ctx.lineTo(x1, mouseY)
  ctx.strokeStyle = lineColor
  ctx.lineWidth = isPinned ? 1 : 0.75
  ctx.stroke()
  ctx.restore()

  // 两端 L 角端盖（向内）
  ctx.save()
  ctx.strokeStyle = tickColor
  ctx.lineWidth = isPinned ? 1 : 0.85
  ctx.shadowColor = glowColor
  ctx.shadowBlur = isPinned ? 4 : 2
  const lArm = 4
  ctx.beginPath()
  // 左端：向下 + 向内
  ctx.moveTo(x0, mouseY - lArm); ctx.lineTo(x0, mouseY + lArm)
  ctx.moveTo(x0, mouseY);        ctx.lineTo(x0 + 2, mouseY)
  // 右端
  ctx.moveTo(x1, mouseY - lArm); ctx.lineTo(x1, mouseY + lArm)
  ctx.moveTo(x1, mouseY);        ctx.lineTo(x1 - 2, mouseY)
  ctx.stroke()
  ctx.restore()

  // 中段 3 枚短刻度（仅在准星较长时画，避免挤压）
  if (x1 - x0 > 36) {
    ctx.save()
    ctx.strokeStyle = tickColor
    ctx.globalAlpha = 0.55
    ctx.lineWidth = 0.75
    const midX = (x0 + x1) / 2
    ctx.beginPath()
    for (const dx of [-6, 0, 6]) {
      ctx.moveTo(midX + dx, mouseY - 2)
      ctx.lineTo(midX + dx, mouseY + 2)
    }
    ctx.stroke()
    ctx.restore()
  }

  // ── 管线标签（原风格 + 轻微斜切） ──
  if (pipeLabel) {
    const hasIcon  = pipeLabelIcon !== null
    const iconSize = 14
    const gap      = 4
    const padX     = 4, padY = 3
    const lineH    = 11

    const labelX     = x0 + p.traceBaseX + PIPE_RIGHT + 6
    const maxLabelW  = x1 - labelX - 2
    const availTextW = maxLabelW - padX * 2 - (hasIcon ? iconSize + gap : 0)

    ctx.font = `500 ${p.fs(9)}px 'JetBrains Mono', 'Courier New', monospace`
    const lines     = availTextW > 10 ? wrapText(ctx, pipeLabel, availTextW).slice(0, 3) : [pipeLabel]
    const textBlock = hasIcon ? Math.max(iconSize, lines.length * lineH) : lines.length * lineH
    const labelH    = padY * 2 + textBlock
    const labelY    = mouseY - labelH / 2

    ctx.save()
    chamferPath(ctx, labelX, labelY, maxLabelW, labelH, 2)
    ctx.fillStyle   = 'rgba(4,8,18,0.80)'
    ctx.fill()
    ctx.strokeStyle = isPinned ? 'rgba(255,180,60,0.5)' : (trackMode === 'bili' ? 'rgba(251,114,153,0.3)' : 'rgba(255,255,255,0.18)')
    ctx.lineWidth   = 0.75
    ctx.stroke()
    ctx.restore()

    let textX = labelX + padX
    if (hasIcon && pipeLabelIcon) {
      const iconY = labelY + padY + (textBlock - iconSize) / 2
      ctx.drawImage(pipeLabelIcon, labelX + padX, iconY, iconSize, iconSize)
      textX = labelX + padX + iconSize + gap
    }

    ctx.font         = `500 ${p.fs(9)}px 'JetBrains Mono', 'Courier New', monospace`
    ctx.fillStyle    = 'rgba(255,255,255,0.88)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'alphabetic'
    const textStartY = labelY + padY + lineH - 1
    lines.forEach((line, i) => {
      ctx.fillText(line, textX, textStartY + i * lineH)
    })
  }

  // ── 锁定/解锁 badge：HUD 指示器（深底 + 彩色边框 + 彩色发光文字） ──
  const label = isPinned ? '解锁' : '锁定'
  const font = `bold ${p.fs(9)}px 'JetBrains Mono', 'Courier New', monospace`
  ctx.font = font
  const textW = ctx.measureText(label).width
  const bPadX = 7
  const badgeW = textW + bPadX * 2
  const badgeH = 14
  const badgeX = x1 + 5
  const badgeY = mouseY - badgeH / 2

  const accentC = isPinned ? 'rgba(255,180,60,1)'   : 'rgba(150,210,255,0.9)'
  const softC   = isPinned ? 'rgba(255,180,60,0.35)': 'rgba(150,210,255,0.3)'
  const glowC   = isPinned ? 'rgba(255,180,60,0.6)' : 'rgba(150,200,255,0.35)'

  // 主体：深背景 + 彩色边框
  ctx.save()
  ctx.shadowColor = glowC
  ctx.shadowBlur = isPinned ? 6 : 3
  chamferPath(ctx, badgeX, badgeY, badgeW, badgeH, 3)
  ctx.fillStyle = 'rgba(6,10,20,0.88)'
  ctx.fill()
  ctx.strokeStyle = accentC
  ctx.lineWidth = isPinned ? 1 : 0.8
  ctx.stroke()
  ctx.restore()

  // 顶/底 accent 细线（HUD 端口感）
  ctx.save()
  ctx.strokeStyle = softC
  ctx.lineWidth = 0.75
  ctx.beginPath()
  ctx.moveTo(badgeX + 4, badgeY - 1); ctx.lineTo(badgeX + badgeW - 4, badgeY - 1)
  ctx.moveTo(badgeX + 4, badgeY + badgeH + 1); ctx.lineTo(badgeX + badgeW - 4, badgeY + badgeH + 1)
  ctx.stroke()
  ctx.restore()

  // 文字：彩色发光，严格几何居中
  ctx.save()
  ctx.font         = font
  ctx.fillStyle    = accentC
  ctx.shadowColor  = glowC
  ctx.shadowBlur   = isPinned ? 4 : 2
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, badgeX + badgeW / 2, badgeY + badgeH / 2 + 0.5)
  ctx.restore()

  return { x: badgeX, y: badgeY, w: badgeW, h: badgeH, pin: { col, y: mouseY, minute } }
}

// ── 编辑模式：拖刷预览（在 tag 填充层之上 / 准星之下） ──
// 取反语义：起点快照里 has(min) 的格子按"擦"渲染；其余在有画笔时按"涂"渲染



function drawDragPreview(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  startMin: number,
  endMin: number,
  brushColor: string,
  brushTagId: number | null,
  initial: Map<number, number>,
) {
  const lo = Math.min(startMin, endMin)
  const hi = Math.max(startMin, endMin)
  const fillOffsetX = p.traceBaseX + traceWidth + TRACE_GAP
  const hasBrush = brushTagId != null

  ctx.save()
  for (let m = lo; m <= hi; m += 5) {
    if (m < 0 || m >= 1440) continue
    const c = Math.floor(m / p.minutesPerCol)
    if (c < 0 || c >= p.cols) continue
    const y0 = minuteToY(m, c, p)
    const y1 = minuteToY(m + 5, c, p)
    const x  = colX(c, p) + fillOffsetX
    const w  = p.cellW - fillOffsetX
    const h  = y1 - y0
    if (h <= 0 || w <= 0) continue

    const existing = initial.get(m)

    // 状态分类：
    //   existing 不存在 → 空格
    //   无画笔 + existing 存在 → 擦（清除模式）
    //   有画笔 + 同色 → 擦（取消）
    //   有画笔 + 异色 → 替换
    //   有画笔 + 空格 → 涂
    //   无画笔 + 空格 → 经过不动
    const isErase = existing !== undefined && (!hasBrush || existing === brushTagId)
    const isReplace = existing !== undefined && hasBrush && existing !== brushTagId
    const isPaint = existing === undefined && hasBrush

    if (isErase) {
      // 擦：暗罩 + 红色虚线 + 中划线
      ctx.fillStyle = 'rgba(20, 4, 8, 0.55)'
      ctx.fillRect(x, y0, w, h)
      ctx.strokeStyle = '#ff5860'
      ctx.lineWidth = 1.2
      ctx.setLineDash([3, 3])
      ctx.strokeRect(x + 0.75, y0 + 0.75, w - 1.5, h - 1.5)
      ctx.beginPath()
      ctx.moveTo(x + 2, y0 + h / 2)
      ctx.lineTo(x + w - 2, y0 + h / 2)
      ctx.stroke()
      ctx.setLineDash([])
    } else if (isReplace) {
      // 替换：画笔色更实 + 双层描边 + 右上角小三角提示"覆盖"
      ctx.fillStyle = hexToRgba(brushColor, 0.7)
      ctx.fillRect(x, y0, w, h)
      ctx.strokeStyle = brushColor
      ctx.lineWidth = 1.5
      ctx.shadowColor = brushColor
      ctx.shadowBlur = 8
      ctx.strokeRect(x + 0.75, y0 + 0.75, w - 1.5, h - 1.5)
      ctx.shadowBlur = 0
      ctx.fillStyle = brushColor
      ctx.beginPath()
      ctx.moveTo(x + w - 5, y0 + 1)
      ctx.lineTo(x + w - 1, y0 + 1)
      ctx.lineTo(x + w - 1, y0 + 5)
      ctx.closePath()
      ctx.fill()
    } else if (isPaint) {
      // 涂：半透明画笔色 + 发光边框
      ctx.fillStyle = hexToRgba(brushColor, 0.55)
      ctx.fillRect(x, y0, w, h)
      ctx.strokeStyle = brushColor
      ctx.lineWidth = 1.5
      ctx.shadowColor = brushColor
      ctx.shadowBlur = 6
      ctx.strokeRect(x + 0.75, y0 + 0.75, w - 1.5, h - 1.5)
      ctx.shadowBlur = 0
    } else {
      // 空格 + 无画笔：经过但不动
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      ctx.setLineDash([2, 3])
      ctx.strokeRect(x + 0.5, y0 + 0.5, w - 1, h - 1)
      ctx.setLineDash([])
    }
  }
  ctx.restore()
}


// ── 顶部 axis 行：左半固定（⊿ + 时间轴 + 当前阶段:中文）+ 底部细横线 ──
//   时段中文标签由 ScrollingZoneLabels 在 wrapper 内 sticky 层渲染（CSS native 同步）

function ChartTopAxisRow() {
  const cyan = theme.electricBlue

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 28,
      pointerEvents: 'none', zIndex: 60,
    }}>
      {/* 左半固定：⊿ + 时间轴（⊿ 偏右下，离 frame 折角斜线 ~9px 内层） */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0, left: 0,
        display: 'flex', alignItems: 'center', gap: 9,
        paddingLeft: 10, paddingRight: 18,
        background: 'linear-gradient(90deg, rgba(2,8,18,0.98) 0%, rgba(2,8,18,0.95) 75%, rgba(2,8,18,0) 100%)',
      }}>
        {/* ⊿ 简化：只主三角 + 内嵌小三角（去掉顶点亮点 / 接线 / 接线端点等"针刺铆钉"装饰） */}
        <svg width="14" height="14" style={{
          overflow: 'visible',
          filter: `drop-shadow(0 0 4px ${cyan}AA) drop-shadow(0 0 1.5px ${cyan})`,
        }}>
          <polygon points="1,13 13,13 13,1" fill={`${cyan}22`} stroke={cyan} strokeWidth="1.3" strokeLinejoin="miter" />
          <polygon points="4.5,11.5 11.5,11.5 11.5,4.5" fill="none" stroke={cyan} strokeWidth="0.8" strokeLinejoin="miter" opacity="0.55" />
        </svg>
        <span style={{
          fontFamily: theme.fontBody, fontSize: 13, fontWeight: 500,
          color: cyan, letterSpacing: 1,
          textShadow: `0 0 4px ${cyan}88`,
        }}>
          时间轴
        </span>
      </div>

      {/* 底部细横线（cyan 极淡） */}
      <div style={{
        position: 'absolute', bottom: 0, left: 16, right: 16,
        height: 1, background: `${cyan}33`,
        pointerEvents: 'none',
      }} />
    </div>
  )
}

// CornerArt 抽到 components/hud/CornerArt.tsx，统一供主舞台外壳使用

// ── 左侧 TIME AXIS 区 ──
//   关键设计：frame 左边线在文字 y 范围内"断开"（黑色遮罩覆盖），顶部装饰朝左上凸出折角；
//   TIME AXIS 文字在 frame 之外的 padding 溢出区；HUD 刻度尺在 chart canvas 与 axis 交界处；
//   底部 45° 大折角自 frame 左边线起，端点在 chart pane 内不出界。

function LeftAxis({ params }: { params: ReturnType<typeof getGridParams> }) {
  const cyan = theme.electricBlue
  const hostRef = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => setH(Math.round(entry.contentRect.height)))
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // 刻度对齐 chart 行间"时间戳单元格"（rowGap）的中线，与 drawTimeLabels 的 gapY 一致：
  //   - LeftAxis.top = 28 = params.topPad，LeftAxis 自身坐标 y=0 ↔ chart 第 0 行顶
  //   - gapY = i * rowStride + cellH + rowGap/2，对应时刻 (i+1)*5 分钟
  //   - major 间隔随密度自适应：12 行 → 每 15min，6/4 行 → 每 10min，3 行 → 每 5min（全 major）
  const majorEvery = params.rowsPerCol >= 12 ? 15 : params.rowsPerCol >= 4 ? 10 : 5
  const ticks = Array.from({ length: params.rowsPerCol }, (_, i) => {
    const minute = (i + 1) * 5
    return {
      minute,
      y: i * params.rowStride + params.cellH + params.rowGap / 2,
      major: minute % majorEvery === 0,
    }
  })

  // 几何
  //   - frame 主线 (xMain) 完整保留，HudFrameSkeleton 自画
  //   - 刀刃 polyline (4 点)：自 (xMain, slotTop) 斜入 → 竖直（包住 axis 文字）→ 斜出回 (xMain, slotBot)
  //   - 底部折角独立：自 (xMain, h-diagY) 斜向 (xMain+diagDx, h)，经过 frame 左边线 + 底边线
  //   - 文字 TIME AXIS 在 frame 主线 与 刀刃竖直段 之间
  const W = 72              // LeftAxis 宽度（24 padding 区 + 48 axis 内）
  const xMain = 24          // frame 主线 x
  const depth = 16          // 刀刃竖直段离 frame 主线
  const xKnife = xMain + depth
  const slant = 14          // 刀刃斜入/斜出高度
  const xText = xMain + 8   // 文字 x（frame 主线 + 刀刃中间）
  const xTickRail = W - 4
  // major 刻度几何：主线 7 + cap 2.5×3.6 + 右端 rail 接合焊点 r=1.8
  // 数字右缘贴 cap 左缘留 2px，整体形成"数字 ▮━━●"紧凑单元
  const majorLen = 7
  const capW = 2.5
  const capH = 3.6
  const numToCapGap = 2
  const xNum = xTickRail - majorLen - capW - numToCapGap   // = 56.5
  void xText
  const taCenterRatio = 0.22  // 整体往上挪（之前 0.30 还不够上）
  const taHalfH = 70         // 刀刃 y 半高
  const diagY = 80
  const diagDx = 80          // = diagY，让终点 y=h 接到 chart pane 底边线

  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute', top: 28, left: -24, width: W, bottom: 0,
        pointerEvents: 'none', zIndex: 80,
      }}
    >
      {h > 0 && (() => {
        const taY = h * taCenterRatio
        const slotTop = taY - taHalfH
        const slotBot = taY + taHalfH
        const slotInTop = slotTop + slant
        const slotInBot = slotBot - slant
        const diagStartY = h - diagY
        void slotInBot

        return (
          <svg width={W} height={h} style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}>
            {/* ── frame 主线遮罩：让 frame 主线在 axis 文字 y 范围断开，文本穿过 ── */}
            <rect x={xMain - 6} y={slotTop} width={12} height={slotBot - slotTop} fill="#020610" />

            {/* ── frame 主线下端恢复处的光点（slotBot 处实心圆 + glow） ── */}
            <circle
              cx={xMain} cy={slotBot}
              r="3"
              fill={cyan}
              style={{ filter: `drop-shadow(0 0 4px ${cyan}) drop-shadow(0 0 1.5px ${cyan})` }}
            />
            <circle
              cx={xMain} cy={slotBot}
              r="6.5"
              fill="none"
              stroke={cyan}
              strokeOpacity="0.2"
              strokeWidth="0.7"
            />

            {/* ── 刀刃刀尖光泽点（slotTop 处 3 条 polyline 起点重合 + 更强 glow） ── */}
            <defs>
              <linearGradient id="timeAxisBladeMoonlight" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor={cyan} stopOpacity="0.52" />
                <stop offset="10%" stopColor={cyan} stopOpacity="0.22" />
                <stop offset="32%" stopColor={cyan} stopOpacity="0.04" />
                <stop offset="58%" stopColor={cyan} stopOpacity="0" />
                <stop offset="100%" stopColor={cyan} stopOpacity="0" />
              </linearGradient>
              <radialGradient id="timeAxisBladeTipBloom" cx="36%" cy="0%" r="82%">
                <stop offset="0%" stopColor={cyan} stopOpacity="0.62" />
                <stop offset="46%" stopColor={cyan} stopOpacity="0.24" />
                <stop offset="100%" stopColor={cyan} stopOpacity="0" />
              </radialGradient>
              <linearGradient id="timeAxisBladeSideLift" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor={cyan} stopOpacity="0.2" />
                <stop offset="18%" stopColor={cyan} stopOpacity="0.12" />
                <stop offset="42%" stopColor={cyan} stopOpacity="0.025" />
                <stop offset="68%" stopColor={cyan} stopOpacity="0" />
                <stop offset="100%" stopColor={cyan} stopOpacity="0" />
              </linearGradient>
              <linearGradient id="timeAxisBladeTopTrace" x1="0%" y1="0%" x2="100%" y2="85%">
                <stop offset="0%" stopColor={cyan} stopOpacity="0.95" />
                <stop offset="36%" stopColor={cyan} stopOpacity="0.58" />
                <stop offset="74%" stopColor={cyan} stopOpacity="0.16" />
                <stop offset="100%" stopColor={cyan} stopOpacity="0" />
              </linearGradient>
              <linearGradient id="timeAxisBladeLeftTrace" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor={cyan} stopOpacity="0.82" />
                <stop offset="42%" stopColor={cyan} stopOpacity="0.34" />
                <stop offset="100%" stopColor={cyan} stopOpacity="0" />
              </linearGradient>
              <filter id="timeAxisBladeSoftBlur" x="-40%" y="-18%" width="180%" height="150%">
                <feGaussianBlur stdDeviation="1.25" />
              </filter>
              <pattern id="timeAxisBladeHex" width="6" height="5.2" patternUnits="userSpaceOnUse">
                <path
                  d="M1.5 0.3 L4.5 0.3 L6 2.6 L4.5 4.9 L1.5 4.9 L0 2.6 Z"
                  fill="none"
                  stroke={cyan}
                  strokeOpacity="0.055"
                  strokeWidth="0.45"
                />
              </pattern>
              <linearGradient id="timeAxisLeftEdgeFade" gradientUnits="userSpaceOnUse" x1={xMain - 4} y1={slotTop} x2={xMain - 4} y2={slotTop + 112}>
                <stop offset="0%" stopColor={cyan} stopOpacity="0.86" />
                <stop offset="62%" stopColor={cyan} stopOpacity="0.72" />
                <stop offset="100%" stopColor={cyan} stopOpacity="0" />
              </linearGradient>
              <linearGradient id="timeAxisInnerBladeFade" gradientUnits="userSpaceOnUse" x1={xKnife - 7} y1={h - diagY + depth} x2={xKnife - 7} y2={slotTop}>
                <stop offset="0%" stopColor={cyan} stopOpacity="0.58" />
                <stop offset="76%" stopColor={cyan} stopOpacity="0.5" />
                <stop offset="91%" stopColor={cyan} stopOpacity="0.08" />
                <stop offset="100%" stopColor={cyan} stopOpacity="0" />
              </linearGradient>
              <clipPath id="timeAxisBladeLightClip">
                <path
                  d={[
                    `M ${xMain} ${slotTop}`,
                    `L ${xKnife + 2} ${slotInTop}`,
                    `L ${xKnife + 2} ${slotBot + 56}`,
                    `L ${xMain - 4} ${slotBot + 56}`,
                    `L ${xMain - 4} ${slotTop + 20}`,
                    'Z',
                  ].join(' ')}
                />
              </clipPath>
            </defs>

            <path
              d={[
                `M ${xMain} ${slotTop}`,
                `L ${xKnife + 2} ${slotInTop}`,
              ].join(' ')}
              fill="none"
              stroke={cyan}
              strokeOpacity="0.95"
              strokeWidth="1.7"
              strokeLinecap="butt"
              strokeLinejoin="miter"
              style={{ filter: `drop-shadow(0 0 4px ${cyan}88)` }}
            />
            <line
              x1={xKnife + 2} y1={slotInTop}
              x2={xKnife + 0.5} y2={slotInTop + 18}
              stroke={cyan}
              strokeOpacity="0.34"
              strokeWidth="1.05"
              strokeLinecap="butt"
            />
            <path
              d={[
                `M ${xMain - 4} ${slotTop + 18}`,
                `L ${xMain - 4} ${slotTop + 112}`,
              ].join(' ')}
              fill="none"
              stroke="url(#timeAxisLeftEdgeFade)"
              strokeWidth="1.8"
              strokeLinecap="butt"
              strokeLinejoin="miter"
              style={{ filter: `drop-shadow(0 0 6px ${cyan}99)` }}
            />
            <g style={{ filter: `drop-shadow(0 0 6px ${cyan}99)` }}>
              <line x1={xMain - 3.8} y1={slotTop + 18} x2={xMain + 6.5} y2={slotTop + 8}
                stroke={cyan} strokeOpacity="0.86" strokeWidth="1.55" strokeLinecap="butt" />
              <line x1={xMain - 3.9} y1={slotTop + 14} x2={xMain + 5.8} y2={slotTop + 4.5}
                stroke={cyan} strokeOpacity="0.68" strokeWidth="1.25" strokeLinecap="butt" />
              <line x1={xMain - 3.7} y1={slotTop + 10.5} x2={xMain + 5.0} y2={slotTop + 2.2}
                stroke={cyan} strokeOpacity="0.48" strokeWidth="1" strokeLinecap="butt" />
            </g>

            {/* ── 刀刃 3 层平行 polyline（起点重合于 (xMain, slotTop)，向下扇形分散） ── */}
            {/* 主线（亮 + glow），最右一条 */}
            <polyline
              points={`${xMain},${slotTop} ${xKnife},${slotInTop} ${xKnife},${h - diagY + depth}`}
              fill="none"
              stroke={cyan} strokeOpacity="0.95" strokeWidth="1.4"
              strokeLinejoin="miter"
              style={{ filter: `drop-shadow(0 0 4px ${cyan}88)` }}
            />
            {/* 内层 1（中等）：起点重合主线 → 斜入紧贴 → 竖直段在主线左 5px */}
            <polyline
              points={`${xMain},${slotTop} ${xKnife - 5},${slotInTop} ${xKnife - 5},${h - diagY + depth - 5}`}
              fill="none"
              stroke="url(#timeAxisInnerBladeFade)" strokeWidth="0.8"
              strokeLinejoin="miter"
            />
            {/* 内层 2（淡）：起点重合主线 → 斜入更紧贴 → 竖直段在主线左 9px */}
            <polyline
              points={`${xMain},${slotTop} ${xKnife - 9},${slotInTop} ${xKnife - 9},${h - diagY + depth - 9}`}
              fill="none"
              stroke="url(#timeAxisInnerBladeFade)" opacity="0.62" strokeWidth="0.8"
              strokeLinejoin="miter"
            />

            {/* ── 底部 45° 大折角 3 条扇形分散（起点重合主线起点，终点提前不同距离）── */}
            {/* 主线（亮 + glow） */}
            <line
              x1={xMain} y1={diagStartY}
              x2={xMain + diagDx} y2={diagStartY + diagDx}
              stroke={cyan} strokeOpacity="0.95" strokeWidth="1.4"
              style={{ filter: `drop-shadow(0 0 4px ${cyan}88)` }}
            />
            {/* 内层 1（中等）：起点重合 + 终点提前 5px */}
            <line
              x1={xMain} y1={diagStartY}
              x2={xMain + diagDx - 5} y2={diagStartY + diagDx - 5}
              stroke={cyan} strokeOpacity="0.55" strokeWidth="0.8"
            />
            {/* 内层 2（淡）：起点重合 + 终点提前 9px */}
            <line
              x1={xMain} y1={diagStartY}
              x2={xMain + diagDx - 9} y2={diagStartY + diagDx - 9}
              stroke={cyan} strokeOpacity="0.32" strokeWidth="0.8"
            />
            {/* ── 折角终点水平延伸（向 axis 右侧，连接刻度尺底部） ── */}
            <line
              x1={xMain + diagDx} y1={diagStartY + diagDx}
              x2={W - 2} y2={diagStartY + diagDx}
              stroke={cyan} strokeOpacity="0.45" strokeWidth="1"
            />

            {/* ── HUD 刻度尺主竖线（亮 + 微 glow） ── */}
            <line x1={xTickRail} y1={6} x2={xTickRail} y2={diagStartY - 6}
              stroke={cyan} strokeOpacity="0.8" strokeWidth="1"
              style={{ filter: `drop-shadow(0 0 1.5px ${cyan}66)` }} />
            {/* ── 内侧重影（offset=-3 朝 axis 中心方向） ── */}
            <line x1={xTickRail - 3} y1={16} x2={xTickRail - 3} y2={diagStartY - 16}
              stroke={cyan} strokeOpacity="0.26" strokeWidth="0.7" />
            {/* ── 外侧重影（offset=+1.8，紧贴主线右侧，制造"主+重影"双轨幻象） ── */}
            <line x1={xTickRail + 1.8} y1={10} x2={xTickRail + 1.8} y2={diagStartY - 10}
              stroke={cyan} strokeOpacity="0.42" strokeWidth="0.6" />
            {/* ── 远侧 ghost 重影（offset=+4，更淡更短，渐远消散感） ── */}
            <line x1={xTickRail + 4} y1={22} x2={xTickRail + 4} y2={diagStartY - 22}
              stroke={cyan} strokeOpacity="0.18" strokeWidth="0.5" />

            {ticks.map((t, i) => {
              if (t.y > diagStartY - 8) return null
              if (t.major) {
                return (
                  <g key={i} style={{ filter: `drop-shadow(0 0 2.5px ${cyan}aa)` }}>
                    {/* 主刻度（亮，stroke 1.3） */}
                    <line x1={xTickRail - majorLen} y1={t.y} x2={xTickRail} y2={t.y}
                      stroke={cyan} strokeOpacity="0.95" strokeWidth="1.3" />
                    {/* 内层 companion 平行线（offset y+2，半长，cyan 中调） */}
                    <line x1={xTickRail - majorLen + 2.5} y1={t.y + 2} x2={xTickRail - 1} y2={t.y + 2}
                      stroke={cyan} strokeOpacity="0.5" strokeWidth="0.75" />
                    {/* 左端方块 cap（2.5×3.6 粗胖锚点） */}
                    <rect x={xTickRail - majorLen - capW} y={t.y - capH / 2}
                      width={capW} height={capH} fill={cyan} opacity="0.98" />
                    {/* 右端 rail 接合"焊点"（HUD 节点语言，跨主线 + 外侧重影） */}
                    <circle cx={xTickRail} cy={t.y} r="1.8" fill={cyan} opacity="1" />
                  </g>
                )
              }
              return (
                /* minor 5min 刻度：长 4 / opacity 0.5（常规风格，不弱化） */
                <line key={i} x1={xTickRail - 4} y1={t.y} x2={xTickRail} y2={t.y}
                  stroke={cyan} strokeOpacity="0.5" strokeWidth="0.85" />
              )
            })}

          </svg>
        )
      })()}

      {/* TIME AXIS 竖排文字（穿过 frame 主线 xMain 位置，frame 在此处被遮罩断开） */}
      {h > 0 && (
        <div style={{
          position: 'absolute',
          top: h * 0.22, left: xMain + 5,
          transform: 'translate(-50%, -50%) rotate(-90deg)',
          transformOrigin: 'center',
          whiteSpace: 'nowrap',
          fontFamily: `'Orbitron', 'Rajdhani', ${theme.fontMono}`,
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: 4.4,
          color: cyan,
          WebkitTextStroke: `0.15px ${cyan}`,
          opacity: 0.86,
          textShadow: `0 0 4px ${cyan}88, 0 0 8px ${cyan}33`,
          pointerEvents: 'none',
        }}>
          TIME AXIS
        </div>
      )}

      {/* 数字：每个刻度都标，所有数字右缘对齐 xNum；major 强、minor 弱形成层次 */}
      {h > 0 && ticks.map((t) => {
        if (t.y > h - 80 - 8) return null
        return (
          <span
            key={t.minute}
            style={{
              position: 'absolute',
              top: t.y, left: xNum,
              transform: 'translate(-100%, -50%)',
              fontFamily: theme.fontMono,
              fontSize: t.major ? 10.5 : 8.5,
              fontWeight: t.major ? 700 : 600,
              color: cyan,
              opacity: t.major ? 1 : 0.55,
              letterSpacing: t.major ? 0.4 : 0.2,
              whiteSpace: 'nowrap',
              textShadow: t.major
                ? `0 0 4px ${cyan}, 0 0 8px ${cyan}55`
                : `0 0 2px ${cyan}66`,
              ...(t.major ? { WebkitTextStroke: `0.12px ${cyan}` } : null),
            }}
          >
            {String(t.minute).padStart(2, '0')}
          </span>
        )
      })}

      {/* DATA STREAM 标签（左下角，折角内 frame 区域） */}
      <span style={{
        position: 'absolute',
        bottom: 14, left: xMain + 11,
        fontFamily: `'Orbitron', 'Rajdhani', ${theme.fontMono}`,
        fontSize: 7.8,
        fontWeight: 700,
        color: cyan,
        WebkitTextStroke: `0.15px ${cyan}`,
        letterSpacing: 1.5,
        opacity: 0.86,
        whiteSpace: 'nowrap',
        lineHeight: 1.15,
        textShadow: `0 0 4px ${cyan}88, 0 0 8px ${cyan}33`,
      }}>
        DATA<br />STREAM
      </span>
    </div>
  )
}

// ── 时段中文标签滚动层（CSS sticky，跟 wrapper 内容横向 native 同步） ──

function ScrollingZoneLabels({ params }: { params: ReturnType<typeof getGridParams> }) {
  const zoneDefs: [number, number][] = [[0,6],[6,12],[12,18],[18,20],[20,24]]
  return (
    // sticky 容器 height:0：不占 wrapper 流式空间（避免纵向滚动条），子内容 absolute 浮出
    <div style={{
      position: 'sticky', top: 0,
      width: params.totalW, height: 0,
      zIndex: 3,
      pointerEvents: 'none',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0,
        width: params.totalW, height: 28,
        pointerEvents: 'none',
      }}>
        {zoneDefs.map(([startH, endH]) => {
          const z = getZoneInfo(startH)
          const [zr, zg, zb] = z.bgColor
          const [br, bg, bb] = ensureHatchBright(zr, zg, zb, 140)
          const firstCol = Math.floor(startH * 60 / params.minutesPerCol)
          const lastCol = Math.floor(endH * 60 / params.minutesPerCol) - 1
          if (firstCol >= params.cols) return null
          const x0 = colX(firstCol, params)
          const x1 = colX(Math.min(lastCol, params.cols - 1), params) + params.cellW
          const cx = (x0 + x1) / 2
          const fillColor = `rgba(${br},${bg},${bb},0.92)`

          return (
            <span
              key={startH}
              style={{
                position: 'absolute',
                top: '50%', left: cx,
                transform: 'translate(-50%, -50%)',
                fontFamily: `'DengXian', '等线', 'Microsoft YaHei', 'PingFang SC', sans-serif`,
                fontSize: 14,
                fontWeight: 600,
                letterSpacing: 1.5,
                whiteSpace: 'nowrap',
                color: fillColor,
              }}
            >
              {z.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ── 主组件 ──

export default function DayNightChart({ activityBlocks, plannedBlocks, planNodes, activityPalette, recordLayer, onRecordLayerChange, editMode, selectedTagId, selectedPlanNodeId, onEditModeToggle, canUndo = false, canRedo = false, onUndo, onRedo, onApplyDrag, perceptionSpans: rawPerceptionSpans = [], biliSpans = [], selectedDate, onSpanClick, onSpanHover, onAppSpanHover, onBiliSpanHover, trackMode = 'apps', onTrackModeChange, pinnedPos, onPinPos }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const hoveredSpanIdRef = useRef<number | null>(null)
  const hoveredCellRef = useRef<{ col: number; row: number } | null>(null)
  const rafRef = useRef<number>(0)
  // 十字准线位置
  const mouseYRef = useRef<number | null>(null)
  const hoveredColRef = useRef<number | null>(null)
  // 固定/取消固定标签的画布命中区域
  const pinBadgeRef = useRef<{ x: number; y: number; w: number; h: number; pin: { col: number; y: number; minute: number } } | null>(null)
  // 悬浮的 tag span（用于右侧栏面板）
  const hoveredTagSpanRef = useRef<PerceptionSpan | null>(null)
  // 悬浮的 app span（用于右侧栏面板）
  const hoveredAppSpanRef = useRef<PerceptionSpan | null>(null)
  // 鼠标当前所在的整分钟（== 一张截图的精度），仅在 apps 轨上 hover 时维护
  const hoveredAppMinuteRef = useRef<number | null>(null)
  // 图标缓存（group_name → img | null | 'loading'）
  const iconCacheRef = useRef<Map<string, HTMLImageElement | null | 'loading'>>(new Map())
  // 指向最新 scheduleRedraw（用于图标加载后触发重绘）
  const redrawRef = useRef<(() => void) | null>(null)
  // 拖拽框选

  const dpr = window.devicePixelRatio || 1

  // 悬浮的 bili span
  const hoveredBiliSpanRef = useRef<BiliSpan | null>(null)

  // ── 响应式纵向：监听可用高度，等比缩放 cellH + cellW ──
  // 横向保持固定宽度（overflow-x scroll），不响应容器宽度变化
  const [chartAreaH, setChartAreaH] = useState(0)
  // 缩放时保留视图中心对应的时间比例，缩放后恢复到原位
  const pRef = useRef<ReturnType<typeof getGridParams>>(getGridParams(12, 80))
  const scrollRatioRef = useRef<number | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      // 记录当前视口中心对应的 totalW 比例
      if (pRef.current.totalW > 0) {
        const centerX = el.scrollLeft + el.clientWidth / 2
        scrollRatioRef.current = centerX / pRef.current.totalW
      }
      setChartAreaH(entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const p = useMemo(() => {
    if (chartAreaH <= 0) {
      // 初始化前用默认值（不会渲染）
      return getGridParams(12, 80)
    }
    const { rowsPerCol, cellH, cellW } = chooseModeByHeight(chartAreaH)
    return getGridParams(rowsPerCol, cellW, cellH)
  }, [chartAreaH])

  // 同步 pRef
  useEffect(() => { pRef.current = p }, [p])

  // p.totalW 变化后恢复滚动位置（保持视口中心时间不变）
  useEffect(() => {
    const el = containerRef.current
    if (!el || scrollRatioRef.current === null) return
    const ratio = scrollRatioRef.current
    scrollRatioRef.current = null
    requestAnimationFrame(() => {
      el.scrollLeft = ratio * p.totalW - el.clientWidth / 2
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.totalW])

  // 选中日期的 YYYY-MM-DD 字符串（用于裁剪跨天 span）
  const selectedDateStr = useMemo(() => {
    const y = selectedDate.getFullYear()
    const m = String(selectedDate.getMonth() + 1).padStart(2, '0')
    const d = String(selectedDate.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }, [selectedDate])

  const selectedBrushId = recordLayer === 'actual' ? selectedTagId : selectedPlanNodeId
  const tagById = useMemo(() => new Map(activityPalette.tags.map((t) => [t.id, t])), [activityPalette.tags])
  const catById = useMemo(() => new Map(activityPalette.categories.map((c) => [c.id, c])), [activityPalette.categories])
  const planNodeById = useMemo(() => new Map(planNodes.map((n) => [n.id, n])), [planNodes])
  const planTitleById = useMemo(() => {
    const cache = new Map<number, string>()
    const build = (node: PlanNode): string => {
      const cached = cache.get(node.id)
      if (cached) return cached
      const parent = node.parentId != null ? planNodeById.get(node.parentId) : null
      const title = parent ? `${build(parent)},${node.title}` : node.title
      cache.set(node.id, title)
      return title
    }
    for (const node of planNodes) build(node)
    return cache
  }, [planNodes, planNodeById])

  const visibleBlocks = useMemo(() => {
    if (recordLayer === 'actual') {
      return activityBlocks.map((b) => ({ minute: b.minute, tagId: b.tagId }))
    }
    return plannedBlocks.map((b) => ({ minute: b.minute, tagId: b.planNodeId }))
  }, [recordLayer, activityBlocks, plannedBlocks])

  // ── 活动记录块 → 合并连续同 tag 的虚拟 PerceptionSpan（track='tags'），喂给现有渲染 ──
  const blockSpans = useMemo<PerceptionSpan[]>(() => {
    if (visibleBlocks.length === 0) return []
    const tagById = new Map(activityPalette.tags.map((t) => [t.id, t]))
    const catById = new Map(activityPalette.categories.map((c) => [c.id, c]))
    const sorted = [...visibleBlocks].sort((a, b) => a.minute - b.minute)
    const fmt = (min: number) => {
      const h = Math.floor(min / 60)
      const m = min % 60
      return `${selectedDateStr} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
    }
    const out: PerceptionSpan[] = []
    let cur: { tagId: number; startMin: number; endMin: number } | null = null
    for (const b of sorted) {
      if (cur && cur.tagId === b.tagId && cur.endMin === b.minute) {
        cur.endMin = b.minute + 5
      } else {
        if (cur) {
          const tag = tagById.get(cur.tagId)
          const cat = tag ? catById.get(tag.categoryId) : null
          out.push({
            id: -(out.length + 1) * 1000 - cur.tagId, // 负 id 防止与 perceptionSpans 真实 id 冲突
            track: 'tags',
            start_at: fmt(cur.startMin),
            end_at: fmt(cur.endMin),
            title: tag?.fullPath ?? '',
            group_name: cat?.name ?? null,
            color: cat?.color ?? '#4488ff',
          })
        }
        cur = { tagId: b.tagId, startMin: b.minute, endMin: b.minute + 5 }
      }
    }
    if (cur) {
      const tag = tagById.get(cur.tagId)
      const cat = tag ? catById.get(tag.categoryId) : null
      out.push({
        id: -(out.length + 1) * 1000 - cur.tagId,
        track: 'tags',
        start_at: fmt(cur.startMin),
        end_at: fmt(cur.endMin),
        title: tag?.fullPath ?? '',
        group_name: cat?.name ?? null,
        color: cat?.color ?? '#4488ff',
      })
    }
    return out
  }, [visibleBlocks, activityPalette, selectedDateStr])

  const planBlockSpans = useMemo<PerceptionSpan[]>(() => {
    if (plannedBlocks.length === 0) return []
    const sorted = [...plannedBlocks].sort((a, b) => a.minute - b.minute)
    const fmt = (min: number) => {
      const h = Math.floor(min / 60)
      const m = min % 60
      return `${selectedDateStr} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
    }
    const out: PerceptionSpan[] = []
    let cur: { nodeId: number; startMin: number; endMin: number } | null = null
    const push = (group: { nodeId: number; startMin: number; endMin: number }) => {
      const node = planNodeById.get(group.nodeId)
      const tag = node ? tagById.get(node.projectTagId) : undefined
      const cat = tag ? catById.get(tag.categoryId) : undefined
      out.push({
        id: -(out.length + 1) * 1000 - group.nodeId,
        track: 'tags',
        start_at: fmt(group.startMin),
        end_at: fmt(group.endMin),
        title: node ? `${tag?.fullPath ?? '计划'},${planTitleById.get(node.id) ?? node.title}` : '计划',
        group_name: cat?.name ?? null,
        color: cat?.color ?? theme.warningOrange,
      })
    }
    for (const block of sorted) {
      if (cur && cur.nodeId === block.planNodeId && cur.endMin === block.minute) {
        cur.endMin = block.minute + 5
      } else {
        if (cur) push(cur)
        cur = { nodeId: block.planNodeId, startMin: block.minute, endMin: block.minute + 5 }
      }
    }
    if (cur) push(cur)
    return out
  }, [plannedBlocks, planNodeById, tagById, catById, planTitleById, selectedDateStr])

  // 合并：自研活动块（tags 轨）+ perception spans
  const perceptionSpans = useMemo<PerceptionSpan[]>(() => [
    ...(recordLayer === 'plan' ? planBlockSpans : blockSpans),
    ...rawPerceptionSpans,
  ], [recordLayer, blockSpans, planBlockSpans, rawPerceptionSpans])


  // Bili span 时间重叠修正 + 跨天裁剪：
  // 一段 23:30 → 次日 00:30 的 span 在"前一天"被裁成 23:30→24:00，
  // 在"次日"被裁成 00:00→00:30，两边都能正常渲染
  const adjustedBiliSpans = useMemo((): BiliSpan[] => {
    if (!biliSpans.length) return biliSpans

    // 1) 先把每个 span 裁到 selectedDate 的范围内
    const clamped: BiliSpan[] = []
    for (const span of biliSpans) {
      const startDate = span.start_at.split(' ')[0] ?? ''
      const endDate   = span.end_at.split(' ')[0]   ?? ''
      const startsBefore = startDate < selectedDateStr
      const endsAfter    = endDate   > selectedDateStr

      // 完全在选中日期之外的 span 跳过（理论上 SQL 已过滤，前端兜底）
      if (endDate < selectedDateStr || startDate > selectedDateStr) continue

      const newStart = startsBefore ? `${selectedDateStr} 00:00:00` : span.start_at
      const newEnd   = endsAfter    ? `${selectedDateStr} 23:59:59` : span.end_at
      clamped.push({ ...span, start_at: newStart, end_at: newEnd })
    }

    // 2) end_at 是精准的（B站 view_at），start_at 是合成的（view_at - progress|duration）；
    //    悬浮检测分辨率是整数分钟，所以这里把 span 吸附到整数分钟边界：
    //      - end 用 ceil（真实 end 在哪个整分钟内就吃掉这一分钟）
    //      - start 至少比 end 早 1 分钟，且不越过前一段的 end
    //      - 多段 end 落在同一分钟内时，后面顺延一分钟，避免彻底重叠
    const fmt = (datePart: string, mins: number): string => {
      const h  = Math.floor(mins / 60)
      const mm = mins % 60
      return `${datePart} ${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`
    }

    const sorted = clamped.sort((a, b) => dtToMinute(a.end_at) - dtToMinute(b.end_at))
    const result: BiliSpan[] = []
    let prevEndInt = -Infinity
    for (const span of sorted) {
      const startMin = dtToMinute(span.start_at)
      const endMin   = dtToMinute(span.end_at)
      let endInt   = Math.ceil(endMin)
      if (endInt <= prevEndInt) endInt = prevEndInt + 1
      let startInt = Math.max(prevEndInt, Math.floor(startMin))
      if (endInt - startInt < 1) startInt = endInt - 1
      if (startInt < prevEndInt) startInt = prevEndInt
      const datePart = span.start_at.split(' ')[0] ?? ''
      result.push({
        ...span,
        start_at: fmt(datePart, startInt),
        end_at:   fmt(datePart, endInt),
      })
      prevEndInt = endInt
    }
    return result
  }, [biliSpans, selectedDateStr])

  const isToday = (() => {
    const now = new Date()
    return selectedDate.toDateString() === now.toDateString()
  })()

  // 绘制
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const hoveredSpanId = hoveredSpanIdRef.current

    ctx.clearRect(0, 0, p.totalW * dpr, p.totalH * dpr)

    // HiDPI 缩放
    ctx.save()
    ctx.scale(dpr, dpr)

    // 背景
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, p.totalW, p.totalH)

    drawZoneBands(ctx, p)
    drawTagFills(ctx, p, perceptionSpans, hoveredSpanId, recordLayer)
    drawGrid(ctx, p)
    drawTimeLabels(ctx, p)

    // ── 十字准线 ──
    const _mouseY = mouseYRef.current
    const _hovCol = hoveredColRef.current

    // 图标按需加载（加载完成后触发重绘）
    const getIcon = (name: string): HTMLImageElement | null => {
      const cache = iconCacheRef.current
      const hit   = cache.get(name)
      if (hit === 'loading') return null
      if (hit !== undefined) return hit as HTMLImageElement | null
      cache.set(name, 'loading')
      const img = new Image()
      img.onload  = () => { cache.set(name, img); redrawRef.current?.() }
      img.onerror = () => { cache.set(name, null) }
      img.src = `http://localhost:49733/api/perception/app-icon?name=${encodeURIComponent(name)}`
      return null
    }

    // 当前高亮 app/status span（固定或悬浮），用于管内图标隐藏
    let highlightedAppSpanId: number | null = null
    if (trackMode === 'apps') {
      const targetTrack = 'apps'
      if (pinnedPos != null) {
        const pinnedMin = pinnedPos.minute
        const pinnedSpan = perceptionSpans.find(s => s.track === targetTrack && pinnedMin >= dtToMinute(s.start_at) && pinnedMin < dtToMinute(s.end_at))
        highlightedAppSpanId = pinnedSpan?.id ?? null
      } else {
        highlightedAppSpanId = hoveredAppSpanRef.current?.id ?? null
      }
    }

    if (trackMode === 'apps') {
      drawAppTraces(ctx, p, perceptionSpans, highlightedAppSpanId)
      drawAfkOverlay(ctx, p, perceptionSpans)
    } else {
      drawBiliTracesInPipe(ctx, p, adjustedBiliSpans)
    }
    drawTagTitles(ctx, p, perceptionSpans)

    // 拖刷预览（覆盖在 tag 填充之上）
    const drag = dragRef.current
    if (drag) {
      drawDragPreview(ctx, p, drag.startMin, drag.currentMin, drag.color, drag.tagId, drag.initial)
    }

    drawNowTick(ctx, p, isToday)

    if (pinnedPos != null) {
      const badge = drawCrosshair(ctx, p, pinnedPos.col, pinnedPos.y, perceptionSpans, true, getIcon, trackMode, adjustedBiliSpans)
      pinBadgeRef.current = badge
      if (_mouseY !== null && _hovCol !== null && _hovCol !== pinnedPos.col) {
        drawCrosshair(ctx, p, _hovCol, _mouseY, perceptionSpans, false, getIcon, trackMode, adjustedBiliSpans)
      }
    } else {
      if (_mouseY !== null && _hovCol !== null) {
        pinBadgeRef.current = drawCrosshair(ctx, p, _hovCol, _mouseY, perceptionSpans, false, getIcon, trackMode, adjustedBiliSpans)
      } else {
        pinBadgeRef.current = null
      }
    }

    ctx.restore()
  }, [p, perceptionSpans, adjustedBiliSpans, trackMode, recordLayer, isToday, dpr, pinnedPos]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    draw()
    // 今天每分钟刷新一次扫描线
    if (!isToday) return
    const id = setInterval(draw, 60_000)
    return () => {
      clearInterval(id)
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0   // 重置，防止守卫阻塞后续 scheduleRedraw
      }
    }
  }, [draw, isToday])

  // 鼠标事件（用 rAF 节流，避免每像素都重绘）
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
  }, [draw])
  redrawRef.current = scheduleRedraw

  // 检测鼠标是否在活动边缘（±6px）→ 返回 edge 信息
  // 将鼠标事件坐标转换为分钟（跨列支持，snap to 5 min）

  function getHitAt(e: React.MouseEvent<HTMLCanvasElement>): { minute: number; snappedEnd: number; hitSpan: PerceptionSpan | undefined } | null {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = xToCol(x, p)
    const rBlock = Math.floor((y - p.topPad) / p.rowStride)
    if (c < 0 || c >= p.cols || rBlock < 0 || rBlock >= p.rows) return null
    const localY = y - p.topPad - rBlock * p.rowStride
    const extraMin = Math.min(Math.floor(localY / p.minuteH), 4)
    const m = c * p.minutesPerCol + rBlock * 5 + extraMin
    const snapped = Math.floor(m / 5) * 5
    const snappedEnd = Math.ceil((m + 1) / 5) * 5
    const hitSpan = perceptionSpans.find((s) => s.track === 'tags' && m >= dtToMinute(s.start_at) && m < dtToMinute(s.end_at))
    return { minute: snapped, snappedEnd, hitSpan }
  }

  /** 编辑模式：把鼠标坐标 snap 到 5min 块的起始分钟 */
  function eventToBlockMinute(e: React.MouseEvent<HTMLCanvasElement> | MouseEvent): number | null {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = xToCol(x, p)
    const rBlock = Math.floor((y - p.topPad) / p.rowStride)
    if (c < 0 || c >= p.cols || rBlock < 0 || rBlock >= p.rows) return null
    return c * p.minutesPerCol + rBlock * 5
  }

  function spanFromMinuteFloat(m: number): PerceptionSpan | undefined {
    return perceptionSpans.find((s) => s.track === 'tags' && m >= dtToMinute(s.start_at) && m < dtToMinute(s.end_at))
  }

  // ── 编辑模式：拖刷状态 ──
  // 时间范围语义：[start, current] 之间所有 5min 块（跨列时对应"先填满起列下半 + 中间整列 + 末列上半"）
  // 三态语义（按起始快照逐格判定）：
  //   空格            → 用当前画笔涂
  //   已是当前画笔色 → 擦（同色覆盖 = 取消）
  //   是其它色       → 用当前画笔替换（覆盖原标签）
  const dragRef = useRef<{
    tagId: number | null
    color: string
    /** mousedown 时所在的层 —— commit 时如果当前 layer 已变，丢弃避免写到错层 */
    layer: RecordLayer
    startMin: number
    currentMin: number
    /** 拖拽起点时刻该日的 minute → tagId 快照（用于逐格判定取反） */
    initial: Map<number, number>
  } | null>(null)
  const blockByMinute = useMemo(() => {
    const m = new Map<number, number>()
    for (const b of visibleBlocks) m.set(b.minute, b.tagId)
    return m
  }, [visibleBlocks])

  useEffect(() => {
    dragRef.current = null
    hoveredSpanIdRef.current = null
    hoveredTagSpanRef.current = null
    onSpanHover?.(null)
    scheduleRedraw()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordLayer])

  /** 起点终点的 5min 块全集（含两端）。endMin < startMin 时反向 */
  const getDragMinutes = (startMin: number, endMin: number): number[] => {
    const lo = Math.min(startMin, endMin)
    const hi = Math.max(startMin, endMin)
    const out: number[] = []
    for (let m = lo; m <= hi; m += 5) out.push(m)
    return out
  }

  /** 查 selectedTagId 对应的颜色（找不到走默认绿） */
  const brushColorRef = useRef('#22C55E')
  const brushColor = useMemo(() => {
    if (selectedBrushId == null) return recordLayer === 'plan' ? theme.warningOrange : theme.expGreen
    const node = recordLayer === 'plan' ? planNodeById.get(selectedBrushId) : null
    const tagId = node ? node.projectTagId : selectedBrushId
    const tag = tagById.get(tagId)
    if (!tag) return recordLayer === 'plan' ? theme.warningOrange : theme.expGreen
    const cat = catById.get(tag.categoryId)
    return cat?.color ?? (recordLayer === 'plan' ? theme.warningOrange : theme.expGreen)
  }, [selectedBrushId, recordLayer, planNodeById, tagById, catById])
  brushColorRef.current = brushColor

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    if (!editMode) return
    const min = eventToBlockMinute(e)
    if (min == null) return
    // 起点是空格且没有画笔 → 干脆不开始（避免无意义的空拖拽）
    const startEmpty = !blockByMinute.has(min)
    if (startEmpty && selectedBrushId == null) return
    dragRef.current = {
      tagId: selectedBrushId,
      color: brushColorRef.current,
      layer: recordLayer,
      startMin: min,
      currentMin: min,
      initial: new Map(blockByMinute),  // 浅拷贝固定快照
    }
    scheduleRedraw()
  }

  function commitDragOrCancel() {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    // 双保险：理论上切换 layer 时 useEffect 会清 dragRef，这里再校验一次
    // 防止任何边角时序窗口把变更写到错的层
    if (drag.layer !== recordLayer) return
    const minutes = getDragMinutes(drag.startMin, drag.currentMin)
    if (minutes.length === 0) return

    const paintMinutes: number[] = []
    const eraseMinutes: number[] = []
    for (const m of minutes) {
      const existing = drag.initial.get(m)
      if (existing === undefined) {
        // 空格 → 涂（需有画笔）
        if (drag.tagId != null) paintMinutes.push(m)
      } else if (existing === drag.tagId) {
        // 同画笔 → 擦
        eraseMinutes.push(m)
      } else if (drag.tagId != null) {
        // 异色 + 有画笔 → 替换（paint 后端 UPSERT，覆盖原 tag_id）
        paintMinutes.push(m)
      } else {
        // 异色 + 无画笔 → 退化为擦（保留"无画笔清除"便捷功能）
        eraseMinutes.push(m)
      }
    }

    if (paintMinutes.length === 0 && eraseMinutes.length === 0) return

    onApplyDrag({
      paintMinutes,
      paintTagId: drag.tagId,
      eraseMinutes,
      layer: drag.layer,
      rangeStartMin: Math.min(drag.startMin, drag.currentMin),
      rangeEndMin: Math.max(drag.startMin, drag.currentMin) + 5,
    })
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = xToCol(x, p)
    const rBlock = Math.floor((y - p.topPad) / p.rowStride)

    // 编辑模式 + 正在拖刷：更新 currentMin（时间范围语义，跨列正确收尾）
    if (editMode && dragRef.current) {
      const min = eventToBlockMinute(e)
      if (min != null && min !== dragRef.current.currentMin) {
        dragRef.current.currentMin = min
        scheduleRedraw()
      }
      // 拖拽过程中也更新右栏 app hover（让用户参考当前位置的截图/应用）
      if (trackMode === 'apps' && c >= 0 && c < p.cols && rBlock >= 0 && rBlock < p.rows) {
        const localY = y - p.topPad - rBlock * p.rowStride
        const minuteFracInRow = Math.max(0, Math.min(5, localY / p.minuteH))
        const mFloat = c * p.minutesPerCol + rBlock * 5 + minuteFracInRow
        const appSpan = perceptionSpans.find(
          (s) => s.track === 'apps' && mFloat >= dtToMinute(s.start_at) && mFloat < dtToMinute(s.end_at)
        ) ?? null
        const curMin = appSpan ? Math.floor(mFloat) : null
        if (appSpan !== hoveredAppSpanRef.current || curMin !== hoveredAppMinuteRef.current) {
          hoveredAppSpanRef.current = appSpan
          hoveredAppMinuteRef.current = curMin
          onAppSpanHover?.(appSpan, curMin)
        }
      }
      canvasRef.current!.style.cursor = 'pointer'
      return
    }

    // 命中当前 badge 区域：保持准星/badge 锁在原悬停位，不更新 hover 列和 Y
    // （否则 badge 位于列外侧会让 hoveredColRef 跳到下一列，点击时锁定错列）
    const badge = pinBadgeRef.current
    if (badge && x >= badge.x && x <= badge.x + badge.w && y >= badge.y && y <= badge.y + badge.h) {
      canvasRef.current!.style.cursor = 'pointer'
      return
    }

    if (c >= 0 && c < p.cols && rBlock >= 0 && rBlock < p.rows) {
      hoveredCellRef.current = { col: c, row: rBlock }
      hoveredColRef.current = c

      if (pinnedPos != null) {
        // ── 固定模式：用实际鼠标 Y（用于其他列暗提示线），不更新 hover span ──
        mouseYRef.current = y
        canvasRef.current!.style.cursor = 'pointer'
      } else {
        // ── 普通 hover ──
        // 精确到秒级：localY / minuteH 不取整，直接得到带小数的分钟数
        const localY = y - p.topPad - rBlock * p.rowStride
        const minuteFracInRow = Math.max(0, Math.min(5, localY / p.minuteH))
        const mFloat = c * p.minutesPerCol + rBlock * 5 + minuteFracInRow
        const hitSpan = spanFromMinuteFloat(mFloat)
        hoveredSpanIdRef.current = hitSpan?.id ?? null
        canvasRef.current!.style.cursor = 'pointer'

        mouseYRef.current = y

        // 检测 tag span hover
        if (hitSpan !== hoveredTagSpanRef.current) {
          hoveredTagSpanRef.current = hitSpan ?? null
          onSpanHover?.(hitSpan ?? null)
        }

        // 检测管线 span hover（按 trackMode 切换）— 用浮点分钟，秒级精度
        if (trackMode === 'apps') {
          const appSpan = perceptionSpans.find(
            (s) => s.track === 'apps' && mFloat >= dtToMinute(s.start_at) && mFloat < dtToMinute(s.end_at)
          ) ?? null
          const spanChanged = appSpan !== hoveredAppSpanRef.current
          const lastMin = hoveredAppMinuteRef.current
          const curMin = appSpan ? Math.floor(mFloat) : null
          const minChanged = curMin !== lastMin
          if (spanChanged || minChanged) {
            hoveredAppSpanRef.current = appSpan
            hoveredAppMinuteRef.current = curMin
            onAppSpanHover?.(appSpan, curMin)
          }
          if (hoveredBiliSpanRef.current !== null) {
            hoveredBiliSpanRef.current = null
            onBiliSpanHover?.(null)
          }
        } else {
          const bSpan = adjustedBiliSpans.find(
            (s) => mFloat >= dtToMinute(s.start_at) && mFloat < dtToMinute(s.end_at)
          ) ?? null
          if (bSpan !== hoveredBiliSpanRef.current) {
            hoveredBiliSpanRef.current = bSpan
            onBiliSpanHover?.(bSpan)
          }
          if (hoveredAppSpanRef.current !== null) {
            hoveredAppSpanRef.current = null
            hoveredAppMinuteRef.current = null
            onAppSpanHover?.(null, null)
          }
        }
      }
    } else {
      hoveredCellRef.current = null
      hoveredSpanIdRef.current = null
      hoveredColRef.current = null

      if (pinnedPos != null) {
        // 固定模式离开网格区：清 mouseYRef（固定线由 pinnedPos.y 驱动，不需要 mouseYRef）
        mouseYRef.current = null
        canvasRef.current!.style.cursor = 'pointer'
      } else {
        mouseYRef.current = null
        if (hoveredTagSpanRef.current !== null) {
          hoveredTagSpanRef.current = null
          onSpanHover?.(null)
        }
        if (hoveredAppSpanRef.current !== null) {
          hoveredAppSpanRef.current = null
          hoveredAppMinuteRef.current = null
          onAppSpanHover?.(null, null)
        }
        canvasRef.current!.style.cursor = 'pointer'
      }
    }
    scheduleRedraw()
  }

  function handleMouseUp(_e: React.MouseEvent<HTMLCanvasElement>) {
    if (editMode && dragRef.current) {
      commitDragOrCancel()
    }
    scheduleRedraw()
  }

  function handleMouseLeave() {
    if (editMode && dragRef.current) {
      // 离开画布时也提交（避免拖到外面才松开 → 没记到的尾段丢掉）
      commitDragOrCancel()
    }
    hoveredCellRef.current = null
    hoveredIdRef.current = null
    hoveredColRef.current = null
    if (pinnedPos == null) {
      // 未固定时，离开画布清除横线和 hover span
      mouseYRef.current = null
      if (hoveredTagSpanRef.current !== null) {
        hoveredTagSpanRef.current = null
        onSpanHover?.(null)
      }
      if (hoveredAppSpanRef.current !== null) {
        hoveredAppSpanRef.current = null
        hoveredAppMinuteRef.current = null
        onAppSpanHover?.(null, null)
      }
      if (hoveredBiliSpanRef.current !== null) {
        hoveredBiliSpanRef.current = null
        onBiliSpanHover?.(null)
      }
    } else {
      // 固定模式：清 mouseYRef（固定线由 pinnedPos.y 驱动），span 不清（右侧栏由 pinnedPos.minute 驱动）
      mouseYRef.current = null
    }
    if (canvasRef.current) canvasRef.current.style.cursor = 'pointer'
    scheduleRedraw()
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    // 编辑模式下点击 = 拖刷的"单格"情况，由 mouseDown+mouseUp 处理，这里不再 pin
    if (editMode) return

    const rect = canvasRef.current!.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top

    // 优先检测"锁定/解锁"标签：直接使用 drawCrosshair 绘制时保存的准星绝对位置
    const badge = pinBadgeRef.current
    if (badge && cx >= badge.x && cx <= badge.x + badge.w && cy >= badge.y && cy <= badge.y + badge.h) {
      if (pinnedPos != null) {
        onPinPos?.(null)
      } else {
        onPinPos?.(badge.pin)
      }
      return
    }

    // 点击单元格区域：用 xToCol 精确反算（考虑 hgGap + ZONE_GAP_EXTRA，
    // Math.floor((cx-hPad)/colStride) 会累积 gap 偏差导致溢出到下一列）
    const c2 = xToCol(cx, p)
    const rBlock2 = Math.floor((cy - p.topPad) / p.rowStride)
    if (c2 >= 0 && c2 < p.cols && rBlock2 >= 0 && rBlock2 < p.rows) {
      if (pinnedPos != null) {
        onPinPos?.(null)
      } else {
        const localY2 = cy - p.topPad - rBlock2 * p.rowStride
        const minuteFracInRow2 = Math.max(0, Math.min(5, localY2 / p.minuteH))
        const rawMinute = c2 * p.minutesPerCol + rBlock2 * 5 + minuteFracInRow2
        onPinPos?.({ col: c2, y: cy, minute: rawMinute })
      }
      return
    }

    const info = getHitAt(e)
    if (info?.hitSpan) onSpanClick?.(info.hitSpan)
  }

  function handleContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    // 旧的列首删除菜单已移除（chronos_activities 已弃用）
    e.preventDefault()
  }

  // 自动滚动到当前时间 / 最早活动
  // 只在日期切换时触发，不随活动增删重置位置
  const scrollKeyRef = useRef('')
  useEffect(() => {
    const key = `${selectedDate.toDateString()}:${recordLayer}`
    if (scrollKeyRef.current === key) return
    scrollKeyRef.current = key

    const container = containerRef.current
    if (!container) return
    let targetMin: number
    if (isToday) {
      const now = new Date()
      targetMin = now.getHours() * 60 + now.getMinutes()
    } else {
      // 非今天：滚到最早的活动块（如果有），否则 0 点
      const earliest = visibleBlocks.length > 0
        ? Math.min(...visibleBlocks.map((b) => b.minute))
        : 0
      targetMin = Math.max(0, earliest - p.minutesPerCol)
    }
    const targetCol = Math.max(0, Math.floor(targetMin / p.minutesPerCol) - 1)
    const scrollX = targetCol * p.colStride
    setTimeout(() => { container.scrollLeft = scrollX }, 100)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, recordLayer, isToday, p.minutesPerCol, p.colStride])

  // 图例：从感知 tags 提取一级标签，带每分类累计时长 + 子标签明细
  const tagLegend = useMemo(() => {
    const toMin = (dt: string) => {
      const t = dt.split(' ')[1] ?? ''
      const [h = 0, m = 0] = t.split(':').map(Number)
      return h * 60 + m
    }
    type Entry = { color: string; mins: number; subTagMap: Map<string, number> }
    const map = new Map<string, Entry>()
    ;(perceptionSpans ?? []).filter((s) => s.track === 'tags').forEach((s) => {
      const { parts } = parseTagTitle(s.title)
      const firstName = parts[0]
      if (!firstName) return
      const mins = Math.max(0, toMin(s.end_at) - toMin(s.start_at))
      const subName = parts.slice(1).join('/') || ''
      // 局部 Map 的 mutable 累加是安全的 — useMemo 内新建对象，无外部副作用
      let entry = map.get(firstName)
      if (!entry) { entry = { color: s.color ?? '#4488ff', mins: 0, subTagMap: new Map() }; map.set(firstName, entry) }
      entry.mins += mins
      if (subName) entry.subTagMap.set(subName, (entry.subTagMap.get(subName) ?? 0) + mins)
    })
    return [...map.entries()]
      .map(([name, v]) => ({
        name, color: v.color, mins: v.mins,
        subTags: [...v.subTagMap.entries()].map(([n, m]) => ({ name: n, mins: m })).sort((a, b) => b.mins - a.mins),
      }))
      .sort((a, b) => b.mins - a.mins)
  }, [perceptionSpans])

  const [legendOpen, setLegendOpen] = useState(false)
  const [expandedChip, setExpandedChip] = useState<string | null>(null)
  const [chipPos, setChipPos] = useState<{ x: number; bottom: number } | null>(null)

  const CHIP_PW = 240
  const handleChipClick = (name: string, e: React.MouseEvent<HTMLButtonElement>) => {
    if (expandedChip === name) {
      setExpandedChip(null)
      setChipPos(null)
    } else {
      const rect = e.currentTarget.getBoundingClientRect()
      const rawX = rect.left + rect.width / 2
      const clampedX = Math.max(CHIP_PW / 2 + 8, Math.min(rawX, window.innerWidth - CHIP_PW / 2 - 8))
      setExpandedChip(name)
      setChipPos({ x: clampedX, bottom: window.innerHeight - rect.top + 6 })
      setLegendOpen(false)
    }
  }

  const tagSpans = (perceptionSpans ?? []).filter((s) => s.track === 'tags')
  const totalTagMinutes = tagSpans.reduce((sum, s) => {
    const toMin = (dt: string) => {
      const t = dt.split(' ')[1] ?? ''
      const [h, m] = t.split(':').map(Number)
      return h * 60 + m
    }
    return sum + Math.max(0, toMin(s.end_at) - toMin(s.start_at))
  }, 0)

  const tabsHeight = 30

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        background: theme.background, position: 'relative',
        paddingLeft: 24,  // 左外边距：给 axis 溢出文本/装饰留空间（双层线 + TIME AXIS 文字）
        paddingRight: 24.5,  // 右外边距：给 ChartHeaderFrame 长竖线显示空间（= rightOffset + 0.5）
      }}
    >
      {/* 管线模式切换：tab 区紧贴顶部，tab 之间无 gap；tab 整体贴底,标签/按钮单独居中
          paddingRight: 24 给 ChartHeaderFrame 右侧装饰让出空间，避免按钮跟装饰挤在一起 */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 0,
        padding: '0 24px 0 12px',
        flexShrink: 0,
        height: tabsHeight,
      }}>
        {/* 面板标题（与 TaskScheduleBoard 顶部"任务调度"对称） */}
        <span style={{
          alignSelf: 'center',
          fontFamily: theme.fontBody,
          fontSize: 12,
          fontWeight: 600,
          color: theme.textPrimary,
          letterSpacing: 0.4,
          paddingLeft: 12,
          paddingRight: 10,
          marginRight: 4,
          marginTop: 6,
        }}>
          昼夜表
        </span>
        <span style={{
          alignSelf: 'center',
          fontFamily: theme.fontBody,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: 0.2,
          color: theme.textMuted,
          paddingRight: 6,
          marginRight: 2,
          marginTop: 6,
        }}>
          数据源
        </span>
        {(['apps', 'bili'] as const).map((mode) => {
          const active = trackMode === mode
          const label = mode === 'apps' ? getAppTrackLabel() : '哔哩哔哩'
          const color = mode === 'apps' ? theme.electricBlue : BILI_COLOR
          return (
            <HudTabButton
              key={mode}
              label={label}
              active={active}
              color={color}
              width={mode === 'apps' ? 96 : 82}
              height={24}
              onClick={() => onTrackModeChange?.(mode)}
            />
          )
        })}

        {/* "层 / 实际记录 / 计划安排" 已下放到 ChartHeaderButtons（右侧夹缝垂直图标按钮）
            编辑模式 + 撤回 + 恢复 也在 ChartHeaderButtons 里 */}
      </div>

      {/* 图表区：滚动 wrapper 占整片，sticky 时段层 + canvas；左半固定 axis 浮在上层 */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {/* 切角矩形 HUD frame，仅包裹 chart pane（不含 tabs / legend） */}
        <HudFrameSkeleton />

        {/* 4 角折角艺术装饰：双层折角 + 内 L 描线 + 端点小口 */}
        <CornerArt position="tl" />
        <CornerArt position="tr" />
        <CornerArt position="bl" />
        <CornerArt position="br" />

        {/* 左下大折角遮罩三角（80×80，覆盖 LeftAxis 大折角区域）*/}
        <div style={{
          position: 'absolute',
          left: 0, bottom: 0, width: 80, height: 80,
          background: theme.background,
          clipPath: 'polygon(0 0, 0 100%, 100% 100%)',
          WebkitClipPath: 'polygon(0 0, 0 100%, 100% 100%)',
          zIndex: 65,
          pointerEvents: 'none',
        }} />

        {/* 右上 frame 切角遮罩三角（18×18，frame cornerCut 范围）*/}
        <div style={{
          position: 'absolute',
          right: 0, top: 0, width: 18, height: 18,
          background: theme.background,
          clipPath: 'polygon(100% 0, 100% 100%, 0 0)',
          WebkitClipPath: 'polygon(100% 0, 100% 100%, 0 0)',
          zIndex: 65,
          pointerEvents: 'none',
        }} />

        {/* 右下 frame 切角遮罩三角（18×18，frame cornerCut 范围）*/}
        <div style={{
          position: 'absolute',
          right: 0, bottom: 0, width: 18, height: 18,
          background: theme.background,
          clipPath: 'polygon(0 100%, 100% 0, 100% 100%)',
          WebkitClipPath: 'polygon(0 100%, 100% 0, 100% 100%)',
          zIndex: 65,
          pointerEvents: 'none',
        }} />

        {/* 滚动 wrapper：覆盖 chart pane，sticky 时段层 + canvas 都跟随它滚 */}
        <div
          ref={containerRef}
          className="daynight-scroll"
          style={{
            position: 'absolute', top: 0, left: 48, right: 0, bottom: 0,
            overflowX: 'auto', overflowY: 'auto', cursor: 'pointer',
          }}
        >
          {/* sticky 时段中文标签层（CSS native 同步，跟 canvas 共享 scrollLeft） */}
          <ScrollingZoneLabels params={p} />

          <canvas
            ref={canvasRef}
            width={p.totalW * dpr}
            height={p.totalH * dpr}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            style={{ display: 'block', width: p.totalW, height: p.totalH, userSelect: 'none' }}
          />
        </div>

        {/* 左半固定 axis row：⊿ + 时间轴 + 当前阶段（zIndex 60，覆盖 sticky 内 0..100） */}
        <ChartTopAxisRow />

        {/* 左侧 TIME AXIS 区（双层竖线 + 顶/底折角 + 跟随 rowsPerCol 的 5 分钟刻度） */}
        <LeftAxis params={p} />

        {/* 顶部 HUD 装饰带：叠加在标题栏 tab 区上层，右端凸塔接 chart pane 右上切角 */}
        <ChartHeaderFrame mainHeight={tabsHeight} rightOffset={24} paddingRightFull={24.5} topOffsetLeft={24} topOffsetRight={24} slopeLen={14} rightSegLen={90} notchWidth={150} />

        {/* 嵌在双层 svg 夹缝中的三个按钮：① 记录 ② 撤回 ③ 恢复 */}
        <ChartHeaderButtons
          mainHeight={tabsHeight}
          rightOffset={24}
          paddingRightFull={24.5}
          topOffsetRight={24}
          slopeLen={14}
          rightSegLen={90}
          notchWidth={150}
          editMode={editMode}
          recordLayerColor={recordLayer === 'plan' ? theme.warningOrange : theme.expGreen}
          recordLayerLabel={recordLayer === 'plan' ? '计划安排' : '实际记录'}
          recordLayer={recordLayer}
          onRecordLayerChange={onRecordLayerChange}
          canUndo={canUndo}
          canRedo={canRedo}
          onToggleEdit={onEditModeToggle}
          onUndo={() => onUndo?.()}
          onRedo={() => onRedo?.()}
        />
      </div>

      {/* 底部：百分比条 + 横向分类胶囊 */}
      <div style={{
        padding: '7px 14px 8px',
        borderTop: `1px solid ${hexToRgba(theme.electricBlue, 0.12)}`,
        background: `linear-gradient(180deg, ${hexToRgba(theme.electricBlue, 0.03)} 0%, transparent 100%)`,
      }}>
        {tagLegend.length > 0 ? (
          <>
            {/* 百分比条：点击打开分类弹窗 */}
            <Tooltip
              content={`${Math.floor(totalTagMinutes / 60)}h ${totalTagMinutes % 60}m · 点击查看分类`}
              display="block"
            >
            <div
              role="button"
              tabIndex={0}
              onClick={() => { setLegendOpen((o) => !o); setExpandedChip(null); setChipPos(null) }}
              onKeyDown={(e) => e.key === 'Enter' && setLegendOpen((o) => !o)}
              style={{
                display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden',
                cursor: 'pointer', gap: 1, marginBottom: 7,
                background: hexToRgba(theme.electricBlue, 0.08),
              }}
            >
              {tagLegend.map((s) => (
                <div key={s.name} style={{
                  flex: s.mins, background: s.color,
                  filter: 'saturate(1.4) brightness(1.1)',
                }} />
              ))}
              {totalTagMinutes < 1440 && (
                <div style={{ flex: 1440 - totalTagMinutes, background: hexToRgba(theme.electricBlue, 0.04) }} />
              )}
            </div>
            </Tooltip>

            {/* 横向滑动分类胶囊，每个胶囊可单独点开子标签弹窗 */}
            <div style={{
              display: 'flex', gap: 5, overflowX: 'auto',
              scrollbarWidth: 'none', alignItems: 'center',
            } as CSSProperties}>
              {tagLegend.map((s) => {
                const h = Math.floor(s.mins / 60)
                const m = s.mins % 60
                const label = h > 0 ? `${h}h${m > 0 ? `${m}m` : ''}` : `${m}m`
                const active = expandedChip === s.name
                return (
                  <button
                    key={s.name}
                    onClick={(e) => handleChipClick(s.name, e)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '3px 8px 3px 6px', borderRadius: 10, flexShrink: 0,
                      background: active ? `${s.color}33` : `${s.color}1a`,
                      border: `1px solid ${active ? s.color : `${s.color}44`}`,
                      whiteSpace: 'nowrap', cursor: 'pointer',
                      boxShadow: active ? `0 0 8px ${s.color}66` : 'none',
                      transition: 'all 0.12s ease',
                    }}
                  >
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                      background: s.color, boxShadow: `0 0 5px ${s.color}aa`,
                      display: 'inline-block',
                    }} />
                    <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: theme.textSecondary }}>
                      {s.name}
                    </span>
                    <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: s.color, fontWeight: 700 }}>
                      {label}
                    </span>
                  </button>
                )
              })}
              {/* 段数 + 总时长徽章 */}
              <div style={{
                marginLeft: 'auto', flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 10px', borderRadius: 10,
                background: hexToRgba(theme.electricBlue, 0.1),
                border: `1px solid ${hexToRgba(theme.electricBlue, 0.35)}`,
              }}>
                <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: theme.electricBlue, fontWeight: 700 }}>
                  {tagSpans.length}
                </span>
                <span style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.textMuted }}>段</span>
                <span style={{ fontFamily: theme.fontMono, fontSize: 9.5, color: hexToRgba(theme.electricBlue, 0.45) }}>·</span>
                <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: theme.electricBlue, fontWeight: 700 }}>
                  {Math.floor(totalTagMinutes / 60)}h{totalTagMinutes % 60 > 0 ? `${totalTagMinutes % 60}m` : ''}
                </span>
              </div>
            </div>
          </>
        ) : (
          <span style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.textMuted, letterSpacing: 0.5 }}>
            今日无标签记录
          </span>
        )}
      </div>

      {/* ── 弹窗 1：百分比条点击 → 分类总览弹窗（ModelDialog 风格） ── */}
      {legendOpen && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(2,6,16,0.78)' }}
            onClick={() => setLegendOpen(false)}
          />
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed', left: '50%', top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 440, maxHeight: '72vh',
              display: 'flex', flexDirection: 'column',
              zIndex: 901,
              background: theme.hudFill,
              border: `1px solid ${theme.hudFrame}`,
              clipPath: hud.chamfer12,
              WebkitClipPath: hud.chamfer12,
              boxShadow: `0 24px 80px rgba(0,0,0,0.8), 0 0 60px ${theme.hudHalo}, inset 0 1px 0 rgba(255,255,255,0.04)`,
              overflow: 'hidden',
            }}
          >
            <div style={{ position: 'absolute', inset: 0, background: hud.scanlines, opacity: 0.45, pointerEvents: 'none', zIndex: 0 }} />

            {/* Header */}
            <div style={{
              position: 'relative', zIndex: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '13px 18px 11px',
              borderBottom: `1px solid ${hexToRgba(theme.electricBlue, 0.2)}`,
              flexShrink: 0,
            }}>
              <div>
                <span style={{ fontFamily: theme.fontDisplay, fontSize: 12, fontWeight: 700, letterSpacing: 2.5, color: theme.electricBlue, textShadow: `0 0 10px ${theme.electricBlue}99` }}>
                  标签时段分布
                </span>
                <span style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.textMuted, marginLeft: 10, letterSpacing: 0.5 }}>
                  {Math.floor(totalTagMinutes / 60)}h {totalTagMinutes % 60}m · {tagSpans.length} 段
                </span>
              </div>
              <button
                onClick={() => setLegendOpen(false)}
                style={{ background: 'none', border: `1px solid ${hexToRgba(theme.electricBlue, 0.2)}`, borderRadius: 3, cursor: 'pointer', color: theme.textMuted, display: 'flex', alignItems: 'center', padding: '3px 5px' }}
              >
                <X size={12} />
              </button>
            </div>

            {/* 顶部比例色条，内缩 18px 不贴边 */}
            <div style={{ margin: '0 18px 2px', flexShrink: 0, zIndex: 1, position: 'relative' }}>
              <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', gap: 1 }}>
                {tagLegend.map((s) => (
                  <div key={s.name} style={{ flex: s.mins, background: s.color, filter: 'saturate(1.5) brightness(1.15)' }} />
                ))}
                {totalTagMinutes < 1440 && <div style={{ flex: 1440 - totalTagMinutes, background: hexToRgba(theme.electricBlue, 0.05) }} />}
              </div>
            </div>

            {/* 分类列表（可滚动） */}
            <div style={{ position: 'relative', zIndex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '12px 18px 16px', flex: 1 } as CSSProperties}>
              {tagLegend.map((s, idx) => {
                const pct = totalTagMinutes > 0 ? Math.round(s.mins / totalTagMinutes * 100) : 0
                const h = Math.floor(s.mins / 60), m = s.mins % 60
                const timeLabel = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
                return (
                  <div key={s.name} style={{ marginBottom: idx < tagLegend.length - 1 ? 14 : 0 }}>
                    {/* 分类 header 行 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: s.color, boxShadow: `0 0 6px ${s.color}` }} />
                      <span style={{ fontFamily: theme.fontMono, fontSize: 12, fontWeight: 700, color: theme.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: 0.3 }}>{s.name}</span>
                      <span style={{ fontFamily: theme.fontMono, fontSize: 11, color: s.color, fontWeight: 700, flexShrink: 0, minWidth: 44, textAlign: 'right' }}>{timeLabel}</span>
                      <span style={{ fontFamily: theme.fontMono, fontSize: 9.5, color: theme.textMuted, flexShrink: 0, minWidth: 28, textAlign: 'right' }}>{pct}%</span>
                    </div>
                    <div style={{ paddingLeft: 13 }}>
                      {/* 分类占比 fill bar */}
                      <div style={{ height: 4, background: hexToRgba(s.color, 0.1), borderRadius: 2, marginBottom: 8, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: s.color, filter: 'saturate(1.4) brightness(1.1)', borderRadius: 2, transition: 'width 0.3s ease' }} />
                      </div>
                      {/* 子标签列表 */}
                      {s.subTags.map((st) => {
                        const stPct = s.mins > 0 ? Math.round(st.mins / s.mins * 100) : 0
                        const sh = Math.floor(st.mins / 60), sm = st.mins % 60
                        const stLabel = sh > 0 ? `${sh}h${sm > 0 ? ` ${sm}m` : ''}` : `${sm}m`
                        return (
                          <div key={st.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, paddingLeft: 2 }}>
                            <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: theme.textSecondary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {st.name}
                            </span>
                            <div style={{ width: 56, height: 2, background: hexToRgba(s.color, 0.12), borderRadius: 1, overflow: 'hidden', flexShrink: 0 }}>
                              <div style={{ height: '100%', width: `${stPct}%`, background: s.color, opacity: 0.75, borderRadius: 1 }} />
                            </div>
                            <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: hexToRgba(s.color, 0.85), fontWeight: 600, minWidth: 40, textAlign: 'right', flexShrink: 0 }}>
                              {stLabel}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* ── 弹窗 2：胶囊点击 → 子标签明细小弹窗，定位在胶囊正上方 ── */}
      {expandedChip && chipPos && (() => {
        const cat = tagLegend.find((s) => s.name === expandedChip)
        if (!cat) return null
        return (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 900 }}
              onClick={() => { setExpandedChip(null); setChipPos(null) }}
            />
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: chipPos.x, bottom: chipPos.bottom,
                transform: 'translateX(-50%)',
                zIndex: 901,
                width: 240,
                background: theme.hudFill,
                border: `1px solid ${theme.hudFrame}`,
                clipPath: hud.chamfer8,
                WebkitClipPath: hud.chamfer8,
                boxShadow: `0 8px 32px rgba(0,0,0,0.75), 0 0 24px ${theme.hudHalo}, inset 0 1px 0 rgba(255,255,255,0.04)`,
                overflow: 'hidden',
              }}
            >
              <div style={{ position: 'absolute', inset: 0, background: hud.scanlines, opacity: 0.5, pointerEvents: 'none' }} />
              {/* Header */}
              <div style={{
                position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '9px 12px 7px',
                borderBottom: `1px solid ${hexToRgba(cat.color, 0.25)}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: cat.color, boxShadow: `0 0 5px ${cat.color}`, display: 'inline-block' }} />
                  <span style={{ fontFamily: theme.fontMono, fontSize: 11, fontWeight: 700, color: cat.color, letterSpacing: 0.8 }}>{cat.name}</span>
                </div>
                <button
                  onClick={() => { setExpandedChip(null); setChipPos(null) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textMuted, display: 'flex', alignItems: 'center', padding: 3 }}
                >
                  <X size={11} />
                </button>
              </div>
              {/* 子标签列表 */}
              <div style={{ position: 'relative', padding: '8px 12px 10px' }}>
                {cat.subTags.length > 0 ? cat.subTags.map((st) => {
                  const pct = cat.mins > 0 ? Math.round(st.mins / cat.mins * 100) : 0
                  const h = Math.floor(st.mins / 60), m = st.mins % 60
                  const label = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
                  return (
                    <div key={st.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: theme.textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.name}</span>
                      <div style={{ width: 60, height: 3, background: hexToRgba(cat.color, 0.12), borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: cat.color, filter: 'saturate(1.3) brightness(1.1)', borderRadius: 2 }} />
                      </div>
                      <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: cat.color, fontWeight: 700, minWidth: 32, textAlign: 'right', flexShrink: 0 }}>{label}</span>
                    </div>
                  )
                }) : (
                  <span style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.textMuted }}>无子标签</span>
                )}
              </div>
            </div>
          </>
        )
      })()}
    </div>
  )
}
