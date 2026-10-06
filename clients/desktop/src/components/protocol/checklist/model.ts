// ══════════════════════════════════════════════
// 协议志 · 清单的数据模型（纯函数，不碰界面）
//   清单 = 项目标签树：分类 → 标签路径各段（「编程,氛围编程,solo-leveling-system项目」= 三层清单）
//   任务 = 计划节点：挂在某个标签下，可以无限嵌套子任务；和昼夜表的「计划」层是同一份数据
// ══════════════════════════════════════════════

import type { ActivityCategory, ActivityPalette, ActivityTag, PlanNode } from '../../../types'

// ── 清单树 ──

export interface ListNode {
  /** 稳定 key：分类根 = `c:{id}`，路径节点 = `c:{id}/段/段` */
  readonly key: string
  readonly label: string
  readonly categoryId: number
  readonly color: string
  /** 完整路径（含分类名作首段），新建子清单时拼在它后面 */
  readonly fullPath: string
  /** 正好有这个路径的标签 → 可以往这个清单里直接加任务 */
  readonly tagId: number | null
  readonly depth: number
  readonly children: readonly ListNode[]
}

interface MutableListNode {
  key: string
  label: string
  categoryId: number
  color: string
  fullPath: string
  tagId: number | null
  depth: number
  children: MutableListNode[]
}

export function buildListTree(palette: ActivityPalette): ListNode[] {
  const categories = [...palette.categories].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
  return categories.map((cat) => buildCategory(cat, palette.tags.filter((t) => t.categoryId === cat.id)))
}

function buildCategory(cat: ActivityCategory, tags: readonly ActivityTag[]): ListNode {
  const root: MutableListNode = {
    key: `c:${cat.id}`, label: cat.name, categoryId: cat.id, color: cat.color,
    fullPath: cat.name, tagId: null, depth: 0, children: [],
  }
  const sorted = [...tags].sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'zh-Hans-CN'))
  for (const tag of sorted) {
    const parts = tag.fullPath.split(',').map((p) => p.trim()).filter(Boolean)
    // 约定首段 = 分类名；不是的话整条路径都挂在分类下
    const segs = parts[0] === cat.name ? parts.slice(1) : parts
    if (segs.length === 0) {
      root.tagId = tag.id
      continue
    }
    let cur = root
    segs.forEach((seg, i) => {
      let next = cur.children.find((c) => c.label === seg)
      if (!next) {
        next = {
          key: `${cur.key}/${seg}`, label: seg, categoryId: cat.id, color: cat.color,
          fullPath: `${cur.fullPath},${seg}`, tagId: null, depth: i + 1, children: [],
        }
        cur.children.push(next)
      }
      cur = next
    })
    cur.tagId = tag.id
  }
  return root
}

