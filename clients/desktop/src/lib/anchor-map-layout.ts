// ══════════════════════════════════════════════
// 锚点域布局 — 语义投影 + 聚簇 + 簇命名（flomo 认知地图架构）
//   · 球 = 锚点句：位置 = 向量 PCA 降维到 2D（语义近 = 空间近）
//   · 山 = 聚簇（≥2 球挤成一团）：名字由 AI 起（不是任何锚点原文），按成员 hash 缓存
//   · 手写幂迭代 PCA / 距离聚簇 / 重叠松弛，零依赖
// ══════════════════════════════════════════════

import { queryModel } from './llm/api'
import { createUserMessage } from './llm/types'
import { loadConfig, getDashScopeApiKey } from './agent/agent-config'
import { getFeatureModel } from './model-audit'
import { fetchClusterNames, saveClusterName } from './local-api'

// ── 确定性工具 ────────────────────────────────

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/** 簇成员指纹：锚点 id 排序拼接的 FNV hash（成员不变 → hash 不变 → 不重复起名）*/
export function clusterMemberHash(anchorIds: readonly string[]): string {
  const joined = [...anchorIds].sort().join('|')
  let h = 2166136261
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ── PCA 投影（幂迭代取前两主成分）──────────────

function normalizeVec(v: number[]): void {
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function powerIteration(rows: number[][], seed: string): number[] {
  const d = rows[0].length
  const v = new Array<number>(d)
  for (let i = 0; i < d; i++) v[i] = hash01(seed + i) - 0.5
  normalizeVec(v)
  for (let iter = 0; iter < 40; iter++) {
    const next = new Array<number>(d).fill(0)
    for (const row of rows) {
      const proj = dot(row, v)
      for (let i = 0; i < d; i++) next[i] += proj * row[i]
    }
    normalizeVec(next)
    for (let i = 0; i < d; i++) v[i] = next[i]
  }
  return v
}

export interface WorldSpec { readonly w: number; readonly h: number; readonly pad: number }

/**
 * 向量 → 世界坐标。两主成分各自缩放铺满画布（小样本下比等比缩放观感好）。
 * 入参只含有向量的锚点；没有向量的由调用方回退处理。
 */
export function projectAnchors(
  entries: ReadonlyArray<{ id: string; vector: number[] }>,
  world: WorldSpec,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (entries.length === 0) return out
  if (entries.length === 1) {
    out.set(entries[0].id, { x: world.w / 2, y: world.h / 2 })
    return out
  }

  const d = entries[0].vector.length
  const mean = new Array<number>(d).fill(0)
  for (const e of entries) for (let i = 0; i < d; i++) mean[i] += e.vector[i]
  for (let i = 0; i < d; i++) mean[i] /= entries.length
  const centered = entries.map((e) => e.vector.map((x, i) => x - mean[i]))

  const p1 = powerIteration(centered, 'pc1')
  const deflated = centered.map((row) => {
    const proj = dot(row, p1)
    return row.map((x, i) => x - proj * p1[i])
  })
  const p2 = powerIteration(deflated, 'pc2')

  const raw = centered.map((row) => ({ u: dot(row, p1), v: dot(row, p2) }))
  let uMin = Infinity; let uMax = -Infinity; let vMin = Infinity; let vMax = -Infinity
  for (const r of raw) {
    if (r.u < uMin) uMin = r.u
    if (r.u > uMax) uMax = r.u
    if (r.v < vMin) vMin = r.v
    if (r.v > vMax) vMax = r.v
  }
  const uSpan = Math.max(uMax - uMin, 1e-6)
  const vSpan = Math.max(vMax - vMin, 1e-6)

  entries.forEach((e, idx) => {
    const r = raw[idx]
    out.set(e.id, {
      x: world.pad + ((r.u - uMin) / uSpan) * (world.w - world.pad * 2),
      y: world.pad + ((r.v - vMin) / vSpan) * (world.h - world.pad * 2),
    })
  })

  relaxOverlap(out, 62, world)
  return out
}

/** 重叠松弛：把贴得过近的球轻推开，保持整体语义布局不变形 */
export function relaxOverlap(
  pos: Map<string, { x: number; y: number }>,
  minDist: number,
  world: WorldSpec,
): void {
  const ids = [...pos.keys()].sort()
  for (let iter = 0; iter < 60; iter++) {
    let moved = false
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!
        const b = pos.get(ids[j])!
        let dx = b.x - a.x
        let dy = b.y - a.y
        let dist = Math.hypot(dx, dy)
        if (dist >= minDist) continue
        if (dist < 1e-3) {
          // 完全重合：按 id 哈希给个确定性方向
          const ang = hash01(ids[i] + ids[j]) * Math.PI * 2
          dx = Math.cos(ang)
          dy = Math.sin(ang)
          dist = 1
        }
        const push = (minDist - dist) / 2 / dist
        pos.set(ids[i], clampToWorld({ x: a.x - dx * push, y: a.y - dy * push }, world))
        pos.set(ids[j], clampToWorld({ x: b.x + dx * push, y: b.y + dy * push }, world))
        moved = true
      }
    }
    if (!moved) break
  }
}

