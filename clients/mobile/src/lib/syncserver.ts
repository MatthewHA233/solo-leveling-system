// ══════════════════════════════════════════════
// SyncServer Native Module 桥接 (Android-only)
// 同步服务由原生 SyncRuntime 随进程启动（端口 39733，与 desktop 统一）；
// 这里只看状态、重试和附近设备，不再由页面启停
// ══════════════════════════════════════════════

import { DeviceEventEmitter, NativeModules, Platform } from 'react-native'

export type SyncServerStatus = {
  running: boolean
  port: number
  ipv4s: string[]
  error?: string
  alias: string
  deviceId: string
  pairCode: string
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

export async function listNearbyPeers(): Promise<NearbyPeer[]> {
  if (!Native) return []
  return Native.listNearbyPeers()
}

export function subscribeSyncStatus(listener: (event: SyncStatusEvent) => void): () => void {
  const sub = DeviceEventEmitter.addListener('SolevupSyncStatus', listener)
  return () => sub.remove()
}
