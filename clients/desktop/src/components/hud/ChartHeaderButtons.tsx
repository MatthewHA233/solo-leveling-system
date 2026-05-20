// ══════════════════════════════════════════════
// ChartHeaderButtons — 嵌在外/内双层 SVG 夹缝中的三个按钮
//
//   ① 主按钮"记录中" — 严格六边形（HTML button + clip-path）
//   ② 撤回 — 矩形
//   ③ 恢复 — 矩形
//
//   交互层：HTML button + clip-path 多边形，可被 Tooltip 包裹
//   描边层：单独 SVG 在上方，画主线 + 雕刻内刻线（pointer-events:none）
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Undo2, Redo2, Pencil, ListChecks, CalendarClock } from 'lucide-react'
import { theme } from '../../theme'
import Tooltip from '../Tooltip'

interface Props {
  readonly mainHeight?: number
  readonly rightOffset?: number
  readonly topOffsetRight?: number
  readonly slopeLen?: number
  readonly rightSegLen?: number
  readonly notchWidth?: number
  readonly paddingRightFull?: number

  readonly editMode: boolean
  readonly recordLayerColor: string
  readonly recordLayerLabel: string
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly recordLayer: 'actual' | 'plan'

  readonly onToggleEdit: () => void
  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly onRecordLayerChange: (layer: 'actual' | 'plan') => void
}

const CHART_CORNER_CUT = 18
const BUTTON_INSET = 2   // 按钮各边距 svg 装饰边线的间隙 px
const ENGRAVE_INSET = 2  // 雕刻内刻线距按钮边缘 px

