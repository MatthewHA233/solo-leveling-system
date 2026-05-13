// ══════════════════════════════════════════════
// HudCommandStrip — 顶栏专用 HUD 装饰层
// 设计原则：所有元素都与唯一的底边线对齐，不做顶/侧线以免喧宾夺主
//   · 一条发光底线（被中央凹槽打断为左右两段）
//   · 中央 V 形凹陷（handshake）+ 嵌入单行 mono 标签
//   · 两端倒角平行四边形 tab（底部贴线对齐）+ 小型 mono 徽章
// 不使用: 顶边线 / 桥型凸起 / 刻度 / 铆钉 / 锯齿（避免"针线活"视觉）
// ══════════════════════════════════════════════

import type { CSSProperties } from 'react'
import { theme } from '../../theme'

interface HudCommandStripProps {
  readonly color?: string
  readonly accent?: string
  readonly centerLabel?: string
  readonly leftBadge?: string
  readonly rightBadge?: string
}

export function HudCommandStrip({
  color = theme.electricBlue,
  accent = theme.warningOrange,
  centerLabel,
  leftBadge,
  rightBadge,
}: HudCommandStripProps) {
  const notchW = centerLabel ? Math.max(centerLabel.length * 6.8 + 28, 160) : 0
  const notchD = 7
  const tabW = 58
  const tabH = 18

  const line: CSSProperties = {
    position: 'absolute',
    bottom: 0,
    height: 1,
    background: color,
    boxShadow: `0 0 4px ${color}88`,
    pointerEvents: 'none',
  }

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
      {/* ── 底边线（遇中央凹槽断裂） ── */}
      <div style={{
        ...line,
        left: tabW + 4,
        width: centerLabel
          ? `calc(50% - ${tabW + 4}px - ${notchW / 2}px)`
          : `calc(100% - ${(tabW + 4) * 2}px)`,
      }} />
      {centerLabel && (
        <div style={{
          ...line,
          right: tabW + 4,
          width: `calc(50% - ${tabW + 4}px - ${notchW / 2}px)`,
        }} />
      )}

      {/* ── 中央 V 形凹陷 + 标签 ── */}
      {centerLabel && (
        <CenterNotch color={color} accent={accent} w={notchW} d={notchD} label={centerLabel} />
      )}

      {/* ── 两端倒角 tab + 徽章 ── */}
      <EndTab side="left"  color={color} accent={accent} w={tabW} h={tabH} badge={leftBadge} />
      <EndTab side="right" color={color} accent={accent} w={tabW} h={tabH} badge={rightBadge} />
    </div>
  )
}

// ──────────────────────────────────────────────

function CenterNotch({
  color, accent, w, d, label,
}: { color: string; accent: string; w: number; d: number; label: string }) {
  const shoulder = 14
  const flatIn   = 26
  const p1 = shoulder
  const p2 = flatIn
  const p3 = w - flatIn
  const p4 = w - shoulder
  return (
    <>
      <svg
        width={w} height={d + 2}
        style={{
          position: 'absolute',
          bottom: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          overflow: 'visible',
        }}
      >
        <path
          d={`M 0 ${d + 0.5} L ${p1} ${d + 0.5} L ${p2} 0.5 L ${p3} 0.5 L ${p4} ${d + 0.5} L ${w} ${d + 0.5}`}
          stroke={color} strokeWidth={1.2} fill="none"
          strokeLinejoin="miter" strokeLinecap="square"
          style={{ filter: `drop-shadow(0 0 3px ${color}AA)` }}
        />
        {/* 平顶下方中心 accent 短线 */}
        <rect x={w / 2 - 6} y={2.5} width={12} height={1} fill={accent} opacity={0.75} />
      </svg>
      <span style={{
        position: 'absolute',
        bottom: d + 4,
        left: '50%',
        transform: 'translateX(-50%)',
        fontSize: 9,
        fontFamily: theme.fontMono,
        fontWeight: 700,
        letterSpacing: 2.4,
        color,
        textShadow: `0 0 6px ${color}BB`,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}>{label}</span>
    </>
  )
}

function EndTab({
  side, color, accent, w, h, badge,
}: {
  side: 'left' | 'right'
  color: string
  accent: string
  w: number
  h: number
  badge?: string
}) {
  const flip = side === 'right' ? 'scaleX(-1)' : undefined
  const cornerW = h * 0.55
  return (
    <>
      <svg
        width={w} height={h + 1}
        style={{
          position: 'absolute',
          bottom: 0,
          [side]: 0,
          transform: flip,
          overflow: 'visible',
        } as CSSProperties}
      >
        {/*
          倒角平行四边形：
          左下 → 右下（贴底线） → 右上 → 左上 → 斜切回左下
        */}
        <path
          d={`M 0.5 ${h + 0.5} L ${w - 0.5} ${h + 0.5} L ${w - 0.5} 0.5 L ${cornerW} 0.5 L 0.5 ${h - cornerW + 0.5} Z`}
          stroke={color} strokeWidth={1.2} fill={`${color}12`}
          strokeLinejoin="miter" strokeLinecap="square"
          style={{ filter: `drop-shadow(0 0 3px ${color}99)` }}
        />
        {/* 内部右侧 accent 短线 */}
        <rect x={w - 9} y={4} width={5} height={1.2} fill={accent} opacity={0.85} />
        {/* 内部右侧小铆点 */}
        <circle cx={w - 6} cy={h - 4} r={1} fill={color} opacity={0.8} />
      </svg>
      {badge && (
        <span style={{
          position: 'absolute',
          bottom: h / 2 - 5,
          [side]: 12,
          fontSize: 8.5,
          fontFamily: theme.fontMono,
          fontWeight: 700,
          letterSpacing: 1.6,
          color,
          textShadow: `0 0 4px ${color}BB`,
          lineHeight: 1,
          pointerEvents: 'none',
        } as CSSProperties}>{badge}</span>
      )}
    </>
  )
}
