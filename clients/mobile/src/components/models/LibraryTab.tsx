// ══════════════════════════════════════════════
// 模型库 Tab（对齐 desktop LibraryTab）
// 差异：手机端没有新增 / 修改，只能从 models.dev 更新 Claude 的模型；百炼额度扫描要在已登录的内嵌 WebView 里注入脚本，
// 手机端不做，额度由桌面端扫完经同步带过来（model_free_quota 表），这里只显示
// ══════════════════════════════════════════════

import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import type { ModelCategory, ModelDef } from '../../lib/models/registry'
import type { ModelFreeQuota } from '../../lib/models/model-audit'
import { MODEL_CATEGORY_LABEL } from '../../lib/models/model-display'
import { Empty, Segmented } from './parts'
import ModelCard from './ModelCard'

const CATEGORY_ORDER: readonly ModelCategory[] = ['text', 'omni', 'realtime', 'embedding', 'asr', 'decision']

export default function LibraryTab({
  category,
  models,
  freeQuotaByModel,
  onCategory,
  onPullClaude,
  pullingClaude,
  onOpenBailian,
  onOpenBailianDetail,
}: {
  category: ModelCategory
  models: readonly ModelDef[]
  freeQuotaByModel: Map<string, ModelFreeQuota>
  onCategory: (v: ModelCategory) => void
  onPullClaude: () => void
  pullingClaude: boolean
  onOpenBailian: () => void
  onOpenBailianDetail: (modelCode: string) => void
}) {
  const options = useMemo(() => CATEGORY_ORDER.map((c) => ({ value: c, label: MODEL_CATEGORY_LABEL[c] })), [])

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title}>模型库</Text>
          <Text style={styles.muted}>和电脑端双向同步，Claude 的模型能从 models.dev 更新 · 历史调用成本不回溯</Text>
        </View>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" hitSlop={6} disabled={pullingClaude} onPress={onPullClaude}>
            <Text style={[styles.link, pullingClaude && styles.linkBusy]}>{pullingClaude ? '更新中' : '更新 Claude 模型'}</Text>
          </Pressable>
          <Pressable accessibilityRole="link" hitSlop={6} onPress={onOpenBailian}>
            <Text style={styles.link}>打开百炼</Text>
          </Pressable>
        </View>
      </View>

      <Segmented scroll value={category} options={options} onChange={(v) => onCategory(v as ModelCategory)} />

      {models.length === 0 ? (
        <Empty text="该类别下还没有模型" />
      ) : (
        <View>
          {models.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              quota={freeQuotaByModel.get(model.id)}
              onOpenBailianDetail={() => onOpenBailianDetail(model.id)}
            />
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  headText: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink },
  muted: { fontSize: 12, color: theme.inkSoft, marginTop: 2 },
  actions: { alignItems: 'flex-end', gap: 6 },
  link: { fontSize: 13, color: theme.accent, fontWeight: '600', paddingVertical: 2 },
  linkBusy: { color: theme.inkSoft },
})
