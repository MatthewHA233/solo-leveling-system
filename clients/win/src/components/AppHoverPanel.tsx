// ══════════════════════════════════════════════
// AppHoverPanel — 程序轨道悬浮/固定时右侧栏面板（HUD 风格）
// 显示：程序图标 + 程序名 + 时段 + ManicTime 截图
// ══════════════════════════════════════════════

import { useState, useEffect } from 'react'
import type { MtSpan } from '../lib/local-api'
import { theme } from '../theme'

interface Props {
  span: MtSpan
  date: Date
}

const clip4 = `polygon(
  4px 0, calc(100% - 4px) 0,
  100% 4px, 100% calc(100% - 4px),
  calc(100% - 4px) 100%, 4px 100%,
  0 calc(100% - 4px), 0 4px
)`

const clip3 = `polygon(
  3px 0, calc(100% - 3px) 0,
  100% 3px, 100% calc(100% - 3px),
  calc(100% - 3px) 100%, 3px 100%,
  0 calc(100% - 3px), 0 3px
)`

function fmt(dt: string) {
  return dt.split(' ')[1]?.slice(0, 5) ?? dt
}

function durationMin(span: MtSpan) {
  const toMin = (dt: string) => {
    const t = dt.split(' ')[1] ?? ''
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }
  return Math.max(0, toMin(span.end_at) - toMin(span.start_at))
}

function hexToRgba(hex: string, alpha: number) {
  if (!hex.startsWith('#') || hex.length < 7) return `rgba(128,128,128,${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export default function AppHoverPanel({ span, date }: Props) {
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [imgError, setImgError] = useState(false)
  const [iconUrl, setIconUrl] = useState<string | null>(null)

  const color = span.color ?? '#4488ff'
  const mins = durationMin(span)
  const durStr = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`
  const displayName = span.group_name ?? span.title
  const hasWindowTitle = !!(span.group_name && span.title !== span.group_name)

  // 加载应用图标
  useEffect(() => {
    if (!span.group_name) return
    let objUrl: string | null = null
    fetch(`http://localhost:3000/api/manictime/app-icon?name=${encodeURIComponent(span.group_name)}`)
      .then((r) => { if (!r.ok) throw new Error('no icon'); return r.blob() })
      .then((blob) => { objUrl = URL.createObjectURL(blob); setIconUrl(objUrl) })
      .catch(() => setIconUrl(null))
    return () => { if (objUrl) URL.revokeObjectURL(objUrl) }
  }, [span.group_name])

  useEffect(() => {
    setScreenshotUrl(null)
    setImgError(false)

    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const timeStr = span.start_at.split(' ')[1] ?? '00:00:00'
    const url = `http://localhost:3000/api/manictime/screenshot?date=${dateStr}&time=${encodeURIComponent(timeStr)}`

    let objectUrl: string | null = null
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error('no screenshot'); return r.blob() })
      .then((blob) => { objectUrl = URL.createObjectURL(blob); setScreenshotUrl(objectUrl) })
      .catch(() => setImgError(true))

    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [span.id, date])

  return (
    <div style={{
      padding: '12px 16px 14px',
      borderTop: `1px solid ${hexToRgba(color, 0.2)}`,
      fontFamily: theme.fontBody,
    }}>
      {/* Section Header */}
      <SectionHeader label="APP · DETAIL" color={color} />

      {/* 程序名 + 图标 + 时长 chip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9,
        marginBottom: 8,
        padding: '6px 10px',
        background: `linear-gradient(90deg, ${hexToRgba(color, 0.1)} 0%, ${hexToRgba(color, 0.02)} 100%)`,
        border: `1px solid ${hexToRgba(color, 0.3)}`,
        clipPath: clip4, WebkitClipPath: clip4,
      }}>
        {/* 图标（斜切 + 发光） */}
        <div style={{
          width: 22, height: 22, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          clipPath: clip3, WebkitClipPath: clip3,
          background: iconUrl ? 'transparent' : `linear-gradient(135deg, ${color} 0%, ${hexToRgba(color, 0.6)} 100%)`,
          boxShadow: `0 0 6px ${hexToRgba(color, 0.5)}`,
        }}>
          {iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              style={{ width: 20, height: 20, imageRendering: 'pixelated' }}
            />
          ) : (
            <span style={{ fontSize: 12, fontWeight: 700, color: '#001018' }}>
              {displayName.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        {/* 程序名 */}
        <span style={{
          flex: 1,
          fontSize: 12.5, fontWeight: 700,
          fontFamily: theme.fontBody,
          color: theme.textPrimary,
          textShadow: `0 0 5px ${hexToRgba(color, 0.5)}`,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          letterSpacing: 0.3,
        }}>
          {displayName}
        </span>

        {/* 时长 chip */}
        <span style={{
          flexShrink: 0,
          fontSize: 10, fontWeight: 700,
          fontFamily: theme.fontMono,
          letterSpacing: 0.8,
          color,
          padding: '2px 8px',
          background: hexToRgba(color, 0.12),
          border: `1px solid ${hexToRgba(color, 0.5)}`,
          clipPath: clip3, WebkitClipPath: clip3,
          textShadow: `0 0 5px ${hexToRgba(color, 0.7)}`,
        }}>
          {durStr}
        </span>
      </div>

      {/* 时间段（mono 细节行） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        marginBottom: hasWindowTitle ? 4 : 10,
        padding: '0 2px',
      }}>
        <span style={{
          fontSize: 8.5, fontFamily: theme.fontMono, fontWeight: 600,
          color: theme.textMuted, letterSpacing: 1.4,
        }}>
          TIME
        </span>
        <span style={{
          fontSize: 10.5, fontFamily: theme.fontMono, fontWeight: 600,
          color: theme.textSecondary, letterSpacing: 0.3,
        }}>
          {fmt(span.start_at)}
          <span style={{ color: hexToRgba(color, 0.6), margin: '0 4px' }}>→</span>
          {fmt(span.end_at)}
        </span>
      </div>

      {/* 窗口标题（仅在有差异时显示） */}
      {hasWindowTitle && (
        <div style={{
          marginBottom: 10,
          padding: '5px 8px',
          background: 'rgba(0,12,28,0.4)',
          border: `1px solid ${theme.hudFrameSoft}`,
          clipPath: clip3, WebkitClipPath: clip3,
          fontSize: 10,
          fontFamily: theme.fontMono,
          color: theme.textSecondary,
          letterSpacing: 0.2,
          lineHeight: 1.4,
          wordBreak: 'break-all',
          opacity: 0.85,
        }}>
          <span style={{
            fontSize: 8, fontWeight: 700,
            color: theme.textMuted, letterSpacing: 1.4,
            marginRight: 5,
          }}>
            WIN
          </span>
          {span.title.length > 80 ? span.title.slice(0, 80) + '…' : span.title}
        </div>
      )}

      {/* 截图（HUD frame：斜切 + 彩色边框 + 角 L 标）*/}
      {screenshotUrl && (
        <ScreenshotFrame src={screenshotUrl} color={color} onError={() => setImgError(true)} />
      )}
      {imgError && !screenshotUrl && (
        <div style={{
          fontSize: 9, fontFamily: theme.fontMono,
          color: theme.textMuted, textAlign: 'center',
          padding: '10px 0',
          letterSpacing: 1.5,
          opacity: 0.6,
        }}>
          ─ NO SCREENSHOT ─
        </div>
      )}
    </div>
  )
}

function SectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      marginBottom: 10,
      fontSize: 8.5, fontFamily: theme.fontMono, fontWeight: 700,
      letterSpacing: 2.5,
      color,
    }}>
      <span style={{ textShadow: `0 0 5px ${hexToRgba(color, 0.7)}` }}>
        ▸ {label}
      </span>
      <span style={{
        flex: 1, height: 1,
        background: `linear-gradient(90deg, ${hexToRgba(color, 0.45)} 0%, transparent 100%)`,
      }} />
    </div>
  )
}

