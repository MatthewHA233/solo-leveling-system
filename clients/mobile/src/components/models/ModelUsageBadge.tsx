// ══════════════════════════════════════════════
// 单次调用的费用徽章（对齐 desktop ModelUsageBadge）
// 桌面端 hover Tooltip 看详情，手机没有 hover，改成点一下弹详情
// ══════════════════════════════════════════════

import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { alpha, fonts, theme } from '../../theme'
import type { ModelCallLog } from '../../lib/models/model-audit'
import { formatCny, formatUsd, tone } from './model-utils'

interface Props {
  call: ModelCallLog | null
  compact?: boolean
  /** minimal=true 时只渲染纯 ¥xxx 文字（无边框/背景），保留点击详情 */
  minimal?: boolean
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
  const [open, setOpen] = useState(false)
  if (!call) return null
  const saved = call.free_quota_saved_cny ?? 0
  const isUsd = call.cost_usd != null
  const money = isUsd ? formatUsd : formatCny
  const cost = (isUsd ? call.cost_usd : call.cost_cny) ?? 0
  const gross = cost + saved
  const accent = saved > 0 ? tone.green : cost > 0 ? tone.danger : tone.green
  const metadata = parseMetadata(call.metadata)
  const asrDuration = formatSeconds(metadata.usageSeconds)

  const details = (
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
        <Pressable style={styles.pop} onPress={() => {}}>
          <Text style={styles.popTitle} numberOfLines={2}>{call.model_id}</Text>
          <Line label="实际成本" value={money(cost)} color={cost > 0 ? tone.danger : tone.green} />
          {saved > 0 && <Line label="免费额度节省" value={money(saved)} color={tone.green} />}
          {saved > 0 && <Line label="免费额度抵扣" value={formatTokens(call.free_quota_tokens)} color={tone.green} />}
          <Line label="理论成本" value={money(gross)} color={theme.inkSoft} />
          <Line label="输入" value={formatTokens(totalInput(call))} color={theme.inkSoft} />
          <Line label="输出" value={formatTokens(totalOutput(call))} color={theme.inkSoft} />
          {asrDuration && <Line label="ASR 音频时长" value={asrDuration} color={theme.inkSoft} />}
          <Line label="时间" value={new Date(call.started_at).toLocaleTimeString('zh-CN')} color={theme.inkFaint} />
        </Pressable>
      </Pressable>
    </Modal>
  )

  if (minimal) {
    return (
      <>
        <Pressable hitSlop={8} onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`本次费用 ${money(cost)}`}>
          <Text style={[styles.minimal, { color: accent }]}>{money(cost)}</Text>
        </Pressable>
        {details}
      </>
    )
  }

  return (
    <>
      <Pressable
        hitSlop={6}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`本次费用 ${money(cost)}`}
        style={[
          styles.badge,
          compact ? styles.badgeCompact : styles.badgeNormal,
          { borderColor: alpha(accent, 0.4), backgroundColor: alpha(accent, 0.07) },
        ]}
      >
        <Text style={[styles.badgeText, compact && styles.badgeTextCompact, { color: accent }]}>{money(cost)}</Text>
        {asrDuration && <Text style={[styles.badgeText, compact && styles.badgeTextCompact, styles.soft]}>ASR {asrDuration}</Text>}
        {saved > 0 && <Text style={[styles.badgeText, compact && styles.badgeTextCompact, { color: tone.green }]}>省 {money(saved)}</Text>}
      </Pressable>
      {details}
    </>
  )
}

function Line({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={[styles.lineValue, { color }]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  minimal: { fontSize: 11, fontWeight: '600', opacity: 0.85, marginLeft: 6, fontVariant: ['tabular-nums'] },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, alignSelf: 'flex-start' },
  badgeCompact: { height: 24, paddingHorizontal: 8 },
  badgeNormal: { height: 28, paddingHorizontal: 10 },
  badgeText: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  badgeTextCompact: { fontSize: 10 },
  soft: { color: theme.inkSoft },

  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  pop: { width: '100%', maxWidth: 320, backgroundColor: theme.surface, borderRadius: 14, padding: 14, gap: 6 },
  popTitle: { fontSize: 13, fontWeight: '700', color: theme.ink, fontFamily: fonts.mono, marginBottom: 2 },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  lineLabel: { fontSize: 12, color: theme.inkSoft },
  lineValue: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
})
