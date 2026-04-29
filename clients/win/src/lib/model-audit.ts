import { invoke } from '@tauri-apps/api/core'
import type { LogModelCallRequest, ModelApiKey, UpsertModelApiKeyRequest } from './local-api'

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

export async function getFeatureModel(feature: string, fallback: string): Promise<string> {
  try {
    const model = await invoke<string | null>('get_feature_model', { feature })
    return model || fallback
  } catch {
    return fallback
  }
}

export async function listModelApiKeys(): Promise<ModelApiKey[]> {
  return invoke<ModelApiKey[]>('list_model_api_keys')
}

export async function getActiveModelApiKey(): Promise<ModelApiKey | null> {
  return invoke<ModelApiKey | null>('get_active_model_api_key')
}

export async function upsertModelApiKey(req: UpsertModelApiKeyRequest): Promise<ModelApiKey> {
  return invoke<ModelApiKey>('upsert_model_api_key', { req })
}

export async function setActiveModelApiKey(id: string): Promise<void> {
  await invoke('set_active_model_api_key', { id })
}

export async function deleteModelApiKey(id: string): Promise<void> {
  await invoke('delete_model_api_key', { id })
}

export function usageToLogRequest(options: LogUsageOptions): LogModelCallRequest {
  const usage = options.usage
  const details = usage?.prompt_tokens_details
  const completionDetails = usage?.completion_tokens_details
  const promptTotal = usage?.prompt_tokens ?? 0

  const prompt_text_tokens = details?.text_tokens
    ?? Math.max(0, promptTotal - (details?.image_tokens ?? 0) - (details?.video_tokens ?? 0) - (details?.audio_tokens ?? 0))

  return {
    api_key_id: options.apiKeyId ?? null,
    feature: options.feature,
    model_id: options.modelId,
    started_at: options.startedAt,
    duration_ms: options.durationMs ?? null,
    prompt_text_tokens,
    prompt_image_tokens: details?.image_tokens ?? 0,
    prompt_video_tokens: details?.video_tokens ?? 0,
    prompt_audio_tokens: details?.audio_tokens ?? 0,
    completion_text_tokens: completionDetails?.text_tokens ?? usage?.completion_tokens ?? 0,
    completion_audio_tokens: completionDetails?.audio_tokens ?? 0,
    success: options.success ?? true,
    error_message: options.errorMessage ?? null,
    metadata: options.metadata ? JSON.stringify(options.metadata) : null,
  }
}

export async function logModelUsage(options: LogUsageOptions): Promise<string | null> {
  try {
    const apiKeyId = options.apiKeyId !== undefined
      ? options.apiKeyId
      : (await getActiveModelApiKey())?.id ?? null
    return await invoke<string>('log_model_call', {
      req: usageToLogRequest({ ...options, apiKeyId }),
    })
  } catch (e) {
    console.warn('[ModelAudit] log_model_call failed:', e)
    return null
  }
}
