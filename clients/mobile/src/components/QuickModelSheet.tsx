// ══════════════════════════════════════════════
// QuickModelSheet — 聊天顶栏的模型快速切换（对齐 desktop ChatPanel 顶栏下拉）
// 按当前聊天模式的 feature（fairy_chat / fairy_omni_chat）过滤可选模型
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme, alpha } from '../theme'
import {
  FEATURE_SPECS,
  modelsForFeature,
  type ModelDef,
} from '../lib/models/registry'
import {
  solevupListModelFreeQuota,
  solevupSetFeatureBinding,
  type ModelFreeQuotaRow,
} from '../lib/solevupdb'

interface Props {
  readonly visible: boolean
  readonly feature: 'fairy_chat' | 'fairy_omni_chat'
  readonly currentModel: string | null
  readonly onClose: () => void
  readonly onPicked: (modelId: string) => void
  readonly onOpenCenter: () => void
}

function quotaPercent(q: ModelFreeQuotaRow | undefined): number | null {
  if (!q || q.errorMessage || q.notSupported || q.totalTokens <= 0) return null
  return Math.max(0, Math.min(100, (q.remainingTokens / q.totalTokens) * 100))
}

function priceLine(def: ModelDef): string {
  const t = def.pricing[0]
  if (!t) return ''
  const parts: string[] = []
  if (t.price_input_text != null) parts.push(`¥${t.price_input_text}/M入`)
  if (t.price_output_text != null) parts.push(`¥${t.price_output_text}/M出`)
  if (t.price_output_audio != null) parts.push(`¥${t.price_output_audio}/M音`)
  return parts.join(' · ')
}

export default function QuickModelSheet({ visible, feature, currentModel, onClose, onPicked, onOpenCenter }: Props) {
  const [quotas, setQuotas] = useState<Map<string, ModelFreeQuotaRow>>(new Map())
  const spec = FEATURE_SPECS.find((s) => s.feature === feature)!
  const models = modelsForFeature(spec)

  useEffect(() => {
    if (!visible) return
    solevupListModelFreeQuota()
      .then((rows) => setQuotas(new Map(rows.map((r) => [r.modelId, r]))))
      .catch(() => {})
  }, [visible])

  const pick = (id: string) => {
    void solevupSetFeatureBinding(feature, id).catch(() => {})
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
              const pct = quotaPercent(quotas.get(m.id))
              return (
                <Pressable key={m.id} style={[styles.row, active && styles.rowOn]} onPress={() => pick(m.id)}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, active && { color: theme.accent }]}>
                      {m.display_name ?? m.id}
                    </Text>
                    <Text style={styles.meta}>{priceLine(m)}</Text>
                    {pct != null && (
                      <View style={styles.quotaWrap}>
                        <View style={[styles.quotaBar, { width: `${pct}%` }]} />
                      </View>
                    )}
                  </View>
                  {active && <Text style={styles.check}>✓</Text>}
                </Pressable>
              )
            })}
          </ScrollView>
          <Pressable style={styles.centerBtn} onPress={() => { onClose(); onOpenCenter() }}>
            <Text style={styles.centerBtnText}>打开模型中心</Text>
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
  quotaWrap: { height: 3, backgroundColor: theme.sunk, borderRadius: 2, marginTop: 5, overflow: 'hidden' },
  quotaBar: { height: 3, backgroundColor: '#3FA86A', borderRadius: 2 },
  check: { fontSize: 14, color: theme.accent, fontWeight: '700' },
  centerBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 6 },
  centerBtnText: { fontSize: 13, color: theme.accent, fontWeight: '600' },
})
