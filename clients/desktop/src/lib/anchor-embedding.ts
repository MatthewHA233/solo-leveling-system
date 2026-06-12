// ══════════════════════════════════════════════
// 锚点句嵌入 — 锚点域地图的语义定位
//   · DashScope text-embedding-v4（OpenAI 兼容 /v1/embeddings），256 维够聚类用
//   · 已存向量从本地 API 拉取，只对缺失的锚点增量嵌入并回存（每条锚点只花一次钱）
//   · 调用计入 model_call_log（feature: anchor_embedding）
// ══════════════════════════════════════════════

import { loadConfig, getDashScopeApiKey } from './agent/agent-config'
import { getFeatureModel, logModelUsage } from './model-audit'
import { fetchAnchorEmbeddings, saveAnchorEmbeddings } from './local-api'

const EMBED_DIMS = 256
const BATCH_SIZE = 10 // text-embedding-v4 单次最多 10 条

export async function loadStoredEmbeddings(): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>()
  try {
    for (const row of await fetchAnchorEmbeddings()) {
      try {
        const v = JSON.parse(row.vector) as unknown
        if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number')) {
          map.set(row.anchor_id, v as number[])
        }
      } catch { /* 损坏行跳过，会被重新嵌入 */ }
    }
  } catch (e) {
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
 */
export async function ensureAnchorEmbeddings(
  anchors: ReadonlyArray<{ id: string; keyword: string }>,
): Promise<Map<string, number[]>> {
  const stored = await loadStoredEmbeddings()
  const missing = anchors.filter((a) => !stored.has(a.id))
  if (missing.length === 0) return stored

  const config = loadConfig()
  const apiKey = getDashScopeApiKey(config) ?? ''
  if (!apiKey) return stored // 无 key：只用已存的，缺的回退

  const model = await getFeatureModel('anchor_embedding', 'text-embedding-v4')
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE)
    const startedAt = new Date().toISOString()
    const t0 = performance.now()
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
      await saveAnchorEmbeddings(got.map((g) => ({
        anchor_id: g.anchorId,
        model,
        dims: g.vector.length,
        vector: JSON.stringify(g.vector.map((x) => Number(x.toFixed(6)))),
      })))

      void logModelUsage({
        feature: 'anchor_embedding',
        modelId: model,
        startedAt,
        durationMs: Math.round(performance.now() - t0),
        usage: {
          prompt_tokens: json.usage?.prompt_tokens ?? 0,
          completion_tokens: 0,
          total_tokens: json.usage?.total_tokens ?? 0,
        },
      })
    } catch (e) {
      console.error('[AnchorEmbed] 嵌入失败', e)
      void logModelUsage({
        feature: 'anchor_embedding',
        modelId: model,
        startedAt,
        durationMs: Math.round(performance.now() - t0),
        success: false,
        errorMessage: e instanceof Error ? e.message : String(e),
      })
      break // 断网/限流时不再硬试，下次打开地图自动补
    }
  }
  return stored
}
