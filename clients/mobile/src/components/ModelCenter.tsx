// ══════════════════════════════════════════════
// ModelCenter — 移动端模型中心（desktop ModelDialog 的手机版）
// 三 tab：绑定（双聊天模式各自选模型）/ 模型库 / 用量计费
// 数据源：静态注册表(registry.ts) + 同步四表(bindings/call_log/free_quota/api_keys)
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { theme, alpha } from '../theme'
import type { AgentConfig } from '../lib/agent/agent-config'
import {
  FEATURE_SPECS,
  MODEL_REGISTRY,
  getModelDef,
  modelsForFeature,
  parseModalities,
  type ModelDef,
  type ModelPricingTier,
} from '../lib/models/registry'
import {
  solevupListFeatureBindings,
  solevupListModelApiKeys,
  solevupListModelFreeQuota,
  solevupQueryModelCallLog,
  solevupSetFeatureBinding,
  type ModelApiKeyListItem,
  type ModelCallLogRow,
  type ModelFreeQuotaRow,
} from '../lib/solevupdb'

interface Props {
  readonly visible: boolean
  readonly config: AgentConfig
  readonly onClose: () => void
  readonly onSaveConfig: (updates: Partial<AgentConfig>) => void
}

type TabKey = 'bindings' | 'library' | 'usage'

const MODALITY_LABEL: Record<string, string> = {
  text: '文', image: '图', video: '视', audio_in: '听', audio_out: '说',
}

const CATEGORY_LABEL: Record<string, string> = {
  text: '文本', omni: '全模态', realtime: '实时', embedding: '嵌入',
}

// ── 计费（对齐 desktop breakdownCallCost：分档匹配 → token × 价 / 1M） ──

function priceOf(tokens: number, p: number | null | undefined): number {
  return tokens > 0 && p != null ? (tokens * p) / 1_000_000 : 0
}

function computeCallCost(row: ModelCallLogRow): number {
  if (row.costCny != null) return row.costCny // desktop 已计成本（含免费额度抵扣）
  const def = getModelDef(row.modelId)
  if (!def) return 0
  const promptTotal = row.promptTextTokens + row.promptImageTokens + row.promptVideoTokens + row.promptAudioTokens
  const tier: ModelPricingTier | undefined = def.pricing.find(
    (t) => promptTotal >= t.tier_min_tokens && (t.tier_max_tokens == null || promptTotal < t.tier_max_tokens),
  ) ?? def.pricing[0]
  if (!tier) return 0
  const hasAudioOut = row.completionAudioTokens > 0
  return (
    priceOf(row.promptTextTokens, tier.price_input_text) +
    priceOf(row.promptImageTokens, tier.price_input_image ?? tier.price_input_text) +
    priceOf(row.promptVideoTokens, tier.price_input_video ?? tier.price_input_text) +
    priceOf(row.promptAudioTokens, tier.price_input_audio) +
    // 有音频输出时文本输出不计费（Omni 双模态口径，对齐 desktop）
    (hasAudioOut ? 0 : priceOf(row.completionTextTokens, tier.price_output_text)) +
    priceOf(row.completionAudioTokens, tier.price_output_audio)
  )
}

