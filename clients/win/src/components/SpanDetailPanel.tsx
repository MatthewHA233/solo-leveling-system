// ══════════════════════════════════════════════
// SpanDetailPanel — ManicTime 标签段详情面板（HUD 风格）
// ══════════════════════════════════════════════

import type { MtSpan } from '../lib/local-api'
import { theme } from '../theme'

interface Props {
  span: MtSpan
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
  return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`
}

function hexToRgba(hex: string, alpha: number) {
  if (!hex.startsWith('#') || hex.length < 7) return `rgba(128,128,128,${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** 把 DB 里偏暗的标签色提亮到最小亮度 minLum（深色面板上才看得清） */
function brightenForDark(hex: string, minLum = 175): string {
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

function parseTagTitle(title: string): { parts: string[]; markers: string[] } {
  const all = title.split(',').map((s) => s.trim()).filter(Boolean)
  return {
    parts:   all.filter((s) => !s.startsWith(':')),
    markers: all.filter((s) => s.startsWith(':')).map((s) => s.slice(1)),
  }
}

const MARKER_LABELS: Record<string, string> = {
  billable: '可计费',
}

export default function SpanDetailPanel({ span }: Props) {
  const { parts: tagParts, markers } = parseTagTitle(span.title)
  // DB 中的标签色经常偏暗（如深红/深蓝），在深色面板上不可读 → 统一提亮
  const color = brightenForDark(span.color ?? '#4488ff', 185)
  const leafIdx = tagParts.length - 1

  return (
    <div style={{
      padding: '12px 16px 14px',
      borderBottom: `1px solid ${hexToRgba(color, 0.18)}`,
      fontFamily: theme.fontBody,
    }}>
      {/* Section Header */}
      <SectionHeader label="标签 · 详情" color={color} />

      {/* 标签路径 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>
        {tagParts.map((part, i) => {
          const isRoot = i === 0
          const isLeaf = i === leafIdx && leafIdx > 0

          if (isLeaf) {
            return (
              <div key={i} style={{
                marginTop: 3,
                marginLeft: i * 10,
                padding: '5px 10px 5px 12px',
                background: `linear-gradient(90deg, ${hexToRgba(color, 0.22)} 0%, ${hexToRgba(color, 0.04)} 100%)`,
                border: `1px solid ${hexToRgba(color, 0.55)}`,
                clipPath: clip3, WebkitClipPath: clip3,
                boxShadow: `0 0 10px ${hexToRgba(color, 0.3)}, inset 0 0 8px ${hexToRgba(color, 0.1)}`,
                display: 'flex', alignItems: 'center', gap: 7,
                position: 'relative',
              }}>
                <span style={{
                  fontSize: 11, fontFamily: theme.fontBody, fontWeight: 700,
                  letterSpacing: 1.5,
                  color: hexToRgba(color, 0.85),
                }}>
                  ▸ 当前
                </span>
                <span style={{
                  flex: 1,
                  fontSize: 13, fontWeight: 700,
                  fontFamily: theme.fontBody,
                  color: '#fff',
                  textShadow: `0 0 6px ${hexToRgba(color, 0.9)}, 0 0 12px ${hexToRgba(color, 0.5)}`,
                  letterSpacing: 0.4,
                  wordBreak: 'break-all',
                }}>
                  {part}
                </span>
              </div>
            )
          }

          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              paddingLeft: i * 10,
            }}>
              {!isRoot && (
                <span style={{
                  fontSize: 8, color: hexToRgba(color, 0.5),
                  fontFamily: theme.fontMono,
                }}>
                  └
                </span>
              )}
              <span style={{
                fontSize: isRoot ? 12.5 : 11,
                fontWeight: isRoot ? 700 : 500,
                fontFamily: isRoot ? theme.fontBody : theme.fontMono,
                color: isRoot ? color : theme.textSecondary,
                textShadow: isRoot ? `0 0 5px ${hexToRgba(color, 0.5)}` : undefined,
                letterSpacing: isRoot ? 0.5 : 0.3,
              }}>
                {part}
              </span>
            </div>
          )
        })}
      </div>

      {/* 属性标记 */}
      {markers.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {markers.map((m) => {
            const mc = 'rgba(255,220,100,0.95)'
            return (
              <span key={m} style={{
                fontSize: 9, fontWeight: 700,
                fontFamily: theme.fontMono,
                padding: '3px 9px',
                clipPath: clip3, WebkitClipPath: clip3,
                background: 'rgba(255,220,100,0.08)',
                border: '1px solid rgba(255,220,100,0.45)',
                color: mc,
                letterSpacing: 1.2,
                textShadow: `0 0 4px rgba(255,220,100,0.5)`,
                boxShadow: 'inset 0 0 6px rgba(255,220,100,0.08)',
              }}>
                {MARKER_LABELS[m] ?? m}
              </span>
            )
          })}
        </div>
      )}

      {/* 时间轴：起点 ── 时长 ── 终点 */}
      <div style={{
        padding: '10px 14px',
        background: 'rgba(0,12,28,0.4)',
        border: `1px solid ${theme.hudFrameSoft}`,
        clipPath: clip4, WebkitClipPath: clip4,
      }}>
        <Timeline
          start={fmtTime(span.start_at)}
          end={fmtTime(span.end_at)}
          duration={fmtDuration(span.start_at, span.end_at)}
          color={color}
        />
      </div>
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

/**
 * 时间轴行：
 *   ◉ 23:52 ──────  6分钟  ────── 23:58 ◉
 * 时长居中浮在线段上；两端时间用色点标记
 */
function Timeline({
  start, end, duration, color,
}: {
  start: string
  end: string
  duration: string
  color: string
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: theme.fontMono,
    }}>
      <Endpoint time={start} color={color} />
      <Track duration={duration} color={color} />
      <Endpoint time={end} color={color} />
    </div>
  )
}

function Endpoint({ time, color }: { time: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: color,
        boxShadow: `0 0 6px ${hexToRgba(color, 0.8)}`,
      }} />
      <span style={{
        fontSize: 13, fontWeight: 700,
        color: theme.textPrimary, letterSpacing: 0.5,
      }}>
        {time}
      </span>
    </div>
  )
}

function Track({ duration, color }: { duration: string; color: string }) {
  return (
    <div style={{
      flex: 1, position: 'relative', height: 22,
      display: 'flex', alignItems: 'center',
    }}>
      {/* 渐变线段 */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: '50%',
        height: 2, transform: 'translateY(-50%)',
        background: `linear-gradient(90deg, ${hexToRgba(color, 0.7)} 0%, ${hexToRgba(color, 0.45)} 50%, ${hexToRgba(color, 0.7)} 100%)`,
        boxShadow: `0 0 5px ${hexToRgba(color, 0.45)}`,
      }} />
      {/* 时长标签（浮在线段中央） */}
      <span style={{
        position: 'relative', margin: '0 auto',
        padding: '2px 9px',
        fontSize: 12, fontWeight: 700,
        color,
        background: 'rgba(0,12,28,0.95)',
        border: `1px solid ${hexToRgba(color, 0.55)}`,
        borderRadius: 3,
        letterSpacing: 0.5,
        textShadow: `0 0 4px ${hexToRgba(color, 0.5)}`,
        whiteSpace: 'nowrap',
      }}>
        {duration}
      </span>
    </div>
  )
}

