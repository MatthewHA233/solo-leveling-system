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

export type CollectUsageResult = {
  rowId: number
  intervalStart: string
  intervalEnd: string
  appCount: number
  totalForegroundMs: number
}

export type UsageApp = {
  packageName: string
  appLabel: string
  totalTimeMs: number
  lastTimeUsed: number
}

export type UsageSummary = {
  rowId: number
  intervalEndMs: number
  apps: UsageApp[]
}

interface PerceptionNative {
  ping(): Promise<PingResult>
  dbStats(): Promise<DbStats>
  dbInsertProbe(): Promise<ProbeInsertResult>
  hasUsageAccess(): Promise<boolean>
  openUsageAccessSettings(): Promise<boolean>
  collectUsageStats(rangeMs: number): Promise<CollectUsageResult>
  getLatestUsageSummary(): Promise<UsageSummary | null>
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

export async function hasUsageAccess(): Promise<boolean> {
  if (!Native) return false
  return Native.hasUsageAccess()
}

export async function openUsageAccessSettings(): Promise<boolean> {
  if (!Native) return false
  return Native.openUsageAccessSettings()
}

export async function collectUsageStats(
  rangeMs: number = 24 * 60 * 60 * 1000,
): Promise<CollectUsageResult | null> {
  if (!Native) return null
  return Native.collectUsageStats(rangeMs)
}

export async function getLatestUsageSummary(): Promise<UsageSummary | null> {
  if (!Native) return null
  return Native.getLatestUsageSummary()
}
