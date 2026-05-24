// ══════════════════════════════════════════════
// SoloDb Native Module 桥接 (Android-only)
// 真 SQLite 数据访问层；schema 镜像 desktop solo.db
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'

type PingResult = {
  ok: boolean
  ts: number
  module: string
}

export type SoloDbStats = {
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
}

interface SoloDbNative {
  ping(): Promise<PingResult>
  getDeviceId(): Promise<string>
  getStats(): Promise<SoloDbStats>
  listCategories(): Promise<CategoryRow[]>
  listTags(): Promise<TagRow[]>
  listBlocksForDate(date: string): Promise<BlockRow[]>
  upsertCategory(args: UpsertCategoryArgs): Promise<number>
  upsertTag(args: UpsertTagArgs): Promise<number>
  paintBlocks(date: string, minutes: number[], tagId: number): Promise<number>
  eraseBlocks(date: string, minutes: number[]): Promise<number>
  exportSync(since: string | null): Promise<SyncExport>
}

const Native: SoloDbNative | null =
  Platform.OS === 'android' ? (NativeModules.SoloDb as SoloDbNative) ?? null : null

export function isSoloDbAvailable(): boolean {
  return Native != null
}

export async function pingSoloDb(): Promise<PingResult | null> {
  if (!Native) return null
  return Native.ping()
}

export async function getSoloDbDeviceId(): Promise<string | null> {
  if (!Native) return null
  return Native.getDeviceId()
}

export async function getSoloDbStats(): Promise<SoloDbStats | null> {
  if (!Native) return null
  return Native.getStats()
}

export async function soloListCategories(): Promise<CategoryRow[]> {
  if (!Native) return []
  return Native.listCategories()
}

export async function soloListTags(): Promise<TagRow[]> {
  if (!Native) return []
  return Native.listTags()
}

export async function soloListBlocksForDate(date: string): Promise<BlockRow[]> {
  if (!Native) return []
  return Native.listBlocksForDate(date)
}

export async function soloUpsertCategory(args: UpsertCategoryArgs): Promise<number> {
  if (!Native) return -1
  return Native.upsertCategory(args)
}

export async function soloUpsertTag(args: UpsertTagArgs): Promise<number> {
  if (!Native) return -1
  return Native.upsertTag(args)
}

export async function soloPaintBlocks(date: string, minutes: number[], tagId: number): Promise<number> {
  if (!Native) return 0
  return Native.paintBlocks(date, minutes, tagId)
}

export async function soloEraseBlocks(date: string, minutes: number[]): Promise<number> {
  if (!Native) return 0
  return Native.eraseBlocks(date, minutes)
}

/**
 * 增量导出（since cursor 之后 updated_at 或 deleted_at 变化的行）。
 * since = null → 全量。返回结构对齐 desktop SyncExport，可直接用作
 * POST /api/sync/import 的 body 给对端 LWW 合并。
 */
export async function soloExportSync(since: string | null = null): Promise<SyncExport> {
  if (!Native) {
    return {
      deviceId: '', exportedAt: '', cursor: '',
      activityCategories: [], activityTags: [], activityBlocks: [],
      planNodes: [], plannedBlocks: [],
    }
  }
  return Native.exportSync(since)
}
