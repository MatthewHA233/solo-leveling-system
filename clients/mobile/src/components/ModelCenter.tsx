// ══════════════════════════════════════════════
// ModelCenter — 模型调用与审计（desktop ModelDialog 的手机版）
// 三 tab：用量 / 模型库 / 功能绑定；顶部有 API Key 管理和刷新
// 数据源：SolevupDb（model_registry 只读镜像 + 同步四表）；各 tab 拆在 components/models/ 下
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme } from '../theme'
import type { AgentConfig } from '../lib/agent/agent-config'
import {
  FEATURE_LABEL,
  FEATURE_SPECS,
  ensureModelCatalog,
  refreshModelCatalog,
  type ModelCategory,
  type ModelDef,
} from '../lib/models/registry'
import {
  deleteModelApiKey,
  emitFeatureBindingUpdated,
  listFeatureBindings,
  listModelApiKeys,
  listModelFreeQuotas,
  openBailianLogin,
  openBailianModelDetail,
  queryCallLog,
  setActiveModelApiKey,
  setFeatureModel,
  subscribeFeatureBindingUpdated,
  subscribeModelUsageLogged,
  upsertModelApiKey,
  type FeatureBinding,
  type ModelApiKey,
  type ModelCallLog,
  type ModelFreeQuota,
} from '../lib/models/model-audit'
import ConfirmDialog from './ConfirmDialog'
import ApiKeySheet from './models/ApiKeySheet'
import BindingsTab from './models/BindingsTab'
import LibraryTab from './models/LibraryTab'
import UsageTab from './models/UsageTab'
import {
  KEY_PROVIDER_META,
  computeUsageTotals,
  nextApiKeyLabel,
  tone,
  viewWindow,
  type KeyProvider,
  type TabKey,
  type ViewMode,
} from './models/model-utils'
import { TabButton } from './models/parts'

interface Props {
  readonly visible: boolean
  readonly config: AgentConfig
  readonly onClose: () => void
  readonly onSaveConfig: (updates: Partial<AgentConfig>) => void
}

// 换百炼 Key 时清掉单独填的 Omni / ASR Key，否则实时语音和识别还在用旧 Key（和桌面端 ModelDialog 一致）
function dashscopeKeyConfig(apiKey: string | null | undefined): Partial<AgentConfig> {
  return {
    dashscopeApiKey: apiKey || null,
    openaiApiKey: apiKey || null,
    omniApiKey: null,
    asrApiKey: null,
  }
}

