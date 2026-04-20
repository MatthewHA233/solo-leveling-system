import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import type { ChronosActivity } from '../types'
import type { MtSpan, BiliSpan } from '../lib/local-api'
import { theme } from '../theme'
import { HudFrame } from './hud'

interface Props {
  activities: ChronosActivity[]
  mtSpans?: MtSpan[]
  biliSpans?: BiliSpan[]
  selectedDate: Date
  onSpanClick?: (span: MtSpan) => void
  onSpanHover?: (span: MtSpan | null) => void
  onAppSpanHover?: (span: MtSpan | null) => void
  onBiliSpanHover?: (span: BiliSpan | null) => void
  trackMode?: 'apps' | 'bili'
  onTrackModeChange?: (mode: 'apps' | 'bili') => void
  pinnedPos?: { col: number; y: number; minute: number } | null
  onPinPos?: (pos: { col: number; y: number; minute: number } | null) => void
  onDeleteMinuteRange?: (startMin: number, endMin: number) => void
}

// ── 响应式密度模式（纵向驱动）──
// 每列行数决定列密度：12行/列=1列/小时，6行/列=2列/小时，4行/列=3列/小时，3行/列=4列/小时

const DENSITY_ROWS = [12, 6, 4, 3] as const
type RowsPerCol = (typeof DENSITY_ROWS)[number]

/** 小时组之间的间距（非 12行/列 模式下，相邻小时列之间留小间距） */
const HOUR_GROUP_GAP = 12

/** 区时边界（凌晨/清晨/上午/下午/黄昏/夜晚）处额外叠加的间距，所有密度模式均生效 */
const ZONE_GAP_EXTRA = 14

const COL_GAP_BY_ROWS: Record<RowsPerCol, number> = { 12: 2, 6: 2, 4: 1, 3: 1 }

/** 返回 hourGroup 之前（不含 0 点）累计的区时边界数量，用于叠加 ZONE_GAP_EXTRA */
function zoneGapsBefore(hourGroup: number): number {
  // ZONE_HOURS 首元素 0 跳过，统计 [5,7,12,18,20] 中 <= hourGroup 的个数
  return [5, 7, 12, 18, 20].filter(h => h <= hourGroup).length
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
  const hPad = 4
  const topPad = 28
  const bottomPad = 8
  const minuteH = cellH / 5
  const traceBaseX = Math.max(1, Math.round(cellW * 0.04))
  const trackSp = Math.max(2, Math.round(cellW * 0.09))
  const colStride = cellW + colGap
  const rowStride = cellH + rowGap
  const gridH = rows * rowStride - rowGap
  // 每小时组内宽：colsPerHour 列宽 + (colsPerHour-1) 列间距
  const hourGroupInnerW = colsPerHour * colStride - colGap
  // 5 个区时边界（5,7,12,18,20 点）各额外加 ZONE_GAP_EXTRA
  const totalW = hPad + 24 * hourGroupInnerW + 23 * hgGap + 5 * ZONE_GAP_EXTRA + 16
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
  if (hour < 5)  return { label: '凌晨', bgColor: [15,  10,  120], bgAlpha: 0.32, textColor: 'rgba(120,140,255,0.80)' }
  if (hour < 7)  return { label: '清晨', bgColor: [210, 130, 30],  bgAlpha: 0.24, textColor: 'rgba(255,190,90,0.90)'  }
  if (hour < 12) return { label: '上午', bgColor: [190, 200, 50],  bgAlpha: 0.18, textColor: 'rgba(220,240,100,0.85)' }
  if (hour < 18) return { label: '下午', bgColor: [220, 180, 20],  bgAlpha: 0.18, textColor: 'rgba(255,220,80,0.85)'  }
  if (hour < 20) return { label: '黄昏', bgColor: [220, 70,  20],  bgAlpha: 0.28, textColor: 'rgba(255,130,60,0.95)'  }
  return           { label: '夜晚', bgColor: [30,  10,  110], bgAlpha: 0.32, textColor: 'rgba(160,110,255,0.80)' }
}


