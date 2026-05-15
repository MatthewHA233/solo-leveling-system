// ══════════════════════════════════════════════
// HudTabButton — 玻璃面 + 底部 L 框 + 三角衔接 + 霓虹辉光
//   设计移植自 gemini-code-1778300566550.html
//   · 玻璃渐变底（顶深底浅）
//   · 顶部 1px 微亮边
//   · 底部断裂式 L 框（左下 L + 中线 + 右下 L 上扬 + 三角衔接点）
//   · gaussianBlur 双层 merge 制造霓虹辉光
//   · 底部 box-blur halo（::after 等价）
// ══════════════════════════════════════════════

import { useId, useState, type CSSProperties } from 'react'

interface HudTabButtonProps {
  readonly label: string
  readonly active: boolean
  readonly color?: string
  readonly width?: number
  readonly height?: number
  readonly onClick?: () => void
}

export function HudTabButton({
  label,
  active,
  color = '#00E5FF',
  width = 170,
  height = 52,
  onClick,
}: HudTabButtonProps) {
  const uid = useId().replace(/:/g, '_')
  const gradId = `hud-tab-glass-${uid}`
  const filtId = `hud-tab-glow-${uid}`
  const [hover, setHover] = useState(false)
  const lit = active || hover

  // 几何：以 170x52 为基准，等比例换算
  const scaleX = width / 170
  const xLeftBracket = 38 * scaleX
  const xRightBracket = width - 27 * scaleX
  const xLeftEdge = 1.5
  const xRightEdge = width - 1.5
  const xRightTriIn = width - 7.5
  const yTop = 1.5
  const yBottom = height - 1.5
  const yLeftBracketTop = height - 6.5
  const yRightBracketTop = 33 / 52 * height
  const yRightTriTop = height - 7.5
  // 上半镜像变量：左上 L 短竖、右上 L 上扬（镜像右下）
  const yLeftTopBracketBottom = 6.5
  const yRightTopBracketBottom = height - 33 / 52 * height
  // 中线底端要对齐 L(strokeWidth=3) 底端,需向下偏移 (3-1)/2 = 1px
  const yMidLine = yBottom + 1
  const yMidLineTop = yTop - 1

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        width, height,
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      {/* 底部辉光 halo（等价 ::after blur 15px） */}
      <div style={{
        position: 'absolute',
        bottom: -2, left: '5%', right: '5%',
        height: 15,
        background: color,
        filter: 'blur(15px)',
        opacity: lit ? 0.65 : 0.28,
        zIndex: 0,
        pointerEvents: 'none',
        transition: 'opacity 0.18s ease-out',
      }} />

      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%',
          zIndex: 1,
          pointerEvents: 'none',
          overflow: 'visible',
        }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#001828" stopOpacity={lit ? 0.18 : 0.10} />
            <stop offset="100%" stopColor="#003b55" stopOpacity={lit ? 0.95 : 0.65} />
          </linearGradient>
          <filter id={filtId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.5" result="blur_inner" />
            <feGaussianBlur stdDeviation="4" result="blur_outer" />
            <feMerge>
              <feMergeNode in="blur_outer" />
              <feMergeNode in="blur_inner" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* 玻璃面 */}
        <polygon points={`0,0 ${width},0 ${width},${height} 0,${height}`} fill={`url(#${gradId})`} />
        {/* 顶部 1px 微亮边 */}
        <line x1="0" y1="0" x2={width} y2="0" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />

        <g style={{ filter: `url(#${filtId})`, transition: 'opacity 0.18s ease-out', opacity: lit ? 1 : 0.78 }}>
          {/* 左上 L（镜像左下,短竖段） */}
          <path
            d={`M ${xLeftEdge} ${yLeftTopBracketBottom} L ${xLeftEdge} ${yTop} L ${xLeftBracket} ${yTop}`}
            fill="none" stroke={color} strokeWidth="3" strokeLinejoin="miter"
          />
          {/* 顶部中线（镜像底部细线,y 上抬 1px 让物理顶端与 L 顶端对齐） */}
          <line x1={xLeftBracket} y1={yMidLineTop} x2={xRightBracket} y2={yMidLineTop} stroke={color} strokeWidth="1" />
          {/* 右上 L（镜像右下,长竖段下扬） */}
          <path
            d={`M ${xRightBracket} ${yTop} L ${xRightEdge} ${yTop} L ${xRightEdge} ${yRightTopBracketBottom}`}
            fill="none" stroke={color} strokeWidth="3" strokeLinejoin="miter"
          />

          {/* 左下 L */}
          <path
            d={`M ${xLeftEdge} ${yLeftBracketTop} L ${xLeftEdge} ${yBottom} L ${xLeftBracket} ${yBottom}`}
            fill="none" stroke={color} strokeWidth="3" strokeLinejoin="miter"
          />
          {/* 中间细线（y 下沉 1px,物理底端与 L 底端对齐,消除"腾空"错觉） */}
          <line x1={xLeftBracket} y1={yMidLine} x2={xRightBracket} y2={yMidLine} stroke={color} strokeWidth="1" />
          {/* 右下 L（上扬） */}
          <path
            d={`M ${xRightBracket} ${yBottom} L ${xRightEdge} ${yBottom} L ${xRightEdge} ${yRightBracketTop}`}
            fill="none" stroke={color} strokeWidth="3" strokeLinejoin="miter"
          />
          {/* 右下三角衔接点 */}
          <polygon
            points={`${xRightTriIn},${yBottom} ${xRightEdge},${yBottom} ${xRightEdge},${yRightTriTop}`}
            fill={color}
          />
        </g>
      </svg>

      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        zIndex: 2,
        color: lit ? '#FFFFFF' : '#D0F8FF',
        fontSize: Math.max(11, Math.round(height * 0.32)),
        fontWeight: 400,
        letterSpacing: 1.6,
        textShadow: lit
          ? `0 0 5px #FFFFFF, 0 0 12px ${color}`
          : `0 0 3px rgba(255,255,255,0.5), 0 0 8px ${color}99`,
        transition: 'color 0.18s ease-out, text-shadow 0.18s ease-out',
        userSelect: 'none',
      } as CSSProperties}>
        {label}
      </div>
    </div>
  )
}
