// ══════════════════════════════════════════════
// AppHoverPanel — 程序轨道悬浮/固定时右侧栏面板（HUD 风格）
// 显示：程序图标 + 程序名 + 时段 + 感知截图
// ══════════════════════════════════════════════

import { useState, useEffect } from 'react'
import { EyeOff, Check } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import type { MtSpan } from '../lib/local-api'
import { theme } from '../theme'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  span: MtSpan
  date: Date
  /** 鼠标当前所在的整分钟（截图按分钟切换）；为 null 时回落到 span.start_at */
  focusMinute?: number | null
  /** 该时刻处于"离开"（afk）— 在标题栏显示红色徽章 */
  isAfk?: boolean
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

/** 把 DB 里偏暗的标签色提亮到最小亮度（深色面板上才看得清） */
function brightenForDark(hex: string, minLum = 185): string {
  if (!hex.startsWith('#') || hex.length < 7) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (lum >= minLum) return hex
  const t = (minLum - lum) / (255 - lum)
  const nr = Math.round(r + (255 - r) * t)
  const ng = Math.round(g + (255 - g) * t)
  const nb = Math.round(b + (255 - b) * t)
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`
}

export default function AppHoverPanel({ span, date, focusMinute, isAfk = false }: Props) {
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [imgError, setImgError] = useState(false)
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const [ignored, setIgnored] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // span 切换时重置忽视状态
  useEffect(() => { setIgnored(false); setConfirmOpen(false) }, [span.id])

  const titleArg: string | null = span.title && span.title !== span.group_name ? span.title : null

  const performIgnore = async () => {
    if (!span.group_name) return
    setConfirmOpen(false)
    try {
      await invoke('add_window_blacklist', { app: span.group_name, title: titleArg })
      setIgnored(true)
    } catch (e) {
      alert(`添加忽略失败: ${e}`)
    }
  }

  const color = brightenForDark(span.color ?? '#4488ff', 185)
  const mins = durationMin(span)
  const durStr = mins < 60
    ? `${mins}分钟`
    : `${Math.floor(mins / 60)}小时${mins % 60 ? `${mins % 60}分钟` : ''}`
  const displayName = span.group_name ?? span.title
  const hasWindowTitle = !!(span.group_name && span.title !== span.group_name)

  // 当前截图对应的时间点（focusMinute 优先；否则用 span 起始）
  const shotTimeStr = (() => {
    if (focusMinute != null) {
      const h = Math.floor(focusMinute / 60)
      const m = focusMinute % 60
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
    return fmt(span.start_at)
  })()

  // 加载应用图标
  useEffect(() => {
    if (!span.group_name) return
    let objUrl: string | null = null
    fetch(`http://localhost:49733/api/manictime/app-icon?name=${encodeURIComponent(span.group_name)}`)
      .then((r) => { if (!r.ok) throw new Error('no icon'); return r.blob() })
      .then((blob) => { objUrl = URL.createObjectURL(blob); setIconUrl(objUrl) })
      .catch(() => setIconUrl(null))
    return () => { if (objUrl) URL.revokeObjectURL(objUrl) }
  }, [span.group_name])

  useEffect(() => {
    setScreenshotUrl(null)
    setImgError(false)

    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    let timeStr: string
    if (focusMinute != null) {
      const h = Math.floor(focusMinute / 60)
      const m = focusMinute % 60
      timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:30`  // 落在该分钟中点，附近搜索更稳
    } else {
      timeStr = span.start_at.split(' ')[1] ?? '00:00:00'
    }
    const url = `http://localhost:49733/api/manictime/screenshot?date=${dateStr}&time=${encodeURIComponent(timeStr)}`

    let objectUrl: string | null = null
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error('no screenshot'); return r.blob() })
      .then((blob) => { objectUrl = URL.createObjectURL(blob); setScreenshotUrl(objectUrl) })
      .catch(() => setImgError(true))

    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [span.id, date, focusMinute])

  return (
    <div style={{
      padding: '12px 16px 14px',
      borderTop: `1px solid ${hexToRgba(color, 0.2)}`,
      fontFamily: theme.fontBody,
    }}>
      {/* Section Header */}
      <SectionHeader label="应用 · 详情" color={color} />

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

        {/* 离开 chip（当前光标处于 afk） */}
        {isAfk && (
          <span style={{
            flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 11, fontWeight: 700,
            fontFamily: theme.fontMono,
            letterSpacing: 0.8,
            color: '#ff4d4d',
            padding: '2px 8px',
            background: 'rgba(255,77,77,0.12)',
            border: '1px solid rgba(255,77,77,0.55)',
            clipPath: clip3, WebkitClipPath: clip3,
            textShadow: '0 0 5px rgba(255,77,77,0.7)',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#ff4d4d',
              boxShadow: '0 0 6px #ff4d4d',
            }} />
            离开
          </span>
        )}

        {/* 时长 chip */}
        <span style={{
          flexShrink: 0,
          fontSize: 11, fontWeight: 700,
          fontFamily: theme.fontMono,
          letterSpacing: 0.6,
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
        marginBottom: 4,
        padding: '0 2px',
      }}>
        <span style={{
          fontSize: 11, fontFamily: theme.fontBody, fontWeight: 600,
          color: theme.textSecondary, letterSpacing: 1,
        }}>
          时段
        </span>
        <span style={{
          fontSize: 12, fontFamily: theme.fontMono, fontWeight: 600,
          color: theme.textPrimary, letterSpacing: 0.3,
        }}>
          {fmt(span.start_at)}
          <span style={{ color: hexToRgba(color, 0.7), margin: '0 4px' }}>→</span>
          {fmt(span.end_at)}
        </span>
      </div>

      {/* 窗口标题 + 截图时间点（无窗口标题时仅显示时间） */}
      <div style={{
        marginBottom: 10,
        padding: '8px 10px',
        background: `linear-gradient(180deg, ${hexToRgba(color, 0.08)} 0%, rgba(0,12,28,0.55) 100%)`,
        border: `1px solid ${hexToRgba(color, 0.32)}`,
        clipPath: clip3, WebkitClipPath: clip3,
        display: 'flex', alignItems: 'flex-start', gap: 8,
        lineHeight: 1.45,
        wordBreak: 'break-all',
      }}>
        <span style={{
          fontSize: 10, fontFamily: theme.fontBody, fontWeight: 700,
          color: hexToRgba(color, 0.85), letterSpacing: 1.4,
          flexShrink: 0,
          paddingTop: 2,
          textShadow: `0 0 4px ${hexToRgba(color, 0.55)}`,
        }}>
          {hasWindowTitle ? '窗口' : '截图'}
        </span>
        <span style={{
          flex: 1,
          fontSize: 13,
          fontFamily: theme.fontBody,
          fontWeight: 600,
          color: theme.textPrimary,
          letterSpacing: 0.2,
        }}>
          {hasWindowTitle
            ? (span.title.length > 80 ? span.title.slice(0, 80) + '…' : span.title)
            : '当前帧'}
        </span>
        <span style={{
          flexShrink: 0,
          fontSize: 11, fontFamily: theme.fontMono, fontWeight: 700,
          letterSpacing: 0.6,
          color,
          padding: '1px 7px',
          background: hexToRgba(color, 0.12),
          border: `1px solid ${hexToRgba(color, 0.45)}`,
          clipPath: clip3, WebkitClipPath: clip3,
          textShadow: `0 0 4px ${hexToRgba(color, 0.6)}`,
        }}>
          {shotTimeStr}
        </span>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={ignored || !span.group_name}
          title={ignored ? '已加入忽略' : '以后忽视这个窗口（不记录、不截图）'}
          style={{
            flexShrink: 0,
            width: 22, height: 22,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: ignored ? hexToRgba(theme.expGreen, 0.16) : 'rgba(255,80,80,0.08)',
            border: `1px solid ${ignored ? hexToRgba(theme.expGreen, 0.55) : 'rgba(255,80,80,0.4)'}`,
            color: ignored ? theme.expGreen : '#ff8a8a',
            cursor: ignored || !span.group_name ? 'default' : 'pointer',
            clipPath: clip3, WebkitClipPath: clip3,
            opacity: !span.group_name ? 0.4 : 1,
          }}
        >
          {ignored ? <Check size={12} /> : <EyeOff size={12} />}
        </button>
      </div>

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
          ─ 暂无截图 ─
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="IGNORE WINDOW"
        titleColor="#ff8a8a"
        question={titleArg
          ? `确定要忽略窗口 "${titleArg}"？`
          : `确定要忽略整个应用 "${span.group_name}"？`}
        details={[
          <span key="d1">
            <strong style={{ color: theme.textPrimary }}>它在前台时不再被记录</strong>
            ：感知层把"前一个活动窗口"继续顶替写入，这段时间会算到上一段记录里。
          </span>,
          <span key="d2">
            <strong style={{ color: theme.textPrimary }}>不再为该窗口截图</strong>
            ：截图轮询碰到该窗口时直接跳过，磁盘上不会留下截图。
          </span>,
          <span key="d3">
            适合用来排除：临时弹出的状态栏、密码管理器、系统工具栏、隐私会话等高频但无价值的活动。
          </span>,
          <span key="d4" style={{ color: theme.textMuted }}>
            随时可以在「设置 → 忽略窗口」里移除。
          </span>,
        ]}
        confirmLabel="加入忽略"
        cancelLabel="取消"
        confirmColor="#ff8a8a"
        danger
        onConfirm={performIgnore}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}

function SectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      marginBottom: 10,
      fontSize: 12, fontFamily: theme.fontBody, fontWeight: 700,
      letterSpacing: 2,
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
