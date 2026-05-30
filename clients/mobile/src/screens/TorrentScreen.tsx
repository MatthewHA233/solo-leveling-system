// ══════════════════════════════════════════════
// 洪流域：用户在 app 里看到的内容还原 UI。
// B 站 raw 解析与动作/卡片模型在 ./torrent/bilibili.ts。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import {
  getAppIcons,
  getRecentTorrentCaptures,
  getPowerEventsInRange,
  getWindowEventsInRange,
  isAccessibilityEnabled,
  openAccessibilitySettings,
  type PowerEvent,
  type TorrentCapture,
  type WindowEvent,
} from '../lib/perception'
import CalendarPopover, { type DayRangeColored } from '../components/CalendarPopover'
import SharedDateHeader from '../components/SharedDateHeader'
import { soloGetPref, soloSetPref } from '../lib/solodb'
import { isSameDay, toLocalDateStr } from '../lib/time'
import { alpha, theme } from '../theme'
import {
  BILI_ACCENT as HOME_ACCENT,
  BILI_PACKAGE,
  buildBiliActionListItems as buildActionListItems,
  buildBiliFeedListItems as buildFeedListItems,
  feedKindLabel,
  getBiliPackageLabel as getPackageLabel,
  splitPlayProgressSegments,
  type BiliActionKind,
  type CommentItem,
  type HomeFeedItem,
  type ListItem,
  type PlayProgressSample,
  type VideoSubTab,
} from './torrent/bilibili'

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

// 视频内秒 → mm:ss / hh:mm:ss
function fmtVidSec(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

const EMPTY_TAG_BY_ID = new Map()
const EMPTY_CATEGORY_BY_ID = new Map()
const TORRENT_CALENDAR_CACHE_KEY = 'torrent.calendar.ranges.v1'

function clampMinute(n: number): number {
  return Math.max(0, Math.min(1440, n))
}

function minuteOfTs(ts: number): number {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes()
}

function mergeTorrentCalendarRanges(ranges: DayRangeColored[]): DayRangeColored[] {
  const sorted = ranges
    .filter((r) => r.endMin > r.startMin)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  const out: DayRangeColored[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && last.color === r.color && r.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, r.endMin)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

function sameCalendarRanges(a: readonly DayRangeColored[] | undefined, b: readonly DayRangeColored[]): boolean {
  if (!a || a.length !== b.length) return false
  return a.every((r, i) =>
    r.startMin === b[i].startMin
    && r.endMin === b[i].endMin
    && r.color === b[i].color)
}

function buildTorrentCalendarRanges(items: TorrentCapture[]): DayRangeColored[] {
  if (items.length === 0) return []
  const actions = buildActionListItems(items).filter((x): x is Extract<ListItem, { kind: 'actionLine' }> => x.kind === 'actionLine')
  const ranges = actions.map((a) => {
    const startMin = clampMinute(minuteOfTs(a.ts))
    const rawEnd = a.endTs
      ? (isSameDay(new Date(a.ts), new Date(a.endTs)) ? minuteOfTs(a.endTs) + 1 : 1440)
      : startMin + 5
    const endMin = clampMinute(Math.max(startMin + 5, rawEnd))
    return { startMin, endMin, color: HOME_ACCENT }
  })
  return mergeTorrentCalendarRanges(ranges)
}

type ViewMode = 'monitor' | 'raw' | 'feed' | 'action'
type SortOrder = 'desc' | 'asc'
type JumpKind = 'home' | 'detail' | 'story' | 'fullscreen' | 'comments'
type JumpTarget = { ts: number; preferKind?: JumpKind }
type CrossJump = (targetViewMode: ViewMode, ts: number, preferKind?: JumpKind) => void
type AppMonitorRun = {
  key: string
  packageName: string
  appLabel: string
  startMs: number
  endMs: number
  eventCount: number
  titles: string[]
}
type AppMonitorSwitch = {
  key: string
  startMs: number
  endMs: number
  runs: AppMonitorRun[]
  packageNames: string[]
  labels: string[]
  eventCount: number
}
type AppMonitorRow =
  | { kind: 'run'; key: string; ts: number; run: AppMonitorRun }
  | { kind: 'switch'; key: string; ts: number; sw: AppMonitorSwitch }
  | { kind: 'power'; key: string; ts: number; event: PowerEvent }

// 【DEV-only】卡片对照调试：把范围设成 ['HH:MM:SS', 'HH:MM:SS']
// 限定只看这段时间的 raw → 单独研究某一卡片，不污染 UI
// 提交前必须设回 null
const DEV_TIME_RANGE: [string, string] | null = null
const FAST_APP_SWITCH_WINDOW_MS = 60_000
// HH:MM:SS → 当天毫秒（用 items 中任意一条的本地日期作为基准日）
function hhmmssToMs(hhmmss: string, items: TorrentCapture[]): number {
  if (items.length === 0) return 0
  const ref = new Date(items[0].eventTimeMs)
  const [h, m, s] = hhmmss.split(':').map(Number)
  ref.setHours(h, m, s, 0)
  return ref.getTime()
}

function localDayBounds(date: Date): { startMs: number; endMs: number } {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const startMs = d.getTime()
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 }
}

function fmtShortDuration(ms: number): string {
  if (ms < 60_000) return '<1 分'
  const mins = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h > 0 && m > 0) return `${h}小时${m}分`
  if (h > 0) return `${h}小时`
  return `${m}分`
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

function buildAppMonitorRuns(events: WindowEvent[], segmentEndMs: number): AppMonitorRun[] {
  const sorted = [...events].sort((a, b) => a.eventTimeMs - b.eventTimeMs || a.rowId - b.rowId)
  const runs: AppMonitorRun[] = []
  let currentEvents: WindowEvent[] = []
  const flush = (nextStartMs?: number) => {
    if (currentEvents.length === 0) return
    const first = currentEvents[0]
    const last = currentEvents[currentEvents.length - 1]
    const endMs = Math.max(last.eventTimeMs, Math.min(nextStartMs ?? segmentEndMs, segmentEndMs))
    runs.push({
      key: `app-run-${first.rowId}-${last.rowId}`,
      packageName: first.packageName,
      appLabel: first.appLabel || first.packageName,
      startMs: first.eventTimeMs,
      endMs,
      eventCount: currentEvents.length,
      titles: compactWindowTitles(currentEvents),
    })
    currentEvents = []
  }
  for (const ev of sorted) {
    const last = currentEvents[currentEvents.length - 1]
    if (!last || last.packageName === ev.packageName) {
      currentEvents.push(ev)
    } else {
      flush(ev.eventTimeMs)
      currentEvents.push(ev)
    }
  }
  flush()
  return runs
}

function uniqStrings(values: string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    if (!value || out.includes(value)) continue
    out.push(value)
  }
  return out
}

function makeAppSwitch(group: AppMonitorRun[]): AppMonitorSwitch {
  const first = group[0]
  const last = group[group.length - 1]
  return {
    key: `app-switch-${first.key}-${last.key}`,
    startMs: first.startMs,
    endMs: last.endMs,
    runs: group,
    packageNames: uniqStrings(group.map((r) => r.packageName)),
    labels: uniqStrings(group.map((r) => r.appLabel || r.packageName)),
    eventCount: group.reduce((sum, r) => sum + r.eventCount, 0),
  }
}

function buildAppMonitorRows(runs: AppMonitorRun[], powerEvents: PowerEvent[]): AppMonitorRow[] {
  const appRows: AppMonitorRow[] = []
  let i = 0
  while (i < runs.length) {
    const group = [runs[i]]
    let j = i + 1
    while (j < runs.length && runs[j].endMs - group[0].startMs <= FAST_APP_SWITCH_WINDOW_MS) {
      group.push(runs[j])
      j++
    }
    const distinctPackages = new Set(group.map((r) => r.packageName))
    if (group.length >= 2 && distinctPackages.size >= 2) {
      const sw = makeAppSwitch(group)
      appRows.push({ kind: 'switch', key: sw.key, ts: sw.startMs, sw })
      i = j
    } else {
      const run = runs[i]
      appRows.push({ kind: 'run', key: run.key, ts: run.startMs, run })
      i++
    }
  }
  const powerRows: AppMonitorRow[] = powerEvents
    .filter((event) => event.event !== 'boot' && event.event !== 'shutdown')
    .map((event) => ({ kind: 'power', key: `power-${event.rowId}`, ts: event.eventTimeMs, event }))
  return [...appRows, ...powerRows].sort((a, b) => a.ts - b.ts)
}

function powerEventLabel(event: string): string {
  if (event === 'screen_on') return '屏幕亮起'
  if (event === 'screen_off') return '屏幕熄灭'
  if (event === 'unlocked') return '解锁手机'
  if (event === 'service_started') return '感知服务启动'
  return event
}

function mergeByRowId<T extends { rowId: number; eventTimeMs: number }>(prev: T[], next: T[]): T[] {
  if (prev.length === 0) return [...next].sort((a, b) => a.eventTimeMs - b.eventTimeMs || a.rowId - b.rowId)
  if (next.length === 0) return prev
  const map = new Map<number, T>()
  for (const item of prev) map.set(item.rowId, item)
  for (const item of next) map.set(item.rowId, item)
  return Array.from(map.values()).sort((a, b) => a.eventTimeMs - b.eventTimeMs || a.rowId - b.rowId)
}

function maxEventTime<T extends { eventTimeMs: number }>(items: T[]): number {
  let max = 0
  for (const item of items) if (item.eventTimeMs > max) max = item.eventTimeMs
  return max
}

export type TorrentScreenDevData = {
  items: TorrentCapture[]
  total: number
  a11yOn: boolean
}

export type TorrentScreenDevSource = {
  pollMs?: number
  load: () => Promise<TorrentScreenDevData>
  loadAppMonitor?: (startMs: number, endMs: number) => Promise<{ events: WindowEvent[]; powerEvents: PowerEvent[] }>
  clear?: () => Promise<void>
  clearLabel?: string
  openAccessibilitySettings?: () => void
}

