// ══════════════════════════════════════════════
// HudFrame — 高达甲板式 HUD 全框装饰
//   · 四边断裂边线（非连续，左右两段 + 中心凹陷缺口）
//   · 居中"握手"凹陷（top/bottom V-dip，内可嵌标签）
//   · 两侧中点 U 形接口（像插头/线缆口）
//   · 四角互不相同的复合折角（TL 内 L / TR 箭羽 / BL 连接器 / BR 电缆接头）
//   · 可选警示条纹
// ══════════════════════════════════════════════

import type { CSSProperties } from 'react'
import { theme } from '../../theme'

interface HudFrameProps {
  readonly color?: string
  readonly accent?: string
  readonly topLabel?: string
  readonly bottomLabel?: string
  readonly notchWidth?: number
  readonly notchDepth?: number
  readonly showNotchTop?: boolean
  readonly showNotchBottom?: boolean
  readonly showConnectors?: boolean     // 两侧中点 U 形接口
  readonly hazardLeft?: boolean
  readonly hazardRight?: boolean
  readonly cornerSize?: number
  readonly rivets?: boolean
  readonly intensity?: 'soft' | 'bright'
}

export function HudFrame({
  color = theme.electricBlue,
  accent = theme.warningOrange,
  topLabel,
  bottomLabel,
  notchWidth = 54,
  notchDepth = 8,
  showNotchTop = false,
  showNotchBottom = true,
  showConnectors = true,
  hazardLeft = false,
  hazardRight = false,
  cornerSize = 18,
  rivets = true,
  intensity = 'bright',
}: HudFrameProps) {
  const strokeW = intensity === 'bright' ? 1.3 : 1
  const baseLine: CSSProperties = {
    position: 'absolute',
    background: color,
    boxShadow: intensity === 'bright' ? `0 0 4px ${color}99` : undefined,
    pointerEvents: 'none',
  }

  // Top edge 分段
  const topLeftWidth = showNotchTop
    ? `calc(50% - ${cornerSize}px - ${notchWidth / 2}px)`
    : `calc(100% - ${cornerSize * 2}px)`
  const topRightWidth = `calc(50% - ${cornerSize}px - ${notchWidth / 2}px)`

  const bottomLeftWidth = showNotchBottom
    ? `calc(50% - ${cornerSize}px - ${notchWidth / 2}px)`
    : `calc(100% - ${cornerSize * 2}px)`
  const bottomRightWidth = `calc(50% - ${cornerSize}px - ${notchWidth / 2}px)`

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* ────────── TOP EDGE ────────── */}
      <div style={{ ...baseLine, top: 0, left: cornerSize, width: topLeftWidth, height: 1 }} />
      {showNotchTop && (
        <div style={{ ...baseLine, top: 0, right: cornerSize, width: topRightWidth, height: 1 }} />
      )}
      {showNotchTop && (
        <TopNotch color={color} w={notchWidth} d={notchDepth} sw={strokeW} />
      )}
      {showNotchTop && topLabel && (
        <NotchLabel text={topLabel} color={color} top={notchDepth + 3} />
      )}

      {/* ────────── BOTTOM EDGE ────────── */}
      <div style={{ ...baseLine, bottom: 0, left: cornerSize, width: bottomLeftWidth, height: 1 }} />
      {showNotchBottom && (
        <div style={{ ...baseLine, bottom: 0, right: cornerSize, width: bottomRightWidth, height: 1 }} />
      )}
      {showNotchBottom && (
        <BottomNotch color={color} w={notchWidth} d={notchDepth} sw={strokeW} />
      )}
      {showNotchBottom && bottomLabel && (
        <NotchLabel text={bottomLabel} color={color} bottom={notchDepth + 3} />
      )}

      {/* ────────── LEFT EDGE ────────── */}
      {showConnectors ? (
        <>
          <div style={{
            ...baseLine, left: 0, top: cornerSize,
            height: `calc(50% - ${cornerSize}px - 12px)`, width: 1,
          }} />
          <div style={{
            ...baseLine, left: 0, bottom: cornerSize,
            height: `calc(50% - ${cornerSize}px - 12px)`, width: 1,
          }} />
          <SideConnector side="left" color={color} sw={strokeW} />
        </>
      ) : (
        <div style={{
          ...baseLine, left: 0, top: cornerSize,
          height: `calc(100% - ${cornerSize * 2}px)`, width: 1,
        }} />
      )}

      {/* ────────── RIGHT EDGE ────────── */}
      {showConnectors ? (
        <>
          <div style={{
            ...baseLine, right: 0, top: cornerSize,
            height: `calc(50% - ${cornerSize}px - 12px)`, width: 1,
          }} />
          <div style={{
            ...baseLine, right: 0, bottom: cornerSize,
            height: `calc(50% - ${cornerSize}px - 12px)`, width: 1,
          }} />
          <SideConnector side="right" color={color} sw={strokeW} />
        </>
      ) : (
        <div style={{
          ...baseLine, right: 0, top: cornerSize,
          height: `calc(100% - ${cornerSize * 2}px)`, width: 1,
        }} />
      )}

      {/* ────────── 4 个非对称角 ────────── */}
      <CornerTL color={color} accent={accent} size={cornerSize} sw={strokeW} />
      <CornerTR color={color} accent={accent} size={cornerSize} sw={strokeW} />
      <CornerBL color={color} accent={accent} size={cornerSize} sw={strokeW} />
      <CornerBR color={color} accent={accent} size={cornerSize} sw={strokeW} />

      {/* ────────── 警示条纹 ────────── */}
      {hazardLeft && <HazardStripe side="left" color={accent} />}
      {hazardRight && <HazardStripe side="right" color={accent} />}

      {/* ────────── 铆钉（4 条边段中点小点） ────────── */}
      {rivets && <Rivets color={color} cornerSize={cornerSize} />}
    </div>
  )
}

