// 笔记里的小菜单（页面「⋯」、更多操作）：钛板浮层里一列键，危险项是红字

import type { ComponentType } from 'react'
import Floating, { type FloatingAnchor } from './Floating'

export interface PopMenuItem {
  readonly key: string
  readonly label: string
  readonly icon?: ComponentType<{ size?: number; strokeWidth?: number }>
  readonly hint?: string
  readonly danger?: boolean
  readonly checked?: boolean
  readonly onSelect: () => void
}

export type PopMenuEntry = PopMenuItem | 'sep'

export default function PopMenu({ anchor, items, onClose, placement = 'bottom-start' }: {
  readonly anchor: FloatingAnchor
  readonly items: readonly PopMenuEntry[]
  readonly onClose: () => void
  readonly placement?: 'bottom-start' | 'bottom-end' | 'right-start'
}) {
  return (
    <Floating anchor={anchor} onClose={onClose} placement={placement} width={220} className="nt-menu">
      {items.map((it, i) => {
        if (it === 'sep') return <div key={`sep-${i}`} className="nt-menu-sep" />
        const Icon = it.icon
        return (
          <button
            key={it.key}
            type="button"
            className="nt-menu-item"
            data-danger={it.danger ? '1' : undefined}
            onClick={() => { onClose(); it.onSelect() }}
          >
            <span className="nt-menu-icon">{Icon && <Icon size={14} strokeWidth={2.1} />}</span>
            <span className="nt-menu-label">{it.label}</span>
            {it.checked !== undefined && <span className="ti-dot" style={{ background: it.checked ? 'var(--ti-led)' : '#3A3733', boxShadow: it.checked ? '0 0 6px rgba(255,120,60,0.9)' : 'none' }} />}
            {it.hint && <span className="nt-menu-hint">{it.hint}</span>}
          </button>
        )
      })}
    </Floating>
  )
}
