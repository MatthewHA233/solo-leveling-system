import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { X } from 'lucide-react'
import type { ActivityBlock, ActivityPalette, PlanNode, PlannedBlock, RecordLayer } from '../types'
import type { PerceptionSpan, BiliSpan } from '../lib/local-api'
import { theme } from '../theme'
import DayNightToolbar from './daynight/DayNightToolbar'
import { tone, PIPE_TONE } from '../lib/color/harmonize'
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

/** 顶部轴区高度（= 原 topPad 28，不加高：高度一紧格子就会跌破 CELL_H_SWITCH 切成大格模式）
 *  28px 里分三层：时段名（0–12）/ 小时点阵数字（基线 21）/ 日照带（24–26） */
const AXIS_TOP = 28
/** 左侧分钟刻度尺宽度 */
const AXIS_W = 46

const pad2 = (n: number) => String(n).padStart(2, '0')
type RowsPerCol = (typeof DENSITY_ROWS)[number]

/** 小时组之间的间距（非 12行/列 模式下，相邻小时列之间留小间距） */
const HOUR_GROUP_GAP = 12

/** canvas 左内边距 / 右尾部留白 / 底部留白（totalW、totalH 与自适应反解共用） */
const GRID_H_PAD = 4
const GRID_TAIL_PAD = 16
const GRID_BOTTOM_PAD = 8

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
  const topPad = AXIS_TOP, bottomPad = GRID_BOTTOM_PAD
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
  const hPad = GRID_H_PAD  // canvas 内 axis 让位由 wrapper.left 实现（不再让 hPad 让位）
  const topPad = AXIS_TOP
  const bottomPad = GRID_BOTTOM_PAD
  const minuteH = cellH / 5
  const traceBaseX = 0  // 管道贴单元格左边缘，无腾空
  const trackSp = Math.max(2, Math.round(cellW * 0.09))
  const colStride = cellW + colGap
  const rowStride = cellH + rowGap
  const gridH = rows * rowStride - rowGap
  // 每小时组内宽：colsPerHour 列宽 + (colsPerHour-1) 列间距
  const hourGroupInnerW = colsPerHour * colStride - colGap
  // 4 个区时边界（6,12,18,20 点）各额外加 ZONE_GAP_EXTRA
  const totalW = hPad + 24 * hourGroupInnerW + 23 * hgGap + 4 * ZONE_GAP_EXTRA + GRID_TAIL_PAD
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

type GridParams = ReturnType<typeof getGridParams>

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

// 时段：夜里偏冷（冰蓝投影光），白天几乎不着色，黄昏一抹信号橙
function getZoneInfo(hour: number): ZoneInfo {
  if (hour < 6)  return { label: '凌晨', bgColor: [70, 120, 205],  bgAlpha: 0.075, textColor: '#9DC2EE' }
  if (hour < 12) return { label: '上午', bgColor: [180, 215, 235], bgAlpha: 0.03,  textColor: '#CFE4EE' }
  if (hour < 18) return { label: '下午', bgColor: [240, 225, 200], bgAlpha: 0.03,  textColor: '#E6DCC8' }
  if (hour < 20) return { label: '黄昏', bgColor: [255, 138, 76],  bgAlpha: 0.07,  textColor: '#FFB98A' }
  return           { label: '夜晚', bgColor: [90, 100, 200],  bgAlpha: 0.085, textColor: '#AFB6F0' }
}

// 日照带：一天里天空的颜色（深夜蓝 → 破晓 → 白昼 → 黄昏橙 → 入夜），画在小时数字下沿
const SKY_STOPS: ReadonlyArray<readonly [number, string]> = [
  [0, '#1A2447'], [4.5, '#1F2C55'], [5.5, '#4A4A8C'], [6.5, '#E39A78'], [8, '#8FC4DE'],
  [12, '#D6E9F0'], [15.5, '#E6D6A4'], [17.5, '#F2A564'], [19, '#FF8A4C'], [20, '#7E4E9E'],
  [21.5, '#2C2C62'], [24, '#1A2447'],
]

/** 小时（可带小数）→ canvas X（列内按分钟线性插值） */
function hourToX(hour: number, p: GridParams): number {
  const minute = Math.max(0, Math.min(1440, hour * 60))
  const col = Math.min(p.cols - 1, Math.floor(minute / p.minutesPerCol))
  const frac = (minute - col * p.minutesPerCol) / p.minutesPerCol
  return colX(col, p) + frac * p.cellW
}

