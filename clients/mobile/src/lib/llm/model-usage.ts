// ══════════════════════════════════════════════
// 模型用量审计（llm 层用）—— 对齐 desktop lib/model-audit.ts 的
// DashScopeUsage / LogUsageOptions / usageToLogRequest / logModelUsage
//
// 桌面端走 Tauri invoke('log_model_call')，手机端走 SolevupDb.logModelCall：
// 阶梯计费 + 免费额度在 Kotlin 里算，返回 ModelCallLog 形状的 JSON。
// 桌面端的 window 事件 model-usage-logged 换成 subscribeModelUsageLogged。
// ══════════════════════════════════════════════

import {
  solevupGetActiveModelApiKey,
  solevupLogModelCall,
  type ModelCallLogInsert,
} from '../solevupdb'

export interface DashScopeUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: {
    text_tokens?: number
    image_tokens?: number
    video_tokens?: number
    audio_tokens?: number
  }
  completion_tokens_details?: {
    text_tokens?: number
    audio_tokens?: number
  }
}

/** 与 desktop local-api.ts 的 ModelCallLog 同形（也是聊天消息 usage_json 的形状） */
export interface ModelCallLog {
  id: string
  api_key_id: string | null
  feature: string
  model_id: string
  started_at: string
  duration_ms: number | null
  prompt_text_tokens: number
  prompt_image_tokens: number
  prompt_video_tokens: number
  prompt_audio_tokens: number
  completion_text_tokens: number
  completion_audio_tokens: number
  cost_cny: number | null
  cost_usd?: number | null
  free_quota_tokens: number
  free_quota_saved_cny: number
  success: boolean
  error_message: string | null
  metadata: string | null
}

export interface LogUsageOptions {
  apiKeyId?: string | null
  feature: string
  modelId: string
  startedAt: string
  durationMs?: number | null
  usage?: DashScopeUsage | null
  success?: boolean
  errorMessage?: string | null
  metadata?: Record<string, unknown> | null
}

export function usageToLogRequest(options: LogUsageOptions): ModelCallLogInsert {
  const usage = options.usage
  const details = usage?.prompt_tokens_details
  const completionDetails = usage?.completion_tokens_details
  const promptTotal = usage?.prompt_tokens ?? 0

  const promptTextTokens = details?.text_tokens
    ?? Math.max(0, promptTotal - (details?.image_tokens ?? 0) - (details?.video_tokens ?? 0) - (details?.audio_tokens ?? 0))
  const completionAudioTokens = completionDetails?.audio_tokens ?? 0
  const completionTextTokens = completionDetails
    ? (completionDetails.text_tokens ?? Math.max(0, (usage?.completion_tokens ?? 0) - completionAudioTokens))
    : (usage?.completion_tokens ?? 0)

  return {
    apiKeyId: options.apiKeyId ?? null,
    feature: options.feature,
    modelId: options.modelId,
    startedAt: options.startedAt,
    durationMs: options.durationMs ?? null,
    promptTextTokens,
    promptImageTokens: details?.image_tokens ?? 0,
    promptVideoTokens: details?.video_tokens ?? 0,
    promptAudioTokens: details?.audio_tokens ?? 0,
    completionTextTokens,
    completionAudioTokens,
    success: options.success ?? true,
    errorMessage: options.errorMessage ?? null,
    metadata: options.metadata ? JSON.stringify(options.metadata) : null,
  }
}

type UsageListener = (call: ModelCallLog) => void
const usageListeners = new Set<UsageListener>()

/** 对应桌面端 window 事件 model-usage-logged：每落一条审计通知一次 */
export function subscribeModelUsageLogged(fn: UsageListener): () => void {
  usageListeners.add(fn)
  return () => usageListeners.delete(fn)
}

export async function logModelUsage(options: LogUsageOptions): Promise<ModelCallLog | null> {
  try {
    const apiKeyId = options.apiKeyId !== undefined
      ? options.apiKeyId
      : (await solevupGetActiveModelApiKey())?.id ?? null
    const json = await solevupLogModelCall(usageToLogRequest({ ...options, apiKeyId }))
    if (!json) return null
    // Kotlin 那边值为 null 的字段不写进 JSON，这里补回 null，和 desktop 的行保持同形
    const row: ModelCallLog = {
      api_key_id: null,
      duration_ms: null,
      cost_cny: null,
      cost_usd: null,
      error_message: null,
      metadata: null,
      ...(JSON.parse(json) as Omit<ModelCallLog, 'api_key_id' | 'duration_ms' | 'cost_cny' | 'error_message' | 'metadata'>),
    }
    for (const fn of usageListeners) fn(row)
    return row
  } catch (e) {
    console.warn('[ModelAudit] log_model_call failed:', e)
    return null
  }
}
