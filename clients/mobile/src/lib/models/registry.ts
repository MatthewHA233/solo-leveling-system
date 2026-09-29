// ══════════════════════════════════════════════
// 模型注册表（mobile 版）— 与 desktop db.rs seed_model_registry 同源
//
// desktop 的 model_registry/model_pricing 不在 LWW 同步 payload 里
// （种子由各端随 git 维护），mobile 用静态模块承载同一份数据。
// ⚠ 对齐流程：desktop 改种子（db.rs seed_model_registry）后，
//   把本文件 SEEDS/NOTES 与之逐条比对更新（结构刻意保持逐行可对照）。
// 数据来源：cn-beijing 百炼价目（2026-04 人工核对，价为元/百万 token）。
// ══════════════════════════════════════════════

export type ModelCategory = 'text' | 'omni' | 'realtime' | 'embedding'

// 与 desktop local-api.ts 的 ModelPricingTier 同形
export interface ModelPricingTier {
  tier_min_tokens: number
  tier_max_tokens: number | null
  price_input_text: number | null
  price_input_image: number | null
  price_input_video: number | null
  price_input_audio: number | null
  price_output_text: number | null
  price_output_text_thinking: number | null
  price_output_audio: number | null
}

// 与 desktop local-api.ts 的 ModelDef 同形
export interface ModelDef {
  id: string
  category: ModelCategory
  provider: string
  display_name: string | null
  modalities: string | null      // JSON 数组字符串，对齐 desktop 存储格式
  context_window: number | null
  notes: string | null
  deprecated: boolean
  updated_at: string
  pricing: ModelPricingTier[]
}

// tier 字段顺序与 desktop 种子一致：(min, max, in_text, in_image, in_video, in_audio, out_text, out_audio)
type Tier = [number, number | null, number | null, number | null, number | null, number | null, number | null, number | null]
// (ids, category, display_name, modalities, context_window, tiers)；ids[0] 为主 id，其余为同价别名
type Seed = [string[], ModelCategory, string, string[], number, Tier[]]