export function ChartHeaderButtons({
  mainHeight = 30,
  rightOffset = 24,
  topOffsetRight = 24,
  slopeLen = 14,
  rightSegLen = 90,
  notchWidth = 150,
  paddingRightFull = 24.5,
  editMode,
  recordLayerColor,
  recordLayerLabel,
  canUndo,
  canRedo,
  recordLayer,
  onToggleEdit,
  onUndo,
  onRedo,
  onRecordLayerChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      setSize({
        w: Math.round(entry.contentRect.width),
        h: Math.round(entry.contentRect.height),
      })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const mainColor = editMode ? recordLayerColor : theme.electricBlue
  const subColor = theme.electricBlue

  // 容器内坐标系：y=0 是容器顶（面板 -mainHeight），chart pane 顶 y=mainHeight
  const xChartRight = size.w - paddingRightFull
  const xLineEnd = xChartRight + rightOffset
  const xSlopeStart = xLineEnd - slopeLen
  const yChartTop = mainHeight
  const yMainRight = yChartTop - topOffsetRight
  const yInnerCornerEnd = yChartTop + CHART_CORNER_CUT
  const ySlopeEnd = yMainRight + slopeLen
  const xPortRightShoulder = xSlopeStart - rightSegLen

  // ── ① 六边形理论顶点（紧贴 svg 边线）──
  const hexRaw: ReadonlyArray<[number, number]> = [
    [xSlopeStart, yMainRight],          // 1 左上
    [xLineEnd, ySlopeEnd],              // 2 右上
    [xLineEnd, yInnerCornerEnd],        // 3 右下
    [xChartRight, yInnerCornerEnd],     // 4 内框切角下端
    [xChartRight - CHART_CORNER_CUT, yChartTop],     // 5 内框切角上端 (xChartRight-18, 30)
    [xChartRight - CHART_CORNER_CUT, yMainRight],    // 6 左上 (xChartRight-18, 8)
  ]
  // 实际按钮顶点：每条边向多边形内部偏移 BUTTON_INSET 像素（让按钮跟 svg 边线有间隙）
  const hex = offsetPolygon(hexRaw, BUTTON_INSET)
  // ① bbox（用于 button 定位）
  const hex_xs = hex.map(([x]) => x)
  const hex_ys = hex.map(([, y]) => y)
  const hexBox = {
    x: Math.min(...hex_xs),
    y: Math.min(...hex_ys),
    w: Math.max(...hex_xs) - Math.min(...hex_xs),
    h: Math.max(...hex_ys) - Math.min(...hex_ys),
  }

  // ② 撤回矩形：紧贴 ① 左边（共享 ① 左边线，不留间隙）
  const btn2Size = 24    // ② 宽度（高度由 ① 内空决定）
  const btn2 = {
    // 右边与 ① 左边 (xChartRight - 18) 重合，向左展开 btn2Size
    x: (xChartRight - CHART_CORNER_CUT) - btn2Size + BUTTON_INSET,
    y: yMainRight + BUTTON_INSET,
    w: btn2Size - BUTTON_INSET,   // 只内嵌左边 (右边贴 ①)
    h: (yChartTop - yMainRight) - 2 * BUTTON_INSET,
  }

  // ③ 恢复正方形：紧贴 ① 下方（共享 ① 下边线，不留间隙）
  const btn3Size = 24   // 正方形边长（= rightOffset，宽度自动撑满 chart pane 外侧空间）
  const btn3 = {
    x: xChartRight + BUTTON_INSET,
    y: yInnerCornerEnd,     // 顶贴 ① 下边线
    w: btn3Size - 2 * BUTTON_INSET,
    h: btn3Size - BUTTON_INSET,   // 只内嵌下方 (上方贴 ①)
  }

  // ④⑤ 记录层切换按钮（实际记录 / 计划安排）
  // 位置：chart pane 右边线外、长竖线左侧，紧贴 ③ 下方垂直堆叠
  // 形状：圆角长方形（竖直高度 > 宽度）
  const layerBtnWidth = rightOffset      // 撑满 chart pane 与长竖线之间的夹缝
  const layerBtnHeight = 32              // 竖直高度（长方形）
  const layerBtnRadius = 6               // 圆角
  const layerBtnGap = 10                 // 按钮间距
  const layerOffsetFromBtn3 = 20         // ④ 距 ③ 的距离
  const yLayer1 = yInnerCornerEnd + btn3Size + layerOffsetFromBtn3
  const yLayer2 = yLayer1 + layerBtnHeight + layerBtnGap
  const layerBtnActual = {
    x: xChartRight + BUTTON_INSET,
    y: yLayer1 + BUTTON_INSET,
    w: layerBtnWidth - 2 * BUTTON_INSET,
    h: layerBtnHeight - 2 * BUTTON_INSET,
  }
  const layerBtnPlan = {
    x: xChartRight + BUTTON_INSET,
    y: yLayer2 + BUTTON_INSET,
    w: layerBtnWidth - 2 * BUTTON_INSET,
    h: layerBtnHeight - 2 * BUTTON_INSET,
  }

  // 把绝对坐标 polygon 转成 button 内 % 的 clip-path 字符串
  function makeClipPath(
    pts: ReadonlyArray<[number, number]>,
    box: { x: number; y: number; w: number; h: number },
  ): string {
    const parts = pts.map(([x, y]) => {
      const rx = box.w === 0 ? 0 : ((x - box.x) / box.w) * 100
      const ry = box.h === 0 ? 0 : ((y - box.y) / box.h) * 100
      return `${rx.toFixed(2)}% ${ry.toFixed(2)}%`
    })
    return `polygon(${parts.join(', ')})`
  }
  const rectClip = 'polygon(0 0, 100% 0, 100% 100%, 0 100%)'

  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute',
        top: -mainHeight,
        left: 0,
        right: -paddingRightFull,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 82,
      }}
    >
      {size.w > 0 && size.h > 0 && (
        <>
          {/* ② 撤回（常驻；editMode=false 时整体置灰） */}
          <BtnHTML
            box={btn2}
            clipPath={rectClip}
            color={mainColor}
            disabled={!editMode || !canUndo}
            onClick={onUndo}
            tooltip="撤回 (Ctrl+Z)"
          >
            <IconLit Icon={Undo2} size={10} color={mainColor} lit={editMode && canUndo} />
          </BtnHTML>

          {/* ① 主按钮 — 3 个字沿左下→右上对角线散开摆放 */}
          <BtnHTML
            box={hexBox}
            clipPath={makeClipPath(hex, hexBox)}
            color={mainColor}
            active={editMode}
            onClick={onToggleEdit}
            tooltip={editMode ? `退出${recordLayerLabel}编辑 (Ctrl+E)` : `编辑${recordLayerLabel} (Ctrl+E)`}
            disableFlexCenter
          >
            <HexLabel label={editMode ? '记录中' : '记录'} color={mainColor} lit={editMode} />
          </BtnHTML>

          {/* ③ 恢复（常驻；editMode=false 时整体置灰） */}
          <BtnHTML
            box={btn3}
            clipPath={rectClip}
            color={mainColor}
            disabled={!editMode || !canRedo}
            onClick={onRedo}
            tooltip="恢复 (Ctrl+Y)"
            compact
          >
            <IconLit Icon={Redo2} size={9} color={mainColor} lit={editMode && canRedo} />
          </BtnHTML>

          {/* ④ 实际记录（绿） */}
          <BtnHTML
            box={layerBtnActual}
            clipPath={rectClip}
            color={theme.expGreen}
            active={recordLayer === 'actual'}
            onClick={() => onRecordLayerChange('actual')}
            tooltip="活动标签"
            borderRadius={layerBtnRadius}
          >
            <IconLit Icon={ListChecks} size={14} color={theme.expGreen} lit={recordLayer === 'actual'} />
          </BtnHTML>

          {/* ⑤ 计划安排（橙） */}
          <BtnHTML
            box={layerBtnPlan}
            clipPath={rectClip}
            color={theme.warningOrange}
            active={recordLayer === 'plan'}
            onClick={() => onRecordLayerChange('plan')}
            tooltip="计划安排"
            borderRadius={layerBtnRadius}
          >
            <IconLit Icon={CalendarClock} size={14} color={theme.warningOrange} lit={recordLayer === 'plan'} />
          </BtnHTML>

          {/* 描边层：在所有按钮之上画 stroke + 内刻线（pointer-events: none） */}
          <svg
            width={size.w}
            height={size.h}
            style={{
              position: 'absolute', top: 0, left: 0,
              pointerEvents: 'none',
              overflow: 'visible',
            }}
          >
            <defs>
              <filter id="chb-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="1" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* ② 描边（常驻，editMode 时跟 ① 同色） */}
            <ButtonStroke pts={rectToPts(btn2)} color={mainColor} faded={!editMode || !canUndo} />
            {/* ① 描边 */}
            <ButtonStroke pts={hex} color={mainColor} accent={editMode} />
            {/* ③ 描边 */}
            <ButtonStroke pts={rectToPts(btn3)} color={mainColor} faded={!editMode || !canRedo} />
            {/* ④ 实际记录描边（圆角矩形） */}
            <RoundedRectStroke box={layerBtnActual} r={layerBtnRadius} color={theme.expGreen} accent={recordLayer === 'actual'} />
            {/* ⑤ 计划安排描边（圆角矩形） */}
            <RoundedRectStroke box={layerBtnPlan} r={layerBtnRadius} color={theme.warningOrange} accent={recordLayer === 'plan'} />
          </svg>
        </>
      )}
    </div>
  )
}

