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

export type WindowEvent = {
  rowId: number
  startAt: string
  packageName: string
  className: string
  appLabel: string
  windowTitle: string
  eventTimeMs: number
}

export type ClickCountEntry = {
  packageName: string
  appLabel: string
  count: number
}

export type ClickCountSnapshot = {
  total: number
  entries: ClickCountEntry[]
}

interface PerceptionNative {
  ping(): Promise<PingResult>
  dbStats(): Promise<DbStats>
  dbInsertProbe(): Promise<ProbeInsertResult>
  hasUsageAccess(): Promise<boolean>
  openUsageAccessSettings(): Promise<boolean>
  collectUsageStats(rangeMs: number): Promise<CollectUsageResult>
  getLatestUsageSummary(): Promise<UsageSummary | null>
  isAccessibilityEnabled(): Promise<boolean>
  openAccessibilitySettings(): Promise<boolean>
  getRecentWindowEvents(limit: number): Promise<WindowEvent[]>
  getWindowEventsInRange(startMs: number, endMs: number, limit: number): Promise<WindowEvent[]>
  getClickCounts(): Promise<ClickCountSnapshot>
  resetClickCounts(): Promise<boolean>
  getAppIcons(packageNames: string[]): Promise<Record<string, string>>
  purgeSelfWindowEvents(): Promise<number>
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

export async function isAccessibilityEnabled(): Promise<boolean> {
  if (!Native) return false
  return Native.isAccessibilityEnabled()
}

export async function openAccessibilitySettings(): Promise<boolean> {
  if (!Native) return false
  return Native.openAccessibilitySettings()
}

export async function getRecentWindowEvents(limit: number = 20): Promise<WindowEvent[]> {
  if (!Native) return []
  return Native.getRecentWindowEvents(limit)
}

export async function getWindowEventsInRange(
  startMs: number,
  endMs: number,
  limit: number = 200,
): Promise<WindowEvent[]> {
  if (!Native) return []
  return Native.getWindowEventsInRange(startMs, endMs, limit)
}

export async function getClickCounts(): Promise<ClickCountSnapshot> {
  if (!Native) return { total: 0, entries: [] }
  return Native.getClickCounts()
}

export async function resetClickCounts(): Promise<boolean> {
  if (!Native) return false
  return Native.resetClickCounts()
}

/**
 * 批量取 app launcher 图标，返回 { pkg: base64PngStr }。空串表示解不出（系统服务等）。
 * 上层用法：<Image source={{ uri: `data:image/png;base64,${base64}` }} />
 */
export async function getAppIcons(packageNames: string[]): Promise<Record<string, string>> {
  if (!Native || packageNames.length === 0) return {}
  return Native.getAppIcons(packageNames)
}

export async function purgeSelfWindowEvents(): Promise<number> {
  if (!Native) return 0
  return Native.purgeSelfWindowEvents()
}
