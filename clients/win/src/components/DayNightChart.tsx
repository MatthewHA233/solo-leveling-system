import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import type { ChronosActivity, TraceLayout } from '../types'
import { theme, getCategoryColor, getCategoryLabel } from '../theme'

interface Props {
  activities: ChronosActivity[]
  isExpanded: boolean
  selectedDate: Date
  selection?: { startMinute: number; endMinute: number } | null
  onActivityClick?: (activity: ChronosActivity) => void
  onTimeSelect?: (startMinute: number, endMinute: number) => void
  onClearSelection?: () => void
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
  const traceBaseX = isExpanded ? 10 : 20
  const trackSp = isExpanded ? 10 : 18
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

function drawStepNodes(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<typeof getGridParams>,
  layouts: TraceLayout[],
  hoveredCell: { col: number; row: number } | null,
) {
  for (const layout of layouts) {
    const color = getCategoryColor(layout.activity.category)
    const trackX = p.traceBaseX + layout.trackIndex * p.trackSp

    for (const step of layout.activity.steps) {
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

// ── 主组件 ──

export default function DayNightChart({ activities, isExpanded, selectedDate, selection, onActivityClick, onTimeSelect, onClearSelection }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const hoveredCellRef = useRef<{ col: number; row: number } | null>(null)
  const rafRef = useRef<number>(0)
  const glowImageRef = useRef<ImageBitmap | HTMLCanvasElement | null>(null)
  const glowKeyRef = useRef<string>('')
  // 拖拽框选
  const isDraggingRef = useRef(false)
  const dragStartMinRef = useRef<number | null>(null)
  const dragCurMinRef = useRef<number | null>(null)
  const hoverMinRef = useRef<number | null>(null)

  const dpr = window.devicePixelRatio || 1

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
    const hoveredCell = hoveredCellRef.current

    ctx.clearRect(0, 0, p.totalW * dpr, p.totalH * dpr)

    // HiDPI 缩放
    ctx.save()
    ctx.scale(dpr, dpr)

    // 背景
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, p.totalW, p.totalH)

    drawGrid(ctx, p)

    // 空格 hover 高亮（在活动层之下）
    if (!isDraggingRef.current) {
      drawHoverHighlight(ctx, p, hoverMinRef.current, layouts)
    }

    drawCellFills(ctx, p, layouts, hoveredId)
    drawTimeLabels(ctx, p)

    // Glow 层（直接贴预渲染的缓存，不再做 blur）
    if (glowImageRef.current) {
      ctx.globalAlpha = 0.3
      ctx.drawImage(glowImageRef.current, 0, 0, p.totalW, p.totalH)
      ctx.globalAlpha = 1.0
    }

    drawTraceSegments(ctx, p, layouts, hoveredId, false)
    drawStepNodes(ctx, p, layouts, hoveredCell)
    drawTitles(ctx, p, layouts)
    drawNowTick(ctx, p, isToday)

    // 选区（最顶层）：拖拽中显示拖拽选区，松手后显示常驻选区
    if (isDraggingRef.current && dragStartMinRef.current !== null && dragCurMinRef.current !== null) {
      const selStart = Math.min(dragStartMinRef.current, dragCurMinRef.current)
      const selEnd = Math.max(dragStartMinRef.current, dragCurMinRef.current)
      drawDragSelection(ctx, p, selStart, Math.max(selEnd, selStart + 5))
    } else if (selection) {
      drawDragSelection(ctx, p, selection.startMinute, selection.endMinute)
    }

    ctx.restore()
  }, [p, layouts, isToday, dpr, selection]) // eslint-disable-line react-hooks/exhaustive-deps

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

  function getHitAt(e: React.MouseEvent<HTMLCanvasElement>): { minute: number; snappedEnd: number; hit: ChronosActivity | undefined } | null {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = Math.floor((x - p.hPad) / p.colStride)
    const rBlock = Math.floor((y - p.topPad) / p.rowStride)
    if (c < 0 || c >= p.cols || rBlock < 0 || rBlock >= p.rows) return null
    const localY = y - p.topPad - rBlock * p.rowStride
    const extraMin = Math.min(Math.floor(localY / p.minuteH), 4)
    const m = c * p.minutesPerCol + rBlock * 5 + extraMin
    const snapped = Math.floor(m / 5) * 5            // 向下对齐（拖拽起点）
    const snappedEnd = Math.ceil((m + 1) / 5) * 5    // 向上对齐（拖拽终点）
    const hit = activities.find((a) => m >= a.startMinute && m < a.endMinute)
    return { minute: snapped, snappedEnd, hit }
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const info = getHitAt(e)
    if (!info || info.hit) return   // 只在空白处开始拖拽
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

    if (isDraggingRef.current) {
      // 拖拽中：更新选区终点
      if (c >= 0 && c < p.cols && rBlock >= 0 && rBlock < p.rows) {
        const localY = y - p.topPad - rBlock * p.rowStride
        const extraMin = Math.min(Math.floor(localY / p.minuteH), 4)
        const m = c * p.minutesPerCol + rBlock * 5 + extraMin
        dragCurMinRef.current = Math.ceil((m + 1) / 5) * 5
      }
      scheduleRedraw()
      return
    }

    // 普通 hover
    if (c >= 0 && c < p.cols && rBlock >= 0 && rBlock < p.rows) {
      hoveredCellRef.current = { col: c, row: rBlock }
      const localY = y - p.topPad - rBlock * p.rowStride
      const extraMin = Math.min(Math.floor(localY / p.minuteH), 4)
      const m = c * p.minutesPerCol + rBlock * 5 + extraMin
      const hit = activities.find((a) => m >= a.startMinute && m < a.endMinute)
      hoveredIdRef.current = hit?.id ?? null
      hoverMinRef.current = hit ? null : Math.floor(m / 5) * 5
      canvasRef.current!.style.cursor = hit ? 'pointer' : 'crosshair'
    } else {
      hoveredCellRef.current = null
      hoveredIdRef.current = null
      hoverMinRef.current = null
      canvasRef.current!.style.cursor = 'crosshair'
    }
    scheduleRedraw()
  }

  function handleMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
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
    // 拖拽中离开：取消拖拽
    if (isDraggingRef.current) {
      isDraggingRef.current = false
      dragStartMinRef.current = null
      dragCurMinRef.current = null
    }
    hoveredCellRef.current = null
    hoveredIdRef.current = null
    hoverMinRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair'
    scheduleRedraw()
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    // 仅处理点击已有活动（空白区由 mouseup 处理）
    const info = getHitAt(e)
    if (info?.hit) onActivityClick?.(info.hit)
  }

  function handleContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    onClearSelection?.()
  }

  // 自动滚动到当前时间 / 最早活动
  useEffect(() => {
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
  }, [isToday, activities, p.minutesPerCol, p.colStride])

  // 图例
  const usedCats = [...new Set(activities.map((a) => a.category))]
  const totalMinutes = activities.reduce((s, a) => s + a.endMinute - a.startMinute, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: theme.background }}>
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
        {usedCats.map((cat) => (
          <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 14, height: 3, borderRadius: 1,
              background: getCategoryColor(cat),
              boxShadow: `0 0 6px ${hexToRgba(getCategoryColor(cat), 0.6)}`,
            }} />
            <span style={{
              fontFamily: "'JetBrains Mono', 'Courier New', monospace",
              fontSize: 12, color: theme.textSecondary,
            }}>
              {getCategoryLabel(cat)}
            </span>
          </div>
        ))}
        <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono', 'Courier New', monospace", fontSize: 12, color: theme.textSecondary }}>
          {activities.length} 条记录 · 共 {totalMinutes} 分钟
        </span>
        <span style={{ fontSize: 11, color: theme.textMuted }}>
          点击空白添加 · 点击活动编辑
        </span>
      </div>
    </div>
  )
}
