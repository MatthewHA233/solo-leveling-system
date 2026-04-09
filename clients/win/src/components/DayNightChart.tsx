import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import type { ChronosActivity, TraceLayout } from '../types'
import type { MtSpan, BiliSpan } from '../lib/local-api'
import { theme, getCategoryColor, getCategoryLabel } from '../theme'

interface Props {
  activities: ChronosActivity[]
  mtSpans?: MtSpan[]
  biliSpans?: BiliSpan[]
  isExpanded: boolean
  selectedDate: Date
  selection?: { startMinute: number; endMinute: number } | null
  onSpanClick?: (span: MtSpan) => void
  onSpanHover?: (span: MtSpan | null) => void
  onAppSpanHover?: (span: MtSpan | null) => void
  onBiliSpanHover?: (span: BiliSpan | null) => void
  trackMode?: 'apps' | 'bili'
  onTrackModeChange?: (mode: 'apps' | 'bili') => void
  pinnedPos?: { col: number; y: number; minute: number } | null
  onPinPos?: (pos: { col: number; y: number; minute: number } | null) => void
  onTimeSelect?: (startMinute: number, endMinute: number) => void
  onClearSelection?: () => void
  onActivityResize?: (activityId: string, newStart: number, newEnd: number) => void
  onDeleteMinuteRange?: (startMin: number, endMin: number) => void
}

// ── Grid 参数 ──
function getGridParams(isExpanded: boolean, cellHOverride?: number) {
  const minutesPerCol = isExpanded ? 60 : 30
  const cols = 1440 / minutesPerCol      // 24 or 48
  const rows = minutesPerCol / 5         // 12 or 6
  const cellW = isExpanded ? 80 : 160
  const defaultCellH = isExpanded ? 50 : 100
  const cellH = cellHOverride ?? defaultCellH
  const colGap = isExpanded ? 2 : 4
  const rowGap = 10
  const hPad = 4
  const topPad = 28
  const bottomPad = 8
  const minuteH = cellH / 5   // 每分钟高度随 cellH 等比例缩放
  const traceBaseX = isExpanded ? 3 : 5
  const trackSp = isExpanded ? 7 : 8
  const colStride = cellW + colGap
  const rowStride = cellH + rowGap
  const gridH = rows * rowStride - rowGap
  const totalW = hPad + cols * colStride + 16
  const totalH = topPad + gridH + bottomPad
  return {
    minutesPerCol, cols, rows, cellW, cellH, colGap, rowGap,
    hPad, topPad, bottomPad, minuteH, traceBaseX, trackSp,
    colStride, rowStride, gridH, totalW, totalH,
  }
}

function colX(col: number, p: ReturnType<typeof getGridParams>) {
  return p.hPad + col * p.colStride
}