const SEEDS: Seed[] = [
  // ── Qwen3.8 文本（2026-09 上线；价目 2026-09-29 从官方价目页核对）──
  // 均无阶梯（0<Token≤1M）；多模态版图片/视频与文本同价；prime = max 的优速模式，价格翻倍
  [['qwen3.8-max', 'qwen3.8-max-0902'], 'text', 'Qwen3.8 Max', ['text', 'image', 'video'], 1_000_000, [
    [0, null, 12.0, 12.0, 12.0, null, 36.0, null],
  ]],
  [['qwen3.8-max-prime'], 'text', 'Qwen3.8 Max Prime', ['text', 'image', 'video'], 1_000_000, [
    [0, null, 24.0, 24.0, 24.0, null, 72.0, null],
  ]],
  [['qwen3.8-flash'], 'text', 'Qwen3.8 Flash', ['text', 'image', 'video'], 1_000_000, [
    [0, null, 0.8, 0.8, 0.8, null, 2.7, null],
  ]],
  [['qwen3.8-2.4t-a95b'], 'text', 'Qwen3.8 2.4T A95B', ['text'], 1_000_000, [
    [0, null, 12.0, null, null, null, 36.0, null],
  ]],
  [['qwen3.8-27b'], 'text', 'Qwen3.8 27B', ['text', 'image', 'video'], 1_000_000, [
    [0, null, 3.0, 3.0, 3.0, null, 12.0, null],
  ]],

  // ── Qwen3.7 文本（2026-05 上线；价目 2026-06-11 控制台人工核对，存原价）──
  [['qwen3.7-max', 'qwen3.7-max-2026-06-08', 'qwen3.7-max-2026-05-20', 'qwen3.7-max-2026-05-17'], 'text', 'Qwen3.7 Max', ['text'], 1_048_576, [
    [0, null, 12.0, null, null, null, 36.0, null],
  ]],
  [['qwen3.7-max-preview'], 'text', 'Qwen3.7 Max Preview', ['text'], 1_048_576, [
    [0, null, 12.0, null, null, null, 36.0, null],
  ]],
  // plus 阶梯两档：≤256K / 256K~1M
  [['qwen3.7-plus', 'qwen3.7-plus-2026-05-26'], 'text', 'Qwen3.7 Plus', ['text', 'image', 'video'], 1_048_576, [
    [0, 262_144, 2.0, 2.0, 2.0, null, 8.0, null],
    [262_144, 1_048_576, 6.0, 6.0, 6.0, null, 24.0, null],
  ]],
  // flash 2026-07 上线（价目 2026-09-29 核对），阶梯三档：≤32K / 32K~256K / 256K~1M
  [['qwen3.7-flash', 'qwen3.7-flash-2026-07-15'], 'text', 'Qwen3.7 Flash', ['text', 'image', 'video'], 1_000_000, [
    [0, 32_768, 0.2, 0.2, 0.2, null, 0.8, null],
    [32_768, 262_144, 0.6, 0.6, 0.6, null, 2.4, null],
    [262_144, 1_048_576, 1.2, 1.2, 1.2, null, 4.8, null],
  ]],

  // ── Qwen3.6 文本 ──
  [['qwen3.6-max-preview'], 'text', 'Qwen3.6 Max Preview', ['text'], 262_144, [
    [0, 131_072, 9.0, null, null, null, 54.0, null],
    [131_072, 262_144, 15.0, null, null, null, 90.0, null],
  ]],
  [['qwen3.6-plus', 'qwen3.6-plus-2026-04-02'], 'text', 'Qwen3.6 Plus', ['text', 'image', 'video'], 1_048_576, [
    [0, 262_144, 2.0, 2.0, 2.0, null, 12.0, null],
    [262_144, 1_048_576, 8.0, 8.0, 8.0, null, 48.0, null],
  ]],
  [['qwen3.6-flash', 'qwen3.6-flash-2026-04-16'], 'text', 'Qwen3.6 Flash', ['text', 'image', 'video'], 1_048_576, [
    [0, 262_144, 1.2, 1.2, 1.2, null, 7.2, null],
    [262_144, 1_048_576, 4.8, 4.8, 4.8, null, 28.8, null],
  ]],
  [['qwen3.6-35b-a3b'], 'text', 'Qwen3.6 35B A3B', ['text', 'image', 'video'], 262_144, [
    [0, 262_144, 1.8, 1.8, 1.8, null, 10.8, null],
  ]],
  [['qwen3.6-27b'], 'text', 'Qwen3.6 27B', ['text'], 262_144, [
    [0, 262_144, 3.0, null, null, null, 18.0, null],
  ]],

  // ── Qwen3.5 文本 ──
  [['qwen3.5-plus', 'qwen3.5-plus-2026-04-20', 'qwen3.5-plus-2026-02-15'], 'text', 'Qwen3.5 Plus', ['text', 'image', 'video'], 1_048_576, [
    [0, 131_072, 0.8, 0.8, 0.8, null, 4.8, null],
    [131_072, 262_144, 2.0, 2.0, 2.0, null, 12.0, null],
    [262_144, 1_048_576, 4.0, 4.0, 4.0, null, 24.0, null],
  ]],
  [['qwen3.5-flash', 'qwen3.5-flash-2026-02-23'], 'text', 'Qwen3.5 Flash', ['text', 'image', 'video'], 1_048_576, [
    [0, 131_072, 0.2, 0.2, 0.2, null, 2.0, null],
    [131_072, 262_144, 0.8, 0.8, 0.8, null, 8.0, null],
    [262_144, 1_048_576, 1.2, 1.2, 1.2, null, 12.0, null],
  ]],
  [['qwen3.5-397b-a17b'], 'text', 'Qwen3.5 397B A17B', ['text', 'image', 'video'], 262_144, [
    [0, 131_072, 1.2, 1.2, 1.2, null, 7.2, null],
    [131_072, 262_144, 3.0, 3.0, 3.0, null, 18.0, null],
  ]],
  [['qwen3.5-122b-a10b'], 'text', 'Qwen3.5 122B A10B', ['text', 'image', 'video'], 262_144, [
    [0, 131_072, 0.8, 0.8, 0.8, null, 6.4, null],
    [131_072, 262_144, 2.0, 2.0, 2.0, null, 16.0, null],
  ]],
  [['qwen3.5-27b'], 'text', 'Qwen3.5 27B', ['text', 'image', 'video'], 262_144, [
    [0, 131_072, 0.6, 0.6, 0.6, null, 4.8, null],
    [131_072, 262_144, 1.8, 1.8, 1.8, null, 14.4, null],
  ]],
  [['qwen3.5-35b-a3b'], 'text', 'Qwen3.5 35B A3B', ['text', 'image', 'video'], 262_144, [
    [0, 131_072, 0.4, 0.4, 0.4, null, 3.2, null],
    [131_072, 262_144, 1.6, 1.6, 1.6, null, 12.8, null],
  ]],

  // ── Qwen3.8 Omni HTTP（只输出文本，不出语音；各输入模态同价）──
  [['qwen3.8-omni-flash'], 'omni', 'Qwen3.8 Omni Flash', ['text', 'image', 'video', 'audio_in'], 1_000_000, [
    [0, null, 0.8, 0.8, 0.8, 0.8, 2.7, null],
  ]],

  // ── Qwen3.5 Omni HTTP ──
  [['qwen3.5-omni-plus', 'qwen3.5-omni-plus-2026-03-15'], 'omni', 'Qwen3.5 Omni Plus', ['text', 'image', 'video', 'audio_in', 'audio_out'], 0, [
    [0, null, 7.0, 7.0, 7.0, 53.0, 40.0, 213.0],
  ]],
  [['qwen3.5-omni-flash', 'qwen3.5-omni-flash-2026-03-15'], 'omni', 'Qwen3.5 Omni Flash', ['text', 'image', 'video', 'audio_in', 'audio_out'], 0, [
    [0, null, 2.2, 2.2, 2.2, 18.0, 13.3, 72.0],
  ]],

  // ── Qwen3.8 Omni Realtime（WS）：输出语音时音频和对应文本分别计费（见 billsTextWithAudio）──
  [['qwen3.8-omni-flash-realtime'], 'realtime', 'Qwen3.8 Omni Flash Realtime', ['text', 'image', 'audio_in', 'audio_out'], 0, [
    [0, null, 1.5, 1.5, 1.5, 6.0, 4.5, 12.0],
  ]],

  // ── Qwen3.5 Omni Realtime（WS）──
  [['qwen3.5-omni-plus-realtime', 'qwen3.5-omni-plus-realtime-2026-03-15'], 'realtime', 'Qwen3.5 Omni Plus Realtime', ['text', 'image', 'audio_in', 'audio_out'], 0, [
    [0, null, 10.0, 10.0, null, 80.0, 60.0, 300.0],
  ]],
  [['qwen3.5-omni-flash-realtime', 'qwen3.5-omni-flash-realtime-2026-03-15'], 'realtime', 'Qwen3.5 Omni Flash Realtime', ['text', 'image', 'audio_in', 'audio_out'], 0, [
    [0, null, 3.3, 3.3, null, 27.0, 20.0, 107.0],
  ]],

  // ── 向量嵌入 / 重排序（无输出 token 计费；context_window 存单次最大输入）──
  [['text-embedding-v4'], 'embedding', 'Text Embedding V4', ['text'], 8_192, [
    [0, null, 0.5, null, null, null, null, null],
  ]],
  [['text-embedding-v3'], 'embedding', 'Text Embedding V3', ['text'], 8_192, [
    [0, null, 0.5, null, null, null, null, null],
  ]],
  // Qwen3.7 文本向量/重排序（价目 2026-09-29 核对；单次最大输入未核对，context_window 留空）
  [['qwen3.7-text-embedding'], 'embedding', 'Qwen3.7 Text Embedding', ['text'], 0, [
    [0, null, 0.5, null, null, null, null, null],
  ]],
  [['qwen3.7-text-embedding-flash'], 'embedding', 'Qwen3.7 Text Embedding Flash', ['text'], 0, [
    [0, null, 0.125, null, null, null, null, null],
  ]],
  [['qwen3.7-text-rerank'], 'embedding', 'Qwen3.7 Text Rerank', ['text'], 0, [
    [0, null, 0.5, null, null, null, null, null],
  ]],
  [['qwen3-vl-embedding'], 'embedding', 'Qwen3 VL Embedding', ['text', 'image'], 32_768, [
    [0, null, 0.7, 1.8, null, null, null, null],
  ]],
  // rerank 2026-09 降价：文本/图片均 0.5（2026-09-29 核对）
  [['qwen3-vl-rerank'], 'embedding', 'Qwen3 VL Rerank', ['text', 'image'], 122_880, [
    [0, null, 0.5, 0.5, null, null, null, null],
  ]],
  [['tongyi-embedding-vision-plus', 'tongyi-embedding-vision-plus-2026-03-06'], 'embedding', '通义 Embedding Vision Plus', ['text', 'image'], 0, [
    [0, null, 0.5, 0.5, null, null, null, null],
  ]],
  [['tongyi-embedding-vision-flash', 'tongyi-embedding-vision-flash-2026-03-06'], 'embedding', '通义 Embedding Vision Flash', ['text', 'image'], 0, [
    [0, null, 0.15, 0.15, null, null, null, null],
  ]],
]

