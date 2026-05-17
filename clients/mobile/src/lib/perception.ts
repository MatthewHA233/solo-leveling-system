// ══════════════════════════════════════════════
// 感知层 Native Module 桥接 (Android-only)
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'

type PingResult = {
  ok: boolean
  ts: number
  platform: string
  module: string
}

export type DbStats = {
  bucketCount: number
  eventCount: number
  path: string
}

export type ProbeInsertResult = {
  rowId: number
  bucketId: string
  at: string
}

interface PerceptionNative {
  ping(): Promise<PingResult>
  dbStats(): Promise<DbStats>
  dbInsertProbe(): Promise<ProbeInsertResult>
}

const Native: PerceptionNative | null =
  Platform.OS === 'android' ? (NativeModules.Perception as PerceptionNative) ?? null : null

export function isPerceptionAvailable(): boolean {
  return Native != null
}

export async function pingPerception(): Promise<PingResult | null> {
  if (!Native) return null
  return Native.ping()
}

export async function fetchDbStats(): Promise<DbStats | null> {
  if (!Native) return null
  return Native.dbStats()
}

export async function insertDbProbe(): Promise<ProbeInsertResult | null> {
  if (!Native) return null
  return Native.dbInsertProbe()
}
