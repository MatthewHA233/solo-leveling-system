import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import {
  AlertCircle,
  AudioLines,
  BarChart3,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Eye,
  EyeOff,
  Image as ImageIcon,
  KeyRound,
  Link2,
  LogIn,
  Plus,
  RefreshCw,
  Save,
  Type as TypeIcon,
  Video,
  X,
} from 'lucide-react'
import { theme, hud } from '../theme'
import HudSelect from './HudSelect'
import Tooltip from './Tooltip'
import type {
  CallLogBucket,
  CallLogGranularity,
  FeatureBinding,
  ModelApiKey,
  ModelCallLog,
  ModelCategory,
  ModelDef,
  ModelFreeQuota,
  ModelPricingTier,
} from '../lib/local-api'
import { MODEL_SELECT_POPUP_WIDTH, modelSelectOption } from '../lib/model-display'
import type { AgentConfig } from '../lib/agent/agent-config'
import {
  deleteModelApiKey,
  getBailianAccount,
  listModelFreeQuotas,
  listModelApiKeys,
  openBailianModelDetail,
  openBailianLogin,
  scanBailianFreeQuota,
  setActiveModelApiKey,
  takeBailianQuotaProgress,
  upsertModelApiKey,
} from '../lib/model-audit'

type TabKey = 'usage' | 'library' | 'bindings'
type ViewMode = 'day' | 'week' | 'month'

interface BailianQuotaProgress {
  stage: 'start' | 'model_start' | 'model_done' | 'model_error' | 'finish' | 'fatal'
  model_id?: string
  index?: number
  total?: number
  scanned?: number
  ok?: number
  failed?: number
  row?: ModelFreeQuota
  error?: string
}

interface BailianQuotaLog {
  id: string
  stage: BailianQuotaProgress['stage']
  modelId: string
  message: string
  color: string
}

interface Props {
  readonly open: boolean
  readonly config: AgentConfig
  readonly onUpdate: (updates: Partial<AgentConfig>) => void
  readonly onClose: () => void
}

interface FeatureSpec {
  readonly feature: string
  readonly label: string
  readonly category: ModelCategory
  readonly hint: string
  readonly requiredModalities?: readonly string[]
  readonly allowedCategories?: readonly ModelCategory[]
}

const FEATURE_SPECS: readonly FeatureSpec[] = [
  { feature: 'fairy_chat', label: 'Fairy 常规聊天', category: 'text', hint: '主对话与文字思考' },
  { feature: 'fairy_omni_chat', label: 'Fairy 全模态聊天', category: 'realtime', hint: '语音/摄像头实时会话' },
  { feature: 'session_title', label: '会话自动起标题', category: 'text', hint: '会话累计若干轮后生成 3-8 字标题（建议低价模型）' },
  { feature: 'bili_omni_transcribe', label: 'B 站音视频全模态转录', category: 'omni', hint: '带音轨的视频文件转录；必须同时支持 video + audio_in', requiredModalities: ['video', 'audio_in'], allowedCategories: ['omni'] },
  { feature: 'bili_visual_transcribe', label: 'B 站仅画面转录', category: 'text', hint: '只读视频画面/屏幕正文；qwen3.6-plus 这类视频模型只能放这里', requiredModalities: ['video'] },
  { feature: 'bili_audio_transcribe', label: 'B 站仅音频转录', category: 'omni', hint: '提取音轨后走 input_audio；只显示支持音频输入的模型', requiredModalities: ['audio_in'], allowedCategories: ['omni'] },
  { feature: 'context_anchor', label: '语境锚定', category: 'text', hint: '对着语境卡聊天时定位原文片段 + 提取锚点句' },
  { feature: 'thought_distill', label: '想法沉淀', category: 'text', hint: '日常聊天判断值不值得记成想法卡（建议低价模型）' },
  { feature: 'anchor_extract', label: '框选锚点提取', category: 'text', hint: '手动框选语境后从原话提取锚点句' },
  { feature: 'anchor_embedding', label: '锚点语义嵌入', category: 'embedding', hint: '锚点域地图的球定位（语义近 = 空间近）', allowedCategories: ['embedding'] },
  { feature: 'anchor_cluster_name', label: '锚点域簇命名', category: 'text', hint: '给认知地图聚簇起 2~6 字主题名（建议低价模型）' },
]

const FEATURE_LABEL = new Map(FEATURE_SPECS.map((f) => [f.feature, f.label]))

const MODEL_ICON_URL = 'https://img.alicdn.com/imgextra/i3/O1CN01Kmx9dR1wcHOaMMXAk_!!6000000006328-55-tps-28-28.svg'

function normalizeBailianName(name: string | null | undefined): string | null {
  const s = name?.trim()
  if (!s) return null
  if (/^\d{6,}$/.test(s)) return null
  if (/^(账号|账户|账号 ID|主账号|头像|退出登录|个人认证|企业认证)$/.test(s)) return null
  return s
}

function emptyTier(): ModelPricingTier {
  return {
    tier_min_tokens: 0,
    tier_max_tokens: null,
    price_input_text: null,
    price_input_image: null,
    price_input_video: null,
    price_input_audio: null,
    price_output_text: null,
    price_output_text_thinking: null,
    price_output_audio: null,
  }
}

function parseList(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function hasAllModalities(model: ModelDef, required: readonly string[] | undefined): boolean {
  if (!required || required.length === 0) return true
  const modalities = new Set(parseList(model.modalities))
  return required.every((m) => modalities.has(m))
}

function matchesFeatureSpec(model: ModelDef, spec: FeatureSpec): boolean {
  if (spec.allowedCategories && !spec.allowedCategories.includes(model.category)) return false
  if (spec.requiredModalities) return hasAllModalities(model, spec.requiredModalities)
  return model.category === spec.category
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCny(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '¥0.00'
  if (n < 0.01 && n > 0) {
    // 极小成本（如单次嵌入 ¥0.000012）按有效数字展示，不被固定位数抹成 0
    const digits = Math.min(8, Math.max(4, 1 - Math.floor(Math.log10(n))))
    return `¥${n.toFixed(digits)}`
  }
  return `¥${n.toFixed(2)}`
}

function priceText(n: number | null | undefined): string {
  return n == null ? '-' : String(n)
}

function nextApiKeyLabel(apiKeys: readonly ModelApiKey[]): string {
  const base = '百炼 API Key'
  const labels = new Set(apiKeys.map((k) => k.label.trim()).filter(Boolean))
  if (!labels.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const label = `${base} ${i}`
    if (!labels.has(label)) return label
  }
  return `${base} ${Date.now()}`
}

interface CostPart { label: string; tokens: number; cost: number }
interface CallCostBreakdown { inputs: CostPart[]; outputs: CostPart[] }

function priceOf(tok: number, p: number | null | undefined): number {
  return tok > 0 && p != null && Number.isFinite(p) ? (tok * p) / 1_000_000 : 0
}

/** 镜像 db.rs::compute_cost：算每子项金额贡献，文本+音频输出口径下 text 输出归 0 */
function breakdownCallCost(call: ModelCallLog, pricing: ModelPricingTier[] | null | undefined): CallCostBreakdown {
  const tiers = pricing ?? []
  const promptTotal = call.prompt_text_tokens + call.prompt_image_tokens + call.prompt_video_tokens + call.prompt_audio_tokens
  const tier = tiers.find((t) => promptTotal >= t.tier_min_tokens && (t.tier_max_tokens == null || promptTotal < t.tier_max_tokens)) ?? null
  const textP = tier?.price_input_text ?? null
  const imgP = tier?.price_input_image ?? textP
  const vidP = tier?.price_input_video ?? textP
  const audP = tier?.price_input_audio ?? null
  const outTextP = tier?.price_output_text ?? null
  const outAudP = tier?.price_output_audio ?? null
  const hasAudio = call.completion_audio_tokens > 0
  return {
    inputs: [
      { label: '文本', tokens: call.prompt_text_tokens,  cost: priceOf(call.prompt_text_tokens,  textP) },
      { label: '图像', tokens: call.prompt_image_tokens, cost: priceOf(call.prompt_image_tokens, imgP)  },
      { label: '视频', tokens: call.prompt_video_tokens, cost: priceOf(call.prompt_video_tokens, vidP)  },
      { label: '音频', tokens: call.prompt_audio_tokens, cost: priceOf(call.prompt_audio_tokens, audP)  },
    ].filter((p) => p.tokens > 0),
    outputs: [
      { label: '文本', tokens: call.completion_text_tokens,  cost: hasAudio ? 0 : priceOf(call.completion_text_tokens, outTextP) },
      { label: '音频', tokens: call.completion_audio_tokens, cost: priceOf(call.completion_audio_tokens, outAudP) },
    ].filter((p) => p.tokens > 0),
  }
}

function tierLabel(tier: ModelPricingTier): string {
  const min = tier.tier_min_tokens
  const max = tier.tier_max_tokens
  const left = min === 0 ? '0' : formatTokens(min)
  return max == null ? `${left}+` : `${left}-${formatTokens(max)}`
}

function viewWindow(mode: ViewMode, anchor: Date): { from: string; to: string; granularity: CallLogGranularity } {
  const d = new Date(anchor)
  if (mode === 'day') {
    const from = new Date(d); from.setHours(0, 0, 0, 0)
    const to = new Date(d); to.setHours(23, 59, 59, 999)
    return { from: from.toISOString(), to: to.toISOString(), granularity: 'hour' }
  }
  if (mode === 'week') {
    const day = d.getDay()
    const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7)); mon.setHours(0, 0, 0, 0)
    const sun = new Date(mon); sun.setDate(mon.getDate() + 7)
    return { from: mon.toISOString(), to: sun.toISOString(), granularity: 'day' }
  }
  // month
  const from = new Date(d.getFullYear(), d.getMonth(), 1)
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 1)
  return { from: from.toISOString(), to: to.toISOString(), granularity: 'day' }
}

function cloneModel(model: ModelDef): ModelDef {
  return {
    ...model,
    pricing: model.pricing.map((p) => ({ ...p })),
  }
}