function fmt(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function computeLayouts(activities: ChronosActivity[]): TraceLayout[] {
  const sorted = [...activities].sort((a, b) => a.startMinute - b.startMinute)
  const result: TraceLayout[] = []
  const ends: number[] = []
  for (const a of sorted) {
    let t = ends.findIndex((e) => a.startMinute >= e)
    if (t === -1) { t = ends.length; ends.push(a.endMinute) }
    else ends[t] = a.endMinute
    result.push({ activity: a, trackIndex: Math.min(t, 2) })
  }
  return result
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

function getZoneInfo(hour: number): ZoneInfo {
  if (hour < 5)  return { label: '凌晨', bgColor: [0,   20,  80],  bgAlpha: 0.16, textColor: 'rgba(100,150,255,0.75)' }
  if (hour < 7)  return { label: '清晨', bgColor: [160, 80,  20],  bgAlpha: 0.10, textColor: 'rgba(255,180,80,0.85)'  }
  if (hour < 12) return { label: '上午', bgColor: [20,  100, 180], bgAlpha: 0.07, textColor: 'rgba(140,210,255,0.75)' }
  if (hour < 18) return { label: '下午', bgColor: [160, 130, 10],  bgAlpha: 0.07, textColor: 'rgba(255,220,100,0.75)' }
  if (hour < 20) return { label: '黄昏', bgColor: [200, 60,  20],  bgAlpha: 0.13, textColor: 'rgba(255,120,70,0.90)'  }
  return           { label: '夜晚', bgColor: [30,  10,  80],  bgAlpha: 0.16, textColor: 'rgba(160,110,255,0.75)' }
}

const ZONE_HOURS = [0, 5, 7, 12, 18, 20]

function drawZoneBands(ctx: CanvasRenderingContext2D, p: ReturnType<typeof getGridParams>) {
  // 背景色带
  for (let c = 0; c < p.cols; c++) {
    const hour = Math.floor(c * p.minutesPerCol / 60)
    const z = getZoneInfo(hour)
    const [r, g, b] = z.bgColor
    ctx.fillStyle = `rgba(${r},${g},${b},${z.bgAlpha})`
    ctx.fillRect(colX(c, p), p.topPad, p.cellW, p.gridH)
  }

  // 时区边界线 + 顶部标签
  for (const zoneHour of ZONE_HOURS) {
    const c = Math.floor(zoneHour * 60 / p.minutesPerCol)
    if (c >= p.cols) continue
    const x = colX(c, p)
    const z = getZoneInfo(zoneHour)
    const [r, g, b] = z.bgColor

    // 边界竖线（跳过 0 点）
    if (zoneHour > 0) {
      ctx.save()
      ctx.shadowColor = `rgb(${r},${g},${b})`
      ctx.shadowBlur = 4
      ctx.beginPath()
      ctx.moveTo(x - p.colGap / 2, p.topPad)
      ctx.lineTo(x - p.colGap / 2, p.topPad + p.gridH)
      ctx.strokeStyle = `rgba(${r},${g},${b},0.35)`
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }

    // 顶部时区标签
    ctx.font = `bold 9px 'JetBrains Mono', 'Courier New', monospace`
    ctx.fillStyle = z.textColor
    ctx.textAlign = 'left'
    ctx.fillText(z.label, x + 2, 11)
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
    const opacity = hovered ? 0.75 : 0.55

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

      // 填充
      ctx.fillStyle = hexToRgba(color, opacity)
      ctx.fillRect(x, y0, w, y1 - y0)

      // 左侧亮边
      ctx.strokeStyle = hexToRgba(color, hovered ? 1.0 : 0.85)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, y0)
      ctx.lineTo(x, y1)
      ctx.stroke()
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

    for (let c = startCol; c <= endCol && c < p.cols; c++) {
      const segStart = Math.max(startMin, c * p.minutesPerCol)
      const segEnd   = Math.min(endMin, (c + 1) * p.minutesPerCol)
      const cx = colX(c, p)
      const lx = cx + p.traceBaseX + PIPE_LEFT
      const rx = cx + p.traceBaseX + PIPE_RIGHT
      const y0 = minuteToY(segStart, c, p)
      const y1 = minuteToY(segEnd, c, p)
      if (y1 <= y0) continue

      ctx.beginPath()
      ctx.moveTo(lx, y0); ctx.lineTo(lx, y1)
      ctx.strokeStyle = hexToRgba(color, 0.85)
      ctx.lineWidth = 1.5; ctx.lineCap = 'butt'; ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(rx, y0); ctx.lineTo(rx, y1)
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1; ctx.lineCap = 'butt'; ctx.stroke()

      // 管内图标：非高亮时在左轨右侧绘制（高亮时图标随横线标签显示，视觉上"移位"）
      if (!isHighlighted && getIcon) {
        const appName = span.group_name ?? span.title
        const icon = getIcon(appName)
        if (icon && y1 - y0 >= PIPE_ICON_SIZE) {
          const iconX = lx + 1
          const iconY = y0 + (y1 - y0) / 2 - PIPE_ICON_SIZE / 2
          ctx.save()
          ctx.globalAlpha = 0.72
          ctx.drawImage(icon, iconX, iconY, PIPE_ICON_SIZE, PIPE_ICON_SIZE)
          ctx.restore()
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

      ctx.beginPath()
      ctx.moveTo(lx, y0); ctx.lineTo(lx, y1)
      ctx.strokeStyle = hexToRgba(railColor, 0.85)
      ctx.lineWidth = 1.5; ctx.lineCap = 'butt'; ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(rx, y0); ctx.lineTo(rx, y1)
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1; ctx.lineCap = 'butt'; ctx.stroke()
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

  const lineH    = 16
  const fontSize = 12

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
      ctx.font = `500 8px 'JetBrains Mono', 'Courier New', monospace`
      ctx.fillStyle = 'rgba(255,220,100,0.75)'
      ctx.fillText(markerStr, x, drawY)
    }
  }
}

const traceWidth = 8      // tag fill 区起始偏移（保持不变）
const APP_TRACE_W = 3     // ManicTime 应用管线渲染宽度
const BILI_COLOR    = '#FB7299'
const BILI_YELLOW   = '#F5C842'

// ── Canvas 绘制函数 ──

function drawGrid(ctx: CanvasRenderingContext2D, p: ReturnType<typeof getGridParams>) {
  const blue = theme.electricBlue
  const cornerLen = Math.min(8, p.cellW * 0.12, p.cellH * 0.15)

  for (let c = 0; c < p.cols; c++) {
    const hourOfCol = Math.floor(c * p.minutesPerCol / 60)
    const isNight = hourOfCol < 6 || hourOfCol >= 22
    const baseA = isNight ? 0.08 : 0.15

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

      // 四角高亮 bracket
      ctx.strokeStyle = hexToRgba(blue, baseA * 2.5)
      ctx.lineWidth = 1
      // 左上
      ctx.beginPath()
      ctx.moveTo(x, y + cornerLen)
      ctx.lineTo(x, y)
      ctx.lineTo(x + cornerLen, y)
      ctx.stroke()
      // 右上
      ctx.beginPath()
      ctx.moveTo(x + w - cornerLen, y)
      ctx.lineTo(x + w, y)
      ctx.lineTo(x + w, y + cornerLen)
      ctx.stroke()
      // 左下
      ctx.beginPath()
      ctx.moveTo(x, y + h - cornerLen)
      ctx.lineTo(x, y + h)
      ctx.lineTo(x + cornerLen, y + h)
      ctx.stroke()
      // 右下
      ctx.beginPath()
      ctx.moveTo(x + w - cornerLen, y + h)
      ctx.lineTo(x + w, y + h)
      ctx.lineTo(x + w, y + h - cornerLen)
      ctx.stroke()
    }
  }

  // 6 小时大分隔线（带 glow）
  for (let hour = 6; hour <= 18; hour += 6) {
    const c = Math.floor(hour * 60 / p.minutesPerCol)
    if (c < 0 || c >= p.cols) continue
    const x = colX(c, p) - p.colGap / 2

    // glow
    ctx.save()
    ctx.shadowColor = blue
    ctx.shadowBlur = 6
    ctx.beginPath()
    ctx.moveTo(x, p.topPad)
    ctx.lineTo(x, p.topPad + p.gridH)
    ctx.strokeStyle = hexToRgba(blue, 0.2)
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()

    // 实线
    ctx.beginPath()
    ctx.moveTo(x, p.topPad)
    ctx.lineTo(x, p.topPad + p.gridH)
    ctx.strokeStyle = hexToRgba(blue, 0.3)
    ctx.lineWidth = 0.5
    ctx.stroke()
  }
}

function drawTimeLabels(ctx: CanvasRenderingContext2D, p: ReturnType<typeof getGridParams>) {
  ctx.textAlign = 'center'
  for (let c = 0; c < p.cols; c++) {
    const x = colX(c, p) + p.cellW / 2
    const colStartMin = c * p.minutesPerCol
    const major = colStartMin % 360 === 0
    ctx.font = `${major ? 'bold' : '500'} ${major ? 12 : 10}px 'JetBrains Mono', 'Courier New', monospace`
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
      ctx.font = `${isMajor ? 'bold' : 'normal'} ${isMajor ? 10 : 9}px 'JetBrains Mono', 'Courier New', monospace`
      ctx.fillStyle = theme.textSecondary
      ctx.fillText(fmt(boundaryMin), cx, gapY + 3)
    }
  }
}

function drawCellFills(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  layouts: TraceLayout[],
  hoveredId: string | null,
) {
  for (const layout of layouts) {
    const a = layout.activity
    const color = getCategoryColor(a.category)
    const hovered = hoveredId === a.id
    const opacity = hovered ? 0.75 : 0.55

    // 按列绘制连续实心矩形（贯穿行间隙）
    const startCol = Math.floor(a.startMinute / p.minutesPerCol)
    const endCol = Math.floor((a.endMinute - 1) / p.minutesPerCol)

    for (let c = startCol; c <= endCol && c < p.cols; c++) {
      const colStartMin = c * p.minutesPerCol
      const colEndMin = (c + 1) * p.minutesPerCol
      const actStart = Math.max(a.startMinute, colStartMin)
      const actEnd = Math.min(a.endMinute, colEndMin)

      const y0 = minuteToY(actStart, c, p)
      const y1 = minuteToY(actEnd, c, p)
      const x = colX(c, p)

      ctx.fillStyle = hexToRgba(color, opacity)
      ctx.fillRect(x, y0, p.cellW, y1 - y0)
    }
  }
}

function drawTraceSegments(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  layouts: TraceLayout[],
  hoveredId: string | null,
  glow: boolean,
) {
  for (const layout of layouts) {
    const a = layout.activity
    const color = getCategoryColor(a.category)
    const hovered = hoveredId === a.id
    const trackX = p.traceBaseX + layout.trackIndex * p.trackSp
    const traceW = 3.0

    let m = a.startMinute
    while (m < a.endMinute) {
      const c = Math.floor(m / p.minutesPerCol)
      const r = Math.floor((m % p.minutesPerCol) / 5)
      if (c >= p.cols || r >= p.rows) break
      const cellStart = c * p.minutesPerCol + r * 5
      const cellEnd = cellStart + 5
      const localStart = Math.max(a.startMinute, cellStart) - cellStart
      const localEnd = Math.min(a.endMinute, cellEnd) - cellStart
      const cx = colX(c, p)
      const cy = p.topPad + r * p.rowStride
      const x = cx + trackX
      const y0 = cy + localStart * p.minuteH
      const y1 = cy + localEnd * p.minuteH

      const lw = glow ? traceW + 2 : (hovered ? traceW + 0.5 : traceW)
      const op = glow ? 1.0 : 1.0
      ctx.beginPath()
      ctx.moveTo(x, y0)
      ctx.lineTo(x, y1)
      ctx.strokeStyle = hexToRgba(color, op)
      ctx.lineWidth = lw
      ctx.lineCap = 'round'
      ctx.stroke()

      if (!glow) {
        // 起点矩形 cap
        if (cellStart <= a.startMinute && a.startMinute < cellEnd) {
          ctx.fillStyle = color
          ctx.fillRect(x - 3, y0 - 1.5, 6, 3)
        }
        // 终点圆 cap
        if (cellStart < a.endMinute && a.endMinute <= cellEnd) {
          ctx.beginPath()
          ctx.arc(x, y1, 3, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
        }
        // 跨行连接虚线
        if (a.endMinute > cellEnd && r < p.rows - 1) {
          const nextCy = p.topPad + (r + 1) * p.rowStride
          ctx.beginPath()
          ctx.moveTo(x, y1)
          ctx.lineTo(x, nextCy)
          ctx.strokeStyle = hexToRgba(color, 0.5)
          ctx.lineWidth = 1.5
          ctx.setLineDash([2, 3])
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
      m = cellEnd
    }
  }
}

function drawEventNodes(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  layouts: TraceLayout[],
  hoveredCell: { col: number; row: number } | null,
) {
  for (const layout of layouts) {
    const color = getCategoryColor(layout.activity.category)
    const trackX = p.traceBaseX + layout.trackIndex * p.trackSp

    for (const step of layout.activity.events) {
      const c = Math.floor(step.minute / p.minutesPerCol)
      const r = Math.floor((step.minute % p.minutesPerCol) / 5)
      if (c >= p.cols || r >= p.rows) continue
      const cellStart = c * p.minutesPerCol + r * 5
      const localMin = step.minute - cellStart
      const cx = colX(c, p)
      const cy = p.topPad + r * p.rowStride
      const x = cx + trackX
      const y = cy + localMin * p.minuteH

      const lit = hoveredCell?.col === c && hoveredCell?.row === r

      // 背景擦除圆
      const nodeR = lit ? 6 : 5
      ctx.beginPath()
      ctx.arc(x, y, nodeR, 0, Math.PI * 2)
      ctx.fillStyle = theme.background
      ctx.fill()

      // 外圆环
      const ringR = lit ? 5.5 : 4.5
      ctx.beginPath()
      ctx.arc(x, y, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.lineWidth = lit ? 2 : 1.5
      ctx.stroke()

      // 内实心点
      const dotR = lit ? 2.5 : 2
      ctx.beginPath()
      ctx.arc(x, y, dotR, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      // 序号
      ctx.font = `500 10px 'JetBrains Mono', 'Courier New', monospace`
      ctx.fillStyle = color
      ctx.textAlign = 'left'
      ctx.fillText(step.label, x + 9, y + 3)

      // hover 时显示步骤标题
      if (lit && step.title) {
        ctx.font = `600 10px 'JetBrains Mono', 'Courier New', monospace`
        ctx.fillStyle = color
        ctx.fillText(step.title, x + 9 + 16, y + 3)
      }
    }
  }
}

function drawTitles(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  layouts: TraceLayout[],
) {
  // 文字区域：三条竖线右侧到矩形右边
  const textLeftPad = p.traceBaseX + 3 * p.trackSp + 4
  const maxTextW = p.cellW - textLeftPad - 4
  if (maxTextW <= 0) return

  const lineH = 14
  const fontSize = 11

  for (const layout of layouts) {
    const a = layout.activity
    // 在活动的第一列内绘制标题
    const startCol = Math.floor(a.startMinute / p.minutesPerCol)
    if (startCol >= p.cols) continue

    const colStartMin = startCol * p.minutesPerCol
    const colEndMin = (startCol + 1) * p.minutesPerCol
    const actStart = Math.max(a.startMinute, colStartMin)
    const actEnd = Math.min(a.endMinute, colEndMin)

    const x = colX(startCol, p) + textLeftPad
    const y0 = minuteToY(actStart, startCol, p)
    const y1 = minuteToY(actEnd, startCol, p)
    const availH = y1 - y0

    if (availH < lineH) continue

    // 标题换行
    ctx.font = `bold ${fontSize}px 'JetBrains Mono', 'Courier New', monospace`
    ctx.textAlign = 'left'
    ctx.fillStyle = theme.textPrimary
    const titleLines = wrapText(ctx, a.title, maxTextW)

    let drawY = y0 + lineH
    for (const line of titleLines) {
      if (drawY > y1) break
      ctx.fillText(line, x, drawY)
      drawY += lineH
    }

    // 时间范围（标题下方，如果还有空间）
    if (drawY + lineH <= y1) {
      ctx.font = `${fontSize - 2}px 'JetBrains Mono', 'Courier New', monospace`
      ctx.fillStyle = hexToRgba(theme.textPrimary, 0.7)
      ctx.fillText(`${fmt(a.startMinute)}–${fmt(a.endMinute)}`, x, drawY)
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
  const blue = theme.electricBlue
  const cyan = '#00ffff'

  // ── 全列纵向扫描线（淡色垂直光柱） ──
  const colCenterX = cx + p.cellW / 2
  const grad = ctx.createLinearGradient(colCenterX, p.topPad, colCenterX, p.topPad + p.gridH)
  grad.addColorStop(0, 'transparent')
  grad.addColorStop(Math.max(0, (y - p.topPad - 60) / p.gridH), 'transparent')
  grad.addColorStop((y - p.topPad) / p.gridH, hexToRgba(cyan, 0.06))
  grad.addColorStop(Math.min(1, (y - p.topPad + 60) / p.gridH), 'transparent')
  grad.addColorStop(1, 'transparent')
  ctx.fillStyle = grad
  ctx.fillRect(cx, p.topPad, p.cellW, p.gridH)

  // ── 外层宽光晕 ──
  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = 20
  ctx.beginPath()
  ctx.moveTo(cx - 12, y)
  ctx.lineTo(cx + p.cellW + 12, y)
  ctx.strokeStyle = hexToRgba(cyan, 0.25)
  ctx.lineWidth = 10
  ctx.stroke()
  ctx.restore()

  // ── 内层锐利光晕 ──
  ctx.save()
  ctx.shadowColor = blue
  ctx.shadowBlur = 8
  ctx.beginPath()
  ctx.moveTo(cx, y)
  ctx.lineTo(cx + p.cellW, y)
  ctx.strokeStyle = hexToRgba(blue, 0.6)
  ctx.lineWidth = 4
  ctx.stroke()
  ctx.restore()

  // ── 主扫描线（渐变） ──
  const lineGrad = ctx.createLinearGradient(cx, y, cx + p.cellW, y)
  lineGrad.addColorStop(0, cyan)
  lineGrad.addColorStop(0.5, blue)
  lineGrad.addColorStop(1, cyan)
  ctx.beginPath()
  ctx.moveTo(cx, y)
  ctx.lineTo(cx + p.cellW, y)
  ctx.strokeStyle = lineGrad
  ctx.lineWidth = 2
  ctx.lineCap = 'butt'
  ctx.stroke()

  // ── 左侧菱形指针 ──
  const dW = 7, dH = 10
  const dx = cx - dW - 2
  ctx.beginPath()
  ctx.moveTo(dx, y)
  ctx.lineTo(dx + dW / 2, y - dH / 2)
  ctx.lineTo(dx + dW, y)
  ctx.lineTo(dx + dW / 2, y + dH / 2)
  ctx.closePath()
  // 菱形 glow
  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = 10
  ctx.fillStyle = blue
  ctx.fill()
  ctx.restore()
  // 菱形边框
  ctx.strokeStyle = cyan
  ctx.lineWidth = 1
  ctx.stroke()

  // ── 右侧小三角 ──
  const triW = 5, triH = 6
  const tx = cx + p.cellW + 2
  ctx.beginPath()
  ctx.moveTo(tx, y - triH / 2)
  ctx.lineTo(tx + triW, y)
  ctx.lineTo(tx, y + triH / 2)
  ctx.closePath()
  ctx.fillStyle = blue
  ctx.fill()

  // ── 端点光点 ──
  for (const px of [cx, cx + p.cellW]) {
    ctx.beginPath()
    ctx.arc(px, y, 3, 0, Math.PI * 2)
    ctx.fillStyle = cyan
    ctx.fill()
    ctx.beginPath()
    ctx.arc(px, y, 1.5, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
  }

  // ── 时间标签（六边形科技风） ──
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const labelW = 44, labelH = 16
  const notch = 4
  const labelX = dx - labelW - 2
  const labelY2 = y

  // 六边形背景
  ctx.beginPath()
  ctx.moveTo(labelX + notch, labelY2 - labelH / 2)
  ctx.lineTo(labelX + labelW - notch, labelY2 - labelH / 2)
  ctx.lineTo(labelX + labelW, labelY2)
  ctx.lineTo(labelX + labelW - notch, labelY2 + labelH / 2)
  ctx.lineTo(labelX + notch, labelY2 + labelH / 2)
  ctx.lineTo(labelX, labelY2)
  ctx.closePath()

  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = 12
  ctx.fillStyle = blue
  ctx.fill()
  ctx.restore()

  // 六边形边框
  ctx.strokeStyle = cyan
  ctx.lineWidth = 1
  ctx.stroke()

  // 时间文字
  ctx.font = `900 10px 'JetBrains Mono', 'Courier New', monospace`
  ctx.fillStyle = '#000'
  ctx.textAlign = 'center'
  ctx.fillText(timeStr, labelX + labelW / 2, labelY2 + 3.5)
}

// ── 空格 hover 高亮 ──

function drawHoverHighlight(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  hoverMin: number | null,
  layouts: TraceLayout[],
) {
  if (hoverMin === null) return
  const onActivity = layouts.some((l) => hoverMin >= l.activity.startMinute && hoverMin < l.activity.endMinute)
  if (onActivity) return

  const c = Math.floor(hoverMin / p.minutesPerCol)
  const row = Math.floor((hoverMin % p.minutesPerCol) / 5)
  if (c >= p.cols || row >= p.rows) return

  const x = colX(c, p)
  const y = p.topPad + row * p.rowStride
  const cyan = theme.electricBlue

  // 单格背景亮
  ctx.fillStyle = hexToRgba(cyan, 0.08)
  ctx.fillRect(x, y, p.cellW, p.cellH)

  // 边框虚线
  ctx.save()
  ctx.strokeStyle = hexToRgba(cyan, 0.35)
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.strokeRect(x + 0.5, y + 0.5, p.cellW - 1, p.cellH - 1)
  ctx.setLineDash([])
  ctx.restore()

  // 中心 + 号
  const cx = x + p.cellW / 2
  const cy = y + p.cellH / 2
  const arm = 5
  ctx.strokeStyle = hexToRgba(cyan, 0.5)
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy)
  ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm)
  ctx.stroke()

  // 时间提示
  ctx.font = `9px 'JetBrains Mono', 'Courier New', monospace`
  ctx.fillStyle = hexToRgba(cyan, 0.5)
  ctx.textAlign = 'center'
  ctx.fillText(fmt(hoverMin), cx, y + p.cellH - 5)
}

// ── 拖拽选区 ──

function drawDragSelection(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  startMin: number,
  endMin: number,
) {
  if (endMin <= startMin) return
  const cyan = theme.electricBlue
  const duration = endMin - startMin

  const startCol = Math.floor(startMin / p.minutesPerCol)
  const endCol = Math.floor(Math.max(endMin - 1, 0) / p.minutesPerCol)

  for (let c = startCol; c <= endCol && c < p.cols; c++) {
    const colStartMin = c * p.minutesPerCol
    const colEndMin = (c + 1) * p.minutesPerCol
    const segStart = Math.max(startMin, colStartMin)
    const segEnd = Math.min(endMin, colEndMin)

    const y0 = minuteToY(segStart, c, p)
    const y1 = minuteToY(segEnd, c, p)
    const x = colX(c, p)
    const h = y1 - y0

    // 填充
    ctx.fillStyle = hexToRgba(cyan, 0.18)
    ctx.fillRect(x, y0, p.cellW, h)

    // 边框
    ctx.save()
    ctx.strokeStyle = hexToRgba(cyan, 0.75)
    ctx.lineWidth = 1.5
    ctx.shadowColor = cyan
    ctx.shadowBlur = 4
    ctx.strokeRect(x + 0.5, y0 + 0.5, p.cellW - 1, h - 1)
    ctx.restore()
  }

  // 起始时间标签
  if (startCol < p.cols) {
    const sy = minuteToY(startMin, startCol, p)
    const sx = colX(startCol, p) + 4
    ctx.font = `bold 9px 'JetBrains Mono', 'Courier New', monospace`
    ctx.fillStyle = cyan
    ctx.textAlign = 'left'
    ctx.fillText(fmt(startMin), sx, sy - 2)
  }

  // 结束时间标签
  if (endCol < p.cols) {
    const ey = minuteToY(endMin, endCol, p)
    const ex = colX(endCol, p) + 4
    ctx.font = `bold 9px 'JetBrains Mono', 'Courier New', monospace`
    ctx.fillStyle = cyan
    ctx.textAlign = 'left'
    ctx.fillText(fmt(endMin), ex, ey + 9)
  }

  // 时长徽章（浮于中间列）
  const midMin = (startMin + endMin) / 2
  const midCol = Math.min(Math.floor(midMin / p.minutesPerCol), p.cols - 1)
  const midY = minuteToY(midMin, midCol, p)
  const midX = colX(midCol, p) + p.cellW / 2
  const durStr = duration < 60
    ? `${duration}m`
    : `${Math.floor(duration / 60)}h${duration % 60 ? ` ${duration % 60}m` : ''}`
  const badgeW = durStr.length * 7 + 12
  const badgeH = 15

  ctx.save()
  ctx.shadowColor = cyan
  ctx.shadowBlur = 8
  ctx.fillStyle = cyan
  ctx.fillRect(midX - badgeW / 2, midY - badgeH / 2, badgeW, badgeH)
  ctx.restore()

  ctx.font = `bold 9px 'JetBrains Mono', 'Courier New', monospace`
  ctx.fillStyle = '#000'
  ctx.textAlign = 'center'
  ctx.fillText(durStr, midX, midY + 3.5)
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
): { x: number; y: number; w: number; h: number } | null {
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
  function highlightPipeSpan(startMin: number, endMin: number, color: string) {
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
      ctx.shadowColor = color; ctx.shadowBlur = 10
      ctx.beginPath(); ctx.moveTo(lx, sy0); ctx.lineTo(lx, sy1)
      ctx.strokeStyle = hexToRgba(color, 1.0)
      ctx.lineWidth = 3.5; ctx.lineCap = 'butt'; ctx.stroke()
      ctx.beginPath(); ctx.moveTo(rx, sy0); ctx.lineTo(rx, sy1)
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.lineWidth = 1.5; ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.shadowColor = color; ctx.shadowBlur = 6
      ctx.strokeStyle = hexToRgba(color, 0.9)
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

  // 横线颜色：固定时橙色，悬浮时白色
  const lineColor = isPinned ? 'rgba(255,180,60,0.85)' : 'rgba(255,255,255,0.55)'
  const glowColor = isPinned ? 'rgba(255,180,60,0.5)' : 'rgba(255,255,255,0.4)'
  ctx.save()
  ctx.shadowColor = glowColor
  ctx.shadowBlur = 4
  ctx.beginPath()
  ctx.moveTo(x0, mouseY)
  ctx.lineTo(x1, mouseY)
  ctx.strokeStyle = lineColor
  ctx.lineWidth = isPinned ? 1 : 0.75
  ctx.stroke()
  ctx.restore()

  // ── 管线标签（图标+文本，管线右侧到列右边缘，支持换行） ──
  if (pipeLabel) {
    const hasIcon  = pipeLabelIcon !== null
    const iconSize = 14
    const gap      = 4
    const padX     = 4, padY = 3
    const lineH    = 11

    const labelX     = x0 + p.traceBaseX + PIPE_RIGHT + 6
    const maxLabelW  = x1 - labelX - 2
    const availTextW = maxLabelW - padX * 2 - (hasIcon ? iconSize + gap : 0)

    ctx.font = `500 9px 'JetBrains Mono', 'Courier New', monospace`
    const lines     = availTextW > 10 ? wrapText(ctx, pipeLabel, availTextW).slice(0, 3) : [pipeLabel]
    const textBlock = hasIcon ? Math.max(iconSize, lines.length * lineH) : lines.length * lineH
    const labelH    = padY * 2 + textBlock
    const labelY    = mouseY - labelH / 2

    ctx.save()
    ctx.fillStyle   = 'rgba(4,8,18,0.80)'
    ctx.strokeStyle = isPinned ? 'rgba(255,180,60,0.5)' : (trackMode === 'bili' ? 'rgba(251,114,153,0.3)' : 'rgba(255,255,255,0.18)')
    ctx.lineWidth   = 0.75
    ctx.beginPath()
    ctx.roundRect(labelX, labelY, maxLabelW, labelH, 3)
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    let textX = labelX + padX
    if (hasIcon && pipeLabelIcon) {
      const iconY = labelY + padY + (textBlock - iconSize) / 2
      ctx.drawImage(pipeLabelIcon, labelX + padX, iconY, iconSize, iconSize)
      textX = labelX + padX + iconSize + gap
    }

    ctx.font      = `500 9px 'JetBrains Mono', 'Courier New', monospace`
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.textAlign = 'left'
    const textStartY = labelY + padY + lineH - 1
    lines.forEach((line, i) => {
      ctx.fillText(line, textX, textStartY + i * lineH)
    })
  }

  // ── "固定"/"取消固定" badge：列右边缘（白线尽头）外侧左对齐 ──
  const label = isPinned ? '取消固定' : '固定'
  const font = `bold 9px 'JetBrains Mono', 'Courier New', monospace`
  ctx.font = font
  const textW = ctx.measureText(label).width
  const bPadX = 5, bPadY = 3
  const badgeW = textW + bPadX * 2
  const badgeH = 14
  const badgeX = x1 + 3          // 白线右端之外，左对齐
  const badgeY = mouseY - badgeH / 2

  ctx.save()
  ctx.shadowColor = isPinned ? 'rgba(255,180,60,0.6)' : 'rgba(255,255,255,0.3)'
  ctx.shadowBlur = 6
  ctx.fillStyle   = isPinned ? 'rgba(255,150,40,0.85)' : 'rgba(40,40,60,0.85)'
  ctx.strokeStyle = isPinned ? 'rgba(255,180,60,0.9)' : 'rgba(255,255,255,0.5)'
  ctx.lineWidth = 0.75
  ctx.beginPath()
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3)
  ctx.fill()
  ctx.stroke()
  ctx.restore()

  ctx.font      = font
  ctx.fillStyle = isPinned ? '#000' : 'rgba(255,255,255,0.9)'
  ctx.textAlign = 'center'
  ctx.fillText(label, badgeX + badgeW / 2, badgeY + badgeH / 2 + 3.5)

  return { x: badgeX, y: badgeY, w: badgeW, h: badgeH }
}


// ── 主组件 ──

export default function DayNightChart({ activities, mtSpans = [], biliSpans = [], isExpanded, selectedDate, selection, onSpanClick, onSpanHover, onAppSpanHover, onBiliSpanHover, trackMode = 'apps', onTrackModeChange, pinnedPos, onPinPos, onTimeSelect, onClearSelection, onActivityResize, onDeleteMinuteRange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const hoveredSpanIdRef = useRef<number | null>(null)
  const hoveredCellRef = useRef<{ col: number; row: number } | null>(null)
  const rafRef = useRef<number>(0)
  const glowImageRef = useRef<ImageBitmap | HTMLCanvasElement | null>(null)
  const glowKeyRef = useRef<string>('')
  // 十字准线位置
  const mouseYRef = useRef<number | null>(null)
  const hoveredColRef = useRef<number | null>(null)
  // 固定/取消固定标签的画布命中区域
  const pinBadgeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  // 悬浮的 tag span（用于右侧栏面板）
  const hoveredTagSpanRef = useRef<MtSpan | null>(null)
  // 悬浮的 app span（用于右侧栏面板）
  const hoveredAppSpanRef = useRef<MtSpan | null>(null)
  // 图标缓存（group_name → img | null | 'loading'）
  const iconCacheRef = useRef<Map<string, HTMLImageElement | null | 'loading'>>(new Map())
  // 指向最新 scheduleRedraw（用于图标加载后触发重绘）
  const redrawRef = useRef<(() => void) | null>(null)
  // 拖拽框选
  const isDraggingRef = useRef(false)
  const dragStartMinRef = useRef<number | null>(null)
  const dragCurMinRef = useRef<number | null>(null)
  const hoverMinRef = useRef<number | null>(null)
  // 边缘拖拽调整时间
  const edgeDragRef = useRef<{
    activity: ChronosActivity
    edge: 'start' | 'end'
    currentMinute: number
  } | null>(null)

  const dpr = window.devicePixelRatio || 1

  // 悬浮的 bili span
  const hoveredBiliSpanRef = useRef<BiliSpan | null>(null)

  // 列首右键菜单
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; startMin: number; endMin: number } | null>(null)

  // ── 响应式高度：监听可用高度，等比缩放 cellH ──
  const [chartAreaH, setChartAreaH] = useState(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setChartAreaH(entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const p = useMemo(() => {
    const base = getGridParams(isExpanded)
    if (chartAreaH <= 0 || chartAreaH <= base.totalH) {
      // 可用高度不足 → 用默认参数，允许滚动
      return base
    }
    // 可用高度充足 → 等比放大 cellH 填满
    const { rows, rowGap, topPad, bottomPad } = base
    const scaledCellH = (chartAreaH - topPad - bottomPad - (rows - 1) * rowGap) / rows
    return getGridParams(isExpanded, scaledCellH)
  }, [isExpanded, chartAreaH])
  const layouts = useMemo(() => computeLayouts(activities), [activities])

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

  // 预渲染 glow 层（只在 layouts/params 变化时重建，blur 很贵）
  useEffect(() => {
    const key = `${p.totalW}-${p.totalH}-${layouts.length}-${dpr}`
    if (glowKeyRef.current === key) return
    glowKeyRef.current = key

    const offscreen = document.createElement('canvas')
    offscreen.width = p.totalW * dpr
    offscreen.height = p.totalH * dpr
    const ctx = offscreen.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.filter = 'blur(5px)'
    drawTraceSegments(ctx, p, layouts, null, true)
    glowImageRef.current = offscreen
  }, [p, layouts, dpr])

  // 绘制
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const hoveredId = hoveredIdRef.current
    const hoveredSpanId = hoveredSpanIdRef.current
    const hoveredCell = hoveredCellRef.current

    // Edge resize 时用修改后的 activity 实时更新视觉
    const edgeRef = edgeDragRef.current
    const activeLayouts = edgeRef ? (() => {
      const a = edgeRef.activity
      const newStart = edgeRef.edge === 'start' ? edgeRef.currentMinute : a.startMinute
      const newEnd   = edgeRef.edge === 'end'   ? edgeRef.currentMinute : a.endMinute
      const modified = { ...a, startMinute: newStart, endMinute: newEnd }
      return layouts.map(l => l.activity.id === a.id ? { ...l, activity: modified } : l)
    })() : layouts

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

    // Glow 层
    if (glowImageRef.current) {
      ctx.globalAlpha = 0.3
      ctx.drawImage(glowImageRef.current, 0, 0, p.totalW, p.totalH)
      ctx.globalAlpha = 1.0
    }

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

    // 选区（最顶层）：拖拽中显示拖拽选区，松手后显示常驻选区
    if (isDraggingRef.current && dragStartMinRef.current !== null && dragCurMinRef.current !== null) {
      const selStart = Math.min(dragStartMinRef.current, dragCurMinRef.current)
      const selEnd = Math.max(dragStartMinRef.current, dragCurMinRef.current)
      drawDragSelection(ctx, p, selStart, Math.max(selEnd, selStart + 5))
    } else if (selection) {
      drawDragSelection(ctx, p, selection.startMinute, selection.endMinute)
    }

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
  }, [p, mtSpans, adjustedBiliSpans, trackMode, isToday, dpr, selection, pinnedPos]) // eslint-disable-line react-hooks/exhaustive-deps

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
  function hitTestEdge(e: React.MouseEvent<HTMLCanvasElement>): {
    activity: ChronosActivity; edge: 'start' | 'end'; minute: number
  } | null {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const EDGE_TOL = 6
    const c = Math.floor((x - p.hPad) / p.colStride)
    if (c < 0 || c >= p.cols) return null

    for (const a of activities) {
      // start edge：活动起始列
      const startCol = Math.floor(a.startMinute / p.minutesPerCol)
      if (startCol === c) {
        const sy = minuteToY(a.startMinute, c, p)
        if (Math.abs(y - sy) <= EDGE_TOL) return { activity: a, edge: 'start', minute: a.startMinute }
      }
      // end edge：活动结束列（end 在列边界时归前一列）
      const endCol = Math.floor(a.endMinute / p.minutesPerCol)
      const checkCol = (a.endMinute % p.minutesPerCol === 0 && endCol > 0) ? endCol - 1 : endCol
      if (checkCol === c && checkCol < p.cols) {
        const ey = minuteToY(a.endMinute, checkCol, p)
        if (Math.abs(y - ey) <= EDGE_TOL) return { activity: a, edge: 'end', minute: a.endMinute }
      }
    }
    return null
  }

  // 将鼠标事件坐标转换为分钟（跨列支持，snap to 5 min）
  function minuteFromEvent(e: React.MouseEvent<HTMLCanvasElement>): number | null {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = Math.floor((x - p.hPad) / p.colStride)
    const rBlock = Math.floor((y - p.topPad) / p.rowStride)
    if (c < 0 || c >= p.cols || rBlock < 0 || rBlock >= p.rows) return null
    const localY = y - p.topPad - rBlock * p.rowStride
    const extraMin = Math.min(Math.floor(localY / p.minuteH), 4)
    const m = c * p.minutesPerCol + rBlock * 5 + extraMin
    return Math.round(m / 5) * 5
  }

  // 边缘拖拽专用：夹紧坐标，永不返回 null
  function minuteFromEventClamped(e: React.MouseEvent<HTMLCanvasElement>): number {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const cRaw = Math.floor((x - p.hPad) / p.colStride)
    const c = Math.max(0, Math.min(cRaw, p.cols - 1))
    const relY = y - p.topPad
    const clampedRelY = Math.max(0, Math.min(relY, p.gridH - 1))
    const rBlock = Math.max(0, Math.min(Math.floor(clampedRelY / p.rowStride), p.rows - 1))
    const localY = clampedRelY - rBlock * p.rowStride
    const extraMin = Math.min(Math.floor(localY / p.minuteH), 4)
    const m = c * p.minutesPerCol + rBlock * 5 + extraMin
    return Math.max(0, Math.min(Math.round(m / 5) * 5, 1440))
  }

  function getHitAt(e: React.MouseEvent<HTMLCanvasElement>): { minute: number; snappedEnd: number; hit: ChronosActivity | undefined; hitSpan: MtSpan | undefined } | null {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = Math.floor((x - p.hPad) / p.colStride)
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

    // 1. 优先检测边缘 resize
    const edgeHit = hitTestEdge(e)
    if (edgeHit) {
      edgeDragRef.current = {
        activity: edgeHit.activity,
        edge: edgeHit.edge,
        currentMinute: edgeHit.minute,
      }
      canvasRef.current!.style.cursor = 'ns-resize'
      scheduleRedraw()
      return
    }

    // 2. 命中 tag span → 由 handleClick 处理，不开始框选
    const info = getHitAt(e)
    if (!info || info.hitSpan) return

    // 3. 空白区域 → 框选
    isDraggingRef.current = true
    dragStartMinRef.current = info.minute
    dragCurMinRef.current = info.snappedEnd
    hoverMinRef.current = null
    canvasRef.current!.style.cursor = 'ns-resize'
    scheduleRedraw()
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = Math.floor((x - p.hPad) / p.colStride)
    const rBlock = Math.floor((y - p.topPad) / p.rowStride)

    // Edge resize 拖拽中
    if (edgeDragRef.current) {
      const newMin = minuteFromEventClamped(e)
      const ref = edgeDragRef.current
      const a = ref.activity
      if (ref.edge === 'start') {
        ref.currentMinute = Math.min(newMin, a.endMinute - 5)
      } else {
        ref.currentMinute = Math.max(Math.min(newMin, 1440), a.startMinute + 5)
      }
      scheduleRedraw()
      return
    }

    if (isDraggingRef.current) {
      // 框选拖拽中：更新选区终点
      if (c >= 0 && c < p.cols && rBlock >= 0 && rBlock < p.rows) {
        const localY = y - p.topPad - rBlock * p.rowStride
        const extraMin = Math.min(Math.floor(localY / p.minuteH), 4)
        const m = c * p.minutesPerCol + rBlock * 5 + extraMin
        dragCurMinRef.current = Math.ceil((m + 1) / 5) * 5
      }
      scheduleRedraw()
      return
    }

    // 普通 hover：先检测边缘
    const edgeHover = hitTestEdge(e)
    if (edgeHover) {
      hoveredIdRef.current = edgeHover.activity.id
      hoveredCellRef.current = null
      hoverMinRef.current = null
      canvasRef.current!.style.cursor = 'ns-resize'
      scheduleRedraw()
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
        hoverMinRef.current = hitSpan ? null : Math.floor(m / 5) * 5
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
      hoverMinRef.current = null
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

  function handleMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    // Edge resize 完成 → 持久化
    if (edgeDragRef.current) {
      const ref = edgeDragRef.current
      const a = ref.activity
      const newStart = ref.edge === 'start' ? ref.currentMinute : a.startMinute
      const newEnd = ref.edge === 'end' ? ref.currentMinute : a.endMinute
      edgeDragRef.current = null
      canvasRef.current!.style.cursor = 'crosshair'
      onActivityResize?.(a.id, newStart, newEnd)
      scheduleRedraw()
      return
    }

    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    canvasRef.current!.style.cursor = 'crosshair'

    const start = dragStartMinRef.current
    const end = dragCurMinRef.current
    dragStartMinRef.current = null
    dragCurMinRef.current = null

    if (start !== null && end !== null) {
      const selStart = Math.min(start, end)
      const selEnd = Math.max(start, end)
      if (selEnd - selStart < 5) {
        // 几乎没移动 → 当作单击，默认 60 分钟
        onTimeSelect?.(selStart, Math.min(selStart + 60, 1440))
      } else {
        onTimeSelect?.(selStart, selEnd)
      }
    }
    scheduleRedraw()
  }

  function handleMouseLeave() {
    // edge resize 离开 → 取消（不保存）
    if (edgeDragRef.current) {
      edgeDragRef.current = null
    }
    // 框选拖拽中离开 → 取消
    if (isDraggingRef.current) {
      isDraggingRef.current = false
      dragStartMinRef.current = null
      dragCurMinRef.current = null
    }
    hoveredCellRef.current = null
    hoveredIdRef.current = null
    hoverMinRef.current = null
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

    // 优先检测"固定/取消固定"标签
    const badge = pinBadgeRef.current
    if (badge && cx >= badge.x && cx <= badge.x + badge.w && cy >= badge.y && cy <= badge.y + badge.h) {
      if (pinnedPos != null) {
        onPinPos?.(null)
      } else {
        const c2 = Math.floor((cx - p.hPad) / p.colStride)
        const rBlock2 = Math.floor((cy - p.topPad) / p.rowStride)
        if (c2 >= 0 && c2 < p.cols && rBlock2 >= 0 && rBlock2 < p.rows) {
          const localY2 = cy - p.topPad - rBlock2 * p.rowStride
          const extraMin2 = Math.min(Math.floor(localY2 / p.minuteH), 4)
          const rawMinute = c2 * p.minutesPerCol + rBlock2 * 5 + extraMin2
          onPinPos?.({ col: c2, y: cy, minute: rawMinute })
        }
      }
      return
    }

    // 点击单元格区域：固定横线到原始像素位置（不 snap，保留精确 Y）
    const c2 = Math.floor((cx - p.hPad) / p.colStride)
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
      const c = Math.floor((x - p.hPad) / p.colStride)
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
    onClearSelection?.()
  }

  // 自动滚动到当前时间 / 最早活动
  // 只在日期切换或展开/收起时触发，不随活动增删重置位置
  const scrollKeyRef = useRef('')
  useEffect(() => {
    const key = `${selectedDate.toDateString()}-${isExpanded}`
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
  }, [selectedDate, isExpanded, isToday, p.minutesPerCol, p.colStride])

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: theme.background, position: 'relative' }}
      onClick={() => setCtxMenu(null)}
    >
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

      {/* 管线模式切换 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2,
        padding: '3px 8px', flexShrink: 0,
        borderBottom: `1px solid ${hexToRgba(theme.electricBlue, 0.1)}`,
      }}>
        {(['apps', 'bili'] as const).map((mode) => {
          const active = trackMode === mode
          const label = mode === 'apps' ? '应用程序' : '哔哩哔哩'
          const color = mode === 'apps' ? '#888888' : BILI_COLOR
          return (
            <button
              key={mode}
              onClick={() => onTrackModeChange?.(mode)}
              style={{
                background: active ? hexToRgba(color, 0.15) : 'transparent',
                border: `1px solid ${active ? hexToRgba(color, 0.5) : 'transparent'}`,
                borderRadius: 3, cursor: 'pointer',
                padding: '1px 10px',
                fontFamily: "'JetBrains Mono', 'Courier New', monospace",
                fontSize: 10, fontWeight: 600,
                color: active ? color : hexToRgba(color, 0.4),
                transition: 'all 0.15s',
                letterSpacing: 1,
              }}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* 图表滚动区：flex-1 填满剩余高度，高度不足时出现滚动条 */}
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

      {/* 分隔线 */}
      <div style={{ height: 1, background: hexToRgba(theme.electricBlue, 0.15) }} />

      {/* 图例 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 16px', flexWrap: 'wrap',
      }}>
        {tagLegend.map(([name, color]) => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 14, height: 3, borderRadius: 1,
              background: color,
              boxShadow: `0 0 6px ${hexToRgba(color, 0.6)}`,
            }} />
            <span style={{
              fontFamily: "'JetBrains Mono', 'Courier New', monospace",
              fontSize: 12, color: theme.textSecondary,
            }}>
              {name}
            </span>
          </div>
        ))}
        <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono', 'Courier New', monospace", fontSize: 12, color: theme.textSecondary }}>
          {tagSpans.length} 段标签 · 共 {totalTagMinutes} 分钟
        </span>
      </div>
    </div>
  )
}
