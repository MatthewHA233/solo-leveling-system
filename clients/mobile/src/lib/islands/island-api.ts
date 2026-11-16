// ══════════════════════════════════════════════
// 昼夜表 · 浮岛与约束的数据访问（本机库，原生实现在 android/.../solevupdb/PlanStore.kt）
//   导出的函数和 desktop lib/islands/island-api.ts 同名同签名；desktop 走本地 HTTP，这里直接读写本机库，
//   两边的数据靠局域网同步合并（规则见 PlanStore.kt 文件头）
// ══════════════════════════════════════════════

import { DeviceEventEmitter } from 'react-native'
import type { ActivityBlock } from '../../types'
import { solevupPlans, type IslandRow } from '../solevupdb'
import { normalizeRule, toDateKey } from './island-model'
import type { Island, IslandRule } from './island-model'

/** 昼夜表的数据被别处改了（Fairy 的工具、计划面板）：昼夜表收到后重新取实际记录、计划和浮岛 */
export const DAYNIGHT_CHANGED_EVENT = 'solevup:daynight-changed'

export function notifyDayNightChanged(): void {
  DeviceEventEmitter.emit(DAYNIGHT_CHANGED_EVENT)
}

function mapIsland(raw: IslandRow): Island {
  return {
    id: raw.id,
    rule: normalizeRule(JSON.parse(raw.doc)),
    sortOrder: raw.sortOrder,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
}

/** 规则列表；库里某条读不成合法规则就跳过（不让一条坏的拖垮整张表） */
export async function fetchIslands(): Promise<Island[]> {
  const raw = await solevupPlans.listIslands()
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
  return mapIsland(await solevupPlans.createIsland(JSON.stringify(rule)))
}

export async function updateIsland(id: string, rule: IslandRule): Promise<Island> {
  return mapIsland(await solevupPlans.updateIsland(id, JSON.stringify(rule)))
}

export async function deleteIsland(id: string): Promise<void> {
  await solevupPlans.deleteIsland(id)
}

/** 这一天勾掉的事：浮岛 id → 事项 id */
export async function fetchIslandChecks(date: Date): Promise<Map<string, Set<string>>> {
  const raw = await solevupPlans.listIslandChecks(toDateKey(date))
  const out = new Map<string, Set<string>>()
  for (const check of raw) {
    const set = out.get(check.islandId) ?? new Set<string>()
    set.add(check.itemId)
    out.set(check.islandId, set)
  }
  return out
}

export async function setIslandCheck(date: Date, islandId: string, itemId: string, done: boolean): Promise<void> {
  await solevupPlans.setIslandCheck(toDateKey(date), islandId, itemId, done)
}

/** 一段日期内的实际记录（含两端），按日期分组 */
export async function fetchActivityBlocksRange(from: Date, to: Date): Promise<Map<string, ActivityBlock[]>> {
  const raw = await solevupPlans.listBlocksInRange(toDateKey(from), toDateKey(to))
  const out = new Map<string, ActivityBlock[]>()
  for (const b of raw) {
    const list = out.get(b.date) ?? []
    list.push({ date: b.date, minute: b.minute, tagId: b.tagId, note: b.note ?? null, createdAt: b.createdAt })
    out.set(b.date, list)
  }
  return out
}