function drawZoneBands(ctx: CanvasRenderingContext2D, p: ReturnType<typeof getGridParams>) {
  // 按小时组绘制色带：区内每个小时组单独一块，hgGap / ZONE_GAP_EXTRA 自然留白
  const zones: [number, number][] = [[0,5],[5,7],[7,12],[12,18],[18,20],[20,24]]
  for (const [startH, endH] of zones) {
    const z = getZoneInfo(startH)
    const [r, g, b] = z.bgColor
    ctx.fillStyle = `rgba(${r},${g},${b},${z.bgAlpha})`
    for (let h = startH; h < endH; h++) {
      const firstCol = Math.floor(h * 60 / p.minutesPerCol)
      const lastCol  = Math.floor((h + 1) * 60 / p.minutesPerCol) - 1
      if (firstCol >= p.cols) continue
      const x0 = colX(firstCol, p)
      const x1 = colX(Math.min(lastCol, p.cols - 1), p) + p.cellW
      ctx.fillRect(x0, 0, x1 - x0, p.totalH)
    }
  }

  // 顶部区时标签：居中于整个区时列宽，楷体大字
  const zoneDefs: [number, number][] = [[0,5],[5,7],[7,12],[12,18],[18,20],[20,24]]
  const labelFontSize = Math.max(12, p.fs(15))
  ctx.font = `bold ${labelFontSize}px 'KaiTi', 'STKaiti', 'SimSun', serif`
  ctx.textAlign = 'center'
  for (const [startH, endH] of zoneDefs) {
    const z = getZoneInfo(startH)
    const firstCol = Math.floor(startH * 60 / p.minutesPerCol)
    const lastCol  = Math.floor(endH   * 60 / p.minutesPerCol) - 1
    if (firstCol >= p.cols) continue
    const x0 = colX(firstCol, p)
    const x1 = colX(Math.min(lastCol, p.cols - 1), p) + p.cellW
    ctx.fillStyle = z.textColor
    ctx.fillText(z.label, (x0 + x1) / 2, labelFontSize)
  }
}

// ── ManicTime 感知轨道 ──

/** 从逗号分隔标签路径中分离路径部分和标记（以 : 开头为标记） */
function parseTagTitle(title: string): { parts: string[]; markers: string[] } {
  const all = title.split(',').map((s) => s.trim()).filter(Boolean)
  return {
    parts:   all.filter((s) => !s.startsWith(':')),
    markers: all.filter((s) => s.startsWith(':')).map((s) => s.slice(1)),
  }
}

/** "2026-04-04 13:30:00" → 分钟数（810） */
function dtToMinute(dt: string): number {
  const parts = dt.split(' ')
  if (parts.length < 2) return 0
  const [h, m] = parts[1].split(':').map(Number)
  return h * 60 + m
}

const TRACE_GAP = 5  // 轨道与高亮矩形之间的间隔

/** ManicTime 标签层 → 跨单元格高亮矩形 */
function drawTagFills(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  spans: MtSpan[],
  hoveredSpanId: number | null,
) {
  const fillOffsetX = p.traceBaseX + traceWidth + TRACE_GAP

  for (const span of spans) {
    if (span.track !== 'tags') continue
    const startMin = dtToMinute(span.start_at)
    const endMin   = dtToMinute(span.end_at)
    if (endMin <= startMin) continue

    const color   = span.color ?? '#4488ff'
    const hovered = hoveredSpanId === span.id

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

      // 1) 填充：极弱水平渐变（基本接近纯色，只在右端收一点边）
      const grad = ctx.createLinearGradient(x, 0, x + w, 0)
      grad.addColorStop(0, hexToRgba(color, hovered ? 0.68 : 0.52))
      grad.addColorStop(0.75, hexToRgba(color, hovered ? 0.6 : 0.46))
      grad.addColorStop(1, hexToRgba(color, hovered ? 0.42 : 0.32))
      ctx.fillStyle = grad
      ctx.fillRect(x, y0, w, h)

      // 2) 顶部高亮带（仅段首列顶部）
      if (isFirstCol) {
        ctx.fillStyle = hexToRgba(color, hovered ? 0.95 : 0.8)
        ctx.fillRect(x, y0, w, 1.2)
      }
      // 底部收口暗线（仅末列底部）
      if (isLastCol) {
        ctx.fillStyle = hexToRgba(color, hovered ? 0.55 : 0.4)
        ctx.fillRect(x, y1 - 1, w, 1)
      }

      // 3) 左侧能量亮边 + 发光
      ctx.save()
      if (hovered) {
        ctx.shadowColor = hexToRgba(color, 0.9)
        ctx.shadowBlur = 6
      }
      ctx.strokeStyle = hexToRgba(color, hovered ? 1.0 : 0.9)
      ctx.lineWidth = hovered ? 2.2 : 1.8
      ctx.beginPath()
      ctx.moveTo(x + 0.5, y0)
      ctx.lineTo(x + 0.5, y1)
      ctx.stroke()
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

// 图标在管道内的尺寸（左轨右侧 ~ 活动矩形左侧，约 12px 可用）
const PIPE_ICON_SIZE = 10

/** ManicTime 应用层 → 双轨管线（按列连续，穿越行间隙）+ 管内图标 */
function drawAppTraces(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  spans: MtSpan[],
  getIcon?: (name: string) => HTMLImageElement | null,
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
    const endCol   = Math.floor((endMin - 1) / p.minutesPerCol)

    // 暗色自动提亮（紫色、深蓝等在暗背景下被吞没的颜色）
    const vivid = brightenForDark(color, 160)

    for (let c = startCol; c <= endCol && c < p.cols; c++) {
      const segStart = Math.max(startMin, c * p.minutesPerCol)
      const segEnd   = Math.min(endMin, (c + 1) * p.minutesPerCol)
      const cx = colX(c, p)
      const lx = cx + p.traceBaseX + PIPE_LEFT
      const rx = cx + p.traceBaseX + PIPE_RIGHT
      const y0 = minuteToY(segStart, c, p)
      const y1 = minuteToY(segEnd, c, p)
      if (y1 <= y0) continue

      // 顶/底端 inset，避开与单元格左上/左下角重叠导致的"视觉打结"
      const isFirstSegCol = c === startCol
      const isLastSegCol  = c === endCol
      const topInset = isFirstSegCol ? 2 : 0
      const botInset = isLastSegCol ? 2 : 0
      const py0 = y0 + topInset
      const py1 = y1 - botInset
      if (py1 <= py0) continue

      // 单根粗实心轨：简洁、清晰、对比度高
      const barX = lx + 1
      const barW = (rx - lx) - 1   // ~5px 粗度
      ctx.save()
      ctx.shadowColor = hexToRgba(vivid, isHighlighted ? 0.9 : 0.55)
      ctx.shadowBlur = isHighlighted ? 8 : 4
      ctx.fillStyle = vivid
      ctx.fillRect(barX, py0, barW, py1 - py0)
      ctx.restore()

      // 单层顶部高光（只在首列顶部有），增加立体感但不再跟轨道边框同位
      if (isFirstSegCol) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.fillRect(barX, py0, barW, 1)
      }

      // 管内图标：非高亮时靠近右侧（贴着标签矩形左边缘），高亮时由横线标签代替
      if (!isHighlighted && getIcon) {
        const appName = span.group_name ?? span.title
        const icon = getIcon(appName)
        if (icon && y1 - y0 >= PIPE_ICON_SIZE) {
          const tagLeftX = cx + p.traceBaseX + traceWidth + TRACE_GAP
          const iconX = tagLeftX - PIPE_ICON_SIZE - 1
          const iconY = y0 + (y1 - y0) / 2 - PIPE_ICON_SIZE / 2
          ctx.drawImage(icon, iconX, iconY, PIPE_ICON_SIZE, PIPE_ICON_SIZE)
        }
      }
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
      const y0 = minuteToY(segStart, c, p)
      const y1 = minuteToY(segEnd, c, p)
      if (y1 <= y0) continue

      const isFirstSegCol = c === startCol
      const isLastSegCol  = c === endCol
      const topInset = isFirstSegCol ? 2 : 0
      const botInset = isLastSegCol ? 2 : 0
      const py0 = y0 + topInset
      const py1 = y1 - botInset
      if (py1 <= py0) continue

      const barX = lx + 1
      const barW = (rx - lx) - 1
      ctx.save()
      ctx.shadowColor = hexToRgba(vivid, 0.55)
      ctx.shadowBlur = 4
      ctx.fillStyle = vivid
      ctx.fillRect(barX, py0, barW, py1 - py0)
      ctx.restore()

      if (isFirstSegCol) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.fillRect(barX, py0, barW, 1)
      }
    }
  }
}