export default function TorrentScreen({ devSource, searchText }: { devSource?: TorrentScreenDevSource; searchText?: string } = {}) {
  const [items, setItems] = useState<TorrentCapture[]>([])
  const [a11yOn, setA11yOn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('monitor')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | null>(null)
  const [highlightKey, setHighlightKey] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [a11yPromptOpen, setA11yPromptOpen] = useState(false)
  const [appIconCache, setAppIconCache] = useState<Record<string, string>>({})
  const [calendarRangesByDay, setCalendarRangesByDay] = useState<Record<string, DayRangeColored[]>>({})
  const [monitorEvents, setMonitorEvents] = useState<WindowEvent[]>([])
  const [monitorPowerEvents, setMonitorPowerEvents] = useState<PowerEvent[]>([])
  const [monitorLoading, setMonitorLoading] = useState(false)
  const [monitorRefreshing, setMonitorRefreshing] = useState(false)
  const liveRef = useRef(true)
  const a11yPromptShownRef = useRef(false)
  const monitorEventsRef = useRef<WindowEvent[]>([])
  const monitorPowerEventsRef = useRef<PowerEvent[]>([])
  const prevViewModeRef = useRef<ViewMode>('monitor')

  const selectedDayBounds = useMemo(() => localDayBounds(selectedDate), [selectedDate])
  const visibleItems = useMemo(
    () => items.filter((it) => isSameDay(new Date(it.eventTimeMs), selectedDate)),
    [items, selectedDate],
  )
  const iconPackageKey = useMemo(() => {
    return Array.from(new Set([
      ...visibleItems.map((it) => it.packageName).filter(Boolean),
      ...monitorEvents.map((it) => it.packageName).filter(Boolean),
    ])).sort().join('|')
  }, [visibleItems, monitorEvents])

  useEffect(() => { monitorEventsRef.current = monitorEvents }, [monitorEvents])
  useEffect(() => { monitorPowerEventsRef.current = monitorPowerEvents }, [monitorPowerEvents])

  // 跨视图跳转：从动作行点 → 切到 feed 跳到对应卡片；从卡头点 → 切到 action 跳到对应行
  const onCrossJump = useCallback<CrossJump>((targetVm, ts, preferKind) => {
    setViewMode(targetVm)
    setTimeout(() => setJumpTarget({ ts, preferKind }), 50)
  }, [])

  // 闪烁高亮目标（jumpTarget 不为空 → 滚动结束后高亮 1.6s）
  const onJumpHighlight = useCallback((key: string) => {
    setHighlightKey(key)
    setTimeout(() => setHighlightKey(null), 1600)
  }, [])

  const refresh = useCallback(async () => {
    try {
      // 默认读完整 raw 快照；性能优化只能靠取消后台轮询 / 后续转译表，
      // 不能截断 raw，否则还原动作会丢上下文。
      const [list, on] = devSource
        ? await devSource.load().then((data) => [data.items, data.a11yOn] as const)
        : await Promise.all([
            getRecentTorrentCaptures(50000),
            isAccessibilityEnabled(),
          ])
      if (!liveRef.current) return
      setItems(list)
      setA11yOn(on)
    } catch (e) {
      console.warn('[torrent] refresh failed', e)
    } finally {
      if (liveRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [devSource])

  const refreshAppMonitor = useCallback(async (mode: 'full' | 'incremental' = 'full') => {
    const prevEvents = monitorEventsRef.current
    const prevPowerEvents = monitorPowerEventsRef.current
    const hasExisting = prevEvents.length > 0 || prevPowerEvents.length > 0
    if (mode === 'full' || !hasExisting) setMonitorLoading(true)
    try {
      const now = Date.now()
      const endMs = Math.min(selectedDayBounds.endMs, now)
      const latestSeen = Math.max(maxEventTime(prevEvents), maxEventTime(prevPowerEvents))
      const queryStartMs = mode === 'incremental' && hasExisting
        ? Math.max(selectedDayBounds.startMs, latestSeen - 1000)
        : selectedDayBounds.startMs
      const loaded = devSource?.loadAppMonitor
        ? await devSource.loadAppMonitor(queryStartMs, selectedDayBounds.endMs)
        : await Promise.all([
            getWindowEventsInRange(queryStartMs, selectedDayBounds.endMs, 5000),
            getPowerEventsInRange(queryStartMs, selectedDayBounds.endMs, 2000),
          ]).then(([events, powerEvents]) => ({ events, powerEvents }))
      if (!liveRef.current) return
      if (mode === 'incremental' && hasExisting) {
        setMonitorEvents(mergeByRowId(prevEvents, loaded.events).filter((e) => e.eventTimeMs <= endMs))
        setMonitorPowerEvents(mergeByRowId(prevPowerEvents, loaded.powerEvents).filter((e) => e.eventTimeMs <= endMs))
      } else {
        setMonitorEvents(loaded.events.filter((e) => e.eventTimeMs <= endMs))
        setMonitorPowerEvents(loaded.powerEvents.filter((e) => e.eventTimeMs <= endMs))
      }
    } catch (e) {
      console.warn('[torrent] app monitor refresh failed', e)
      if (liveRef.current) {
        setMonitorEvents([])
        setMonitorPowerEvents([])
      }
    } finally {
      if (liveRef.current) {
        setMonitorLoading(false)
        setMonitorRefreshing(false)
      }
    }
  }, [devSource, selectedDayBounds.startMs, selectedDayBounds.endMs])

  useEffect(() => {
    liveRef.current = true
    refresh()
    const pollMs = devSource?.pollMs
    const id = pollMs != null && pollMs > 0 ? setInterval(refresh, pollMs) : null
    return () => {
      liveRef.current = false
      if (id != null) clearInterval(id)
    }
  }, [refresh, devSource?.pollMs])

  useEffect(() => {
    void refreshAppMonitor()
  }, [refreshAppMonitor])

  useEffect(() => {
    const prev = prevViewModeRef.current
    prevViewModeRef.current = viewMode
    if (prev !== viewMode && viewMode === 'monitor') void refreshAppMonitor('incremental')
  }, [viewMode, refreshAppMonitor])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return
      void refresh()
      void refreshAppMonitor('incremental')
    })
    return () => sub.remove()
  }, [refresh, refreshAppMonitor])

  useEffect(() => {
    let cancelled = false
    soloGetPref(TORRENT_CALENDAR_CACHE_KEY, '')
      .then((raw) => {
        if (cancelled || !raw) return
        const parsed = JSON.parse(raw) as Record<string, DayRangeColored[]>
        setCalendarRangesByDay(parsed && typeof parsed === 'object' ? parsed : {})
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (loading) return
    const dayKey = toLocalDateStr(selectedDate)
    const ranges = buildTorrentCalendarRanges(visibleItems)
    setCalendarRangesByDay((prev) => {
      if (sameCalendarRanges(prev[dayKey], ranges)) return prev
      const next = { ...prev, [dayKey]: ranges }
      soloSetPref(TORRENT_CALENDAR_CACHE_KEY, JSON.stringify(next)).catch(() => {})
      return next
    })
  }, [loading, selectedDate, visibleItems])

  useEffect(() => {
    if (loading || a11yOn || devSource || a11yPromptShownRef.current) return
    a11yPromptShownRef.current = true
    setA11yPromptOpen(true)
  }, [a11yOn, devSource, loading])

  useEffect(() => {
    const packages = iconPackageKey ? iconPackageKey.split('|') : []
    const missing = packages.filter((pkg) => !(pkg in appIconCache))
    if (missing.length === 0) return
    let cancelled = false
    getAppIcons(missing)
      .then((icons) => {
        if (cancelled) return
        setAppIconCache((prev) => {
          const next = { ...prev }
          for (const pkg of missing) next[pkg] = icons[pkg] ?? ''
          return next
        })
      })
      .catch((e) => console.warn('[torrent] load app icons failed', e))
    return () => { cancelled = true }
  }, [iconPackageKey, appIconCache])

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <SharedDateHeader
          selectedDate={selectedDate}
          onChangeDate={setSelectedDate}
          onOpenCalendar={() => setCalendarOpen(true)}
        />
        <View style={styles.modeRow}>
          {(['monitor', 'action', 'feed', 'raw'] as ViewMode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => setViewMode(m)}
              style={[styles.modeChip, viewMode === m && styles.modeChipOn]}
            >
              <Text
                style={[styles.modeChipText, viewMode === m && styles.modeChipTextOn]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
              >
                {m === 'monitor' ? '应用监控' : m === 'feed' ? '还原卡片' : m === 'action' ? '还原动作' : '原始 SLS 数据'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.contentArea}>
        <Pressable
          onPress={() => setSortOrder((s) => s === 'desc' ? 'asc' : 'desc')}
          style={styles.sortFloat}
        >
          <Text style={styles.sortFloatText}>
            {sortOrder === 'desc' ? '新→旧 ↓' : '旧→新 ↑'}
          </Text>
        </Pressable>
        {viewMode === 'monitor' ? (
          <AppMonitorView
            events={monitorEvents}
            powerEvents={monitorPowerEvents}
            loading={monitorLoading}
            refreshing={monitorRefreshing}
            onRefresh={() => {
              setMonitorRefreshing(true)
              refreshAppMonitor()
            }}
            appIconCache={appIconCache}
            rangeEndMs={Math.min(selectedDayBounds.endMs, Date.now())}
            sortOrder={sortOrder}
          />
        ) : loading ? (
          <View style={styles.empty}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : visibleItems.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyHint}>
              这一天还没抓到文本{'\n\n'}
              打开哔哩哔哩 app，刷一刷首页{'\n'}
              这边会自动出现你看到过的视频卡片
            </Text>
          </View>
        ) : (
          <RenderList
            items={visibleItems}
            viewMode={viewMode}
            sortOrder={sortOrder}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true)
              refresh()
            }}
            jumpTarget={jumpTarget}
            onJumpDone={(targetKey) => {
              setJumpTarget(null)
              if (targetKey) onJumpHighlight(targetKey)
            }}
            onCrossJump={onCrossJump}
            highlightKey={highlightKey}
            appIconCache={appIconCache}
            searchText={searchText}
          />
        )}
      </View>
      <CalendarPopover
        open={calendarOpen}
        selectedDate={selectedDate}
        tagById={EMPTY_TAG_BY_ID}
        categoryById={EMPTY_CATEGORY_BY_ID}
        externalRangesByDay={calendarRangesByDay}
        loadActivityRanges={false}
        onSelect={setSelectedDate}
        onClose={() => setCalendarOpen(false)}
      />
      <Modal visible={a11yPromptOpen} transparent animationType="fade" onRequestClose={() => setA11yPromptOpen(false)}>
        <Pressable style={styles.helpBackdrop} onPress={() => setA11yPromptOpen(false)}>
          <Pressable style={styles.helpCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.helpTitle}>需要开启 SLS 辅助功能</Text>
            <Text style={styles.helpText}>
              洪流域依赖辅助功能记录你在 app 里看到的文本。开启后，回到 B 站或其他内容 app，新的文本会进入还原数据。
            </Text>
            <View style={styles.promptActions}>
              <Pressable onPress={() => setA11yPromptOpen(false)} style={[styles.helpClose, styles.promptGhost]}>
                <Text style={[styles.helpCloseText, styles.promptGhostText]}>稍后</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setA11yPromptOpen(false)
                  if (devSource?.openAccessibilitySettings) devSource.openAccessibilitySettings()
                  else openAccessibilitySettings()
                }}
                style={styles.helpClose}
              >
                <Text style={styles.helpCloseText}>去开启</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}

