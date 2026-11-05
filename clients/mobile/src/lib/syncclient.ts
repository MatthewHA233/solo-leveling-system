// ══════════════════════════════════════════════
// SyncClient Native Module 桥接 (Android-only)
// 链接管理 + 手动同步；自动同步由原生 SyncRuntime 负责，不依赖任何页面
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'

export type LinkedDevice = {
  deviceId: string
  alias: string
  lastBase: string
  lastSyncedAt?: string
  createdAt: string
  syncing?: boolean
  lastError?: string
}

export type ImportResult = {
  activityCategories: number
  activityTags: number
  activityBlocks: number
  planNodes: number
  plannedBlocks: number
  modelApiKeys: number
  modelCallLog: number
  modelFreeQuota: number
  featureBindings: number
  chatSessions: number
  chatMessages: number
  modelRegistry: number
  skipped: number
}

export type SyncRoundResult = {
  deviceId: string
  alias: string
  pulled: ImportResult
  pushed: ImportResult
}

export type SyncAllItem = {
  deviceId: string
  alias: string
  ok: boolean
  pulled?: ImportResult
  pushed?: ImportResult
  error?: string
}

interface SyncClientNative {
  listLinkedDevices(): Promise<LinkedDevice[]>
  linkPeer(baseUrl: string): Promise<SyncRoundResult>
  unlinkPeer(deviceId: string): Promise<boolean>
  syncNow(deviceId: string): Promise<SyncRoundResult>
  syncAll(): Promise<SyncAllItem[]>
}

const Native: SyncClientNative | null =
  Platform.OS === 'android' ? (NativeModules.SyncClient as SyncClientNative) ?? null : null

export function isSyncClientAvailable(): boolean {
  return Native != null
}

export async function listLinkedDevices(): Promise<LinkedDevice[]> {
  if (!Native) return []
  return Native.listLinkedDevices()
}

export async function linkPeer(baseUrl: string): Promise<SyncRoundResult | null> {
  if (!Native) return null
  return Native.linkPeer(baseUrl)
}

export async function unlinkPeer(deviceId: string): Promise<boolean> {
  if (!Native) return false
  return Native.unlinkPeer(deviceId)
}

export async function syncNow(deviceId: string): Promise<SyncRoundResult | null> {
  if (!Native) return null
  return Native.syncNow(deviceId)
}

export async function syncAll(): Promise<SyncAllItem[]> {
  if (!Native) return []
  return Native.syncAll()
}