function clampToWorld(p: { x: number; y: number }, world: WorldSpec): { x: number; y: number } {
  return {
    x: Math.max(world.pad, Math.min(world.w - world.pad, p.x)),
    y: Math.max(world.pad, Math.min(world.h - world.pad, p.y)),
  }
}

// ── 余弦聚簇（嵌入空间，并查集 + 自适应阈值）─────
// 阈值随语料自身的相似度分布走：mean + 0.5σ，夹在 [0.35, 0.55]
// （2026-06-11 用真实锚点标定：同主题对 0.37~0.39，跨主题 ≤0.32）

function cosineSim(a: number[], b: number[]): number {
  let d = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na * nb)
  return denom > 0 ? d / denom : 0
}

export function clusterByCosine(
  entries: ReadonlyArray<{ id: string; vector: number[] }>,
): string[][] {
  if (entries.length === 0) return []
  if (entries.length === 1) return [[entries[0].id]]

  const sims: Array<{ i: number; j: number; sim: number }> = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      sims.push({ i, j, sim: cosineSim(entries[i].vector, entries[j].vector) })
    }
  }
  const mean = sims.reduce((acc, s) => acc + s.sim, 0) / sims.length
  const variance = sims.reduce((acc, s) => acc + (s.sim - mean) ** 2, 0) / sims.length
  const threshold = Math.min(0.55, Math.max(0.35, mean + 0.5 * Math.sqrt(variance)))

  const parent = new Map<string, string>()
  const find = (a: string): string => {
    let root = a
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = a
    while (cur !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  for (const e of entries) parent.set(e.id, e.id)
  for (const s of sims) {
    if (s.sim > threshold) parent.set(find(entries[s.i].id), find(entries[s.j].id))
  }
  const groups = new Map<string, string[]>()
  for (const e of entries) {
    const root = find(e.id)
    const list = groups.get(root)
    if (list) list.push(e.id)
    else groups.set(root, [e.id])
  }
  return [...groups.values()]
}

// ── 距离聚簇（并查集；回退布局时用）──────────────

export function clusterByDistance(
  items: ReadonlyArray<{ id: string; x: number; y: number }>,
  linkDist: number,
): string[][] {
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    let root = a
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = a
    while (cur !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  for (const it of items) parent.set(it.id, it.id)
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const dx = items[i].x - items[j].x
      const dy = items[i].y - items[j].y
      if (dx * dx + dy * dy < linkDist * linkDist) parent.set(find(items[i].id), find(items[j].id))
    }
  }
  const groups = new Map<string, string[]>()
  for (const it of items) {
    const root = find(it.id)
    const list = groups.get(root)
    if (list) list.push(it.id)
    else groups.set(root, [it.id])
  }
  return [...groups.values()]
}

