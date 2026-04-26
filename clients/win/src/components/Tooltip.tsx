// ══════════════════════════════════════════════
// Tooltip — 全局自定义悬浮提示
// 替代浏览器原生 title，统一 HUD 风格
// ══════════════════════════════════════════════

import { useState, useRef, useEffect, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { theme } from '../theme'

interface Props {
  readonly content: ReactNode
  readonly children: ReactNode
  /** 显示延迟 ms，默认 400 */
  readonly delay?: number
  /** 优先位置，空间不足会自动翻转 */
  readonly side?: 'top' | 'bottom'
  /** 包装层 display，默认 inline-flex（不破坏原布局） */
  readonly display?: CSSProperties['display']
  /** 包装层附加样式 */
  readonly wrapStyle?: CSSProperties
  /** 禁用 tooltip（保留 children 行为） */
  readonly disabled?: boolean
}

export default function Tooltip({
  content, children, delay = 180, side = 'top',
  display = 'inline-flex', wrapStyle, disabled,
}: Props) {
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number; placement: 'top' | 'bottom'; shiftX: number } | null>(null)

  const show = () => {
    if (disabled || !content) return
    timerRef.current = window.setTimeout(() => {
      const el = wrapRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const placement = side === 'top' && r.top > 44 ? 'top' : 'bottom'
      const cx = r.left + r.width / 2
      const y = placement === 'top' ? r.top - 6 : r.bottom + 6
      const vw = window.innerWidth
      const half = Math.min(160, cx, vw - cx)
      const margin = 6
      const x = Math.max(margin + half, Math.min(vw - margin - half, cx))
      setPos({ x, y, placement, shiftX: cx - x })
      setOpen(true)
    }, delay)
  }

  const hide = () => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null }
    setOpen(false)
  }

  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current) }, [])

  return (
    <>
      <span
        ref={wrapRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onMouseDown={hide}
        style={{ display, ...wrapStyle }}
      >
        {children}
      </span>
      {open && pos && createPortal(
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            ['--tt-from' as any]: pos.placement === 'top' ? '-92%' : '8%',
            ['--tt-to'   as any]: pos.placement === 'top' ? '-100%' : '0%',
            transform: pos.placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
            background: 'rgba(8, 16, 32, 0.96)',
            border: `1px solid ${theme.electricBlue}55`,
            color: theme.textPrimary,
            fontSize: 11,
            fontFamily: theme.fontMono,
            letterSpacing: 0.3,
            lineHeight: 1.45,
            padding: '5px 9px',
            borderRadius: 5,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            zIndex: 99999,
            boxShadow: `0 4px 14px rgba(0,0,0,0.55), 0 0 10px ${theme.electricBlue}33`,
            animation: 'tooltip-fade 0.12s ease-out',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
          }}
        >
          {content}
          {/* 尾巴：边框层 */}
          <span style={{
            position: 'absolute',
            left: `calc(50% + ${pos.shiftX}px)`,
            transform: 'translateX(-50%)',
            width: 0, height: 0,
            borderStyle: 'solid',
            ...(pos.placement === 'top'
              ? { top: '100%', borderWidth: '5px 5px 0 5px', borderColor: `${theme.electricBlue}55 transparent transparent transparent` }
              : { bottom: '100%', borderWidth: '0 5px 5px 5px', borderColor: `transparent transparent ${theme.electricBlue}55 transparent` }),
          }} />
          {/* 尾巴：填充层（盖在边框层上 1px） */}
          <span style={{
            position: 'absolute',
            left: `calc(50% + ${pos.shiftX}px)`,
            transform: 'translateX(-50%)',
            width: 0, height: 0,
            borderStyle: 'solid',
            ...(pos.placement === 'top'
              ? { top: 'calc(100% - 1px)', borderWidth: '5px 5px 0 5px', borderColor: 'rgba(8, 16, 32, 0.96) transparent transparent transparent' }
              : { bottom: 'calc(100% - 1px)', borderWidth: '0 5px 5px 5px', borderColor: 'transparent transparent rgba(8, 16, 32, 0.96) transparent' }),
          }} />
        </div>,
        document.body
      )}
    </>
  )
}