export default function ModelDialog({ open, onUpdate, onClose }: Props) {
  const [tab, setTab] = useState<TabKey>('usage')
  const [models, setModels] = useState<ModelDef[]>([])
  const [bindings, setBindings] = useState<FeatureBinding[]>([])
  const [calls, setCalls] = useState<ModelCallLog[]>([])
  const [viewMode, setViewMode] = useState<ViewMode>('day')
  const [anchorDate, setAnchorDate] = useState<Date>(() => new Date())
  const [category, setCategory] = useState<ModelCategory | 'all'>('all')
  const [feature, setFeature] = useState<string>('all')
  const [modelId, setModelId] = useState<string>('all')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [editingModel, setEditingModel] = useState<ModelDef | null>(null)
  const [apiKeys, setApiKeys] = useState<ModelApiKey[]>([])
  const [apiKeyOpen, setApiKeyOpen] = useState(false)
  const [creatingApiKey, setCreatingApiKey] = useState(false)
  const [newApiKeyLabel, setNewApiKeyLabel] = useState('百炼 API Key')
  const [newApiKeyValue, setNewApiKeyValue] = useState('')
  const [pendingDeleteKey, setPendingDeleteKey] = useState<ModelApiKey | null>(null)
  const [freeQuotas, setFreeQuotas] = useState<ModelFreeQuota[]>([])
  const [scanningQuota, setScanningQuota] = useState(false)
  const [bailianName, setBailianName] = useState<string | null>(null)
  const [openingBailian, setOpeningBailian] = useState(false)
  const [pollingBailianLogin, setPollingBailianLogin] = useState(false)
  const bailianLoginPollRef = useRef<number | null>(null)
  const [quotaProgress, setQuotaProgress] = useState<BailianQuotaProgress | null>(null)
  const [quotaLogs, setQuotaLogs] = useState<BailianQuotaLog[]>([])
  const [quotaModalOpen, setQuotaModalOpen] = useState(false)

  const loadBase = useCallback(async () => {
    setErr(null)
    try {
      const [modelRows, bindingRows, keyRows, quotaRows] = await Promise.all([
        invoke<ModelDef[]>('list_models'),
        invoke<FeatureBinding[]>('list_feature_bindings'),
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
      const apiKeyArg = apiKeys.find((k) => k.is_active)?.id ?? null
      const callRows = await invoke<ModelCallLog[]>('query_call_log', {
        timeFrom: from,
        timeTo: to,
        feature: featureArg,
        modelId: modelArg,
        apiKeyId: apiKeyArg,
        limit: null,
      })
      setCalls(callRows)
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [apiKeys, anchorDate, viewMode, feature, modelId])

  useEffect(() => {
    if (!open) return
    loadBase()
  }, [open, loadBase])

  useEffect(() => {
    if (!open) return
    const onBindingUpdated = () => { void loadBase() }
    window.addEventListener('model-feature-binding-updated', onBindingUpdated)
    return () => window.removeEventListener('model-feature-binding-updated', onBindingUpdated)
  }, [open, loadBase])

  useEffect(() => {
    if (!open) return
    loadUsage()
  }, [open, loadUsage])

  const refreshBailianAccount = useCallback(async (): Promise<string | null> => {
    try {
      const account = await getBailianAccount()
      const name = normalizeBailianName(account.display_name)
      if (account.is_login && name) {
        setBailianName(name)
        try { localStorage.setItem('bailian.displayName', name) } catch {}
        return name
      } else if (!account.is_login) {
        setBailianName(null)
      }
      return null
    } catch {
      return null
    }
  }, [])

  const stopBailianLoginPolling = useCallback(() => {
    if (bailianLoginPollRef.current !== null) {
      window.clearInterval(bailianLoginPollRef.current)
      bailianLoginPollRef.current = null
    }
    setPollingBailianLogin(false)
  }, [])

  const startBailianLoginPolling = useCallback(() => {
    if (bailianLoginPollRef.current !== null) return
    setPollingBailianLogin(true)
    setBailianName(null)

    const tick = async () => {
      const name = await refreshBailianAccount()
      if (name) {
        stopBailianLoginPolling()
        setSaved(`百炼已登录：${name}`)
        window.setTimeout(() => setSaved(null), 1800)
      }
    }

    window.setTimeout(() => { void tick() }, 700)
    bailianLoginPollRef.current = window.setInterval(() => {
      void tick()
    }, 1800)
  }, [refreshBailianAccount, stopBailianLoginPolling])

  useEffect(() => {
    if (open) return
    stopBailianLoginPolling()
  }, [open, stopBailianLoginPolling])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const modelPricingMap = useMemo(() => {
    return new Map(models.map((m) => [m.id, m.pricing]))
  }, [models])

  const usageTotals = useMemo(() => {
    return calls.reduce((acc, c) => {
      acc.calls += 1
      acc.promptText += c.prompt_text_tokens
      acc.promptImage += c.prompt_image_tokens
      acc.promptVideo += c.prompt_video_tokens
      acc.promptAudio += c.prompt_audio_tokens
      acc.completionText += c.completion_text_tokens
      acc.completionAudio += c.completion_audio_tokens
      acc.cost += c.cost_cny ?? 0
      acc.saved += c.free_quota_saved_cny ?? 0
      const bd = breakdownCallCost(c, modelPricingMap.get(c.model_id))
      const grossCost = [...bd.inputs, ...bd.outputs].reduce((s, p) => s + p.cost, 0)
      const netRatio = grossCost > 0 ? Math.max(0, Math.min(1, ((c.cost_cny ?? grossCost) / grossCost))) : 1
      for (const p of bd.inputs) {
        const netCost = p.cost * netRatio
        if (p.label === '文本') acc.costPromptText += netCost
        else if (p.label === '图像') acc.costPromptImage += netCost
        else if (p.label === '视频') acc.costPromptVideo += netCost
        else if (p.label === '音频') acc.costPromptAudio += netCost
      }
      for (const p of bd.outputs) {
        const netCost = p.cost * netRatio
        if (p.label === '文本') acc.costCompletionText += netCost
        else if (p.label === '音频') acc.costCompletionAudio += netCost
      }
      return acc
    }, {
      calls: 0,
      promptText: 0, promptImage: 0, promptVideo: 0, promptAudio: 0,
      completionText: 0, completionAudio: 0,
      cost: 0,
      saved: 0,
      costPromptText: 0, costPromptImage: 0, costPromptVideo: 0, costPromptAudio: 0,
      costCompletionText: 0, costCompletionAudio: 0,
    })
  }, [calls, modelPricingMap])

  const bindingByFeature = useMemo(() => {
    return new Map(bindings.map((b) => [b.feature, b.model_id]))
  }, [bindings])

  const activeApiKey = useMemo(() => {
    return apiKeys.find((k) => k.is_active) ?? null
  }, [apiKeys])

  const freeQuotaByModel = useMemo(() => {
    return new Map(freeQuotas.map((q) => [q.model_id, q]))
  }, [freeQuotas])

  const openBailian = useCallback(async () => {
    setErr(null)
    setOpeningBailian(true)
    try {
      await openBailianLogin()
      startBailianLoginPolling()
    } catch (e) {
      setErr(String(e))
    } finally {
      setOpeningBailian(false)
    }
  }, [startBailianLoginPolling])

  const applyQuotaProgress = useCallback((event: BailianQuotaProgress) => {
    setQuotaProgress((prev) => ({ ...(prev ?? {}), ...event }))
    const modelId = event.model_id ?? ''
    const row = event.row
    const message = event.stage === 'model_start'
      ? `${event.index ?? '-'} / ${event.total ?? '-'} opening detail`
      : event.stage === 'model_done'
        ? `${event.index ?? '-'} / ${event.total ?? '-'} ${row?.raw_quota ?? (row ? `${formatTokens(row.remaining_tokens)} / ${formatTokens(row.total_tokens)}` : 'done')}`
        : event.stage === 'model_error'
          ? `${event.index ?? '-'} / ${event.total ?? '-'} ${event.error ?? row?.error_message ?? 'error'}`
          : event.stage === 'finish'
            ? `finished: OK ${event.ok ?? 0} / ERR ${event.failed ?? 0}`
            : event.stage === 'fatal'
              ? event.error ?? 'fatal error'
              : `start: ${event.total ?? 0} models`
    const color = event.stage === 'model_done' || event.stage === 'finish'
      ? theme.expGreen
      : event.stage === 'model_error' || event.stage === 'fatal'
        ? theme.dangerRed
        : theme.electricBlue
    setQuotaLogs((prev) => [{
      id: `scan-${event.stage}-${modelId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      stage: event.stage,
      modelId,
      message,
      color,
    }, ...prev].slice(0, 24))
  }, [])

  const drainQuotaProgress = useCallback(async () => {
    try {
      const events = await takeBailianQuotaProgress()
      for (const event of events) {
        if (event && typeof event === 'object' && 'stage' in event) {
          applyQuotaProgress(event as BailianQuotaProgress)
        }
      }
    } catch {
      // Progress is best-effort; the scan result path remains authoritative.
    }
  }, [applyQuotaProgress])

  const scanFreeQuota = useCallback(async () => {
    setErr(null)
    setScanningQuota(true)
    startBailianLoginPolling()
    setQuotaModalOpen(true)
    setQuotaProgress({ stage: 'start', total: models.length, scanned: 0, ok: 0, failed: 0 })
    setQuotaLogs([{
      id: `start-local-${Date.now()}`,
      stage: 'start',
      modelId: '',
      message: `准备扫描 ${models.length} 个模型；如未登录，请先在百炼窗口完成登录`,
      color: theme.electricBlue,
    }])
    await drainQuotaProgress()
    const progressTimer = window.setInterval(() => {
      void drainQuotaProgress()
    }, 500)
    try {
      const codes = models.map((m) => m.id)
      const rows = await scanBailianFreeQuota(codes)
      setFreeQuotas(rows)
      window.dispatchEvent(new CustomEvent('model-free-quota-updated'))
      void refreshBailianAccount()
      const failed = rows.filter((row) => row.error_message).length
      setQuotaProgress({ stage: 'finish', total: rows.length, scanned: rows.length, ok: rows.length - failed, failed })
      const finishLog: BailianQuotaLog = {
        id: `finish-local-${Date.now()}`,
        stage: 'finish',
        modelId: '',
        message: `扫描完成：OK ${rows.length - failed} / ERR ${failed}`,
        color: failed ? theme.warningOrange : theme.expGreen,
      }
      setQuotaLogs((prev) => [finishLog, ...prev].slice(0, 24))
      setSaved(`Free quota scanned: ${rows.length}`)
      setTimeout(() => setSaved(null), 1800)
    } catch (e) {
      const raw = String(e)
      const message = raw.includes('BAILIAN_NOT_LOGGED_IN')
        ? '请先登录百炼，登录完成后会自动识别，再重新扫描'
        : raw
      setErr(message)
      if (raw.includes('BAILIAN_NOT_LOGGED_IN')) {
        startBailianLoginPolling()
      }
      setQuotaProgress((prev) => ({ ...(prev ?? { total: models.length, scanned: 0, ok: 0, failed: 0 }), stage: 'fatal', error: message }))
      const fatalLog: BailianQuotaLog = {
        id: `scan-error-${Date.now()}`,
        stage: 'fatal',
        modelId: '',
        message,
        color: theme.dangerRed,
      }
      setQuotaLogs((prev) => [fatalLog, ...prev].slice(0, 18))
      setQuotaModalOpen(true)
    } finally {
      window.clearInterval(progressTimer)
      await drainQuotaProgress()
      setScanningQuota(false)
    }
  }, [drainQuotaProgress, models, refreshBailianAccount, startBailianLoginPolling])

  const startCreateApiKey = useCallback(() => {
    setNewApiKeyLabel(nextApiKeyLabel(apiKeys))
    setNewApiKeyValue('')
    setCreatingApiKey(true)
  }, [apiKeys])

  const activateApiKey = useCallback(async (key: ModelApiKey) => {
    setErr(null)
    try {
      await setActiveModelApiKey(key.id)
      onUpdate({
        dashscopeApiKey: key.api_key || null,
        openaiApiKey: key.api_key || null,
        omniApiKey: null,
        asrApiKey: null,
      })
      setSaved(`${key.label} 已切换`)
      setTimeout(() => setSaved(null), 1800)
      await loadBase()
      await loadUsage()
    } catch (e) {
      setErr(String(e))
    }
  }, [loadBase, loadUsage, onUpdate])

  const saveNewApiKey = useCallback(async () => {
    setErr(null)
    try {
      const key = await upsertModelApiKey({
        label: newApiKeyLabel.trim() || nextApiKeyLabel(apiKeys),
        api_key: newApiKeyValue,
        is_active: true,
      })
      onUpdate({
        dashscopeApiKey: key.api_key || null,
        openaiApiKey: key.api_key || null,
        omniApiKey: null,
        asrApiKey: null,
      })
      setNewApiKeyLabel(nextApiKeyLabel([...apiKeys, key]))
      setNewApiKeyValue('')
      setCreatingApiKey(false)
      setSaved(`${key.label} 已保存并切换`)
      setTimeout(() => setSaved(null), 1800)
      await loadBase()
      await loadUsage()
    } catch (e) {
      setErr(String(e))
    }
  }, [apiKeys, loadBase, loadUsage, newApiKeyLabel, newApiKeyValue, onUpdate])

  const requestDeleteApiKey = useCallback((key: ModelApiKey) => {
    setPendingDeleteKey(key)
  }, [])

  const confirmDeleteApiKey = useCallback(async () => {
    const key = pendingDeleteKey
    if (!key) return
    setPendingDeleteKey(null)
    setErr(null)
    try {
      await deleteModelApiKey(key.id)
      setSaved(`${key.label} 已删除`)
      setTimeout(() => setSaved(null), 1800)
      await loadBase()
      await loadUsage()
    } catch (e) {
      setErr(String(e))
    }
  }, [loadBase, loadUsage, pendingDeleteKey])

  const saveModel = useCallback(async (model: ModelDef) => {
    setErr(null)
    try {
      await invoke('upsert_model', { def: model })
      setSaved(`${model.id} 已保存`)
      setTimeout(() => setSaved(null), 1800)
      setEditingModel(null)
      await loadBase()
    } catch (e) {
      setErr(String(e))
    }
  }, [loadBase])

  const deleteModel = useCallback(async (id: string) => {
    setErr(null)
    try {
      await invoke('delete_model', { modelId: id })
      setSaved(`${id} 已删除`)
      setTimeout(() => setSaved(null), 1800)
      await loadBase()
      await loadUsage()
    } catch (e) {
      setErr(String(e))
    }
  }, [loadBase, loadUsage])

  const addModel = useCallback(() => {
    const cat: ModelCategory = category === 'all' ? 'text' : category
    const id = `custom-model-${Date.now()}`
    setEditingModel({
      id,
      category: cat,
      provider: 'dashscope',
      display_name: '',
      modalities: cat === 'text' ? '["text"]' : '["text","image","video","audio"]',
      context_window: null,
      notes: '自定义模型',
      deprecated: false,
      updated_at: new Date().toISOString(),
      pricing: [emptyTier()],
    })
    setCategory(cat)
    setTab('library')
  }, [category])

  const editModel = useCallback((model: ModelDef) => {
    setEditingModel(cloneModel(model))
  }, [])

  const setBinding = useCallback(async (featureName: string, nextModelId: string) => {
    setErr(null)
    try {
      await invoke('set_feature_binding', { feature: featureName, modelId: nextModelId })
      window.dispatchEvent(new CustomEvent('model-feature-binding-updated', {
        detail: { feature: featureName, modelId: nextModelId },
      }))
      setSaved(`${FEATURE_LABEL.get(featureName) ?? featureName} 已绑定`)
      setTimeout(() => setSaved(null), 1800)
      await loadBase()
    } catch (e) {
      setErr(String(e))
    }
  }, [loadBase])


  if (!open) return null

  return (
    <>
      <style>{`
        @keyframes model-dialog-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes model-dialog-pop { from { opacity: 0; transform: translate(-50%, -50%) scale(0.98); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
        @keyframes model-dialog-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        .model-dialog-icon-btn {
          background: rgba(0,229,255,0.05);
          border: 1px solid ${theme.hudFrameSoft};
          color: ${theme.textSecondary};
          width: 24px; height: 24px;
          box-sizing: border-box;
          display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer;
          clip-path: ${hud.chamfer8};
          -webkit-clip-path: ${hud.chamfer8};
          transition: all 0.15s ease;
        }
        .model-dialog-icon-btn:hover:not(:disabled) { color: ${theme.electricBlue}; border-color: ${theme.electricBlue}; box-shadow: 0 0 8px ${theme.electricBlue}55; }
        .model-dialog-icon-btn:disabled { opacity: 0.32; cursor: not-allowed; filter: grayscale(0.7); }
        .model-input::placeholder { color: ${theme.textMuted}; }

        /* ── HUD 卡片体系 ── */
        .hud-card {
          position: relative;
          background:
            linear-gradient(180deg, rgba(4,12,26,0.82) 0%, rgba(2,8,20,0.74) 100%);
          border: 1px solid rgba(0,229,255,0.18);
          padding: 12px 14px 12px 16px;
          clip-path: ${hud.chamfer8};
          -webkit-clip-path: ${hud.chamfer8};
          transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
          overflow: hidden;
        }
        .hud-card::after {
          /* 微弱扫描线纹理（不抢戏） */
          content: '';
          position: absolute; inset: 0;
          background-image: repeating-linear-gradient(
            0deg, transparent 0 2px, rgba(0,229,255,0.025) 2px 3px
          );
          pointer-events: none;
          opacity: 0.55;
        }
        .hud-card:hover {
          border-color: rgba(0,229,255,0.45);
          box-shadow: 0 0 14px rgba(0,229,255,0.22), 0 0 28px rgba(0,229,255,0.08);
          background: linear-gradient(180deg, rgba(6,16,32,0.86) 0%, rgba(2,10,22,0.78) 100%);
        }
        .hud-card-stripe {
          position: absolute;
          left: 0; top: 8px; bottom: 8px;
          width: 2px;
          background: var(--accent, ${theme.electricBlue});
          box-shadow: 0 0 6px var(--accent, ${theme.electricBlue}), 0 0 12px var(--accent, ${theme.electricBlue});
          opacity: 0.6;
          transition: opacity 0.15s ease;
          z-index: 1;
        }
        .hud-card:hover .hud-card-stripe { opacity: 1; }
        .hud-card > * { position: relative; z-index: 2; }

        /* 卡片内"价格层"分组：去掉边框，用左侧色条 + 半透明深底 */
        .hud-tier {
          position: relative;
          padding: 8px 10px 8px 12px;
          background: rgba(0,4,12,0.4);
          border-left: 2px solid rgba(0,229,255,0.4);
          border-top: 1px solid rgba(255,255,255,0.04);
        }

        /* 价格小标签：彩色图标 + 数值，无边框 */
        .hud-pricetag {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 0;
          font-family: ${theme.fontMono};
          cursor: default;
        }

        /* 数值发光（用于卡片大数字） */
        .hud-num {
          font-family: ${theme.fontMono};
          font-weight: 800;
          letter-spacing: 0.02em;
          text-shadow: 0 0 8px var(--accent-soft, rgba(0,229,255,0.35));
        }
      `}</style>

      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 900,
          background: 'rgba(2, 6, 16, 0.84)',
          animation: 'model-dialog-in 0.16s ease-out',
        }}
      />

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(1100px, 92vw)',
          height: 'min(820px, 88vh)',
          zIndex: 901,
          display: 'flex',
          flexDirection: 'column',
          background: theme.hudFill,
          border: `1px solid ${theme.hudFrame}`,
          clipPath: hud.chamfer12,
          WebkitClipPath: hud.chamfer12,
          boxShadow: `0 24px 80px rgba(0,0,0,0.8), 0 0 60px ${theme.hudHalo}, inset 0 1px 0 rgba(255,255,255,0.04)`,
          animation: 'model-dialog-pop 0.18s ease-out',
          overflow: 'hidden',
        }}
      >
        <header style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <Boxes size={16} color={theme.electricBlue} style={{ filter: `drop-shadow(0 0 6px ${theme.electricBlue}AA)` }} />
            <span style={titleStyle}>模型调用与审计</span>
          </div>

          <Tooltip content="关闭 (Esc)">
            <button type="button" className="model-dialog-icon-btn" onClick={onClose}>
              <X size={13} />
            </button>
          </Tooltip>
        </header>

        <div style={tabBarStyle}>
          <TabButton active={tab === 'usage'} icon={<BarChart3 size={14} />} label="用量" onClick={() => setTab('usage')} />
          <TabButton active={tab === 'library'} icon={<Database size={14} />} label="模型库" onClick={() => setTab('library')} />
          <TabButton active={tab === 'bindings'} icon={<Link2 size={14} />} label="功能绑定" onClick={() => setTab('bindings')} />
          <div style={{ flex: 1 }} />
          {saved && <span style={statusStyle(theme.expGreen)}><Check size={12} />{saved}</span>}
          {err && <span style={statusStyle(theme.dangerRed)}>{err}</span>}
          <div style={{ position: 'relative' }}>
            <Tooltip content="API Key">
              <button type="button" onClick={() => setApiKeyOpen((v) => !v)} style={smallBtnStyle(activeApiKey ? theme.expGreen : theme.warningOrange)}>
                <KeyRound size={13} />
              </button>
            </Tooltip>
            {apiKeyOpen && (
              <ApiKeyPopover
                apiKeys={apiKeys}
                activeId={activeApiKey?.id ?? null}
                creating={creatingApiKey}
                newLabel={newApiKeyLabel}
                newValue={newApiKeyValue}
                onStartCreate={startCreateApiKey}
                onCancelCreate={() => setCreatingApiKey(false)}
                onNewLabel={setNewApiKeyLabel}
                onNewValue={setNewApiKeyValue}
                onSaveNew={saveNewApiKey}
                onActivate={activateApiKey}
                onDelete={requestDeleteApiKey}
              />
            )}
          </div>
          <Tooltip content="刷新数据">
            <button type="button" onClick={() => { loadBase(); loadUsage() }} style={smallBtnStyle(theme.electricBlue)}>
              <RefreshCw size={13} />
            </button>
          </Tooltip>
        </div>

        {quotaModalOpen && (scanningQuota || quotaLogs.length > 0) && createPortal(
          <BailianQuotaScanPanel
            progress={quotaProgress}
            logs={quotaLogs}
            scanning={scanningQuota}
            onClose={() => setQuotaModalOpen(false)}
          />,
          document.body
        )}

        <main
          className="model-dialog-scroll"
          style={{
            flex: 1,
            minHeight: 0,
            overflow: tab === 'usage' ? 'hidden' : 'auto',
            padding: 16,
            boxSizing: 'border-box',
          }}
        >
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
              allModels={models}
              modelPricingMap={modelPricingMap}
              onViewMode={setViewMode}
              onAnchorDate={setAnchorDate}
              onFeature={setFeature}
              onModel={setModelId}
            />
          )}

          {tab === 'library' && (
            <LibraryTab
              category={category === 'all' ? 'text' : category}
              models={models.filter((m) => m.category === (category === 'all' ? 'text' : category))}
              freeQuotaByModel={freeQuotaByModel}
              onCategory={setCategory}
              onAdd={addModel}
              onEdit={editModel}
              onDelete={deleteModel}
              onOpenBailian={openBailian}
              onScanFreeQuota={scanFreeQuota}
              onOpenQuotaPanel={() => setQuotaModalOpen(true)}
              onOpenBailianDetail={(modelCode) => {
                setErr(null)
                startBailianLoginPolling()
                void openBailianModelDetail(modelCode).catch((e) => setErr(String(e)))
              }}
              scanningQuota={scanningQuota}
              hasQuotaLogs={quotaLogs.length > 0}
              bailianName={bailianName}
              openingBailian={openingBailian}
              pollingBailianLogin={pollingBailianLogin}
              canScanQuota={models.length > 0}
            />
          )}

          {tab === 'bindings' && (
            <BindingsTab
              specs={FEATURE_SPECS}
              models={models}
              freeQuotaByModel={freeQuotaByModel}
              bindingByFeature={bindingByFeature}
              onBind={setBinding}
            />
          )}
        </main>
      </div>

      {pendingDeleteKey && (
        <ConfirmDeleteApiKey
          keyLabel={pendingDeleteKey.label}
          onCancel={() => setPendingDeleteKey(null)}
          onConfirm={confirmDeleteApiKey}
        />
      )}

      {editingModel && (
        <ModelEditor
          initial={editingModel}
          isNew={!models.some((m) => m.id === editingModel.id)}
          onCancel={() => setEditingModel(null)}
          onSave={saveModel}
        />
      )}
    </>
  )
}

function ConfirmDeleteApiKey({
  keyLabel,
  onCancel,
  onConfirm,
}: {
  keyLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.72)',
        animation: 'model-dialog-in 0.14s ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.hudFillDeep,
          border: `1px solid ${theme.dangerRed}66`,
          boxShadow: `0 0 32px ${theme.dangerRed}44, inset 0 0 16px rgba(0,0,0,0.4)`,
          borderRadius: 2,
          padding: '24px 28px 22px',
          minWidth: 380,
          maxWidth: 460,
          fontFamily: theme.fontMono,
          color: theme.textPrimary,
          clipPath: 'polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))',
        }}
      >
        <div style={{
          fontFamily: theme.fontDisplay,
          fontSize: 12,
          letterSpacing: '0.12em',
          color: theme.dangerRed,
          textShadow: `0 0 8px ${theme.dangerRed}`,
          marginBottom: 14,
          textTransform: 'uppercase',
        }}>
          DELETE API KEY
        </div>

        <div style={{ fontSize: 13, color: theme.textPrimary, marginBottom: 8, lineHeight: 1.6 }}>
          确定删除「{keyLabel}」吗？
        </div>
        <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 22, lineHeight: 1.65 }}>
          删除此 API Key 后，会同时删除归属此 Key 的所有用量记录，此操作不可恢复。
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={onCancel} style={confirmBtnStyle(theme.electricBlue)}>取消</button>
          <button onClick={onConfirm} style={confirmBtnStyle(theme.dangerRed)}>确定删除</button>
        </div>
      </div>
    </div>
  )
}

function confirmBtnStyle(color: string): CSSProperties {
  return {
    flex: 1,
    padding: '9px 0',
    background: 'transparent',
    border: `1px solid ${color}`,
    borderRadius: 2,
    color,
    fontFamily: 'inherit',
    fontSize: 12,
    letterSpacing: '0.06em',
    cursor: 'pointer',
    transition: 'background 0.15s',
  }
}

function BailianQuotaScanPanel({
  progress,
  logs,
  scanning,
  onClose,
}: {
  progress: BailianQuotaProgress | null
  logs: BailianQuotaLog[]
  scanning: boolean
  onClose: () => void
}) {
  const total = progress?.total ?? 0
  const scanned = progress?.scanned ?? (progress?.index ? Math.max(0, progress.index - 1) : 0)
  const pct = total > 0 ? Math.max(0, Math.min(100, (scanned / total) * 100)) : 0
  const current = progress?.model_id ?? logs.find((l) => l.modelId)?.modelId ?? ''
  const ok = progress?.ok ?? 0
  const failed = progress?.failed ?? 0

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'rgba(0,0,0,0.46)',
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="百炼额度扫描"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, calc(100vw - 32px))',
          maxHeight: 'min(620px, calc(100vh - 48px))',
          display: 'grid',
          gridTemplateRows: 'auto auto minmax(0, 1fr)',
          gap: 14,
          padding: 16,
          border: `1px solid ${theme.hudFrame}`,
          background: 'rgba(6,13,22,0.98)',
          boxShadow: `0 0 0 1px ${theme.glassBorder}, 0 24px 80px rgba(0,0,0,0.55)`,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <RefreshCw
            size={15}
            color={scanning ? theme.electricBlue : theme.textMuted}
            style={scanning ? { animation: 'model-dialog-spin 1s linear infinite' } : undefined}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: theme.textPrimary, fontWeight: 900, fontSize: 14 }}>百炼额度扫描</div>
            <div style={{ color: theme.textMuted, fontFamily: theme.fontMono, fontSize: 10, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {current || (scanning ? '等待百炼页面回传状态' : '扫描结果')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255,255,255,0.04)',
              border: `1px solid ${theme.glassBorder}`,
              color: theme.textSecondary,
              cursor: 'pointer',
            }}
          >
            <X size={14} />
          </button>
        </header>

        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontFamily: theme.fontMono, fontSize: 11 }}>
            <span style={{ color: theme.textMuted }}>{scanned}/{total}</span>
            <span style={{ color: theme.expGreen }}>OK {ok}</span>
            <span style={{ color: failed > 0 ? theme.dangerRed : theme.textMuted }}>ERR {failed}</span>
          </div>
          <div style={{ height: 5, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: theme.electricBlue, transition: 'width 180ms ease' }} />
          </div>
        </div>

        <div style={{
          display: 'grid',
          gap: 7,
          overflow: 'auto',
          paddingRight: 2,
        }}>
          {logs.length === 0 ? (
            <div style={{ color: theme.textMuted, fontSize: 12 }}>
              等待百炼页面开始回传扫描状态
            </div>
          ) : logs.map((log) => (
            <div key={log.id} style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(120px, 0.9fr) minmax(0, 1.4fr)',
              gap: 10,
              alignItems: 'center',
              minHeight: 30,
              padding: '6px 8px',
              border: `1px solid ${theme.hudFrameSoft}`,
              background: 'rgba(255,255,255,0.025)',
            }}>
              <span style={{
                color: log.color,
                fontFamily: theme.fontMono,
                fontSize: 10,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {log.modelId || log.stage}
              </span>
              <span style={{
                color: theme.textSecondary,
                fontSize: 12,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {log.message}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function UsageTab({
  calls,
  loading,
  totals,
  viewMode,
  anchorDate,
  feature,
  modelId,
  models,
  freeQuotaByModel,
  allModels,
  modelPricingMap,
  activeKeyLabel,
  onViewMode,
  onAnchorDate,
  onFeature,
  onModel,
}: {
  calls: ModelCallLog[]
  loading: boolean
  totals: {
    calls: number
    promptText: number; promptImage: number; promptVideo: number; promptAudio: number
    completionText: number; completionAudio: number
    cost: number
    saved: number
    costPromptText: number; costPromptImage: number; costPromptVideo: number; costPromptAudio: number
    costCompletionText: number; costCompletionAudio: number
  }
  viewMode: ViewMode
  anchorDate: Date
  feature: string
  modelId: string
  models: ModelDef[]
  freeQuotaByModel: Map<string, ModelFreeQuota>
  allModels: ModelDef[]
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
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(320px, 0.8fr)', gap: 14, height: '100%', minHeight: 0 }}>
      <section style={{ ...panelStyle, minHeight: 0, overflow: 'hidden' }}>
        <div style={panelHeaderStyle}>
          <div>
            <div style={sectionTitleStyle}>调用用量</div>
            <div style={mutedStyle}>
              {activeKeyLabel ? <>当前 Key：<span style={{ color: theme.textPrimary, fontWeight: 700 }}>{activeKeyLabel}</span></> : '未选择 API Key'}
            </div>
          </div>
          {loading && <span style={statusStyle(theme.electricBlue)}>刷新中</span>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
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
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, margin: '12px 0' }}>
          <Metric label="调用" value={String(totals.calls)} />
          <MetricBreakdown
            label="输入"
            total={totals.promptText + totals.promptImage + totals.promptVideo + totals.promptAudio}
            accent={theme.electricBlue}
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
            accent={theme.warningOrange}
            parts={[
              { label: '文本', value: totals.completionText, cost: totals.costCompletionText },
              { label: '音频', value: totals.completionAudio, cost: totals.costCompletionAudio },
            ]}
          />
          <Metric
            label="成本"
            value={formatCny(totals.cost)}
            accent={theme.dangerRed}
            note={totals.saved > 0 ? `免费额度节省 ${formatCny(totals.saved)}` : undefined}
          />
        </div>

        <StackedBarChart calls={calls} viewMode={viewMode} anchorDate={anchorDate} />
      </section>

      <section style={{ ...panelStyle, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={panelHeaderStyle}>
          <div>
            <div style={sectionTitleStyle}>调用明细</div>
            <div style={mutedStyle}>共 {calls.length} 条</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
          <HudSelect
            value={feature}
            options={[
              { value: 'all', label: '全部功能' },
              ...FEATURE_SPECS.map((f) => ({ value: f.feature, label: f.label, hint: f.hint })),
            ]}
            onChange={onFeature}
          />
          <HudSelect
            value={modelId}
            options={modelChoices}
            onChange={onModel}
            popupWidth={MODEL_SELECT_POPUP_WIDTH}
          />
        </div>

        <div className="model-dialog-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 2 }}>
          {calls.length === 0 ? (
            <Empty text={allModels.length === 0 ? '模型库还没有初始化' : '暂无调用记录'} />
          ) : (
            <>
              {calls.length > 100 && (
                <div style={{ fontSize: 10, color: theme.textMuted, textAlign: 'center', padding: '4px 0 8px', fontFamily: theme.fontMono }}>
                  显示最近 100 条（共 {calls.length} 条）
                </div>
              )}
              {calls.slice(0, 100).map((call) => (
                <CallRow key={call.id} call={call} apiKeyLabel={null} pricing={modelPricingMap.get(call.model_id)} />
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  )
}

// ── 日历 Popover ──

const CAL_WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function calDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function buildMonthGrid(y: number, m: number): Date[] {
  const first = new Date(y, m, 1)
  const dow = (first.getDay() + 6) % 7
  const start = new Date(y, m, 1 - dow)
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}

function anchorLabel(viewMode: ViewMode, d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  if (viewMode === 'day') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (viewMode === 'week') {
    const { from, to } = viewWindow('week', d)
    const f = new Date(from); const t = new Date(to); t.setDate(t.getDate() - 1)
    return `${f.getMonth() + 1}/${pad(f.getDate())} – ${t.getMonth() + 1}/${pad(t.getDate())}`
  }
  return `${d.getFullYear()} · ${pad(d.getMonth() + 1)}`
}

function UsageCalendar({ viewMode, anchorDate, onSelect }: {
  viewMode: ViewMode
  anchorDate: Date
  onSelect: (d: Date) => void
}) {
  const [open, setOpen] = useState(false)
  const [calMonth, setCalMonth] = useState(() => ({ y: anchorDate.getFullYear(), m: anchorDate.getMonth() }))
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [dayCosts, setDayCosts] = useState<Map<string, number>>(new Map())
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // 计算弹出位置（居中于触发器下方）
  useEffect(() => {
    if (!open) return
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (r) setPos({ left: Math.round(r.left + r.width / 2), top: Math.round(r.bottom + 6) })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  // 外部点击关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // 打开时拉取当前展示月的每日成本
  useEffect(() => {
    if (!open) return
    const from = new Date(calMonth.y, calMonth.m, 1).toISOString()
    const to = new Date(calMonth.y, calMonth.m + 1, 1).toISOString()
    invoke<CallLogBucket[]>('aggregate_call_log', {
      timeFrom: from, timeTo: to, granularity: 'day',
      feature: null, modelId: null, apiKeyId: null,
    }).then((rows) => {
      const m = new Map<string, number>()
      for (const r of rows) m.set(r.bucket.slice(0, 10), r.cost_cny_total)
      setDayCosts(m)
    }).catch(() => {})
  }, [open, calMonth])

  // anchorDate 变了同步月份
  useEffect(() => {
    setCalMonth({ y: anchorDate.getFullYear(), m: anchorDate.getMonth() })
  }, [anchorDate])

  const step = (delta: number) => {
    const d = new Date(anchorDate)
    if (viewMode === 'day') d.setDate(d.getDate() + delta)
    else if (viewMode === 'week') d.setDate(d.getDate() + delta * 7)
    else d.setMonth(d.getMonth() + delta)
    onSelect(d)
  }

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }, [])
  const cells = useMemo(() => buildMonthGrid(calMonth.y, calMonth.m), [calMonth])

  const isSelected = (d: Date): boolean => {
    if (viewMode === 'day') return calDayKey(d) === calDayKey(anchorDate)
    if (viewMode === 'week') {
      const { from, to } = viewWindow('week', anchorDate)
      return d >= new Date(from) && d < new Date(to)
    }
    return d.getFullYear() === anchorDate.getFullYear() && d.getMonth() === anchorDate.getMonth()
  }

  // 月成本热力色（有成本时淡红底）
  const costHeatColor = (cost: number): string => {
    if (cost <= 0) return 'transparent'
    const intensity = Math.min(1, cost / 2)
    return `rgba(255,68,68,${(intensity * 0.25).toFixed(2)})`
  }

  return (
    <>
      <style>{`
        .ucal-arrow {
          display:flex; align-items:center; justify-content:center;
          width:26px; height:26px;
          background:transparent;
          border:1px solid ${theme.glassBorder};
          color:${theme.textSecondary};
          cursor:pointer; border-radius:3px;
          transition:all 0.12s ease;
        }
        .ucal-arrow:hover { color:${theme.electricBlue}; border-color:${theme.hudFrame}; box-shadow:0 0 6px ${theme.electricBlue}55; }
        .ucal-trigger {
          display:inline-flex; align-items:center; gap:5px;
          padding:4px 12px; min-width:140px; justify-content:center;
          background:${theme.glass}; border:1px solid ${theme.glassBorder};
          color:${theme.electricBlue};
          font-family:${theme.fontMono}; font-size:12px; font-weight:700; letter-spacing:0.08em;
          cursor:pointer; border-radius:3px;
          transition:all 0.12s ease;
          text-shadow:0 0 6px ${theme.electricBlue}66;
        }
        .ucal-trigger:hover { background:${theme.glassHover}; border-color:${theme.hudFrame}; box-shadow:0 0 8px ${theme.electricBlue}33; }
        .ucal-cell {
          position:relative; height:36px;
          display:flex; flex-direction:column; align-items:center; justify-content:center;
          padding-top:2px; gap:1px;
          font-family:${theme.fontMono}; font-size:11px; font-weight:600;
          background:transparent; border:1px solid transparent;
          color:${theme.textPrimary}; cursor:pointer;
          transition:background 0.1s, border-color 0.1s;
          border-radius:3px;
        }
        .ucal-cell:hover { background:${theme.glassHover}; border-color:${theme.glassBorder}; }
        .ucal-cell.muted { color:${theme.textMuted}; }
        .ucal-cell.today { color:${theme.electricBlue}; text-shadow:0 0 6px ${theme.electricBlue}AA; }
        .ucal-cell.selected {
          background:rgba(0,229,255,0.15); border-color:${theme.electricBlue};
          color:${theme.electricBlue}; text-shadow:0 0 8px ${theme.electricBlue}AA;
          box-shadow:0 0 10px ${theme.electricBlue}44, inset 0 0 6px rgba(0,229,255,0.1);
        }
        .ucal-cost { font-size:8px; color:${theme.dangerRed}; font-weight:700; letter-spacing:0; line-height:1; }
        .ucal-nav {
          display:flex; align-items:center; justify-content:center;
          width:22px; height:22px;
          background:transparent; border:1px solid ${theme.glassBorder};
          color:${theme.textSecondary}; cursor:pointer; border-radius:3px;
          transition:all 0.12s ease;
        }
        .ucal-nav:hover { color:${theme.electricBlue}; border-color:${theme.hudFrame}; box-shadow:0 0 6px ${theme.electricBlue}55; }
        @keyframes ucal-pop {
          from { opacity:0; transform:translate(-50%, -4px) scale(0.97); }
          to   { opacity:1; transform:translate(-50%, 0) scale(1); }
        }
      `}</style>

      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <button className="ucal-arrow" onClick={() => step(-1)}><ChevronLeft size={13} /></button>
        <button ref={triggerRef} className="ucal-trigger" onClick={() => setOpen((v) => !v)}>
          {anchorLabel(viewMode, anchorDate)}
          <ChevronDown size={11} style={{ opacity: 0.6 }} />
        </button>
        <button className="ucal-arrow" onClick={() => step(1)}><ChevronRight size={13} /></button>
      </div>

      {open && pos && createPortal(
        <div ref={popRef} style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          transform: 'translateX(-50%)',
          zIndex: 1200,
          width: viewMode === 'month' ? 200 : 268,
          padding: 12,
          background: theme.hudFill,
          border: `1px solid ${theme.hudFrame}`,
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          clipPath: hud.chamfer8,
          boxShadow: `0 8px 32px rgba(0,0,0,0.7), 0 0 24px ${theme.hudHalo}, inset 0 1px 0 rgba(255,255,255,0.04)`,
          animation: 'ucal-pop 0.14s ease-out',
        }}>
          {/* 扫描线 */}
          <div style={{ position:'absolute', inset:0, pointerEvents:'none', background: hud.scanlines, opacity:0.5, clipPath: hud.chamfer8 }} />

          {/* 月份导航 */}
          <div style={{ position:'relative', display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <button className="ucal-nav" onClick={() => setCalMonth(({ y, m }) => m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 })}>
              <ChevronLeft size={12} />
            </button>
            <span style={{ fontFamily: theme.fontDisplay, fontSize: 12, fontWeight: 700, letterSpacing: 2, color: theme.electricBlue, textShadow: `0 0 8px ${theme.electricBlue}88` }}>
              {calMonth.y} · {String(calMonth.m + 1).padStart(2, '0')}
            </span>
            <button className="ucal-nav" onClick={() => setCalMonth(({ y, m }) => m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 })}>
              <ChevronRight size={12} />
            </button>
          </div>

          {viewMode === 'month' ? (
            <div style={{ position:'relative', display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:4 }}>
              {Array.from({ length: 12 }, (_, mi) => {
                const sel = anchorDate.getFullYear() === calMonth.y && anchorDate.getMonth() === mi
                const monthCost = Array.from(dayCosts.entries())
                  .filter(([k]) => k.startsWith(`${calMonth.y}-${String(mi + 1).padStart(2, '0')}`))
                  .reduce((s, [, v]) => s + v, 0)
                return (
                  <button
                    key={mi}
                    className={`ucal-cell${sel ? ' selected' : ''}`}
                    style={{ height: 36, paddingTop: 4 }}
                    onClick={() => { onSelect(new Date(calMonth.y, mi, 1)); setOpen(false) }}
                  >
                    <span>{mi + 1} 月</span>
                    {monthCost > 0 && <span className="ucal-cost">{formatCny(monthCost)}</span>}
                  </button>
                )
              })}
            </div>
          ) : (
            <div style={{ position:'relative' }}>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:2, marginBottom:4, paddingBottom:5, borderBottom:`1px solid ${theme.glassBorder}` }}>
                {CAL_WEEK_LABELS.map((w, i) => (
                  <div key={w} style={{ textAlign:'center', fontSize:9, fontWeight:700, letterSpacing:1, color: i >= 5 ? theme.shadowPurple : theme.textMuted, fontFamily: theme.fontBody }}>
                    {w}
                  </div>
                ))}
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:2 }}>
                {cells.map((d, i) => {
                  const isCurMonth = d.getMonth() === calMonth.m
                  const isToday = d.getTime() === today.getTime()
                  const sel = isSelected(d)
                  const cost = dayCosts.get(calDayKey(d)) ?? 0
                  const cls = ['ucal-cell', !isCurMonth && 'muted', isToday && 'today', sel && 'selected'].filter(Boolean).join(' ')
                  return (
                    <button
                      key={i}
                      className={cls}
                      style={{ background: sel ? undefined : costHeatColor(cost) }}
                      onClick={() => { onSelect(new Date(d)); setOpen(false) }}
                    >
                      <span>{d.getDate()}</span>
                      {cost > 0 && isCurMonth && <span className="ucal-cost">{formatCny(cost)}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

// ── 竖向堆叠柱状图 ──

type BarMetric = 'cost' | 'tokens' | 'calls'
type BarGroup = 'feature' | 'model'

const BAR_PALETTE = [
  '#00E5FF', '#FF9933', '#00FF88', '#FF4444', '#7DF9FF',
  '#7000FF', '#FFD700', '#FF69B4', '#00CED1', '#FFA500',
]

function StackedBarChart({ calls, viewMode, anchorDate }: {
  calls: ModelCallLog[]
  viewMode: ViewMode
  anchorDate: Date
}) {
  const [metric, setMetric] = useState<BarMetric>('cost')
  const [group, setGroup] = useState<BarGroup>('feature')
  const [hoverBucket, setHoverBucket] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  const callValue = useCallback((c: ModelCallLog): number => {
    if (metric === 'calls') return 1
    if (metric === 'tokens') return c.prompt_text_tokens + c.prompt_image_tokens + c.prompt_video_tokens + c.prompt_audio_tokens + c.completion_text_tokens + c.completion_audio_tokens
    return c.cost_cny ?? 0
  }, [metric])

  // 生成时间桶列表（按 viewMode 生成完整序列，确保空桶也显示）
  const bucketKeys = useMemo((): string[] => {
    const pad = (n: number) => String(n).padStart(2, '0')
    const localDay = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const localHour = (d: Date) =>
      `${localDay(d)}T${pad(d.getHours())}`

    const keys: string[] = []
    if (viewMode === 'day') {
      const base = new Date(anchorDate); base.setHours(0, 0, 0, 0)
      for (let h = 0; h < 24; h++) {
        const d = new Date(base); d.setHours(h)
        keys.push(localHour(d))
      }
    } else {
      const { from, to } = viewWindow(viewMode, anchorDate)
      const cur = new Date(from)
      while (cur < new Date(to)) {
        keys.push(localDay(cur))
        cur.setDate(cur.getDate() + 1)
      }
    }
    return keys
  }, [viewMode, anchorDate])

  // 所有分层 key
  const layerKeys = useMemo(() => {
    const s = new Set<string>()
    for (const c of calls) s.add(group === 'feature' ? c.feature : c.model_id)
    return Array.from(s)
  }, [calls, group])

  const keyColor = useMemo(() => {
    const m = new Map<string, string>()
    layerKeys.forEach((k, i) => m.set(k, BAR_PALETTE[i % BAR_PALETTE.length]))
    return m
  }, [layerKeys])

  // bucketKey(call) → 本地时间 key，与 bucketKeys 格式一致
  const callBucketKey = useCallback((c: ModelCallLog): string => {
    const d = new Date(c.started_at)
    const pad = (n: number) => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    return viewMode === 'day' ? `${day}T${pad(d.getHours())}` : day
  }, [viewMode])

  // 构建 bucketKey → layerKey → value
  const data = useMemo(() => {
    const map = new Map<string, Map<string, number>>()
    for (const bk of bucketKeys) map.set(bk, new Map())
    for (const c of calls) {
      const bk = callBucketKey(c)
      const lk = group === 'feature' ? c.feature : c.model_id
      const inner = map.get(bk)
      if (inner) inner.set(lk, (inner.get(lk) ?? 0) + callValue(c))
    }
    return map
  }, [bucketKeys, calls, group, callBucketKey, callValue])

  const maxBarVal = useMemo(() => {
    let m = 0
    for (const inner of data.values()) {
      const sum = Array.from(inner.values()).reduce((s, v) => s + v, 0)
      if (sum > m) m = sum
    }
    return m || 1
  }, [data])

  // 图例汇总
  const legendTotals = useMemo(() => {
    const m = new Map<string, number>()
    for (const inner of data.values())
      for (const [k, v] of inner) m.set(k, (m.get(k) ?? 0) + v)
    return m
  }, [data])

  const formatVal = (v: number) => metric === 'cost' ? formatCny(v) : metric === 'tokens' ? formatTokens(v) : String(v)

  const BAR_HEIGHT = 240
  const TOP_LABEL_H = 18   // 柱顶标签预留高度
  const Y_AXIS_W = 54
  const X_LABEL_H = 16

  const bucketLabel = (bk: string): string => viewMode === 'day' ? bk.slice(11, 13) + 'h' : bk.slice(5)

  // 纵轴刻度：4 档，0/25%/50%/75%/100%
  const yTicks = [0.25, 0.5, 0.75, 1.0].map((frac) => ({
    frac,
    label: formatVal(maxBarVal * frac),
    top: Math.round((1 - frac) * BAR_HEIGHT),
  }))

  // 按月时每 5 天显示一个 X 标签；其他模式全显示
  const showXLabel = (bk: string): boolean => {
    if (viewMode !== 'month') return true
    const day = parseInt(bk.slice(8), 10)
    return day === 1 || day % 5 === 0
  }

  if (calls.length === 0) return <Empty text="暂无可绘制数据" tall />

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <Segmented value={metric} options={[
          { value: 'cost', label: '成本' },
          { value: 'tokens', label: 'Token' },
          { value: 'calls', label: '次数' },
        ]} onChange={(v) => setMetric(v as BarMetric)} />
        <Segmented value={group} options={[
          { value: 'feature', label: '按功能' },
          { value: 'model', label: '按模型' },
        ]} onChange={(v) => setGroup(v as BarGroup)} />
      </div>

      <div ref={chartRef} style={{ position: 'relative', borderTop: `1px solid ${theme.hudFrameSoft}`, background: 'rgba(255,255,255,0.02)', padding: '8px 8px 4px 0' }}>
        <div style={{ display: 'flex' }}>

          {/* ── 纵轴 ── */}
          <div style={{ width: Y_AXIS_W, flexShrink: 0, position: 'relative', height: BAR_HEIGHT + X_LABEL_H }}>
            {/* 纵轴线 */}
            <div style={{ position: 'absolute', right: 0, top: 0, width: 1, height: BAR_HEIGHT, background: 'rgba(255,255,255,0.15)' }} />
            {/* 刻度标签 */}
            {yTicks.map(({ frac, label, top }) => (
              <div key={frac} style={{
                position: 'absolute',
                right: 6,
                top: top - 6,
                fontSize: 10,
                fontFamily: theme.fontMono,
                color: theme.textSecondary,
                textAlign: 'right',
                whiteSpace: 'nowrap',
                lineHeight: '12px',
              }}>
                {label}
              </div>
            ))}
            <div style={{ position: 'absolute', right: 6, top: BAR_HEIGHT - 6, fontSize: 10, fontFamily: theme.fontMono, color: theme.textSecondary, textAlign: 'right', lineHeight: '12px' }}>0</div>
          </div>

          {/* ── 图表主体 ── */}
          <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
            {/* 水平网格线 */}
            {yTicks.map(({ frac, top }) => (
              <div key={frac} style={{
                position: 'absolute', left: 0, right: 0, top,
                height: 1,
                background: frac === 1 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)',
                pointerEvents: 'none',
              }} />
            ))}
            {/* X 轴线 */}
            <div style={{ position: 'absolute', left: 0, right: 0, top: BAR_HEIGHT, height: 1, background: 'rgba(255,255,255,0.2)', pointerEvents: 'none' }} />

            {/* 柱状图区 */}
            <div style={{ display: 'flex', gap: 2, height: BAR_HEIGHT + X_LABEL_H, overflowX: 'auto', overflowY: 'hidden' }}>
              {bucketKeys.map((bk) => {
                const inner = data.get(bk) ?? new Map()
                const total = Array.from(inner.values()).reduce((s, v) => s + v, 0)
                const barH = Math.round((total / maxBarVal) * (BAR_HEIGHT - TOP_LABEL_H))
                const isHover = hoverBucket === bk
                const segments: { key: string; value: number; color: string }[] = []
                for (const lk of layerKeys) {
                  const v = inner.get(lk) ?? 0
                  if (v > 0) segments.push({ key: lk, value: v, color: keyColor.get(lk) ?? theme.electricBlue })
                }
                return (
                  <div
                    key={bk}
                    style={{ flex: '1 0 0', minWidth: 8, maxWidth: 36, display: 'flex', flexDirection: 'column', cursor: 'default' }}
                    onMouseEnter={(e) => {
                      setHoverBucket(bk)
                      const rect = chartRef.current?.getBoundingClientRect()
                      if (rect) setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
                    }}
                    onMouseMove={(e) => {
                      const rect = chartRef.current?.getBoundingClientRect()
                      if (rect) setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
                    }}
                    onMouseLeave={() => { setHoverBucket(null); setTooltipPos(null) }}
                  >
                    {/* 顶部空间 + 柱顶数值 */}
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 2, minHeight: 0, overflow: 'hidden' }}>
                      {total > 0 && (
                        <span style={{
                          fontSize: 9,
                          fontFamily: theme.fontMono,
                          fontWeight: 700,
                          color: isHover ? theme.textPrimary : theme.textSecondary,
                          whiteSpace: 'nowrap',
                          lineHeight: 1,
                        }}>
                          {formatVal(total)}
                        </span>
                      )}
                    </div>
                    {/* 柱体 */}
                    <div style={{
                      width: '100%', height: barH,
                      display: 'flex', flexDirection: 'column-reverse',
                      overflow: 'hidden',
                      opacity: isHover ? 1 : 0.82,
                      transition: 'opacity 0.12s',
                    }}>
                      {segments.map((seg) => (
                        <div key={seg.key} style={{ width: '100%', height: `${(seg.value / total) * 100}%`, background: seg.color, minHeight: 1 }} />
                      ))}
                    </div>
                    {/* X 轴标签 */}
                    <div style={{
                      height: X_LABEL_H,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontFamily: theme.fontMono,
                      color: isHover ? theme.textPrimary : theme.textSecondary,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      visibility: showXLabel(bk) ? 'visible' : 'hidden',
                    }}>
                      {bucketLabel(bk)}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* 浮动 tooltip */}
        {hoverBucket && tooltipPos && (() => {
          const inner = data.get(hoverBucket) ?? new Map()
          const total = Array.from(inner.values()).reduce((s, v) => s + v, 0)
          const segments = Array.from(inner.entries()).filter(([, v]) => v > 0)
          const tipW = 180
          const chartW = chartRef.current?.offsetWidth ?? 400
          const left = tooltipPos.x + tipW + 12 > chartW ? tooltipPos.x - tipW - 8 : tooltipPos.x + 12
          return (
            <div style={{
              position: 'absolute',
              left,
              top: Math.max(0, tooltipPos.y - 20),
              zIndex: 100,
              width: tipW,
              padding: '8px 10px',
              background: theme.panelDeep,
              border: `1px solid ${theme.hudFrame}`,
              boxShadow: `0 8px 24px rgba(0,0,0,0.7), 0 0 0 1px ${theme.electricBlue}22`,
              fontFamily: theme.fontMono,
              fontSize: 11,
              pointerEvents: 'none',
            }}>
              <div style={{ color: theme.electricBlue, fontWeight: 700, marginBottom: 6 }}>{bucketLabel(hoverBucket)}</div>
              {segments.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                  <div style={{ width: 7, height: 7, background: keyColor.get(k), flexShrink: 0 }} />
                  <span style={{ color: theme.textSecondary, flex: 1, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {group === 'feature' ? (FEATURE_LABEL.get(k) ?? k) : k}
                  </span>
                  <span style={{ color: metric === 'cost' ? theme.dangerRed : theme.electricBlue }}>{formatVal(v)}</span>
                </div>
              ))}
              <div style={{ borderTop: `1px solid ${theme.hudFrameSoft}`, marginTop: 5, paddingTop: 5, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: theme.textMuted }}>合计</span>
                <span style={{ color: metric === 'cost' ? theme.dangerRed : theme.electricBlue, fontWeight: 700 }}>{formatVal(total)}</span>
              </div>
            </div>
          )
        })()}

        {/* 图例 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 10px', marginTop: 8 }}>
          {layerKeys.map((k) => {
            const v = legendTotals.get(k) ?? 0
            if (v === 0) return null
            const color = keyColor.get(k) ?? theme.electricBlue
            const label = group === 'feature' ? (FEATURE_LABEL.get(k) ?? k) : k
            return (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                <div style={{ width: 8, height: 8, background: color, flexShrink: 0 }} />
                <span style={{ color: theme.textPrimary }}>{label}</span>
                <span style={{ fontFamily: theme.fontMono, color: metric === 'cost' ? theme.dangerRed : theme.electricBlue }}>{formatVal(v)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function LibraryTab({
  category,
  models,
  freeQuotaByModel,
  onCategory,
  onAdd,
  onEdit,
  onDelete,
  onOpenBailian,
  onScanFreeQuota,
  onOpenQuotaPanel,
  onOpenBailianDetail,
  scanningQuota,
  hasQuotaLogs,
  bailianName,
  openingBailian,
  pollingBailianLogin,
  canScanQuota,
}: {
  category: ModelCategory
  models: ModelDef[]
  freeQuotaByModel: Map<string, ModelFreeQuota>
  onCategory: (v: ModelCategory | 'all') => void
  onAdd: () => void
  onEdit: (m: ModelDef) => void
  onDelete: (id: string) => void
  onOpenBailian: () => void
  onScanFreeQuota: () => void
  onOpenQuotaPanel: () => void
  onOpenBailianDetail: (modelCode: string) => void
  scanningQuota: boolean
  hasQuotaLogs: boolean
  bailianName: string | null
  openingBailian: boolean
  pollingBailianLogin: boolean
  canScanQuota: boolean
}) {
  return (
    <section style={panelStyle}>
      <div style={panelHeaderStyle}>
        <div>
          <div style={sectionTitleStyle}>模型库</div>
          <div style={mutedStyle}>点击「修改」编辑参数 · 价格单位：元 / 百万 Token · 历史调用成本不回溯</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Tooltip content={bailianName ? '打开百炼窗口' : '打开百炼登录窗口，登录后自动识别'}>
            <button
              type="button"
              onClick={onOpenBailian}
              disabled={openingBailian}
              style={{
                ...textActionBtnStyle(bailianName ? theme.textSecondary : pollingBailianLogin ? theme.electricBlue : theme.warningOrange),
                background: bailianName ? 'rgba(255,255,255,0.04)' : pollingBailianLogin ? `${theme.electricBlue}18` : `${theme.warningOrange}18`,
                border: `1px solid ${bailianName ? theme.glassBorder : pollingBailianLogin ? theme.electricBlue : theme.warningOrange}`,
                opacity: openingBailian ? 0.6 : 1,
                cursor: openingBailian ? 'default' : 'pointer',
              }}
            >
              {pollingBailianLogin ? <RefreshCw size={12} style={{ animation: 'model-dialog-spin 1s linear infinite' }} /> : <LogIn size={12} />}
              {openingBailian ? '打开中' : bailianName ? `已登录 ${bailianName}` : pollingBailianLogin ? '等待登录' : '登录百炼'}
            </button>
          </Tooltip>
          <Tooltip content={bailianName ? '扫描百炼免费额度' : '需要先登录百炼才能扫描'}>
            <button
              type="button"
              onClick={onScanFreeQuota}
              disabled={scanningQuota || !canScanQuota}
              style={{
                ...textActionBtnStyle(bailianName ? theme.expGreen : theme.warningOrange),
                opacity: scanningQuota || !canScanQuota ? 0.55 : 1,
                cursor: scanningQuota || !canScanQuota ? 'default' : 'pointer',
              }}
            >
              <RefreshCw size={12} style={scanningQuota ? { animation: 'model-dialog-spin 1s linear infinite' } : undefined} />
              {scanningQuota ? '扫描中' : '扫描免费额度'}
            </button>
          </Tooltip>
          {(scanningQuota || hasQuotaLogs) && (
            <button
              type="button"
              onClick={onOpenQuotaPanel}
              style={textActionBtnStyle(scanningQuota ? theme.electricBlue : theme.textSecondary)}
            >
              <RefreshCw size={12} style={scanningQuota ? { animation: 'model-dialog-spin 1s linear infinite' } : undefined} />
              {scanningQuota ? '扫描过程' : '扫描结果'}
            </button>
          )}
          <Segmented
            value={category}
            options={[
              { value: 'text', label: '文本' },
              { value: 'omni', label: 'Omni 全模态' },
              { value: 'realtime', label: 'Realtime' },
              { value: 'embedding', label: '向量嵌入' },
            ]}
            onChange={(v) => onCategory(v as ModelCategory)}
          />
          <Tooltip content="新增模型">
            <button type="button" onClick={onAdd} style={smallBtnStyle(theme.expGreen)}>
              <Plus size={13} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="model-dialog-scroll" style={{ overflow: 'auto', paddingRight: 2 }}>
        {models.length === 0 ? (
          <Empty text="该类别下还没有模型，点击右上角 + 新增" />
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 12,
          }}>
            {models.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                quota={freeQuotaByModel.get(model.id)}
                onEdit={() => onEdit(model)}
                onDelete={() => onDelete(model.id)}
                onOpenBailianDetail={() => onOpenBailianDetail(model.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function modelCategoryAccent(cat: ModelCategory): string {
  if (cat === 'omni') return theme.flameTeal
  if (cat === 'realtime') return theme.warningOrange
  if (cat === 'embedding') return theme.shadowPurple
  return theme.electricBlue
}

function ModelCard({
  model,
  quota,
  onEdit,
  onDelete,
  onOpenBailianDetail,
}: {
  model: ModelDef
  quota?: ModelFreeQuota
  onEdit: () => void
  onDelete: () => void
  onOpenBailianDetail: () => void
}) {
  const modalities = parseList(model.modalities)
  const displayName = model.display_name?.trim() || model.id
  const accent = modelCategoryAccent(model.category)

  return (
    <div className="hud-card" style={{ '--accent': accent, '--accent-soft': `${accent}55`, padding: '14px 14px 12px 18px' } as CSSProperties}>
      <span className="hud-card-stripe" />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
        <img
          src={MODEL_ICON_URL}
          alt=""
          width={32}
          height={32}
          style={{ flexShrink: 0, filter: `drop-shadow(0 0 6px ${accent}99)` }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Tooltip content="打开百炼模型详情">
            <button
              type="button"
              onClick={onOpenBailianDetail}
              style={{
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                color: theme.textPrimary,
                cursor: 'pointer',
                display: 'block',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 800,
                lineHeight: 1.3,
                margin: 0,
                padding: 0,
                textAlign: 'left',
                whiteSpace: 'normal',
                wordBreak: 'break-all',
                textShadow: `0 0 6px ${accent}33`,
              }}
            >
              {displayName}
            </button>
          </Tooltip>
          <div style={{ color: theme.textPrimary, opacity: 0.7, fontFamily: theme.fontMono, fontSize: 10, marginTop: 3, wordBreak: 'break-all', letterSpacing: 0.2 }}>
            {model.id}
          </div>
        </div>
      </div>

      {modalities.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          {modalities.map((m) => (
            <span key={m} style={{
              border: `1px solid ${accent}55`,
              color: accent,
              background: `${accent}18`,
              padding: '2px 7px',
              fontSize: 10,
              fontFamily: theme.fontMono,
              fontWeight: 600,
              letterSpacing: 0.4,
              textShadow: `0 0 4px ${accent}55`,
              clipPath: 'polygon(3px 0, 100% 0, calc(100% - 3px) 100%, 0 100%)',
              WebkitClipPath: 'polygon(3px 0, 100% 0, calc(100% - 3px) 100%, 0 100%)',
            }}>{m}</span>
          ))}
        </div>
      )}

      <div style={{ marginBottom: 8, fontSize: 11, color: theme.textPrimary }}>
        <span style={cardLabelStyle}>上下文：</span>
        <span style={{ color: theme.textPrimary, fontFamily: theme.fontMono, fontWeight: 600 }}>
          {model.context_window ? formatTokens(model.context_window) : '-'}
        </span>
      </div>

      {quota && (
        <div style={{ marginBottom: 8, fontSize: 11, display: 'grid', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={cardLabelStyle}>免费额度</span>
            <span style={{
              color: quota.error_message ? theme.dangerRed : quota.remaining_tokens > 0 ? theme.expGreen : theme.textSecondary,
              fontFamily: theme.fontMono,
              fontWeight: 800,
            }}>
              {quota.error_message
                ? 'ERR'
                : quota.total_tokens > 0
                  ? `${formatTokens(quota.remaining_tokens)} / ${formatTokens(quota.total_tokens)}`
                  : quota.not_supported ? '不支持' : '0 / 0'}
            </span>
          </div>
          {quota.total_tokens > 0 && (
            <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
              <div style={{
                width: `${Math.max(0, Math.min(100, (quota.remaining_tokens / quota.total_tokens) * 100))}%`,
                height: '100%',
                background: quota.remaining_tokens > 0 ? theme.expGreen : theme.dangerRed,
              }} />
            </div>
          )}
          <div style={{ color: theme.textPrimary, opacity: 0.7, fontFamily: theme.fontMono, fontSize: 10 }}>
            {quota.expire_date ? `expires ${quota.expire_date}` : new Date(quota.scanned_at).toLocaleString('zh-CN')}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
        {model.pricing.map((tier, idx) => {
          const inputs: { label: string; value: number | null }[] = [
            { label: '文本', value: tier.price_input_text },
            { label: '图片', value: tier.price_input_image },
            { label: '视频', value: tier.price_input_video },
            { label: '音频', value: tier.price_input_audio },
          ].filter((p) => p.value != null)
          const outputs: { label: string; value: number | null }[] = [
            { label: '文本', value: tier.price_output_text },
            { label: '音频', value: tier.price_output_audio },
          ].filter((p) => p.value != null)
          return (
            <div key={idx} className="hud-tier" style={{ borderLeftColor: `${accent}66` }}>
              <div style={{
                color: theme.textPrimary,
                opacity: 0.85,
                fontFamily: theme.fontDisplay,
                fontSize: 10,
                fontWeight: 700,
                marginBottom: 6,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
              }}>
                {tierLabel(tier)}
              </div>
              {inputs.length > 0 && (
                <div style={priceGroupStyle}>
                  <span style={priceGroupLabelStyle(theme.electricBlue)}>IN</span>
                  <div style={priceListStyle}>
                    {inputs.map((p) => <PriceTag key={p.label} label={p.label} value={p.value} color={theme.electricBlue} />)}
                  </div>
                </div>
              )}
              {outputs.length > 0 && (
                <div style={priceGroupStyle}>
                  <span style={priceGroupLabelStyle(theme.warningOrange)}>OUT</span>
                  <div style={priceListStyle}>
                    {outputs.map((p) => <PriceTag key={p.label} label={p.label} value={p.value} color={theme.warningOrange} />)}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ color: theme.textPrimary, opacity: 0.78, fontFamily: theme.fontMono, fontSize: 10, marginBottom: 10, letterSpacing: 0.3 }}>
        单位：元 / 百万 token
      </div>

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onEdit} style={cardBtnStyle(theme.electricBlue)}>
          修改
        </button>
        <button type="button" onClick={onDelete} style={cardBtnStyle(theme.dangerRed)}>
          删除
        </button>
      </div>
    </div>
  )
}

function modalityIcon(label: string, color: string): React.ReactNode {
  const props = {
    size: 12,
    color,
    strokeWidth: 2.2,
    style: { filter: `drop-shadow(0 0 3px ${color}88)`, flexShrink: 0 },
  } as const
  switch (label) {
    case '文本': return <TypeIcon {...props} />
    case '图片': return <ImageIcon {...props} />
    case '视频': return <Video {...props} />
    case '音频': return <AudioLines {...props} />
    default:     return null
  }
}

function PriceTag({ label, value, color }: { label: string; value: number | null; color: string }) {
  return (
    <Tooltip content={label}>
      <span className="hud-pricetag" style={{ ['--tone' as never]: color }}>
        {modalityIcon(label, color)}
        <span style={{ color: theme.textPrimary, fontWeight: 700, textShadow: `0 0 4px ${color}66`, fontSize: 11 }}>
          ¥{value}
        </span>
      </span>
    </Tooltip>
  )
}

function ModelEditor({
  initial,
  isNew,
  onCancel,
  onSave,
}: {
  initial: ModelDef
  isNew: boolean
  onCancel: () => void
  onSave: (m: ModelDef) => void
}) {
  const [draft, setDraft] = useState<ModelDef>(initial)
  const [modalitiesText, setModalitiesText] = useState(parseList(initial.modalities).join(', '))

  const updateTier = (index: number, field: keyof ModelPricingTier, value: string) => {
    setDraft((m) => {
      const next = [...m.pricing]
      const tier = { ...(next[index] ?? emptyTier()) }
      if (field === 'tier_max_tokens') {
        tier[field] = value.trim() === '' ? null : Number(value)
      } else if (field === 'tier_min_tokens') {
        tier[field] = value.trim() === '' ? 0 : Number(value)
      } else {
        ;(tier[field] as number | null) = value.trim() === '' ? null : Number(value)
      }
      next[index] = tier
      return { ...m, pricing: next }
    })
  }

  const addTier = () => setDraft((m) => ({ ...m, pricing: [...m.pricing, emptyTier()] }))
  const removeTier = (idx: number) => setDraft((m) => ({
    ...m,
    pricing: m.pricing.length <= 1 ? m.pricing : m.pricing.filter((_, i) => i !== idx),
  }))

  const handleSave = () => {
    const modalities = modalitiesText.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    onSave({
      ...draft,
      display_name: draft.display_name?.trim() || draft.id,
      modalities: JSON.stringify(modalities),
    })
  }

  const canSave = draft.id.trim().length > 0

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.74)',
        animation: 'model-dialog-in 0.14s ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="model-dialog-scroll"
        style={{
          background: theme.hudFillDeep,
          border: `1px solid ${theme.hudFrame}`,
          boxShadow: `0 0 32px ${theme.hudHalo}, inset 0 0 16px rgba(0,0,0,0.4)`,
          borderRadius: 2,
          padding: '22px 26px 18px',
          width: 'min(640px, 92vw)',
          maxHeight: '88vh',
          overflow: 'auto',
          fontFamily: theme.fontMono,
          color: theme.textPrimary,
          clipPath: hud.chamfer12,
          WebkitClipPath: hud.chamfer12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <img src={MODEL_ICON_URL} alt="" width={24} height={24} />
          <div style={{
            fontFamily: theme.fontDisplay,
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: '0.06em',
            color: theme.electricBlue,
            textShadow: `0 0 6px ${theme.electricBlue}88`,
          }}>
            {isNew ? '新增模型' : `修改模型 · ${initial.display_name || initial.id}`}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12, marginBottom: 14 }}>
          <EditorField label="Model ID" hint="例：qwen3.5-omni-plus">
            <input
              className="model-input"
              value={draft.id}
              onChange={(e) => setDraft((m) => ({ ...m, id: e.target.value }))}
              disabled={!isNew}
              style={{ ...inputStyle, width: '100%', opacity: isNew ? 1 : 0.6 }}
            />
          </EditorField>
          <EditorField label="显示名称">
            <input
              className="model-input"
              value={draft.display_name ?? ''}
              onChange={(e) => setDraft((m) => ({ ...m, display_name: e.target.value }))}
              style={{ ...inputStyle, width: '100%' }}
            />
          </EditorField>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <EditorField label="类别">
              <HudSelect
                value={draft.category}
                options={[
                  { value: 'text', label: '文本' },
                  { value: 'omni', label: 'Omni 全模态' },
                  { value: 'realtime', label: 'Realtime' },
                  { value: 'embedding', label: '向量嵌入' },
                ]}
                onChange={(v) => setDraft((m) => ({ ...m, category: v as ModelCategory }))}
              />
            </EditorField>
            <EditorField label="上下文窗口（token）">
              <input
                className="model-input"
                value={draft.context_window ?? ''}
                onChange={(e) => setDraft((m) => ({ ...m, context_window: e.target.value ? Number(e.target.value) : null }))}
                style={{ ...inputStyle, width: '100%' }}
              />
            </EditorField>
          </div>
          <EditorField label="模态" hint="逗号分隔，如 text,image,video,audio">
            <input
              className="model-input"
              value={modalitiesText}
              onChange={(e) => setModalitiesText(e.target.value)}
              style={{ ...inputStyle, width: '100%' }}
            />
          </EditorField>
          <EditorField label="备注">
            <input
              className="model-input"
              value={draft.notes ?? ''}
              onChange={(e) => setDraft((m) => ({ ...m, notes: e.target.value }))}
              style={{ ...inputStyle, width: '100%' }}
            />
          </EditorField>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: theme.textPrimary, fontWeight: 800, fontSize: 12 }}>价格分档</span>
            <button type="button" onClick={addTier} style={cardBtnStyle(theme.expGreen)}>
              + 添加分档
            </button>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {draft.pricing.map((tier, index) => (
              <div key={index} style={{ border: `1px solid ${theme.hudFrameSoft}`, background: 'rgba(0,0,0,0.18)', padding: 6 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, marginBottom: 8, alignItems: 'end' }}>
                  <EditorField label="区间起始">
                    <input
                      className="model-input"
                      value={tier.tier_min_tokens === 0 ? '' : tier.tier_min_tokens}
                      placeholder="0"
                      onChange={(e) => updateTier(index, 'tier_min_tokens', e.target.value)}
                      style={{ ...inputStyle, width: '100%' }}
                    />
                  </EditorField>
                  <EditorField label="区间结束（留空=不限）">
                    <input
                      className="model-input"
                      value={tier.tier_max_tokens ?? ''}
                      onChange={(e) => updateTier(index, 'tier_max_tokens', e.target.value)}
                      style={{ ...inputStyle, width: '100%' }}
                    />
                  </EditorField>
                  <button
                    type="button"
                    onClick={() => removeTier(index)}
                    disabled={draft.pricing.length <= 1}
                    style={{
                      ...cardBtnStyle(theme.dangerRed),
                      opacity: draft.pricing.length <= 1 ? 0.4 : 1,
                      cursor: draft.pricing.length <= 1 ? 'not-allowed' : 'pointer',
                    }}
                  >
                    删除
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                  <PriceBox label="入文" value={tier.price_input_text} onChange={(v) => updateTier(index, 'price_input_text', v)} />
                  <PriceBox label="图" value={tier.price_input_image} onChange={(v) => updateTier(index, 'price_input_image', v)} />
                  <PriceBox label="视频" value={tier.price_input_video} onChange={(v) => updateTier(index, 'price_input_video', v)} />
                  <PriceBox label="音频" value={tier.price_input_audio} onChange={(v) => updateTier(index, 'price_input_audio', v)} />
                  <PriceBox label="出文" value={tier.price_output_text} onChange={(v) => updateTier(index, 'price_output_text', v)} />
                  <PriceBox label="出音" value={tier.price_output_audio} onChange={(v) => updateTier(index, 'price_output_audio', v)} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} style={cardBtnStyle(theme.textSecondary)}>
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            style={{
              ...cardBtnStyle(theme.expGreen),
              opacity: canSave ? 1 : 0.5,
              cursor: canSave ? 'pointer' : 'not-allowed',
            }}
          >
            <Save size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function EditorField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ color: theme.textSecondary, fontSize: 11, fontWeight: 700 }}>
        {label}
        {hint && <span style={{ color: theme.textMuted, fontWeight: 400, marginLeft: 6 }}>{hint}</span>}
      </span>
      {children}
    </label>
  )
}

function BindingsTab({
  specs,
  models,
  freeQuotaByModel,
  bindingByFeature,
  onBind,
}: {
  specs: readonly FeatureSpec[]
  models: ModelDef[]
  freeQuotaByModel: Map<string, ModelFreeQuota>
  bindingByFeature: Map<string, string>
  onBind: (feature: string, modelId: string) => void
}) {
  return (
    <section style={panelStyle}>
      <div style={panelHeaderStyle}>
        <div>
          <div style={sectionTitleStyle}>功能绑定</div>
          <div style={mutedStyle}>每个功能选择一个默认模型；下一阶段会把设置里的模型 ID 字段迁移到这里</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 10 }}>
        {specs.map((spec) => {
          const options = models
            .filter((m) => matchesFeatureSpec(m, spec))
            .map((m) => {
              return modelSelectOption(m, freeQuotaByModel.get(m.id))
            })
          const boundValue = bindingByFeature.get(spec.feature)
          const value = boundValue && options.some((o) => o.value === boundValue)
            ? boundValue
            : options[0]?.value ?? boundValue ?? ''
          return (
            <div key={spec.feature} style={bindingRowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: theme.textPrimary, fontWeight: 700, fontSize: 13 }}>{spec.label}</div>
                <div style={mutedStyle}>{spec.hint}</div>
                <div style={{ ...mutedStyle, fontFamily: theme.fontMono, marginTop: 4 }}>{spec.feature}</div>
              </div>
              <HudSelect
                value={value}
                options={options.length > 0 ? options : [{ value: '', label: '暂无可选模型' }]}
                onChange={(v) => v && onBind(spec.feature, v)}
                disabled={options.length === 0}
                popupWidth={MODEL_SELECT_POPUP_WIDTH}
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ApiKeyPopover({
  apiKeys,
  activeId,
  creating,
  newLabel,
  newValue,
  onStartCreate,
  onCancelCreate,
  onNewLabel,
  onNewValue,
  onSaveNew,
  onActivate,
  onDelete,
}: {
  apiKeys: ModelApiKey[]
  activeId: string | null
  creating: boolean
  newLabel: string
  newValue: string
  onStartCreate: () => void
  onCancelCreate: () => void
  onNewLabel: (v: string) => void
  onNewValue: (v: string) => void
  onSaveNew: () => void
  onActivate: (key: ModelApiKey) => void
  onDelete: (key: ModelApiKey) => void
}) {
  return (
    <div style={apiKeyPopoverStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ color: theme.textPrimary, fontSize: 13, fontWeight: 800 }}>API Key</div>
          <div style={{ color: theme.textMuted, fontSize: 11 }}>请填写百炼平台的 API KEY</div>
        </div>
        <button
          type="button"
          onClick={() => { void invoke('open_url_in_browser', { url: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key' }) }}
          style={{
            color: theme.electricBlue,
            fontSize: 11,
            fontFamily: theme.fontMono,
            textDecoration: 'underline',
            whiteSpace: 'nowrap',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          点击访问百炼 API Key 页面
        </button>
      </div>

      <div style={{ display: 'grid', marginBottom: creating ? 8 : 10 }}>
        <button type="button" onClick={onStartCreate} style={plainActionStyle}>
          新建 API Key
        </button>
      </div>

      {creating && (
        <div style={apiKeyEditorStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ color: theme.textPrimary, fontSize: 12, fontWeight: 800 }}>新建 API Key</span>
            <button type="button" onClick={onCancelCreate} style={ghostTextBtnStyle}>
              收起
            </button>
          </div>
          <input
            className="model-input"
            value={newLabel}
            onChange={(e) => onNewLabel(e.target.value)}
            placeholder="名称，例如：主账号 / 测试 Key"
            style={{ ...inputStyle, width: '100%' }}
          />
          <ApiKeyField value={newValue} onChange={onNewValue} placeholder="sk-..." />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button type="button" onClick={onCancelCreate} style={plainActionStyle}>
              取消
            </button>
            <button
              type="button"
              onClick={onSaveNew}
              disabled={!newValue.trim()}
              style={{
                ...plainActionStyle,
                color: newValue.trim() ? theme.expGreen : theme.textMuted,
                borderColor: newValue.trim() ? `${theme.expGreen}55` : theme.hudFrameSoft,
                cursor: newValue.trim() ? 'pointer' : 'not-allowed',
                opacity: newValue.trim() ? 1 : 0.55,
              }}
            >
              保存并切换
            </button>
          </div>
        </div>
      )}

      <div className="model-dialog-scroll" style={{ display: 'grid', gap: 8, maxHeight: 260, overflow: 'auto', paddingRight: 2 }}>
        {apiKeys.length === 0 ? (
          <div style={{
            padding: '18px 16px',
            border: `1px dashed ${theme.hudFrameSoft}`,
            background: 'rgba(255,255,255,0.018)',
            color: theme.textMuted,
            fontSize: 12,
            lineHeight: 1.7,
            textAlign: 'center',
          }}>
            <div style={{ marginBottom: 6 }}>还没有保存 API Key</div>
            <div>
              请访问
              <button
                type="button"
                onClick={() => { void invoke('open_url_in_browser', { url: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key' }) }}
                style={{
                  color: theme.electricBlue,
                  textDecoration: 'underline',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '0 4px',
                  fontSize: 12,
                  fontFamily: 'inherit',
                }}
              >
                百炼 API Key 页面
              </button>
              申请 API Key
            </div>
          </div>
        ) : apiKeys.map((key) => (
          <div key={key.id} style={apiKeyRowStyle}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ color: theme.textPrimary, fontWeight: 800, fontSize: 12 }}>{key.label}</span>
                {key.id === activeId && <span style={activeBadgeStyle}>使用中</span>}
              </div>
              <ApiKeyField value={key.api_key} onChange={() => {}} readOnly />
              <div style={{ color: theme.textMuted, fontSize: 10, marginTop: 5 }}>
                用量会记录到此 Key：{key.id.slice(0, 8)}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                type="button"
                disabled={key.id === activeId}
                onClick={() => onActivate(key)}
                style={{
                  ...smallTextBtnStyle(key.id === activeId ? theme.textMuted : theme.expGreen),
                  cursor: key.id === activeId ? 'default' : 'pointer',
                  opacity: key.id === activeId ? 0.55 : 1,
                }}
              >
                切换
              </button>
              <button type="button" onClick={() => onDelete(key)} style={smallTextBtnStyle(theme.dangerRed)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ApiKeyField({
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  readOnly?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }, [value])

  return (
    <div style={{ position: 'relative' }}>
      <input
        className="model-input"
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        style={{
          ...inputStyle,
          width: '100%',
          paddingRight: 56,
          opacity: readOnly ? 0.9 : 1,
        }}
      />
      <div style={{ position: 'absolute', right: 4, top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
        <IconBtn title={revealed ? '隐藏' : '显示'} onClick={() => setRevealed((v) => !v)}>
          {revealed ? <Eye size={13} /> : <EyeOff size={13} />}
        </IconBtn>
        <IconBtn title={copied ? '已复制' : '复制'} onClick={handleCopy} disabled={!value} active={copied}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </IconBtn>
      </div>
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  disabled,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
  active?: boolean
}) {
  return (
    <Tooltip content={title} disabled={disabled}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          padding: 0,
          border: 'none',
          borderRadius: 3,
          background: 'transparent',
          color: active ? theme.expGreen : theme.textSecondary,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.35 : 1,
        }}
      >
        {children}
      </button>
    </Tooltip>
  )
}

const CallRow = React.memo(function CallRow({ call, apiKeyLabel, pricing }: { call: ModelCallLog; apiKeyLabel?: string | null; pricing?: ModelPricingTier[] }) {
  const prompt = call.prompt_text_tokens + call.prompt_image_tokens + call.prompt_video_tokens + call.prompt_audio_tokens
  const completion = call.completion_text_tokens + call.completion_audio_tokens
  const bd = breakdownCallCost(call, pricing)
  const inputParts = bd.inputs.map((p) => ({ label: p.label, value: p.tokens, cost: p.cost }))
  const outputParts = bd.outputs.map((p) => ({ label: p.label, value: p.tokens, cost: p.cost }))
  const saved = call.free_quota_saved_cny ?? 0
  const freeTokens = call.free_quota_tokens ?? 0
  const cost = call.cost_cny ?? 0
  const accent = !call.success ? theme.dangerRed : saved > 0 ? theme.expGreen : theme.electricBlue
  const featureLabel = FEATURE_LABEL.get(call.feature) ?? call.feature

  return (
    <div className="hud-card" style={{ '--accent': accent, '--accent-soft': `${accent}55`, marginBottom: 8, padding: '12px 14px 12px 18px' } as CSSProperties}>
      <span className="hud-card-stripe" />

      {/* 标题行：功能名 + 状态徽章 + 成本 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: theme.textPrimary, fontFamily: theme.fontDisplay, fontWeight: 700, fontSize: 12, letterSpacing: '0.08em', textShadow: `0 0 6px ${accent}55` }}>
          {featureLabel}
        </span>
        {!call.success && <StatusBadge color={theme.dangerRed} label="ERR" />}
        {saved > 0 && <StatusBadge color={theme.expGreen} label="FREE" />}
        <span style={{ flex: 1 }} />
        <span className="hud-num" style={{
          color: cost > 0 ? theme.dangerRed : theme.expGreen,
          fontSize: 14,
          ['--accent-soft' as never]: cost > 0 ? `${theme.dangerRed}66` : `${theme.expGreen}66`,
        }}>
          {formatCny(call.cost_cny)}
        </span>
      </div>

      {/* 模型 ID + 时间戳 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
        <span style={{ color: theme.textPrimary, fontFamily: theme.fontMono, fontSize: 11, fontWeight: 700, letterSpacing: 0.2 }}>
          {call.model_id}
        </span>
        <span style={{ color: theme.textPrimary, opacity: 0.72, fontFamily: theme.fontMono, fontSize: 10, flexShrink: 0 }}>
          {new Date(call.started_at).toLocaleString('zh-CN')}
        </span>
      </div>

      {/* API Key */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: theme.textPrimary, opacity: 0.7, fontSize: 10, fontFamily: theme.fontMono, marginTop: 3 }}>
        <KeyRound size={10} style={{ flexShrink: 0 }} />
        <span>{apiKeyLabel ?? (call.api_key_id ? call.api_key_id.slice(0, 8) : '未归属')}</span>
      </div>

      {/* 免费额度抵扣 */}
      {saved > 0 && (
        <div style={{ color: theme.expGreen, fontSize: 10, marginTop: 4, fontFamily: theme.fontMono, textShadow: `0 0 4px ${theme.expGreen}55` }}>
          免费额度抵扣 {formatTokens(freeTokens)} · 节省 {formatCny(saved)}
        </div>
      )}

      {/* 输入/输出明细 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginTop: 8 }}>
        <MiniMetric label="输入" value={formatTokens(prompt)} sub={inputParts} accent={theme.electricBlue} />
        <MiniMetric label="输出" value={formatTokens(completion)} sub={outputParts} accent={theme.warningOrange} />
      </div>

      {/* 错误提示条 */}
      {call.error_message && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 6,
          marginTop: 8,
          padding: '6px 8px',
          background: `${theme.dangerRed}14`,
          borderLeft: `2px solid ${theme.dangerRed}`,
          color: theme.dangerRed,
          fontSize: 11,
          fontFamily: theme.fontMono,
          lineHeight: 1.4,
        }}>
          <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ wordBreak: 'break-all' }}>{call.error_message}</span>
        </div>
      )}
    </div>
  )
})

function StatusBadge({ color, label }: { color: string; label: string }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '1px 6px',
      fontFamily: theme.fontDisplay,
      fontSize: 9,
      fontWeight: 800,
      letterSpacing: '0.12em',
      color,
      background: `${color}1A`,
      border: `1px solid ${color}66`,
      textShadow: `0 0 4px ${color}88`,
      clipPath: 'polygon(2px 0, 100% 0, calc(100% - 2px) 100%, 0 100%)',
      WebkitClipPath: 'polygon(2px 0, 100% 0, calc(100% - 2px) 100%, 0 100%)',
    }}>
      {label}
    </span>
  )
}

function PriceBox({ label, value, onChange }: { label: string; value: number | null; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'grid', gap: 3 }}>
      <span style={{ color: theme.textMuted, fontSize: 10 }}>{label}</span>
      <input
        className="model-input"
        value={priceText(value)}
        onChange={(e) => onChange(e.target.value === '-' ? '' : e.target.value)}
        style={{ ...inputStyle, width: 54, padding: '4px 5px', fontSize: 11 }}
      />
    </label>
  )
}

function Metric({ label, value, accent, note }: { label: string; value: string; accent?: string; note?: string }) {
  const stripeColor = accent ?? theme.electricBlue
  return (
    <div className="hud-card" style={{ '--accent': stripeColor, '--accent-soft': `${stripeColor}5C` } as CSSProperties}>
      <span className="hud-card-stripe" />
      <div style={metricLabelStyle}>{label}</div>
      <div className="hud-num" style={{ color: stripeColor, fontSize: 20, marginTop: 4 }}>{value}</div>
      {note && <div style={{ color: theme.expGreen, fontFamily: theme.fontMono, fontSize: 10, marginTop: 6, letterSpacing: 0.3 }}>{note}</div>}
    </div>
  )
}

function MetricBreakdown({
  label, total, accent, parts,
}: {
  label: string
  total: number
  accent?: string
  parts: { label: string; value: number; cost?: number }[]
}) {
  const visible = parts.filter((p) => p.value > 0)
  const totalCost = parts.reduce((s, p) => s + (p.cost ?? 0), 0)
  const hasCost = parts.some((p) => p.cost != null)
  const stripeColor = accent ?? theme.electricBlue
  return (
    <div className="hud-card" style={{ '--accent': stripeColor, '--accent-soft': `${stripeColor}5C` } as CSSProperties}>
      <span className="hud-card-stripe" />
      <div style={metricLabelStyle}>{label}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
        <span className="hud-num" style={{ color: stripeColor, fontSize: 20 }}>
          {formatTokens(total)}
        </span>
        {hasCost && totalCost > 0 && (
          <span className="hud-num" style={{ color: theme.dangerRed, fontSize: 12, ['--accent-soft' as never]: `${theme.dangerRed}55` }}>{formatCny(totalCost)}</span>
        )}
      </div>
      {visible.length > 0 && (
        <div style={{ display: 'grid', gap: 3, marginTop: 8, paddingTop: 6, borderTop: `1px solid ${theme.hudFrameSoft}` }}>
          {visible.map((p) => (
            <div key={p.label} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 10 }}>
              <span style={{ color: theme.textSecondary, flexShrink: 0, letterSpacing: 0.3 }}>{p.label}</span>
              <span style={{ fontFamily: theme.fontMono, color: theme.textPrimary, flex: 1, textAlign: 'right' }}>{formatTokens(p.value)}</span>
              {p.cost != null && (
                <span style={{ fontFamily: theme.fontMono, fontSize: 9, color: p.cost > 0 ? theme.dangerRed : theme.textMuted, flexShrink: 0, minWidth: 42, textAlign: 'right' }}>
                  {p.cost > 0 ? formatCny(p.cost) : '不计费'}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MiniMetric({
  label, value, sub, accent,
}: {
  label: string
  value: string
  sub?: { label: string; value: number; cost?: number }[]
  accent?: string
}) {
  const accentColor = accent ?? theme.electricBlue
  const visible = (sub ?? []).filter((p) => p.value > 0 || (p.cost ?? 0) > 0)
  const totalCost = sub?.reduce((s, p) => s + (p.cost ?? 0), 0) ?? 0
  const hasCost = sub?.some((p) => p.cost != null) ?? false
  return (
    <div className="hud-tier" style={{ borderLeftColor: accentColor, padding: '6px 8px 6px 10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          color: theme.textPrimary, opacity: 0.82,
          fontFamily: theme.fontDisplay, fontSize: 9, fontWeight: 700,
          letterSpacing: '0.14em', textTransform: 'uppercase',
        }}>
          {label}
        </span>
        {hasCost && totalCost > 0 && (
          <span style={{ fontFamily: theme.fontMono, fontSize: 10, fontWeight: 700, color: theme.dangerRed, textShadow: `0 0 4px ${theme.dangerRed}55` }}>
            {formatCny(totalCost)}
          </span>
        )}
      </div>
      <div style={{
        color: accentColor,
        fontFamily: theme.fontMono, fontSize: 13, fontWeight: 800,
        textShadow: `0 0 6px ${accentColor}55`,
        marginTop: 1,
      }}>
        {value}
      </div>
      {visible.length > 0 && (
        <div style={{ display: 'grid', gap: 2, marginTop: 4 }}>
          {visible.map((p) => (
            <div key={p.label} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
              <Tooltip content={p.label}>
                <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
                  {modalityIcon(p.label, accentColor)}
                </span>
              </Tooltip>
              <span style={{ fontFamily: theme.fontMono, color: theme.textPrimary, flex: 1, textAlign: 'right' }}>
                {formatTokens(p.value)}
              </span>
              {p.cost != null && (
                <span style={{
                  fontFamily: theme.fontMono, fontSize: 9,
                  color: p.cost > 0 ? theme.dangerRed : theme.textPrimary,
                  opacity: p.cost > 0 ? 1 : 0.55,
                  flexShrink: 0, minWidth: 40, textAlign: 'right',
                }}>
                  {p.cost > 0 ? formatCny(p.cost) : '不计费'}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Empty({ text, tall }: { text: string; tall?: boolean }) {
  return (
    <div style={{
      height: tall ? 300 : 140,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: theme.textMuted,
      border: `1px dashed ${theme.hudFrameSoft}`,
      background: 'rgba(255,255,255,0.018)',
      fontSize: 12,
    }}>
      {text}
    </div>
  )
}

function Segmented({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${theme.hudFrameSoft}`, background: 'rgba(255,255,255,0.025)' }}>
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              border: 'none',
              borderRight: `1px solid ${theme.hudFrameSoft}`,
              background: active ? `${theme.electricBlue}14` : 'transparent',
              color: active ? theme.electricBlue : theme.textSecondary,
              padding: '6px 10px',
              cursor: 'pointer',
              fontFamily: theme.fontMono,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0,
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: `1px solid ${active ? theme.electricBlue + '66' : theme.hudFrameSoft}`,
        background: active ? `${theme.electricBlue}12` : 'rgba(255,255,255,0.025)',
        color: active ? theme.electricBlue : theme.textSecondary,
        padding: '3px 10px',
        height: 24,
        boxSizing: 'border-box',
        lineHeight: 1,
        cursor: 'pointer',
        fontFamily: theme.fontMono,
        fontSize: 12,
        fontWeight: 800,
        clipPath: hud.chamfer8,
        WebkitClipPath: hud.chamfer8,
      }}
    >
      {icon}
      {label}
    </button>
  )
}

const headerStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '7px 16px',
  flexShrink: 0,
  borderBottom: `1px solid ${theme.hudFrameSoft}`,
  background: 'linear-gradient(180deg, rgba(0,229,255,0.05) 0%, transparent 100%)',
}

const titleStyle: CSSProperties = {
  color: theme.electricBlue,
  fontFamily: theme.fontDisplay,
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 1.6,
  textShadow: `0 0 8px ${theme.electricBlue}88`,
}

const tabBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 16px',
  borderBottom: `1px solid ${theme.hudFrameSoft}`,
}

const panelStyle: CSSProperties = {
  border: `1px solid ${theme.hudFrameSoft}`,
  background: 'rgba(2, 8, 18, 0.72)',
  padding: 12,
  minWidth: 0,
  minHeight: 0,
}

const panelHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 12,
}

const sectionTitleStyle: CSSProperties = {
  color: theme.textPrimary,
  fontSize: 14,
  fontWeight: 800,
  letterSpacing: 0,
}

const mutedStyle: CSSProperties = {
  color: theme.textPrimary,
  opacity: 0.72,
  fontSize: 11,
}

const cardLabelStyle: CSSProperties = {
  color: theme.textPrimary,
  opacity: 0.78,
  fontSize: 11,
  fontFamily: theme.fontBody,
  fontWeight: 600,
  marginRight: 4,
  letterSpacing: 0.2,
}



const inputStyle: CSSProperties = {
  border: `1px solid ${theme.hudFrameSoft}`,
  background: 'rgba(0,0,0,0.25)',
  color: theme.textPrimary,
  outline: 'none',
  padding: '6px 8px',
  fontFamily: theme.fontMono,
  fontSize: 12,
  borderRadius: 2,
}

function smallBtnStyle(color: string): CSSProperties {
  return {
    border: `1px solid ${color}55`,
    background: `${color}12`,
    color,
    cursor: 'pointer',
    padding: 6,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 28,
    height: 28,
    clipPath: hud.chamfer8,
    WebkitClipPath: hud.chamfer8,
  }
}

function textActionBtnStyle(color: string): CSSProperties {
  return {
    border: `1px solid ${color}55`,
    background: `${color}12`,
    color,
    cursor: 'pointer',
    padding: '0 10px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 28,
    minWidth: 0,
    clipPath: hud.chamfer8,
    WebkitClipPath: hud.chamfer8,
    fontFamily: theme.fontBody,
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  }
}

function statusStyle(color: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    color,
    fontFamily: theme.fontMono,
    fontSize: 11,
    minHeight: 22,
  }
}

const metricLabelStyle: CSSProperties = {
  color: theme.textPrimary,
  opacity: 0.82,
  fontSize: 10,
  fontFamily: theme.fontDisplay,
  fontWeight: 700,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
}

const priceGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  marginBottom: 2,
}

function priceGroupLabelStyle(color: string): CSSProperties {
  return {
    flexShrink: 0,
    fontFamily: theme.fontDisplay,
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '0.12em',
    color,
    width: 26,
    marginTop: 2,
    textShadow: `0 0 4px ${color}55`,
  }
}

const priceListStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  columnGap: 12,
  rowGap: 2,
  flex: 1,
  minWidth: 0,
}

