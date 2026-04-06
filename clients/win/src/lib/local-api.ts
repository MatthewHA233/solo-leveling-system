// ══════════════════════════════════════════════
// Local API — 本地 HTTP 客户端
// 替代 Supabase
// ══════════════════════════════════════════════

import type { ChronosActivity, ChronosEvent } from '../types'

const API_BASE = 'http://localhost:3000'

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

// Rust API 返回 snake_case
interface RawEvent {
  id: string
  minute: number
  label: string
  title: string
}

interface RawActivity {
  id: string
  date: string
  title: string
  category: string
  start_minute: number
  end_minute: number
  goal_alignment?: string | null
  events: RawEvent[]
}

function mapActivity(r: RawActivity): ChronosActivity {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    startMinute: r.start_minute,
    endMinute: r.end_minute,
    goalAlignment: r.goal_alignment ?? undefined,
    events: (r.events ?? []).map((e): ChronosEvent => ({
      id: e.id,
      minute: e.minute,
      label: e.label,
      title: e.title,
    })),
  }
}

function toLocalDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 查询某天的所有活动（含事件） */
export async function fetchActivities(date: Date): Promise<ChronosActivity[]> {
  const dateStr = toLocalDateStr(date)

  const res = await fetch(`${API_BASE}/api/activities?date=${dateStr}`)
  const json: ApiResponse<RawActivity[]> = await res.json()

  if (!json.success || !json.data) {
    throw new Error(json.error || '获取活动失败')
  }

  return json.data.map(mapActivity)
}

/** 插入一条活动（含事件），返回 { activityId, eventIds } */
export async function createActivity(
  date: Date,
  activity: Omit<ChronosActivity, 'id'>,
): Promise<{ activityId: string; eventIds: string[] }> {
  const dateStr = toLocalDateStr(date)

  const res = await fetch(`${API_BASE}/api/activities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: dateStr,
      title: activity.title,
      category: activity.category,
      start_minute: activity.startMinute,
      end_minute: activity.endMinute,
      goal_alignment: activity.goalAlignment ?? null,
      events: activity.events.map((e) => ({
        minute: e.minute,
        label: e.label,
        title: e.title,
      })),
    }),
  })

  const json: ApiResponse<{ id: string; event_ids: string[] }> = await res.json()

  if (!json.success || !json.data) {
    throw new Error(json.error || '创建活动失败')
  }

  return { activityId: json.data.id, eventIds: json.data.event_ids }
}

/** 删除一条活动（级联删除事件） */
export async function deleteActivity(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/activities/${id}`, {
    method: 'DELETE',
  })

  const json: ApiResponse<void> = await res.json()

  if (!json.success) {
    throw new Error(json.error || '删除活动失败')
  }
}

/** 更新一条活动（含事件） */
export async function updateActivity(
  id: string,
  activity: Omit<ChronosActivity, 'id'>,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/activities/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: activity.title,
      category: activity.category,
      start_minute: activity.startMinute,
      end_minute: activity.endMinute,
      goal_alignment: activity.goalAlignment ?? null,
      events: activity.events.map((e) => ({
        minute: e.minute,
        label: e.label,
        title: e.title,
      })),
    }),
  })

  const json: ApiResponse<void> = await res.json()

  if (!json.success) {
    throw new Error(json.error || '更新活动失败')
  }
}

/** 合并活动（事件 ID 不变，bvid 链接天然保留） */
export async function mergeActivities(
  survivorId: string,
  absorbedIds: string[],
  newStart: number,
  newEnd: number,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/activities/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      survivor_id: survivorId,
      absorbed_ids: absorbedIds,
      new_start: newStart,
      new_end: newEnd,
    }),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '合并失败')
}

// ── ManicTime API ──

export interface MtSpan {
  id: number
  track: string         // "apps" | "tags"
  start_at: string      // "2026-04-04 13:00:00"
  end_at: string
  title: string
  group_name: string | null
  color: string | null  // "#F9BA00"
}

/** 查询某天的 ManicTime spans（apps + tags） */
export async function fetchManicTimeSpans(date: Date): Promise<MtSpan[]> {
  const dateStr = toLocalDateStr(date)
  const res = await fetch(`${API_BASE}/api/manictime/spans?date=${dateStr}`)
  const json: ApiResponse<MtSpan[]> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '获取 ManicTime 数据失败')
  return json.data
}

// ── Bilibili 历史 DB API ──

export interface DbBiliItem {
  bvid: string
  oid: number
  title: string
  author_name: string
  cover: string
  duration: number
  progress: number
  view_at: number
  event_id: string | null
}

export interface BiliHistoryPage {
  items: DbBiliItem[]
  total: number
  page: number
  page_size: number
}

/** 分页查询本地 B站历史 */
export async function fetchBiliHistoryDb(
  page: number,
  pageSize: number,
  unlinkedOnly: boolean,
): Promise<BiliHistoryPage> {
  const res = await fetch(
    `${API_BASE}/api/bilibili/history?page=${page}&page_size=${pageSize}&unlinked_only=${unlinkedOnly}`,
  )
  const json: ApiResponse<BiliHistoryPage> = await res.json()
  if (!json.success || !json.data) throw new Error(json.error || '查询失败')
  return json.data
}

/** 将一批 bvid 关联到事件 */
export async function linkBiliToEvent(bvids: string[], eventId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/bilibili/history/link`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bvids, event_id: eventId }),
  })
  const json: ApiResponse<void> = await res.json()
  if (!json.success) throw new Error(json.error || '关联失败')
}
