// ══════════════════════════════════════════════
// 模型注册表（mobile 版）— 种子与 desktop db.rs seed_model_registry / jev.rs 同源
//
// 真正的模型库在 SQLite（model_registry / model_pricing），和 desktop 双向同步：
// 两端都导出，收到后按行合并，updated_at 新的赢，删除靠 deleted_at 标记传过去（SolevupDb.mergeModelCatalog）。
// 这里的静态种子在「还没和 desktop 同步过」时写进库垫底；同步过时只补库里缺的行，让费用能算、绑定能选。
// Anthropic 的模型不在种子里：两端各自从 models.dev 拉（models-dev.ts、pullAnthropicModels），启动时拉一次，模型中心里也能手动拉。
// models.dev 和 Anthropic 一样从「网络代理」的端口出去（AppProxy.kt），没配端口时跟随系统代理或 VPN。
// ⚠ 对齐流程：desktop 改种子后，把本文件 SEEDS/NOTES 等与之逐条比对更新（结构刻意保持逐行可对照）。
// 数据来源：cn-beijing 百炼价目（元/百万 token）；Vercel AI Gateway（美元折算成元）。
// ══════════════════════════════════════════════

import { hasProxyPort, isConnectError } from '../network'
import { solevupListModelCatalogJson, solevupSeedModelCatalogIfEmpty, solevupUpsertModelCatalog } from '../solevupdb'
import { MODELS_DEV_URL, fetchAnthropicCatalog } from './models-dev'

