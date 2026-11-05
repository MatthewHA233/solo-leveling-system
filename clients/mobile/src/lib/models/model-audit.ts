// ══════════════════════════════════════════════
// 模型审计（对齐 desktop lib/model-audit.ts）
// Tauri invoke 换成 SolevupDb 桥；形状保持 desktop 的 snake_case，UI 可以逐行对照。
// 落库本体（usageToLogRequest / logModelUsage）在 llm/model-usage.ts，这里转出去，不写第二份。
// ══════════════════════════════════════════════

import { Linking } from 'react-native'
import {
  solevupAggregateCallLog,
  solevupDeleteModelApiKey,
  solevupGetActiveModelApiKey,
  solevupGetFeatureBinding,
  solevupGetModelCallLog,
  solevupListFeatureBindings,
  solevupListModelApiKeys,
  solevupListModelFreeQuota,
  solevupQueryCallLog,
  solevupSetActiveModelApiKey,
  solevupSetFeatureBinding,
  solevupUpsertModelApiKey,
  type CallLogBucket,
  type CallLogGranularity,
  type ModelApiKeyInfo,
  type ModelCallLog,
  type ModelFreeQuotaRow,
} from '../solevupdb'
import type { DashScopeUsage } from '../llm/model-usage'

export { logModelUsage, subscribeModelUsageLogged, usageToLogRequest } from '../llm/model-usage'
export type { DashScopeUsage, LogUsageOptions } from '../llm/model-usage'
export type { CallLogBucket, CallLogGranularity, ModelCallLog } from '../solevupdb'

/**
 * Realtime API 的 usage 字段（百炼 omni-realtime 实际响应）
 * 文档：https://help.aliyun.com/zh/model-studio/realtime
 * 字段名为 input_tokens_details / output_tokens_details（复数 tokens）
 */
export interface RealtimeUsage {
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: {
    text_tokens?: number
    audio_tokens?: number
    image_tokens?: number
    cached_tokens?: number
  }
  output_tokens_details?: {
    text_tokens?: number
    audio_tokens?: number
  }
}

/** Realtime usage → chat-completions usage 的字段转换 */
export function realtimeUsageToDashScope(u: RealtimeUsage): DashScopeUsage {
  return {
    prompt_tokens: u.input_tokens,
    completion_tokens: u.output_tokens,
    total_tokens: u.total_tokens,
    prompt_tokens_details: u.input_tokens_details ? {
      text_tokens: u.input_tokens_details.text_tokens,
      image_tokens: u.input_tokens_details.image_tokens,
      audio_tokens: u.input_tokens_details.audio_tokens,
    } : undefined,
    completion_tokens_details: u.output_tokens_details ? {
      text_tokens: u.output_tokens_details.text_tokens,
      audio_tokens: u.output_tokens_details.audio_tokens,
    } : undefined,
  }
}

// ── desktop 形状的行类型 ──

export interface FeatureBinding {
  feature: string
  model_id: string
  updated_at: string
}

export interface ModelApiKey {
  id: string
  label: string
  api_key: string
  is_active: boolean
  created_at: string
  updated_at: string
  /** 'dashscope' | 'anthropic'（以后还会有别的） */
  provider: string
}

export interface UpsertModelApiKeyRequest {
  id?: string | null
  label: string
  api_key: string
  is_active: boolean
  /** 缺省 = 百炼 */
  provider?: string
}

export interface ModelFreeQuota {
  model_id: string
  has_free_quota: boolean
  not_supported: boolean
  used_tokens: number
  total_tokens: number
  remaining_tokens: number
  used_percent: string | null
  expire_date: string | null
  raw_quota: string | null
  scanned_at: string
  error_message: string | null
}

function toModelApiKey(k: ModelApiKeyInfo): ModelApiKey {
  return {
    id: k.id,
    label: k.label,
    api_key: k.apiKey,
    is_active: k.isActive,
    created_at: k.createdAt,
    updated_at: k.updatedAt,
    provider: k.provider,
  }
}

function toModelFreeQuota(q: ModelFreeQuotaRow): ModelFreeQuota {
  return {
    model_id: q.modelId,
    has_free_quota: q.hasFreeQuota,
    not_supported: q.notSupported,
    used_tokens: q.usedTokens,
    total_tokens: q.totalTokens,
    remaining_tokens: q.remainingTokens,
    used_percent: q.usedPercent,
    expire_date: q.expireDate,
    raw_quota: q.rawQuota,
    scanned_at: q.scannedAt,
    error_message: q.errorMessage,
  }
}

// ── 功能绑定 ──

export async function getFeatureModel(feature: string, fallback: string): Promise<string> {
  try {
    const model = await solevupGetFeatureBinding(feature)
    return model || fallback
  } catch {
    return fallback
  }
}

export async function setFeatureModel(feature: string, modelId: string): Promise<void> {
  await solevupSetFeatureBinding(feature, modelId)
}

