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
  renameTagPath(tagId: number, newFullPath: string): Promise<number>
  getPref(key: string, fallback: string): Promise<string>
  setPref(key: string, value: string): Promise<boolean>
  exportSync(since: string | null): Promise<SyncExport>
  importSync(payload: SyncExport): Promise<SyncImportResult>
  getActiveModelApiKey(): Promise<ModelApiKeyInfo | null>
  listModelApiKeys(): Promise<ModelApiKeyListItem[]>
  getFeatureBinding(feature: string): Promise<string | null>
  listFeatureBindings(): Promise<{ feature: string; modelId: string }[]>
  setFeatureBinding(feature: string, modelId: string): Promise<boolean>
  queryModelCallLog(since: string | null, limit: number): Promise<ModelCallLogRow[]>
  listModelFreeQuota(): Promise<ModelFreeQuotaRow[]>
  createChatSession(): Promise<ChatSessionRow>
  listChatSessions(limit: number): Promise<ChatSessionRow[]>
  getChatMessages(sessionId: string): Promise<ChatMessageDbRow[]>
  appendChatMessages(sessionId: string, rows: ChatMessageDbRow[]): Promise<boolean>
  patchChatSession(sessionId: string, title: string | null, summary: string | null): Promise<boolean>
  deleteChatSession(sessionId: string): Promise<boolean>
  cleanupEmptyChatSessions(exceptId: string | null): Promise<boolean>
  insertModelCallLog(row: ModelCallLogInsert): Promise<string>
}

export type ModelApiKeyInfo = {
  id: string
  label: string
  apiKey: string
  isActive: boolean
}

export type ModelApiKeyListItem = {
  id: string
  label: string
  isActive: boolean
  hasKey: boolean
}

export type ModelCallLogInsert = {
  apiKeyId?: string | null
  feature: string
  modelId: string
  startedAt: string
  durationMs?: number | null
  promptTextTokens?: number
  completionTextTokens?: number
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

export async function solevupRenameTagPath(tagId: number, newFullPath: string): Promise<number> {
  if (!Native) return 0
  return Native.renameTagPath(tagId, newFullPath)
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

export async function solevupGetActiveModelApiKey(): Promise<ModelApiKeyInfo | null> {
  if (!Native) return null
  return Native.getActiveModelApiKey()
}

export async function solevupListModelApiKeys(): Promise<ModelApiKeyListItem[]> {
  if (!Native) return []
  return Native.listModelApiKeys()
}

export async function solevupGetFeatureBinding(feature: string): Promise<string | null> {
  if (!Native) return null
  return Native.getFeatureBinding(feature)
}

export async function solevupInsertModelCallLog(row: ModelCallLogInsert): Promise<string | null> {
  if (!Native) return null
  return Native.insertModelCallLog(row)
}

export async function solevupListFeatureBindings(): Promise<{ feature: string; modelId: string }[]> {
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
  freeQuotaTokens: number
  freeQuotaSavedCny: number
  success: boolean
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
  scannedAt: string
  errorMessage: string | null
}

export async function solevupQueryModelCallLog(since: string | null, limit = 2000): Promise<ModelCallLogRow[]> {
  if (!Native) return []
  return Native.queryModelCallLog(since, limit)
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
  return Native.getChatMessages(sessionId)
}

export async function solevupAppendChatMessages(sessionId: string, rows: ChatMessageDbRow[]): Promise<boolean> {
  if (!Native) return false
  return Native.appendChatMessages(sessionId, rows)
}

export async function solevupPatchChatSession(sessionId: string, title: string | null, summary: string | null): Promise<boolean> {
  if (!Native) return false
  return Native.patchChatSession(sessionId, title, summary)
}

export async function solevupDeleteChatSession(sessionId: string): Promise<boolean> {
  if (!Native) return false
  return Native.deleteChatSession(sessionId)
}

export async function solevupCleanupEmptyChatSessions(exceptId: string | null): Promise<boolean> {
  if (!Native) return false
  return Native.cleanupEmptyChatSessions(exceptId)
}
