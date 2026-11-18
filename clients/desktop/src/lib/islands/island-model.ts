// ══════════════════════════════════════════════
// 昼夜表 · 浮岛与日程：规则的结构 + 当天落点的算法（纯函数，不碰网络和界面）
//   浮岛（after）= 挂在某个标签后面：取当天「结束时刻落在时段内的最后一段」作锚，隔 offset 分钟开始
//                  锚还没出现时，用近几天同一条规则的锚时刻平均值估一个位置
//   日程（fixed）= 钉在钟点上
//   lock = 这一条进行期间要锁住的应用 / 网站（哪台设备执行哪几项看 platform；执行在各端原生层）
//   后端只存 JSON（src-tauri/src/islands.rs），结构以这里为准
// ══════════════════════════════════════════════

import type { ActivityBlock, ActivityPalette, ActivityTag } from '../../types'

export const DAY_MINUTES = 1440
export const BLOCK_MINUTES = 5
/** 同一标签的两段之间空这么久以内，算同一段（中途断一下不算结束） */
export const ANCHOR_MERGE_GAP_MIN = 30
/** 估位置时往回看几天 */
export const ESTIMATE_LOOKBACK_DAYS = 7
/** 没有清单的浮岛，整块做完记这个 id */
export const WHOLE_ITEM_ID = '__whole'

const NAME_MAX_CHARS = 40
const ITEM_MAX_CHARS = 60
const MAX_ITEMS = 12
const MAX_OFFSET_MIN = 12 * 60
const MIN_DURATION_MIN = BLOCK_MINUTES
const DEFAULT_DURATION_MIN = 30
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export type IslandKind = 'after' | 'fixed'

/** 应用规则是哪台设备上的：Windows 写 exe 名，Mac 写应用名 / bundle id，安卓写包名 */
export type LockPlatform = 'windows' | 'mac' | 'android'
export const LOCK_PLATFORMS: readonly LockPlatform[] = ['windows', 'mac', 'android']

export interface IslandLockEntry {
  readonly rule: string
  /** 灰色地带：不直接拦，这段内容算不算跑偏交给判断模型 */
  readonly gray: boolean
}

export interface IslandLockApp extends IslandLockEntry {
  readonly platform: LockPlatform
}

/** 这一条进行期间锁住的东西（锁名单：只拦名单里的，别的照常用） */
export interface IslandLock {
  readonly apps: readonly IslandLockApp[]
  /** 网站各端通用（浏览器里只拦这些站，不拦浏览器本身） */
  readonly sites: readonly IslandLockEntry[]
  /** 判断标准：给判断模型看的一段话，灰色项算不算跑偏按它判（主人手写或 Fairy 写）；空 = 用名字 */
  readonly intent: string
  /** true = 里面的事全勾完才解开；false = 到这一条的结束时刻自动解开 */
  readonly untilDone: boolean
}

export interface IslandItem {
  readonly id: string
  readonly title: string
}

export interface IslandRule {
  readonly name: string
  readonly kind: IslandKind
  /** after：挂在哪个标签后面（它的子标签也算） */
  readonly anchorTagId: number | null
  /** after：只认结束时刻落在 [windowStart, windowEnd] 的那一段，用来区分同一标签一天里的几次 */
  readonly windowStart: number
  readonly windowEnd: number
  /** after：锚结束后隔多久开始 */
  readonly offsetMin: number
  /** after：最晚开始时刻；锚拖得再晚也不再往后漂。null = 不限 */
  readonly latestStart: number | null
  /** fixed：开始时刻 */
  readonly startMinute: number
  readonly durationMin: number
  readonly items: readonly IslandItem[]
  /** null = 跟锚标签所在分类的颜色 */
  readonly color: string | null
  readonly enabled: boolean
  /** null = 不锁 */
  readonly lock: IslandLock | null
}