// 个别模型的补充说明（与 desktop notes 段一致）
const NOTES: ReadonlyArray<[string, string]> = [
  ['qwen3.8-max', '无阶梯；Batch 调用半价；缓存命中 1.5、显式缓存创建 15/命中 1 元/百万；快照 qwen3.8-max-0902（别名 qwen3.8-max-2026-09-02）'],
  ['qwen3.8-max-prime', 'qwen3.8-max 的优速模式（Prime），价格翻倍；无免费额度'],
  ['qwen3.8-flash', '无阶梯；缓存命中 0.1、显式缓存创建 1.25/命中 0.1 元/百万'],
  ['qwen3.8-omni-flash', '只输出文本（不出语音）；文本/图片/视频/音频输入同价；缓存命中 0.1 元/百万'],
  ['qwen3.8-omni-flash-realtime', '输出语音时音频和对应文本分别计费（Qwen3.5-Omni-Realtime 只计音频）'],
  ['qwen3.7-flash', '阶梯计费(≤32K/32K~256K/256K~1M)；Batch 调用半价'],
  ['qwen3.7-plus', '阶梯计费(≤256K/256K~1M)；当前限时8折、Batch Chat 5折，库内存原价；缓存命中 0.4/1.2 元/百万'],
  ['qwen3.7-max', '无阶梯；Batch 调用半价；缓存命中 2.4、显式缓存创建 15/命中 1.2'],
  ['qwen3.7-max-preview', '预览版：仅思考模式；限流低(RPM 60/TPM 50万)'],
  ['text-embedding-v4', 'Qwen3-Embedding 系列；Batch 调用半价 0.25 元/百万；维度 64~2048 可选；单次最大输入 8192 token；无免费额度'],
  ['text-embedding-v3', 'Batch 调用半价 0.25 元/百万；维度 64~1024 可选；单次最大输入 8192 token；无免费额度'],
  ['qwen3-vl-embedding', '视觉-文本向量；最大输入 32K；无免费额度'],
  ['qwen3-vl-rerank', '视觉-文本重排序（输出相关度分数，非向量）；最大输入 120K；无免费额度'],
  ['tongyi-embedding-vision-plus', '免费额度挂在 -2026-03-06 快照 id 上（100 万，至 2026-07-23），基础别名无额度'],
  ['tongyi-embedding-vision-flash', '免费额度挂在 -2026-03-06 快照 id 上（100 万，至 2026-06-19），基础别名无额度'],
]

