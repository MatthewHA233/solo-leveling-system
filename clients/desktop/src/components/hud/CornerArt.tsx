// ══════════════════════════════════════════════
// CornerArt — 主舞台外壳 4 角折角艺术装饰
//   · 双层折角亮条（与主体切角平行，内层 offset 1.8）
//   · 内 L 描线（3 段 polyline，offset 4 内缩）
//   · 端点小口（2 个 2×2 黑矩形）
//   · 设计原型在 HudFrame.tsx CornerTL，CSS transform 镜像到 4 角
// ══════════════════════════════════════════════

import type { CSSProperties } from 'react'
import { theme } from '../../theme'

export type CornerPos = 'tl' | 'tr' | 'bl' | 'br'

interface Props {
  readonly position: CornerPos
  readonly color?: string
}

export function CornerArt({ position, color }: Props) {
  const cyan = color ?? theme.electricBlue
  const cornerCut = 18
  const cornerArm = 18
  const totalSize = cornerCut + cornerArm
  const innerOff = 4
  const lightOff = 1.8
  const tipGap = 3

  // 4 角用 CSS transform 镜像 TL 几何
  const transformMap: Record<CornerPos, string> = {
    tl: 'none',
    tr: 'scaleX(-1)',
    bl: 'scaleY(-1)',
    br: 'scale(-1, -1)',
  }

  const positionStyle: CSSProperties = {
    position: 'absolute',
    width: totalSize, height: totalSize,
    pointerEvents: 'none',
    zIndex: 78,
    transform: transformMap[position],
    transformOrigin: 'center',
    [position.includes('l') ? 'left' : 'right']: 0,
    [position.startsWith('t') ? 'top' : 'bottom']: 0,
  } as CSSProperties

  return (
    <div style={positionStyle}>
      <svg width={totalSize} height={totalSize} style={{ overflow: 'visible' }}>
        <line
          x1={lightOff} y1={cornerCut + lightOff}
          x2={cornerCut + lightOff} y2={lightOff}
          stroke={cyan} strokeOpacity="0.95" strokeWidth="1.3"
          strokeLinecap="butt"
          style={{ filter: `drop-shadow(0 0 3px ${cyan}CC)` }}
        />

        <polyline
          points={`${innerOff},${totalSize - 2} ${innerOff},${cornerCut + innerOff} ${cornerCut + innerOff},${innerOff} ${totalSize - 2},${innerOff}`}
          fill="none"
          stroke={cyan} strokeOpacity="0.55" strokeWidth="0.8"
          strokeLinejoin="miter"
        />

        <rect x={-1} y={totalSize - tipGap - 1} width={2} height={2} fill={theme.background} />
        <rect x={totalSize - tipGap - 1} y={-1} width={2} height={2} fill={theme.background} />
      </svg>
    </div>
  )
}
