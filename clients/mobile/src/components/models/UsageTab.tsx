// ══════════════════════════════════════════════
// 用量 Tab（对齐 desktop UsageTab）：桌面端左右两栏，手机改成上下一栏滚动
// ══════════════════════════════════════════════

import { StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import { FEATURE_SPECS, type ModelDef, type ModelPricingTier } from '../../lib/models/registry'
import type { ModelCallLog, ModelFreeQuota } from '../../lib/models/model-audit'
import { modelSelectOption } from '../../lib/models/model-display'
import { formatCny, formatUsd, tone, type UsageTotals, type ViewMode } from './model-utils'
import { Empty, Metric, MetricBreakdown, Segmented } from './parts'
import CallRow from './CallRow'
import SelectField from './SelectField'
import StackedBarChart from './StackedBarChart'
import UsageCalendar from './UsageCalendar'

export default function UsageTab({
  calls,
  loading,
  totals,
  viewMode,
  anchorDate,
  feature,
  modelId,
  models,
  freeQuotaByModel,
  modelPricingMap,
  activeKeyLabel,
  onViewMode,
  onAnchorDate,
  onFeature,
  onModel,
}: {
  calls: readonly ModelCallLog[]
  loading: boolean
  totals: UsageTotals
  viewMode: ViewMode
  anchorDate: Date
  feature: string
  modelId: string
  models: readonly ModelDef[]
  freeQuotaByModel: Map<string, ModelFreeQuota>
  modelPricingMap: Map<string, ModelPricingTier[]>
  activeKeyLabel: string | null
  onViewMode: (v: ViewMode) => void
  onAnchorDate: (d: Date) => void
  onFeature: (v: string) => void
  onModel: (v: string) => void
}) {
  const modelChoices = [
    { value: 'all', label: '全部模型', hint: '不过滤' },
    ...models.map((m) => modelSelectOption(m, freeQuotaByModel.get(m.id))),
  ]

  return (
    <View style={styles.root}>
      <View style={styles.headRow}>
        <View style={styles.headText}>
          <Text style={styles.sectionTitle}>调用用量</Text>
          {activeKeyLabel
            ? <Text style={styles.muted}>当前 Key：<Text style={styles.mutedStrong}>{activeKeyLabel}</Text></Text>
            : <Text style={styles.muted}>未选择 API Key</Text>}
        </View>
        {loading && <Text style={styles.loading}>刷新中</Text>}
      </View>

      <View style={styles.controls}>
        <UsageCalendar viewMode={viewMode} anchorDate={anchorDate} onSelect={onAnchorDate} />
        <Segmented
          value={viewMode}
          options={[
            { value: 'day', label: '按天' },
            { value: 'week', label: '按周' },
            { value: 'month', label: '按月' },
          ]}
          onChange={(v) => onViewMode(v as ViewMode)}
        />
      </View>

      <View style={styles.metricRow}>
        <Metric label="调用" value={String(totals.calls)} />
        <Metric
          label="成本"
          value={formatCny(totals.cost)}
          secondary={totals.costUsd > 0 ? formatUsd(totals.costUsd) : undefined}
          accent={tone.danger}
          note={totals.saved > 0 ? `免费额度节省 ${formatCny(totals.saved)}` : undefined}
        />
      </View>
      <View style={styles.metricRow}>
        <MetricBreakdown
          label="输入"
          total={totals.promptText + totals.promptImage + totals.promptVideo + totals.promptAudio}
          accent={tone.accent}
          parts={[
            { label: '文本', value: totals.promptText, cost: totals.costPromptText },
            { label: '图像', value: totals.promptImage, cost: totals.costPromptImage },
            { label: '视频', value: totals.promptVideo, cost: totals.costPromptVideo },
            { label: '音频', value: totals.promptAudio, cost: totals.costPromptAudio },
          ]}
        />
        <MetricBreakdown
          label="输出"
          total={totals.completionText + totals.completionAudio}
          accent={tone.orange}
          parts={[
            { label: '文本', value: totals.completionText, cost: totals.costCompletionText },
            { label: '音频', value: totals.completionAudio, cost: totals.costCompletionAudio },
          ]}
        />
      </View>

      <View style={styles.panel}>
        <StackedBarChart calls={calls} viewMode={viewMode} anchorDate={anchorDate} />
      </View>

      <View style={styles.headRow}>
        <View style={styles.headText}>
          <Text style={styles.sectionTitle}>调用明细</Text>
          <Text style={styles.muted}>共 {calls.length} 条</Text>
        </View>
      </View>

      <View style={styles.filterRow}>
        <View style={styles.filterCell}>
          <SelectField
            value={feature}
            title="按功能筛选"
            options={[
              { value: 'all', label: '全部功能' },
              ...FEATURE_SPECS.map((f) => ({ value: f.feature, label: f.label, hint: f.hint })),
            ]}
            onChange={onFeature}
          />
        </View>
        <View style={styles.filterCell}>
          <SelectField value={modelId} title="按模型筛选" options={modelChoices} onChange={onModel} />
        </View>
      </View>

      {calls.length === 0 ? (
        <Empty text={models.length === 0 ? '模型库还没有初始化' : '暂无调用记录'} />
      ) : (
        <>
          {calls.length > 100 && (
            <Text style={styles.limitHint}>显示最近 100 条（共 {calls.length} 条）</Text>
          )}
          {calls.slice(0, 100).map((call) => (
            <CallRow key={call.id} call={call} apiKeyLabel={null} pricing={modelPricingMap.get(call.model_id)} />
          ))}
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headText: { flex: 1, minWidth: 0 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: theme.ink },
  muted: { fontSize: 12, color: theme.inkSoft, marginTop: 2 },
  mutedStrong: { color: theme.ink, fontWeight: '600' },
  loading: { fontSize: 12, color: theme.accent },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  metricRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  panel: { backgroundColor: theme.surface, borderRadius: 12, padding: 12 },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterCell: { flex: 1, minWidth: 0 },
  limitHint: { fontSize: 11, color: theme.inkSoft, textAlign: 'center', paddingVertical: 4 },
})
