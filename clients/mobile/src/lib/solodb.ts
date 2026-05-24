// ══════════════════════════════════════════════
// SoloDb Native Module 桥接 (Android-only)
// Phase 0：仅暴露 ping / deviceId / stats 验证连通
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

interface SoloDbNative {
  ping(): Promise<PingResult>
  getDeviceId(): Promise<string>
  getStats(): Promise<SoloDbStats>
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
