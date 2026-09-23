// ══════════════════════════════════════════════
// SyncServer Native Module 桥接 (Android-only)
// 启停 NanoHTTPD，端口默认 39733（与 desktop 统一；旧版 49733 已弃用）
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'

export type SyncServerStatus = {
  running: boolean
  port: number
  ipv4s: string[]
}

interface SyncServerNative {
  start(port: number): Promise<SyncServerStatus>
  stop(): Promise<boolean>
  status(): Promise<SyncServerStatus>
}

const Native: SyncServerNative | null =
  Platform.OS === 'android' ? (NativeModules.SyncServer as SyncServerNative) ?? null : null

export const SYNC_SERVER_DEFAULT_PORT = 39733

export function isSyncServerAvailable(): boolean {
  return Native != null
}

export async function startSyncServer(
  port: number = SYNC_SERVER_DEFAULT_PORT,
): Promise<SyncServerStatus | null> {
  if (!Native) return null
  return Native.start(port)
}

export async function stopSyncServer(): Promise<boolean> {
  if (!Native) return false
  return Native.stop()
}

export async function getSyncServerStatus(): Promise<SyncServerStatus | null> {
  if (!Native) return null
  return Native.status()
}
