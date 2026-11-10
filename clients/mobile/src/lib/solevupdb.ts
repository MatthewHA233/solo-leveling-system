// ══════════════════════════════════════════════
// SolevupDb Native Module 桥接 (Android-only)
// 真 SQLite 数据访问层；schema 镜像 desktop solevup.db
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'

type PingResult = {
  ok: boolean
  ts: number
  module: string
}

export type SolevupDbStats = {
  tables: Record<string, number>
  path: string
}

export type CategoryRow = {
  id: number
  syncId: string
  name: string
  color: string
  sortOrder: number
  createdAt: string
  lastUsedAt: string
  updatedAt: string
  deletedAt?: string
}

export type TagRow = {
  id: number
  syncId: string
  categoryId: number
  fullPath: string
  leafName: string
  depth: number
  createdAt: string
  lastUsedAt: string
  updatedAt: string
  deletedAt?: string
}

export type BlockRow = {
  date: string
  minute: number
  syncId: string
  tagId: number
  note?: string
  createdAt: string
  updatedAt: string
}

export type UpsertCategoryArgs = {
  name: string
  color: string
  sortOrder?: number
  syncId?: string
  createdAt?: string
  lastUsedAt?: string
  /** LWW 关键字段；seed 种子数据时必须传 desktop 原始 updated_at，
   * 否则会被对端视为"mobile 刚改"覆盖 desktop 已更新版本。 */
  updatedAt?: string
}

// ── Sync export 类型（镜像 desktop SyncExport） ──

export type SyncCategoryRow = {
  syncId: string
  name: string
  color: string
  sortOrder: number
  createdAt: string
  lastUsedAt: string
  updatedAt: string
  deletedAt?: string
}

export type SyncTagRow = {
  syncId: string
  categorySyncId: string
  fullPath: string
  leafName: string
  depth: number
  createdAt: string
  lastUsedAt: string
  updatedAt: string
  deletedAt?: string
}

