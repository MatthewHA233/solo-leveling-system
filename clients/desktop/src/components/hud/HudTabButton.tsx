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
  const xRightEdge = width - 1.5
  const xRightTriIn = width - 7.5
  const yBottom = height - 1.5
  const yLeftBracketTop = height - 6.5
  const yRightBracketTop = 33 / 52 * height
  const yRightTriTop = height - 7.5

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
        transition: 'opacity 0.3s ease',
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

        <g style={{ filter: `url(#${filtId})`, transition: 'opacity 0.3s ease', opacity: lit ? 1 : 0.78 }}>
          {/* 左下 L */}
          <path
            d={`M 1.5 ${yLeftBracketTop} L 1.5 ${yBottom} L ${xLeftBracket} ${yBottom}`}
            fill="none" stroke={color} strokeWidth="3" strokeLinejoin="miter"
          />
          {/* 中间细线 */}
          <line x1={xLeftBracket} y1={yBottom} x2={xRightBracket} y2={yBottom} stroke={color} strokeWidth="1" />
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
        transition: 'all 0.3s ease',
        userSelect: 'none',
      } as CSSProperties}>
        {label}
      </div>
    </div>
  )
}
