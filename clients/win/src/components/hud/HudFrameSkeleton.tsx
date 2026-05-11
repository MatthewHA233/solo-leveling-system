// ══════════════════════════════════════════════
// HudFrameSkeleton — 切角矩形 + 主描边 + 4 角强光加粗
//   · 主体：八边形 1px 描边（淡）
//   · 角部：每角一段 L 形短线，加粗 + 强 glow（亮）
//   · 切角偏大（默认 22），HUD 凹角感
//   · ResizeObserver 拿真实尺寸保证切角不变形
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'

interface HudFrameSkeletonProps {
  readonly skin?: string         // 主体描边色
  readonly skinBright?: string   // 角部强光色
  readonly cornerCut?: number    // 切角大小
  readonly cornerArm?: number    // 角部强光臂长（沿边线方向）
  readonly mainStroke?: number   // 主体描边宽
  readonly cornerStroke?: number // 角部加粗宽
  readonly mainGlow?: number     // 主体 glow blur
  readonly cornerGlow?: number   // 角部 glow blur
  readonly opacity?: number
}

export function HudFrameSkeleton({
  skin = '#40CAE8',
  skinBright = '#7DF9FF',
  cornerCut = 18,
  cornerArm = 18,
  mainStroke = 1.2,
  cornerStroke = 1.2,    // 跟 mainStroke 一致，无任何加粗（之前 1.4 仍突兀）
  mainGlow = 4,
  cornerGlow = 4,        // 跟 mainGlow 一致
  opacity = 1,
}: HudFrameSkeletonProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const { w, h } = size
  const c = cornerCut
  const a = cornerArm

  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute', inset: 0,
        pointerEvents: 'none',
        zIndex: 70,
        opacity,
      }}
    >
      {w > 0 && h > 0 && (
        <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
          {/* 主体八边形：淡描边 */}
          <path
            d={`M ${c} 0 L ${w - c} 0 L ${w} ${c} L ${w} ${h - c} L ${w - c} ${h} L ${c} ${h} L 0 ${h - c} L 0 ${c} Z`}
            fill="none"
            stroke={skin}
            strokeWidth={mainStroke}
            strokeLinejoin="miter"
            style={{ filter: `drop-shadow(0 0 ${mainGlow}px ${skin}99)` }}
          />

          {/* 4 角强光：加粗 + 强 glow，覆盖在主描边上方 */}
          <g
            fill="none"
            stroke={skinBright}
            strokeWidth={cornerStroke}
            strokeLinejoin="miter"
            strokeLinecap="butt"
            style={{ filter: `drop-shadow(0 0 ${cornerGlow}px ${skinBright})` }}
          >
            {/* TL: 从 (0, c+a) → (0, c) → (c, 0) → (c+a, 0) */}
            <polyline points={`0,${c + a} 0,${c} ${c},0 ${c + a},0`} />
            {/* TR: 从 (w-c-a, 0) → (w-c, 0) → (w, c) → (w, c+a) */}
            <polyline points={`${w - c - a},0 ${w - c},0 ${w},${c} ${w},${c + a}`} />
            {/* BR: 从 (w, h-c-a) → (w, h-c) → (w-c, h) → (w-c-a, h) */}
            <polyline points={`${w},${h - c - a} ${w},${h - c} ${w - c},${h} ${w - c - a},${h}`} />
            {/* BL: 从 (c+a, h) → (c, h) → (0, h-c) → (0, h-c-a) */}
            <polyline points={`${c + a},${h} ${c},${h} 0,${h - c} 0,${h - c - a}`} />
          </g>
        </svg>
      )}
    </div>
  )
}