// 展开逻辑对齐 desktop：别名独立成行，display_name 附日期段；thinking 价 = out_text
function expandSeeds(): ModelDef[] {
  const notesById = new Map(NOTES)
  const out: ModelDef[] = []
  for (const [ids, category, displayName, modalities, ctx, tiers] of SEEDS) {
    const mainId = ids[0]
    for (const id of ids) {
      let rowDisplayName = displayName
      if (id !== mainId && id.startsWith(`${mainId}-`)) {
        rowDisplayName = `${displayName} ${id.slice(mainId.length + 1)}`
      }
      out.push({
        id,
        category,
        provider: 'dashscope',
        display_name: rowDisplayName,
        modalities: JSON.stringify(modalities),
        context_window: ctx > 0 ? ctx : null,
        notes: notesById.get(id) ?? null,
        deprecated: false,
        updated_at: '2026-06-12T00:00:00Z',
        pricing: tiers.map(([min, max, inText, inImage, inVideo, inAudio, outText, outAudio]) => ({
          tier_min_tokens: min,
          tier_max_tokens: max,
          price_input_text: inText,
          price_input_image: inImage,
          price_input_video: inVideo,
          price_input_audio: inAudio,
          price_output_text: outText,
          price_output_text_thinking: outText,
          price_output_audio: outAudio,
        })),
      })
    }
  }
  return out
}

export const MODEL_REGISTRY: ModelDef[] = expandSeeds()

export function getModelDef(id: string): ModelDef | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id)
}

/** 对齐 desktop db.rs::bills_text_with_audio：3.8 Omni 起输出语音时文本另计费 */
export function billsTextWithAudio(modelId: string): boolean {
  return modelId.startsWith('qwen3.8-omni')
}

export function parseModalities(m: ModelDef): string[] {
  try { return JSON.parse(m.modalities ?? '[]') as string[] } catch { return [] }
}

// ── 功能绑定规格（与 desktop ModelDialog FEATURE_SPECS 同源；mobile 先用前三个） ──

export interface FeatureSpec {
  feature: string
  label: string
  category: ModelCategory
  hint: string
  requiredModalities?: string[]
  allowedCategories?: ModelCategory[]
}

export const FEATURE_SPECS: readonly FeatureSpec[] = [
  { feature: 'fairy_chat', label: '常规聊天', category: 'text', hint: '主对话与文字思考' },
  { feature: 'fairy_omni_chat', label: '全模态聊天', category: 'realtime', hint: '语音实时会话', allowedCategories: ['realtime'] },
  { feature: 'session_title', label: '会话自动起标题', category: 'text', hint: '会话累计若干轮后生成 3-8 字标题（建议低价模型）' },
]

/** 某 feature 可选的模型（按 allowedCategories/requiredModalities 过滤，对齐 desktop 选择器规则） */
export function modelsForFeature(spec: FeatureSpec): ModelDef[] {
  return MODEL_REGISTRY.filter((m) => {
    if (m.deprecated) return false
    if (spec.allowedCategories && !spec.allowedCategories.includes(m.category)) return false
    if (!spec.allowedCategories && m.category === 'embedding') return false
    if (spec.requiredModalities) {
      const mods = parseModalities(m)
      if (!spec.requiredModalities.every((r) => mods.includes(r))) return false
    }
    return true
  })
}
