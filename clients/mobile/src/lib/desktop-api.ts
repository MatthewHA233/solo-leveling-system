// ══════════════════════════════════════════════
// 桌面端局域网 API（mobile 版）— 函数名和语义对齐 desktop src/lib/local-api.ts
//
// 想法卡 / 锚点 / 绑定 / 锚点向量 / 动机去向这些表没有 updated_at，不在同步协议里，
// 桌面端是唯一数据源；手机端不存副本，一律经局域网读写桌面端的 /api/...（端口 39733）。
//
// 地址取已配对设备的 last_base（原生层在听到广播、同步成功时刷新），发请求前用
// /api/sync/hello 确认对面还是这台设备，并且是桌面端（手机互相配对时对端没有这些路由）。
//
// 连不上一律抛 DesktopUnreachableError，绝不静默返回空：
// 调用方要能区分「桌面端上确实没有」和「现在连不上」。
// ══════════════════════════════════════════════

import { listLinkedDevices, verifyLinkedPeer, type LinkedDevice } from './syncclient'

const PROBE_TIMEOUT_MS = 3_000
const REQUEST_TIMEOUT_MS = 15_000
/** 地址确认一次管多久：补发队列一轮要连着发好几个请求，不必每个都先 hello */
const BASE_CACHE_MS = 30_000

interface ApiResponse<T> {
  success: boolean
  data?: T | null
  error?: string | null
}

// ── 错误类型 ──

/** 桌面端连不上：没配对、不在线、超时、请求中途断开 */
export class DesktopUnreachableError extends Error {
  /** true = 写请求已经发出去才断的，桌面端可能已经写入，重试前要先查重 */
  readonly requestSent: boolean

  constructor(message: string, requestSent = false) {
    super(message)
    this.name = 'DesktopUnreachableError'
    this.requestSent = requestSent
  }
}

/** 桌面端连上了，但明确拒绝或返回异常（业务错误、旧版本没有这条路由） */
export class DesktopApiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'DesktopApiError'
    this.status = status
  }
}

export function isDesktopUnreachable(e: unknown): e is DesktopUnreachableError {
  return e instanceof Error && e.name === 'DesktopUnreachableError'
}

// ── 地址解析 ──

let cachedBase: { base: string; token: string; at: number } | null = null

export function invalidateDesktopBase(): void {
  cachedBase = null
}

/**
 * RN 的 OkHttp 默认不限时，地址过期时请求会一直挂着，必须自己 abort。
 * body 也读在超时范围内，返回给调用方的是读完的文本。
 */
async function fetchText(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: abort.signal })
    return { status: res.status, text: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

async function isLiveDesktop(link: LinkedDevice): Promise<boolean> {
  // 地址可能已被 DHCP 分给别的设备，发现广播也可能是假的（同 SyncCoordinator.runRound 的校验）：
  // 想法卡是私人内容，不能写到一台认不出来的机器上。令牌也要确认过才发
  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS))
  const deviceType = await Promise.race([verifyLinkedPeer(link.deviceId).catch(() => null), timer])
  return deviceType != null && deviceType !== 'mobile'
}

/**
 * 找到当前可用的桌面端地址。配了多台时按最近同步优先，取第一台可达的。
 * 注意想法卡不在同步协议里，两台桌面端之间数据不互通。
 */
export async function resolveDesktopBase(): Promise<string> {
  return (await resolveDesktopLink()).base
}

async function resolveDesktopLink(): Promise<{ base: string; token: string }> {
  if (cachedBase && Date.now() - cachedBase.at < BASE_CACHE_MS) return cachedBase

  const links = await listLinkedDevices()
  if (links.length === 0) throw new DesktopUnreachableError('还没有配对桌面端')

  const ordered = [...links].sort((a, b) => (b.lastSyncedAt ?? '').localeCompare(a.lastSyncedAt ?? ''))
  for (const link of ordered) {
    if (await isLiveDesktop(link)) {
      cachedBase = { base: link.lastBase, token: link.authToken, at: Date.now() }
      return cachedBase
    }
  }
  throw new DesktopUnreachableError(`桌面端不可达（${links.map((l) => l.alias).join('、')}）`)
}

// ── 通用调用 ──

export type DesktopMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * 调桌面端任意 /api 路由，返回原始信封 { success, data, error }。
 * 连不上抛 DesktopUnreachableError；响应不是 JSON（路由不存在等）抛 DesktopApiError。
 */
