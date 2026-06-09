import { ReceiptText } from 'lucide-react'
import { theme, hud } from '../theme'
import type { ModelCallLog } from '../lib/local-api'
import Tooltip from './Tooltip'

interface Props {
  call: ModelCallLog | null
  compact?: boolean
  /** minimal=true 时只渲染纯 ¥xxx 文字（无图标/边框/背景），保留 hover 详情 */
  minimal?: boolean
}

function formatCny(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '¥0.00'
  if (n < 0.01 && n > 0) return `¥${n.toFixed(4)}`
  return `¥${n.toFixed(2)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 1 : 2)}K`
  return String(n)
}

function totalInput(call: ModelCallLog): number {
  return call.prompt_text_tokens + call.prompt_image_tokens + call.prompt_video_tokens + call.prompt_audio_tokens
}

function totalOutput(call: ModelCallLog): number {
  return call.completion_text_tokens + call.completion_audio_tokens
}

function parseMetadata(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {}
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function formatSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const sec = Math.round(value)
  const min = Math.floor(sec / 60)
  const rest = sec % 60
  return min > 0 ? `${min}m ${rest}s` : `${rest}s`
}

export default function ModelUsageBadge({ call, compact = false, minimal = false }: Props) {
  if (!call) return null
  const saved = call.free_quota_saved_cny ?? 0
  const cost = call.cost_cny ?? 0
  const gross = cost + saved
  const accent = saved > 0 ? theme.expGreen : cost > 0 ? theme.dangerRed : theme.expGreen
  const metadata = parseMetadata(call.metadata)
  const asrDuration = formatSeconds(metadata.usageSeconds)
  const content = (
    <div style={{ display: 'grid', gap: 6, minWidth: 210 }}>
      <div style={{ color: theme.electricBlue, fontFamily: theme.fontMono, fontWeight: 800 }}>{call.model_id}</div>
      <Line label="实际成本" value={formatCny(cost)} color={cost > 0 ? theme.dangerRed : theme.expGreen} />
      {saved > 0 && <Line label="免费额度节省" value={formatCny(saved)} color={theme.expGreen} />}
      {saved > 0 && <Line label="免费额度抵扣" value={formatTokens(call.free_quota_tokens)} color={theme.expGreen} />}
      <Line label="理论成本" value={formatCny(gross)} color={theme.textSecondary} />
      <Line label="输入" value={formatTokens(totalInput(call))} color={theme.textSecondary} />
      <Line label="输出" value={formatTokens(totalOutput(call))} color={theme.textSecondary} />
      {asrDuration && <Line label="ASR 音频时长" value={asrDuration} color={theme.textSecondary} />}
      <Line label="时间" value={new Date(call.started_at).toLocaleTimeString('zh-CN')} color={theme.textMuted} />
    </div>
  )

  if (minimal) {
    return (
      <Tooltip content={content}>
        <span style={{
          color: accent,
          fontFamily: theme.fontMono,
          fontSize: 11,
          fontWeight: 700,
          opacity: 0.85,
          marginLeft: 6,
          whiteSpace: 'nowrap',
          cursor: 'help',
        }}>
          {formatCny(cost)}
        </span>
      </Tooltip>
    )
  }

  return (
    <Tooltip content={content}>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: compact ? 24 : 28,
        padding: compact ? '0 8px' : '0 10px',
        border: `1px solid ${accent}66`,
        background: `${accent}12`,
        color: accent,
        clipPath: hud.chamfer8,
        WebkitClipPath: hud.chamfer8,
        fontFamily: theme.fontMono,
        fontSize: compact ? 10 : 11,
        fontWeight: 800,
        whiteSpace: 'nowrap',
      }}>
        <ReceiptText size={compact ? 11 : 12} />
        {formatCny(cost)}
        {asrDuration && <span style={{ color: theme.textSecondary }}>ASR {asrDuration}</span>}
        {saved > 0 && <span style={{ color: theme.expGreen }}>省 {formatCny(saved)}</span>}
      </span>
    </Tooltip>
  )
}

function Line({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11 }}>
      <span style={{ color: theme.textMuted }}>{label}</span>
      <span style={{ color, fontFamily: theme.fontMono, fontWeight: 700 }}>{value}</span>
    </div>
  )
}
