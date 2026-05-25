// ══════════════════════════════════════════════
// HudSelect — Neon Brutalism 风格下拉选择
// 替代原生 <select>，统一深色主题 + cyan 高亮
// 支持：
//   - inline=true 时按内容自适应宽度（与按钮同行场景）
//   - 弹出层智能翻转：下方放不下就翻到上方
//   - 高度受可用空间限制并出滚动条，绝不溢出窗口
// ══════════════════════════════════════════════

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { theme } from '../theme'

export interface HudSelectOption<T extends string> {
  readonly value: T
  readonly label: string
  /** 右侧灰色辅助说明（小字） */
  readonly hint?: string
  /** 右侧小圆环进度，0-100 */
  readonly meter?: number
}

interface Props<T extends string> {
  readonly value: T
  readonly options: readonly HudSelectOption<T>[]
  readonly onChange: (v: T) => void
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly popupWidth?: number
  /** true：触发器宽度跟随内容，与按钮同行排列；默认 false（占满父容器宽度） */
  readonly inline?: boolean
}

interface PopPos {
  left: number
  top: number
  minWidth: number      // 至少与触发器同宽
  width: number
  maxHeight: number     // 限定到可用空间，超出滚动
  placement: 'below' | 'above'
}

const VIEWPORT_MARGIN = 8       // 距视窗边的安全边距
const HARD_MAX_HEIGHT = 320     // 即使空间够大也别太长
const HARD_MAX_WIDTH = 460
const TRIGGER_GAP = 4

