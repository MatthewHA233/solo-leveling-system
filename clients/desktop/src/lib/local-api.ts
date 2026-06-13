// ══════════════════════════════════════════════
// Local API — 本地 HTTP 客户端
// 替代 Supabase
// ══════════════════════════════════════════════

import type {
  ActivityBlock,
  ActivityCategory,
  ActivityPalette,
  ActivityTag,
  PlanNode,
  PlannedBlock,
} from '../types'

const API_BASE = 'http://localhost:49733'

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

function toLocalDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// ── 活动记录：标签库 + 5min 块 ──

interface RawCategory {
  id: number
  name: string
  color: string
  sort_order: number
  created_at: string
  last_used_at: string
}

interface RawTag {
  id: number
  category_id: number
  full_path: string
  leaf_name: string
  depth: number
  created_at: string
  last_used_at: string
}

interface RawBlock {
  date: string
  minute: number
  tag_id: number
  note: string | null
  created_at: string
}

interface RawPlanNode {
  id: number
  project_tag_id: number
  parent_id: number | null
  title: string
  status: 'active' | 'done' | 'archived'
  sort_order: number
  created_at: string
  updated_at: string
}

interface RawPlannedBlock {
  date: string
  minute: number
  plan_node_id: number
  note: string | null
  created_at: string
}

function mapCategory(r: RawCategory): ActivityCategory {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }
}

function mapTag(r: RawTag): ActivityTag {
  return {
    id: r.id,
    categoryId: r.category_id,
    fullPath: r.full_path,
    leafName: r.leaf_name,
    depth: r.depth,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }
}

function mapBlock(r: RawBlock): ActivityBlock {
  return {
    date: r.date,
    minute: r.minute,
    tagId: r.tag_id,
    note: r.note,
    createdAt: r.created_at,
  }
}

function mapPlanNode(r: RawPlanNode): PlanNode {
  return {
    id: r.id,
    projectTagId: r.project_tag_id,
    parentId: r.parent_id,
    title: r.title,
    status: r.status,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapPlannedBlock(r: RawPlannedBlock): PlannedBlock {
  return {
    date: r.date,
    minute: r.minute,
    planNodeId: r.plan_node_id,
    note: r.note,
    createdAt: r.created_at,
  }
}

export async function fetchActivityPalette(): Promise<ActivityPalette> {
  const res = await fetch(`${API_BASE}/api/activities/palette`)
  const json: ApiResponse<{ categories: RawCategory[]; tags: RawTag[] }> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取标签库失败')
  return {
    categories: json.data.categories.map(mapCategory),
    tags: json.data.tags.map(mapTag),
  }
}

export async function addActivityCategory(name: string, color: string): Promise<ActivityCategory> {
  const res = await fetch(`${API_BASE}/api/activities/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  })
  const json: ApiResponse<RawCategory> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '添加分类失败')
  return mapCategory(json.data)
}

export async function deleteActivityCategory(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/activities/categories/${id}`, { method: 'DELETE' })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '删除分类失败')
}

export async function updateActivityCategory(
  id: number,
  patch: { name?: string; color?: string },
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/activities/categories/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: patch.name ?? null, color: patch.color ?? null }),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '更新分类失败')
}

/**
 * 改单个标签的完整路径（含首段分类名）。
 * 首段必须是已存在分类的名字；扁平模式下不级联到其它共享前缀的 tag。
 */
export async function renameActivityPath(
  tagId: number,
  newFullPath: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/activities/tags/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_id: tagId,
      new_full_path: newFullPath,
    }),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '重命名失败')
}

export async function addActivityTag(categoryId: number, fullPath: string): Promise<ActivityTag> {
  const res = await fetch(`${API_BASE}/api/activities/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category_id: categoryId, full_path: fullPath }),
  })
  const json: ApiResponse<RawTag> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '添加标签失败')
  return mapTag(json.data)
}

export async function deleteActivityTag(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/activities/tags/${id}`, { method: 'DELETE' })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '删除标签失败')
}

