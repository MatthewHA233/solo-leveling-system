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
  /** 配对时换到的令牌，访问对端的私有接口要带 */
  authToken: string
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
  settings: number
  chatImages: number
  skipped: number
}

/** 配对页的在线状态和型号 */
export type LinkProbe = {
  deviceId: string
  online: boolean
  deviceType?: string
  deviceModel?: string
}

export type SyncRoundResult = {
  deviceId: string
  alias: string
  pulled: ImportResult
  pushed: ImportResult
}

export type LinkPeerResult = {
  deviceId: string
  alias: string
  /** 第一轮同步的结果。配对成功但同步失败时没有，原因在 syncError */
  pulled?: ImportResult
  pushed?: ImportResult
  syncError?: string
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
  linkPeer(baseUrl: string, code: string): Promise<LinkPeerResult>
  verifyLinkedPeer(deviceId: string): Promise<string | null>
  probeLinkedPeers(): Promise<LinkProbe[]>
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

/** code 是对方设备上显示的配对码；两边都记成已链接，之后不用再输 */
export async function linkPeer(baseUrl: string, code: string): Promise<LinkPeerResult | null> {
  if (!Native) return null
  return Native.linkPeer(baseUrl, code)
}

/** 确认对面持有同一个令牌，通过时返回对端 deviceType，否则 null */
export async function verifyLinkedPeer(deviceId: string): Promise<string | null> {
  if (!Native) return null
  return Native.verifyLinkedPeer(deviceId)
}

export async function probeLinkedPeers(): Promise<LinkProbe[]> {
  if (!Native) return []
  return Native.probeLinkedPeers()
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