function drawSkyRibbon(ctx: CanvasRenderingContext2D, p: GridParams) {
  const x0 = colX(0, p)
  const x1 = colX(p.cols - 1, p) + p.cellW
  const y = p.topPad - 4
  const grad = ctx.createLinearGradient(x0, 0, x1, 0)
  for (const [h, c] of SKY_STOPS) {
    grad.addColorStop(Math.min(1, Math.max(0, (hourToX(h, p) - x0) / (x1 - x0))), c)
  }
  ctx.save()
  ctx.fillStyle = grad
  ctx.globalAlpha = 0.9
  ctx.fillRect(x0, y, x1 - x0, 2)
  ctx.globalAlpha = 0.16   // 往下晕开一点，像光带
  ctx.fillRect(x0, y + 2, x1 - x0, 2)
  ctx.restore()
}

/** 区时分界线的 X：落在两个时段之间那道缝的正中 */
function zoneBoundaryX(hour: number, p: GridParams): number {
  const col = Math.floor(hour * 60 / p.minutesPerCol)
  return colX(col, p) - (p.hgGap + ZONE_GAP_EXTRA) / 2
}

function drawZoneBands(ctx: CanvasRenderingContext2D, p: GridParams) {
  // 1) 时段投影光柱：顶部略亮、往下淡出（不再用斜线 hatching）
  const zones: [number, number][] = [[0, 6], [6, 12], [12, 18], [18, 20], [20, 24]]
  for (const [startH, endH] of zones) {
    const z = getZoneInfo(startH)
    const [r, g, b] = z.bgColor
    const firstCol = Math.floor(startH * 60 / p.minutesPerCol)
    const lastCol = Math.min(p.cols - 1, Math.floor(endH * 60 / p.minutesPerCol) - 1)
    if (firstCol >= p.cols) continue
    const x0 = colX(firstCol, p) - 3
    const x1 = colX(lastCol, p) + p.cellW + 3
    const grad = ctx.createLinearGradient(0, p.topPad, 0, p.topPad + p.gridH)
    grad.addColorStop(0, `rgba(${r},${g},${b},${z.bgAlpha * 1.7})`)
    grad.addColorStop(1, `rgba(${r},${g},${b},${z.bgAlpha * 0.5})`)
    ctx.fillStyle = grad
    ctx.fillRect(x0, p.topPad - 2, x1 - x0, p.gridH + 4)
  }

  // 2) 日照带
  drawSkyRibbon(ctx, p)

  // 3) 时段分界：冰蓝虚线 + 日照带上一颗菱形灯
  for (const h of [6, 12, 18, 20]) {
    const col = Math.floor(h * 60 / p.minutesPerCol)
    if (col >= p.cols) continue
    const x = Math.round(zoneBoundaryX(h, p)) + 0.5
    ctx.save()
    ctx.strokeStyle = 'rgba(158,216,242,0.22)'
    ctx.lineWidth = 1
    ctx.setLineDash([2, 4])
    ctx.beginPath()
    ctx.moveTo(x, p.topPad)
    ctx.lineTo(x, p.topPad + p.gridH)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#C8ECFC'
    ctx.shadowColor = 'rgba(150,215,245,0.9)'
    ctx.shadowBlur = 5
    const dy = p.topPad - 3
    ctx.beginPath()
    ctx.moveTo(x, dy - 3.5); ctx.lineTo(x + 3.5, dy); ctx.lineTo(x, dy + 3.5); ctx.lineTo(x - 3.5, dy)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  // 时段中文名由 ScrollingZoneLabels 在 sticky 层渲染（随 scrollLeft 同步）
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

    const color   = tone(span.color ?? '#4488ff')   // 颜色统一明度彩度（lib/color/harmonize）
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
    const vivid = tone(color, PIPE_TONE)
    const startCol = Math.floor(startMin / p.minutesPerCol)
    const endCol   = Math.floor((endMin - 0.0001) / p.minutesPerCol)


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
      ctx.shadowColor = hexToRgba(vivid, isHighlighted ? 0.9 : 0.4)
      ctx.shadowBlur = isHighlighted ? 8 : 2
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
    const vivid = tone(railColor, PIPE_TONE)
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
      ctx.shadowColor = hexToRgba(vivid, 0.4)
      ctx.shadowBlur = 2
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

function drawGrid(ctx: CanvasRenderingContext2D, p: GridParams) {
  // 玻璃砖：极淡冷光底 + 上沿亮线 + 下沿压暗（不画格线、不画四角括号）
  for (let c = 0; c < p.cols; c++) {
    const x = colX(c, p)
    for (let r = 0; r < p.rows; r++) {
      const y = p.topPad + r * p.rowStride
      ctx.fillStyle = 'rgba(158,216,242,0.032)'
      ctx.fillRect(x, y, p.cellW, p.cellH)
      ctx.fillStyle = 'rgba(200,236,252,0.075)'
      ctx.fillRect(x, y, p.cellW, 1)
      ctx.fillStyle = 'rgba(0,0,0,0.28)'
      ctx.fillRect(x, y + p.cellH - 1, p.cellW, 1)
    }
  }
}

function drawTimeLabels(ctx: CanvasRenderingContext2D, p: GridParams) {
  // 只在列头标小时（点阵数字）；分钟交给左侧刻度尺，格子里不再逐格印时间
  const ZONE_START_HOURS = new Set([0, 6, 12, 18, 20])
  const y = p.topPad - 7
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  for (let c = 0; c < p.cols; c++) {
    const m = c * p.minutesPerCol
    const x = colX(c, p) + p.cellW / 2
    if (m % 60 === 0) {
      const hour = m / 60
      const zoneStart = ZONE_START_HOURS.has(hour)
      ctx.font = `900 ${p.fs(13)}px 'Doto', 'JetBrains Mono', monospace`
      ctx.fillStyle = zoneStart ? '#C8ECFC' : '#CBC6BF'
      ctx.shadowColor = zoneStart ? 'rgba(150,215,245,0.7)' : 'transparent'
      ctx.shadowBlur = zoneStart ? 6 : 0
      ctx.fillText(pad2(hour), x, y)
    } else {
      ctx.font = `700 ${p.fs(10)}px 'Doto', 'JetBrains Mono', monospace`
      ctx.fillStyle = '#8E8982'
      ctx.shadowBlur = 0
      ctx.fillText(`:${pad2(m % 60)}`, x, y)
    }
  }
  ctx.restore()
}

function drawNowTick(ctx: CanvasRenderingContext2D, p: GridParams, isToday: boolean) {
  if (!isToday) return
  const now = new Date()
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  const col = Math.floor(nowMinute / p.minutesPerCol)
  if (col >= p.cols) return
  const row = Math.floor((nowMinute % p.minutesPerCol) / 5)
  if (row >= p.rows) return
  const cx = colX(col, p)
  const y = p.topPad + row * p.rowStride + (nowMinute % 5) * p.minuteH

  ctx.save()
  // 1) 当前列：冷光投影柱 + 顶沿亮条
  const colGrad = ctx.createLinearGradient(0, p.topPad, 0, p.topPad + p.gridH)
  colGrad.addColorStop(0, 'rgba(158,216,242,0.11)')
  colGrad.addColorStop(1, 'rgba(158,216,242,0.025)')
  ctx.fillStyle = colGrad
  ctx.fillRect(cx - 2, p.topPad, p.cellW + 4, p.gridH)
  ctx.shadowColor = 'rgba(150,215,245,0.9)'
  ctx.shadowBlur = 6
  ctx.fillStyle = '#C8ECFC'
  ctx.fillRect(cx, p.topPad - 1, p.cellW, 2)

  // 2) 此刻：橙色 LED 线 + 左端菱形
  ctx.shadowColor = 'rgba(255,120,60,0.95)'
  ctx.shadowBlur = 8
  ctx.fillStyle = '#FF8A4C'
  ctx.fillRect(cx - 2, y - 1, p.cellW + 4, 2)
  ctx.fillStyle = '#FFB98A'
  ctx.beginPath()
  ctx.moveTo(cx - 10, y); ctx.lineTo(cx - 6, y - 4); ctx.lineTo(cx - 2, y); ctx.lineTo(cx - 6, y + 4)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  // 3) 读数芯片：黑玻璃 +「此刻」+ 点阵时间（右侧放不下就放到列左侧）
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const timeFont = `900 ${p.fs(15)}px 'Doto', 'JetBrains Mono', monospace`
  const labelFont = `${p.fs(11)}px 'Microsoft YaHei UI', sans-serif`
  ctx.save()
  ctx.font = timeFont
  const timeW = ctx.measureText(timeStr).width
  ctx.font = labelFont
  const labelW = ctx.measureText('此刻').width
  const padX = 8, gap = 6, chipH = 22
  const chipW = padX + labelW + gap + timeW + padX
  let chipX = cx + p.cellW + 10
  const onRight = chipX + chipW <= p.totalW - 4
  if (!onRight) chipX = cx - 14 - chipW
  const chipY = y - chipH / 2

  ctx.strokeStyle = 'rgba(255,138,76,0.7)'
  ctx.lineWidth = 1
  ctx.beginPath()
  if (onRight) { ctx.moveTo(cx + p.cellW + 2, y + 0.5); ctx.lineTo(chipX, y + 0.5) }
  else { ctx.moveTo(chipX + chipW, y + 0.5); ctx.lineTo(cx - 10, y + 0.5) }
  ctx.stroke()

  ctx.beginPath()
  ctx.roundRect(chipX, chipY, chipW, chipH, 4)
  ctx.fillStyle = 'rgba(7,7,6,0.92)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,138,76,0.55)'
  ctx.stroke()

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = labelFont
  ctx.fillStyle = '#A8A39C'
  ctx.fillText('此刻', chipX + padX, y + 0.5)
  ctx.font = timeFont
  ctx.fillStyle = '#FF9A5C'
  ctx.shadowColor = 'rgba(255,130,60,0.8)'
  ctx.shadowBlur = 6
  ctx.fillText(timeStr, chipX + padX + labelW + gap, y + 1)
  ctx.restore()
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
    const color = tone(span.color ?? '#4488ff')
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
    const frameColor = '#9ED8F2'
    const frameGlow  = 'rgba(150,215,245,0.8)'

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

  // ── 准星横线：悬停 = 冰蓝，锁定 = 信号橙；两端各一颗小方点 ──
  const lineColor = isPinned ? 'rgba(255,138,76,0.95)' : 'rgba(200,236,252,0.75)'
  const glowColor = isPinned ? 'rgba(255,120,60,0.7)' : 'rgba(150,215,245,0.55)'
  ctx.save()
  ctx.shadowColor = glowColor
  ctx.shadowBlur = 5
  ctx.fillStyle = lineColor
  ctx.fillRect(x0, Math.round(mouseY) - 0.5, x1 - x0, 1)
  ctx.fillRect(x0 - 1.5, mouseY - 1.5, 3, 3)
  ctx.fillRect(x1 - 1.5, mouseY - 1.5, 3, 3)
  ctx.restore()

  // ── 管线标签：黑玻璃小窗（应用名 / 视频标题） ──
  if (pipeLabel) {
    const hasIcon  = pipeLabelIcon !== null
    const iconSize = 14
    const gap      = 4
    const padX     = 5, padY = 3
    const lineH    = 13

    const labelX     = x0 + p.traceBaseX + PIPE_RIGHT + 6
    const maxLabelW  = x1 - labelX - 2
    const availTextW = maxLabelW - padX * 2 - (hasIcon ? iconSize + gap : 0)

    const labelFont = `500 ${p.fs(10.5)}px 'Microsoft YaHei UI', 'PingFang SC', sans-serif`
    ctx.font = labelFont
    const lines     = availTextW > 10 ? wrapText(ctx, pipeLabel, availTextW).slice(0, 3) : [pipeLabel]
    const textBlock = hasIcon ? Math.max(iconSize, lines.length * lineH) : lines.length * lineH
    const labelH    = padY * 2 + textBlock
    const labelY    = mouseY - labelH / 2

    ctx.save()
    ctx.beginPath()
    ctx.roundRect(labelX, labelY, maxLabelW, labelH, 3)
    ctx.fillStyle = 'rgba(7,7,6,0.9)'
    ctx.fill()
    ctx.strokeStyle = isPinned ? 'rgba(255,138,76,0.5)' : (trackMode === 'bili' ? 'rgba(251,114,153,0.35)' : 'rgba(158,216,242,0.3)')
    ctx.lineWidth = 0.75
    ctx.stroke()
    ctx.restore()

    let textX = labelX + padX
    if (hasIcon && pipeLabelIcon) {
      const iconY = labelY + padY + (textBlock - iconSize) / 2
      ctx.drawImage(pipeLabelIcon, labelX + padX, iconY, iconSize, iconSize)
      textX = labelX + padX + iconSize + gap
    }

    ctx.font         = labelFont
    ctx.fillStyle    = '#E4E0DA'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'alphabetic'
    const textStartY = labelY + padY + lineH - 2.5
    lines.forEach((line, i) => {
      ctx.fillText(line, textX, textStartY + i * lineH)
    })
  }

  // ── 读数 + 锁定键：点阵时刻 ｜ 锁定/解锁（整块可点） ──
  const timeStr = fmt(Math.floor(minute))
  const actionLabel = isPinned ? '解锁' : '锁定'
  const timeFont = `900 ${p.fs(13)}px 'Doto', 'JetBrains Mono', monospace`
  const actFont = `${p.fs(10.5)}px 'Microsoft YaHei UI', sans-serif`
  ctx.font = timeFont
  const timeW = ctx.measureText(timeStr).width
  ctx.font = actFont
  const actW = ctx.measureText(actionLabel).width
  const bPadX = 7, bGap = 7
  const badgeW = bPadX + timeW + bGap + 1 + bGap + actW + bPadX
  const badgeH = 20
  let badgeX = x1 + 6
  if (badgeX + badgeW > p.totalW - 2) badgeX = x0 - 6 - badgeW
  const badgeY = mouseY - badgeH / 2

  ctx.save()
  ctx.beginPath()
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4)
  ctx.fillStyle = 'rgba(7,7,6,0.92)'
  ctx.fill()
  ctx.strokeStyle = isPinned ? 'rgba(255,138,76,0.6)' : 'rgba(158,216,242,0.35)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = timeFont
  ctx.fillStyle = isPinned ? '#FF9A5C' : '#C8ECFC'
  ctx.shadowColor = isPinned ? 'rgba(255,130,60,0.8)' : 'rgba(150,215,245,0.7)'
  ctx.shadowBlur = 5
  ctx.fillText(timeStr, badgeX + bPadX, mouseY + 1)
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(255,255,255,0.14)'
  ctx.fillRect(badgeX + bPadX + timeW + bGap, badgeY + 5, 1, badgeH - 10)
  ctx.font = actFont
  ctx.fillStyle = isPinned ? '#FFB98A' : '#A8A39C'
  ctx.fillText(actionLabel, badgeX + bPadX + timeW + bGap * 2 + 1, mouseY + 0.5)
  ctx.restore()
  ctx.textBaseline = 'alphabetic'

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


// ── 左上角：斜线表头（右上「时」、左下「分」）──

function AxisCorner() {
  return (
    <div aria-hidden style={{
      position: 'absolute', top: 0, left: 0, width: AXIS_W, height: AXIS_TOP,
      pointerEvents: 'none', zIndex: 6,
    }}>
      <svg width={AXIS_W} height={AXIS_TOP} style={{ position: 'absolute', top: 0, left: 0 }}>
        <line x1={4} y1={3} x2={AXIS_W - 4} y2={AXIS_TOP - 2} stroke="rgba(158,216,242,0.4)" strokeWidth="1" />
      </svg>
      <span style={{ position: 'absolute', top: 1, right: 7, fontSize: 10.5, color: 'var(--ti-text-dim)' }}>时</span>
      <span style={{ position: 'absolute', bottom: 0, left: 7, fontSize: 10.5, color: 'var(--ti-text-dim)' }}>分</span>
    </div>
  )
}

// ── 左侧分钟刻度尺：每行一道刻度，逢 15 / 10 / 5 分钟（随密度）标点阵数字 ──

function LeftAxis({ params }: { params: GridParams }) {
  const majorEvery = params.rowsPerCol >= 12 ? 15 : params.rowsPerCol >= 4 ? 10 : 5
  const ticks = Array.from({ length: params.rowsPerCol - 1 }, (_, i) => {
    const minute = (i + 1) * 5
    return {
      minute,
      y: i * params.rowStride + params.cellH + params.rowGap / 2,
      major: minute % majorEvery === 0,
    }
  })
  return (
    <div aria-hidden style={{
      position: 'absolute', top: AXIS_TOP, left: 0, width: AXIS_W, height: params.gridH,
      pointerEvents: 'none', zIndex: 6,
    }}>
      <div style={{
        position: 'absolute', right: 5, top: 0, bottom: 0, width: 1,
        background: 'linear-gradient(180deg, rgba(158,216,242,0.55), rgba(158,216,242,0.12))',
      }} />
      {ticks.map((t) => (
        <div key={t.minute} style={{
          position: 'absolute', top: t.y, right: 5,
          display: 'flex', alignItems: 'center', gap: 5,
          transform: 'translateY(-50%)',
        }}>
          <span className="ti-led" style={{
            fontSize: t.major ? 12 : 10,
            fontWeight: t.major ? 900 : 700,
            color: t.major ? '#C8ECFC' : '#8E8982',
            textShadow: t.major ? '0 0 6px rgba(150,215,245,0.6)' : 'none',
          }}>
            {pad2(t.minute)}
          </span>
          <span style={{
            width: t.major ? 7 : 4, height: 1,
            background: t.major ? 'rgba(200,236,252,0.9)' : 'rgba(158,216,242,0.4)',
          }} />
        </div>
      ))}
    </div>
  )
}

// ── 时段名：跨整段的一道渐隐细线，名字居中（CSS sticky，跟 canvas 共享 scrollLeft） ──

function ScrollingZoneLabels({ params }: { params: GridParams }) {
  const zoneDefs: [number, number][] = [[0, 6], [6, 12], [12, 18], [18, 20], [20, 24]]
  return (
    // sticky 容器 height:0：不占 wrapper 流式空间（避免纵向滚动条），子内容 absolute 浮出
    <div style={{
      position: 'sticky', top: 0,
      width: params.totalW, height: 0,
      zIndex: 3,
      pointerEvents: 'none',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, width: params.totalW, height: 12 }}>
        {zoneDefs.map(([startH, endH]) => {
          const z = getZoneInfo(startH)
          const firstCol = Math.floor(startH * 60 / params.minutesPerCol)
          const lastCol = Math.floor(endH * 60 / params.minutesPerCol) - 1
          if (firstCol >= params.cols) return null
          const x0 = colX(firstCol, params)
          const x1 = colX(Math.min(lastCol, params.cols - 1), params) + params.cellW
          return (
            <div key={startH} style={{
              position: 'absolute', top: 0, left: x0, width: x1 - x0, height: 12,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, transparent, ${z.textColor}66)` }} />
              <span style={{ fontSize: 10.5, lineHeight: '12px', letterSpacing: '0.4em', paddingLeft: '0.4em', color: z.textColor, whiteSpace: 'nowrap' }}>
                {z.label}
              </span>
              <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${z.textColor}66, transparent)` }} />
            </div>
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
    ctx.fillStyle = '#05080B'
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
      img.src = `http://localhost:39733/api/perception/app-icon?name=${encodeURIComponent(name)}`
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
      drawDragPreview(ctx, p, drag.startMin, drag.currentMin, tone(drag.color), drag.tagId, drag.initial)
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

  // canvas 用到 Doto 点阵字：字体到位后补一次重绘，避免首帧回落成等宽字
  useEffect(() => {
    let cancelled = false
    const fonts = document.fonts
    if (!fonts) return
    Promise.all([fonts.load("900 14px 'Doto'"), fonts.load("700 11px 'Doto'")])
      .then(() => { if (!cancelled) redrawRef.current?.() })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

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
      if (!entry) { entry = { color: tone(s.color ?? '#4488ff'), mins: 0, subTagMap: new Map() }; map.set(firstName, entry) }
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

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        background: 'transparent', position: 'relative',
      }}
    >
      <DayNightToolbar
        trackMode={trackMode}
        onTrackModeChange={onTrackModeChange}
        appLabel={getAppTrackLabel()}
        recordLayer={recordLayer}
        onRecordLayerChange={onRecordLayerChange}
        editMode={editMode}
        onToggleEdit={onEditModeToggle}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => onUndo?.()}
        onRedo={() => onRedo?.()}
      />

      {/* 图表区：滚动 wrapper（sticky 时段名 + canvas）；左侧斜线表头 + 分钟刻度尺浮在上层 */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <div
          ref={containerRef}
          className="daynight-scroll"
          style={{
            position: 'absolute', top: 0, left: AXIS_W, right: 0, bottom: 0,
            overflowX: 'auto', overflowY: 'auto', cursor: 'pointer',
          }}
        >
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

        <AxisCorner />
        <LeftAxis params={p} />
      </div>

      {/* 底部：百分比条 + 横向分类胶囊 */}
      <div style={{
        position: 'relative',
        padding: '7px 14px 8px',
        background: 'linear-gradient(180deg, rgba(158,216,242,0.04) 0%, transparent 100%)',
      }}>
        <div className="ti-groove-h" style={{ position: 'absolute', left: 0, right: 0, top: 0 }} />
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
              className="ti-well"
              style={{
                display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden',
                cursor: 'pointer', gap: 1, marginBottom: 7,
              }}
            >
              {tagLegend.map((s) => (
                <div key={s.name} style={{ flex: s.mins, background: s.color }} />
              ))}
              {totalTagMinutes < 1440 && (
                <div style={{ flex: 1440 - totalTagMinutes, background: 'transparent' }} />
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
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '3px 9px 3px 7px', borderRadius: 4, flexShrink: 0,
                      background: active ? `${s.color}22` : '#070706',
                      border: 'none',
                      whiteSpace: 'nowrap', cursor: 'pointer',
                      boxShadow: `inset 0 1px 3px rgba(0,0,0,0.9), 0 0 0 1px ${active ? `${s.color}99` : 'rgba(255,255,255,0.05)'}`,
                      transition: 'all 0.12s ease',
                    }}
                  >
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                      background: s.color, boxShadow: `0 0 5px ${s.color}aa`,
                      display: 'inline-block',
                    }} />
                    <span style={{ fontFamily: theme.fontBody, fontSize: 11, color: theme.textSecondary }}>
                      {s.name}
                    </span>
                    <span className="ti-led" style={{ fontSize: 12, color: s.color, textShadow: `0 0 6px ${s.color}88` }}>
                      {label}
                    </span>
                  </button>
                )
              })}
              {/* 段数 + 总时长徽章 */}
              <div className="ti-well" style={{
                marginLeft: 'auto', flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '3px 10px', borderRadius: 4,
              }}>
                <span className="ti-led" style={{ fontSize: 13 }}>{tagSpans.length}</span>
                <span style={{ fontSize: 10.5, color: theme.textMuted }}>段</span>
                <span style={{ width: 1, height: 10, background: 'rgba(255,255,255,0.12)' }} />
                <span className="ti-led" style={{ fontSize: 13 }}>
                  {Math.floor(totalTagMinutes / 60)}h{totalTagMinutes % 60 > 0 ? `${totalTagMinutes % 60}m` : ''}
                </span>
              </div>
            </div>
          </>
        ) : (
          <span style={{ fontSize: 11.5, color: theme.textMuted, letterSpacing: '0.1em' }}>
            这一天还没有标签记录 · 点「记录」开始涂
          </span>
        )}
      </div>

      {/* ── 弹窗 1：百分比条点击 → 分类总览弹窗（ModelDialog 风格） ── */}
      {legendOpen && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(0,0,0,0.62)' }}
            onClick={() => setLegendOpen(false)}
          />
          <div
            onClick={(e) => e.stopPropagation()}
            className="ti-plate"
            style={{
              position: 'fixed', left: '50%', top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 440, maxHeight: '72vh',
              display: 'flex', flexDirection: 'column',
              zIndex: 901,
              borderRadius: 9,
              overflow: 'hidden',
            }}
          >

            {/* Header */}
            <div style={{
              position: 'relative', zIndex: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '13px 18px 11px',
              borderBottom: `1px solid ${hexToRgba(theme.electricBlue, 0.2)}`,
              flexShrink: 0,
            }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: 2.5, color: theme.textPrimary }}>
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
              className="ti-plate"
              style={{
                position: 'fixed',
                left: chipPos.x, bottom: chipPos.bottom,
                transform: 'translateX(-50%)',
                zIndex: 901,
                width: 240,
                borderRadius: 7,
                overflow: 'hidden',
              }}
            >
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