export async function fetchActivityBlocks(date: Date): Promise<ActivityBlock[]> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/activities/blocks?date=${dateStr}`)
  const json: ApiResponse<RawBlock[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取活动块失败')
  return json.data.map(mapBlock)
}

export async function paintActivityBlocks(date: Date, minutes: number[], tagId: number): Promise<number> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/activities/blocks/paint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: dateStr, minutes, tag_id: tagId }),
  })
  const json: ApiResponse<number> = await res.json()
  if (!json.success) throw new Error(json.error || '涂块失败')
  return json.data ?? 0
}

export async function eraseActivityBlocks(date: Date, minutes: number[]): Promise<number> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/activities/blocks/erase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: dateStr, minutes }),
  })
  const json: ApiResponse<number> = await res.json()
  if (!json.success) throw new Error(json.error || '擦块失败')
  return json.data ?? 0
}

// ── Plan nodes: project-tag anchored task tree ──

export async function fetchPlanNodes(projectTagId: number): Promise<PlanNode[]> {
  const res = await fetch(`${API_BASE}/api/plans/nodes?project_tag_id=${projectTagId}`)
  const json: ApiResponse<RawPlanNode[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取计划节点失败')
  return json.data.map(mapPlanNode)
}

export async function addPlanNode(
  projectTagId: number,
  title: string,
  parentId: number | null = null,
): Promise<PlanNode> {
  const res = await fetch(`${API_BASE}/api/plans/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_tag_id: projectTagId, parent_id: parentId, title }),
  })
  const json: ApiResponse<RawPlanNode> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '新增计划节点失败')
  return mapPlanNode(json.data)
}

export async function updatePlanNode(
  id: number,
  patch: { title?: string; status?: PlanNode['status'] },
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/plans/nodes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      title: patch.title ?? null,
      status: patch.status ?? null,
    }),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '更新计划节点失败')
}

export async function deletePlanNode(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/plans/nodes/${id}`, { method: 'DELETE' })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '删除计划节点失败')
}

// ── Planned Timeline Blocks: same 5-minute model, separate storage table ──

export async function fetchPlannedBlocks(date: Date): Promise<PlannedBlock[]> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/plans/blocks?date=${dateStr}`)
  const json: ApiResponse<RawPlannedBlock[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取计划块失败')
  return json.data.map(mapPlannedBlock)
}

export async function paintPlannedBlocks(date: Date, minutes: number[], planNodeId: number): Promise<number> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/plans/blocks/paint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: dateStr, minutes, plan_node_id: planNodeId }),
  })
  const json: ApiResponse<number> = await res.json()
  if (!json.success) throw new Error(json.error || '计划涂块失败')
  return json.data ?? 0
}

export async function erasePlannedBlocks(date: Date, minutes: number[]): Promise<number> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/plans/blocks/erase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: dateStr, minutes }),
  })
  const json: ApiResponse<number> = await res.json()
  if (!json.success) throw new Error(json.error || '计划擦块失败')
  return json.data ?? 0
}

// ── LAN Sync: activity records + plan layer ──

export interface SyncHello {
  device_id: string
  pair_code: string
  server_time: string
  protocol_version: number
  tables: string[]
  alias: string
  device_type: string
  device_model: string
}

export interface SyncPeer {
  device_id: string
  pair_code: string
  alias: string
  ip: string
  port: number
  protocol: string
  last_seen_at: string
  source: string
  device_type: string
  device_model: string
}

export interface SyncActivityCategory {
  sync_id: string
  name: string
  color: string
  sort_order: number
  created_at: string
  last_used_at: string
  updated_at: string
  deleted_at: string | null
}

export interface SyncActivityTag {
  sync_id: string
  category_sync_id: string
  full_path: string
  leaf_name: string
  depth: number
  created_at: string
  last_used_at: string
  updated_at: string
  deleted_at: string | null
}