export default function ModelCenter({ visible, config, onClose, onSaveConfig }: Props) {
  const [tab, setTab] = useState<TabKey>('usage')
  const [models, setModels] = useState<ModelDef[]>([])
  const [bindings, setBindings] = useState<FeatureBinding[]>([])
  const [calls, setCalls] = useState<ModelCallLog[]>([])
  const [viewMode, setViewMode] = useState<ViewMode>('day')
  const [anchorDate, setAnchorDate] = useState<Date>(() => new Date())
  const [category, setCategory] = useState<ModelCategory>('text')
  const [feature, setFeature] = useState<string>('all')
  const [modelId, setModelId] = useState<string>('all')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [apiKeys, setApiKeys] = useState<ModelApiKey[]>([])
  const [apiKeyOpen, setApiKeyOpen] = useState(false)
  const [creatingApiKey, setCreatingApiKey] = useState(false)
  const [newApiKeyLabel, setNewApiKeyLabel] = useState('百炼 API Key')
  const [newApiKeyValue, setNewApiKeyValue] = useState('')
  const [keyProvider, setKeyProvider] = useState<KeyProvider>('dashscope')
  const [pendingDeleteKey, setPendingDeleteKey] = useState<ModelApiKey | null>(null)
  const [freeQuotas, setFreeQuotas] = useState<ModelFreeQuota[]>([])
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flashSaved = useCallback((text: string) => {
    setSaved(text)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(null), 1800)
  }, [])

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current)
  }, [])

  const loadBase = useCallback(async () => {
    setErr(null)
    try {
      await ensureModelCatalog()
      const [modelRows, bindingRows, keyRows, quotaRows] = await Promise.all([
        refreshModelCatalog(),
        listFeatureBindings(),
        listModelApiKeys(),
        listModelFreeQuotas(),
      ])
      setModels(modelRows)
      setBindings(bindingRows)
      setApiKeys(keyRows)
      setFreeQuotas(quotaRows)
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  const loadUsage = useCallback(async () => {
    const { from, to } = viewWindow(viewMode, anchorDate)
    setLoading(true)
    setErr(null)
    try {
      const featureArg = feature === 'all' ? null : feature
      const modelArg = modelId === 'all' ? null : modelId
      // 只按百炼 Key 分账：Anthropic 和未归属（Vercel 决策）的调用不能被当前百炼 Key 过滤掉
      const hiddenKeyIds = new Set(
        apiKeys.some((k) => k.is_active && k.provider === 'dashscope')
          ? apiKeys.filter((k) => !k.is_active && k.provider === 'dashscope').map((k) => k.id)
          : [],
      )
      const callRows = await queryCallLog({
        timeFrom: from,
        timeTo: to,
        feature: featureArg,
        modelId: modelArg,
        apiKeyId: null,
        limit: null,
      })
      setCalls(callRows.filter((c) => !c.api_key_id || !hiddenKeyIds.has(c.api_key_id)))
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [apiKeys, anchorDate, viewMode, feature, modelId])

  useEffect(() => {
    if (!visible) return
    void loadBase()
  }, [visible, loadBase])

  useEffect(() => {
    if (!visible) return
    return subscribeFeatureBindingUpdated(() => { void loadBase() })
  }, [visible, loadBase])

  useEffect(() => {
    if (!visible) return
    void loadUsage()
  }, [visible, loadUsage])

  // 开着面板时有新调用落库就刷新明细（桌面端靠手动刷新，手机端聊天和面板会同屏切换）
  useEffect(() => {
    if (!visible) return
    return subscribeModelUsageLogged(() => { void loadUsage() })
  }, [visible, loadUsage])

  const modelPricingMap = useMemo(() => new Map(models.map((m) => [m.id, m.pricing])), [models])
  const usageTotals = useMemo(() => computeUsageTotals(calls, modelPricingMap), [calls, modelPricingMap])
  const bindingByFeature = useMemo(() => new Map(bindings.map((b) => [b.feature, b.model_id])), [bindings])
  const activeApiKey = useMemo(() => apiKeys.find((k) => k.is_active && k.provider === 'dashscope') ?? null, [apiKeys])
  /** 当前弹层里这个提供商的 Key 列表 */
  const providerKeys = useMemo(() => apiKeys.filter((k) => k.provider === keyProvider), [apiKeys, keyProvider])
  const providerActiveId = useMemo(() => providerKeys.find((k) => k.is_active)?.id ?? null, [providerKeys])
  const freeQuotaByModel = useMemo(() => new Map(freeQuotas.map((q) => [q.model_id, q])), [freeQuotas])
  const categoryModels = useMemo(() => models.filter((m) => m.category === category), [models, category])

  const openBailian = useCallback(() => {
    setErr(null)
    void openBailianLogin().catch((e) => setErr(String(e)))
  }, [])

  const startCreateApiKey = useCallback(() => {
    setNewApiKeyLabel(nextApiKeyLabel(apiKeys.filter((k) => k.provider === keyProvider), KEY_PROVIDER_META[keyProvider].defaultLabel))
    setNewApiKeyValue('')
    setCreatingApiKey(true)
  }, [apiKeys, keyProvider])

  const changeKeyProvider = useCallback((next: KeyProvider) => {
    setKeyProvider(next)
    setCreatingApiKey(false)
    setNewApiKeyValue('')
  }, [])

  const activateApiKey = useCallback(async (key: ModelApiKey) => {
    setErr(null)
    try {
      await setActiveModelApiKey(key.id)
      if (key.provider === 'dashscope') onSaveConfig(dashscopeKeyConfig(key.api_key))
      flashSaved(`${key.label} 已切换`)
      await loadBase()
      await loadUsage()
    } catch (e) {
      setErr(String(e))
    }
  }, [flashSaved, loadBase, loadUsage, onSaveConfig])

  const saveApiKey = useCallback(async (provider: KeyProvider, label: string, value: string) => {
    const meta = KEY_PROVIDER_META[provider]
    const key = await upsertModelApiKey({
      label: label.trim() || nextApiKeyLabel(apiKeys.filter((k) => k.provider === provider), meta.defaultLabel),
      api_key: value,
      is_active: true,
      provider,
    })
    if (provider === 'dashscope') onSaveConfig(dashscopeKeyConfig(key.api_key))
    return key
  }, [apiKeys, onSaveConfig])

  const saveNewApiKey = useCallback(async () => {
    setErr(null)
    try {
      const key = await saveApiKey(keyProvider, newApiKeyLabel, newApiKeyValue)
      const meta = KEY_PROVIDER_META[keyProvider]
      setNewApiKeyLabel(nextApiKeyLabel([...apiKeys, key].filter((k) => k.provider === keyProvider), meta.defaultLabel))
      setNewApiKeyValue('')
      setCreatingApiKey(false)
      flashSaved(`${key.label} 已保存并切换`)
      await loadBase()
      await loadUsage()
    } catch (e) {
      setErr(String(e))
    }
  }, [apiKeys, flashSaved, keyProvider, loadBase, loadUsage, newApiKeyLabel, newApiKeyValue, saveApiKey])

  // 旧版在设置里手填的百炼 Key：存进 Key 库后用量才有归属
  const importLegacyKey = useCallback(async () => {
    if (!config.dashscopeApiKey) return
    setErr(null)
    try {
      const key = await saveApiKey('dashscope', '', config.dashscopeApiKey)
      flashSaved(`${key.label} 已保存并切换`)
      await loadBase()
      await loadUsage()
    } catch (e) {
      setErr(String(e))
    }
  }, [config.dashscopeApiKey, flashSaved, loadBase, loadUsage, saveApiKey])

  const confirmDeleteApiKey = useCallback(async () => {
    const key = pendingDeleteKey
    if (!key) return
    setPendingDeleteKey(null)
    setErr(null)
    try {
      await deleteModelApiKey(key.id)
      flashSaved(`${key.label} 已删除`)
      await loadBase()
      await loadUsage()
      // 配置里还留着被删的那把时换成顶上来的 Key，否则聊天兜底会继续用已删除的 Key
      if (key.provider === 'dashscope' && config.dashscopeApiKey === key.api_key) {
        const next = (await listModelApiKeys()).find((k) => k.is_active && k.provider === 'dashscope')
        onSaveConfig(dashscopeKeyConfig(next?.api_key))
      }
    } catch (e) {
      setErr(String(e))
    }
  }, [config.dashscopeApiKey, flashSaved, loadBase, loadUsage, onSaveConfig, pendingDeleteKey])

  const setBinding = useCallback(async (featureName: string, nextModelId: string) => {
    setErr(null)
    try {
      await setFeatureModel(featureName, nextModelId)
      emitFeatureBindingUpdated(featureName, nextModelId)
      flashSaved(`${FEATURE_LABEL.get(featureName) ?? featureName} 已绑定`)
      await loadBase()
    } catch (e) {
      setErr(String(e))
    }
  }, [flashSaved, loadBase])

  const openBailianDetail = useCallback((modelCode: string) => {
    setErr(null)
    void openBailianModelDetail(modelCode).catch((e) => setErr(String(e)))
  }, [])

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* ── 顶栏 ── */}
        <View style={styles.topbar}>
          <Pressable hitSlop={10} onPress={onClose}><Text style={styles.topAction}>关闭</Text></Pressable>
          <Text style={styles.title}>模型调用与审计</Text>
          <View style={styles.topRight}>
            <Pressable hitSlop={10} onPress={() => { void loadBase(); void loadUsage() }}>
              <Text style={styles.topAction}>刷新</Text>
            </Pressable>
            <Pressable hitSlop={10} onPress={() => setApiKeyOpen(true)}>
              <Text style={[styles.topKey, { color: activeApiKey ? tone.green : tone.orange }]}>Key</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Tab 切换 ── */}
        <View style={styles.tabs}>
          <TabButton active={tab === 'usage'} label="用量" onPress={() => setTab('usage')} />
          <TabButton active={tab === 'library'} label="模型库" onPress={() => setTab('library')} />
          <TabButton active={tab === 'bindings'} label="功能绑定" onPress={() => setTab('bindings')} />
        </View>

        {(saved || err) && (
          <View style={styles.status}>
            {saved && <Text style={styles.statusOk} numberOfLines={1}>{saved}</Text>}
            {err && <Text style={styles.statusErr} numberOfLines={2}>{err}</Text>}
          </View>
        )}

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {tab === 'usage' && (
            <UsageTab
              activeKeyLabel={activeApiKey?.label ?? null}
              calls={calls}
              loading={loading}
              totals={usageTotals}
              viewMode={viewMode}
              anchorDate={anchorDate}
              feature={feature}
              modelId={modelId}
              models={models}
              freeQuotaByModel={freeQuotaByModel}
              modelPricingMap={modelPricingMap}
              onViewMode={setViewMode}
              onAnchorDate={setAnchorDate}
              onFeature={setFeature}
              onModel={setModelId}
            />
          )}

          {tab === 'library' && (
            <LibraryTab
              category={category}
              models={categoryModels}
              freeQuotaByModel={freeQuotaByModel}
              onCategory={setCategory}
              onOpenBailian={openBailian}
              onOpenBailianDetail={openBailianDetail}
            />
          )}

          {tab === 'bindings' && (
            <BindingsTab
              specs={FEATURE_SPECS}
              models={models}
              freeQuotaByModel={freeQuotaByModel}
              bindingByFeature={bindingByFeature}
              onBind={(f, m) => { void setBinding(f, m) }}
            />
          )}
        </ScrollView>

        <ApiKeySheet
          visible={apiKeyOpen}
          apiKeys={providerKeys}
          activeId={providerActiveId}
          provider={keyProvider}
          onProviderChange={changeKeyProvider}
          creating={creatingApiKey}
          newLabel={newApiKeyLabel}
          newValue={newApiKeyValue}
          legacyKey={config.dashscopeApiKey}
          onStartCreate={startCreateApiKey}
          onCancelCreate={() => setCreatingApiKey(false)}
          onNewLabel={setNewApiKeyLabel}
          onNewValue={setNewApiKeyValue}
          onSaveNew={() => { void saveNewApiKey() }}
          onImportLegacy={() => { void importLegacyKey() }}
          onActivate={(k) => { void activateApiKey(k) }}
          onDelete={setPendingDeleteKey}
          onClose={() => setApiKeyOpen(false)}
        />

        <ConfirmDialog
          open={!!pendingDeleteKey}
          title={`确定删除「${pendingDeleteKey?.label ?? ''}」吗？`}
          body="删除此 API Key 后，会同时删除归属此 Key 的所有用量记录，此操作不可恢复。"
          confirmText="确定删除"
          danger
          onCancel={() => setPendingDeleteKey(null)}
          onConfirm={() => { void confirmDeleteApiKey() }}
        />
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: theme.surface,
  },
  title: { fontSize: 16, fontWeight: '700', color: theme.ink },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  topAction: { fontSize: 14, color: theme.inkSoft },
  topKey: { fontSize: 14, fontWeight: '700' },
  tabs: {
    flexDirection: 'row', backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line,
  },
  status: { paddingHorizontal: 16, paddingVertical: 6, backgroundColor: theme.surface },
  statusOk: { fontSize: 12, color: tone.green },
  statusErr: { fontSize: 12, color: tone.danger },
  body: { flex: 1 },
  bodyContent: { padding: 16, paddingBottom: 32 },
})
