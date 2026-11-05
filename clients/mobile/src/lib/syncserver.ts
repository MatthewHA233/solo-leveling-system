// ══════════════════════════════════════════════
// SyncServer Native Module 桥接 (Android-only)
// 同步服务由原生 SyncRuntime 随进程启动（端口 39733，与 desktop 统一）；
// 这里只看状态、日志、重试、改别名和附近设备，不再由页面启停
// ══════════════════════════════════════════════

import { DeviceEventEmitter, NativeModules, Platform } from 'react-native'

export type SyncServerStatus = {
  running: boolean
  port: number
  ipv4s: string[]
  error?: string
  alias: string
  deviceId: string
  deviceModel: string
  pairCode: string
  /** 下次自动同步的时间（毫秒）。不在前台时是 0 */
  nextAutoSyncAt: number
}

export type SyncLogEntry = {
  at: number
  text: string
}

export type NearbyPeer = {
  deviceId: string
  alias: string
  deviceType: string
  deviceModel: string
  base: string
  pairCode: string
}

export type SyncStatusEvent = {
  deviceId: string
  syncing: boolean
  ok?: boolean
  error?: string
}

interface SyncServerNative {
  status(): Promise<SyncServerStatus>
  retry(): Promise<SyncServerStatus>
  listNearbyPeers(): Promise<NearbyPeer[]>
  refreshPeers(): Promise<NearbyPeer[]>
  setAlias(alias: string): Promise<SyncServerStatus>
  syncLog(): Promise<SyncLogEntry[]>
  createPairCode(): Promise<{ code: string; ttlSeconds: number }>
}

const Native: SyncServerNative | null =
  Platform.OS === 'android' ? (NativeModules.SyncServer as SyncServerNative) ?? null : null

export function isSyncServerAvailable(): boolean {
  return Native != null
}

export async function getSyncServerStatus(): Promise<SyncServerStatus | null> {
  if (!Native) return null
  return Native.status()
}

export async function retrySyncServer(): Promise<SyncServerStatus | null> {
  if (!Native) return null
  return Native.retry()
}

/** 生成配对码给对方设备输入（5 分钟有效，用一次就作废） */
export async function createPairCode(): Promise<{ code: string; ttlSeconds: number } | null> {
  if (!Native) return null
  return Native.createPairCode()
}

export async function listNearbyPeers(): Promise<NearbyPeer[]> {
  if (!Native) return []
  return Native.listNearbyPeers()
}

/** 主人点刷新：广播一轮，没人回应就扫网段，要几秒 */
export async function refreshNearbyPeers(): Promise<NearbyPeer[]> {
  if (!Native) return []
  return Native.refreshPeers()
}

export async function setSyncAlias(alias: string): Promise<SyncServerStatus | null> {
  if (!Native) return null
  return Native.setAlias(alias)
}

/** 最近 20 条，新的在前 */
export async function getSyncLog(): Promise<SyncLogEntry[]> {
  if (!Native) return []
  return Native.syncLog()
}

export function subscribeSyncStatus(listener: (event: SyncStatusEvent) => void): () => void {
  const sub = DeviceEventEmitter.addListener('SolevupSyncStatus', listener)
  return () => sub.remove()
}
