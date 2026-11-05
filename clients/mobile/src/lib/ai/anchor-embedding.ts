// ══════════════════════════════════════════════
// 锚点句嵌入 — 锚点域地图的语义定位
//   · DashScope text-embedding-v4（OpenAI 兼容 /v1/embeddings），256 维够聚类用
//   · 已存向量从桌面端 API 拉取，只对缺失的锚点增量嵌入并回存（每条锚点只花一次钱）
//   · 只复用当前绑定模型算出的向量：换模型后旧向量不在同一语义空间，视为缺失重嵌
//   · 调用计入 model_call_log（feature: anchor_embedding）
//
// 手机端差异：向量表在桌面端，这里依赖局域网。桌面端连不上时抛 DesktopUnreachableError，
// 不嵌入也不返回空——否则会把全部锚点重嵌一遍，钱花了还存不回去。
// ══════════════════════════════════════════════

import { loadConfig, getDashScopeApiKey } from '../agent/agent-config'
import { logModelUsage } from '../llm/model-usage'
import { solevupGetActiveModelApiKey, solevupGetFeatureBinding } from '../solevupdb'
import { fetchAnchorEmbeddings, isDesktopUnreachable, saveAnchorEmbeddings } from '../desktop-api'

const EMBED_DIMS = 256
const BATCH_SIZE = 10 // text-embedding-v4 单次最多 10 条

export async function loadStoredEmbeddings(model: string): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>()
  try {
    for (const row of await fetchAnchorEmbeddings()) {
      if (row.model !== model) continue // 别的模型算的向量不能和当前模型的混着比余弦
      try {
        const v = JSON.parse(row.vector) as unknown
        if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number')) {
          map.set(row.anchor_id, v as number[])
        }
      } catch { /* 损坏行跳过，会被重新嵌入 */ }
    }
  } catch (e) {
    if (isDesktopUnreachable(e)) throw e
    console.error('[AnchorEmbed] 读取已存向量失败', e)
  }
  return map
}

interface EmbeddingsApiResponse {
  data?: Array<{ index: number; embedding: number[] }>
  usage?: { prompt_tokens?: number; total_tokens?: number }
  error?: { message?: string }
}

/**
 * 确保所有锚点都有向量：缺失的增量嵌入并回存。
 * 返回完整 anchorId → vector 映射；完全没有可用向量且无法嵌入时返回空 Map（调用方回退布局）。
 * 桌面端连不上时抛 DesktopUnreachableError。
 */
export async function ensureAnchorEmbeddings(
  anchors: ReadonlyArray<{ id: string; keyword: string }>,
): Promise<Map<string, number[]>> {
  const model = (await solevupGetFeatureBinding('anchor_embedding').catch(() => null)) || 'text-embedding-v4'
  const stored = await loadStoredEmbeddings(model)
  const missing = anchors.filter((a) => !stored.has(a.id))
  if (missing.length === 0) return stored

  const config = await loadConfig()
  const synced = await solevupGetActiveModelApiKey().catch(() => null)
  const apiKey = synced?.apiKey || getDashScopeApiKey(config) || ''
  if (!apiKey) return stored // 无 key：只用已存的，缺的回退

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE)
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    let billed = false
    try {
      const res = await fetch(`${config.openaiApiBase}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          input: batch.map((a) => a.keyword),
          dimensions: EMBED_DIMS,
          encoding_format: 'float',
        }),
      })
      const json = (await res.json()) as EmbeddingsApiResponse
      if (!res.ok || !json.data) throw new Error(json.error?.message || `embeddings HTTP ${res.status}`)

      const got = json.data
        .filter((d) => Array.isArray(d.embedding) && batch[d.index])
        .map((d) => ({ anchorId: batch[d.index].id, vector: d.embedding }))
      for (const g of got) stored.set(g.anchorId, g.vector)

      // 手机端差异：先记账再回存。嵌入和回存之间桌面端可能掉线，这笔钱已经花了，不能漏记
      billed = true
      void logModelUsage({
        feature: 'anchor_embedding',
        modelId: model,
        startedAt,
        durationMs: Date.now() - t0,
        usage: {
          prompt_tokens: json.usage?.prompt_tokens ?? 0,
          completion_tokens: 0,
          total_tokens: json.usage?.total_tokens ?? 0,
        },
      })

      await saveAnchorEmbeddings(got.map((g) => ({
        anchor_id: g.anchorId,
        model,
        dims: g.vector.length,
        vector: JSON.stringify(g.vector.map((x) => Number(x.toFixed(6)))),
      })))
    } catch (e) {
      console.error('[AnchorEmbed] 嵌入失败', e)
      if (!billed) {
        void logModelUsage({
          feature: 'anchor_embedding',
          modelId: model,
          startedAt,
          durationMs: Date.now() - t0,
          success: false,
          errorMessage: e instanceof Error ? e.message : String(e),
        })
      }
      break // 断网/限流时不再硬试，下次打开地图自动补
    }
  }
  return stored
}