export interface SyncActivityBlock {
  sync_id: string
  date: string
  minute: number
  tag_sync_id: string
  note: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface SyncPlanNode {
  sync_id: string
  project_tag_sync_id: string
  parent_sync_id: string | null
  title: string
  status: 'active' | 'done' | 'archived'
  sort_order: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface SyncPlannedBlock {
  sync_id: string
  date: string
  minute: number
  plan_node_sync_id: string
  note: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface SyncModelApiKey {
  id: string
  label: string
  api_key: string
  is_active: number
  created_at: string
  updated_at: string
}

export interface SyncModelCallLog {
  id: string
  api_key_id: string | null
  feature: string
  model_id: string
  started_at: string
  duration_ms: number | null
  prompt_text_tokens: number
  prompt_image_tokens: number
  prompt_video_tokens: number
  prompt_audio_tokens: number
  completion_text_tokens: number
  completion_audio_tokens: number
  cost_cny: number | null
  free_quota_tokens: number
  free_quota_saved_cny: number
  success: number
  error_message: string | null
  metadata: string | null
}

export interface SyncModelFreeQuota {
  model_id: string
  has_free_quota: number
  not_supported: number
  used_tokens: number
  total_tokens: number
  remaining_tokens: number
  used_percent: string | null
  expire_date: string | null
  raw_quota: string | null
  scanned_at: string
  error_message: string | null
}

export interface SyncFeatureBinding {
  feature: string
  model_id: string
  updated_at: string
}

export interface SyncExport {
  device_id: string
  exported_at: string
  cursor: string
  activity_categories: SyncActivityCategory[]
  activity_tags: SyncActivityTag[]
  activity_blocks: SyncActivityBlock[]
  plan_nodes: SyncPlanNode[]
  planned_blocks: SyncPlannedBlock[]
  model_api_keys: SyncModelApiKey[]
  model_call_log: SyncModelCallLog[]
  model_free_quota: SyncModelFreeQuota[]
  feature_bindings: SyncFeatureBinding[]
}

export interface SyncImportResult {
  activity_categories: number
  activity_tags: number
  activity_blocks: number
  plan_nodes: number
  planned_blocks: number
  model_api_keys: number
  model_call_log: number
  model_free_quota: number
  feature_bindings: number
  skipped: number
}

export interface SyncTransferResult {
  snapshot: SyncExport
  importResult: SyncImportResult
}

function normalizeSyncBase(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  if (!trimmed) return API_BASE
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withProtocol)
    if (!url.port) url.port = '49733'
    return url.toString().replace(/\/$/, '')
  } catch {
    return withProtocol
  }
}

export async function fetchSyncHello(base = API_BASE): Promise<SyncHello> {
  const res = await fetch(`${normalizeSyncBase(base)}/api/sync/hello`)
  const json: ApiResponse<SyncHello> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '同步握手失败')
  return json.data
}

export async function fetchSyncPeers(): Promise<SyncPeer[]> {
  const res = await fetch(`${API_BASE}/api/sync/peers`)
  const json: ApiResponse<SyncPeer[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取同步设备失败')
  return json.data
}

export async function discoverSyncPeers(): Promise<SyncPeer[]> {
  const res = await fetch(`${API_BASE}/api/sync/discover`, { method: 'POST' })
  const json: ApiResponse<SyncPeer[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '发现同步设备失败')
  return json.data
}

export async function exportSync(since?: string | null, base = API_BASE): Promise<SyncExport> {
  const query = since ? `?since=${encodeURIComponent(since)}` : ''
  const res = await fetch(`${normalizeSyncBase(base)}/api/sync/export${query}`)
  const json: ApiResponse<SyncExport> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '同步导出失败')
  return json.data
}

export async function importSync(payload: SyncExport, base = API_BASE): Promise<SyncImportResult> {
  const res = await fetch(`${normalizeSyncBase(base)}/api/sync/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json: ApiResponse<SyncImportResult> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '同步导入失败')
  return json.data
}

export async function pullSyncFromPeer(peerBase: string, since?: string | null): Promise<SyncTransferResult> {
  const snapshot = await exportSync(since, peerBase)
  const importResult = await importSync(snapshot)
  return { snapshot, importResult }
}

export async function pushSyncToPeer(peerBase: string, since?: string | null): Promise<SyncTransferResult> {
  const snapshot = await exportSync(since)
  const importResult = await importSync(snapshot, peerBase)
  return { snapshot, importResult }
}

export async function setLocalSyncAlias(alias: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/sync/alias`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias }),
  })
  const json: ApiResponse<string> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '更新别名失败')
  return json.data
}

// ── 已链接（持久自动同步）设备 ──

export interface LinkedDevice {
  device_id: string
  alias: string
  last_base: string
  last_synced_at: string | null
  created_at: string
}

export interface SyncRoundResult {
  pulled: SyncImportResult
  pushed: SyncImportResult
}