export interface Island {
  readonly id: string
  readonly rule: IslandRule
  readonly sortOrder: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** anchored 锚已出现 / estimated 按近几天估的 / fixed 钉在钟点 / none 估不出来（没有历史，也没有锚） */
export type PlacementBasis = 'anchored' | 'estimated' | 'fixed' | 'none'
export type PlacementStatus = 'done' | 'active' | 'upcoming' | 'missed'

export interface IslandPlacement {
  readonly island: Island
  readonly basis: PlacementBasis
  /** basis = none 时为 null */
  readonly start: number | null
  readonly end: number | null
  /** 当天锚的结束时刻（after 且已出现才有） */
  readonly anchorEnd: number | null
  /** 估位置用了几天的数据 */
  readonly sampleDays: number
  /** 锚拖晚了，被 latestStart 卡住 */
  readonly late: boolean
  readonly doneItemIds: readonly string[]
  readonly status: PlacementStatus
}

// ── 规则校验 ──

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function snap(minute: number): number {
  return Math.round(minute / BLOCK_MINUTES) * BLOCK_MINUTES
}

export function newItemId(): string {
  return `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

function normalizeItems(raw: unknown): IslandItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: IslandItem[] = []
  for (const entry of raw) {
    const o = (typeof entry === 'object' && entry !== null ? entry : { title: entry }) as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, ITEM_MAX_CHARS) : ''
    if (!title) continue
    let id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : newItemId()
    while (seen.has(id) || id === WHOLE_ITEM_ID) id = newItemId()
    seen.add(id)
    out.push({ id, title })
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

const LOCK_RULE_MAX_CHARS = 300
const LOCK_MAX_ENTRIES = 100
const LOCK_INTENT_MAX_CHARS = 500

function normalizeLockEntries<T extends IslandLockEntry>(raw: unknown, build: (rule: string, gray: boolean, o: Record<string, unknown>) => T, keyOf: (entry: T) => string): T[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of raw) {
    const o = (typeof item === 'object' && item !== null ? item : { rule: item }) as Record<string, unknown>
    const rule = typeof o.rule === 'string' ? o.rule.trim().slice(0, LOCK_RULE_MAX_CHARS) : ''
    if (!rule) continue
    const entry = build(rule, o.gray === true, o)
    const key = keyOf(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
    if (out.length >= LOCK_MAX_ENTRIES) break
  }
  return out
}

/** 锁名单收成合法的；应用和网站都空 = 不锁（null） */
export function normalizeLock(raw: unknown): IslandLock | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const apps = normalizeLockEntries<IslandLockApp>(
    o.apps,
    (rule, gray, e) => ({ rule, gray, platform: LOCK_PLATFORMS.find((p) => p === e.platform) ?? 'windows' }),
    (e) => `${e.platform}|${e.rule.toLowerCase()}`,
  )
  const sites = normalizeLockEntries<IslandLockEntry>(o.sites, (rule, gray) => ({ rule, gray }), (e) => e.rule.toLowerCase())
  if (apps.length === 0 && sites.length === 0) return null
  return {
    apps,
    sites,
    intent: typeof o.intent === 'string' ? o.intent.trim().slice(0, LOCK_INTENT_MAX_CHARS) : '',
    untilDone: o.untilDone === true,
  }
}

/** 外来的文档（库里读的 / AI 给的 / 表单填的）收成一条合法规则；名字为空会抛错 */
export function normalizeRule(raw: unknown): IslandRule {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, NAME_MAX_CHARS) : ''
  if (!name) throw new Error('浮岛要有个名字')
  const kind: IslandKind = o.kind === 'fixed' ? 'fixed' : 'after'
  const anchorTagId = typeof o.anchorTagId === 'number' && Number.isInteger(o.anchorTagId) ? o.anchorTagId : null
  if (kind === 'after' && anchorTagId == null) throw new Error('浮岛要选一个挂靠的标签')
  const windowStart = snap(clampInt(o.windowStart, 0, DAY_MINUTES, 0))
  const rawWindowEnd = snap(clampInt(o.windowEnd, 0, DAY_MINUTES, DAY_MINUTES))
  const windowEnd = rawWindowEnd > windowStart ? rawWindowEnd : DAY_MINUTES
  const latest = o.latestStart == null || o.latestStart === '' ? null : snap(clampInt(o.latestStart, 0, DAY_MINUTES - BLOCK_MINUTES, 0))
  return {
    name,
    kind,
    anchorTagId: kind === 'after' ? anchorTagId : null,
    windowStart,
    windowEnd,
    offsetMin: snap(clampInt(o.offsetMin, 0, MAX_OFFSET_MIN, 0)),
    latestStart: kind === 'after' ? latest : null,
    startMinute: snap(clampInt(o.startMinute, 0, DAY_MINUTES - BLOCK_MINUTES, 0)),
    durationMin: Math.max(MIN_DURATION_MIN, snap(clampInt(o.durationMin, MIN_DURATION_MIN, DAY_MINUTES, DEFAULT_DURATION_MIN))),
    items: normalizeItems(o.items),
    color: typeof o.color === 'string' && HEX_COLOR.test(o.color) ? o.color : null,
    enabled: o.enabled !== false,
    lock: normalizeLock(o.lock),
  }
}

// ── 时间 ──

export function minuteToHHmm(minute: number): string {
  const m = Math.max(0, Math.min(DAY_MINUTES, Math.round(minute)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 'HH:mm' → 分钟；写得不对返回 null */
export function parseHHmm(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const match = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(text)
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 24 || m > 59 || (h === 24 && m > 0)) return null
  return h * 60 + m
}

export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  d.setDate(d.getDate() + days)
  return d
}

// ── 锚 ──

/** 锚标签和它的子标签的 id */
export function anchorTagIds(anchorTagId: number, tags: readonly ActivityTag[]): Set<number> {
  const ids = new Set<number>([anchorTagId])
  const anchor = tags.find((t) => t.id === anchorTagId)
  if (!anchor) return ids
  const prefix = `${anchor.fullPath},`
  for (const tag of tags) {
    if (tag.categoryId === anchor.categoryId && tag.fullPath.startsWith(prefix)) ids.add(tag.id)
  }
  return ids
}

/** 当天锚的结束时刻：命中标签的各段（间隔不超过 ANCHOR_MERGE_GAP_MIN 的并成一段）里，结束时刻落在时段内的最后一段 */
export function findAnchorEnd(rule: IslandRule, blocks: readonly ActivityBlock[], tagIds: ReadonlySet<number>): number | null {
  const minutes = blocks.filter((b) => tagIds.has(b.tagId)).map((b) => b.minute).sort((a, b) => a - b)
  let segmentEnd: number | null = null
  let found: number | null = null
  const close = () => {
    if (segmentEnd != null && segmentEnd >= rule.windowStart && segmentEnd <= rule.windowEnd) found = segmentEnd
  }
  for (const minute of minutes) {
    if (segmentEnd != null && minute - segmentEnd > ANCHOR_MERGE_GAP_MIN) close()
    segmentEnd = minute + BLOCK_MINUTES
  }
  close()
  return found
}

/** 近几天锚时刻的平均值（没有一天有锚 = null） */
export function estimateAnchorEnd(
  rule: IslandRule,
  historyByDate: ReadonlyMap<string, readonly ActivityBlock[]>,
  tagIds: ReadonlySet<number>,
): { minute: number; sampleDays: number } | null {
  const ends: number[] = []
  for (const blocks of historyByDate.values()) {
    const end = findAnchorEnd(rule, blocks, tagIds)
    if (end != null) ends.push(end)
  }
  if (ends.length === 0) return null
  const mean = ends.reduce((sum, v) => sum + v, 0) / ends.length
  return { minute: snap(mean), sampleDays: ends.length }
}

// ── 落点 ──

export interface PlacementInput {
  readonly islands: readonly Island[]
  readonly palette: ActivityPalette
  /** 这一天的实际记录 */
  readonly blocks: readonly ActivityBlock[]
  /** 这一天之前几天的实际记录，按日期分组 */
  readonly historyByDate: ReadonlyMap<string, readonly ActivityBlock[]>
  /** 这一天勾掉的事：浮岛 id → 事项 id */
  readonly checks: ReadonlyMap<string, ReadonlySet<string>>
  /** 这一天相对今天：-1 过去 / 0 今天 / 1 将来 */
  readonly dayOffset: -1 | 0 | 1
  /** 此刻的分钟数（只在今天用） */
  readonly nowMinute: number
}

function placeOne(island: Island, input: PlacementInput): IslandPlacement {
  const { rule } = island
  const done = input.checks.get(island.id) ?? new Set<string>()
  const doneItemIds = rule.items.length > 0
    ? rule.items.filter((item) => done.has(item.id)).map((item) => item.id)
    : done.has(WHOLE_ITEM_ID) ? [WHOLE_ITEM_ID] : []
  const allDone = rule.items.length > 0 ? doneItemIds.length === rule.items.length : doneItemIds.length > 0

  let basis: PlacementBasis = 'none'
  let start: number | null = null
  let anchorEnd: number | null = null
  let sampleDays = 0
  let late = false

  if (rule.kind === 'fixed') {
    basis = 'fixed'
    start = rule.startMinute
  } else if (rule.anchorTagId != null) {
    const tagIds = anchorTagIds(rule.anchorTagId, input.palette.tags)
    // 将来的日子不会有记录，直接估
    anchorEnd = input.dayOffset > 0 ? null : findAnchorEnd(rule, input.blocks, tagIds)
    let base = anchorEnd
    if (base != null) {
      basis = 'anchored'
    } else {
      const estimate = estimateAnchorEnd(rule, input.historyByDate, tagIds)
      if (estimate) {
        basis = 'estimated'
        base = estimate.minute
        sampleDays = estimate.sampleDays
      }
    }
    if (base != null) {
      const wanted = base + rule.offsetMin
      late = rule.latestStart != null && wanted > rule.latestStart
      start = late && rule.latestStart != null ? rule.latestStart : wanted
    }
  }

  // 排到了当天之外：画不出来，按估不出处理
  if (start != null && start >= DAY_MINUTES) {
    basis = 'none'
    start = null
  }
  const end = start != null ? Math.min(DAY_MINUTES, start + rule.durationMin) : null

  let status: PlacementStatus = 'upcoming'
  if (allDone) status = 'done'
  else if (input.dayOffset < 0) status = 'missed'
  else if (input.dayOffset === 0 && start != null && end != null) {
    if (input.nowMinute >= end) status = 'missed'
    else if (input.nowMinute >= start) status = 'active'
  }

  return { island, basis, start, end, anchorEnd, sampleDays, late, doneItemIds, status }
}

/** 这一天每条规则的落点（停用的不出） */
export function computePlacements(input: PlacementInput): IslandPlacement[] {
  return input.islands
    .filter((island) => island.rule.enabled)
    .map((island) => placeOne(island, input))
    .sort((a, b) => (a.start ?? DAY_MINUTES) - (b.start ?? DAY_MINUTES))
}

/** 浮岛的颜色：自己定的 > 锚标签所在分类的 > 默认 */
export function islandColor(rule: IslandRule, palette: ActivityPalette, fallback: string): string {
  if (rule.color) return rule.color
  if (rule.anchorTagId == null) return fallback
  const tag = palette.tags.find((t) => t.id === rule.anchorTagId)
  const category = tag ? palette.categories.find((c) => c.id === tag.categoryId) : undefined
  return category?.color ?? fallback
}

/** 一句话说清这条规则（面板和 AI 都用） */
export function describeRule(rule: IslandRule, palette: ActivityPalette): string {
  const duration = `${rule.durationMin} 分钟`
  if (rule.kind === 'fixed') return `每天 ${minuteToHHmm(rule.startMinute)} 开始，${duration}`
  const tag = palette.tags.find((t) => t.id === rule.anchorTagId)
  const anchor = tag ? `「${tag.leafName}」` : '（标签已不存在）'
  const fullDay = rule.windowStart === 0 && rule.windowEnd === DAY_MINUTES
  const window = fullDay ? '' : `（${minuteToHHmm(rule.windowStart)}–${minuteToHHmm(rule.windowEnd)} 结束的那次）`
  const gap = rule.offsetMin === 0 ? '结束后马上' : `结束后 ${formatGap(rule.offsetMin)}`
  const latest = rule.latestStart != null ? `，最晚 ${minuteToHHmm(rule.latestStart)}` : ''
  return `${anchor}${window}${gap}，${duration}${latest}`
}

function formatGap(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`
}

/** 一句话说清锁了什么（面板和 AI 都用）；不锁返回空串 */
export function describeLock(lock: IslandLock | null): string {
  if (!lock) return ''
  const parts: string[] = []
  if (lock.apps.length > 0) parts.push(`${lock.apps.length} 个应用`)
  if (lock.sites.length > 0) parts.push(`${lock.sites.length} 个网站`)
  const gray = lock.apps.filter((e) => e.gray).length + lock.sites.filter((e) => e.gray).length
  return `锁 ${parts.join(' + ')}${gray > 0 ? `（其中 ${gray} 项交给 AI 判断）` : ''}，${lock.untilDone ? '做完才解开' : '到点解开'}`
}

/** 落点的时间怎么写：估的前面带「约」 */
export function describePlacementTime(p: IslandPlacement): string {
  if (p.start == null || p.end == null) return '还估不出位置'
  const range = `${minuteToHHmm(p.start)}–${minuteToHHmm(p.end)}`
  return p.basis === 'estimated' ? `约 ${range}` : range
}