function buildRawListItems(itemsIn: TorrentCapture[]): ListItem[] {
  // items 默认 DESC，但要按"同秒同窗 → 同 group"分组必须按 rowId ASC 处理，
  // 让 group.texts[0] 是该秒最早 = a11y 树最顶端 = 视觉自顶向下顺序
  const items = [...itemsIn].sort((a, b) => a.rowId - b.rowId)
  type Group = ListItem & { kind: 'rawSnapshot' }
  const groups: Group[] = []
  for (const c of items) {
    const secKey = Math.floor(c.eventTimeMs / 1000)
    const last = groups[groups.length - 1]
    if (
      last
      && Math.floor(last.ts / 1000) === secKey
      && last.packageName === c.packageName
      && last.windowClass === c.windowClass
    ) {
      last.texts.push({ rowId: c.rowId, text: c.text, sourceClass: c.sourceClass })
    } else {
      groups.push({
        kind: 'rawSnapshot',
        key: `r-${c.rowId}`,
        ts: c.eventTimeMs,
        packageName: c.packageName,
        windowClass: c.windowClass,
        texts: [{ rowId: c.rowId, text: c.text, sourceClass: c.sourceClass }],
      })
    }
  }
  return groups.reverse()  // 默认 desc，跟 feed/action 语义一致；UI 可切 asc
}

// 收集 ListItem 内所有字符串值，用于搜索匹配（不依赖具体字段名，鲁棒）
function collectStrings(v: any, acc: string[], depth = 0): void {
  if (v == null || depth > 6) return
  if (typeof v === 'string') { acc.push(v); return }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, acc, depth + 1); return }
  if (typeof v === 'object') { for (const k in v) collectStrings((v as any)[k], acc, depth + 1); return }
}
function itemSearchText(it: ListItem): string {
  const acc: string[] = []
  collectStrings(it, acc)
  return acc.join(' ').toLowerCase()
}

function AppMonitorView({
  events,
  powerEvents,
  loading,
  refreshing,
  onRefresh,
  appIconCache,
  rangeEndMs,
  sortOrder,
}: {
  events: WindowEvent[]
  powerEvents: PowerEvent[]
  loading: boolean
  refreshing: boolean
  onRefresh: () => void
  appIconCache: Record<string, string>
  rangeEndMs: number
  sortOrder: SortOrder
}) {
  const runs = useMemo(() => buildAppMonitorRuns(events, rangeEndMs), [events, rangeEndMs])
  const rows = useMemo(() => {
    const base = buildAppMonitorRows(runs, powerEvents)
    return sortOrder === 'asc' ? base : [...base].reverse()
  }, [runs, powerEvents, sortOrder])
  const switchCount = rows.filter((row) => row.kind === 'switch').length
  const [expandedSwitchKeys, setExpandedSwitchKeys] = useState<Set<string>>(() => new Set())
  const toggleSwitchExpanded = (key: string) => {
    setExpandedSwitchKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (loading && rows.length === 0) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.monitorList}
      contentContainerStyle={styles.monitorContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.monitorSummary}>
        <Text style={styles.monitorTitle}>应用监控</Text>
        <Text style={styles.monitorMeta}>
          {runs.length} 段应用 · {events.length} 条窗口切换 · {powerEvents.length} 条屏幕事件
          {switchCount > 0 ? ` · ${switchCount} 组快速切换` : ''}
        </Text>
      </View>
      {rows.length === 0 ? (
        <View style={styles.emptyInline}>
          <Text style={styles.emptyHint}>
            这一天还没有窗口切换记录{'\n\n'}
            开启辅助功能后，切换 app、亮屏、解锁等事件会出现在这里
          </Text>
        </View>
      ) : (
        rows.map((row) => {
          if (row.kind === 'power') {
            const dim = row.event.event === 'screen_off'
            return (
              <View key={row.key} style={styles.monitorPowerRow}>
                <Text style={styles.monitorTime}>{fmtTime(row.event.eventTimeMs).slice(0, 5)}</Text>
                <View style={[styles.monitorPowerDot, dim && styles.monitorPowerDotDim]} />
                <Text style={[styles.monitorPowerText, dim && { color: theme.inkSoft }]}>
                  {powerEventLabel(row.event.event)}
                </Text>
              </View>
            )
          }
          if (row.kind === 'switch') {
            const sw = row.sw
            const expanded = expandedSwitchKeys.has(sw.key)
            const shownRuns = expanded ? sw.runs : sw.runs.slice(0, 4)
            const hiddenCount = Math.max(0, sw.runs.length - shownRuns.length)
            const appTitle = sw.labels.join(' → ')
            return (
              <View key={row.key} style={[styles.monitorRunRow, styles.monitorSwitchRow]}>
                <Text style={styles.monitorTime}>
                  {fmtTime(sw.startMs).slice(0, 5)}
                  {sw.endMs > sw.startMs ? `\n${fmtTime(sw.endMs).slice(0, 5)}` : ''}
                </Text>
                <View style={[styles.monitorSwitchIcons, expanded && styles.monitorSwitchIconsExpanded]}>
                  {shownRuns.map((run, idx) => {
                    const b64 = appIconCache[run.packageName]
                    const initial = (run.appLabel || run.packageName || '?').slice(0, 1).toUpperCase()
                    return b64 ? (
                      <Image key={`${run.key}-${idx}`} style={styles.monitorSwitchIcon} source={{ uri: `data:image/png;base64,${b64}` }} />
                    ) : (
                      <View key={`${run.key}-${idx}`} style={styles.monitorSwitchIconFallback}>
                        <Text style={styles.monitorSwitchIconText}>{initial}</Text>
                      </View>
                    )
                  })}
                  {hiddenCount > 0 && (
                    <Pressable hitSlop={8} onPress={() => toggleSwitchExpanded(sw.key)} style={styles.monitorSwitchMore}>
                      <Text style={styles.monitorSwitchMoreText}>+{hiddenCount}</Text>
                    </Pressable>
                  )}
                  {expanded && sw.runs.length > 4 && (
                    <Pressable hitSlop={8} onPress={() => toggleSwitchExpanded(sw.key)} style={styles.monitorSwitchMore}>
                      <Text style={styles.monitorSwitchMoreText}>收</Text>
                    </Pressable>
                  )}
                </View>
                <View style={styles.monitorBody}>
                  <View style={styles.monitorAppHead}>
                    <Text style={styles.monitorApp} numberOfLines={expanded ? 2 : 1}>{appTitle}</Text>
                    <Text style={styles.monitorDuration}>快速切换 · {sw.eventCount} 次</Text>
                  </View>
                  <Text style={styles.monitorWindowTitle} numberOfLines={expanded ? 3 : 1}>
                    {sw.runs.length} 段应用在 1 分钟内切换
                  </Text>
                  <Text style={styles.monitorPkg} numberOfLines={1}>{sw.packageNames.join(' / ')}</Text>
                </View>
              </View>
            )
          }
          const run = row.run
          const label = run.appLabel || run.packageName
          const title = run.titles[run.titles.length - 1] ?? ''
          const b64 = appIconCache[run.packageName]
          const initial = (label || '?').slice(0, 1).toUpperCase()
          return (
            <View key={row.key} style={styles.monitorRunRow}>
              <Text style={styles.monitorTime}>
                {fmtTime(run.startMs).slice(0, 5)}
                {run.endMs > run.startMs ? `\n${fmtTime(run.endMs).slice(0, 5)}` : ''}
              </Text>
              {b64 ? (
                <Image style={styles.monitorIcon} source={{ uri: `data:image/png;base64,${b64}` }} />
              ) : (
                <View style={styles.monitorIconFallback}>
                  <Text style={styles.monitorIconText}>{initial}</Text>
                </View>
              )}
              <View style={styles.monitorBody}>
                <View style={styles.monitorAppHead}>
                  <Text style={styles.monitorApp} numberOfLines={1}>{label}</Text>
                  <Text style={styles.monitorDuration}>
                    {fmtShortDuration(run.endMs - run.startMs)}
                    {run.eventCount > 1 ? ` · ${run.eventCount} 次` : ''}
                  </Text>
                </View>
                {!!title && <Text style={styles.monitorWindowTitle} numberOfLines={1}>{title}</Text>}
                <Text style={styles.monitorPkg} numberOfLines={1}>{run.packageName}</Text>
              </View>
            </View>
          )
        })
      )}
    </ScrollView>
  )
}

function RenderList({
  items, viewMode, sortOrder, refreshing, onRefresh, jumpTarget, onJumpDone, onCrossJump, highlightKey, appIconCache, searchText,
}: {
  items: TorrentCapture[]
  viewMode: ViewMode
  sortOrder: SortOrder
  refreshing: boolean
  onRefresh: () => void
  jumpTarget: JumpTarget | null
  onJumpDone: (targetKey: string | null) => void
  onCrossJump: CrossJump
  highlightKey: string | null
  appIconCache: Record<string, string>
  searchText?: string
}) {
  // 【DEV-only】按时间戳范围过滤 raw items（卡片对照调试）
  const filteredItems = useMemo(() => {
    if (!DEV_TIME_RANGE) return items
    const [from, to] = DEV_TIME_RANGE.map((t) => hhmmssToMs(t, items))
    return items.filter((c) => c.eventTimeMs >= from && c.eventTimeMs <= to)
  }, [items])
  const listItems = useMemo(() => {
    let base: ListItem[]
    if (viewMode === 'feed') base = buildFeedListItems(filteredItems)
    else if (viewMode === 'action') base = buildActionListItems(filteredItems)
    else base = buildRawListItems(filteredItems)
    // build 函数们默认 desc（新→旧）；切 asc 时整体 reverse
    // feed 视图按 [_groupTs(sortOrder), _groupIdx ASC] 排：组级别翻转，组内顺序保持
    // 其他视图整体 reverse 即可
    if (viewMode === 'feed') {
      const sorted = [...base].sort((a, b) => {
        const aGTs = (a as any)._groupTs ?? ('tsEnd' in a ? a.tsEnd : 0)
        const bGTs = (b as any)._groupTs ?? ('tsEnd' in b ? b.tsEnd : 0)
        if (aGTs !== bGTs) return sortOrder === 'asc' ? aGTs - bGTs : bGTs - aGTs
        const aIdx = (a as any)._groupIdx ?? 0
        const bIdx = (b as any)._groupIdx ?? 0
        return aIdx - bIdx
      })
      return sorted
    }
    return sortOrder === 'asc' ? [...base].reverse() : base
  }, [filteredItems, viewMode, sortOrder])

  // AUDIT-038：useRef / useEffect 必须无条件调用（React Hooks rules）。
  // 之前 listItems.length===0 提前 return 会让 Hooks 在空列表→非空切换时顺序错乱。
  const listRef = useRef<FlatList<ListItem>>(null)
  useEffect(() => {
    if (jumpTarget == null) return
    if (listItems.length === 0) { onJumpDone(null); return }
    const targetTs = jumpTarget.ts
    const preferKind = jumpTarget.preferKind
    const getTs = (it: ListItem) => {
      if ('tsStart' in it) return it.tsStart
      if ('ts' in it) return it.ts
      return 0
    }
    // 1) 优先匹配 preferKind 且 ts 在范围内的 item（用于动作子段精确跳到对应卡）
    let bestIdx = -1, bestDelta = Infinity
    if (preferKind) {
      for (let i = 0; i < listItems.length; i++) {
        const it = listItems[i]
        if (it.kind !== preferKind) continue
        const tsStart = 'tsStart' in it ? it.tsStart : getTs(it)
        const tsEnd = 'tsEnd' in it ? it.tsEnd : tsStart
        // ts 落在范围内直接命中
        if (targetTs >= tsStart && targetTs <= tsEnd) { bestIdx = i; break }
        // 否则按距离最近 pref item
        const d = Math.min(Math.abs(tsStart - targetTs), Math.abs(tsEnd - targetTs))
        if (d < bestDelta) { bestDelta = d; bestIdx = i }
      }
    }
    // 2) 兜底：找 ts 最近的任意 item
    if (bestIdx < 0) {
      bestDelta = Infinity
      for (let i = 0; i < listItems.length; i++) {
        const d = Math.abs(getTs(listItems[i]) - targetTs)
        if (d < bestDelta) { bestDelta = d; bestIdx = i }
      }
    }
    if (bestIdx >= 0) {
      try {
        listRef.current?.scrollToIndex({ index: bestIdx, animated: true, viewPosition: 0.1 })
      } catch {}
      onJumpDone(listItems[bestIdx].key)
    } else {
      onJumpDone(null)
    }
  }, [jumpTarget, listItems, onJumpDone])

  // 搜索：searchText 变化 → 找第一条文本命中的 item → 滚动 + 高亮闪烁（复用 onJumpDone）
  useEffect(() => {
    const q = (searchText || '').trim().toLowerCase()
    if (!q || listItems.length === 0) return
    const idx = listItems.findIndex((it) => itemSearchText(it).includes(q))
    if (idx >= 0) {
      try {
        listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.1 })
      } catch {}
      onJumpDone(listItems[idx].key)
    }
  }, [searchText, listItems, onJumpDone])

  if (listItems.length === 0) {
    return (
      <View style={styles.emptyInline}>
        <Text style={styles.emptyHint}>
          暂无{viewMode === 'feed' ? '视频卡片' : '快照'}{'\n\n'}
          打开 B 站刷一刷，这里会列出当时看到的内容
        </Text>
      </View>
    )
  }

  return (
    <FlatList
      ref={listRef}
      data={listItems}
      keyExtractor={(it) => it.key}
      renderItem={({ item }) => (
        <ListItemView
          item={item}
          sortOrder={sortOrder}
          onCrossJump={onCrossJump}
          highlighted={highlightKey === item.key}
          appIconCache={appIconCache}
        />
      )}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />
      }
      initialNumToRender={8}
      maxToRenderPerBatch={6}
      windowSize={11}
      removeClippedSubviews
      onScrollToIndexFailed={(info) => {
        // 列表还没渲染到目标位置，等一帧再尝试
        setTimeout(() => {
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })
        }, 100)
      }}
    />
  )
}