/** 一个清单节点（含所有子清单）覆盖的标签 id */
export function tagIdsUnder(node: ListNode): number[] {
  const out: number[] = []
  const walk = (n: ListNode) => {
    if (n.tagId != null) out.push(n.tagId)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

export function findListNode(tree: readonly ListNode[], key: string): ListNode | null {
  for (const n of tree) {
    if (n.key === key) return n
    const hit = findListNode(n.children, key)
    if (hit) return hit
  }
  return null
}

export function findListByTag(tree: readonly ListNode[], tagId: number): ListNode | null {
  for (const n of tree) {
    if (n.tagId === tagId) return n
    const hit = findListByTag(n.children, tagId)
    if (hit) return hit
  }
  return null
}

/** 清单显示名：去掉分类首段后的路径，「氛围编程 › solo-leveling-system项目」 */
export function listPathLabel(tag: ActivityTag | undefined): string {
  if (!tag) return '未知清单'
  const parts = tag.fullPath.split(',')
  return parts.length > 1 ? parts.slice(1).join(' › ') : parts[0]
}

// ── 任务树 ──

/** parentId → 子任务（按 sortOrder），只收给定标签里的 */
export function childrenIndex(nodes: readonly PlanNode[]): Map<number | null, PlanNode[]> {
  const map = new Map<number | null, PlanNode[]>()
  for (const n of nodes) {
    const list = map.get(n.parentId) ?? []
    list.push(n)
    map.set(n.parentId, list)
  }
  for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
  return map
}

export interface TaskRowItem {
  readonly node: PlanNode
  readonly depth: number
  /** 未完成的子任务数 / 全部子任务数（折叠时显示「2/5」） */
  readonly openChildren: number
  readonly totalChildren: number
}

/**
 * 一个标签下的任务树 → 按显示顺序拍平。
 * 已完成的顶层任务不在树里（收进底部「已完成」）；已完成的子任务留在原位，划线变暗，看得到进度。
 */
export function flattenTaskTree(
  index: Map<number | null, PlanNode[]>,
  rootIds: readonly PlanNode[],
  collapsed: ReadonlySet<number>,
): TaskRowItem[] {
  const out: TaskRowItem[] = []
  const walk = (node: PlanNode, depth: number) => {
    const kids = (index.get(node.id) ?? []).filter((k) => k.status !== 'archived')
    out.push({
      node, depth,
      openChildren: kids.filter((k) => k.status === 'active').length,
      totalChildren: kids.length,
    })
    if (collapsed.has(node.id)) return
    kids.forEach((k) => walk(k, depth + 1))
  }
  rootIds.filter((n) => n.status === 'active').forEach((n) => walk(n, 0))
  return out
}

/** 一棵子树里所有任务 id（含自己） */
export function subtreeIds(index: Map<number | null, PlanNode[]>, id: number): number[] {
  const out = [id]
  for (const k of index.get(id) ?? []) out.push(...subtreeIds(index, k.id))
  return out
}

/** 从任务往上找祖先标题，做「父任务 › 子任务」的面包屑 */
export function ancestorTitles(byId: ReadonlyMap<number, PlanNode>, node: PlanNode): string[] {
  const out: string[] = []
  let cur = node.parentId != null ? byId.get(node.parentId) : undefined
  let guard = 0
  while (cur && guard++ < 50) {
    out.unshift(cur.title)
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined
  }
  return out
}

// ── 日期 ──

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return toDateKey(new Date(y, m - 1, d + days))
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/** 日期的人话：今天 / 明天 / 昨天 / 周三（一周内）/ 10月12日（跨年带年份） */
export function dueLabel(due: string, today: string): string {
  if (due === today) return '今天'
  if (due === addDays(today, 1)) return '明天'
  if (due === addDays(today, -1)) return '昨天'
  const [y, m, d] = due.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const diff = Math.round((date.getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000)
  if (diff > 1 && diff < 7) return `周${WEEKDAY[date.getDay()]}`
  const thisYear = Number(today.slice(0, 4))
  return y === thisYear ? `${m}月${d}日` : `${y}年${m}月${d}日`
}

// ── 智能视图 ──

export type SmartView = 'today' | 'week' | 'all' | 'done'

/** 左栏选中的是智能视图，还是某个清单 */
export type ChecklistSelection =
  | { readonly kind: 'smart'; readonly id: SmartView }
  | { readonly kind: 'list'; readonly key: string }

export const SMART_VIEWS: readonly { readonly id: SmartView; readonly label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '最近 7 天' },
  { id: 'all', label: '全部' },
  { id: 'done', label: '已完成' },
]

/** 今天视图：今天到期 + 已逾期（逾期排前，再按优先级） */
export function todayTasks(nodes: readonly PlanNode[], today: string): PlanNode[] {
  return nodes
    .filter((n) => n.status === 'active' && n.dueDate != null && n.dueDate <= today)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0) || b.priority - a.priority || a.id - b.id)
}

/** 最近 7 天：逾期 + 今天起 7 天内，按日期分组 */
export function weekGroups(nodes: readonly PlanNode[], today: string): { key: string; label: string; tasks: PlanNode[] }[] {
  const end = addDays(today, 6)
  const active = nodes.filter((n) => n.status === 'active' && n.dueDate != null && n.dueDate <= end)
  const groups: { key: string; label: string; tasks: PlanNode[] }[] = []
  const overdue = active.filter((n) => n.dueDate! < today)
  if (overdue.length) groups.push({ key: 'overdue', label: '已逾期', tasks: sortByPriority(overdue) })
  for (let i = 0; i < 7; i++) {
    const day = addDays(today, i)
    const tasks = active.filter((n) => n.dueDate === day)
    if (tasks.length) groups.push({ key: day, label: `${dueLabel(day, today)} · ${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`, tasks: sortByPriority(tasks) })
  }
  return groups
}

/** 已完成：按完成日期分组，新的在前 */
export function doneGroups(nodes: readonly PlanNode[], today: string): { key: string; label: string; tasks: PlanNode[] }[] {
  const done = nodes
    .filter((n) => n.status === 'done')
    .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))
  const groups = new Map<string, PlanNode[]>()
  for (const n of done) {
    const day = (n.completedAt ?? n.updatedAt).slice(0, 10)
    groups.set(day, [...(groups.get(day) ?? []), n])
  }
  return [...groups.entries()].map(([day, tasks]) => ({ key: day, label: dueLabel(day, today), tasks }))
}

function sortByPriority(list: PlanNode[]): PlanNode[] {
  return [...list].sort((a, b) => b.priority - a.priority || a.sortOrder - b.sortOrder || a.id - b.id)
}