// ── HTML button 包装：用 clip-path 切多边形 + Tooltip ──

interface BtnHTMLProps {
  readonly box: { x: number; y: number; w: number; h: number }
  readonly clipPath: string
  readonly color: string
  readonly active?: boolean
  readonly disabled?: boolean
  readonly compact?: boolean
  readonly disableFlexCenter?: boolean
  readonly borderRadius?: number   // 圆角（与 clipPath 互斥；> 0 时忽略 clipPath）
  readonly onClick: () => void
  readonly tooltip: string
  readonly children: React.ReactNode
}

function BtnHTML({ box, clipPath, color, active = false, disabled = false, onClick, tooltip, disableFlexCenter = false, borderRadius = 0, children }: BtnHTMLProps) {
  const [hover, setHover] = useState(false)
  const lit = active || (!disabled && hover)
  return (
    <Tooltip
      content={tooltip}
      wrapStyle={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        pointerEvents: disabled ? 'none' : 'auto',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <button
        type="button"
        onClick={() => !disabled && onClick()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'relative',
          width: '100%', height: '100%',
          display: disableFlexCenter ? 'block' : 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: lit ? `${color}22` : `${color}0B`,
          border: 'none',
          clipPath: borderRadius > 0 ? undefined : clipPath,
          WebkitClipPath: borderRadius > 0 ? undefined : clipPath,
          borderRadius: borderRadius > 0 ? borderRadius : undefined,
          color: lit ? color : `${color}AA`,
          cursor: disabled ? 'default' : 'pointer',
          padding: 0,
          fontFamily: theme.fontMono,
          textShadow: lit ? `0 0 6px ${color}66` : undefined,
          transition: 'background 0.15s, color 0.15s',
        } as CSSProperties}
      >
        {children}
      </button>
    </Tooltip>
  )
}