function StorySnapView({ item: s, highlighted, appIconCache }: { item: Extract<ListItem, { kind: 'story' }>; highlighted: boolean; appIconCache: Record<string, string> }) {
  const it = s.story
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  return (
    <View style={[styles.snapCard, highlighted && styles.snapCardHighlight]}>
      <View style={[styles.snapCardHead, styles.snapCardHeadDetail]}>
        <View style={[styles.snapCardAccentBar, { backgroundColor: '#00AEEC' }]} />
        <View style={styles.snapCardHeadText}>
          <View style={styles.snapCardTitleRow}>
            <BiliCardIcon appIconCache={appIconCache} color="#00AEEC" />
            <Text style={styles.snapCardTitle}>视频播放界面（竖屏）</Text>
          </View>
          <Text style={styles.snapCardSubtitle}>{tsLabel}{it.seenCount > 1 ? ` · 看 ${it.seenCount} 次` : ''}</Text>
        </View>
      </View>
      <View style={styles.snapCardBody}>
        <View style={styles.detailMainBlock}>
          <View style={styles.storyTitleRow}>
            {it.isAd && <Text style={styles.storyAdTag}>广告</Text>}
            <Text style={styles.detailTitle}>{it.title}</Text>
          </View>
          <View style={styles.detailUpRow}>
            <Text style={styles.detailUp}>@{it.upName}</Text>
            <Text style={styles.detailUpMeta}>{it.upFans} 粉丝</Text>
            {it.views && <Text style={styles.detailUpMeta}>{it.views}</Text>}
          </View>
          {it.tag && <Text style={styles.storyTag} numberOfLines={1}>{it.tag}</Text>}
          {(it.likes || it.comments || it.coins || it.favorites || it.shares) && (
            <View style={styles.detailStatsRow}>
              {it.likes && <Text style={styles.detailStat}>👍 {it.likes}</Text>}
              {it.comments && <Text style={styles.detailStat}>💬 {it.comments}</Text>}
              {it.coins && <Text style={styles.detailStat}>🪙 {it.coins}</Text>}
              {it.favorites && <Text style={styles.detailStat}>⭐ {it.favorites}</Text>}
              {it.shares && <Text style={styles.detailStat}>↗ {it.shares}</Text>}
            </View>
          )}
        </View>
      </View>
    </View>
  )
}

function ListItemView({ item, sortOrder, onCrossJump, highlighted, appIconCache }: { item: ListItem; sortOrder: SortOrder; onCrossJump: CrossJump; highlighted: boolean; appIconCache: Record<string, string> }) {
  // 视频组子卡：fullscreen / comments 且 _groupIdx > 0 = 子层级
  const groupIdx = (item as any)._groupIdx ?? 0
  const isChild = groupIdx > 0 && (item.kind === 'fullscreen' || item.kind === 'comments')

  let inner: React.ReactNode
  if (item.kind === 'home') {
    inner = <HomeSnapView item={item} sortOrder={sortOrder} onCrossJump={onCrossJump} highlighted={highlighted} appIconCache={appIconCache} />
  } else if (item.kind === 'detail') {
    inner = <DetailSnapView item={item} onCrossJump={onCrossJump} highlighted={highlighted} appIconCache={appIconCache} />
  } else if (item.kind === 'story') {
    inner = <StorySnapView item={item} highlighted={highlighted} appIconCache={appIconCache} />
  } else if (item.kind === 'comments') {
    inner = <CommentsSnapView item={item} sortOrder={sortOrder} onCrossJump={onCrossJump} highlighted={highlighted} appIconCache={appIconCache} />
  } else if (item.kind === 'fullscreen') {
    inner = <FullscreenSnapView item={item} onCrossJump={onCrossJump} highlighted={highlighted} appIconCache={appIconCache} />
  } else if (item.kind === 'actionLine') {
    inner = <ActionLineView item={item} onCrossJump={onCrossJump} highlighted={highlighted} appIconCache={appIconCache} />
  } else if (item.kind === 'rawSnapshot') {
    inner = <RawSnapshotView item={item} sortOrder={sortOrder} />
  } else {
    return null
  }

  if (isChild) {
    // 缩进 + 左侧蓝色连接线（视觉上表明子卡归属父 detail）
    return (
      <View style={styles.childRow}>
        <View style={styles.childConnector} />
        <View style={{ flex: 1 }}>{inner}</View>
      </View>
    )
  }
  return inner
}

function HomeSnapView({ item: s, sortOrder, onCrossJump, highlighted, appIconCache }: { item: Extract<ListItem, { kind: 'home' }>; sortOrder: SortOrder; onCrossJump: CrossJump; highlighted: boolean; appIconCache: Record<string, string> }) {
  // 卡头点击 → 跳到对应动作
  const onHeadPress = () => onCrossJump('action', s.tsStart)
  // feedItems 默认按 firstSeenTs ASC（视觉自顶向下）；desc 时反转
  const orderedItems = sortOrder === 'desc' ? [...s.feedItems].reverse() : s.feedItems
  // 拆行：横幅独占；视频/竖版视频 2 列瀑布流
  type Row = { kind: 'banner'; item: HomeFeedItem } | { kind: 'pair'; items: HomeFeedItem[] }
  const rows: Row[] = []
  let pairBuf: HomeFeedItem[] = []
  const flushPair = () => {
    if (pairBuf.length > 0) { rows.push({ kind: 'pair', items: pairBuf }); pairBuf = [] }
  }
  for (const it of orderedItems) {
    if (it.kind === '横幅视频' || it.kind === '大卡视频') { flushPair(); rows.push({ kind: 'banner', item: it }) }
    else { pairBuf.push(it); if (pairBuf.length === 2) flushPair() }
  }
  flushPair()
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  const dur = Math.round((s.tsEnd - s.tsStart) / 1000)
  return (
    <View style={[styles.snapCard, highlighted && styles.snapCardHighlight]}>
      <Pressable onPress={onHeadPress}>
      <View style={styles.snapCardHead}>
        <View style={styles.snapCardAccentBar} />
        <View style={styles.snapCardHeadText}>
          <View style={styles.snapCardTitleRow}>
            <BiliCardIcon appIconCache={appIconCache} color={HOME_ACCENT} />
            <Text style={styles.snapCardTitle}>B 站主页</Text>
            <Text style={styles.jumpHint}>→ 动作</Text>
          </View>
          <Text style={styles.snapCardSubtitle}>
            {tsLabel}{dur > 0 ? ` · 停留 ${dur}s` : ''} · 看到 {s.feedItems.length} 条视频
            {s.sweepCount > 1 ? ` · 刷 ${s.sweepCount} 次` : ''}
          </Text>
        </View>
      </View>
      </Pressable>
      <View style={styles.snapCardBody}>
        {rows.map((r, ri) => {
          if (r.kind === 'banner') {
            const f = r.item
            return (
              <View key={`b${ri}-${f.rowId}`} style={styles.gridBanner}>
                <View style={styles.feedKindRow}>
                  <Text style={styles.feedKindTag}>{feedKindLabel(f.kind)}</Text>
                  {f.seenCount > 1 && <Text style={styles.feedSeenCount}>×{f.seenCount}</Text>}
                </View>
                <Text style={styles.feedTitle}>{f.title}</Text>
                <View style={styles.feedMeta}>
                  {f.duration && <Text style={styles.feedMetaText}>{f.duration}</Text>}
                  {f.views && <Text style={styles.feedDot}>·</Text>}
                  {f.views && <Text style={styles.feedMetaText}>{f.views} 播放</Text>}
                </View>
              </View>
            )
          }
          return (
            <View key={`p${ri}`} style={styles.gridRow}>
              {r.items.map((f) => (
                <View key={f.rowId} style={styles.gridCell}>
                  <View style={styles.feedKindRow}>
                    <Text style={styles.feedKindTag}>{feedKindLabel(f.kind)}</Text>
                    {f.seenCount > 1 && <Text style={styles.feedSeenCount}>×{f.seenCount}</Text>}
                  </View>
                  <Text style={styles.feedTitleCompact} numberOfLines={2}>{f.title}</Text>
                  <View style={styles.feedUpRowCompact}>
                    {f.followed && <Text style={styles.followedCheck}>✓ 已关注</Text>}
                    {f.upName && <Text style={styles.feedUpName} numberOfLines={1}>{f.upName}</Text>}
                  </View>
                  <View style={styles.feedMetaCompact}>
                    {f.duration && <Text style={styles.feedMetaTextSm}>{f.duration}</Text>}
                    {f.views && <Text style={styles.feedMetaTextSm}>{f.views}播</Text>}
                    {f.danmaku && <Text style={styles.feedMetaTextSm}>{f.danmaku}弹</Text>}
                  </View>
                </View>
              ))}
              {r.items.length === 1 && <View style={styles.gridCell} />}
            </View>
          )
        })}
      </View>
    </View>
  )
}

