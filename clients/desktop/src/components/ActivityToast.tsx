// ══════════════════════════════════════════════
// ActivityToast — 涂块/擦块底部提示，5s 自动消失
// 居中于昼夜表（避开右侧 340px 面板）
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { theme } from '../theme'

interface Props {
  toast: {
    id: number
    startMin: number
    endMin: number
    path: string
    color: string
    mode: 'paint' | 'erase'
  } | null
  onDismiss: () => void
  /** 右栏当前宽度（用于居中算偏移）— 不传走 340 默认 */
  rightPanelWidth?: number
}

const DURATION_MS = 5_000

function fmtTime(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export default function ActivityToast({ toast, onDismiss, rightPanelWidth = 340 }: Props) {
  const [visible, setVisible] = useState(false)
  // 用 ref 持有最新 onDismiss，避免父组件每次 render 都重置定时器
  const dismissRef = useRef(onDismiss)
  useEffect(() => { dismissRef.current = onDismiss }, [onDismiss])

  useEffect(() => {
    if (!toast) {
      setVisible(false)
      return
    }
    setVisible(true)
    const hideTimer = setTimeout(() => setVisible(false), DURATION_MS)
    const dismissTimer = setTimeout(() => dismissRef.current(), DURATION_MS + 220)
    return () => {
      clearTimeout(hideTimer)
      clearTimeout(dismissTimer)
    }
    // 仅在新 toast（id 变化）时重启定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id])

  if (!toast) return null

  const minutes = toast.endMin - toast.startMin
  const isErase = toast.mode === 'erase'

  return (
    <div
      style={{
        position: 'fixed',
        // 居中于"主区域 = 视口 - 右面板"：左侧偏移正好让 toast 落在主区中线
        left: `calc(50% - ${rightPanelWidth / 2}px)`,
        bottom: 14,
        transform: `translate(-50%, ${visible ? '0' : '14px'})`,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.18s ease-out, transform 0.18s ease-out',
        zIndex: 9000,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 18px',
        background: 'rgba(4,10,20,0.94)',
        border: `1px solid ${toast.color}AA`,
        boxShadow: `0 6px 24px rgba(0,0,0,0.55), 0 0 24px ${toast.color}33`,
        fontFamily: theme.fontBody,
        color: theme.textPrimary,
        backdropFilter: 'blur(6px)',
        pointerEvents: 'none',
      }}
    >
      <span style={{
        width: 10, height: 10,
        background: isErase ? 'transparent' : toast.color,
        border: `2px solid ${toast.color}`,
        flexShrink: 0,
      }} />
      <span style={{
        fontFamily: theme.fontDisplay,
        fontSize: 13, fontWeight: 600,
        color: toast.color,
        letterSpacing: 1.2,
      }}>
        {fmtTime(toast.startMin)} – {fmtTime(toast.endMin)}
      </span>
      <span style={{ color: theme.textMuted, fontSize: 11 }}>
        {minutes} 分钟
      </span>
      <span style={{ color: theme.textMuted, fontSize: 12 }}>{isErase ? '✕' : '→'}</span>
      <span style={{
        fontSize: 12, color: theme.textPrimary,
        maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {toast.path}
      </span>
    </div>
  )
}
