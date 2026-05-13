// ══════════════════════════════════════════════
// NeonRule — 霓虹分割线（带中心亮点）
// ══════════════════════════════════════════════

import type { CSSProperties } from 'react'
import { theme } from '../../theme'

interface Props {
  readonly vertical?: boolean
  readonly color?: string
  readonly intensity?: 'soft' | 'bright'
  readonly style?: CSSProperties
}

export function NeonRule({
  vertical = false,
  color = theme.electricBlue,
  intensity = 'soft',
  style,
}: Props) {
  const peakA = intensity === 'bright' ? `${color}FF` : `${color}66`
  const peakB = intensity === 'bright' ? `${color}99` : `${color}22`
  const gradient = vertical
    ? `linear-gradient(180deg, transparent 0%, ${peakB} 25%, ${peakA} 50%, ${peakB} 75%, transparent 100%)`
    : `linear-gradient(90deg, transparent 0%, ${peakB} 25%, ${peakA} 50%, ${peakB} 75%, transparent 100%)`

  return (
    <div
      style={{
        ...(vertical
          ? { width: 1, alignSelf: 'stretch' }
          : { height: 1, width: '100%' }),
        background: gradient,
        boxShadow: intensity === 'bright' ? `0 0 4px ${color}80` : undefined,
        ...style,
      }}
    />
  )
}