export async function listFeatureBindings(): Promise<FeatureBinding[]> {
  const rows = await solevupListFeatureBindings()
  return rows.map((r) => ({ feature: r.feature, model_id: r.modelId, updated_at: r.updatedAt }))
}

type BindingListener = (detail: { feature: string; modelId: string }) => void
const bindingListeners = new Set<BindingListener>()

/** 对应桌面端 window 事件 model-feature-binding-updated */
export function subscribeFeatureBindingUpdated(fn: BindingListener): () => void {
  bindingListeners.add(fn)
  return () => bindingListeners.delete(fn)
}

export function emitFeatureBindingUpdated(feature: string, modelId: string): void {
  for (const fn of bindingListeners) fn({ feature, modelId })
}

// ── API Key ──

export async function listModelApiKeys(): Promise<ModelApiKey[]> {
  return (await solevupListModelApiKeys()).map(toModelApiKey)
}

/** 缺省取百炼的启用 Key；对齐 desktop get_active_model_api_key(provider) */
export async function getActiveModelApiKey(provider = 'dashscope'): Promise<ModelApiKey | null> {
  const key = await solevupGetActiveModelApiKey(provider)
  return key ? toModelApiKey(key) : null
}

export async function upsertModelApiKey(req: UpsertModelApiKeyRequest): Promise<ModelApiKey> {
  const key = await solevupUpsertModelApiKey({
    id: req.id ?? null,
    label: req.label,
    apiKey: req.api_key,
    provider: req.provider,
    activate: req.is_active,
  })
  if (!key) throw new Error('本地数据库不可用')
  return toModelApiKey(key)
}

export async function setActiveModelApiKey(id: string): Promise<void> {
  await solevupSetActiveModelApiKey(id)
}

export async function deleteModelApiKey(id: string): Promise<void> {
  await solevupDeleteModelApiKey(id)
}

// ── 百炼控制台：手机端没有内嵌 WebView，交给系统浏览器 ──

const BAILIAN_MARKET_URL = 'https://bailian.console.aliyun.com/cn-beijing/?tab=model#/model-market/all'

export async function openBailianLogin(): Promise<void> {
  await Linking.openURL(BAILIAN_MARKET_URL)
}

export async function openBailianModelDetail(modelCode: string): Promise<void> {
  const code = modelCode.trim()
  if (!code) throw new Error('MODEL_CODE_EMPTY')
  await Linking.openURL(
    `https://bailian.console.aliyun.com/cn-beijing/?tab=model#/model-market/detail/${encodeURIComponent(code)}?serviceSite=asia-pacific-china`,
  )
}

export async function openExternalUrl(url: string): Promise<void> {
  await Linking.openURL(url)
}

// ── 免费额度 / 调用记录 ──

export async function listModelFreeQuotas(): Promise<ModelFreeQuota[]> {
  return (await solevupListModelFreeQuota()).map(toModelFreeQuota)
}

export async function getModelCallLog(id: string): Promise<ModelCallLog | null> {
  return solevupGetModelCallLog(id)
}

export async function queryCallLog(args: {
  timeFrom?: string | null
  timeTo?: string | null
  feature?: string | null
  modelId?: string | null
  apiKeyId?: string | null
  limit?: number | null
}): Promise<ModelCallLog[]> {
  return solevupQueryCallLog(args)
}

export async function aggregateCallLog(args: {
  timeFrom: string
  timeTo: string
  granularity: CallLogGranularity
  feature?: string | null
  modelId?: string | null
  apiKeyId?: string | null
}): Promise<CallLogBucket[]> {
  return solevupAggregateCallLog(args)
}

/** 消息 usage_json → ModelCallLog；坏数据或旧格式返回 null，气泡就不显示费用 */
export function parseModelCallLog(json: string | null | undefined): ModelCallLog | null {
  if (!json) return null
  try {
    const row = JSON.parse(json) as Partial<ModelCallLog> | null
    if (!row || typeof row !== 'object' || typeof row.model_id !== 'string') return null
    return {
      id: row.id ?? '',
      api_key_id: row.api_key_id ?? null,
      feature: row.feature ?? '',
      model_id: row.model_id,
      started_at: row.started_at ?? '',
      duration_ms: row.duration_ms ?? null,
      prompt_text_tokens: row.prompt_text_tokens ?? 0,
      prompt_image_tokens: row.prompt_image_tokens ?? 0,
      prompt_video_tokens: row.prompt_video_tokens ?? 0,
      prompt_audio_tokens: row.prompt_audio_tokens ?? 0,
      completion_text_tokens: row.completion_text_tokens ?? 0,
      completion_audio_tokens: row.completion_audio_tokens ?? 0,
      cost_cny: row.cost_cny ?? null,
      cost_usd: row.cost_usd ?? null,
      free_quota_tokens: row.free_quota_tokens ?? 0,
      free_quota_saved_cny: row.free_quota_saved_cny ?? 0,
      success: row.success !== false && (row.success as unknown) !== 0,
      error_message: row.error_message ?? null,
      metadata: row.metadata ?? null,
    }
  } catch {
    return null
  }
}