export async function fetchSyncLinks(): Promise<LinkedDevice[]> {
  const res = await fetch(`${API_BASE}/api/sync/links`)
  const json: ApiResponse<LinkedDevice[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取链接列表失败')
  return json.data
}

export async function addSyncLink(deviceId: string, alias: string, lastBase: string): Promise<LinkedDevice> {
  const res = await fetch(`${API_BASE}/api/sync/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, alias, last_base: lastBase }),
  })
  const json: ApiResponse<LinkedDevice> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '建立链接失败')
  return json.data
}

export async function removeSyncLink(deviceId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sync/links/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '解除链接失败')
}

export async function runSyncLink(deviceId: string): Promise<SyncRoundResult> {
  const res = await fetch(`${API_BASE}/api/sync/links/${encodeURIComponent(deviceId)}/sync`, { method: 'POST' })
  const json: ApiResponse<SyncRoundResult> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '同步失败')
  return json.data
}

// ── Perception Timeline API（保留 PerceptionSpan 数据结构） ──

export interface PerceptionSpan {
  id: number
  track: string         // "apps" | "tags"
  start_at: string      // "2026-04-04 13:00:00"
  end_at: string
  title: string
  group_name: string | null
  color: string | null  // "#F9BA00"
  platform?: 'mac' | 'win' | 'desktop' | string | null
}

/** 查询某天的本机感知 spans（apps + tags/status） */
export async function fetchPerceptionSpans(date: Date): Promise<PerceptionSpan[]> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/perception/spans?date=${dateStr}`)
  const json: ApiResponse<PerceptionSpan[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取感知数据失败')
  return json.data
}

// ── Bilibili 时间轴 Span ──

export interface BiliSpan {
  bvid: string
  oid: number
  title: string
  author_name: string
  cover: string       // 封面 URL
  start_at: string    // "2026-04-06 13:30:00"
  end_at: string
  duration: number    // 总时长（秒）
  progress: number    // 已看（秒）
  view_at: number     // unix 秒
  event_id: string | null
  downloaded: boolean // bili_video_assets 中存在 done 状态
  file_size_bytes: number | null // 已下载时 = 文件字节数；未下载 = null
  transcribed: boolean // bili_video_assets 中存在 visual 或 audio 转录
}

// 日历角标用：某月每日的观看数 / 已下载数 / 已转录数
export interface BiliDayCount {
  day: string         // "YYYY-MM-DD"
  watched: number
  downloaded: number
  transcribed: number
}

/**
 * 查询 [from, to] 范围内"有任何数据"的日期（聚合 chronos / bili / presence）
 * 用于昼夜表前后日按钮置灰判断
 */
export async function fetchDataDays(from: string, to: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/activities/data-days?from=${from}&to=${to}`)
  const json: ApiResponse<string[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取数据日失败')
  return json.data
}

/** 拉取一段日期内每日观看 / 已下载计数（用于日历） */
export async function fetchBiliDayCounts(from: string, to: string): Promise<BiliDayCount[]> {
  const res = await fetch(`${API_BASE}/api/bilibili/day-counts?from=${from}&to=${to}`)
  const json: ApiResponse<BiliDayCount[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取B站日计数失败')
  return json.data
}

/** 查询某天的 B站观看 spans */
export async function fetchBiliSpans(date: Date): Promise<BiliSpan[]> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/bilibili/spans/day?date=${dateStr}`)
  const json: ApiResponse<BiliSpan[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取B站Span失败')
  return json.data
}

// ── Bilibili 历史 DB API ──

export interface DbBiliItem {
  bvid: string
  oid: number
  title: string
  author_name: string
  cover: string
  duration: number
  progress: number
  view_at: number
  event_id: string | null
}

export interface BiliHistoryPage {
  items: DbBiliItem[]
  total: number
  page: number
  page_size: number
}

/** 分页查询本地 B站历史 */
export async function fetchBiliHistoryDb(
  page: number,
  pageSize: number,
  unlinkedOnly: boolean,
): Promise<BiliHistoryPage> {
  const res = await fetch(
    `${API_BASE}/api/bilibili/history?page=${page}&page_size=${pageSize}&unlinked_only=${unlinkedOnly}`,
  )
  const json: ApiResponse<BiliHistoryPage> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '查询失败')
  return json.data
}

/** 模糊搜索本地 B站历史（title / author / bvid） */
export async function searchBiliHistory(q: string, limit = 40, offset = 0): Promise<DbBiliItem[]> {
  const trimmed = q.trim()
  if (!trimmed) return []
  const res = await fetch(
    `${API_BASE}/api/bilibili/history/search?q=${encodeURIComponent(trimmed)}&limit=${limit}&offset=${offset}`,
  )
  const json: ApiResponse<DbBiliItem[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '搜索失败')
  return json.data
}

/** 将一批 bvid 关联到事件 */
export async function linkBiliToEvent(bvids: string[], eventId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/bilibili/history/link`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bvids, event_id: eventId }),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '关联失败')
}

// ── Goals ──

export interface Goal {
  id: string
  title: string
  status: 'active' | 'completed' | 'abandoned'
  tags: string        // JSON array string，如 '["健康","成长"]'
  created_at: string
  completed_at: string | null
}

/** 解析 Goal.tags JSON 字符串为数组 */
export function parseGoalTags(goal: Goal): string[] {
  try { return JSON.parse(goal.tags) } catch { return [] }
}

export async function fetchGoals(status?: 'active' | 'completed' | 'abandoned'): Promise<Goal[]> {
  const url = status ? `${API_BASE}/api/goals?status=${status}` : `${API_BASE}/api/goals`
  const res = await fetch(url)
  const json: ApiResponse<Goal[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '查询目标失败')
  return json.data
}

export async function createGoal(title: string, tags: string[] = []): Promise<Goal> {
  const res = await fetch(`${API_BASE}/api/goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, tags }),
  })
  const json: ApiResponse<Goal> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '创建目标失败')
  return json.data
}