export async function desktopRequest<T>(
  method: DesktopMethod,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const { base, token } = await resolveDesktopLink()
  const auth = { Authorization: `Bearer ${token}` }
  let res: { status: number; text: string }
  try {
    res = await fetchText(
      `${base}${path}`,
      body === undefined
        ? { method, headers: auth }
        : { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      REQUEST_TIMEOUT_MS,
    )
  } catch (e) {
    invalidateDesktopBase()
    const reason = e instanceof Error ? e.message : String(e)
    throw new DesktopUnreachableError(`桌面端不可达：${reason}`, true)
  }
  try {
    return JSON.parse(res.text) as ApiResponse<T>
  } catch {
    throw new DesktopApiError(`桌面端返回异常（HTTP ${res.status}）：${method} ${path}`, res.status)
  }
}

async function requestData<T>(method: DesktopMethod, path: string, body: unknown, failMessage: string): Promise<T> {
  const json = await desktopRequest<T>(method, path, body)
  if (!json.success || !json.data) throw new DesktopApiError(json.error || failMessage)
  return json.data
}

async function requestVoid(method: DesktopMethod, path: string, body: unknown, failMessage: string): Promise<void> {
  const json = await desktopRequest<unknown>(method, path, body)
  if (!json.success) throw new DesktopApiError(json.error || failMessage)
}

// ── Context Cards（语境卡流）──

export interface ContextFeedItem {
  readonly id: string
  readonly kind: 'thought' | 'bili_transcript'
  readonly text: string                    // thought=想法全文；bili=转录摘要
  readonly title: string | null            // bili=视频标题
  readonly cover_url: string | null        // bili=封面
  readonly bvid: string | null
  readonly ref_path: string | null         // bili download_path，展开转录全文用
  readonly source_label: string | null     // thought 语境标签
  readonly source_card_id: string | null   // thought 来源语境卡 id（语境标签点击跳转用）
  readonly created_at: string
  readonly link_broken: boolean             // thought 断链：指向了视频但视频侧未回填锚点（损坏）
}

export async function fetchContextFeed(): Promise<ContextFeedItem[]> {
  return requestData('GET', '/api/context/feed', undefined, '查询语境流失败')
}

export async function addContextCard(text: string, sourceLabel?: string, createdAt?: string, sourceCardId?: string): Promise<string> {
  return requestData('POST', '/api/context/cards', {
    text,
    source_label: sourceLabel ?? null,
    source_card_id: sourceCardId ?? null,
    created_at: createdAt ?? null,
  }, '添加语境卡失败')
}

export async function deleteContextCard(id: string): Promise<void> {
  return requestVoid('DELETE', `/api/context/cards/${id}`, undefined, '删除语境卡失败')
}

// ── 锚点绑定（语境片段 ↔ 原话 ↔ 关键词）──

export type AnchorCategory = 'motive' | 'view' | 'practice'

export interface AnchorRef {
  readonly id: string
  readonly keyword: string
  readonly category: AnchorCategory
}

export interface AnchorBinding {
  readonly id: string
  readonly card_id: string
  readonly start_pos: number
  readonly end_pos: number
  readonly selected_text: string
  readonly user_speech: string       // 你的原话，不 AI 总结
  readonly created_at: string
  readonly anchors: AnchorRef[]
}

export async function fetchCardBindings(cardId: string): Promise<AnchorBinding[]> {
  return requestData('GET', `/api/context/cards/${cardId}/bindings`, undefined, '查询锚点失败')
}

/** 一次取全部锚点绑定（前端按 card_id 分组）。替代「每张卡各发一个请求」，支撑上万卡。 */
export async function fetchAllBindings(): Promise<AnchorBinding[]> {
  return requestData('GET', '/api/context/all-bindings', undefined, '批量查询锚点失败')
}

/** 把 AnchorBinding[] 按 card_id 分组成 Map（顶层加载一次，各卡从 Map 直取，不再单独请求） */
export function groupBindingsByCard(all: readonly AnchorBinding[]): Map<string, AnchorBinding[]> {
  const m = new Map<string, AnchorBinding[]>()
  for (const b of all) {
    const arr = m.get(b.card_id)
    if (arr) arr.push(b)
    else m.set(b.card_id, [b])
  }
  return m
}

export async function addBinding(input: {
  card_id: string
  start_pos: number
  end_pos: number
  selected_text: string
  user_speech: string
  anchors: Array<{ keyword: string; category: AnchorCategory }>
  /** 同源想法卡 id：语境卡上的绑定由某张想法卡派生时填，删想法卡级联删本绑定 */
  source_card_id?: string
}): Promise<AnchorBinding> {
  return requestData('POST', '/api/context/bindings', input, '保存锚点失败')
}

export async function deleteBinding(id: string): Promise<void> {
  return requestVoid('DELETE', `/api/context/bindings/${id}`, undefined, '删除锚点失败')
}

/** 编辑想法卡正文（整卡绑定的原话/选区同步更新）；sourceLabel 传入时连带改语境来源标签 */
export async function updateContextCard(id: string, text: string, sourceLabel?: string): Promise<void> {
  return requestVoid('PATCH', `/api/context/cards/${id}`, {
    text,
    ...(sourceLabel !== undefined && { source_label: sourceLabel }),
  }, '更新想法卡失败')
}

/** 编辑锚点句 / 类别（至少传一个；后端按需删旧向量并清簇名缓存，下次打开地图自动重嵌入/重起名） */
export async function updateAnchor(id: string, patch: { keyword?: string; category?: AnchorCategory }): Promise<void> {
  return requestVoid('PATCH', `/api/anchors/${id}`, patch, '更新锚点失败')
}

/** 编辑锚点句（updateAnchor 的便捷封装，Fairy 工具在用） */
export async function updateAnchorKeyword(id: string, keyword: string): Promise<void> {
  return updateAnchor(id, { keyword })
}

/** 往已有绑定追加一条锚点（同名同类复用全局锚点） */
export async function addAnchorToBinding(bindingId: string, keyword: string, category: AnchorCategory): Promise<AnchorRef> {
  return requestData('POST', `/api/context/bindings/${bindingId}/anchors`, { keyword, category }, '添加锚点失败')
}

// ── B 站转录（桌面端是 Tauri 命令 get_bili_transcripts，手机端走同语义的 LAN 路由）──

export interface BiliTranscriptCacheResp {
  readonly visual: string | null
  readonly audio: string | null
  readonly combined: string | null
}

/** 按 ref_path（download_path）取转录。需要桌面端带 /api/bilibili/transcripts 路由的版本，旧版本抛 DesktopApiError */
export async function fetchBiliTranscripts(refPath: string): Promise<BiliTranscriptCacheResp> {
  return requestData('GET', `/api/bilibili/transcripts?path=${encodeURIComponent(refPath)}`, undefined, '读取转录失败')
}

// ── 协议志·动机云（每条动机的去向 + 行动蓝图）──

/** cloud=在云里 / action=展开成行动 / wish=留作愿望 / released=放下（归档不删） */
export type MotiveDestiny = 'cloud' | 'action' | 'wish' | 'released'

export interface BlueprintDirection {
  readonly title: string
  readonly steps: readonly string[]
}

export interface MotiveBlueprint {
  readonly directions: readonly BlueprintDirection[]
}

export interface MotiveProtocol {
  readonly anchor_id: string
  readonly destiny: MotiveDestiny
  readonly blueprint: MotiveBlueprint | null
  readonly updated_at: string
}

interface MotiveProtocolRow {
  readonly anchor_id: string
  readonly destiny: MotiveDestiny
  readonly blueprint_json: string | null
  readonly updated_at: string
}

function parseBlueprint(json: string | null): MotiveBlueprint | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as { directions?: unknown }
    if (!Array.isArray(raw.directions)) return null
    const directions = raw.directions
      .filter((d): d is { title: string; steps: unknown } => typeof d?.title === 'string')
      .map((d) => ({
        title: d.title,
        steps: Array.isArray(d.steps) ? d.steps.filter((s): s is string => typeof s === 'string') : [],
      }))
    return { directions }
  } catch {
    return null
  }
}

