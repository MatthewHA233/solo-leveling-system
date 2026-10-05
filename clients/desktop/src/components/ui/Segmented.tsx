// ══════════════════════════════════════════════
// 段选：下沉黑玻璃槽里的一排键，选中的那格是整块语义色 + 黑色粗体字（昼夜表 / 洪流域工具条共用）
// ══════════════════════════════════════════════

import Tooltip from '../Tooltip'
import { theme } from '../../theme'

export interface SegOption<T extends string> {
  readonly value: T
  readonly label: string
  /** 选中时整块的颜色（语义色：实际 = 绿、计划 = 琥珀……） */
  readonly led: string
  readonly tip: string
}

export default function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: readonly SegOption<T>[]
  onChange: (v: T) => void
}) {
  return (
    <div className="ti-well" style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 5 }}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <Tooltip key={o.value} content={o.tip}>
            <button
              type="button"
              className="dn-seg"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              style={{
                height: 22, padding: '0 11px',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 12.5, fontWeight: active ? 900 : 600, borderRadius: 4,
                border: 'none', cursor: 'pointer',
                color: active ? '#140A04' : theme.paperDim,
                background: active
                  ? `linear-gradient(180deg, rgba(255,255,255,0.38), rgba(255,255,255,0) 65%), ${o.led}`
                  : 'transparent',
                boxShadow: active ? `0 0 0 1px #080807, 0 0 10px ${o.led}55` : 'none',
                pointerEvents: active ? 'none' : undefined,
              }}
            >
              {!active && (
                <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: o.led, opacity: 0.8 }} />
              )}
              {o.label}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
