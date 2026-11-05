// ══════════════════════════════════════════════
// QuickModelSheet — 聊天顶栏的模型快速切换（对齐 desktop ChatPanel 顶栏下拉）
// 按当前聊天模式的 feature（fairy_chat / fairy_omni_chat）过滤可选模型
// ══════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme, alpha } from '../theme'
import {
  FEATURE_SPECS,
  ensureModelCatalog,
  listCachedModels,
  modelsForFeature,
  refreshModelCatalog,
  type ModelDef,
} from '../lib/models/registry'
import {
  emitFeatureBindingUpdated,
  listModelFreeQuotas,
  setFeatureModel,
  type ModelFreeQuota,
} from '../lib/models/model-audit'
import { modelSelectOption } from '../lib/models/model-display'

interface Props {
  readonly visible: boolean
  readonly feature: 'fairy_chat' | 'fairy_omni_chat'
  readonly currentModel: string | null
  readonly onClose: () => void
  readonly onPicked: (modelId: string) => void
  readonly onOpenCenter: () => void
}

/** 免费额度颜色（对应 desktop HudSelectRow 的 meter：>35 绿，>10 橙，否则红） */
export function quotaRingColor(pct: number): string {
  return pct > 35 ? '#3FA86A' : pct > 10 ? '#D98A3D' : theme.danger
}

function priceLine(def: ModelDef): string {
  const t = def.pricing[0]
  if (!t) return ''
  const sign = def.currency === 'USD' ? '$' : '¥'
  const parts: string[] = []
  if (t.price_input_text != null) parts.push(`${sign}${t.price_input_text}/M入`)
  if (t.price_output_text != null) parts.push(`${sign}${t.price_output_text}/M出`)
  if (t.price_output_audio != null) parts.push(`${sign}${t.price_output_audio}/M音`)
  return parts.join(' · ')
}

export default function QuickModelSheet({ visible, feature, currentModel, onClose, onPicked, onOpenCenter }: Props) {
  const [quotas, setQuotas] = useState<Map<string, ModelFreeQuota>>(new Map())
  const [catalog, setCatalog] = useState<readonly ModelDef[]>(() => listCachedModels())
  const spec = FEATURE_SPECS.find((s) => s.feature === feature)!
  // 对应 desktop FairyWindow modelOptions：按能力过滤为空（模型表缺字段等）时回退全部，别让选择器变空
  const models = useMemo(() => {
    const filtered = modelsForFeature(spec, catalog)
    return filtered.length > 0 ? filtered : catalog
  }, [spec, catalog])

  useEffect(() => {
    if (!visible) return
    void ensureModelCatalog().then(() => refreshModelCatalog()).then(setCatalog)
    listModelFreeQuotas()
      .then((rows) => setQuotas(new Map(rows.map((r) => [r.model_id, r]))))
      .catch(() => {})
  }, [visible])

  const pick = (id: string) => {
    void setFeatureModel(feature, id)
      .then(() => emitFeatureBindingUpdated(feature, id))
      .catch(() => {})
    onPicked(id)
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>{spec.label} · 选择模型</Text>
          <ScrollView style={styles.list}>
            {models.map((m) => {
              const active = m.id === currentModel
              const option = modelSelectOption(m, quotas.get(m.id))
              return (
                <Pressable key={m.id} style={[styles.row, active && styles.rowOn]} onPress={() => pick(m.id)}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, active && { color: theme.accent }]}>
                      {option.label}
                    </Text>
                    <Text style={styles.meta}>{priceLine(m)}</Text>
                    {option.hint && <Text style={styles.quotaHint}>{option.hint}</Text>}
                    {option.meter != null && (
                      <View style={styles.quotaWrap}>
                        <View style={[styles.quotaBar, { width: `${option.meter}%`, backgroundColor: quotaRingColor(option.meter) }]} />
                      </View>
                    )}
                  </View>
                  {active && <Text style={styles.check}>✓</Text>}
                </Pressable>
              )
            })}
          </ScrollView>
          <Pressable style={styles.centerBtn} onPress={() => { onClose(); onOpenCenter() }}>
            <Text style={styles.centerBtnText}>打开模型调用与审计</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 18, paddingBottom: 24, maxHeight: 520,
  },
  handle: {
    alignSelf: 'center', width: 36, height: 4, borderRadius: 2,
    backgroundColor: theme.line, marginTop: 10, marginBottom: 12,
  },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink, marginBottom: 10 },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 11, paddingHorizontal: 10, borderRadius: 10, marginBottom: 2,
  },
  rowOn: { backgroundColor: alpha(theme.accent, 0.07) },
  name: { fontSize: 14, fontWeight: '600', color: theme.ink },
  meta: { fontSize: 11, color: theme.inkFaint, marginTop: 2 },
  quotaHint: { fontSize: 11, color: '#2F8F5B', marginTop: 2 },
  quotaWrap: { height: 3, backgroundColor: theme.sunk, borderRadius: 2, marginTop: 5, overflow: 'hidden' },
  quotaBar: { height: 3, borderRadius: 2 },
  check: { fontSize: 14, color: theme.accent, fontWeight: '700' },
  centerBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 6 },
  centerBtnText: { fontSize: 13, color: theme.accent, fontWeight: '600' },
})