function cardBtnStyle(color: string): CSSProperties {
  return {
    padding: '5px 12px',
    background: `${color}0C`,
    border: `1px solid ${color}55`,
    color,
    fontFamily: theme.fontMono,
    fontSize: 11,
    letterSpacing: 0.5,
    cursor: 'pointer',
    clipPath: hud.chamfer8,
    WebkitClipPath: hud.chamfer8,
    transition: 'all 0.15s ease',
  }
}

const bindingRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 220px',
  gap: 12,
  alignItems: 'center',
  border: `1px solid ${theme.hudFrameSoft}`,
  background: 'rgba(255,255,255,0.025)',
  padding: 12,
}

const apiKeyPopoverStyle: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 36,
  width: 430,
  zIndex: 930,
  padding: 12,
  border: `1px solid ${theme.hudFrame}`,
  background: 'rgba(3, 10, 22, 0.98)',
  boxShadow: `0 18px 48px rgba(0,0,0,0.72), 0 0 30px ${theme.hudHalo}`,
  clipPath: hud.chamfer12,
  WebkitClipPath: hud.chamfer12,
}

const apiKeyEditorStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  padding: 10,
  marginBottom: 10,
  border: `1px solid ${theme.hudFrameSoft}`,
  background: 'rgba(255,255,255,0.025)',
}

const apiKeyRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 64px',
  gap: 10,
  alignItems: 'stretch',
  padding: 10,
  border: `1px solid ${theme.hudFrameSoft}`,
  background: 'rgba(255,255,255,0.025)',
}

const activeBadgeStyle: CSSProperties = {
  color: theme.expGreen,
  border: `1px solid ${theme.expGreen}55`,
  background: `${theme.expGreen}12`,
  fontSize: 10,
  fontFamily: theme.fontMono,
  padding: '1px 5px',
}

const plainActionStyle: CSSProperties = {
  border: `1px solid ${theme.electricBlue}40`,
  background: 'rgba(255,255,255,0.025)',
  color: theme.electricBlue,
  padding: '6px 8px',
  cursor: 'pointer',
  fontFamily: theme.fontMono,
  fontSize: 11,
  clipPath: hud.chamfer8,
  WebkitClipPath: hud.chamfer8,
}

const ghostTextBtnStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: theme.textMuted,
  padding: '2px 4px',
  cursor: 'pointer',
  fontFamily: theme.fontMono,
  fontSize: 11,
}

function smallTextBtnStyle(color: string): CSSProperties {
  return {
    border: `1px solid ${color}55`,
    background: `${color}10`,
    color,
    padding: '6px 7px',
    cursor: 'pointer',
    fontFamily: theme.fontMono,
    fontSize: 11,
    clipPath: hud.chamfer8,
    WebkitClipPath: hud.chamfer8,
  }
}