// ──────────── 子组件 ────────────

function TopNotch({ color, w, d, sw }: { color: string; w: number; d: number; sw: number }) {
  const p1 = w * 0.22
  const p2 = w * 0.36
  const p3 = w * 0.64
  const p4 = w * 0.78
  return (
    <svg width={w} height={d + 2}
      style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', overflow: 'visible' }}
    >
      <path
        d={`M 0 0.5 L ${p1} 0.5 L ${p2} ${d + 0.5} L ${p3} ${d + 0.5} L ${p4} 0.5 L ${w} 0.5`}
        stroke={color} strokeWidth={sw} fill="none"
        strokeLinejoin="miter" strokeLinecap="square"
        style={{ filter: `drop-shadow(0 0 3px ${color}AA)` }}
      />
      {/* 凹陷底部 2 个小方点（装饰） */}
      <rect x={w * 0.48} y={d - 0.5} width={1.5} height={1.5} fill={color} opacity={0.9} />
      <rect x={w * 0.52 - 1.5} y={d - 0.5} width={1.5} height={1.5} fill={color} opacity={0.6} />
    </svg>
  )
}

function BottomNotch({ color, w, d, sw }: { color: string; w: number; d: number; sw: number }) {
  const p1 = w * 0.22
  const p2 = w * 0.36
  const p3 = w * 0.64
  const p4 = w * 0.78
  return (
    <svg width={w} height={d + 2}
      style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', overflow: 'visible' }}
    >
      <path
        d={`M 0 ${d + 1.5} L ${p1} ${d + 1.5} L ${p2} 1.5 L ${p3} 1.5 L ${p4} ${d + 1.5} L ${w} ${d + 1.5}`}
        stroke={color} strokeWidth={sw} fill="none"
        strokeLinejoin="miter" strokeLinecap="square"
        style={{ filter: `drop-shadow(0 0 3px ${color}AA)` }}
      />
      <rect x={w * 0.48} y={2.5} width={1.5} height={1.5} fill={color} opacity={0.9} />
      <rect x={w * 0.52 - 1.5} y={2.5} width={1.5} height={1.5} fill={color} opacity={0.6} />
    </svg>
  )
}

function NotchLabel({ text, color, top, bottom }: {
  text: string; color: string; top?: number; bottom?: number
}) {
  return (
    <span style={{
      position: 'absolute',
      top, bottom,
      left: '50%',
      transform: 'translateX(-50%)',
      fontSize: 8.5,
      fontFamily: theme.fontMono,
      fontWeight: 700,
      letterSpacing: 1.6,
      color,
      textShadow: `0 0 6px ${color}BB`,
      lineHeight: 1,
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
    }}>
      {text}
    </span>
  )
}

