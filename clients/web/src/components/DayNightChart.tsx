import { useRef, useEffect, useState, useCallback } from 'react'
import type { ChronosActivity, TraceLayout } from '../types'
import { theme, getCategoryColor, getCategoryLabel } from '../theme'

interface Props {
  activities: ChronosActivity[]
  isExpanded: boolean
  selectedDate: Date
}

// ── Grid 参数 ──
function getGridParams(isExpanded: boolean) {
  const minutesPerCol = isExpanded ? 60 : 30
  const cols = 1440 / minutesPerCol      // 24 or 48
  const rows = minutesPerCol / 5         // 12 or 6
  const cellW = isExpanded ? 80 : 160
  const cellH = isExpanded ? 50 : 100
  const colGap = isExpanded ? 2 : 4
  const rowGap = 10
  const hPad = 4
  const topPad = 28
  const bottomPad = 8
  const minuteH = isExpanded ? 10 : 20
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

// ── Canvas 绘制函数 ──

function drawGrid(ctx: CanvasRenderingContext2D, p: ReturnType<typeof getGridParams>) {
  for (let c = 0; c < p.cols; c++) {
    const hourOfCol = Math.floor(c * p.minutesPerCol / 60)
    const isNight = hourOfCol < 6 || hourOfCol >= 22
    const borderA = isNight ? 0.05 : 0.09

    for (let r = 0; r < p.rows; r++) {
      const cx = colX(c, p)
      const cy = p.topPad + r * p.rowStride
      ctx.strokeStyle = hexToRgba(theme.electricBlue, borderA)
      ctx.lineWidth = 0.5
      ctx.strokeRect(cx, cy, p.cellW, p.cellH)
    }
  }
  // 6 小时大分隔线
  for (let hour = 6; hour <= 18; hour += 6) {
    const c = Math.floor(hour * 60 / p.minutesPerCol)
    if (c < 0 || c >= p.cols) continue
    const x = colX(c, p) - p.colGap / 2
    ctx.beginPath()
    ctx.moveTo(x, p.topPad)
    ctx.lineTo(x, p.topPad + p.gridH)
    ctx.strokeStyle = hexToRgba(theme.electricBlue, 0.12)
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
    ctx.font = `${major ? 'bold' : '500'} ${major ? 12 : 10}px 'Courier New', monospace`
    ctx.fillStyle = major ? theme.textPrimary : theme.textSecondary
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
      ctx.font = `${isMajor ? 'bold' : 'normal'} ${isMajor ? 10 : 9}px 'Courier New', monospace`
      ctx.fillStyle = hexToRgba(theme.textSecondary, isMajor ? 1.0 : 0.5)
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
    const opacity = hovered ? 0.25 : 0.15
    let m = a.startMinute
    while (m < a.endMinute) {
      const c = Math.floor(m / p.minutesPerCol)
      const r = Math.floor((m % p.minutesPerCol) / 5)
      if (c >= p.cols || r >= p.rows) break
      const cellStart = c * p.minutesPerCol + r * 5
      const cx = colX(c, p)
      const cy = p.topPad + r * p.rowStride
      const localStart = Math.max(a.startMinute, cellStart) - cellStart
      const localEnd = Math.min(a.endMinute, cellStart + 5) - cellStart
      const fillY = cy + localStart * p.minuteH
      const fillH = (localEnd - localStart) * p.minuteH
      ctx.fillStyle = hexToRgba(color, opacity)
      ctx.fillRect(cx, fillY, p.cellW, fillH)
      m = cellStart + 5
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
      const op = glow ? 1.0 : (hovered ? 1.0 : 0.75)
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
          ctx.strokeStyle = hexToRgba(color, 0.25)
          ctx.lineWidth = 1
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
      ctx.strokeStyle = hexToRgba(color, lit ? 1.0 : 0.6)
      ctx.lineWidth = lit ? 2 : 1.5
      ctx.stroke()

      // 内实心点
      const dotR = lit ? 2.5 : 2
      ctx.beginPath()
      ctx.arc(x, y, dotR, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      // 序号
      ctx.font = `500 10px 'Courier New', monospace`
      ctx.fillStyle = hexToRgba(color, lit ? 1.0 : 0.5)
      ctx.textAlign = 'left'
      ctx.fillText(step.label, x + 9, y + 3)

      // hover 时显示步骤标题
      if (lit && step.title) {
        ctx.font = `600 10px 'Courier New', monospace`
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
  for (const layout of layouts) {
    const a = layout.activity
    const color = getCategoryColor(a.category)
    const startCol = Math.floor(a.startMinute / p.minutesPerCol)
    const endCol = Math.min(Math.floor((a.endMinute - 1) / p.minutesPerCol), p.cols - 1)
    if (endCol < 0 || startCol >= p.cols) continue

    const firstRow = Math.floor((a.startMinute % p.minutesPerCol) / 5)
    const lastRow = Math.floor(((a.endMinute - 1) % p.minutesPerCol) / 5)
    const x1 = colX(startCol, p)
    const x2 = colX(endCol, p) + p.cellW
    const y1 = p.topPad + firstRow * p.rowStride
    const y2 = startCol === endCol
      ? p.topPad + lastRow * p.rowStride + p.cellH
      : p.topPad + (p.rows - 1) * p.rowStride + p.cellH

    const cx = (x1 + x2) / 2
    const cy = (y1 + y2) / 2

    ctx.textAlign = 'center'
    ctx.font = `bold 12px 'Courier New', monospace`
    ctx.fillStyle = color
    ctx.fillText(a.title, cx, cy - 8)

    ctx.font = `10px 'Courier New', monospace`
    ctx.fillStyle = hexToRgba(color, 0.5)
    ctx.fillText(`${fmt(a.startMinute)} – ${fmt(a.endMinute)}`, cx, cy + 8)
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

  // 扫描线光晕
  ctx.save()
  ctx.shadowColor = blue
  ctx.shadowBlur = 12
  ctx.beginPath()
  ctx.moveTo(cx, y)
  ctx.lineTo(cx + p.cellW, y)
  ctx.strokeStyle = hexToRgba(blue, 0.5)
  ctx.lineWidth = 8
  ctx.stroke()
  ctx.restore()

  // 主横线
  ctx.beginPath()
  ctx.moveTo(cx, y)
  ctx.lineTo(cx + p.cellW, y)
  ctx.strokeStyle = blue
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.stroke()

  // 左侧三角箭头
  const arrowW = 6, arrowH = 8
  ctx.beginPath()
  ctx.moveTo(cx - arrowW, y - arrowH / 2)
  ctx.lineTo(cx, y)
  ctx.lineTo(cx - arrowW, y + arrowH / 2)
  ctx.closePath()
  ctx.fillStyle = blue
  ctx.fill()

  // 时间标签
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const labelW = 38, labelH = 14
  const labelX = cx - arrowW - labelW - 2
  const labelY = y - labelH / 2
  ctx.fillStyle = blue
  ctx.beginPath()
  ctx.roundRect(labelX, labelY, labelW, labelH, 3)
  ctx.fill()
  ctx.font = `900 9px 'Courier New', monospace`
  ctx.fillStyle = '#000'
  ctx.textAlign = 'center'
  ctx.fillText(timeStr, labelX + labelW / 2, y + 3)
}

// ── 主组件 ──

export default function DayNightChart({ activities, isExpanded, selectedDate }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [hoveredCell, setHoveredCell] = useState<{ col: number; row: number } | null>(null)

  const p = getGridParams(isExpanded)
  const layouts = computeLayouts(activities)

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

    ctx.clearRect(0, 0, p.totalW, p.totalH)

    // 背景
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, p.totalW, p.totalH)

    drawGrid(ctx, p)
    drawTimeLabels(ctx, p)
    drawCellFills(ctx, p, layouts, hoveredId)

    // Glow 层（在独立 offscreen canvas 上模糊后叠加）
    const glowCanvas = document.createElement('canvas')
    glowCanvas.width = p.totalW
    glowCanvas.height = p.totalH
    const glowCtx = glowCanvas.getContext('2d')!
    glowCtx.filter = 'blur(5px)'
    drawTraceSegments(glowCtx, p, layouts, hoveredId, true)
    ctx.globalAlpha = 0.3
    ctx.drawImage(glowCanvas, 0, 0)
    ctx.globalAlpha = 1.0

    drawTraceSegments(ctx, p, layouts, hoveredId, false)
    drawStepNodes(ctx, p, layouts, hoveredCell)
    drawTitles(ctx, p, layouts)
    drawNowTick(ctx, p, isToday)
  }, [p, layouts, hoveredId, hoveredCell, isToday]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    draw()
    // 今天每分钟刷新一次扫描线
    if (!isToday) return
    const id = setInterval(draw, 60_000)
    return () => clearInterval(id)
  }, [draw, isToday])

  // 鼠标事件
  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = Math.floor((x - p.hPad) / p.colStride)
    const rBlock = Math.floor((y - p.topPad) / p.rowStride)
    if (c >= 0 && c < p.cols && rBlock >= 0 && rBlock < p.rows) {
      setHoveredCell({ col: c, row: rBlock })
      const localY = y - p.topPad - rBlock * p.rowStride
      const extraMin = Math.min(Math.floor(localY / p.minuteH), 4)
      const m = c * p.minutesPerCol + rBlock * 5 + extraMin
      const hit = activities.find((a) => m >= a.startMinute && m < a.endMinute)
      setHoveredId(hit?.id ?? null)
    } else {
      setHoveredCell(null)
      setHoveredId(null)
    }
  }

  function handleMouseLeave() {
    setHoveredCell(null)
    setHoveredId(null)
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
    <div style={{ display: 'flex', flexDirection: 'column', background: theme.background }}>
      {/* 图表滚动区 */}
      <div
        ref={containerRef}
        style={{ overflowX: 'auto', overflowY: 'auto', cursor: 'crosshair' }}
      >
        <canvas
          ref={canvasRef}
          width={p.totalW}
          height={p.totalH}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{ display: 'block' }}
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
              fontFamily: "'Courier New', monospace",
              fontSize: 11, color: theme.textSecondary,
            }}>
              {getCategoryLabel(cat)}
            </span>
          </div>
        ))}
        <span style={{ marginLeft: 'auto', fontFamily: "'Courier New', monospace", fontSize: 11, color: theme.textSecondary }}>
          {activities.length} traces · {totalMinutes}m
        </span>
      </div>
    </div>
  )
}
