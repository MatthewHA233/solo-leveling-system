// ══════════════════════════════════════════════
// models.dev：公开的模型目录（MIT 许可）。Anthropic 的模型清单和价目从这里拉，不随包写死
//   GET https://models.dev/api.json：全量约 6 MB（压缩后约 0.7 MB），没有按提供商取的接口
//   国内直连不稳（手机上实测超时），和 Anthropic 一样从「网络代理」的端口出去；请求由两端各自发，这里只管解析
// 两端逐字一致（桌面端和手机端都是 lib/models/models-dev.ts），改要同时改两端
// ══════════════════════════════════════════════

export const MODELS_DEV_URL = 'https://models.dev/api.json'
const PROVIDER_ANTHROPIC = 'anthropic'

// 模型库的一行，字段同两端各自的 ModelDef（local-api.ts / registry.ts）；这里单独定义，文件才能两端同文
export interface CatalogPricingTier {
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

export interface CatalogRow {
  id: string
  category: 'text'
  provider: string
  display_name: string | null
  modalities: string | null
  context_window: number | null
  notes: string | null
  deprecated: boolean
  updated_at: string
  currency: string
  pricing: CatalogPricingTier[]
}

type Json = Record<string, unknown>

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

// models.dev 的输入模态 → 模型库的写法；pdf 这类模型库里没有对应项的不记
const MODALITY: Record<string, string> = { text: 'text', image: 'image', video: 'video', audio: 'audio_in' }

function modalitiesOf(model: Json): string[] {
  const input = isObject(model.modalities) && Array.isArray(model.modalities.input) ? model.modalities.input : []
  const out = input.map((m) => MODALITY[String(m)]).filter((m): m is string => !!m)
  return out.length > 0 ? out : ['text']
}

/** 价格阶梯：cost 本身是起步价，cost.tiers 里每项是输入超过 size 个 token 之后的价。返回各档的价目，从低到高 */
function costSteps(cost: Json): { from: number; cost: Json }[] {
  const steps = (Array.isArray(cost.tiers) ? cost.tiers : [])
    .filter(isObject)
    .map((c) => ({ from: isObject(c.tier) && c.tier.type === 'context' ? num(c.tier.size) : null, cost: c }))
    .filter((s): s is { from: number; cost: Json } => s.from !== null && s.from > 0)
    .sort((a, b) => a.from - b.from)
  return [{ from: 0, cost }, ...steps]
}

function pricingOf(steps: { from: number; cost: Json }[]): CatalogPricingTier[] {
  return steps.map((step, i) => {
    const input = num(step.cost.input)
    const output = num(step.cost.output)
    return {
      tier_min_tokens: step.from,
      tier_max_tokens: steps[i + 1]?.from ?? null,
      price_input_text: input,
      price_input_image: input,
      price_input_video: null,
      price_input_audio: null,
      price_output_text: output,
      price_output_text_thinking: output,
      price_output_audio: null,
    }
  })
}

/** 备注：模型库的价目表里没有列的那几项（缓存价、最多输出、发布日期） */
function noteOf(model: Json, steps: { from: number; cost: Json }[]): string {
  const parts: string[] = []
  if (steps.length > 1) parts.push(`按输入长度分 ${steps.length} 档`)
  const prices = (field: string) => {
    const values = steps.map((s) => num(s.cost[field]))
    return values.every((v): v is number => v !== null) ? values.map((v) => `$${v}`).join(' / ') : null
  }
  const write = prices('cache_write')
  const read = prices('cache_read')
  const cache = [write && `缓存写入 ${write}`, read && `缓存命中 ${read}`].filter(Boolean).join('，')
  if (cache) parts.push(`${cache}（每百万 token）`)
  const output = isObject(model.limit) ? num(model.limit.output) : null
  if (output) parts.push(`最多输出 ${+(output / 10_000).toFixed(1)} 万`)
  const released = str(model.release_date)
  if (released) parts.push(`${released} 发布`)
  return parts.join('；')
}

/** 从 api.json 里取出 Anthropic 的模型，展开成模型库的行（美元原价，currency = USD）。一个都没有时抛出 */
export function anthropicRowsFromModelsDev(api: unknown, now: string): CatalogRow[] {
  const provider = isObject(api) ? api[PROVIDER_ANTHROPIC] : null
  const models = isObject(provider) && isObject(provider.models) ? provider.models : {}
  const rows: CatalogRow[] = []
  for (const [id, model] of Object.entries(models)) {
    if (!id.trim() || !isObject(model)) continue
    const steps = isObject(model.cost) ? costSteps(model.cost) : []
    rows.push({
      id,
      category: 'text',
      provider: PROVIDER_ANTHROPIC,
      display_name: str(model.name) ?? id,
      modalities: JSON.stringify(modalitiesOf(model)),
      context_window: isObject(model.limit) ? num(model.limit.context) : null,
      notes: noteOf(model, steps) || null,
      deprecated: model.status === 'deprecated',
      updated_at: now,
      currency: 'USD',
      pricing: pricingOf(steps),
    })
  }
  if (rows.length === 0) throw new Error('返回的数据里没有 Anthropic 的模型')
  return rows
}

/**
 * 拉一次 models.dev，返回 Anthropic 的模型行。load 取回 api.json 的文本，两端各自实现：
 * 桌面端在 Rust 里走代理发（fetch_models_dev），手机端用 fetch、代理在 OkHttp 层（AppProxy.kt）。
 * 失败时抛出，message 可直接展示
 */
export async function fetchAnthropicCatalog(load: () => Promise<string>, now: string = new Date().toISOString()): Promise<CatalogRow[]> {
  try {
    return anthropicRowsFromModelsDev(JSON.parse(await load()), now)
  } catch (e) {
    throw new Error(`从 models.dev 拉模型清单失败：${e instanceof Error ? e.message : String(e)}`)
  }
}