function SideConnector({ side, color, sw }: { side: 'left' | 'right'; color: string; sw: number }) {
  const flip = side === 'right' ? 'scaleX(-1)' : undefined
  return (
    <svg width={11} height={24} style={{
      position: 'absolute',
      [side]: 0,
      top: '50%',
      transform: `translateY(-50%) ${flip ?? ''}`.trim(),
    } as CSSProperties}>
      {/* U 形凹槽 + 内部连接点 */}
      <path d="M 0.5 0 L 0.5 4 L 10 4 L 10 20 L 0.5 20 L 0.5 24"
        stroke={color} strokeWidth={sw} fill="none" strokeLinejoin="miter"
        style={{ filter: `drop-shadow(0 0 3px ${color}AA)` }} />
      {/* 内部横贯短线 */}
      <line x1={4} y1={9} x2={9} y2={9} stroke={color} strokeWidth={sw * 0.7} opacity={0.55} />
      <line x1={4} y1={15} x2={9} y2={15} stroke={color} strokeWidth={sw * 0.7} opacity={0.55} />
      {/* 接点圆 */}
      <circle cx={6} cy={12} r={1.6} fill={color} opacity={0.9}
        style={{ filter: `drop-shadow(0 0 2px ${color})` }} />
      <circle cx={6} cy={12} r={2.8} stroke={color} strokeWidth={sw * 0.5} fill="none" opacity={0.55} />
    </svg>
  )
}

// ── 4 个不同的角 ──────────────────────

// TL：内嵌双 L + 45° 斜切 + 小方点
function CornerTL({ color, accent, size, sw }: { color: string; accent: string; size: number; sw: number }) {
  return (
    <svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}>
      {/* 外 L：45° 斜切起步 */}
      <polyline
        points={`0.5,${size - 4} 0.5,4 4,0.5 ${size - 4},0.5`}
        stroke={color} strokeWidth={sw + 0.1} fill="none"
        strokeLinecap="square" strokeLinejoin="miter"
        style={{ filter: `drop-shadow(0 0 3px ${color}BB)` }}
      />
      {/* 斜切亮条 */}
      <line x1={1} y1={6} x2={6} y2={1} stroke={color} strokeWidth={sw + 0.2}
        style={{ filter: `drop-shadow(0 0 3px ${color}CC)` }} />
      {/* 内 L（细线） */}
      <polyline
        points={`4,${size - 2} 4,7 7,4 ${size - 2},4`}
        stroke={color} strokeWidth={sw * 0.6} fill="none"
        opacity={0.55} strokeLinejoin="miter"
      />
      {/* 右延伸断续 */}
      <line x1={size - 4} y1={0.5} x2={size - 1} y2={0.5} stroke={color} strokeWidth={sw * 0.7} opacity={0.6} />
      <line x1={0.5} y1={size - 4} x2={0.5} y2={size - 1} stroke={color} strokeWidth={sw * 0.7} opacity={0.6} />
      {/* 小方点 */}
      <rect x={9} y={9} width={1.6} height={1.6} fill={color} opacity={0.95} />
      {/* 橙色警示三角 */}
      <path d={`M ${size - 6} 3 L ${size - 3} 3 L ${size - 4.5} 5.5 Z`} fill={accent} opacity={0.8} />
    </svg>
  )
}

// TR：箭羽形（堆叠三段线 + 方块）
function CornerTR({ color, accent, size, sw }: { color: string; accent: string; size: number; sw: number }) {
  return (
    <svg width={size} height={size}
      style={{ position: 'absolute', top: 0, right: 0, transform: 'scaleX(-1)', overflow: 'visible' }}
    >
      <polyline
        points={`0.5,${size - 4} 0.5,4 4,0.5 ${size - 4},0.5`}
        stroke={color} strokeWidth={sw + 0.1} fill="none"
        strokeLinecap="square" strokeLinejoin="miter"
        style={{ filter: `drop-shadow(0 0 3px ${color}BB)` }}
      />
      <line x1={1} y1={6} x2={6} y2={1} stroke={color} strokeWidth={sw + 0.2}
        style={{ filter: `drop-shadow(0 0 3px ${color}CC)` }} />
      {/* 箭羽：三段平行斜线 */}
      <line x1={6} y1={4} x2={10} y2={4} stroke={color} strokeWidth={sw * 0.7} opacity={0.7} />
      <line x1={6} y1={7} x2={13} y2={7} stroke={color} strokeWidth={sw * 0.7} opacity={0.55} />
      <line x1={6} y1={10} x2={size - 3} y2={10} stroke={color} strokeWidth={sw * 0.7} opacity={0.4} />
      {/* 小菱形（accent） */}
      <rect x={size - 5} y={size - 5} width={2} height={2}
        fill={accent} opacity={0.85}
        transform={`rotate(45 ${size - 4} ${size - 4})`}
      />
    </svg>
  )
}

