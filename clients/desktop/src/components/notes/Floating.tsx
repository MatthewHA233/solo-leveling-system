// ══════════════════════════════════════════════
// 笔记里的浮层底座：挂到 body、贴着锚点摆、出屏就翻 / 夹回来；点外面或按 Esc 关。
//   锚点传元素时，点锚点本身不算「点外面」（不然按钮的开关会先关再开）。
// ══════════════════════════════════════════════

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type FloatingAnchor = HTMLElement | DOMRect

export interface FloatingProps {
  readonly anchor: FloatingAnchor
  readonly onClose: () => void
  readonly placement?: 'bottom-start' | 'bottom-end' | 'right-start'
  readonly width?: number
  readonly className?: string
  readonly children: ReactNode
}

const GAP = 6
const EDGE = 8

export default function Floating({ anchor, onClose, placement = 'bottom-start', width, className, children }: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => { closeRef.current = onClose })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = placement === 'bottom-end' ? rect.right - w : placement === 'right-start' ? rect.right + GAP : rect.left
    let top = placement === 'right-start' ? rect.top : rect.bottom + GAP
    if (top + h > vh - EDGE) {
      top = placement === 'right-start' ? vh - h - EDGE : rect.top - h - GAP
    }
    left = Math.min(Math.max(EDGE, left), vw - w - EDGE)
    top = Math.max(EDGE, top)
    setPos({ left, top })
  }, [anchor, placement])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (anchor instanceof HTMLElement && anchor.contains(target)) return
      closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      className={`nt-float ${className ?? ''}`}
      style={{
        position: 'fixed',
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width,
        // 第一帧还没量好位置：先透明着（不用 visibility:hidden——那样里面的输入框拿不到焦点）
        opacity: pos ? 1 : 0,
        pointerEvents: pos ? undefined : 'none',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}