// ── 图标加亮包装（lit 时按钮色 + 强 glow；non-lit 时按钮色稍淡 + 微弱 glow，
//   但仍亮于按钮边框，保证"图标亮度永远 > 边框亮度"） ──
function IconLit({
  Icon, size, color, lit,
}: {
  readonly Icon: typeof Undo2
  readonly size: number
  readonly color: string
  readonly lit: boolean
}) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        color: lit ? color : `${color}CC`,
        filter: lit
          ? `drop-shadow(0 0 3px ${color}) drop-shadow(0 0 8px ${color}99)`
          : `drop-shadow(0 0 2px ${color}66)`,
        pointerEvents: 'none',
      }}
    >
      <Icon size={size} />
    </span>
  )
}

// ── 六边形按钮内 3 字散开摆放 ──
//   字本身不旋转（横平竖直），但 3 字位置沿"左下→右上"对角线分布
//   契合按钮内部最宽段（y=22..30 的菱形区域）
function HexLabel({ label, color, lit }: { readonly label: string; readonly color: string; readonly lit: boolean }) {
  // label 可能是 "记录中"（3 字）或 "记录"（2 字），按字数计算位置
  const chars = label.split('')
  const n = chars.length
  // 散开 (button 内 %)：左上 → 右下，沿外斜切方向
  // 2 字（记录）紧凑分布 + 略大字号；3 字（记录中）较宽分布 + 小字号
  const RANGE_3 = { x0: 25, x1: 65, y0: 25, y1: 75 }
  const RANGE_2 = { x0: 35, x1: 55, y0: 35, y1: 65 }
  const range = n === 2 ? RANGE_2 : RANGE_3
  const fontSize = n === 2 ? 11 : 9
  const positions = chars.map((_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1)
    // 2 字模式下的"录"（index 1）单独偏移：再向右 2px、向下 1px
    const isLuInRecord = n === 2 && i === 1
    return {
      left: range.x0 + (range.x1 - range.x0) * t,
      top: range.y0 + (range.y1 - range.y0) * t,
      dxPx: isLuInRecord ? 2 : 0,
      dyPx: isLuInRecord ? 1 : 0,
    }
  })
  return (
    <>
      {chars.map((c, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            left: `${positions[i].left}%`,
            top: `${positions[i].top}%`,
            transform: `translate(calc(-50% + ${1 + positions[i].dxPx}px), calc(-50% + ${positions[i].dyPx}px))`,
            fontFamily: theme.fontMono,
            fontSize: fontSize,
            fontWeight: 700,
            letterSpacing: 0,
            lineHeight: 1,
            // 参考昼夜表 HudTabButton：lit 时白字 + 强 glow，否则浅亮色 + 弱 glow
            color: lit ? '#FFFFFF' : '#D0F8FF',
            textShadow: lit
              ? `0 0 5px #FFFFFF, 0 0 12px ${color}`
              : `0 0 3px rgba(255,255,255,0.5), 0 0 8px ${color}99`,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {c}
        </span>
      ))}
    </>
  )
}

// ── 描边层（主线 + 雕刻内刻线） ──

