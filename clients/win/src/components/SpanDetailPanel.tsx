// ══════════════════════════════════════════════
// SpanDetailPanel — ManicTime 标签段详情面板
// ══════════════════════════════════════════════

import type { MtSpan } from '../lib/local-api'
import { theme } from '../theme'

interface Props {
  span: MtSpan
}

function fmtTime(dt: string): string {
  return dt.split(' ')[1]?.slice(0, 5) ?? dt
}

function fmtDuration(start: string, end: string): string {
  const toMin = (s: string) => {
    const t = s.split(' ')[1] ?? ''
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }
  const diff = toMin(end) - toMin(start)
  if (diff <= 0) return '—'
  const h = Math.floor(diff / 60)
  const m = diff % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function hexToRgba(hex: string, alpha: number) {
  if (!hex.startsWith('#') || hex.length < 7) return `rgba(128,128,128,${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export default function SpanDetailPanel({ span }: Props) {
  const tagParts = span.title.split(',').map((s) => s.trim()).filter(Boolean)
  const color = span.color ?? '#4488ff'

  return (
    <div style={{
      padding: '14px 16px',
      borderBottom: `1px solid ${hexToRgba(color, 0.2)}`,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      {/* 标题行 */}
      <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 10, letterSpacing: 1 }}>
        标签详情
      </div>

      {/* 色条 + 路径 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
        <div style={{
          width: 3, borderRadius: 2, flexShrink: 0, alignSelf: 'stretch',
          background: color,
          boxShadow: `0 0 6px ${hexToRgba(color, 0.6)}`,
        }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {tagParts.map((part, i) => (
            <span key={i} style={{
              fontSize: i === 0 ? 13 : 11,
              fontWeight: i === 0 ? 700 : 400,
              color: i === 0 ? color : theme.textSecondary,
              paddingLeft: i * 8,
            }}>
              {i > 0 && '› '}{part}
            </span>
          ))}
        </div>
      </div>

      {/* 时间 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Row label="时段" value={`${fmtTime(span.start_at)} → ${fmtTime(span.end_at)}`} />
        <Row label="时长" value={fmtDuration(span.start_at, span.end_at)} color={color} />
        {span.group_name && <Row label="分类" value={span.group_name} />}
      </div>
    </div>
  )
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: theme.textMuted }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color: color ?? theme.textPrimary }}>{value}</span>
    </div>
  )
}