/** ManicTime 标签标题 */
function drawTagTitles(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  spans: MtSpan[],
) {
  const textLeftPad = p.traceBaseX + traceWidth + TRACE_GAP + 6
  const maxTextW    = p.cellW - textLeftPad - 4
  if (maxTextW <= 0) return

  const fontSize = p.fs(12)
  const lineH    = Math.max(8, Math.round(fontSize * 1.4))

  for (const span of spans) {
    if (span.track !== 'tags') continue
    const startMin = dtToMinute(span.start_at)
    const endMin   = dtToMinute(span.end_at)
    if (endMin <= startMin) continue

    const startCol = Math.floor(startMin / p.minutesPerCol)
    if (startCol >= p.cols) continue

    const colStartMin = startCol * p.minutesPerCol
    const segStart    = Math.max(startMin, colStartMin)
    const segEnd      = Math.min(endMin, (startCol + 1) * p.minutesPerCol)

    const x  = colX(startCol, p) + textLeftPad
    const y0 = minuteToY(segStart, startCol, p)
    const y1 = minuteToY(segEnd, startCol, p)
    if (y1 - y0 < lineH) continue

    // 取标签路径最后一段（排除 :xxx 标记）
    const { parts, markers } = parseTagTitle(span.title)
    const label = parts[parts.length - 1] ?? ''
    if (!label) continue
    const markerStr = markers.length ? ` [${markers.join('·')}]` : ''

    ctx.font = `bold ${fontSize}px 'JetBrains Mono', 'Courier New', monospace`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#ffffff'

    const lines = wrapText(ctx, label, maxTextW)
    let drawY = y0 + lineH
    for (const line of lines) {
      if (drawY > y1) break
      ctx.fillText(line, x, drawY)
      drawY += lineH
    }
    // 标记徽章（:billable 等），小字追加
    if (markerStr && drawY <= y1) {
      ctx.font = `500 ${p.fs(8)}px 'JetBrains Mono', 'Courier New', monospace`
      ctx.fillStyle = 'rgba(255,220,100,0.75)'
      ctx.fillText(markerStr, x, drawY)
    }
  }
}

