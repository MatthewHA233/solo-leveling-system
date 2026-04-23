// ══════════════════════════════════════════════
// DataRibbon — HUD 式标签-数值双行读数
// 例：  TIME  14:32:07   /   STATE  ONLINE
// ══════════════════════════════════════════════

import type { CSSProperties, ReactNode } from 'react'
import { theme } from '../../theme'

interface Props {
  readonly label: string
  readonly value: ReactNode
  readonly color?: string
  readonly valueMono?: boolean
  readonly flicker?: boolean
  readonly style?: CSSProperties
}

export function DataRibbon({
  label, value, color = theme.electricBlue,
  valueMono = true, flicker = false, style,
}: Props) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      gap: 1, lineHeight: 1,
      ...style,
    }}>
      <span style={{
        fontSize: 8.5,
        letterSpacing: 1.8,
        fontWeight: 700,
        color: theme.textMuted,
        fontFamily: theme.fontBody,
        textTransform: 'uppercase',
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 11,
        fontWeight: 700,
        color,
        fontFamily: valueMono ? theme.fontMono : theme.fontDisplay,
        textShadow: `0 0 6px ${color}88`,
        letterSpacing: valueMono ? 0.5 : 1.5,
        animation: flicker ? 'hudFlicker 3.2s linear infinite' : undefined,
      }}>
        {value}
      </span>
    </div>
  )
}
