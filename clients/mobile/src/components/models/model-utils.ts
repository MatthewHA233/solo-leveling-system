// ══════════════════════════════════════════════
// 模型中心的纯函数和常量（对齐 desktop ModelDialog.tsx 顶部的工具函数）
// ══════════════════════════════════════════════

import { billsTextWithAudio, type ModelPricingTier } from '../../lib/models/registry'
import type { CallLogGranularity, ModelApiKey, ModelCallLog } from '../../lib/models/model-audit'
import { theme } from '../../theme'

export type TabKey = 'usage' | 'library' | 'bindings'
export type ViewMode = 'day' | 'week' | 'month'
export type KeyProvider = 'dashscope' | 'anthropic'

/** 语义色：成本红 / 输入蓝 / 免费绿 / 输出橙；只给数字和徽章用，配合文字标签，不单靠颜色区分 */
export const tone = {
  green: '#2F8F5B',
  danger: theme.danger,
  accent: theme.accent,
  orange: '#C2772E',
}

/** 模态的中文名（库里存英文键） */
export const MODALITY_ZH: Record<string, string> = { text: '文本', image: '图像', video: '视频', audio: '音频', audio_in: '音频输入', audio_out: '音频输出', embedding: '向量' }

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatCny(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '¥0.00'
  if (n < 0.01 && n > 0) {
    // 极小成本（如单次嵌入 ¥0.000012）按有效数字展示，不被固定位数抹成 0
    const digits = Math.min(8, Math.max(4, 1 - Math.floor(Math.log10(n))))
    return `¥${n.toFixed(digits)}`
  }
  return `¥${n.toFixed(2)}`
}

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '$0.00'
  if (n < 0.01 && n > 0) {
    const digits = Math.min(8, Math.max(4, 1 - Math.floor(Math.log10(n))))
    return `$${n.toFixed(digits)}`
  }
  return `$${n.toFixed(2)}`
}

/** 各提供商的 Key 弹层文案（同一个 Key 库，按提供商分开看） */
export const KEY_PROVIDER_META: Record<KeyProvider, { label: string; hint: string; url: string; pageName: string; defaultLabel: string }> = {
  dashscope: {
    label: '百炼',
    hint: '请填写百炼平台的 API KEY',
    url: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key',
    pageName: '百炼 API Key 页面',
    defaultLabel: '百炼 API Key',
  },
  anthropic: {
    label: 'Anthropic',
    hint: 'Anthropic 官方 API Key',
    url: 'https://console.anthropic.com/settings/keys',
    pageName: 'Anthropic 控制台',
    defaultLabel: 'Anthropic API Key',
  },
}

export function nextApiKeyLabel(apiKeys: readonly ModelApiKey[], base = '百炼 API Key'): string {
  const labels = new Set(apiKeys.map((k) => k.label.trim()).filter(Boolean))
  if (!labels.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const label = `${base} ${i}`
    if (!labels.has(label)) return label
  }
  return `${base} ${Date.now()}`
}

export interface CostPart { label: string; tokens: number; cost: number }
export interface CallCostBreakdown { inputs: CostPart[]; outputs: CostPart[] }

function priceOf(tok: number, p: number | null | undefined): number {
  return tok > 0 && p != null && Number.isFinite(p) ? (tok * p) / 1_000_000 : 0
}

/** 镜像 db.rs::compute_cost：算每子项金额贡献，文本+音频输出口径下 text 输出归 0（3.8 Omni 起另计） */
export function breakdownCallCost(call: ModelCallLog, pricing: ModelPricingTier[] | null | undefined): CallCostBreakdown {
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
      { label: '文本', tokens: call.prompt_text_tokens, cost: priceOf(call.prompt_text_tokens, textP) },
      { label: '图像', tokens: call.prompt_image_tokens, cost: priceOf(call.prompt_image_tokens, imgP) },
      { label: '视频', tokens: call.prompt_video_tokens, cost: priceOf(call.prompt_video_tokens, vidP) },
      { label: '音频', tokens: call.prompt_audio_tokens, cost: priceOf(call.prompt_audio_tokens, audP) },
    ].filter((p) => p.tokens > 0),
    outputs: [
      { label: '文本', tokens: call.completion_text_tokens, cost: hasAudio && !billsTextWithAudio(call.model_id) ? 0 : priceOf(call.completion_text_tokens, outTextP) },
      { label: '音频', tokens: call.completion_audio_tokens, cost: priceOf(call.completion_audio_tokens, outAudP) },
    ].filter((p) => p.tokens > 0),
  }
}

export function tierLabel(tier: ModelPricingTier): string {
  const min = tier.tier_min_tokens
  const max = tier.tier_max_tokens
  const left = min === 0 ? '0' : formatTokens(min)
  return max == null ? `${left}+` : `${left}-${formatTokens(max)}`
}

export function viewWindow(mode: ViewMode, anchor: Date): { from: string; to: string; granularity: CallLogGranularity } {
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

export const CAL_WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

export function calDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function buildMonthGrid(y: number, m: number): Date[] {
  const first = new Date(y, m, 1)
  const dow = (first.getDay() + 6) % 7
  const start = new Date(y, m, 1 - dow)
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}

export function anchorLabel(viewMode: ViewMode, d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  if (viewMode === 'day') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (viewMode === 'week') {
    const { from, to } = viewWindow('week', d)
    const f = new Date(from); const t = new Date(to); t.setDate(t.getDate() - 1)
    return `${f.getMonth() + 1}/${pad(f.getDate())} – ${t.getMonth() + 1}/${pad(t.getDate())}`
  }
  return `${d.getFullYear()} · ${pad(d.getMonth() + 1)}`
}

export interface UsageTotals {
  calls: number
  promptText: number; promptImage: number; promptVideo: number; promptAudio: number
  completionText: number; completionAudio: number
  cost: number
  costUsd: number
  saved: number
  costPromptText: number; costPromptImage: number; costPromptVideo: number; costPromptAudio: number
  costCompletionText: number; costCompletionAudio: number
}

/** 对齐 desktop usageTotals：成本拆分按「实际成本 / 理论成本」折净，美元调用只累加不混进人民币拆分 */
export function computeUsageTotals(calls: readonly ModelCallLog[], pricingMap: Map<string, ModelPricingTier[]>): UsageTotals {
  return calls.reduce<UsageTotals>((acc, c) => {
    acc.calls += 1
    acc.promptText += c.prompt_text_tokens
    acc.promptImage += c.prompt_image_tokens
    acc.promptVideo += c.prompt_video_tokens
    acc.promptAudio += c.prompt_audio_tokens
    acc.completionText += c.completion_text_tokens
    acc.completionAudio += c.completion_audio_tokens
    acc.cost += c.cost_cny ?? 0
    acc.saved += c.free_quota_saved_cny ?? 0
    // 美元计费的调用单价也是美元，不混进人民币拆分，单独累加
    if (c.cost_usd != null) {
      acc.costUsd += c.cost_usd
      return acc
    }
    const bd = breakdownCallCost(c, pricingMap.get(c.model_id))
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
    costUsd: 0,
    saved: 0,
    costPromptText: 0, costPromptImage: 0, costPromptVideo: 0, costPromptAudio: 0,
    costCompletionText: 0, costCompletionAudio: 0,
  })
}