export async function updateGoal(id: string, patch: { title?: string; status?: string; tags?: string[] }): Promise<void> {
  const res = await fetch(`${API_BASE}/api/goals/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '更新目标失败')
}

export async function deleteGoal(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/goals/${id}`, { method: 'DELETE' })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '删除目标失败')
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
}

export async function fetchContextFeed(): Promise<ContextFeedItem[]> {
  const res = await fetch(`${API_BASE}/api/context/feed`)
  const json: ApiResponse<ContextFeedItem[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '查询语境流失败')
  return json.data
}

export async function addContextCard(text: string, sourceLabel?: string, createdAt?: string, sourceCardId?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/context/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source_label: sourceLabel ?? null, source_card_id: sourceCardId ?? null, created_at: createdAt ?? null }),
  })
  const json: ApiResponse<string> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '添加语境卡失败')
  return json.data
}

export async function deleteContextCard(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/context/cards/${id}`, { method: 'DELETE' })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '删除语境卡失败')
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
  const res = await fetch(`${API_BASE}/api/context/cards/${cardId}/bindings`)
  const json: ApiResponse<AnchorBinding[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '查询锚点失败')
  return json.data
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
  const res = await fetch(`${API_BASE}/api/context/bindings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const json: ApiResponse<AnchorBinding> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '保存锚点失败')
  return json.data
}

export async function deleteBinding(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/context/bindings/${id}`, { method: 'DELETE' })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '删除锚点失败')
}

/** 编辑想法卡正文（整卡绑定的原话/选区同步更新）；sourceLabel 传入时连带改语境来源标签 */
export async function updateContextCard(id: string, text: string, sourceLabel?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/context/cards/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(sourceLabel !== undefined && { source_label: sourceLabel }) }),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '更新想法卡失败')
}

/** 编辑锚点句 / 类别（至少传一个；后端按需删旧向量并清簇名缓存，下次打开地图自动重嵌入/重起名） */
export async function updateAnchor(id: string, patch: { keyword?: string; category?: AnchorCategory }): Promise<void> {
  const res = await fetch(`${API_BASE}/api/anchors/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '更新锚点失败')
}

/** 编辑锚点句（updateAnchor 的便捷封装，Fairy 工具在用） */
export async function updateAnchorKeyword(id: string, keyword: string): Promise<void> {
  return updateAnchor(id, { keyword })
}

/** 往已有绑定追加一条锚点（同名同类复用全局锚点） */
export async function addAnchorToBinding(bindingId: string, keyword: string, category: AnchorCategory): Promise<AnchorRef> {
  const res = await fetch(`${API_BASE}/api/context/bindings/${bindingId}/anchors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, category }),
  })
  const json: ApiResponse<AnchorRef> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '添加锚点失败')
  return json.data
}

// ── Anchor Embeddings（锚点域地图：语义向量 + 簇名缓存）──

export interface AnchorEmbeddingRecord {
  readonly anchor_id: string
  readonly model: string
  readonly dims: number
  readonly vector: string   // JSON 数组文本
}

export async function fetchAnchorEmbeddings(): Promise<AnchorEmbeddingRecord[]> {
  const res = await fetch(`${API_BASE}/api/anchors/embeddings`)
  const json: ApiResponse<AnchorEmbeddingRecord[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '查询锚点向量失败')
  return json.data
}

export async function saveAnchorEmbeddings(items: AnchorEmbeddingRecord[]): Promise<void> {
  if (items.length === 0) return
  const res = await fetch(`${API_BASE}/api/anchors/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '保存锚点向量失败')
}