function ScreenshotFrame({ src, color, onError }: { src: string; color: string; onError: () => void }) {
  return (
    <div style={{
      position: 'relative',
      padding: 3,
      background: `linear-gradient(135deg, ${hexToRgba(color, 0.22)} 0%, ${hexToRgba(color, 0.05)} 100%)`,
      clipPath: clip4, WebkitClipPath: clip4,
      boxShadow: `0 0 10px ${hexToRgba(color, 0.25)}`,
    }}>
      <img
        src={src}
        alt="screenshot"
        onError={onError}
        style={{
          width: '100%', display: 'block',
          clipPath: clip3, WebkitClipPath: clip3,
        }}
      />
      {/* 四角 L 标：视觉 HUD 收口 */}
      <Corner pos="tl" color={color} />
      <Corner pos="tr" color={color} />
      <Corner pos="bl" color={color} />
      <Corner pos="br" color={color} />
    </div>
  )
}

function Corner({ pos, color }: { pos: 'tl' | 'tr' | 'bl' | 'br'; color: string }) {
  const sz = 7
  const style: React.CSSProperties = {
    position: 'absolute', width: sz, height: sz,
    pointerEvents: 'none',
    borderColor: color,
    filter: `drop-shadow(0 0 3px ${hexToRgba(color, 0.7)})`,
  }
  if (pos === 'tl') { style.left = -1;  style.top = -1;    style.borderTop = `1.5px solid`;    style.borderLeft  = `1.5px solid` }
  if (pos === 'tr') { style.right = -1; style.top = -1;    style.borderTop = `1.5px solid`;    style.borderRight = `1.5px solid` }
  if (pos === 'bl') { style.left = -1;  style.bottom = -1; style.borderBottom = `1.5px solid`; style.borderLeft  = `1.5px solid` }
  if (pos === 'br') { style.right = -1; style.bottom = -1; style.borderBottom = `1.5px solid`; style.borderRight = `1.5px solid` }
  return <span style={style} />
}