export type SyncBlockRow = {
  syncId: string
  date: string
  minute: number
  tagSyncId: string
  note?: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export type SyncPlanNodeRow = {
  syncId: string
  projectTagSyncId: string
  parentSyncId?: string
  title: string
  status: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export type SyncPlannedBlockRow = {
  syncId: string
  date: string
  minute: number
  planNodeSyncId: string
  note?: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export type SyncExport = {
  deviceId: string
  exportedAt: string
  cursor: string
  activityCategories: SyncCategoryRow[]
  activityTags: SyncTagRow[]
  activityBlocks: SyncBlockRow[]
  planNodes: SyncPlanNodeRow[]
  plannedBlocks: SyncPlannedBlockRow[]
}

export type UpsertTagArgs = {
  categoryId: number
  fullPath: string
  leafName: string
  depth: number
  syncId?: string
  createdAt?: string
  lastUsedAt?: string
  /** LWW 关键字段；同 UpsertCategoryArgs */
  updatedAt?: string
}

interface SolevupDbNative {
  ping(): Promise<PingResult>
  getDeviceId(): Promise<string>
  getStats(): Promise<SolevupDbStats>
  listCategories(): Promise<CategoryRow[]>
  listTags(): Promise<TagRow[]>
  listBlocksForDate(date: string): Promise<BlockRow[]>
  upsertCategory(args: UpsertCategoryArgs): Promise<number>
  upsertTag(args: UpsertTagArgs): Promise<number>
  paintBlocks(date: string, minutes: number[], tagId: number): Promise<number>
  eraseBlocks(date: string, minutes: number[]): Promise<number>
  deleteTag(tagId: number): Promise<number>
  deleteCategory(categoryId: number): Promise<number>
  renameCategory(categoryId: number, newName: string, newColor: string): Promise<number>
  renameTagPath(tagId: number, newFullPath: string, cascade: boolean): Promise<number>
  getPref(key: string, fallback: string): Promise<string>
  setPref(key: string, value: string): Promise<boolean>
  listSyncedSettings(): Promise<SyncedSetting[]>
  saveSyncedSetting(key: string, value: string, seed: boolean): Promise<boolean>
  exportSync(since: string | null): Promise<SyncExport>
  importSync(payload: SyncExport): Promise<SyncImportResult>
  getActiveModelApiKey(provider: string | null): Promise<ModelApiKeyInfo | null>
  listModelApiKeys(): Promise<ModelApiKeyInfo[]>
  upsertModelApiKey(
    id: string | null,
    label: string,
    apiKey: string,
    provider: string | null,
    activate: boolean,
  ): Promise<ModelApiKeyInfo>
  setActiveModelApiKey(id: string): Promise<boolean>
  deleteModelApiKey(id: string): Promise<boolean>
  listModelCatalog(): Promise<string>
  seedModelCatalogIfEmpty(json: string): Promise<boolean>
  upsertModelCatalog(json: string): Promise<number>
  getFeatureBinding(feature: string): Promise<string | null>
  listFeatureBindings(): Promise<{ feature: string; modelId: string; updatedAt: string }[]>
  setFeatureBinding(feature: string, modelId: string): Promise<boolean>
  queryModelCallLog(since: string | null, limit: number): Promise<ModelCallLogRow[]>
  queryCallLog(
    timeFrom: string | null,
    timeTo: string | null,
    feature: string | null,
    modelId: string | null,
    apiKeyId: string | null,
    limit: number,
  ): Promise<string>
  aggregateCallLog(
    timeFrom: string,
    timeTo: string,
    granularity: string,
    feature: string | null,
    modelId: string | null,
    apiKeyId: string | null,
  ): Promise<string>
  getModelCallLog(id: string): Promise<string | null>
  copyText(text: string): Promise<boolean>
  listModelFreeQuota(): Promise<ModelFreeQuotaRow[]>
  createChatSession(): Promise<ChatSessionRow>
  listChatSessions(limit: number): Promise<ChatSessionRow[]>
  getChatMessages(sessionId: string): Promise<ChatMessageDbRow[]>
  appendChatMessages(sessionId: string, rows: ChatMessageDbRow[]): Promise<boolean>
  patchChatSession(sessionId: string, title: string | null, summary: string | null): Promise<boolean>
  deleteChatSession(sessionId: string): Promise<boolean>
  isChatSessionDeleted(sessionId: string): Promise<boolean>
  cleanupEmptyChatSessions(exceptId: string | null): Promise<string[]>
  searchChatSessions(query: string, limit: number): Promise<ChatSessionSearchHit[]>
  logModelCall(row: ModelCallLogInsert): Promise<string>
}

export type ModelApiKeyInfo = {
  id: string
  label: string
  apiKey: string
  isActive: boolean
  provider: string
  createdAt: string
  updatedAt: string
}

export type ModelCallLogInsert = {
  apiKeyId?: string | null
  feature: string
  modelId: string
  startedAt: string
  durationMs?: number | null
  promptTextTokens?: number
  promptImageTokens?: number
  promptVideoTokens?: number
  promptAudioTokens?: number
  completionTextTokens?: number
  completionAudioTokens?: number
  success?: boolean
  errorMessage?: string | null
  metadata?: string | null
}

export type SyncImportResult = {
  activityCategories: number
  activityTags: number
  activityBlocks: number
  planNodes: number
  plannedBlocks: number
  modelApiKeys?: number
  modelCallLog?: number
  modelFreeQuota?: number
  featureBindings?: number
  chatSessions?: number
  chatMessages?: number
  modelRegistry?: number
  skipped: number
}

const Native: SolevupDbNative | null =
  Platform.OS === 'android' ? (NativeModules.SolevupDb as SolevupDbNative) ?? null : null

export function isSolevupDbAvailable(): boolean {
  return Native != null
}

export async function pingSolevupDb(): Promise<PingResult | null> {
  if (!Native) return null
  return Native.ping()
}

export async function getSolevupDbDeviceId(): Promise<string | null> {
  if (!Native) return null
  return Native.getDeviceId()
}

export async function getSolevupDbStats(): Promise<SolevupDbStats | null> {
  if (!Native) return null
  return Native.getStats()
}

export async function solevupListCategories(): Promise<CategoryRow[]> {
  if (!Native) return []
  return Native.listCategories()
}

export async function solevupListTags(): Promise<TagRow[]> {
  if (!Native) return []
  return Native.listTags()
}

export async function solevupListBlocksForDate(date: string): Promise<BlockRow[]> {
  if (!Native) return []
  return Native.listBlocksForDate(date)
}

export async function solevupUpsertCategory(args: UpsertCategoryArgs): Promise<number> {
  if (!Native) return -1
  return Native.upsertCategory(args)
}

export async function solevupUpsertTag(args: UpsertTagArgs): Promise<number> {
  if (!Native) return -1
  return Native.upsertTag(args)
}

export async function solevupPaintBlocks(date: string, minutes: number[], tagId: number): Promise<number> {
  if (!Native) return 0
  return Native.paintBlocks(date, minutes, tagId)
}

export async function solevupEraseBlocks(date: string, minutes: number[]): Promise<number> {
  if (!Native) return 0
  return Native.eraseBlocks(date, minutes)
}

export async function solevupDeleteTag(tagId: number): Promise<number> {
  if (!Native) return 0
  return Native.deleteTag(tagId)
}

export async function solevupDeleteCategory(categoryId: number): Promise<number> {
  if (!Native) return 0
  return Native.deleteCategory(categoryId)
}

export async function solevupRenameCategory(
  categoryId: number,
  newName: string | null,
  newColor: string | null,
): Promise<number> {
  if (!Native) return 0
  return Native.renameCategory(categoryId, newName ?? '', newColor ?? '')
}

export async function solevupRenameTagPath(tagId: number, newFullPath: string, cascade = false): Promise<number> {
  if (!Native) return 0
  return Native.renameTagPath(tagId, newFullPath, cascade)
}

export interface SyncedSetting {
  readonly key: string
  readonly value: string
  readonly updated_at: string
}

/** 随同步走的设置，规则见 agent/synced-settings.ts */
export async function solevupListSyncedSettings(): Promise<SyncedSetting[]> {
  if (!Native) return []
  return Native.listSyncedSettings()
}

export async function solevupSaveSyncedSetting(key: string, value: string, seed: boolean): Promise<void> {
  if (!Native) return
  await Native.saveSyncedSetting(key, value, seed)
}

export async function solevupGetPref(key: string, fallback: string): Promise<string> {
  if (!Native) return fallback
  return Native.getPref(key, fallback)
}

export async function solevupSetPref(key: string, value: string): Promise<boolean> {
  if (!Native) return false
  return Native.setPref(key, value)
}

/**
 * 把对端 SyncExport 合进本地，LWW 按 updated_at 比较，
 * sync_id 主匹配 + 业务键回查 + (date, minute) slot 冲突保护。
 * 返回每张表实际 upsert 行数 + skipped。
 */
export async function solevupImportSync(payload: SyncExport): Promise<SyncImportResult> {
  if (!Native) {
    return {
      activityCategories: 0, activityTags: 0, activityBlocks: 0,
      planNodes: 0, plannedBlocks: 0, skipped: 0,
    }
  }
  return Native.importSync(payload)
}

/**
 * 增量导出（since cursor 之后 updated_at 或 deleted_at 变化的行）。
 * since = null → 全量。返回结构对齐 desktop SyncExport，可直接用作
 * POST /api/sync/import 的 body 给对端 LWW 合并。
 */
export async function solevupExportSync(since: string | null = null): Promise<SyncExport> {
  if (!Native) {
    return {
      deviceId: '', exportedAt: '', cursor: '',
      activityCategories: [], activityTags: [], activityBlocks: [],
      planNodes: [], plannedBlocks: [],
    }
  }
  return Native.exportSync(since)
}

// ── 模型配置（LAN 同步过来的 model_api_keys / feature_bindings；用量落库回推） ──

export async function solevupGetActiveModelApiKey(provider: string = 'dashscope'): Promise<ModelApiKeyInfo | null> {
  if (!Native) return null
  return Native.getActiveModelApiKey(provider)
}

export async function solevupListModelApiKeys(): Promise<ModelApiKeyInfo[]> {
  if (!Native) return []
  return Native.listModelApiKeys()
}

export async function solevupGetFeatureBinding(feature: string): Promise<string | null> {
  if (!Native) return null
  return Native.getFeatureBinding(feature)
}

export async function solevupUpsertModelApiKey(args: {
  id?: string | null
  label: string
  apiKey: string
  provider?: string
  activate?: boolean
}): Promise<ModelApiKeyInfo | null> {
  if (!Native) return null
  return Native.upsertModelApiKey(args.id ?? null, args.label, args.apiKey, args.provider ?? 'dashscope', args.activate ?? false)
}

export async function solevupSetActiveModelApiKey(id: string): Promise<boolean> {
  if (!Native) return false
  return Native.setActiveModelApiKey(id)
}

export async function solevupDeleteModelApiKey(id: string): Promise<boolean> {
  if (!Native) return false
  return Native.deleteModelApiKey(id)
}

/** 模型库（字段形状同 desktop ModelDef）；空表时返回空数组，由调用方用静态种子兜底 */
export async function solevupListModelCatalogJson(): Promise<string> {
  if (!Native) return '[]'
  return Native.listModelCatalog()
}

export async function solevupSeedModelCatalogIfEmpty(json: string): Promise<boolean> {
  if (!Native) return false
  return Native.seedModelCatalogIfEmpty(json)
}

/** 手机端自己拉来的模型行写进库：有就整行换掉（含价目），没有就加；返回写入的行数 */
export async function solevupUpsertModelCatalog(json: string): Promise<number> {
  if (!Native) return 0
  return Native.upsertModelCatalog(json)
}

/** 按价目算费用并落库，返回 ModelCallLog 形状的 JSON 字符串（消息 usage_json 直接存它） */
export async function solevupLogModelCall(row: ModelCallLogInsert): Promise<string | null> {
  if (!Native) return null
  return Native.logModelCall(row)
}

export async function solevupListFeatureBindings(): Promise<{ feature: string; modelId: string; updatedAt: string }[]> {
  if (!Native) return []
  return Native.listFeatureBindings()
}

export async function solevupSetFeatureBinding(feature: string, modelId: string): Promise<boolean> {
  if (!Native) return false
  return Native.setFeatureBinding(feature, modelId)
}

export type ModelCallLogRow = {
  id: string
  apiKeyId: string | null
  feature: string
  modelId: string
  startedAt: string
  durationMs: number | null
  promptTextTokens: number
  promptImageTokens: number
  promptVideoTokens: number
  promptAudioTokens: number
  completionTextTokens: number
  completionAudioTokens: number
  costCny: number | null
  costUsd: number | null
  freeQuotaTokens: number
  freeQuotaSavedCny: number
  success: boolean
  errorMessage: string | null
  metadata: string | null
}

export type ModelFreeQuotaRow = {
  modelId: string
  hasFreeQuota: boolean
  notSupported: boolean
  usedTokens: number
  totalTokens: number
  remainingTokens: number
  usedPercent: string | null
  expireDate: string | null
  rawQuota: string | null
  scannedAt: string
  errorMessage: string | null
}

export async function solevupQueryModelCallLog(since: string | null, limit = 2000): Promise<ModelCallLogRow[]> {
  if (!Native) return []
  return Native.queryModelCallLog(since, limit)
}

// ── 用量界面：字段形状同 desktop local-api.ts（snake_case），原生层直接给 JSON 字符串 ──

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
  cost_usd?: number | null
  free_quota_tokens: number
  free_quota_saved_cny: number
  success: boolean
  error_message: string | null
  metadata: string | null
}

export interface CallLogBucket {
  bucket: string
  call_count: number
  prompt_tokens_total: number
  completion_tokens_total: number
  cost_cny_total: number
  cost_usd_total: number
}

export type CallLogGranularity = 'minute' | 'hour' | 'day'

export async function solevupQueryCallLog(args: {
  timeFrom?: string | null
  timeTo?: string | null
  feature?: string | null
  modelId?: string | null
  apiKeyId?: string | null
  limit?: number | null
}): Promise<ModelCallLog[]> {
  if (!Native) return []
  const json = await Native.queryCallLog(
    args.timeFrom ?? null,
    args.timeTo ?? null,
    args.feature ?? null,
    args.modelId ?? null,
    args.apiKeyId ?? null,
    args.limit ?? 0,
  )
  return JSON.parse(json) as ModelCallLog[]
}

export async function solevupAggregateCallLog(args: {
  timeFrom: string
  timeTo: string
  granularity: CallLogGranularity
  feature?: string | null
  modelId?: string | null
  apiKeyId?: string | null
}): Promise<CallLogBucket[]> {
  if (!Native) return []
  const json = await Native.aggregateCallLog(
    args.timeFrom,
    args.timeTo,
    args.granularity,
    args.feature ?? null,
    args.modelId ?? null,
    args.apiKeyId ?? null,
  )
  return JSON.parse(json) as CallLogBucket[]
}

export async function solevupGetModelCallLog(id: string): Promise<ModelCallLog | null> {
  if (!Native) return null
  const json = await Native.getModelCallLog(id)
  return json ? (JSON.parse(json) as ModelCallLog) : null
}

/** 复制敏感文本（API Key）到系统剪贴板 */
export async function solevupCopyText(text: string): Promise<boolean> {
  if (!Native) return false
  return Native.copyText(text)
}

export async function solevupListModelFreeQuota(): Promise<ModelFreeQuotaRow[]> {
  if (!Native) return []
  return Native.listModelFreeQuota()
}

// ── 聊天会话（schema 对齐 desktop chat_sessions/chat_messages） ──

export type ChatSessionRow = {
  id: string
  title: string
  summary: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
}

export type ChatMessageDbRow = {
  id: string
  role: string
  content: string | null
  timestamp: string
  audioPath?: string | null
  durationMs?: number | null
  usageJson?: string | null
  reasoning?: string | null
  toolCalls?: string | null
  toolCallId?: string | null
  name?: string | null
}

export type ChatSessionSearchHit = {
  session: ChatSessionRow
  snippets: { role: string; excerpt: string; timestamp: string }[]
}

export async function solevupCreateChatSession(): Promise<ChatSessionRow | null> {
  if (!Native) return null
  return Native.createChatSession()
}

export async function solevupListChatSessions(limit = 100): Promise<ChatSessionRow[]> {
  if (!Native) return []
  return Native.listChatSessions(limit)
}

export async function solevupGetChatMessages(sessionId: string): Promise<ChatMessageDbRow[]> {
  if (!Native) return []
  const rows = await Native.getChatMessages(sessionId)
  for (const r of rows) seenMessageIds.add(r.id)
  return rows
}

// ── 往已删除的会话写消息 ──
// 界面开着会话 A，同步进来发现 A 已被另一台设备删除（墓碑）。native 层和 desktop 一样拒绝写入墓碑，这里接住：
//   · 这次进程里入过库的消息（读出来或写进去过）随删除一起消失，不写回。删除优先，否则删掉的内容会换个会话复活；
//   · 没入过库的消息（主人新写的）写进一个新会话，同一个墓碑只建一次；
//   · 主人在本机亲手删的会话不走这条路：迟到的流式回写直接丢弃，不能把它写回来。
// desktop 目前没有这层，append_chat_messages 拒绝后界面不知情，消息只留在屏幕上。

export type ChatAppendResult = {
  /** 消息实际落到的会话。和传入的不同 = 传入的会话已被其他设备删除，调用方要切过去并提醒主人 */
  sessionId: string
  /** 这批没有写入：本机亲手删的会话，或已被其他设备删除但这批里没有新内容 */
  discarded: boolean
}

const chatSuccessors = new Map<string, string>()
const locallyDeletedSessions = new Set<string>()
const seenMessageIds = new Set<string>()
const droppedMessageIds = new Set<string>()
// 排队：流式途中回写很密，并发时同一个墓碑会建出两个新会话
let chatAppendQueue: Promise<unknown> = Promise.resolve()

/** 值得为它新建会话的行：界面提示和空的流式占位不算 */
function hasNewContent(r: ChatMessageDbRow): boolean {
  if (r.role === 'system') return false
  if (r.role === 'user') return true
  return !!(r.content || r.reasoning || r.toolCalls)
}

async function appendOrReroute(
  native: SolevupDbNative,
  sessionId: string,
  rows: ChatMessageDbRow[],
): Promise<ChatAppendResult> {
  let target = sessionId
  for (let next = chatSuccessors.get(target); next; next = chatSuccessors.get(target)) target = next

  const kept = rows.filter((r) => !droppedMessageIds.has(r.id))
  if (kept.length === 0) return { sessionId: target, discarded: rows.length > 0 }
  if (await native.appendChatMessages(target, kept)) {
    for (const r of kept) seenMessageIds.add(r.id)
    return { sessionId: target, discarded: false }
  }

  if (locallyDeletedSessions.has(target)) return { sessionId: target, discarded: true }
  const fresh = kept.filter((r) => !seenMessageIds.has(r.id))
  for (const r of kept) if (seenMessageIds.has(r.id)) droppedMessageIds.add(r.id)
  if (!fresh.some(hasNewContent)) return { sessionId: target, discarded: true }

  const next = await native.createChatSession()
  chatSuccessors.set(target, next.id)
  await native.appendChatMessages(next.id, fresh)
  for (const r of fresh) seenMessageIds.add(r.id)
  return { sessionId: next.id, discarded: false }
}

export async function solevupAppendChatMessages(sessionId: string, rows: ChatMessageDbRow[]): Promise<ChatAppendResult> {
  const native = Native
  if (!native) return { sessionId, discarded: true }
  const run = chatAppendQueue.then(() => appendOrReroute(native, sessionId, rows))
  chatAppendQueue = run.catch(() => {})
  return run
}

/** 会话是否已被删除。收到 SolevupDbChanged 时检查当前会话用，比「不在列表里」可靠（列表有上限） */
export async function solevupIsChatSessionDeleted(sessionId: string): Promise<boolean> {
  if (!Native) return false
  return Native.isChatSessionDeleted(sessionId)
}

export async function solevupSearchChatSessions(query: string, limit = 50): Promise<ChatSessionSearchHit[]> {
  if (!Native) return []
  return Native.searchChatSessions(query, limit)
}

export async function solevupPatchChatSession(sessionId: string, title: string | null, summary: string | null): Promise<boolean> {
  if (!Native) return false
  return Native.patchChatSession(sessionId, title, summary)
}

export async function solevupDeleteChatSession(sessionId: string): Promise<boolean> {
  if (!Native) return false
  locallyDeletedSessions.add(sessionId)
  return Native.deleteChatSession(sessionId)
}

/** 清理没有任何消息的空白会话（exceptId 排除当前会话），返回被删的 id */
export async function solevupCleanupEmptyChatSessions(exceptId: string | null): Promise<string[]> {
  if (!Native) return []
  return Native.cleanupEmptyChatSessions(exceptId)
}