// ── 簇命名（AI 起名 + 缓存）────────────────────

const NAME_SYSTEM_PROMPT = `你是「区域命名者」。给一组同主题的句子起一个简洁的关键词式名字（2~8 字），像地图上的地名。
要求：直接用这组句子共同指向的核心关键词（参考风格："macOS 截图""GitHub 安全""工程化学习"），宁可具体，不要抽象拔高，也不要整句照抄。
只输出名字本身，不要引号、标点、解释。`

async function nameClusterWithAI(keywords: readonly string[]): Promise<string | null> {
  const config = loadConfig()
  const apiKey = getDashScopeApiKey(config) ?? ''
  if (!apiKey) {
    console.warn('[AnchorMap] 簇命名跳过：未配置 DashScope API key')
    return null
  }
  const model = await getFeatureModel('anchor_cluster_name', 'qwen3.6-flash')
  const userMsg = createUserMessage(`这组锚点句：\n${keywords.map((k) => `- ${k}`).join('\n')}`)
  const stream = queryModel([userMsg], {
    apiKey,
    apiBase: config.openaiApiBase,
    model,
    systemPrompt: NAME_SYSTEM_PROMPT,
    maxTokens: 30,
    feature: 'anchor_cluster_name',
  })
  let full = ''
  for await (const chunk of stream) {
    if (chunk.type === 'textDelta') full += chunk.delta
    else if (chunk.type === 'error') {
      // 不能静默吞掉：免费额度耗尽（403）这类错误曾导致整晚回退用锚点原文当山名
      console.error(`[AnchorMap] 簇命名 API 错误（model=${model}）：${chunk.message}`)
      return null
    }
  }
  // 保留词间空格（"macOS 截图"这类中英混排名字更易读），只去引号标点
  const name = full.replace(/["'「」『』#。，！？]/g, '').replace(/\s+/g, ' ').trim()
  if (!name || name.length > 12) return null
  return name
}

export interface ClusterToName {
  readonly hash: string
  readonly keywords: readonly string[]
}

/** 进行中的起名请求（按簇 hash 去重）：React dev 双跑 effect / 并发渲染时避免同簇重复调 AI */
const inflightNames = new Map<string, Promise<string | null>>()

function nameClusterDeduped(c: ClusterToName): Promise<string | null> {
  const pending = inflightNames.get(c.hash)
  if (pending) return pending
  const p = nameClusterWithAI(c.keywords).finally(() => inflightNames.delete(c.hash))
  inflightNames.set(c.hash, p)
  return p
}

/**
 * 解析全部簇名：缓存命中直接用；未命中的逐个 AI 起名并写缓存。
 * AI 失败时回退到簇内权重最高锚点句的截断（不写缓存，下次重试 AI）。
 */
export async function resolveClusterNames(
  clusters: ReadonlyArray<ClusterToName>,
  onName?: (hash: string, name: string) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let cached = new Map<string, string>()
  try {
    cached = new Map((await fetchClusterNames()).map((r) => [r.member_hash, r.name]))
  } catch (e) {
    console.error('[AnchorMap] 读取簇名缓存失败', e)
  }

  for (const c of clusters) {
    const hit = cached.get(c.hash)
    if (hit) {
      out.set(c.hash, hit)
      onName?.(c.hash, hit)
      continue
    }
    // AI 失败时回退用完整锚点句（不截断；地图侧会自动折两行）
    const fallback = c.keywords[0] || '未命名'
    let name: string | null = null
    try {
      name = await nameClusterDeduped(c)
    } catch (e) {
      console.error('[AnchorMap] 簇命名失败', e)
    }
    if (name) {
      out.set(c.hash, name)
      onName?.(c.hash, name)
      try { await saveClusterName(c.hash, name) }
      catch (e) { console.error('[AnchorMap] 簇名写缓存失败', e) }
    } else {
      out.set(c.hash, fallback)
      onName?.(c.hash, fallback)
    }
  }
  return out
}