// BL：连接器 tab（T 形 + 圆孔）
function CornerBL({ color, accent, size, sw }: { color: string; accent: string; size: number; sw: number }) {
  return (
    <svg width={size} height={size}
      style={{ position: 'absolute', bottom: 0, left: 0, transform: 'scaleY(-1)', overflow: 'visible' }}
    >
      <polyline
        points={`0.5,${size - 4} 0.5,4 4,0.5 ${size - 4},0.5`}
        stroke={color} strokeWidth={sw + 0.1} fill="none"
        strokeLinecap="square" strokeLinejoin="miter"
        style={{ filter: `drop-shadow(0 0 3px ${color}BB)` }}
      />
      <line x1={1} y1={6} x2={6} y2={1} stroke={color} strokeWidth={sw + 0.2}
        style={{ filter: `drop-shadow(0 0 3px ${color}CC)` }} />
      {/* T 形插口 */}
      <rect x={6} y={5} width={7} height={4} stroke={color} strokeWidth={sw * 0.7} fill="none" opacity={0.65} />
      <line x1={9.5} y1={9} x2={9.5} y2={12} stroke={color} strokeWidth={sw * 0.7} opacity={0.55} />
      {/* 圆孔 */}
      <circle cx={9.5} cy={7} r={0.8} fill={color} opacity={0.9} />
      {/* accent 横短线 */}
      <line x1={size - 6} y1={3} x2={size - 1} y2={3} stroke={accent} strokeWidth={sw * 0.8} opacity={0.8} />
    </svg>
  )
}

// BR：电缆接头（同心圆 + 延伸线）
function CornerBR({ color, accent, size, sw }: { color: string; accent: string; size: number; sw: number }) {
  return (
    <svg width={size} height={size}
      style={{ position: 'absolute', bottom: 0, right: 0, transform: 'scale(-1,-1)', overflow: 'visible' }}
    >
      <polyline
        points={`0.5,${size - 4} 0.5,4 4,0.5 ${size - 4},0.5`}
        stroke={color} strokeWidth={sw + 0.1} fill="none"
        strokeLinecap="square" strokeLinejoin="miter"
        style={{ filter: `drop-shadow(0 0 3px ${color}BB)` }}
      />
      <line x1={1} y1={6} x2={6} y2={1} stroke={color} strokeWidth={sw + 0.2}
        style={{ filter: `drop-shadow(0 0 3px ${color}CC)` }} />
      {/* 电缆虚线段 */}
      <line x1={6} y1={4} x2={size - 2} y2={4} stroke={color} strokeWidth={sw * 0.65} opacity={0.55} strokeDasharray="1.5,1.5" />
      {/* 同心圆接头 */}
      <circle cx={11} cy={11} r={3} stroke={color} strokeWidth={sw * 0.7} fill="none" opacity={0.7} />
      <circle cx={11} cy={11} r={1.1} fill={color} opacity={0.95}
        style={{ filter: `drop-shadow(0 0 2px ${color})` }} />
      {/* accent 方块 */}
      <rect x={size - 6} y={size - 6} width={2} height={2} fill={accent} opacity={0.8} />
    </svg>
  )
}

function HazardStripe({ side, color }: { side: 'left' | 'right'; color: string }) {
  return (
    <div style={{
      position: 'absolute',
      [side]: 3,
      top: '32%', bottom: '32%',
      width: 4,
      background: `repeating-linear-gradient(-45deg, ${color}BB 0, ${color}BB 3px, transparent 3px, transparent 6px)`,
      opacity: 0.55,
      pointerEvents: 'none',
    } as CSSProperties} />
  )
}

function Rivets({ color, cornerSize }: { color: string; cornerSize: number }) {
  const dot: CSSProperties = {
    position: 'absolute',
    width: 2.5, height: 2.5, borderRadius: '50%',
    background: color,
    boxShadow: `0 0 4px ${color}99`,
    opacity: 0.7,
    pointerEvents: 'none',
  }
  return (
    <>
      {/* 上边：偏 corner 侧两个 */}
      <div style={{ ...dot, top: 2, left: cornerSize + 8 }} />
      <div style={{ ...dot, top: 2, right: cornerSize + 8 }} />
      {/* 下边 */}
      <div style={{ ...dot, bottom: 2, left: cornerSize + 8 }} />
      <div style={{ ...dot, bottom: 2, right: cornerSize + 8 }} />
    </>
  )
}