function fmtCny(v: number): string {
  if (v === 0) return '¥0'
  if (v < 0.01) return `¥${v.toFixed(4)}`
  return `¥${v.toFixed(2)}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// 价格摘要："¥1.2-4.8/M入 · ¥7.2-28.8/M出"
function pricingSummary(def: ModelDef): string {
  if (!def.pricing.length) return '—'
  const ins = def.pricing.map((t) => t.price_input_text).filter((v): v is number => v != null)
  const outs = def.pricing.map((t) => t.price_output_text).filter((v): v is number => v != null)
  const range = (vs: number[]) => {
    if (!vs.length) return null
    const lo = Math.min(...vs); const hi = Math.max(...vs)
    return lo === hi ? `${lo}` : `${lo}-${hi}`
  }
  const inS = range(ins); const outS = range(outs)
  if (inS && outS) return `¥${inS}/M入 · ¥${outS}/M出`
  if (inS) return `¥${inS}/M入`
  return '—'
}

// 免费额度剩余百分比（对齐 desktop positiveFreeQuotaPercent）
function quotaPercent(q: ModelFreeQuotaRow | undefined): number | null {
  if (!q || q.errorMessage || q.notSupported || q.totalTokens <= 0) return null
  return Math.max(0, Math.min(100, (q.remainingTokens / q.totalTokens) * 100))
}

export default function ModelCenter({ visible, config, onClose, onSaveConfig }: Props) {
  const [tab, setTab] = useState<TabKey>('bindings')
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [quotas, setQuotas] = useState<ModelFreeQuotaRow[]>([])
  const [callLog, setCallLog] = useState<ModelCallLogRow[]>([])
  const [syncedKeys, setSyncedKeys] = useState<ModelApiKeyListItem[]>([])
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null)
  const [manualKey, setManualKey] = useState('')
  const [showKey, setShowKey] = useState(false)

  const quotaById = useMemo(() => new Map(quotas.map((q) => [q.modelId, q])), [quotas])

  const reload = useCallback(() => {
    solevupListFeatureBindings()
      .then((rows) => setBindings(Object.fromEntries(rows.map((r) => [r.feature, r.modelId]))))
      .catch(() => {})
    solevupListModelFreeQuota().then(setQuotas).catch(() => {})
    solevupListModelApiKeys().then(setSyncedKeys).catch(() => setSyncedKeys([]))
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    solevupQueryModelCallLog(since, 3000).then(setCallLog).catch(() => {})
  }, [])

  useEffect(() => {
    if (!visible) return
    setManualKey(config.dashscopeApiKey ?? '')
    setShowKey(false)
    setExpandedFeature(null)
    reload()
  }, [visible, config, reload])

  const pickModel = useCallback((feature: string, modelId: string) => {
    setBindings((prev) => ({ ...prev, [feature]: modelId }))
    setExpandedFeature(null)
    void solevupSetFeatureBinding(feature, modelId).catch(() => {})
  }, [])

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* ── 顶栏 ── */}
        <View style={styles.topbar}>
          <Pressable hitSlop={10} onPress={onClose}><Text style={styles.closeText}>关闭</Text></Pressable>
          <Text style={styles.title}>模型中心</Text>
          <View style={{ width: 36 }} />
        </View>

        {/* ── Tab 切换 ── */}
        <View style={styles.tabs}>
          {([['bindings', '绑定'], ['library', '模型库'], ['usage', '用量']] as [TabKey, string][]).map(([k, label]) => (
            <Pressable key={k} style={[styles.tabBtn, tab === k && styles.tabBtnOn]} onPress={() => setTab(k)}>
              <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {tab === 'bindings' && (
            <BindingsTab
              bindings={bindings}
              quotaById={quotaById}
              expanded={expandedFeature}
              onToggle={(f) => setExpandedFeature((cur) => (cur === f ? null : f))}
              onPick={pickModel}
              syncedKeys={syncedKeys}
              manualKey={manualKey}
              showKey={showKey}
              onManualKey={setManualKey}
              onToggleShow={() => setShowKey((v) => !v)}
              onSaveManualKey={() => onSaveConfig({ dashscopeApiKey: manualKey.trim() || null })}
            />
          )}
          {tab === 'library' && <LibraryTab quotaById={quotaById} />}
          {tab === 'usage' && <UsageTab callLog={callLog} />}
        </ScrollView>
      </View>
    </Modal>
  )
}

// ══════════════ 绑定 Tab ══════════════

function BindingsTab({
  bindings, quotaById, expanded, onToggle, onPick,
  syncedKeys, manualKey, showKey, onManualKey, onToggleShow, onSaveManualKey,
}: {
  bindings: Record<string, string>
  quotaById: Map<string, ModelFreeQuotaRow>
  expanded: string | null
  onToggle: (feature: string) => void
  onPick: (feature: string, modelId: string) => void
  syncedKeys: ModelApiKeyListItem[]
  manualKey: string
  showKey: boolean
  onManualKey: (v: string) => void
  onToggleShow: () => void
  onSaveManualKey: () => void
}) {
  return (
    <>
      <Text style={styles.sectionTitle}>功能 → 模型绑定</Text>
      <Text style={styles.sectionHint}>改动会随下一轮同步推回电脑</Text>
      {FEATURE_SPECS.map((spec) => {
        const bound = bindings[spec.feature]
        const def = bound ? getModelDef(bound) : undefined
        const open = expanded === spec.feature
        return (
          <View key={spec.feature} style={styles.bindCard}>
            <Pressable style={styles.bindHead} onPress={() => onToggle(spec.feature)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.bindLabel}>{spec.label}</Text>
                <Text style={styles.bindHint}>{spec.hint}</Text>
              </View>
              <Text style={styles.bindModel}>{def?.display_name ?? bound ?? '未绑定'}</Text>
              <Text style={styles.chev}>{open ? '▴' : '▾'}</Text>
            </Pressable>
            {open && (
              <View style={styles.pickList}>
                {modelsForFeature(spec).map((m) => (
                  <ModelPickRow
                    key={m.id}
                    def={m}
                    active={m.id === bound}
                    quota={quotaById.get(m.id)}
                    onPress={() => onPick(spec.feature, m.id)}
                  />
                ))}
              </View>
            )}
          </View>
        )
      })}

      <Text style={[styles.sectionTitle, { marginTop: 24 }]}>API Key</Text>
      {syncedKeys.length > 0 ? (
        syncedKeys.map((k) => (
          <View key={k.id} style={styles.keyRow}>
            <Text style={styles.keyLabel}>{k.label}</Text>
            {k.isActive && k.hasKey
              ? <Text style={styles.keyOn}>● 当前使用</Text>
              : !k.hasKey ? <Text style={styles.keyOff}>已删除</Text> : null}
          </View>
        ))
      ) : (
        <Text style={styles.sectionHint}>还没有同步的 Key — 与电脑同步一次，或在下方手填</Text>
      )}
      <View style={styles.manualKeyRow}>
        <TextInput
          style={styles.manualKeyInput}
          value={manualKey}
          onChangeText={onManualKey}
          placeholder="手动 Key（仅同步缺失时兜底）"
          placeholderTextColor={theme.inkFaint}
          secureTextEntry={!showKey}
          autoCapitalize="none"
          autoCorrect={false}
          onBlur={onSaveManualKey}
        />
        <Pressable style={styles.eyeBtn} onPress={onToggleShow}>
          <Text style={styles.eyeText}>{showKey ? '隐藏' : '显示'}</Text>
        </Pressable>
      </View>
    </>
  )
}

function ModelPickRow({ def, active, quota, onPress }: {
  def: ModelDef; active: boolean; quota?: ModelFreeQuotaRow; onPress: () => void
}) {
  const pct = quotaPercent(quota)
  return (
    <Pressable style={[styles.pickRow, active && styles.pickRowOn]} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.pickName, active && { color: theme.accent }]}>{def.display_name ?? def.id}</Text>
        <Text style={styles.pickMeta}>{pricingSummary(def)}</Text>
        {pct != null && (
          <View style={styles.quotaBarWrap}>
            <View style={[styles.quotaBar, { width: `${pct}%` }]} />
          </View>
        )}
      </View>
      {active && <Text style={styles.pickCheck}>✓</Text>}
    </Pressable>
  )
}

// ══════════════ 模型库 Tab ══════════════

function LibraryTab({ quotaById }: { quotaById: Map<string, ModelFreeQuotaRow> }) {
  // 主 id 行（无日期后缀别名）优先展示，别名折叠计数
  const groups = useMemo(() => {
    const mains = MODEL_REGISTRY.filter((m) => !/\d{4}-\d{2}-\d{2}$/.test(m.id))
    const byCat = new Map<string, ModelDef[]>()
    for (const m of mains) {
      const list = byCat.get(m.category) ?? []
      list.push(m)
      byCat.set(m.category, list)
    }
    return (['text', 'omni', 'realtime', 'embedding'] as const)
      .filter((c) => byCat.has(c))
      .map((c) => ({ category: c, models: byCat.get(c)! }))
  }, [])

  return (
    <>
      {groups.map(({ category, models }) => (
        <View key={category}>
          <Text style={styles.sectionTitle}>{CATEGORY_LABEL[category]}（{models.length}）</Text>
          {models.map((m) => {
            const quota = quotaById.get(m.id)
            const pct = quotaPercent(quota)
            const mods = parseModalities(m)
            return (
              <View key={m.id} style={styles.libCard}>
                <View style={styles.libHead}>
                  <Text style={styles.libName}>{m.display_name ?? m.id}</Text>
                  <View style={styles.modChips}>
                    {mods.map((mod) => (
                      <Text key={mod} style={styles.modChip}>{MODALITY_LABEL[mod] ?? mod}</Text>
                    ))}
                  </View>
                </View>
                <Text style={styles.libId}>{m.id}{m.context_window ? ` · ${fmtTokens(m.context_window)} ctx` : ''}</Text>
                <Text style={styles.libPrice}>{pricingSummary(m)}{m.pricing.length > 1 ? `（${m.pricing.length} 档阶梯）` : ''}</Text>
                {pct != null && quota && (
                  <View style={styles.libQuotaRow}>
                    <View style={styles.quotaBarWrap}>
                      <View style={[styles.quotaBar, { width: `${pct}%` }]} />
                    </View>
                    <Text style={styles.libQuotaText}>
                      免费 {fmtTokens(quota.remainingTokens)}/{fmtTokens(quota.totalTokens)}
                      {quota.expireDate ? ` · 至 ${quota.expireDate.slice(0, 10)}` : ''}
                    </Text>
                  </View>
                )}
                {m.notes && <Text style={styles.libNotes}>{m.notes}</Text>}
              </View>
            )
          })}
        </View>
      ))}
      <Text style={styles.footNote}>模型库与电脑端同源（随版本更新）；免费额度由电脑端扫描后同步过来</Text>
    </>
  )
}

// ══════════════ 用量 Tab ══════════════

function UsageTab({ callLog }: { callLog: ModelCallLogRow[] }) {
  const stats = useMemo(() => {
    let totalCost = 0
    let totalCalls = 0
    let totalTokens = 0
    const byDay = new Map<string, { calls: number; tokens: number; cost: number }>()
    const byFeature = new Map<string, { calls: number; tokens: number; cost: number }>()
    for (const row of callLog) {
      const cost = computeCallCost(row)
      const tokens =
        row.promptTextTokens + row.promptImageTokens + row.promptVideoTokens + row.promptAudioTokens +
        row.completionTextTokens + row.completionAudioTokens
      totalCost += cost; totalCalls += 1; totalTokens += tokens
      const day = row.startedAt.slice(0, 10)
      const d = byDay.get(day) ?? { calls: 0, tokens: 0, cost: 0 }
      d.calls += 1; d.tokens += tokens; d.cost += cost
      byDay.set(day, d)
      const f = byFeature.get(row.feature) ?? { calls: 0, tokens: 0, cost: 0 }
      f.calls += 1; f.tokens += tokens; f.cost += cost
      byFeature.set(row.feature, f)
    }
    return {
      totalCost, totalCalls, totalTokens,
      days: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)),
      features: [...byFeature.entries()].sort((a, b) => b[1].cost - a[1].cost),
    }
  }, [callLog])

  const maxDayCost = Math.max(0.0001, ...stats.days.map(([, d]) => d.cost))

  return (
    <>
      <Text style={styles.sectionTitle}>近 7 天</Text>
      <View style={styles.statRow}>
        <StatBox label="费用" value={fmtCny(stats.totalCost)} />
        <StatBox label="调用" value={String(stats.totalCalls)} />
        <StatBox label="Tokens" value={fmtTokens(stats.totalTokens)} />
      </View>

      <Text style={styles.sectionTitle}>按日</Text>
      {stats.days.length === 0 && <Text style={styles.sectionHint}>近 7 天没有调用记录（与电脑同步后会包含两端用量）</Text>}
      {stats.days.map(([day, d]) => (
        <View key={day} style={styles.dayRow}>
          <Text style={styles.dayLabel}>{day.slice(5)}</Text>
          <View style={styles.dayBarWrap}>
            <View style={[styles.dayBar, { width: `${Math.max(2, (d.cost / maxDayCost) * 100)}%` }]} />
          </View>
          <Text style={styles.dayMeta}>{d.calls} 次 · {fmtTokens(d.tokens)} · {fmtCny(d.cost)}</Text>
        </View>
      ))}

      <Text style={styles.sectionTitle}>按功能</Text>
      {stats.features.map(([feature, f]) => {
        const spec = FEATURE_SPECS.find((s) => s.feature === feature)
        return (
          <View key={feature} style={styles.featRow}>
            <Text style={styles.featLabel}>{spec?.label ?? feature}</Text>
            <Text style={styles.dayMeta}>{f.calls} 次 · {fmtTokens(f.tokens)} · {fmtCny(f.cost)}</Text>
          </View>
        )
      })}
      <Text style={styles.footNote}>电脑端记录带实付成本（含免费额度抵扣）；手机端记录按价目表估算</Text>
    </>
  )
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

// ══════════════ 样式 ══════════════

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 16, paddingBottom: 10,
  },
  closeText: { fontSize: 14, color: theme.accent },
  title: { fontSize: 16, fontWeight: '700', color: theme.ink },
  tabs: {
    flexDirection: 'row', marginHorizontal: 18, marginBottom: 4,
    backgroundColor: theme.sunk, borderRadius: 10, padding: 3,
  },
  tabBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center' },
  tabBtnOn: { backgroundColor: theme.surface },
  tabText: { fontSize: 13, color: theme.inkSoft },
  tabTextOn: { color: theme.ink, fontWeight: '600' },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 18, paddingBottom: 40 },

  sectionTitle: { fontSize: 13, fontWeight: '700', color: theme.inkSoft, marginTop: 18, marginBottom: 8 },
  sectionHint: { fontSize: 11, color: theme.inkFaint, marginBottom: 8 },
  footNote: { fontSize: 11, color: theme.inkFaint, marginTop: 16, lineHeight: 16 },

  // 绑定
  bindCard: { backgroundColor: theme.surface, borderRadius: 12, marginBottom: 8, overflow: 'hidden' },
  bindHead: { flexDirection: 'row', alignItems: 'center', padding: 13, gap: 8 },
  bindLabel: { fontSize: 14, fontWeight: '600', color: theme.ink },
  bindHint: { fontSize: 11, color: theme.inkFaint, marginTop: 2 },
  bindModel: { fontSize: 12, color: theme.accent, maxWidth: 130 },
  chev: { fontSize: 12, color: theme.inkFaint },
  pickList: { borderTopWidth: 1, borderTopColor: theme.line },
  pickRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, paddingVertical: 10, gap: 8 },
  pickRowOn: { backgroundColor: alpha(theme.accent, 0.06) },
  pickName: { fontSize: 13, fontWeight: '600', color: theme.ink },
  pickMeta: { fontSize: 11, color: theme.inkFaint, marginTop: 1 },
  pickCheck: { fontSize: 14, color: theme.accent, fontWeight: '700' },

  // 免费额度条
  quotaBarWrap: { height: 3, backgroundColor: theme.sunk, borderRadius: 2, marginTop: 5, overflow: 'hidden' },
  quotaBar: { height: 3, backgroundColor: '#3FA86A', borderRadius: 2 },

  // 模型库
  libCard: { backgroundColor: theme.surface, borderRadius: 12, padding: 13, marginBottom: 8 },
  libHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  libName: { fontSize: 14, fontWeight: '600', color: theme.ink, flex: 1 },
  modChips: { flexDirection: 'row', gap: 3 },
  modChip: {
    fontSize: 10, color: theme.inkSoft, backgroundColor: theme.sunk,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: 'hidden',
  },
  libId: { fontSize: 11, color: theme.inkFaint, marginTop: 3 },
  libPrice: { fontSize: 12, color: theme.inkSoft, marginTop: 4 },
  libQuotaRow: { marginTop: 6 },
  libQuotaText: { fontSize: 10, color: '#3FA86A', marginTop: 3 },
  libNotes: { fontSize: 10, color: theme.inkFaint, marginTop: 6, lineHeight: 14 },

  // 用量
  statRow: { flexDirection: 'row', gap: 8 },
  statBox: { flex: 1, backgroundColor: theme.surface, borderRadius: 12, padding: 12, alignItems: 'center' },
  statValue: { fontSize: 17, fontWeight: '700', color: theme.ink },
  statLabel: { fontSize: 11, color: theme.inkFaint, marginTop: 2 },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  dayLabel: { width: 42, fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  dayBarWrap: { flex: 1, height: 6, backgroundColor: theme.sunk, borderRadius: 3, overflow: 'hidden' },
  dayBar: { height: 6, backgroundColor: alpha(theme.accent, 0.6), borderRadius: 3 },
  dayMeta: { fontSize: 10, color: theme.inkFaint, fontVariant: ['tabular-nums'] },
  featRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: theme.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 6,
  },
  featLabel: { fontSize: 13, color: theme.ink },

  // API Key
  keyRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: theme.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6,
  },
  keyLabel: { fontSize: 13, fontWeight: '600', color: theme.ink },
  keyOn: { fontSize: 11, color: '#3FA86A', fontWeight: '600' },
  keyOff: { fontSize: 11, color: theme.inkFaint },
  manualKeyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  manualKeyInput: {
    flex: 1, backgroundColor: theme.sunk, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, color: theme.ink,
  },
  eyeBtn: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, backgroundColor: theme.sunk },
  eyeText: { fontSize: 12, color: theme.inkSoft },
})
