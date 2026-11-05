// ══════════════════════════════════════════════
// 功能绑定 Tab（对齐 desktop BindingsTab）
// ══════════════════════════════════════════════

import { StyleSheet, Text, View } from 'react-native'
import { fonts, theme } from '../../theme'
import { matchesFeatureSpec, type FeatureSpec, type ModelDef } from '../../lib/models/registry'
import type { ModelFreeQuota } from '../../lib/models/model-audit'
import { modelSelectOption } from '../../lib/models/model-display'
import SelectField from './SelectField'

export default function BindingsTab({ specs, models, freeQuotaByModel, bindingByFeature, onBind }: {
  specs: readonly FeatureSpec[]
  models: readonly ModelDef[]
  freeQuotaByModel: Map<string, ModelFreeQuota>
  bindingByFeature: Map<string, string>
  onBind: (feature: string, modelId: string) => void
}) {
  return (
    <View style={styles.root}>
      <View>
        <Text style={styles.title}>功能绑定</Text>
        <Text style={styles.muted}>每个功能选择一个默认模型；改动会随下一轮同步推回电脑</Text>
      </View>

      {specs.map((spec) => {
        const options = models
          .filter((m) => matchesFeatureSpec(m, spec))
          .map((m) => modelSelectOption(m, freeQuotaByModel.get(m.id)))
        const boundValue = bindingByFeature.get(spec.feature)
        const value = boundValue && options.some((o) => o.value === boundValue)
          ? boundValue
          : options[0]?.value ?? boundValue ?? ''
        return (
          <View key={spec.feature} style={styles.row}>
            <Text style={styles.label}>{spec.label}</Text>
            <Text style={styles.feature}>{spec.feature}</Text>
            <Text style={styles.hint}>{spec.hint}</Text>
            <View style={styles.select}>
              <SelectField
                value={value}
                title={spec.label}
                options={options.length > 0 ? options : [{ value: '', label: '暂无可选模型' }]}
                onChange={(v) => { if (v) onBind(spec.feature, v) }}
                disabled={options.length === 0}
              />
            </View>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink },
  muted: { fontSize: 12, color: theme.inkSoft, marginTop: 2 },
  row: { backgroundColor: theme.surface, borderRadius: 12, padding: 12 },
  label: { fontSize: 14, fontWeight: '700', color: theme.ink },
  feature: { fontSize: 10, color: theme.inkFaint, marginTop: 2, fontFamily: fonts.mono },
  hint: { fontSize: 12, lineHeight: 18, color: theme.inkSoft, marginTop: 4 },
  select: { marginTop: 8 },
})
