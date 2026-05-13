// ══════════════════════════════════════════════
// Neon Brutalism UI Primitives
// 基础 UI 组件：分割线、面板、徽章、按钮
// ══════════════════════════════════════════════

import type { CSSProperties, ReactNode } from 'react'
import { theme } from '../theme'

// ── Neon Divider ──

export function NeonDivider({ vertical = false }: { vertical?: boolean }) {
  const style: CSSProperties = vertical
    ? { width: 1, alignSelf: 'stretch', background: theme.divider }
    : { height: 1, width: '100%', background: theme.divider }
  return <div style={style} />
}

// ── Brutal Panel ──

export function BrutalPanel({
  children,
  style,
  glow,
}: {
  children: ReactNode
  style?: CSSProperties
  glow?: string
}) {
  return (
    <div
      style={{
        background: theme.glass,
        border: `1px solid ${theme.glassBorder}`,
        borderRadius: 8,
        padding: 12,
        boxShadow: glow
          ? `0 0 6px ${glow}40, 0 0 16px ${glow}20`
          : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// ── Neon Badge ──

export function NeonBadge({
  text,
  color = theme.electricBlue,
  size = 'sm',
}: {
  text: string
  color?: string
  size?: 'xs' | 'sm'
}) {
  const fontSize = size === 'xs' ? 9 : 10
  const padding = size === 'xs' ? '1px 4px' : '2px 6px'
  return (
    <span
      style={{
        fontSize,
        fontFamily: theme.fontBody,
        fontWeight: 'bold',
        padding,
        borderRadius: 3,
        background: `${color}26`,
        color,
        letterSpacing: 0.5,
      }}
    >
      {text}
    </span>
  )
}

// ── Section Header ──

export function SectionHeader({
  title,
  count,
  color = theme.electricBlue,
}: {
  title: string
  count?: number
  color?: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 800,
          fontFamily: theme.fontBody,
          color: theme.textSecondary,
          letterSpacing: 2,
          textTransform: 'uppercase',
        }}
      >
        {title}
      </span>
      {count !== undefined && (
        <NeonBadge text={String(count)} color={color} size="xs" />
      )}
    </div>
  )
}

// ── Magnetic Button ──

export function MagneticButton({
  children,
  onClick,
  color = theme.electricBlue,
  disabled = false,
  style: extraStyle,
}: {
  children: ReactNode
  onClick?: () => void
  color?: string
  disabled?: boolean
  style?: CSSProperties
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'transparent',
        border: `1px solid ${color}4D`,
        color: disabled ? theme.textSecondary : color,
        fontFamily: theme.fontBody,
        fontSize: 11,
        padding: '4px 12px',
        cursor: disabled ? 'default' : 'pointer',
        borderRadius: 3,
        letterSpacing: 1,
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.2s ease',
        ...extraStyle,
      }}
    >
      {children}
    </button>
  )
}

// ── Progress Bar ──

export function NeonProgressBar({
  progress,
  color = theme.electricBlue,
  height = 6,
}: {
  progress: number   // 0-1
  color?: string
  height?: number
}) {
  const clamped = Math.max(0, Math.min(1, progress))
  return (
    <div
      style={{
        width: '100%',
        height,
        background: 'rgba(255,255,255,0.05)',
        borderRadius: height / 2,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          background: `linear-gradient(90deg, ${color}99, ${color})`,
          borderRadius: height / 2,
          boxShadow: `0 0 6px ${color}60`,
          transition: 'width 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      />
    </div>
  )
}

// ── Glow Text ──

export function GlowText({
  text,
  color = theme.electricBlue,
  size = 13,
  weight = 'bold',
}: {
  text: string
  color?: string
  size?: number
  weight?: string
}) {
  return (
    <span
      style={{
        fontSize: size,
        fontWeight: weight as CSSProperties['fontWeight'],
        fontFamily: theme.fontBody,
        color,
        textShadow: `0 0 6px ${color}80, 0 0 16px ${color}40`,
      }}
    >
      {text}
    </span>
  )
}