export interface ClusterNameRecord {
  readonly member_hash: string
  readonly name: string
}

export async function fetchClusterNames(): Promise<ClusterNameRecord[]> {
  const res = await fetch(`${API_BASE}/api/anchors/cluster-names`)
  const json: ApiResponse<ClusterNameRecord[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '查询簇名缓存失败')
  return json.data
}

export async function saveClusterName(memberHash: string, name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/anchors/cluster-names`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_hash: memberHash, name }),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '保存簇名失败')
}

// ── Presence Spans ──

export interface PresenceSpanRecord {
  readonly id: string
  readonly start_time: string       // "YYYY-MM-DD HH:MM:SS"
  readonly end_time: string | null  // null = 仍在进行
  readonly state: 'present' | 'absent'
}

export async function fetchPresenceSpans(date: Date): Promise<PresenceSpanRecord[]> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/presence/spans?date=${dateStr}`)
  const json: ApiResponse<PresenceSpanRecord[]> = await res.json()
  return json.data ?? []
}

export async function upsertPresenceSpan(span: PresenceSpanRecord): Promise<void> {
  await fetch(`${API_BASE}/api/presence/spans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(span),
  })
}

export async function closePresenceSpan(id: string, endTime: string): Promise<void> {
  await fetch(`${API_BASE}/api/presence/spans/${id}/close`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ end_time: endTime }),
  })
}

// ══════════════════════════════════════════════
// 模型审计：registry / bindings / call_log
// 通过 tauri invoke 调用，不走 HTTP
// ══════════════════════════════════════════════

export type ModelCategory = 'text' | 'omni' | 'realtime' | 'embedding'

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

export interface ModelDef {
  id: string
  category: ModelCategory
  provider: string                    // 'dashscope'
  display_name: string | null
  modalities: string | null           // JSON 数组字符串
  context_window: number | null
  notes: string | null
  deprecated: boolean
  updated_at: string
  pricing: ModelPricingTier[]
}

export interface FeatureBinding {
  feature: string                     // 'bili_visual_transcribe' / 'fairy_chat' / ...
  model_id: string
  updated_at: string
}

export interface ModelApiKey {
  id: string
  label: string
  api_key: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface UpsertModelApiKeyRequest {
  id?: string | null
  label: string
  api_key: string
  is_active: boolean
}

export interface ModelCallLog {
  id: string
  api_key_id: string | null
  feature: string
  model_id: string
  started_at: string
  duration_ms: number | null
  prompt_text_tokens: number
  prompt_image_tokens: number
  prompt_video_tokens: number
  prompt_audio_tokens: number
  completion_text_tokens: number
  completion_audio_tokens: number
  cost_cny: number | null
  free_quota_tokens: number
  free_quota_saved_cny: number
  success: boolean
  error_message: string | null
  metadata: string | null
}

export interface ModelFreeQuota {
  model_id: string
  has_free_quota: boolean
  not_supported: boolean
  used_tokens: number
  total_tokens: number
  remaining_tokens: number
  used_percent: string | null
  expire_date: string | null
  raw_quota: string | null
  scanned_at: string
  error_message: string | null
}

export interface LogModelCallRequest {
  api_key_id?: string | null
  feature: string
  model_id: string
  started_at: string
  duration_ms?: number | null
  prompt_text_tokens: number
  prompt_image_tokens: number
  prompt_video_tokens: number
  prompt_audio_tokens: number
  completion_text_tokens: number
  completion_audio_tokens: number
  success: boolean
  error_message?: string | null
  metadata?: string | null
}

export interface CallLogBucket {
  bucket: string
  call_count: number
  prompt_tokens_total: number
  completion_tokens_total: number
  cost_cny_total: number
}

export type CallLogGranularity = 'minute' | 'hour' | 'day'

// ── Windows 图形偏好 ──

export interface GpuPrefStatus {
  /** Solevup.exe 完整路径 */
  self_exe_path: string
  /** Solevup.exe 是否已写入"高性能"偏好 */
  self_exe_pref_set: boolean
  /** 检测到的 msedgewebview2.exe 完整路径（null = 找不到） */
  webview2_path: string | null
  /** msedgewebview2.exe 是否已写入"高性能"偏好 */
  webview2_pref_set: boolean
  /** 检测到的 Edge WebView 版本号 */
  edge_version: string | null
}
