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

export type PowerEvent = {
  rowId: number
  startAt: string
  /** screen_on / screen_off / unlocked / service_started */
  event: string
  eventTimeMs: number
}

export type AppMonitorSegment = {
  rowId: number
  dateKey: string
  /** app / power */
  kind: string
  startMs: number
  endMs: number
  packageName: string
  className: string
  appLabel: string
  windowTitle: string
  /** screen_on / screen_off / unlocked / service_started when kind=power */
  eventType: string
  eventCount: number
  titles: string[]
}

function normalizeAppMonitorSegment(seg: AppMonitorSegment): AppMonitorSegment {
  return {
    rowId: Number(seg.rowId || 0),
    dateKey: String(seg.dateKey || ''),
    kind: String(seg.kind || ''),
    startMs: Number(seg.startMs || 0),
    endMs: Number(seg.endMs || 0),
    packageName: String(seg.packageName || ''),
    className: String(seg.className || ''),
    appLabel: String(seg.appLabel || ''),
    windowTitle: String(seg.windowTitle || ''),
    eventType: String(seg.eventType || ''),
    eventCount: Number(seg.eventCount || 0),
    titles: Array.isArray(seg.titles) ? seg.titles.map(String) : [],
  }
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

export type TorrentStats = {
  rowCount: number
  rawBytes: number
  databaseBytes: number
  rawLimitMb: number
  appMonitorRowCount?: number
  appMonitorBytes?: number
  formalActionCount?: number
  formalActionBytes?: number
  formalCardCount?: number
  formalCardBytes?: number
}

export type TorrentRawLimitResult = {
  rawLimitMb: number
  deletedRows: number
  deletedDays: number
  rawBytesBefore: number
  rawBytesAfter: number
}

export type TorrentFormalSaveResult = {
  actionCount: number
  cardCount: number
}

export type TorrentFormalSourceRef = {
  rowId: number
  eventTimeMs: number
  packageName: string
  windowClass: string
  text?: string
}

export type TorrentFormalActionInput = {
  key: string
  packageName: string
  appLabel: string
  kind: string
  startTs: number
  endTs: number
  title?: string
  upName?: string
  isStory?: boolean
  payload?: Record<string, unknown>
  sourceRefs?: TorrentFormalSourceRef[]
}

export type TorrentFormalCardInput = {
  key: string
  packageName: string
  appLabel: string
  cardKind: string
  startTs: number
  endTs: number
  title?: string
  upName?: string
  payload?: Record<string, unknown>
  sourceRefs?: TorrentFormalSourceRef[]
}

export type TorrentFormalAction = {
  rowId: number
  dateKey: string
  parserId: string
  parserVersion: number
  key: string
  packageName: string
  appLabel: string
  kind: string
  startTs: number
  endTs: number
  title: string
  upName: string
  isStory: boolean
  payloadJson: string
  sourceRefsJson: string
}

export type TorrentFormalCard = {
  rowId: number
  dateKey: string
  parserId: string
  parserVersion: number
  key: string
  packageName: string
  appLabel: string
  cardKind: string
  startTs: number
  endTs: number
  title: string
  upName: string
  payloadJson: string
  sourceRefsJson: string
}

interface PerceptionNative {
  ping(): Promise<PingResult>
  dbStats(): Promise<DbStats>
  dbInsertProbe(): Promise<ProbeInsertResult>
  hasUsageAccess(): Promise<boolean>
  openUsageAccessSettings(): Promise<boolean>
  collectUsageStats(rangeMs: number): Promise<CollectUsageResult>
  queryUsageByEvents(startMs: number, endMs: number): Promise<ForegroundUsage[]>
  getLatestUsageSummary(): Promise<UsageSummary | null>
  isAccessibilityEnabled(): Promise<boolean>
  openAccessibilitySettings(): Promise<boolean>
  getRecentWindowEvents(limit: number): Promise<WindowEvent[]>
  getWindowEventsInRange(startMs: number, endMs: number, limit: number): Promise<WindowEvent[]>
  getPowerEventsInRange(startMs: number, endMs: number, limit: number): Promise<PowerEvent[]>
  getAppMonitorSegmentsInRange?(startMs: number, endMs: number, limit: number): Promise<AppMonitorSegment[]>
  getRecentAppMonitorSegments?(limit: number): Promise<AppMonitorSegment[]>
  getClickCounts(): Promise<ClickCountSnapshot>
  resetClickCounts(): Promise<boolean>
  getAppIcons(packageNames: string[]): Promise<Record<string, string>>
  purgeSelfWindowEvents(): Promise<number>
  getRecentTorrentCaptures(limit: number): Promise<TorrentCapture[]>
  getTorrentCapturesInRange(startMs: number, endMs: number, limit: number): Promise<TorrentCapture[]>
  getTorrentRawFingerprintInRange?(startMs: number, endMs: number): Promise<TorrentRawFingerprint>
  countTorrentCaptures(): Promise<number>
  getTorrentStats(): Promise<TorrentStats>
  setTorrentRawLimitMb?(rawLimitMb: number): Promise<TorrentRawLimitResult>
  clearTorrentCaptures(): Promise<number>
  getTorrentFormalMaxSourceEndMs?(dateKey: string): Promise<number>
  getTorrentFormalParserVersions?(dateKey: string): Promise<Array<{ parserId: string; parserVersion: number }>>
  saveTorrentFormalDay?(
    dayKey: string,
    parserId: string,
    parserVersion: number,
    sourceStartMs: number,
    sourceEndMs: number,
    actionsJson: string,
    cardsJson: string,
  ): Promise<TorrentFormalSaveResult>
  getTorrentFormalActionsInRange?(startMs: number, endMs: number, limit: number): Promise<TorrentFormalAction[]>
  getTorrentFormalCardsInRange?(startMs: number, endMs: number, limit: number): Promise<TorrentFormalCard[]>
}

export type TorrentCapture = {
  rowId: number
  eventTimeMs: number
  packageName: string
  windowClass: string
  captureType: string
  text: string
  textHash: string
  sourceClass: string
}

export type TorrentRawFingerprint = {
  count: number
  firstRowId: number
  lastRowId: number
  minEventTimeMs: number
  maxEventTimeMs: number
}

const Native: PerceptionNative | null =
  Platform.OS === 'android' ? (NativeModules.Perception as PerceptionNative) ?? null : null

const MONITOR_TRANSIENT_PACKAGES = new Set([
  'com.android.systemui',
  'com.coloros.smartsidebar',
])
const MONITOR_LAUNCHER_PACKAGES = new Set([
  'com.android.launcher',
])

function localDateKey(ms: number): string {
  const d = new Date(ms)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function isMonitorNoiseEvent(ev: WindowEvent): boolean {
  const title = ev.windowTitle?.trim() || ''
  const pkg = ev.packageName || ''
  const cls = ev.className || ''
  if (!pkg) return true
  if (MONITOR_TRANSIENT_PACKAGES.has(pkg)) return true
  if (pkg.includes('inputmethod') || cls.includes('inputmethodservice.SoftInputWindow')) return true
  if (MONITOR_LAUNCHER_PACKAGES.has(pkg)) {
    if (title.includes('最近用过的应用') || title.startsWith('文件夹已') || title === '应用图标') return true
  }
  return title === '应用图标'
}

function compactWindowTitles(events: WindowEvent[]): string[] {
  const out: string[] = []
  for (const ev of events) {
    const label = ev.appLabel || ev.packageName
    const title = ev.windowTitle?.trim()
    if (!title || title === label || title === ev.packageName) continue
    if (out[out.length - 1] !== title) out.push(title)
  }
  return out
}

function rawAppMonitorToSegments(
  events: WindowEvent[],
  powerEvents: PowerEvent[],
  rangeEndMs: number,
): AppMonitorSegment[] {
  const sorted = events
    .filter((ev) => !isMonitorNoiseEvent(ev))
    .sort((a, b) => a.eventTimeMs - b.eventTimeMs || a.rowId - b.rowId)
  const segments: AppMonitorSegment[] = []
  let current: WindowEvent[] = []
  const flush = (nextStartMs?: number) => {
    if (current.length === 0) return
    const first = current[0]
    const last = current[current.length - 1]
    const endMs = Math.max(last.eventTimeMs, Math.min(nextStartMs ?? rangeEndMs, rangeEndMs))
    const titles = compactWindowTitles(current)
    segments.push({
      rowId: first.rowId,
      dateKey: localDateKey(first.eventTimeMs),
      kind: 'app',
      startMs: first.eventTimeMs,
      endMs,
      packageName: first.packageName,
      className: last.className,
      appLabel: first.appLabel || first.packageName,
      windowTitle: titles[titles.length - 1] ?? last.windowTitle ?? '',
      eventType: '',
      eventCount: current.length,
      titles,
    })
    current = []
  }
  for (const ev of sorted) {
    const last = current[current.length - 1]
    if (!last || last.packageName === ev.packageName) {
      current.push(ev)
    } else {
      flush(ev.eventTimeMs)
      current.push(ev)
    }
  }
  flush()
  for (const ev of powerEvents) {
    if (ev.event === 'boot' || ev.event === 'shutdown') continue
    segments.push({
      rowId: ev.rowId,
      dateKey: localDateKey(ev.eventTimeMs),
      kind: 'power',
      startMs: ev.eventTimeMs,
      endMs: ev.eventTimeMs,
      packageName: '',
      className: '',
      appLabel: '',
      windowTitle: '',
      eventType: ev.event,
      eventCount: 1,
      titles: [],
    })
  }
  return segments.sort((a, b) => a.startMs - b.startMs || a.rowId - b.rowId)
}

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

export type ForegroundUsage = {
  packageName: string
  appLabel: string
  totalMs: number
}

/** queryEvents 精确统计区间内各 app 前台时长（系统对照，不落库） */
export async function queryUsageByEvents(startMs: number, endMs: number): Promise<ForegroundUsage[]> {
  if (!Native) throw new Error('Perception native module unavailable')
  return Native.queryUsageByEvents(startMs, endMs)
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

export async function getPowerEventsInRange(
  startMs: number,
  endMs: number,
  limit: number = 100,
): Promise<PowerEvent[]> {
  if (!Native) return []
  return Native.getPowerEventsInRange(startMs, endMs, limit)
}

export async function getAppMonitorSegmentsInRange(
  startMs: number,
  endMs: number,
  limit: number = 5000,
): Promise<AppMonitorSegment[]> {
  if (!Native) return []
  let formal: AppMonitorSegment[] = []
  if (typeof Native.getAppMonitorSegmentsInRange === 'function') {
    try {
      formal = await Native.getAppMonitorSegmentsInRange(startMs, endMs, limit)
      formal = Array.from(formal || []).map(normalizeAppMonitorSegment)
      console.log('[perception-monitor]', {
        source: 'formal',
        count: formal.length,
        first: formal[0]?.packageName,
      })
    } catch (e) {
      console.warn('[perception] getAppMonitorSegmentsInRange failed', e)
    }
  }
  if (formal.length > 0) return formal
  const [events, powerEvents] = await Promise.all([
    Native.getWindowEventsInRange(startMs, endMs, Math.max(5000, limit)),
    Native.getPowerEventsInRange(startMs, endMs, 2000),
  ])
  console.log('[perception-monitor]', { source: 'fallback-raw-compatible', events: events.length, powerEvents: powerEvents.length })
  return rawAppMonitorToSegments(events, powerEvents, endMs).slice(0, limit)
}

export async function getRecentAppMonitorSegments(limit: number = 20): Promise<AppMonitorSegment[]> {
  if (!Native) return []
  if (typeof Native.getRecentAppMonitorSegments === 'function') {
    try {
      const formal = await Native.getRecentAppMonitorSegments(limit)
      return Array.from(formal || []).map(normalizeAppMonitorSegment)
    } catch (e) {
      console.warn('[perception] getRecentAppMonitorSegments failed', e)
      return []
    }
  }
  return []
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

export async function getRecentTorrentCaptures(limit: number = 200): Promise<TorrentCapture[]> {
  if (!Native) return []
  return Native.getRecentTorrentCaptures(limit)
}

export async function getTorrentCapturesInRange(
  startMs: number, endMs: number, limit: number = 1000,
): Promise<TorrentCapture[]> {
  if (!Native) return []
  return Native.getTorrentCapturesInRange(startMs, endMs, limit)
}

export async function countTorrentCaptures(): Promise<number> {
  if (!Native) return 0
  return Native.countTorrentCaptures()
}

export async function getTorrentStats(): Promise<TorrentStats> {
  if (!Native) {
    return {
      rowCount: 0,
      rawBytes: 0,
      databaseBytes: 0,
      rawLimitMb: 256,
      appMonitorRowCount: 0,
      appMonitorBytes: 0,
      formalActionCount: 0,
      formalActionBytes: 0,
      formalCardCount: 0,
      formalCardBytes: 0,
    }
  }
  const stats = await Native.getTorrentStats()
  return {
    ...stats,
    rawLimitMb: Number.isFinite(stats.rawLimitMb) ? stats.rawLimitMb : 256,
    appMonitorRowCount: Number(stats.appMonitorRowCount || 0),
    appMonitorBytes: Number(stats.appMonitorBytes || 0),
    formalActionCount: Number(stats.formalActionCount || 0),
    formalActionBytes: Number(stats.formalActionBytes || 0),
    formalCardCount: Number(stats.formalCardCount || 0),
    formalCardBytes: Number(stats.formalCardBytes || 0),
  }
}

export async function setTorrentRawLimitMb(rawLimitMb: number): Promise<TorrentRawLimitResult> {
  if (!Native) {
    return {
      rawLimitMb,
      deletedRows: 0,
      deletedDays: 0,
      rawBytesBefore: 0,
      rawBytesAfter: 0,
    }
  }
  if (typeof Native.setTorrentRawLimitMb !== 'function') {
    throw new Error('当前安装包缺少洪流域 raw 上限接口，请安装新版 debug/release 包')
  }
  return Native.setTorrentRawLimitMb(rawLimitMb)
}

export async function clearTorrentCaptures(): Promise<number> {
  if (!Native) return 0
  return Native.clearTorrentCaptures()
}

export async function getTorrentRawFingerprintInRange(
  startMs: number,
  endMs: number,
): Promise<TorrentRawFingerprint> {
  if (!Native || typeof Native.getTorrentRawFingerprintInRange !== 'function') {
    return { count: 0, firstRowId: 0, lastRowId: 0, minEventTimeMs: 0, maxEventTimeMs: 0 }
  }
  return Native.getTorrentRawFingerprintInRange(startMs, endMs)
}

export async function getTorrentFormalMaxSourceEndMs(dayKey: string): Promise<number> {
  if (!Native || typeof Native.getTorrentFormalMaxSourceEndMs !== 'function') return 0
  return Native.getTorrentFormalMaxSourceEndMs(dayKey)
}

/** 某天已物化的 parser@版本 集合，用于"parser 变了就让正式数据失效重建" */
export async function getTorrentFormalParserVersions(dayKey: string): Promise<Array<{ parserId: string; parserVersion: number }>> {
  if (!Native || typeof Native.getTorrentFormalParserVersions !== 'function') return []
  return Native.getTorrentFormalParserVersions(dayKey)
}

export async function saveTorrentFormalDay(params: {
  dayKey: string
  parserId: string
  parserVersion: number
  sourceStartMs: number
  sourceEndMs: number
  actions: TorrentFormalActionInput[]
  cards: TorrentFormalCardInput[]
}): Promise<TorrentFormalSaveResult> {
  if (!Native) return { actionCount: 0, cardCount: 0 }
  if (typeof Native.saveTorrentFormalDay !== 'function') {
    throw new Error('当前安装包缺少洪流域正式表接口，请安装新版 debug/release 包')
  }
  return Native.saveTorrentFormalDay(
    params.dayKey,
    params.parserId,
    params.parserVersion,
    params.sourceStartMs,
    params.sourceEndMs,
    JSON.stringify(params.actions ?? []),
    JSON.stringify(params.cards ?? []),
  )
}

export async function getTorrentFormalActionsInRange(
  startMs: number,
  endMs: number,
  limit: number = 10000,
): Promise<TorrentFormalAction[]> {
  if (!Native || typeof Native.getTorrentFormalActionsInRange !== 'function') return []
  return Native.getTorrentFormalActionsInRange(startMs, endMs, limit)
}

export async function getTorrentFormalCardsInRange(
  startMs: number,
  endMs: number,
  limit: number = 10000,
): Promise<TorrentFormalCard[]> {
  if (!Native || typeof Native.getTorrentFormalCardsInRange !== 'function') return []
  return Native.getTorrentFormalCardsInRange(startMs, endMs, limit)
}
