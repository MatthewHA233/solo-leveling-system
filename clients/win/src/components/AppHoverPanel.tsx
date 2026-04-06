/**
 * AppHoverPanel — 程序轨道悬浮/固定时，右侧栏展示的面板
 * 显示：程序名、时间段、ManicTime 截图
 */

import { useState, useEffect } from 'react'
import type { MtSpan } from '../lib/local-api'
import { theme } from '../theme'

interface Props {
  span: MtSpan
  date: Date
}

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
      padding: '12px 16px',
      borderTop: `1px solid ${hexToRgba(color, 0.25)}`,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      {/* 标题行 */}
      <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 8, letterSpacing: 1 }}>
        程序详情
      </div>

      {/* 程序名 + 时长 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {iconUrl ? (
          <img src={iconUrl} alt="" style={{ width: 20, height: 20, flexShrink: 0, imageRendering: 'pixelated' }} />
        ) : (
          <div style={{
            width: 20, height: 20, borderRadius: 3, flexShrink: 0,
            background: color, boxShadow: `0 0 6px ${hexToRgba(color, 0.7)}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: '#000',
          }}>
            {(span.group_name ?? span.title).charAt(0).toUpperCase()}
          </div>
        )}
        <span style={{
          fontSize: 12, fontWeight: 700, color: '#fff',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {span.group_name ?? span.title}
        </span>
        <span style={{ fontSize: 10, color: hexToRgba(color, 0.9), flexShrink: 0 }}>
          {durStr}
        </span>
      </div>

      {/* 时间段 + 窗口标题 */}
      <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: screenshotUrl ? 10 : 0 }}>
        {fmt(span.start_at)} → {fmt(span.end_at)}
        {span.group_name && span.title !== span.group_name && (
          <div style={{ marginTop: 3, color: theme.textSecondary, opacity: 0.7, wordBreak: 'break-all' }}>
            {span.title.length > 60 ? span.title.slice(0, 60) + '…' : span.title}
          </div>
        )}
      </div>

      {/* 截图 */}
      {screenshotUrl && (
        <img
          src={screenshotUrl}
          alt="screenshot"
          onError={() => setImgError(true)}
          style={{
            width: '100%', borderRadius: 4, display: 'block',
            border: `1px solid ${hexToRgba(color, 0.25)}`,
          }}
        />
      )}
      {imgError && (
        <div style={{ fontSize: 10, color: theme.textMuted, textAlign: 'center', paddingTop: 4 }}>
          暂无截图
        </div>
      )}
    </div>
  )
}
