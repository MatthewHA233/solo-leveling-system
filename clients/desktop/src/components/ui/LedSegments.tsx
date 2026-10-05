// ══════════════════════════════════════════════
// LED 段码条：一排（或一列）小灯格，亮几格表示一个比例
//   用在上下文占用（CTX）、信号强度等"有真实数据"的地方——不做纯装饰。
// ══════════════════════════════════════════════

import { ti } from '../../theme'

export default function LedSegments({ value, count = 10, vertical = false, color = ti.led, glow = 'rgba(255,120,60,0.8)', thickness = 3, length = 10, gap = 2 }: {
  /** 0–1，亮起的比例（向上取整到格） */
  value: number
  count?: number
  /** 竖排时从下往上亮 */
  vertical?: boolean
  color?: string
  glow?: string
  thickness?: number
  length?: number
  gap?: number
}) {
  const clamped = Math.min(1, Math.max(0, value))
  const lit = clamped > 0 ? Math.max(1, Math.ceil(clamped * count)) : 0
  return (
    <div
      aria-hidden
      style={{
        display: 'flex',
        flexDirection: vertical ? 'column-reverse' : 'row',
        gap,
        flexShrink: 0,
      }}
    >
      {Array.from({ length: count }, (_, i) => {
        const on = i < lit
        return (
          <span
            key={i}
            style={{
              width: vertical ? length : thickness,
              height: vertical ? thickness : length,
              borderRadius: 1,
              background: on ? color : ti.ledOff,
              boxShadow: on ? `0 0 4px ${glow}` : 'none',
              transition: 'background 0.2s, box-shadow 0.2s',
            }}
          />
        )
      })}
    </div>
  )
}