function ButtonStroke({ pts, color, accent = false, faded = false }: {
  readonly pts: ReadonlyArray<[number, number]>
  readonly color: string
  readonly accent?: boolean
  readonly faded?: boolean
}) {
  const pStr = pts.map(([x, y]) => `${x},${y}`).join(' ')
  const inset = offsetPolygon(pts, ENGRAVE_INSET)
  const insetStr = inset.map(([x, y]) => `${x},${y}`).join(' ')
  const op = faded ? 0.4 : 1
  return (
    <g style={{ opacity: op }}>
      {/* 主描边 */}
      <polygon
        points={pStr}
        fill="none"
        stroke={color}
        strokeWidth={accent ? 1.6 : 1.2}
        strokeLinejoin="miter"
        filter={accent ? 'url(#chb-glow)' : undefined}
      />
      {/* 雕刻内刻线 */}
      <polygon
        points={insetStr}
        fill="none"
        stroke={color}
        strokeWidth={0.6}
        strokeOpacity={0.32}
        strokeLinejoin="miter"
      />
    </g>
  )
}

function rectToPts(b: { x: number; y: number; w: number; h: number }): ReadonlyArray<[number, number]> {
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]
}

// 圆角矩形描边（主线 + 内偏 ENGRAVE_INSET 雕刻线，跟 ButtonStroke 风格一致）
// non-accent 时整体描边 opacity 0.4（让按钮"待机"状态明显比图标暗）
function RoundedRectStroke({
  box, r, color, accent = false,
}: {
  readonly box: { x: number; y: number; w: number; h: number }
  readonly r: number
  readonly color: string
  readonly accent?: boolean
}) {
  return (
    <g style={{ opacity: accent ? 1 : 0.4 }}>
      <rect
        x={box.x} y={box.y} width={box.w} height={box.h} rx={r} ry={r}
        fill="none"
        stroke={color}
        strokeWidth={accent ? 1.6 : 1.2}
        filter={accent ? 'url(#chb-glow)' : undefined}
      />
      <rect
        x={box.x + ENGRAVE_INSET}
        y={box.y + ENGRAVE_INSET}
        width={box.w - 2 * ENGRAVE_INSET}
        height={box.h - 2 * ENGRAVE_INSET}
        rx={Math.max(0, r - ENGRAVE_INSET)} ry={Math.max(0, r - ENGRAVE_INSET)}
        fill="none"
        stroke={color}
        strokeWidth={0.6}
        strokeOpacity={0.32}
      />
    </g>
  )
}

function insetPolygon(pts: ReadonlyArray<[number, number]>, d: number): Array<[number, number]> {
  const n = pts.length
  const cx = pts.reduce((s, [x]) => s + x, 0) / n
  const cy = pts.reduce((s, [, y]) => s + y, 0) / n
  return pts.map(([x, y]) => {
    const dx = cx - x
    const dy = cy - y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    return [x + (dx / len) * d, y + (dy / len) * d]
  })
}

// 按边法线方向平行内移 d 像素（顺时针多边形假设；svg 坐标系 y 向下）
// 比 insetPolygon "顶点到中心"准确得多，每条边真正平行偏移 d
function offsetPolygon(pts: ReadonlyArray<[number, number]>, d: number): Array<[number, number]> {
  const n = pts.length
  const out: Array<[number, number]> = []
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]
    const curr = pts[i]
    const next = pts[(i + 1) % n]
    const ex1 = curr[0] - prev[0]
    const ey1 = curr[1] - prev[1]
    const l1 = Math.hypot(ex1, ey1) || 1
    const nx1 = -ey1 / l1
    const ny1 = ex1 / l1
    const ex2 = next[0] - curr[0]
    const ey2 = next[1] - curr[1]
    const l2 = Math.hypot(ex2, ey2) || 1
    const nx2 = -ey2 / l2
    const ny2 = ex2 / l2
    const bx = nx1 + nx2
    const by = ny1 + ny2
    const blen2 = bx * bx + by * by
    if (blen2 < 0.0001) {
      out.push([curr[0] + d * nx1, curr[1] + d * ny1])
    } else {
      // 偏移距离 = d / sin(内角/2)；bisector 已经是 (n1+n2)，|bisector|=2 sin(内角/2)
      // 所以 new_curr = curr + bisector * (2d / |bisector|^2)
      const k = (2 * d) / blen2
      out.push([curr[0] + bx * k, curr[1] + by * k])
    }
  }
  return out
}
