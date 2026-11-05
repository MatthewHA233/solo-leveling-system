// ══════════════════════════════════════════════
// 调用明细的一行（对齐 desktop CallRow）
// ══════════════════════════════════════════════

import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { alpha, fonts, theme } from '../../theme'
import { FEATURE_LABEL, type ModelPricingTier } from '../../lib/models/registry'
import type { ModelCallLog } from '../../lib/models/model-audit'
import { breakdownCallCost, formatCny, formatTokens, formatUsd, tone } from './model-utils'
import { MiniMetric, StatusBadge } from './parts'

export default memo(function CallRow({ call, apiKeyLabel, pricing }: {
  call: ModelCallLog
  apiKeyLabel?: string | null
  pricing?: ModelPricingTier[]
}) {
  const prompt = call.prompt_text_tokens + call.prompt_image_tokens + call.prompt_video_tokens + call.prompt_audio_tokens
  const completion = call.completion_text_tokens + call.completion_audio_tokens
  const bd = breakdownCallCost(call, pricing)
  const inputParts = bd.inputs.map((p) => ({ label: p.label, value: p.tokens, cost: p.cost }))
  const outputParts = bd.outputs.map((p) => ({ label: p.label, value: p.tokens, cost: p.cost }))
  const saved = call.free_quota_saved_cny ?? 0
  const freeTokens = call.free_quota_tokens ?? 0
  const isUsd = call.cost_usd != null
  const money = isUsd ? formatUsd : formatCny
  const cost = (isUsd ? call.cost_usd : call.cost_cny) ?? 0
  const featureLabel = FEATURE_LABEL.get(call.feature) ?? call.feature

  return (
    <View style={styles.card}>
      {/* 标题行：功能名 + 状态徽章 + 成本 */}
      <View style={styles.headRow}>
        <Text style={styles.feature} numberOfLines={1}>{featureLabel}</Text>
        {!call.success && <StatusBadge color={tone.danger} label="ERR" />}
        {saved > 0 && <StatusBadge color={tone.green} label="免费" />}
        <View style={styles.spacer} />
        <Text style={[styles.cost, { color: cost > 0 ? tone.danger : tone.green }]}>
          {money(isUsd ? call.cost_usd : call.cost_cny)}
        </Text>
      </View>

      {/* 模型 ID + 时间戳 */}
      <View style={styles.metaRow}>
        <Text style={styles.modelId} numberOfLines={1}>{call.model_id}</Text>
        <Text style={styles.time}>{new Date(call.started_at).toLocaleString('zh-CN')}</Text>
      </View>

      {/* API Key */}
      <Text style={styles.keyLine}>Key {apiKeyLabel ?? (call.api_key_id ? call.api_key_id.slice(0, 8) : '未归属')}</Text>

      {/* 免费额度抵扣 */}
      {saved > 0 && (
        <Text style={styles.freeLine}>免费额度抵扣 {formatTokens(freeTokens)} · 节省 {formatCny(saved)}</Text>
      )}

      {/* 输入/输出明细 */}
      <View style={styles.miniRow}>
        <MiniMetric label="输入" value={formatTokens(prompt)} sub={inputParts} money={money} accent={tone.accent} />
        <MiniMetric label="输出" value={formatTokens(completion)} sub={outputParts} money={money} accent={tone.orange} />
      </View>

      {/* 错误提示条 */}
      {call.error_message && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText} selectable>{call.error_message}</Text>
        </View>
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  card: { backgroundColor: theme.surface, borderRadius: 12, padding: 12, marginBottom: 8 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  feature: { flexShrink: 1, fontSize: 13, fontWeight: '700', color: theme.ink },
  spacer: { flex: 1 },
  cost: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginTop: 6 },
  modelId: { flexShrink: 1, fontSize: 11, fontWeight: '600', color: theme.ink, fontFamily: fonts.mono },
  time: { flexShrink: 0, fontSize: 10, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  keyLine: { fontSize: 10, color: theme.inkSoft, marginTop: 3, fontFamily: fonts.mono },
  freeLine: { fontSize: 11, color: tone.green, marginTop: 4 },
  miniRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  errorBox: { marginTop: 8, padding: 8, borderRadius: 8, backgroundColor: alpha(tone.danger, 0.07) },
  errorText: { fontSize: 11, lineHeight: 16, color: tone.danger, fontFamily: fonts.mono },
})