const traceWidth = 8      // tag fill 区起始偏移（保持不变）
const BILI_COLOR    = '#FB7299'
const BILI_YELLOW   = '#F5C842'

// ── Canvas 绘制函数 ──

function drawGrid(ctx: CanvasRenderingContext2D, p: ReturnType<typeof getGridParams>) {
  const blue = theme.electricBlue
  // 区时边界精确分钟数（包括 0 点）
  const ZONE_BOUNDARY_MINS = new Set([0, 5*60, 7*60, 12*60, 18*60, 20*60])
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
  const ZONE_BOUNDARY_MINS = new Set([0, 5*60, 7*60, 12*60, 18*60, 20*60])
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
  ctx.shadowBlur = 6
  ctx.beginPath()
  ctx.moveTo(cx - 6, y); ctx.lineTo(cx + p.cellW + 6, y)
  ctx.strokeStyle = lineGrad
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()

  // ── 中段刻度（线上每 ~1/4 处一个小方点） ──
  ctx.save()
  ctx.fillStyle = hexToRgba(cyan, 0.85)
  ctx.shadowColor = cyan
  ctx.shadowBlur = 4
  for (const r of [0.25, 0.5, 0.75]) {
    const tx = cx + p.cellW * r
    ctx.fillRect(tx - 0.5, y - 2, 1, 4)
  }
  ctx.restore()

  // ── 两端 L 角端盖 ──
  ctx.save()
  ctx.strokeStyle = cyan
  ctx.lineWidth = 1.2
  ctx.shadowColor = cyan
  ctx.shadowBlur = 5
  const lArm = 5
  ctx.beginPath()
  // 左端
  ctx.moveTo(cx, y - lArm); ctx.lineTo(cx, y + lArm)
  // 右端
  ctx.moveTo(cx + p.cellW, y - lArm); ctx.lineTo(cx + p.cellW, y + lArm)
  ctx.stroke()
  ctx.restore()

  // ── 右侧 HUD 时间指示：时间文本贴线，NOW 小标签 + 脉冲圆点组成扁平 chip ──
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  ctx.font = `700 ${p.fs(11)}px 'JetBrains Mono', 'Courier New', monospace`
  const timeW = ctx.measureText(timeStr).width

  ctx.font = `700 ${p.fs(7)}px 'JetBrains Mono', 'Courier New', monospace`
  const nowLabelW = ctx.measureText('NOW').width

  const padX = 6
  const dotSize = 4
  const gap = 5
  const chipW = padX + dotSize + gap + nowLabelW + 6 + timeW + padX
  const chipH = 16
  // 原位：右侧（列末尾 + 箭头短连线 + 间距）
  const chipX = cx + p.cellW + 10
  const chipY = y - chipH / 2

  // chip → 列末的指向短连线（不覆盖右端 L 角端盖）
  ctx.save()
  ctx.strokeStyle = cyan
  ctx.lineWidth = 1
  ctx.shadowColor = cyan
  ctx.shadowBlur = 4
  ctx.beginPath()
  ctx.moveTo(cx + p.cellW + 3, y); ctx.lineTo(chipX, y)
  ctx.stroke()
  ctx.restore()

  // chip 主体（斜切 + 顶/底保留空间，让扫描线视觉上"穿过"chip 中央）
  chamferPath(ctx, chipX, chipY, chipW, chipH, 3)
  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = 10 * pulse
  // 背景半透明，让扫描线能从 chip 中间隐约"贯穿"
  ctx.fillStyle = 'rgba(2,14,28,0.78)'
  ctx.fill()
  ctx.strokeStyle = cyan
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()

  // 扫描线"穿过"chip：在 chip 内沿 y 再画一条细亮线（贴着文本基线），强化"文本在线上"的观感
  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = 5
  const innerGrad = ctx.createLinearGradient(chipX, y, chipX + chipW, y)
  innerGrad.addColorStop(0, hexToRgba(cyan, 0.0))
  innerGrad.addColorStop(0.15, hexToRgba(cyan, 0.55))
  innerGrad.addColorStop(0.85, hexToRgba(cyan, 0.55))
  innerGrad.addColorStop(1, hexToRgba(cyan, 0.0))
  ctx.strokeStyle = innerGrad
  ctx.lineWidth = 0.8
  ctx.beginPath()
  ctx.moveTo(chipX + 1, y); ctx.lineTo(chipX + chipW - 1, y)
  ctx.stroke()
  ctx.restore()

  // 脉冲小圆点（左端，落在 y 上）
  ctx.save()
  ctx.fillStyle = cyan
  ctx.shadowColor = cyan
  ctx.shadowBlur = 6 * pulse
  const dotCx = chipX + padX + dotSize / 2
  ctx.beginPath()
  ctx.arc(dotCx, y, dotSize / 2 * (0.7 + 0.3 * pulse), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // NOW 小标签（文字在线上）
  ctx.save()
  ctx.font = `700 ${p.fs(7)}px 'JetBrains Mono', 'Courier New', monospace`
  ctx.fillStyle = hexToRgba(cyan, 0.78)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('NOW', chipX + padX + dotSize + gap, y + 0.5)
  ctx.restore()

  // 时间主文本（贴在线上，白色+青光）
  ctx.save()
  ctx.font = `700 ${p.fs(11)}px 'JetBrains Mono', 'Courier New', monospace`
  ctx.fillStyle = '#FFFFFF'
  ctx.shadowColor = cyan
  ctx.shadowBlur = 6
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(timeStr, chipX + padX + dotSize + gap + nowLabelW + 6, y + 0.5)
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
  spans: MtSpan[],
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

  // 当前列的分钟
  const rBlock = Math.floor(relY / p.rowStride)
  if (rBlock >= p.rows) return null
  const localY = relY - rBlock * p.rowStride
  const minuteInCell = localY < p.cellH ? Math.min(Math.floor(localY / p.minuteH), 4) : 4
  const minute = col * p.minutesPerCol + rBlock * 5 + minuteInCell

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
    let hoveredAppSpan: MtSpan | null = null
    for (const span of spans) {
      if (span.track !== 'apps') continue
      const startMin = dtToMinute(span.start_at)
      const endMin   = dtToMinute(span.end_at)
      if (minute < startMin || minute >= endMin) continue
      hoveredAppSpan = span
      highlightPipeSpan(startMin, endMin, span.color ?? '#888888')
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


// ── 主组件 ──

export default function DayNightChart({ activities, mtSpans = [], biliSpans = [], selectedDate, onSpanClick, onSpanHover, onAppSpanHover, onBiliSpanHover, trackMode = 'apps', onTrackModeChange, pinnedPos, onPinPos, onDeleteMinuteRange }: Props) {
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
  const hoveredTagSpanRef = useRef<MtSpan | null>(null)
  // 悬浮的 app span（用于右侧栏面板）
  const hoveredAppSpanRef = useRef<MtSpan | null>(null)
  // 图标缓存（group_name → img | null | 'loading'）
  const iconCacheRef = useRef<Map<string, HTMLImageElement | null | 'loading'>>(new Map())
  // 指向最新 scheduleRedraw（用于图标加载后触发重绘）
  const redrawRef = useRef<(() => void) | null>(null)
  // 拖拽框选

  const dpr = window.devicePixelRatio || 1

  // 悬浮的 bili span
  const hoveredBiliSpanRef = useRef<BiliSpan | null>(null)

  // 列首右键菜单
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; startMin: number; endMin: number } | null>(null)

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

  // Bili span 时间重叠修正：后者开始时间衔接前者结束时间
  const adjustedBiliSpans = useMemo((): BiliSpan[] => {
    if (!biliSpans.length) return biliSpans
    const sorted = [...biliSpans].sort((a, b) => dtToMinute(a.start_at) - dtToMinute(b.start_at))
    const result: BiliSpan[] = []
    let prevEndMin = -Infinity
    for (const span of sorted) {
      const startMin = dtToMinute(span.start_at)
      const endMin   = dtToMinute(span.end_at)
      if (endMin <= startMin) continue
      const adjStart = Math.max(startMin, prevEndMin)
      if (adjStart >= endMin) continue
      if (adjStart !== startMin) {
        const datePart = span.start_at.split(' ')[0] ?? ''
        const h = Math.floor(adjStart / 60), m = adjStart % 60
        result.push({ ...span, start_at: `${datePart} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00` })
      } else {
        result.push(span)
      }
      prevEndMin = endMin
    }
    return result
  }, [biliSpans])

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
    drawTagFills(ctx, p, mtSpans, hoveredSpanId)
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
      img.src = `http://localhost:3000/api/manictime/app-icon?name=${encodeURIComponent(name)}`
      return null
    }

    // 当前高亮 app span（固定或悬浮），用于管内图标隐藏
    let highlightedAppSpanId: number | null = null
    if (trackMode === 'apps') {
      if (pinnedPos != null) {
        const pinnedMin = pinnedPos.minute
        const pinnedSpan = mtSpans.find(s => s.track === 'apps' && pinnedMin >= dtToMinute(s.start_at) && pinnedMin < dtToMinute(s.end_at))
        highlightedAppSpanId = pinnedSpan?.id ?? null
      } else {
        highlightedAppSpanId = hoveredAppSpanRef.current?.id ?? null
      }
    }

    if (trackMode === 'apps') drawAppTraces(ctx, p, mtSpans, getIcon, highlightedAppSpanId)
    else drawBiliTracesInPipe(ctx, p, adjustedBiliSpans)
    drawTagTitles(ctx, p, mtSpans)


    drawNowTick(ctx, p, isToday)

    if (pinnedPos != null) {
      const badge = drawCrosshair(ctx, p, pinnedPos.col, pinnedPos.y, mtSpans, true, getIcon, trackMode, adjustedBiliSpans)
      pinBadgeRef.current = badge
      if (_mouseY !== null && _hovCol !== null && _hovCol !== pinnedPos.col) {
        drawCrosshair(ctx, p, _hovCol, _mouseY, mtSpans, false, getIcon, trackMode, adjustedBiliSpans)
      }
    } else {
      if (_mouseY !== null && _hovCol !== null) {
        pinBadgeRef.current = drawCrosshair(ctx, p, _hovCol, _mouseY, mtSpans, false, getIcon, trackMode, adjustedBiliSpans)
      } else {
        pinBadgeRef.current = null
      }
    }

    ctx.restore()
  }, [p, mtSpans, adjustedBiliSpans, trackMode, isToday, dpr, pinnedPos]) // eslint-disable-line react-hooks/exhaustive-deps

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

  function getHitAt(e: React.MouseEvent<HTMLCanvasElement>): { minute: number; snappedEnd: number; hit: ChronosActivity | undefined; hitSpan: MtSpan | undefined } | null {
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
    const hit = activities.find((a) => m >= a.startMinute && m < a.endMinute)
    const hitSpan = mtSpans.find((s) => s.track === 'tags' && m >= dtToMinute(s.start_at) && m < dtToMinute(s.end_at))
    return { minute: snapped, snappedEnd, hit, hitSpan }
  }

  function spanFromMinute(m: number): MtSpan | undefined {
    return mtSpans.find((s) => s.track === 'tags' && m >= dtToMinute(s.start_at) && m < dtToMinute(s.end_at))
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = xToCol(x, p)
    const rBlock = Math.floor((y - p.topPad) / p.rowStride)

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
        canvasRef.current!.style.cursor = 'crosshair'
      } else {
        // ── 普通 hover ──
        const localY = y - p.topPad - rBlock * p.rowStride
        const extraMin = Math.min(Math.floor(localY / p.minuteH), 4)
        const m = c * p.minutesPerCol + rBlock * 5 + extraMin
        const hitSpan = spanFromMinute(m)
        hoveredSpanIdRef.current = hitSpan?.id ?? null
        canvasRef.current!.style.cursor = hitSpan ? 'pointer' : 'crosshair'

        mouseYRef.current = y

        // 检测 tag span hover
        if (hitSpan !== hoveredTagSpanRef.current) {
          hoveredTagSpanRef.current = hitSpan ?? null
          onSpanHover?.(hitSpan ?? null)
        }

        // 检测管线 span hover（按 trackMode 切换）
        if (trackMode === 'apps') {
          const appSpan = mtSpans.find(
            (s) => s.track === 'apps' && m >= dtToMinute(s.start_at) && m < dtToMinute(s.end_at)
          ) ?? null
          if (appSpan !== hoveredAppSpanRef.current) {
            hoveredAppSpanRef.current = appSpan
            onAppSpanHover?.(appSpan)
          }
          // 清除 bili hover
          if (hoveredBiliSpanRef.current !== null) {
            hoveredBiliSpanRef.current = null
            onBiliSpanHover?.(null)
          }
        } else {
          const bSpan = adjustedBiliSpans.find(
            (s) => m >= dtToMinute(s.start_at) && m < dtToMinute(s.end_at)
          ) ?? null
          if (bSpan !== hoveredBiliSpanRef.current) {
            hoveredBiliSpanRef.current = bSpan
            onBiliSpanHover?.(bSpan)
          }
          // 清除 app hover
          if (hoveredAppSpanRef.current !== null) {
            hoveredAppSpanRef.current = null
            onAppSpanHover?.(null)
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
        canvasRef.current!.style.cursor = 'crosshair'
      } else {
        mouseYRef.current = null
        if (hoveredTagSpanRef.current !== null) {
          hoveredTagSpanRef.current = null
          onSpanHover?.(null)
        }
        if (hoveredAppSpanRef.current !== null) {
          hoveredAppSpanRef.current = null
          onAppSpanHover?.(null)
        }
        canvasRef.current!.style.cursor = 'crosshair'
      }
    }
    scheduleRedraw()
  }

  function handleMouseUp(_e: React.MouseEvent<HTMLCanvasElement>) {
    scheduleRedraw()
  }

  function handleMouseLeave() {
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
        onAppSpanHover?.(null)
      }
      if (hoveredBiliSpanRef.current !== null) {
        hoveredBiliSpanRef.current = null
        onBiliSpanHover?.(null)
      }
    } else {
      // 固定模式：清 mouseYRef（固定线由 pinnedPos.y 驱动），span 不清（右侧栏由 pinnedPos.minute 驱动）
      mouseYRef.current = null
    }
    if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair'
    scheduleRedraw()
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
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
        const extraMin2 = Math.min(Math.floor(localY2 / p.minuteH), 4)
        const rawMinute = c2 * p.minutesPerCol + rBlock2 * 5 + extraMin2
        onPinPos?.({ col: c2, y: cy, minute: rawMinute })
      }
      return
    }

    const info = getHitAt(e)
    if (info?.hitSpan) onSpanClick?.(info.hitSpan)
  }

  function handleContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    // 点击在列首时间标签区（topPad 以上）→ 显示删除菜单
    if (y <= p.topPad) {
      const c = xToCol(x, p)
      if (c >= 0 && c < p.cols) {
        const startMin = c * p.minutesPerCol
        const endMin = startMin + p.minutesPerCol
        const inRange = activities.filter((a) => a.startMinute < endMin && a.endMinute > startMin)
        if (inRange.length > 0) {
          setCtxMenu({ x: e.clientX, y: e.clientY, startMin, endMin })
          return
        }
      }
    }
    setCtxMenu(null)
  }

  // 自动滚动到当前时间 / 最早活动
  // 只在日期切换时触发，不随活动增删重置位置
  const scrollKeyRef = useRef('')
  useEffect(() => {
    const key = selectedDate.toDateString()
    if (scrollKeyRef.current === key) return
    scrollKeyRef.current = key

    const container = containerRef.current
    if (!container) return
    let targetMin: number
    if (isToday) {
      const now = new Date()
      targetMin = now.getHours() * 60 + now.getMinutes()
    } else {
      const earliest = activities.length > 0
        ? Math.min(...activities.map((a) => a.startMinute))
        : 0
      targetMin = Math.max(0, earliest - p.minutesPerCol)
    }
    const targetCol = Math.max(0, Math.floor(targetMin / p.minutesPerCol) - 1)
    const scrollX = targetCol * p.colStride
    setTimeout(() => { container.scrollLeft = scrollX }, 100)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, isToday, p.minutesPerCol, p.colStride])

  // 图例：从 ManicTime tags 提取一级标签
  const tagLegend = useMemo(() => {
    const map = new Map<string, string>() // name → color
    ;(mtSpans ?? []).filter((s) => s.track === 'tags').forEach((s) => {
      const { parts } = parseTagTitle(s.title)
      const firstName = parts[0]
      if (firstName && !map.has(firstName)) {
        map.set(firstName, s.color ?? '#4488ff')
      }
    })
    return [...map.entries()]
  }, [mtSpans])

  const tagSpans = (mtSpans ?? []).filter((s) => s.track === 'tags')
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
        background: theme.background, position: 'relative',
      }}
      onClick={() => setCtxMenu(null)}
    >
      {/* HUD 边框：围绕整个昼夜表，绝对覆盖不占布局 */}
      <HudFrame
        color={theme.electricBlue}
        accent={theme.warningOrange}
        showNotchTop={false}
        showNotchBottom={false}
        showConnectors={false}
        cornerSize={14}
        rivets={false}
        intensity="soft"
      />

      {/* 列首右键菜单 */}
      {ctxMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', left: ctxMenu.x, top: ctxMenu.y,
            zIndex: 9999,
            background: 'rgba(2,8,20,0.97)',
            border: `1px solid ${theme.dangerRed}60`,
            borderRadius: 4,
            boxShadow: `0 4px 20px rgba(0,0,0,0.6), 0 0 12px ${theme.dangerRed}20`,
            minWidth: 180,
            fontFamily: theme.fontBody,
          }}
        >
          <div style={{ padding: '6px 12px', fontSize: 10, color: theme.textMuted, borderBottom: `1px solid ${theme.divider}` }}>
            {fmt(ctxMenu.startMin)} — {fmt(ctxMenu.endMin)}
          </div>
          <button
            onClick={() => {
              onDeleteMinuteRange?.(ctxMenu.startMin, ctxMenu.endMin)
              setCtxMenu(null)
            }}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 12px', fontSize: 12,
              background: 'transparent', border: 'none',
              color: theme.dangerRed, cursor: 'pointer',
              fontFamily: theme.fontBody,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = `${theme.dangerRed}18` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
          >
            删除此时段全部活动
          </button>
        </div>
      )}

      {/* 管线模式切换（HUD 风格斜切按钮） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 14px 6px 12px', flexShrink: 0,
        borderBottom: `1px solid ${hexToRgba(theme.electricBlue, 0.12)}`,
      }}>
        <span style={{
          fontFamily: theme.fontMono, fontSize: 10.5, fontWeight: 700,
          letterSpacing: 2, color: theme.electricBlue,
          textShadow: `0 0 6px ${hexToRgba(theme.electricBlue, 0.55)}`,
          paddingRight: 6,
          borderRight: `1px solid ${hexToRgba(theme.electricBlue, 0.45)}`,
          marginRight: 2,
        }}>
          左侧管道数据源
        </span>
        {(['apps', 'bili'] as const).map((mode) => {
          const active = trackMode === mode
          const label = mode === 'apps' ? '应用程序' : '哔哩哔哩'
          const color = mode === 'apps' ? theme.electricBlue : BILI_COLOR
          return (
            <button
              key={mode}
              onClick={() => onTrackModeChange?.(mode)}
              className="daynight-track-btn"
              data-active={active ? '1' : '0'}
              style={{
                position: 'relative',
                background: active
                  ? `linear-gradient(90deg, ${hexToRgba(color, 0.22)} 0%, ${hexToRgba(color, 0.06)} 100%)`
                  : 'transparent',
                border: `1px solid ${active ? hexToRgba(color, 0.7) : hexToRgba(color, 0.25)}`,
                clipPath: 'polygon(4px 0, calc(100% - 4px) 0, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0 calc(100% - 4px), 0 4px)',
                WebkitClipPath: 'polygon(4px 0, calc(100% - 4px) 0, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0 calc(100% - 4px), 0 4px)',
                cursor: 'pointer',
                padding: '3px 14px',
                fontFamily: theme.fontBody,
                fontSize: 11.5, fontWeight: 700,
                color: active ? color : hexToRgba(color, 0.55),
                textShadow: active ? `0 0 6px ${hexToRgba(color, 0.6)}` : undefined,
                boxShadow: active ? `0 0 10px ${hexToRgba(color, 0.35)}, inset 0 0 8px ${hexToRgba(color, 0.18)}` : undefined,
                transition: 'color 0.15s, background 0.15s, box-shadow 0.15s, border-color 0.15s',
                letterSpacing: 1.2,
              }}
            >
              {active && (
                <span style={{
                  position: 'absolute', left: -4, top: '50%',
                  width: 3, height: 10, transform: 'translateY(-50%)',
                  background: color, boxShadow: `0 0 6px ${color}`,
                  pointerEvents: 'none',
                }} />
              )}
              {label}
            </button>
          )
        })}
      </div>

      {/* 图表滚动区：flex:1 直接填满，保持原响应式高度测量 */}
      <div
        ref={containerRef}
        style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', cursor: 'crosshair' }}
      >
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

      {/* 图例（HUD 风格） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '6px 14px 8px', flexWrap: 'wrap',
        borderTop: `1px solid ${hexToRgba(theme.electricBlue, 0.12)}`,
        background: `linear-gradient(180deg, ${hexToRgba(theme.electricBlue, 0.03)} 0%, transparent 100%)`,
      }}>
        <span style={{
          fontFamily: theme.fontMono, fontSize: 10.5, fontWeight: 700,
          letterSpacing: 2, color: theme.electricBlue,
          textShadow: `0 0 6px ${hexToRgba(theme.electricBlue, 0.55)}`,
          paddingRight: 8,
          borderRight: `1px solid ${hexToRgba(theme.electricBlue, 0.45)}`,
        }}>
          标签图例
        </span>
        {tagLegend.map(([name, color]) => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 14, height: 10, flexShrink: 0,
              clipPath: 'polygon(2px 0, calc(100% - 2px) 0, 100% 2px, 100% calc(100% - 2px), calc(100% - 2px) 100%, 2px 100%, 0 calc(100% - 2px), 0 2px)',
              WebkitClipPath: 'polygon(2px 0, calc(100% - 2px) 0, 100% 2px, 100% calc(100% - 2px), calc(100% - 2px) 100%, 2px 100%, 0 calc(100% - 2px), 0 2px)',
              background: color,
              borderLeft: `2px solid ${color}`,
            }} />
            <span style={{
              fontFamily: theme.fontBody,
              fontSize: 12, fontWeight: 600,
              color: theme.textPrimary,
              letterSpacing: 0.3,
            }}>
              {name}
            </span>
          </div>
        ))}
        <span style={{
          marginLeft: 'auto',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: theme.fontMono,
          fontSize: 11, fontWeight: 700,
          color: theme.textPrimary,
          letterSpacing: 0.8,
          padding: '3px 11px',
          border: `1px solid ${hexToRgba(theme.electricBlue, 0.55)}`,
          clipPath: 'polygon(3px 0, calc(100% - 3px) 0, 100% 3px, 100% calc(100% - 3px), calc(100% - 3px) 100%, 3px 100%, 0 calc(100% - 3px), 0 3px)',
          WebkitClipPath: 'polygon(3px 0, calc(100% - 3px) 0, 100% 3px, 100% calc(100% - 3px), calc(100% - 3px) 100%, 3px 100%, 0 calc(100% - 3px), 0 3px)',
          background: `linear-gradient(90deg, ${hexToRgba(theme.electricBlue, 0.14)} 0%, ${hexToRgba(theme.electricBlue, 0.04)} 100%)`,
          boxShadow: `0 0 8px ${hexToRgba(theme.electricBlue, 0.25)}, inset 0 0 6px ${hexToRgba(theme.electricBlue, 0.08)}`,
        }}>
          <span style={{ color: theme.electricBlue, textShadow: `0 0 6px ${hexToRgba(theme.electricBlue, 0.85)}` }}>
            {tagSpans.length}
          </span>
          <span style={{ color: theme.textPrimary }}>段</span>
          <span style={{ color: hexToRgba(theme.electricBlue, 0.6) }}>·</span>
          <span style={{ color: theme.electricBlue, textShadow: `0 0 6px ${hexToRgba(theme.electricBlue, 0.85)}` }}>
            {totalTagMinutes}
          </span>
          <span style={{ color: theme.textPrimary }}>分</span>
        </span>
      </div>
    </div>
  )
}