export default function HudSelect<T extends string>({
  value, options, onChange, placeholder, disabled, inline, popupWidth,
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<PopPos | null>(null)

  const current = options.find((o) => o.value === value)
  // 计算最佳放置：优先下方，下方不够就比较两侧空间，挑大的
  const reposition = () => {
    if (!triggerRef.current) return
    const tr = triggerRef.current.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth

    const spaceBelow = vh - tr.bottom - TRIGGER_GAP - VIEWPORT_MARGIN
    const spaceAbove = tr.top - TRIGGER_GAP - VIEWPORT_MARGIN

    // 用 popup 实际高度判断是否需要翻转（首次渲染前用占位）
    const popH = popRef.current?.scrollHeight ?? 0
    const wantBelow = popH === 0 ? true : popH <= spaceBelow || spaceBelow >= spaceAbove

    const placement: 'below' | 'above' = wantBelow ? 'below' : 'above'
    const available = placement === 'below' ? spaceBelow : spaceAbove
    const maxHeight = Math.max(80, Math.min(HARD_MAX_HEIGHT, available))

    // 水平方向：优先与触发器左对齐；若 popup 比触发器宽且会越界，向左收
    const viewportMaxWidth = Math.max(120, vw - VIEWPORT_MARGIN * 2)
    const targetWidth = popupWidth ?? Math.max(tr.width, HARD_MAX_WIDTH)
    const width = Math.min(targetWidth, viewportMaxWidth)
    const popW = width
    let left = tr.left
    if (left + popW > vw - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, vw - popW - VIEWPORT_MARGIN)
    }

    const top = placement === 'below'
      ? tr.bottom + TRIGGER_GAP
      : Math.max(VIEWPORT_MARGIN, tr.top - TRIGGER_GAP - Math.min(popH, maxHeight))

    setPos((prev) => {
      if (
        prev &&
        prev.left === left &&
        prev.top === top &&
        prev.minWidth === tr.width &&
        prev.width === width &&
        prev.maxHeight === maxHeight &&
        prev.placement === placement
      ) return prev
      return { left, top, minWidth: tr.width, width, maxHeight, placement }
    })
  }

  // 打开时初始定位（用估算高度，立即可见，避免闪烁）
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    reposition()
    // 下一帧再测一次，此时 popup 已挂载，能拿到真实高度
    const r = requestAnimationFrame(reposition)
    return () => cancelAnimationFrame(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 滚动 / 窗口尺寸变化时重新定位
  useEffect(() => {
    if (!open) return
    const onScroll = () => reposition()
    const onResize = () => reposition()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 外部点击关闭 + Esc
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const borderColor = open || hover
    ? 'rgba(0,229,255,0.55)'
    : 'rgba(0,229,255,0.18)'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: inline ? 'auto' : '100%',
          minWidth: 0,
          display: inline ? 'inline-flex' : 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          padding: '6px 8px',
          background: open
            ? 'rgba(0,229,255,0.08)'
            : 'rgba(255,255,255,0.03)',
          border: `1px solid ${borderColor}`,
          borderRadius: 4,
          color: current ? theme.textPrimary : theme.textMuted,
          fontFamily: theme.fontBody,
          fontSize: 12,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1,
          outline: 'none',
          whiteSpace: 'nowrap',
          transition: 'border-color 0.12s ease, background 0.12s ease',
          boxShadow: open ? 'inset 0 0 8px rgba(0,229,255,0.15)' : undefined,
        }}
      >
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
          {current?.label ?? placeholder ?? '请选择'}
        </span>
        <ChevronDown
          size={13}
          style={{
            color: open || hover ? theme.electricBlue : theme.textSecondary,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease, color 0.15s ease',
            flexShrink: 0,
          }}
        />
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          className="hud-select-popup"
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            minWidth: popupWidth ? undefined : pos.minWidth,
            width: pos.width,
            maxWidth: pos.width,
            maxHeight: pos.maxHeight,
            zIndex: 9999,
            background: theme.panelDeep,
            border: `1px solid rgba(0,229,255,0.45)`,
            borderRadius: 4,
            boxShadow: '0 6px 20px rgba(0,0,0,0.55), 0 0 14px rgba(0,229,255,0.25)',
            padding: 4,
            overflowY: 'auto',
            overflowX: 'hidden',
            backdropFilter: 'blur(6px)',
            animation: 'hudSelectFade 140ms ease-out',
          }}
        >
          {options.map((opt) => {
            const selected = opt.value === value
            return (
              <HudSelectRow
                key={opt.value}
                label={opt.label}
                hint={opt.hint}
                meter={opt.meter}
                selected={selected}
                onClick={() => { onChange(opt.value); setOpen(false) }}
              />
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}

function HudSelectRow({
  label, hint, meter, selected, onClick,
}: {
  label: string
  hint?: string
  meter?: number
  selected: boolean
  onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const active = selected || hover
  const hasMeter = typeof meter === 'number' && Number.isFinite(meter)
  const pct = hasMeter ? Math.max(0, Math.min(100, meter)) : 0
  const visiblePct = pct >= 100 ? 100 : Math.min(pct, 94)
  const ringColor = pct > 35 ? theme.expGreen : pct > 10 ? theme.warningOrange : theme.dangerRed
  const ringR = 6
  const ringC = 2 * Math.PI * ringR
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: hasMeter || hint
          ? '12px minmax(0, 1fr) 132px 16px'
          : '12px minmax(0, 1fr)',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 3,
        cursor: 'pointer',
        background: hover
          ? 'rgba(0,229,255,0.12)'
          : selected
          ? 'rgba(0,229,255,0.06)'
          : 'transparent',
        color: active ? theme.electricBlue : theme.textPrimary,
        fontFamily: theme.fontBody,
        fontSize: 12,
        whiteSpace: 'nowrap',
        minWidth: 0,
        transition: 'background 0.1s ease, color 0.1s ease',
      }}
    >
      <span style={{
        width: 12, display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {selected ? <Check size={11} style={{ color: theme.electricBlue }} /> : null}
      </span>
      <span style={{
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {label}
      </span>
      {hint && (
        <span style={{
          fontSize: 10,
          color: theme.textMuted,
          letterSpacing: 0.3,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'right',
        }}>
          {hint}
        </span>
      )}
      {hasMeter && (
        <span
          title={`${Math.round(pct)}%`}
          style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block', overflow: 'visible' }}>
            <circle cx="8" cy="8" r={ringR} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="3" />
            <circle
              cx="8"
              cy="8"
              r={ringR}
              fill="none"
              stroke={ringColor}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={ringC}
              strokeDashoffset={ringC * (1 - visiblePct / 100)}
              transform="rotate(-90 8 8)"
              style={{ filter: `drop-shadow(0 0 4px ${ringColor}88)` }}
            />
          </svg>
        </span>
      )}
    </div>
  )
}
