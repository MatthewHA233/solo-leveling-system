// ══════════════════════════════════════════════
// 模型显示文案（对齐 desktop lib/model-display.ts）
// ══════════════════════════════════════════════

import type { ModelCategory, ModelDef } from './registry'
import type { ModelFreeQuota } from './model-audit'

export const MODEL_CATEGORY_LABEL: Record<ModelCategory, string> = {
  text: '文本',
  omni: 'Omni 全模态',
  realtime: 'Realtime',
  embedding: '向量嵌入',
  asr: '语音识别',
  decision: '决策判断',
}

export function formatModelName(model: ModelDef): string {
  return model.display_name?.trim() || model.id
}

export function formatQuotaTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatPositiveFreeQuota(quota: ModelFreeQuota | undefined): string | null {
  if (!quota) return null
  if (quota.error_message || quota.not_supported) return null
  if (quota.total_tokens <= 0 || quota.remaining_tokens <= 0) return null
  return `免费额度 ${formatQuotaTokens(quota.remaining_tokens)}/${formatQuotaTokens(quota.total_tokens)}`
}

export function positiveFreeQuotaPercent(quota: ModelFreeQuota | undefined): number | undefined {
  if (!quota) return undefined
  if (quota.error_message || quota.not_supported) return undefined
  if (quota.total_tokens <= 0 || quota.remaining_tokens <= 0) return undefined
  return Math.max(0, Math.min(100, (quota.remaining_tokens / quota.total_tokens) * 100))
}

export function modelSelectLabel(model: ModelDef, _quota?: ModelFreeQuota): string {
  return formatModelName(model)
}

export function modelSelectHint(_model: ModelDef, quota?: ModelFreeQuota): string | undefined {
  return formatPositiveFreeQuota(quota)
    ?? undefined
}

export function modelSelectOption(model: ModelDef, quota?: ModelFreeQuota) {
  return {
    value: model.id,
    label: modelSelectLabel(model, quota),
    hint: modelSelectHint(model, quota),
    meter: positiveFreeQuotaPercent(quota),
  }
}
