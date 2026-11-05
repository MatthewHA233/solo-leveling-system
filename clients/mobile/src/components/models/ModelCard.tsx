// ══════════════════════════════════════════════
// 模型库的一张卡（对齐 desktop ModelCard）
// 手机端模型库是只读镜像：没有修改 / 删除按钮，桌面端全量同步时整表覆盖
// ══════════════════════════════════════════════

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { alpha, fonts, theme } from '../../theme'
import { parseList, type ModelDef } from '../../lib/models/registry'
import type { ModelFreeQuota } from '../../lib/models/model-audit'
import { MODALITY_ZH, formatTokens, tierLabel, tone } from './model-utils'

function PriceTag({ label, value, currency }: { label: string; value: number | null; currency?: string }) {
  return (
    <Text style={styles.priceTag}>
      <Text style={styles.priceTagLabel}>{label} </Text>
      {currency === 'USD' ? '$' : '¥'}{value}
    </Text>
  )
}

export default function ModelCard({ model, quota, onOpenBailianDetail }: {
  model: ModelDef
  quota?: ModelFreeQuota
  onOpenBailianDetail: () => void
}) {
  const modalities = parseList(model.modalities)
  const displayName = model.display_name?.trim() || model.id
  // 走网关 / 官方直连的模型：没有百炼详情页，标一下渠道
  const isVercel = model.provider === 'vercel' || model.provider === 'anthropic'

  return (
    <View style={styles.card}>
      {isVercel ? (
        <View style={styles.nameRow}>
          <Text style={styles.name}>{displayName}</Text>
          <Text style={styles.chip}>{model.provider === 'anthropic' ? 'Anthropic' : 'Vercel'}</Text>
        </View>
      ) : (
        <Pressable accessibilityRole="link" hitSlop={4} onPress={onOpenBailianDetail}>
          <Text style={styles.name}>{displayName}</Text>
        </Pressable>
      )}
      <Text style={styles.id} selectable>{model.id}</Text>

      {modalities.length > 0 && (
        <View style={styles.chips}>
          {modalities.map((m) => <Text key={m} style={styles.chip}>{MODALITY_ZH[m] ?? m}</Text>)}
        </View>
      )}

      <Text style={styles.ctx}>
        <Text style={styles.label}>上下文：</Text>
        {model.context_window ? formatTokens(model.context_window) : '-'}
      </Text>

      {quota && (
        <View style={styles.quota}>
          <View style={styles.quotaHead}>
            <Text style={styles.label}>免费额度</Text>
            <Text style={[
              styles.quotaValue,
              { color: quota.error_message ? tone.danger : quota.remaining_tokens > 0 ? tone.green : theme.inkSoft },
            ]}>
              {quota.error_message
                ? '查询失败'
                : quota.total_tokens > 0
                  ? `${formatTokens(quota.remaining_tokens)} / ${formatTokens(quota.total_tokens)}`
                  : quota.not_supported ? '不支持' : '0 / 0'}
            </Text>
          </View>
          {quota.total_tokens > 0 && (
            <View style={styles.meter}>
              <View style={{
                width: `${Math.max(0, Math.min(100, (quota.remaining_tokens / quota.total_tokens) * 100))}%`,
                height: '100%',
                backgroundColor: quota.remaining_tokens > 0 ? tone.green : tone.danger,
              }} />
            </View>
          )}
          <Text style={styles.quotaMeta}>
            {quota.expire_date ? `到期 ${quota.expire_date}` : new Date(quota.scanned_at).toLocaleString('zh-CN')}
          </Text>
        </View>
      )}

      <View style={styles.tiers}>
        {model.pricing.map((tier, idx) => {
          const inputs = [
            { label: '文本', value: tier.price_input_text },
            { label: '图片', value: tier.price_input_image },
            { label: '视频', value: tier.price_input_video },
            { label: '音频', value: tier.price_input_audio },
          ].filter((p) => p.value != null)
          const outputs = [
            { label: '文本', value: tier.price_output_text },
            { label: '音频', value: tier.price_output_audio },
          ].filter((p) => p.value != null)
          return (
            <View key={idx} style={styles.tier}>
              <Text style={styles.tierLabel}>{tierLabel(tier)} tokens</Text>
              {inputs.length > 0 && (
                <View style={styles.priceRow}>
                  <Text style={styles.priceGroup}>输入</Text>
                  <View style={styles.priceList}>
                    {inputs.map((p) => <PriceTag key={p.label} label={p.label} value={p.value} currency={model.currency} />)}
                  </View>
                </View>
              )}
              {outputs.length > 0 && (
                <View style={styles.priceRow}>
                  <Text style={styles.priceGroup}>输出</Text>
                  <View style={styles.priceList}>
                    {outputs.map((p) => <PriceTag key={p.label} label={p.label} value={p.value} currency={model.currency} />)}
                  </View>
                </View>
              )}
            </View>
          )
        })}
      </View>
      <Text style={styles.unit}>
        {model.currency === 'USD' ? '单位：美元 / 百万 token' : `单位：元 / 百万 token${isVercel ? '（美元价按 1:7.1 折算）' : ''}`}
      </Text>

      {/* 决策模型的实测成绩 / 数据留存说明（种子里写在 notes，用「｜」分段） */}
      {isVercel && model.notes && (
        <View style={styles.notes}>
          {model.notes.split('｜').map((line) => <Text key={line} style={styles.note}>{line}</Text>)}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.surface, borderRadius: 12, padding: 14, marginBottom: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  name: { fontSize: 14, fontWeight: '700', color: theme.ink },
  id: { fontSize: 11, color: theme.inkSoft, marginTop: 3, fontFamily: fonts.mono },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 10 },
  chip: {
    fontSize: 11, fontWeight: '500', color: theme.accent,
    backgroundColor: alpha(theme.accent, 0.08), borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden',
  },
  ctx: { fontSize: 12, color: theme.ink, marginTop: 10, fontVariant: ['tabular-nums'] },
  label: { fontSize: 12, color: theme.inkSoft },

  quota: { gap: 4, marginTop: 10 },
  quotaHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  quotaValue: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  meter: { height: 5, borderRadius: 3, backgroundColor: theme.sunk, overflow: 'hidden' },
  quotaMeta: { fontSize: 10, color: theme.inkSoft, fontVariant: ['tabular-nums'] },

  tiers: { gap: 6, marginTop: 10 },
  tier: { backgroundColor: theme.bg, borderRadius: 8, padding: 10 },
  tierLabel: { fontSize: 11, fontWeight: '600', color: theme.inkSoft, marginBottom: 6, fontVariant: ['tabular-nums'] },
  priceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 2 },
  priceGroup: { fontSize: 11, color: theme.inkSoft, lineHeight: 18 },
  priceList: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 2 },
  priceTag: { fontSize: 12, lineHeight: 18, fontWeight: '600', color: theme.ink, fontVariant: ['tabular-nums'] },
  priceTagLabel: { fontSize: 11, fontWeight: '400', color: theme.inkSoft },

  unit: { fontSize: 10, color: theme.inkSoft, marginTop: 8 },
  notes: { gap: 3, marginTop: 8 },
  note: { fontSize: 12, lineHeight: 18, color: theme.inkSoft },
})
