// ══════════════════════════════════════════════
// Local API — 本地 HTTP 客户端
// 替代 Supabase
// ══════════════════════════════════════════════

import type { ChronosActivity, ChronosStep } from '../types'

const API_BASE = 'http://localhost:3000'

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

// Rust API 返回 snake_case
interface RawStep {
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
  steps: RawStep[]
}

function mapActivity(r: RawActivity): ChronosActivity {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    startMinute: r.start_minute,
    endMinute: r.end_minute,
    goalAlignment: r.goal_alignment ?? undefined,
    steps: (r.steps ?? []).map((s): ChronosStep => ({
      id: s.id,
      minute: s.minute,
      label: s.label,
      title: s.title,
    })),
  }
}

/** 查询某天的所有活动（含步骤） */
export async function fetchActivities(date: Date): Promise<ChronosActivity[]> {
  const dateStr = date.toISOString().slice(0, 10)

  const res = await fetch(`${API_BASE}/api/activities?date=${dateStr}`)
  const json: ApiResponse<RawActivity[]> = await res.json()

  if (!json.success || !json.data) {
    throw new Error(json.error || '获取活动失败')
  }

  return json.data.map(mapActivity)
}

/** 插入一条活动（含步骤） */
export async function createActivity(
  date: Date,
  activity: Omit<ChronosActivity, 'id'>,
): Promise<string> {
  const dateStr = date.toISOString().slice(0, 10)

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
      steps: activity.steps.map((s) => ({
        minute: s.minute,
        label: s.label,
        title: s.title,
      })),
    }),
  })

  const json: ApiResponse<string> = await res.json()

  if (!json.success || !json.data) {
    throw new Error(json.error || '创建活动失败')
  }

  return json.data
}

/** 删除一条活动（级联删除步骤） */
export async function deleteActivity(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/activities/${id}`, {
    method: 'DELETE',
  })

  const json: ApiResponse<void> = await res.json()

  if (!json.success) {
    throw new Error(json.error || '删除活动失败')
  }
}

/** 更新一条活动（含步骤） */
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
      steps: activity.steps.map((s) => ({
        minute: s.minute,
        label: s.label,
        title: s.title,
      })),
    }),
  })

  const json: ApiResponse<void> = await res.json()

  if (!json.success) {
    throw new Error(json.error || '更新活动失败')
  }
}