function DetailSnapView({ item: s, onCrossJump, highlighted, appIconCache }: { item: Extract<ListItem, { kind: 'detail' }>; onCrossJump: CrossJump; highlighted: boolean; appIconCache: Record<string, string> }) {
  const onHeadPress = () => onCrossJump('action', s.tsStart)
  // 相关推荐目前按 a11y 抓取顺序，跟时间顺序无关 — 不跟 sortOrder 翻
  // 评论数用 d.related 自身；主视频信息没有时间维度
  const d = s.detail
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  return (
    <View style={[styles.snapCard, highlighted && styles.snapCardHighlight]}>
      <Pressable onPress={onHeadPress}>
      <View style={[styles.snapCardHead, styles.snapCardHeadDetail]}>
        <View style={[styles.snapCardAccentBar, { backgroundColor: '#00AEEC' }]} />
        <View style={styles.snapCardHeadText}>
          <View style={styles.snapCardTitleRow}>
            <BiliCardIcon appIconCache={appIconCache} color="#00AEEC" />
            <Text style={styles.snapCardTitle}>视频播放界面</Text>
            <Text style={styles.jumpHint}>→ 动作</Text>
          </View>
          <Text style={styles.snapCardSubtitle}>
            {tsLabel} · 在看
            {d.related.length > 0 ? ` · 相关推荐 ${d.related.length} 条` : ''}
          </Text>
        </View>
      </View>
      </Pressable>
      <View style={styles.snapCardBody}>
        {/* 主视频 */}
        <View style={styles.detailMainBlock}>
          {d.kindLabel && <Text style={styles.detailKindTag}>{d.kindLabel}</Text>}
          {d.title && <Text style={styles.detailTitle}>{d.title}</Text>}
          {/* UP 主 + 关注/充电 按钮态（同行模拟真实 B 站布局） */}
          {d.upName && (
            <View style={styles.detailUpRow}>
              <Text style={styles.detailUp}>@{d.upName}</Text>
              {d.upFans && <Text style={styles.detailUpMeta}>{d.upFans} 粉丝</Text>}
              {d.upVideoCount && <Text style={styles.detailUpMeta}>{d.upVideoCount} 视频</Text>}
              {d.hasChargeBtn && <Text style={styles.upActionCharge}>⚡ 充电</Text>}
              {d.followed && <Text style={styles.upActionFollowed}>✓ 已关注</Text>}
            </View>
          )}
          <View style={styles.detailMetaRow}>
            {d.views && <Text style={styles.detailMeta}>{d.views} 播放</Text>}
            {d.danmaku && <Text style={styles.detailMeta}>{d.danmaku} 弹幕</Text>}
            {d.watchingNow && <Text style={styles.detailMeta}>{d.watchingNow} 人正在看</Text>}
            {d.publishedAt && <Text style={styles.detailMeta}>{d.publishedAt}</Text>}
            {d.category && <Text style={styles.detailMeta}>{d.category}</Text>}
          </View>
          {/* 互动按钮栏（按钮永远显示，对应 B 站底部 4 按钮）*/}
          <View style={styles.detailStatsRow}>
            <Text style={styles.detailStat}>👍 {d.likes ?? '0'}</Text>
            <Text style={styles.detailStat}>🪙 {d.coins ?? '0'}</Text>
            <Text style={styles.detailStat}>⭐ {d.favorites ?? '0'}</Text>
            <Text style={styles.detailStat}>↗ {d.shares ?? '0'}</Text>
          </View>
          {/* 合集 */}
          {d.collectionName && (
            <View style={styles.collectionStrip}>
              <Text style={styles.collectionIcon}>≡</Text>
              <Text style={styles.collectionName} numberOfLines={1}>合集 · {d.collectionName}</Text>
              {d.collectionProgress && <Text style={styles.collectionProgress}>{d.collectionProgress}</Text>}
            </View>
          )}
          {/* 播放进度时间线（用户在这段时间播到哪里）*/}
          {/* 播放进度移到全屏播放子卡里展示（只有全屏才有 SeekBar 采样） */}
        </View>
        {/* 条形推送：紧凑单行 */}
        {d.promos.length > 0 && (
          <View style={styles.promoStripCompact}>
            {d.promos.map((p, i) => (
              <Text key={i} style={styles.promoLine} numberOfLines={1}>
                <Text style={styles.promoKindInline}>{p.kind}</Text>
                {'  '}{p.text}
              </Text>
            ))}
          </View>
        )}
        {/* 相关推荐列表 */}
        {d.related.length > 0 && (
          <View style={styles.relatedBlock}>
            <Text style={styles.relatedHead}>相关推荐</Text>
            {d.related.map((f) => (
              <View key={f.rowId} style={styles.relatedItem}>
                <View style={styles.feedKindRow}>
                  <Text style={[styles.feedKindTag, { backgroundColor: '#00AEEC' }]}>{feedKindLabel(f.kind)}</Text>
                </View>
                <Text style={styles.relatedTitle} numberOfLines={2}>{f.title}</Text>
                <View style={styles.feedMeta}>
                  {f.upName && <Text style={styles.feedUp}>@{f.upName}</Text>}
                  {f.duration && <Text style={styles.feedDot}>·</Text>}
                  {f.duration && <Text style={styles.feedMetaText}>{f.duration}</Text>}
                  {f.views && <Text style={styles.feedDot}>·</Text>}
                  {f.views && <Text style={styles.feedMetaText}>{f.views} 播放</Text>}
                  {f.danmaku && <Text style={styles.feedDot}>·</Text>}
                  {f.danmaku && <Text style={styles.feedMetaText}>{f.danmaku} 弹幕</Text>}
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  )
}

// 播放进度条：按 currSec 回退切段（一次完整播放 / 回看 → 多段）
function PlayProgressStrip({ samples }: { samples: PlayProgressSample[] }) {
  const segments = splitPlayProgressSegments(samples)
  const orderedSamples = segments.flat()
  const totalSec = orderedSamples[orderedSamples.length - 1]?.totalSec ?? samples[samples.length - 1].totalSec

  const fmt = (s: number) => `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`
  // 总观看时长（每段 last.cur - first.cur 之和）
  const totalWatchedSec = segments.reduce((n, seg) => n + Math.max(seg[seg.length - 1].currSec - seg[0].currSec, 0), 0)
  const first = orderedSamples[0] ?? samples[0]
  const last = orderedSamples[orderedSamples.length - 1] ?? samples[samples.length - 1]
  return (
    <View style={styles.progressWrap}>
      <View style={styles.progressHeader}>
        <Text style={styles.progressLabel}>
          播放进度{segments.length > 1 ? ` · ${segments.length} 段` : ''}
        </Text>
        <Text style={styles.progressMeta}>{fmt(totalSec)}</Text>
      </View>
      <View style={styles.progressBar}>
        {segments.map((seg, i) => {
          const segStart = seg[0].currSec
          const segEnd = seg[seg.length - 1].currSec
          return (
            <View
              key={i}
              style={[
                styles.progressFillSeen,
                {
                  left: `${(segStart / totalSec) * 100}%`,
                  width: `${(Math.max(segEnd - segStart, 0.5) / totalSec) * 100}%`,
                  opacity: 0.5 + 0.5 * (i + 1) / segments.length,
                },
              ]}
            />
          )
        })}
        {segments.map((seg, i) => (
          <View key={`m${i}-start`} style={[styles.progressMarker, { left: `${(seg[0].currSec / totalSec) * 100}%` }]} />
        ))}
      </View>
      {/* 段详情：仅 ≥ 2 段时展开 */}
      {segments.length > 1 ? (
        <View style={styles.progressSegList}>
          {segments.map((seg, i) => {
            const s0 = seg[0], sN = seg[seg.length - 1]
            return (
              <Text key={i} style={styles.progressSegLine}>
                <Text style={styles.progressSegIdx}>#{i + 1}</Text>
                {'  '}{fmtTime(s0.ts)}–{fmtTime(sN.ts)}
                {'  '}{fmt(s0.currSec)} → {fmt(sN.currSec)}
              </Text>
            )
          })}
          <Text style={styles.progressNote}>共看了 {totalWatchedSec}s</Text>
        </View>
      ) : (
        <Text style={styles.progressNote}>
          {fmtTime(first.ts)} 起播 → {fmtTime(last.ts)} · 实际看了 {totalWatchedSec}s
        </Text>
      )}
    </View>
  )
}

const COMMENTS_ACCENT = '#FBB04C'

function CommentsSnapView({ item: s, sortOrder, onCrossJump, highlighted, appIconCache }: { item: Extract<ListItem, { kind: 'comments' }>; sortOrder: SortOrder; onCrossJump: CrossJump; highlighted: boolean; appIconCache: Record<string, string> }) {
  const onHeadPress = () => onCrossJump('action', s.tsStart)
  // 评论区是对屏幕内容的还原，组内始终保留 a11y 的自顶向下视觉顺序。
  const comments: CommentItem[] = s.comments
  const commentDetails = s.commentDetails
  const hasCommentDetail = commentDetails.length > 0 || s.commentDetailSegs.length > 0
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  const CD_COLOR = SUB_TAB_LABEL.comment_detail.color
  return (
    <View style={[styles.subCard, highlighted && styles.snapCardHighlight, { borderColor: alpha(COMMENTS_ACCENT, 0.3) }]}>
      <Pressable onPress={onHeadPress} style={[styles.subCardHead, { backgroundColor: alpha(COMMENTS_ACCENT, 0.06) }]}>
        <View style={[styles.subCardDot, { backgroundColor: COMMENTS_ACCENT }]} />
        <BiliCardIcon appIconCache={appIconCache} color={COMMENTS_ACCENT} small />
        <Text style={[styles.subCardLabel, { color: COMMENTS_ACCENT }]}>评论区</Text>
        <Text style={styles.subCardMeta}>{tsLabel} · {comments.length} 条</Text>
        <Text style={styles.jumpHint}>→ 动作</Text>
      </Pressable>
      <View style={styles.subCardBody}>
        {comments.map((c, i) => (
          <View key={`${c.rowId}-${i}`} style={[styles.commentItem, i === comments.length - 1 && !hasCommentDetail && { borderBottomWidth: 0, marginBottom: 0, paddingBottom: 0 }]}>
            <View style={styles.commentHead}>
              {c.author && <Text style={styles.commentAuthor}>{c.author}</Text>}
              {c.badges.map((b, bi) => (
                <Text key={bi} style={styles.commentBadge}>{b}</Text>
              ))}
              <Text style={styles.commentTime}>{c.timeLocation}</Text>
            </View>
            <Text style={styles.commentBody}>{c.body}</Text>
            {c.likes && (
              <View style={styles.commentFoot}>
                <Text style={styles.commentFootText}>👍 {c.likes}</Text>
              </View>
            )}
            {c.replyCount && (
              <View style={styles.commentReplyEntry}>
                <Text style={styles.commentReplyText}>共{c.replyCount}条回复</Text>
                <Text style={styles.commentReplyArrow}>{'>'}</Text>
              </View>
            )}
          </View>
        ))}
        {/* 评论详情：复现 B 站打开后的独立详情面板，而不是折叠展开控件 */}
        {hasCommentDetail && (
          <View style={styles.cdInline}>
            <View style={styles.cdSheetHead}>
              <Text style={styles.cdSheetTitle}>评论详情</Text>
              <Text style={styles.cdClose}>×</Text>
            </View>
            <View style={styles.cdBody}>
              {commentDetails.length > 0 ? commentDetails.map((detail, i) => {
                const dur = Math.round((detail.endTs - detail.startTs) / 1000)
                const replyTotal = detail.replyTotal ?? (detail.replies.length > 0 ? String(detail.replies.length) : null)
                return (
                  <View key={`${detail.root?.rowId ?? 'reply'}-${i}`} style={[styles.cdThread, { borderTopColor: alpha(CD_COLOR, 0.24) }]}>
                    <Text style={styles.cdSegTime}>
                      {fmtTime(detail.startTs)} → {fmtTime(detail.endTs)}{dur >= 1 ? ` · 停留 ${dur}s` : ''}
                    </Text>
                    {detail.root && (
                      <View style={styles.cdRoot}>
                        <View style={styles.commentHead}>
                          {detail.root.author && <Text style={styles.commentAuthor}>{detail.root.author}</Text>}
                          {detail.root.badges.map((b, bi) => <Text key={bi} style={styles.commentBadge}>{b}</Text>)}
                          <Text style={styles.commentTime}>{detail.root.timeLocation}</Text>
                        </View>
                        <Text style={styles.commentBody}>{detail.root.body}</Text>
                        {detail.root.likes && (
                          <View style={styles.commentFoot}>
                            <Text style={styles.commentFootText}>👍 {detail.root.likes}</Text>
                          </View>
                        )}
                      </View>
                    )}
                    {detail.replies.length > 0 && (
                      <View style={styles.cdReplies}>
                        <View style={styles.cdReplyHeader}>
                          <Text style={styles.cdReplyHeaderText}>相关回复{replyTotal ? `共${replyTotal}条` : ''}</Text>
                          <Text style={styles.cdReplySort}>按时间</Text>
                        </View>
                        {detail.replies.slice(0, 5).map((r, ri) => (
                          <View key={`${r.rowId}-${ri}`} style={[styles.cdReply, ri === Math.min(detail.replies.length, 5) - 1 && { borderBottomWidth: 0, paddingBottom: 0 }]}>
                            <View style={styles.commentHead}>
                              {r.author && <Text style={styles.cdReplyAuthor}>{r.author}</Text>}
                              {r.badges.map((b, bi) => <Text key={bi} style={styles.commentBadge}>{b}</Text>)}
                              <Text style={styles.commentTime}>{r.timeLocation}</Text>
                            </View>
                            <Text style={styles.cdReplyBody}>{r.body}</Text>
                            {r.likes && <Text style={styles.commentFootText}>👍 {r.likes}</Text>}
                          </View>
                        ))}
                        {detail.replies.length > 5 && (
                          <Text style={styles.cdMore}>还有 {detail.replies.length - 5} 条回复未展开</Text>
                        )}
                      </View>
                    )}
                  </View>
                )
              }) : s.commentDetailSegs.map((seg, i) => {
                const dur = Math.round((seg.endTs - seg.startTs) / 1000)
                return (
                  <View key={i} style={[styles.cdSeg, { borderTopColor: alpha(CD_COLOR, 0.24) }]}>
                    <Text style={styles.cdSegTime}>
                      {fmtTime(seg.startTs)} → {fmtTime(seg.endTs)}{dur >= 1 ? ` · 停留 ${dur}s` : ''}
                    </Text>
                    <Text style={styles.cdSegPlaceholder}>
                      进入评论详情页（本次采样未抓到正文）
                    </Text>
                  </View>
                )
              })}
              </View>
          </View>
        )}
      </View>
    </View>
  )
}

function getActionJumpKind(a: Extract<ListItem, { kind: 'actionLine' }>): JumpKind | null {
  if (a.act === 'home') return 'home'
  if (a.act === 'video_intro') return a.isStory ? 'story' : 'detail'
  if (a.act === 'fullscreen') return 'fullscreen'
  if (a.act === 'comments' || a.act === 'comment_detail') return 'comments'
  return null
}

function ActionAppIcon({
  color,
  label,
  iconB64,
  size = 28,
  inline = false,
}: {
  color: string
  label: string
  iconB64?: string
  size?: number
  inline?: boolean
}) {
  const initial = (label || '应').slice(0, 1).toUpperCase()
  const radius = Math.max(6, Math.round(size * 0.28))
  const badgeSize = Math.max(7, Math.round(size * 0.32))
  return (
    <View style={[styles.actionAppIcon, inline && styles.actionAppIconInline, { width: size, height: size, borderRadius: radius }]}>
      {iconB64 ? (
        <Image
          style={[styles.actionAppIconImage, { width: size, height: size, borderRadius: radius }]}
          source={{ uri: `data:image/png;base64,${iconB64}` }}
        />
      ) : (
        <Text style={styles.actionAppIconText}>{initial}</Text>
      )}
      <View style={[styles.actionAppBadge, { backgroundColor: color, width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2 }]} />
    </View>
  )
}

function BiliCardIcon({ appIconCache, color, small }: { appIconCache: Record<string, string>; color: string; small?: boolean }) {
  return (
    <ActionAppIcon
      color={color}
      label={getPackageLabel(BILI_PACKAGE)}
      iconB64={appIconCache[BILI_PACKAGE]}
      size={small ? 18 : 22}
      inline
    />
  )
}

// 全屏播放子卡 — video_intro 的 fullscreen 段独立成卡
function FullscreenSnapView({ item: s, onCrossJump, highlighted, appIconCache }: { item: Extract<ListItem, { kind: 'fullscreen' }>; onCrossJump: CrossJump; highlighted: boolean; appIconCache: Record<string, string> }) {
  const onHeadPress = () => onCrossJump('action', s.tsStart)
  const tsLabel = s.tsStart === s.tsEnd ? fmtTime(s.tsEnd) : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  const FS_COLOR = SUB_TAB_LABEL.fullscreen.color
  return (
    <View style={[styles.subCard, highlighted && styles.snapCardHighlight, { borderColor: alpha(FS_COLOR, 0.3) }]}>
      <Pressable onPress={onHeadPress} style={[styles.subCardHead, { backgroundColor: alpha(FS_COLOR, 0.06) }]}>
        <View style={[styles.subCardDot, { backgroundColor: FS_COLOR }]} />
        <BiliCardIcon appIconCache={appIconCache} color={FS_COLOR} small />
        <Text style={[styles.subCardLabel, { color: FS_COLOR }]}>全屏播放</Text>
        <Text style={styles.subCardMeta}>{tsLabel}</Text>
        <Text style={styles.jumpHint}>→ 动作</Text>
      </Pressable>
      <View style={styles.subCardBody}>
        {s.samples.length > 0
          ? <PlayProgressStrip samples={s.samples} />
          : (
            <Text style={styles.placeholderHint}>
              该全屏段无播放进度采样（可能用户未触发 SeekBar 显示）
            </Text>
          )}
      </View>
    </View>
  )
}

// 评论详情子卡 — video_intro 的 comment_detail 段独立成卡
function ActionLineView({ item: a, onCrossJump, highlighted, appIconCache }: { item: Extract<ListItem, { kind: 'actionLine' }>; onCrossJump: CrossJump; highlighted: boolean; appIconCache: Record<string, string> }) {
  const cfg = ACTION_CFG[a.act]
  const appLabel = a.appLabel ?? getPackageLabel(a.packageName)
  const iconB64 = a.packageName ? appIconCache[a.packageName] : undefined
  const lasted = a.endTs ? Math.round((a.endTs - a.ts) / 1000) : 0
  const timeRange = lasted >= 1
    ? `${fmtTime(a.ts)} → ${fmtTime(a.endTs!)}`
    : fmtTime(a.ts)
  const jumpKind = getActionJumpKind(a)
  const canJump = jumpKind != null
  return (
    <Pressable
      onPress={jumpKind ? () => onCrossJump('feed', a.ts, jumpKind) : undefined}
      disabled={!canJump}
      style={[styles.actionRow, highlighted && styles.actionRowHighlight]}
    >
      <ActionAppIcon color={cfg.color} label={appLabel} iconB64={iconB64} />
      <View style={styles.actionBody}>
        <View style={styles.actionHead}>
          <Text style={[styles.actionKind, { color: cfg.color }]}>{a.act === 'video_intro' ? `进入视频播放界面${a.isStory ? '（竖屏）' : ''}` : cfg.label}</Text>
          {canJump && <Text style={styles.jumpHint}>→ 卡片</Text>}
          {lasted >= 1 && <Text style={styles.actionLasted}>停留 {lasted}s</Text>}
        </View>
        <Text style={styles.actionTime}>{timeRange}</Text>
        {(a.title || a.upName || a.meta) && (
          <Text style={styles.actionDetail} numberOfLines={2}>
            {a.title ? `《${a.title}》` : ''}
            {a.upName ? ` @${a.upName}` : ''}
            {a.meta ? `  ${a.meta}` : ''}
          </Text>
        )}
        {/* video_intro 子段：原 chip 横排序列（简介→全屏→评论→...）
            - intro：普通 chip（无跳转）
            - fullscreen/comments/comment_detail：特殊 chip（带 ↗ 跳转标 + 可点 → 对应卡片）
            - 全屏 chip 额外行显示播放进度紧凑摘要 */}
        {a.act === 'video_intro' && a.tabSeq && a.tabSeq.length > 0 && (
          <View style={styles.subTabRow}>
            {a.tabSeq.map((seg, i) => {
              const sub = SUB_TAB_LABEL[seg.tab]
              const w = seg.tab === 'fullscreen' ? seg.watch : null
              const chipDur = seg.displayDurationSec ?? Math.round((seg.endTs - seg.startTs) / 1000)
              const hasCard = seg.tab !== 'intro'
              const segJumpKind: JumpKind = seg.tab === 'fullscreen' ? 'fullscreen' : 'comments'
              const onSegPress = hasCard ? (e: any) => {
                e?.stopPropagation?.()
                onCrossJump('feed', seg.startTs, segJumpKind)
              } : undefined
              return (
                <View key={i} style={styles.subTabSegRow}>
                  {i > 0 && <Text style={styles.subTabArrow}>→</Text>}
                  <Pressable
                    onPress={onSegPress}
                    disabled={!hasCard}
                    style={[styles.subTabChip, { backgroundColor: alpha(sub.color, 0.12), borderColor: alpha(sub.color, 0.35) }]}
                  >
                    <Text style={[styles.subTabChipText, { color: sub.color }]}>{sub.label}</Text>
                    {chipDur >= 1 && <Text style={[styles.subTabChipDur, { color: sub.color }]}>{chipDur}s</Text>}
                    {hasCard && <Text style={[styles.subTabChipJump, { color: sub.color }]}>↗</Text>}
                    {w && (
                      <Text style={[styles.subTabChipWatch, { color: sub.color }]}>
                        {fmtVidSec(w.videoFromSec)}→{fmtVidSec(w.videoToSec)}/{fmtVidSec(w.videoTotalSec)} · 看 {w.watchedSec}s
                      </Text>
                    )}
                  </Pressable>
                </View>
              )
            })}
          </View>
        )}
      </View>
    </Pressable>
  )
}

const SUB_TAB_LABEL: Record<VideoSubTab, { label: string; color: string }> = {
  intro:          { label: '简介',     color: '#00AEEC' },
  comments:       { label: '评论',     color: '#FBB04C' },
  comment_detail: { label: '评论详情', color: '#F59E0B' },
  fullscreen:     { label: '全屏播放', color: '#6366F1' },
}

const ACTION_CFG: Record<BiliActionKind, { label: string; color: string }> = {
  splash:         { label: '开屏广告',     color: '#9CA3AF' },
  home:           { label: '进入主页',     color: '#FB7299' },
  video_intro:    { label: '进入视频播放界面', color: '#00AEEC' },
  fullscreen:     { label: '进入全屏播放', color: '#6366F1' },
  comments:       { label: '进入评论',     color: '#FBB04C' },
  comment_detail: { label: '进入评论详情', color: '#F59E0B' },
}

function RawSnapshotView({ item: g, sortOrder }: { item: Extract<ListItem, { kind: 'rawSnapshot' }>; sortOrder: SortOrder }) {
  const winShort = g.windowClass ? g.windowClass.split('.').pop() : ''
  // raw 文本按 rowId 顺序（自顶向下）；desc 反转
  const texts = sortOrder === 'desc' ? [...g.texts].reverse() : g.texts
  return (
    <View style={styles.snapshot}>
      <View style={styles.snapshotHead}>
        <Text style={styles.snapshotTime}>{fmtTime(g.ts)}</Text>
        <Text style={styles.snapshotMeta} numberOfLines={1}>
          {getPackageLabel(g.packageName)}
          {winShort ? ` · ${winShort}` : ''}
          {' · '}{texts.length} 条
        </Text>
      </View>
      <View style={styles.snapshotBody}>
        {texts.map((t) => (
          <Text key={t.rowId} style={styles.snapshotText} numberOfLines={3}>
            {t.text}
          </Text>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line,
    backgroundColor: theme.surface,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 18, fontWeight: '700', color: theme.ink },
  subtitle: { fontSize: 12, color: theme.inkSoft, marginTop: 4 },
  helpBtn: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 1, borderColor: theme.line,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.surface,
  },
  helpBtnText: { fontSize: 14, color: theme.inkSoft, fontWeight: '700' },
  helpBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
    padding: 24,
  },
  helpCard: {
    backgroundColor: theme.surface, borderRadius: 12, padding: 20,
    width: '100%', maxWidth: 420,
  },
  helpTitle: { fontSize: 16, fontWeight: '700', color: theme.ink, marginBottom: 12 },
  helpSection: { fontSize: 13, fontWeight: '700', color: theme.accent, marginTop: 10, marginBottom: 4 },
  helpText: { fontSize: 12, color: theme.ink, lineHeight: 20 },
  helpClose: {
    marginTop: 16, alignSelf: 'flex-end',
    paddingHorizontal: 14, paddingVertical: 6,
    backgroundColor: theme.accent, borderRadius: 6,
  },
  helpCloseText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  promptActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 2 },
  promptGhost: {
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.line,
  },
  promptGhostText: { color: theme.inkSoft },
  snapCardHighlight: {
    borderWidth: 2, borderColor: theme.accent,
    shadowColor: theme.accent, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  actionRowHighlight: {
    backgroundColor: alpha(theme.accent, 0.12),
    borderLeftWidth: 3, borderLeftColor: theme.accent,
  },
  snapCardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  jumpHint: {
    fontSize: 9,
    color: theme.accent,
    fontWeight: '700',
    backgroundColor: alpha(theme.accent, 0.12),
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  openA11yBtn: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: theme.accent,
    alignSelf: 'flex-start',
  },
  openA11yText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, paddingHorizontal: 18 },
  modeChip: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.line,
    backgroundColor: theme.bg,
  },
  modeChipOn: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  modeChipText: { fontSize: 12, color: theme.inkSoft, fontWeight: '500' },
  modeChipTextOn: { color: '#FFF', fontWeight: '600' },
  contentArea: { flex: 1, position: 'relative' },
  sortFloat: {
    position: 'absolute',
    top: 8,
    right: 14,
    zIndex: 20,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: alpha(theme.ink, 0.12),
    backgroundColor: alpha(theme.surface, 0.92),
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  sortFloatText: { fontSize: 11, color: theme.inkSoft, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyInline: { paddingTop: 60, alignItems: 'center', paddingHorizontal: 24 },
  emptyHint: { fontSize: 13, color: theme.inkSoft, textAlign: 'center', lineHeight: 22 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 20 },
  monitorList: { flex: 1 },
  monitorContent: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 24 },
  monitorSummary: {
    backgroundColor: theme.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.line,
  },
  monitorTitle: { fontSize: 15, fontWeight: '700', color: theme.ink },
  monitorMeta: { fontSize: 11, color: theme.inkSoft, marginTop: 4 },
  monitorRunRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.surface,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.lineSoft,
  },
  monitorSwitchRow: {
    backgroundColor: alpha(theme.accent, 0.05),
    borderColor: alpha(theme.accent, 0.22),
  },
  monitorPowerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 6,
  },
  monitorTime: {
    width: 40,
    fontSize: 11,
    lineHeight: 15,
    color: theme.inkSoft,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  monitorIcon: { width: 30, height: 30, borderRadius: 7 },
  monitorIconFallback: {
    width: 30,
    height: 30,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: alpha(theme.accent, 0.12),
  },
  monitorIconText: { fontSize: 13, fontWeight: '700', color: theme.accent },
  monitorSwitchIcons: { width: 48, minHeight: 30, flexDirection: 'row', flexWrap: 'wrap', gap: 3, alignItems: 'center' },
  monitorSwitchIconsExpanded: { width: 72 },
  monitorSwitchIcon: { width: 21, height: 21, borderRadius: 5 },
  monitorSwitchIconFallback: {
    width: 21,
    height: 21,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: alpha(theme.accent, 0.14),
  },
  monitorSwitchIconText: { fontSize: 10, fontWeight: '700', color: theme.accent },
  monitorSwitchMore: {
    width: 21,
    height: 21,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: alpha(theme.ink, 0.08),
  },
  monitorSwitchMoreText: { fontSize: 9, fontWeight: '700', color: theme.inkSoft },
  monitorBody: { flex: 1, minWidth: 0 },
  monitorAppHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  monitorApp: { flex: 1, fontSize: 13, fontWeight: '700', color: theme.ink },
  monitorDuration: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  monitorWindowTitle: { fontSize: 12, color: theme.inkSoft, marginTop: 2 },
  monitorPkg: { fontSize: 10, color: theme.inkFaint, marginTop: 2 },
  monitorPowerDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.accent },
  monitorPowerDotDim: { backgroundColor: theme.inkFaint },
  monitorPowerText: { fontSize: 12, color: theme.ink, fontWeight: '600' },
  // 主页快照大卡
  // 子卡片层级容器：缩进 + 左侧粗色连接线（视觉归属父 detail）
  childRow: {
    flexDirection: 'row',
    paddingLeft: 10,
    marginTop: -6,
    marginBottom: 0,
  },
  childConnector: {
    width: 2,
    backgroundColor: alpha('#00AEEC', 0.35),
    marginRight: 8,
    marginTop: -8,  // 顶往上贴父卡
    marginBottom: 14,
  },
  // 子卡片本体：比父卡更轻量（无 head 大字 + 紧凑 chip 头）
  subCard: {
    backgroundColor: theme.surface,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  subCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  subCardDot: { width: 6, height: 6, borderRadius: 3 },
  subCardLabel: { fontSize: 12, fontWeight: '700' },
  subCardMeta: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'], marginLeft: 'auto', marginRight: 6 },
  subCardBody: { padding: 12 },
  snapCard: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    marginBottom: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.line,
    overflow: 'hidden',
  },
  snapCardHead: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: alpha(HOME_ACCENT, 0.06),
    borderBottomWidth: 1,
    borderBottomColor: alpha(HOME_ACCENT, 0.15),
  },
  snapCardAccentBar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: HOME_ACCENT,
    marginRight: 10,
  },
  snapCardHeadText: { flex: 1, justifyContent: 'center', gap: 3 },
  snapCardTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: theme.ink,
    letterSpacing: 0.3,
  },
  snapCardSubtitle: {
    fontSize: 12,
    color: theme.inkSoft,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  snapCardBody: { padding: 12 },
  subGroupBlock: {},
  subGroupBlockGap: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line,
  },
  subGroupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  subGroupDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: HOME_ACCENT,
  },
  subGroupTime: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.ink,
    fontVariant: ['tabular-nums'],
  },
  subGroupCount: { fontSize: 11, color: theme.inkFaint },
  snapFeedItem: {
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  snapFeedItemLast: {
    paddingBottom: 0,
    marginBottom: 0,
    borderBottomWidth: 0,
  },
  // 视频详情大卡
  snapCardHeadDetail: {
    backgroundColor: alpha('#00AEEC', 0.06),
    borderBottomColor: alpha('#00AEEC', 0.15),
  },
  detailMainBlock: {},
  detailKindTag: {
    alignSelf: 'flex-start',
    fontSize: 10,
    color: '#FFF',
    backgroundColor: '#00AEEC',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontWeight: '600',
    overflow: 'hidden',
    marginBottom: 6,
  },
  detailTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.ink,
    lineHeight: 22,
    marginBottom: 8,
  },
  detailUpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  detailUp: {
    fontSize: 13,
    color: theme.accent,
    fontWeight: '600',
  },
  detailUpMeta: {
    fontSize: 11,
    color: theme.inkSoft,
  },
  detailMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 8,
  },
  detailMeta: {
    fontSize: 11,
    color: theme.inkSoft,
    fontVariant: ['tabular-nums'],
  },
  detailStatsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
  },
  detailStat: {
    fontSize: 12,
    color: theme.ink,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  // 主视频下方条形推送
  promoStrip: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
    gap: 6,
  },
  promoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.bg,
    borderRadius: 6,
    padding: 8,
  },
  promoKind: {
    fontSize: 10,
    color: theme.inkSoft,
    backgroundColor: theme.line,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    fontWeight: '600',
    overflow: 'hidden',
  },
  promoText: { flex: 1, fontSize: 12, color: theme.ink, lineHeight: 17 },
  // 紧凑 promo（单行）
  promoStripCompact: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
    gap: 3,
  },
  promoLine: { fontSize: 11, color: theme.inkSoft, lineHeight: 16 },
  promoKindInline: {
    fontSize: 10, color: theme.inkFaint,
    fontWeight: '700',
  },
  // UP 主互动按钮（同行内联）
  upActionCharge: {
    fontSize: 10, fontWeight: '700',
    color: '#FF6699', backgroundColor: alpha('#FF6699', 0.1),
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8,
    overflow: 'hidden',
  },
  upActionFollowed: {
    fontSize: 10, fontWeight: '700',
    color: '#F69900', backgroundColor: alpha('#F69900', 0.1),
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8,
    overflow: 'hidden',
  },
  // 合集条
  collectionStrip: {
    marginTop: 10,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: alpha('#00AEEC', 0.08),
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 6,
  },
  collectionIcon: { fontSize: 14, color: '#00AEEC', fontWeight: '700' },
  collectionName: { flex: 1, fontSize: 12, color: '#0090C7', fontWeight: '600' },
  collectionProgress: { fontSize: 11, color: '#00AEEC', fontVariant: ['tabular-nums'], fontWeight: '700' },
  // 播放进度条
  progressWrap: {
    marginTop: 10, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
  },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressLabel: { fontSize: 11, color: theme.inkSoft, fontWeight: '600' },
  progressMeta: { fontSize: 11, color: theme.ink, fontVariant: ['tabular-nums'], fontWeight: '600' },
  progressBar: {
    height: 6, backgroundColor: theme.line, borderRadius: 3,
    position: 'relative', overflow: 'visible',
  },
  progressFillSeen: {
    position: 'absolute', top: 0, bottom: 0,
    backgroundColor: '#00AEEC', borderRadius: 3,
  },
  progressMarker: {
    position: 'absolute', top: -2, bottom: -2,
    width: 2, marginLeft: -1, backgroundColor: '#0090C7',
    borderRadius: 1,
  },
  progressNote: {
    marginTop: 8, fontSize: 13, color: theme.ink, fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  progressSegList: { marginTop: 6, gap: 2 },
  progressSegLine: { fontSize: 10, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  progressSegIdx: { color: '#00AEEC', fontWeight: '700' },
  // 相关推荐列表
  relatedBlock: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
  },
  relatedHead: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.ink,
    marginBottom: 8,
  },
  relatedItem: {
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  relatedTitle: {
    fontSize: 13,
    color: theme.ink,
    fontWeight: '600',
    lineHeight: 18,
    marginBottom: 6,
  },
  // 评论项
  commentItem: {
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  commentHead: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  },
  commentAuthor: {
    fontSize: 12,
    color: COMMENTS_ACCENT,
    fontWeight: '700',
  },
  commentBadge: {
    fontSize: 9,
    color: theme.inkSoft,
    backgroundColor: theme.line,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    fontWeight: '500',
    overflow: 'hidden',
  },
  commentTime: {
    fontSize: 10,
    color: theme.inkFaint,
    marginLeft: 'auto',
  },
  commentBody: {
    fontSize: 13,
    color: theme.ink,
    lineHeight: 19,
    marginBottom: 4,
  },
  commentFoot: { flexDirection: 'row', gap: 12, marginTop: 2 },
  commentFootText: { fontSize: 11, color: theme.inkSoft },
  commentReplyEntry: {
    marginTop: 6,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 4,
    backgroundColor: alpha(COMMENTS_ACCENT, 0.08),
  },
  commentReplyText: { fontSize: 11, color: COMMENTS_ACCENT, fontWeight: '700' },
  commentReplyArrow: { fontSize: 11, color: COMMENTS_ACCENT, fontWeight: '800' },
  commentVideoContext: {
    fontSize: 11, color: COMMENTS_ACCENT, fontWeight: '600', marginTop: 2,
  },
  placeholderHint: { fontSize: 12, color: theme.inkSoft, fontStyle: 'italic', lineHeight: 18 },
  // 评论详情面板：复现 B 站评论详情页结构
  cdInline: {
    marginTop: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(COMMENTS_ACCENT, 0.22),
    borderRadius: 5,
    overflow: 'hidden',
    backgroundColor: alpha(COMMENTS_ACCENT, 0.035),
  },
  cdSheetHead: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  cdSheetTitle: { flex: 1, fontSize: 12, color: theme.ink, fontWeight: '800' },
  cdClose: { fontSize: 16, color: theme.inkFaint, fontWeight: '600' },
  cdBody: { gap: 0 },
  cdSeg: {
    paddingHorizontal: 10, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cdThread: {
    paddingHorizontal: 10, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cdSegTime: { fontSize: 11, color: theme.ink, fontVariant: ['tabular-nums'], fontWeight: '600' },
  cdSegPlaceholder: { fontSize: 11, color: theme.inkSoft, fontStyle: 'italic', marginTop: 2 },
  cdRoot: {
    marginTop: 7, paddingBottom: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: alpha(COMMENTS_ACCENT, 0.18),
  },
  cdReplies: { marginTop: 6, gap: 5 },
  cdReplyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  cdReplyHeaderText: { fontSize: 11, color: theme.inkSoft, fontWeight: '700' },
  cdReplySort: { fontSize: 10, color: theme.inkFaint },
  cdReply: {
    paddingBottom: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: alpha(COMMENTS_ACCENT, 0.12),
  },
  cdReplyAuthor: { fontSize: 12, color: theme.ink, fontWeight: '700' },
  cdReplyBody: { fontSize: 12, color: theme.ink, lineHeight: 18, marginTop: 1 },
  cdMore: { fontSize: 11, color: theme.inkSoft, marginTop: 1 },
  // 还原动作 — 时间线行
  actionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  actionAppIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    marginRight: 12,
  },
  actionAppIconInline: {
    marginTop: 0,
    marginRight: 0,
  },
  actionAppIconText: {
    color: theme.inkSoft,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
  actionAppIconImage: {
    width: 28,
    height: 28,
    borderRadius: 8,
  },
  actionAppBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: theme.surface,
  },
  actionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    marginRight: 12,
  },
  actionBody: { flex: 1 },
  actionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginBottom: 4 },
  actionTime: {
    fontSize: 11,
    color: theme.inkFaint,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
    marginBottom: 2,
  },
  actionKind: {
    fontSize: 14,
    fontWeight: '700',
  },
  actionLasted: {
    fontSize: 11,
    color: theme.inkSoft,
    fontVariant: ['tabular-nums'],
    marginLeft: 'auto',
  },
  actionDetail: {
    fontSize: 12,
    color: theme.ink,
    lineHeight: 16,
  },
  actionWatch: {
    marginTop: 6,
    paddingTop: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: alpha('#00AEEC', 0.08),
    borderLeftWidth: 3, borderLeftColor: '#00AEEC',
    borderRadius: 4,
  },
  actionWatchMain: {
    fontSize: 13, fontWeight: '700', color: theme.ink,
    fontVariant: ['tabular-nums'],
  },
  actionWatchSub: {
    fontSize: 11, color: theme.inkSoft, marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  subTabRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 6 },
  // 子段竖排：横向 chip + fullscreen 整段块混排
  subTabCol: { gap: 6, marginTop: 6 },
  subTabChipInner: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  // fullscreen 子段块（带播放进度）
  fsBlock: {
    paddingHorizontal: 10, paddingVertical: 8,
    borderLeftWidth: 3, borderRadius: 4,
  },
  fsHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  fsLabel: { fontSize: 12, fontWeight: '700' },
  fsDur: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'], marginLeft: 'auto' },
  jumpHintSm: { fontSize: 10, color: theme.accent, fontWeight: '700' },
  fsWatchMain: { fontSize: 11, fontWeight: '600', color: theme.ink, fontVariant: ['tabular-nums'] },
  fsWatchSub: { fontSize: 11, color: theme.inkSoft, marginTop: 2, fontVariant: ['tabular-nums'] },
  subTabSegRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  subTabArrow: { fontSize: 10, color: theme.inkFaint },
  subTabChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4, borderWidth: 1,
  },
  subTabChipText: { fontSize: 10, fontWeight: '700' },
  subTabChipDur: { fontSize: 10, fontVariant: ['tabular-nums'], fontWeight: '500' },
  subTabChipJump: { fontSize: 10, fontWeight: '700', opacity: 0.7 },
  subTabChipWatch: { fontSize: 10, fontVariant: ['tabular-nums'], fontWeight: '500', marginLeft: 4 },
  feedKindRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  feedKindTag: {
    fontSize: 10,
    color: '#FFF',
    backgroundColor: HOME_ACCENT,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontWeight: '600',
    overflow: 'hidden',
  },
  feedFollowedTag: {
    fontSize: 10,
    color: theme.accent,
    backgroundColor: '#E9EDFB',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontWeight: '600',
    overflow: 'hidden',
  },
  feedTitle: {
    fontSize: 14,
    color: theme.ink,
    fontWeight: '600',
    lineHeight: 20,
    marginBottom: 6,
  },
  feedMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
  feedUp: { fontSize: 11, color: theme.accent, fontWeight: '500' },
  feedDot: { fontSize: 11, color: theme.inkFaint },
  feedMetaText: { fontSize: 11, color: theme.inkSoft },
  feedSeenCount: { fontSize: 10, color: theme.inkFaint, marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  // Story 竖屏视频卡
  storyRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  storyTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  storyAdTag: {
    fontSize: 10, fontWeight: '700', color: '#F59E0B',
    backgroundColor: alpha('#F59E0B', 0.12),
    paddingHorizontal: 4, paddingVertical: 1,
    borderRadius: 3, overflow: 'hidden',
  },
  storyTitle: { flex: 1, fontSize: 13, color: theme.ink, fontWeight: '600', lineHeight: 18 },
  storyUp: { fontSize: 11, color: theme.inkSoft, marginBottom: 4 },
  storyTag: { fontSize: 11, color: '#8B5CF6', marginBottom: 4 },
  storyStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 2 },
  storyStat: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  // 2 列瀑布流网格
  gridRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  gridCell: {
    flex: 1,
    backgroundColor: theme.bg,
    borderRadius: 8,
    padding: 8,
  },
  gridBanner: {
    backgroundColor: theme.bg,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  feedTitleCompact: {
    fontSize: 12,
    color: theme.ink,
    fontWeight: '600',
    lineHeight: 17,
    marginBottom: 4,
  },
  feedUpCompact: {
    fontSize: 10,
    color: theme.accent,
    marginBottom: 4,
  },
  feedUpRowCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  followedCheck: {
    fontSize: 10,
    color: '#F69900',
    fontWeight: '700',
  },
  feedUpName: {
    fontSize: 10,
    color: theme.inkSoft,
    flexShrink: 1,
  },
  feedMetaCompact: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  feedMetaTextSm: {
    fontSize: 10,
    color: theme.inkSoft,
  },
  // 原始时间线
  snapshot: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.line,
  },
  snapshotHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 8,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  snapshotTime: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.ink,
    fontVariant: ['tabular-nums'],
  },
  snapshotMeta: {
    fontSize: 11,
    color: theme.inkFaint,
    flex: 1,
  },
  snapshotBody: { gap: 6 },
  snapshotText: {
    fontSize: 13,
    color: theme.ink,
    lineHeight: 19,
  },
})
