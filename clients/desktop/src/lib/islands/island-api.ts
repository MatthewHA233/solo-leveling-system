// ══════════════════════════════════════════════
// 昼夜表 · 浮岛与日程的本地 API 客户端（后端 src-tauri/src/islands.rs）
// ══════════════════════════════════════════════

import { emit } from '@tauri-apps/api/event'
import type { ActivityBlock } from '../../types'
import { API_BASE } from '../local-api'
import { normalizeRule, toDateKey } from './island-model'
import type { Island, IslandRule } from './island-model'

/** 昼夜表的数据被别处改了（AI 工具、面板）：主窗口收到后重新取实际记录、计划和浮岛。跨窗口，走 Tauri 事件 */
export const DAYNIGHT_CHANGED_EVENT = 'solevup:daynight-changed'

export function notifyDayNightChanged(): void {
  emit(DAYNIGHT_CHANGED_EVENT).catch((err) => console.warn('[Islands] 通知昼夜表刷新失败', err))
}

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

interface RawIsland {
  id: string
  doc: unknown
  sort_order: number
  created_at: string
  updated_at: string
}

interface RawCheck {
  island_id: string
  item_id: string
}

interface RawBlock {
  date: string
  minute: number
  tag_id: number
  note: string | null
  created_at: string
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new Error('连不上本地服务（应用后端没在运行？）')
  }
  if (!res.ok) throw new Error(`浮岛服务出错（${res.status}）`)
  const json = (await res.json()) as ApiResponse<T>
  if (!json.success) throw new Error(json.error ?? '浮岛服务出错')
  return json.data as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

function mapIsland(raw: RawIsland): Island {
  return { id: raw.id, rule: normalizeRule(raw.doc), sortOrder: raw.sort_order, createdAt: raw.created_at, updatedAt: raw.updated_at }
}

/** 规则列表；库里某条读不成合法规则就跳过（不让一条坏的拖垮整张表） */
export async function fetchIslands(): Promise<Island[]> {
  const raw = await call<RawIsland[]>('/api/islands')
  return raw.flatMap((r) => {
    try {
      return [mapIsland(r)]
    } catch (err) {
      console.warn(`[Islands] 规则 ${r.id} 不合法，已跳过`, err)
      return []
    }
  })
}

export async function createIsland(rule: IslandRule): Promise<Island> {
  return mapIsland(await call<RawIsland>('/api/islands', jsonInit('POST', { doc: rule })))
}

export async function updateIsland(id: string, rule: IslandRule): Promise<Island> {
  return mapIsland(await call<RawIsland>(`/api/islands/${encodeURIComponent(id)}`, jsonInit('PUT', { doc: rule })))
}

export async function deleteIsland(id: string): Promise<void> {
  await call<null>(`/api/islands/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 这一天勾掉的事：浮岛 id → 事项 id */
export async function fetchIslandChecks(date: Date): Promise<Map<string, Set<string>>> {
  const raw = await call<RawCheck[]>(`/api/island-checks?date=${toDateKey(date)}`)
  const out = new Map<string, Set<string>>()
  for (const check of raw) {
    const set = out.get(check.island_id) ?? new Set<string>()
    set.add(check.item_id)
    out.set(check.island_id, set)
  }
  return out
}

export async function setIslandCheck(date: Date, islandId: string, itemId: string, done: boolean): Promise<void> {
  await call<null>('/api/island-checks', jsonInit('POST', { date: toDateKey(date), island_id: islandId, item_id: itemId, done }))
}

/** 一段日期内的实际记录（含两端），按日期分组 */
export async function fetchActivityBlocksRange(from: Date, to: Date): Promise<Map<string, ActivityBlock[]>> {
  const raw = await call<RawBlock[]>(`/api/activities/blocks/range?from=${toDateKey(from)}&to=${toDateKey(to)}`)
  const out = new Map<string, ActivityBlock[]>()
  for (const b of raw) {
    const list = out.get(b.date) ?? []
    list.push({ date: b.date, minute: b.minute, tagId: b.tag_id, note: b.note, createdAt: b.created_at })
    out.set(b.date, list)
  }
  return out
}