function toMotiveProtocol(row: MotiveProtocolRow): MotiveProtocol {
  return {
    anchor_id: row.anchor_id,
    destiny: row.destiny,
    blueprint: parseBlueprint(row.blueprint_json),
    updated_at: row.updated_at,
  }
}

export async function fetchMotiveProtocols(): Promise<MotiveProtocol[]> {
  const rows = await requestData<MotiveProtocolRow[]>('GET', '/api/motives/protocols', undefined, '读取动机去向失败')
  return rows.map(toMotiveProtocol)
}

/** 只改传入的字段；blueprint 传 null = 清空蓝图 */
export async function saveMotiveProtocol(
  anchorId: string,
  patch: { destiny?: MotiveDestiny; blueprint?: MotiveBlueprint | null },
): Promise<MotiveProtocol> {
  const body = {
    destiny: patch.destiny,
    blueprint_json: patch.blueprint ? JSON.stringify(patch.blueprint) : undefined,
    clear_blueprint: patch.blueprint === null,
  }
  const row = await requestData<MotiveProtocolRow>(
    'PUT',
    `/api/motives/protocols/${encodeURIComponent(anchorId)}`,
    body,
    '保存动机去向失败',
  )
  return toMotiveProtocol(row)
}

// ── Anchor Embeddings（锚点域地图：语义向量 + 簇名缓存）──

export interface AnchorEmbeddingRecord {
  readonly anchor_id: string
  readonly model: string
  readonly dims: number
  readonly vector: string   // JSON 数组文本
}

export async function fetchAnchorEmbeddings(): Promise<AnchorEmbeddingRecord[]> {
  return requestData('GET', '/api/anchors/embeddings', undefined, '查询锚点向量失败')
}

export async function saveAnchorEmbeddings(items: AnchorEmbeddingRecord[]): Promise<void> {
  if (items.length === 0) return
  return requestVoid('POST', '/api/anchors/embeddings', { items }, '保存锚点向量失败')
}

export interface ClusterNameRecord {
  readonly member_hash: string
  readonly name: string
}

export async function fetchClusterNames(): Promise<ClusterNameRecord[]> {
  return requestData('GET', '/api/anchors/cluster-names', undefined, '查询簇名缓存失败')
}

export async function saveClusterName(memberHash: string, name: string): Promise<void> {
  return requestVoid('POST', '/api/anchors/cluster-names', { member_hash: memberHash, name }, '保存簇名失败')
}