/** decision = 决策模型（只做选择题 / 打分题，走 Vercel AI Gateway） */
export type ModelCategory = 'text' | 'omni' | 'realtime' | 'embedding' | 'asr' | 'decision'

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
  currency?: string              // 'CNY' | 'USD'
  deleted_at?: string | null     // 删除标记，只在同步里出现；读库时不返回带标记的行
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

  // ── 流式语音识别（Fun-ASR 协议，价目 2026-09-29 核对）：输入主要是音频，按 token 计 ──
  [['qwen-audio-3.1-asr-flash-streaming'], 'asr', 'Qwen-Audio 3.1 ASR Flash Streaming', ['audio_in'], 8_192, [
    [0, null, null, null, null, 6.0, 4.5, null],
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
  ['qwen-audio-3.1-asr-flash-streaming', '流式识别（run-task 协议）；支持即时热词与对话上下文；输入含上下文文本，统一按音频输入价记'],
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

// 对齐 desktop jev.rs：模型库统一按「元 / 百万 token」记价；Vercel 标的是美元，按这个汇率折算（备注里留着美元原价）
const USD_TO_CNY = 7.1

// 对齐 desktop jev.rs DECISION_MODELS：(id, 显示名, 能看图, 上下文, 美元 / 百万输入 token, 备注)
const DECISION_SEEDS: ReadonlyArray<[string, string, boolean, number, number, string]> = [
  ['microsoft/microsoft-decision-1', 'Microsoft Decision-1', false, 32_768, 0.042,
    '推荐·基础判断｜灰色地带 10 题实测 10/10，有把握却判错 0｜最果断｜不留存、不拿去训练｜Vercel AI Gateway，$0.042/百万输入，输出免费'],
  ['typesafe-ai/jev', 'Jev', false, 32_000, 0.042,
    '灰色地带 10 题实测 9/10，有把握却判错 0｜最谨慎：拿不准时概率摊开，少误伤｜部分不留存、不拿去训练｜Vercel AI Gateway，$0.042/百万输入，输出免费'],
  ['liquid/d1', 'Liquid d1', true, 65_536, 0.040,
    '推荐·看图判断｜灰色地带 10 题实测 10/10，有把握却判错 0｜能看截图｜会留存、可能拿去训练（发截图要慎重）｜Vercel AI Gateway，$0.04/百万输入，输出免费'],
]

// 种子写库时的 updated_at；只是占位，desktop 同步过来的整表会覆盖
const SEED_UPDATED_AT = '2026-10-10T00:00:00Z'

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
        updated_at: SEED_UPDATED_AT,
        currency: 'CNY',
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

  // 对齐 desktop jev.rs seed_decision_models：价格折成元，只记输入价，输出免费
  for (const [id, name, vision, ctx, usd, note] of DECISION_SEEDS) {
    const cny = Math.round(usd * USD_TO_CNY * 10_000) / 10_000
    out.push({
      id,
      category: 'decision',
      provider: 'vercel',
      display_name: name,
      modalities: JSON.stringify(vision ? ['text', 'image'] : ['text']),
      context_window: ctx,
      notes: note,
      deprecated: false,
      updated_at: SEED_UPDATED_AT,
      currency: 'CNY',
      pricing: [{
        tier_min_tokens: 0,
        tier_max_tokens: null,
        price_input_text: cny,
        price_input_image: vision ? cny : null,
        price_input_video: null,
        price_input_audio: null,
        price_output_text: 0,
        price_output_text_thinking: null,
        price_output_audio: null,
      }],
    })
  }
  return out
}

/** 随包种子；费用以库里的为准，这份只用来垫底和开机前的同步读取 */
export const MODEL_SEEDS: ModelDef[] = expandSeeds()

// ── 库里的模型表 + 内存缓存（聊天气泡要同步拿模型定义，不能每次 await） ──

let catalogCache: ModelDef[] = MODEL_SEEDS
let catalogById = new Map(MODEL_SEEDS.map((m) => [m.id, m]))
let ensurePromise: Promise<ModelDef[]> | null = null

function setCatalogCache(models: ModelDef[]): ModelDef[] {
  // 原生模块不可用或读出空表时留着种子，别让选择器和计费说明变空
  if (models.length === 0) return catalogCache
  catalogCache = models
  catalogById = new Map(models.map((m) => [m.id, m]))
  return catalogCache
}

/** 重新读库刷新缓存（同步导入了新的 model_registry 后调用） */
export async function refreshModelCatalog(): Promise<ModelDef[]> {
  try {
    const json = await solevupListModelCatalogJson()
    return setCatalogCache(JSON.parse(json) as ModelDef[])
  } catch (e) {
    console.warn('[ModelRegistry] list catalog failed:', e)
    return catalogCache
  }
}

/** 对齐 desktop 启动时跑种子：没同步过写整表，同步过只补缺的行（见 SolevupDb.seedModelCatalogIfEmpty），然后载入缓存；一次启动只跑一遍，失败时下次调用重试 */
export function ensureModelCatalog(): Promise<ModelDef[]> {
  if (!ensurePromise) {
    ensurePromise = solevupSeedModelCatalogIfEmpty(JSON.stringify(MODEL_SEEDS))
      .then(() => refreshModelCatalog())
      .catch((e) => {
        console.warn('[ModelRegistry] seed catalog failed:', e)
        ensurePromise = null
        return catalogCache
      })
  }
  return ensurePromise
}

const MODELS_DEV_TIMEOUT_MS = 30_000

/** 取 models.dev 的全量目录（JSON 文本）。错误文字接在「从 models.dev 拉模型清单失败：」后面 */
async function loadModelsDev(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS)
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal })
    if (!res.ok) throw new Error(`返回 ${res.status}`)
    return await res.text()
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    // RN 的 fetch 连不上时只说 Network request failed，拿不到底层原因
    if (controller.signal.aborted || isConnectError(detail) || /network request failed/i.test(detail)) {
      const what = controller.signal.aborted ? '超时没响应' : '连不上'
      throw new Error(hasProxyPort()
        ? `${what}。确认代理软件开着，端口对得上（Fairy 设置 → 网络）`
        : `${what}。确认手机的 VPN 或系统代理开着，或者到 Fairy 设置 → 网络 填代理端口`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 从 models.dev 拉 Anthropic 的模型清单和价目写进库并刷新缓存，返回写入的行数。失败时抛出，message 可直接展示 */
export async function pullAnthropicModels(): Promise<number> {
  const rows = await fetchAnthropicCatalog(loadModelsDev)
  await ensureModelCatalog()
  const count = await solevupUpsertModelCatalog(JSON.stringify(rows))
  await refreshModelCatalog()
  return count
}

/** 最近一次载入的模型表（同步读取） */
export function listCachedModels(): ModelDef[] {
  return catalogCache
}

/** 兼容旧调用方的只读视图 */
export const MODEL_REGISTRY: ReadonlyArray<ModelDef> = MODEL_SEEDS

export function getModelDef(id: string): ModelDef | undefined {
  return catalogById.get(id)
}

/** 对齐 desktop db.rs::bills_text_with_audio：3.8 Omni 起输出语音时文本另计费 */
export function billsTextWithAudio(modelId: string): boolean {
  return modelId.startsWith('qwen3.8-omni')
}

export function parseList(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function parseModalities(m: ModelDef): string[] {
  return parseList(m.modalities)
}

export function hasAllModalities(model: ModelDef, required: readonly string[] | undefined): boolean {
  if (!required || required.length === 0) return true
  const modalities = new Set(parseList(model.modalities))
  return required.every((m) => modalities.has(m))
}

/** 模型能不能看图。不在模型库里的让它试，不支持时接口会报错 */
export function modelSeesImages(modelId: string): boolean {
  const def = getModelDef(modelId)
  return !def || hasAllModalities(def, ['image'])
}

// ── 功能绑定规格（与 desktop ModelDialog FEATURE_SPECS 同源） ──

export interface FeatureSpec {
  feature: string
  label: string
  category: ModelCategory
  hint: string
  requiredModalities?: readonly string[]
  allowedCategories?: readonly ModelCategory[]
}

export const FEATURE_SPECS: readonly FeatureSpec[] = [
  { feature: 'fairy_chat', label: 'Fairy 常规聊天', category: 'text', hint: '主对话与文字思考' },
  { feature: 'fairy_omni_chat', label: 'Fairy 全模态聊天', category: 'realtime', hint: '语音/摄像头实时会话' },
  { feature: 'session_title', label: '会话自动起标题', category: 'text', hint: '会话累计若干轮后生成 3-8 字标题（建议低价模型）' },
  { feature: 'bili_omni_transcribe', label: 'B 站音视频全模态转录', category: 'omni', hint: '带音轨的视频文件转录；必须同时支持 video + audio_in', requiredModalities: ['video', 'audio_in'], allowedCategories: ['omni'] },
  { feature: 'bili_visual_transcribe', label: 'B 站仅画面转录', category: 'text', hint: '只读视频画面/屏幕正文；qwen3.6-plus 这类视频模型只能放这里', requiredModalities: ['video'] },
  { feature: 'bili_audio_transcribe', label: 'B 站仅音频转录', category: 'omni', hint: '提取音轨后走 input_audio；只显示支持音频输入的模型', requiredModalities: ['audio_in'], allowedCategories: ['omni'] },
  { feature: 'ocr_article_stitch', label: 'B 站滚动文章·缝合', category: 'text', hint: '滚动文章逐帧 OCR（qwen-vl-ocr）后，把碎片去重缝合成带时间戳字幕的文本模型（建议中高质量）' },
  { feature: 'context_anchor', label: '语境锚定', category: 'text', hint: '对着语境卡聊天时定位原文片段 + 提取锚点句' },
  { feature: 'thought_distill', label: '想法沉淀', category: 'text', hint: '日常聊天判断值不值得记成想法卡（建议低价模型）' },
  { feature: 'anchor_extract', label: '框选锚点提取', category: 'text', hint: '手动框选语境后从原话提取锚点句' },
  { feature: 'anchor_embedding', label: '锚点语义嵌入', category: 'embedding', hint: '锚点域地图的球定位（语义近 = 空间近）', allowedCategories: ['embedding'] },
  { feature: 'fairy_voice_asr', label: 'Fairy 语音识别', category: 'asr', hint: '按住说话的流式识别（带热词与对话上下文）', allowedCategories: ['asr'] },
  { feature: 'anchor_cluster_name', label: '锚点域簇命名', category: 'text', hint: '给认知地图聚簇起 2~6 字主题名（建议低价模型）' },
  { feature: 'motive_blueprint', label: '协议志·动机蓝图', category: 'text', hint: '把一条动机展开成行动方向与具体步骤（建议中高质量模型）' },
  { feature: 'protocol_genesis', label: '协议志·开局', category: 'text', hint: '两份清单之后：系统照一遍、愿望金字塔、未来年表（建议高质量模型，默认千问 3.8 Max）' },
  { feature: 'protocol_gray', label: '协议·灰色地带判断', category: 'decision', hint: '白名单里标「灰」的内容在前台时，按协议用意和窗口标题判断是学习还是娱乐', allowedCategories: ['decision'] },
  { feature: 'protocol_gray_vision', label: '协议·灰色地带判断（看图）', category: 'decision', hint: '标题看不出来时看截图判断；必须能看图（截图会发给模型，注意它的数据留存）', requiredModalities: ['image'], allowedCategories: ['decision'] },
]

export const FEATURE_LABEL = new Map(FEATURE_SPECS.map((f) => [f.feature, f.label]))

/** 对齐 desktop matchesFeatureSpec */
export function matchesFeatureSpec(model: ModelDef, spec: FeatureSpec): boolean {
  if (spec.allowedCategories && !spec.allowedCategories.includes(model.category)) return false
  if (spec.requiredModalities) return hasAllModalities(model, spec.requiredModalities)
  return model.category === spec.category
}

/** 某 feature 可选的模型；不传 models 时用缓存 */
export function modelsForFeature(spec: FeatureSpec, models: ReadonlyArray<ModelDef> = catalogCache): ModelDef[] {
  return models.filter((m) => matchesFeatureSpec(m, spec))
}

// 模块加载就垫底：第一条用量落库前价目就得在库里
void ensureModelCatalog()
