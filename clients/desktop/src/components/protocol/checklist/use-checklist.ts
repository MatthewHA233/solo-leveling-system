// 协议志 · 清单的数据：全部任务 + 增删改移。
// 改动先落到本地状态（界面立刻有反应），再写后端；失败就整表重拉，并把错误交给界面提示。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanNode } from '../../../types'
import {
  addPlanNode, deletePlanNode, fetchAllPlanNodes, movePlanNode, updatePlanNode,
} from '../../../lib/local-api'

export type TaskPatch = Parameters<typeof updatePlanNode>[1]

/** 「计划节点有变化」的广播：清单页收到就重读（自己写的改动不发，免得来回刷） */
export const PLAN_NODES_CHANGED = 'solevup:plan-nodes-changed'

export interface ChecklistData {
  readonly nodes: readonly PlanNode[]
  readonly loading: boolean
  readonly error: string | null
  readonly reload: () => Promise<void>
  readonly add: (
    projectTagId: number,
    title: string,
    parentId: number | null,
    extra?: { dueDate?: string | null; priority?: PlanNode['priority'] },
  ) => Promise<PlanNode | null>
  readonly update: (id: number, patch: TaskPatch) => Promise<void>
  readonly move: (id: number, target: { projectTagId: number; parentId: number | null; index: number }) => Promise<void>
  readonly remove: (id: number) => Promise<void>
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 和后端 local_now_string 同一格式：「2026-10-06 09:30:00」（本地时间，按日期分组才不会跨午夜归错天） */
function localNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** onChanged：每次写成功后通知外面（App 用来刷新昼夜表的计划层） */
export function useChecklist(onChanged?: () => void): ChecklistData {
  const [nodes, setNodes] = useState<readonly PlanNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged

  const reload = useCallback(async () => {
    try {
      const all = await fetchAllPlanNodes()
      setNodes(all)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  // 别处改了计划节点（昼夜表的「计划安排」、Fairy 的工具……）：重读一次
  useEffect(() => {
    const onChanged = () => { void reload() }
    window.addEventListener(PLAN_NODES_CHANGED, onChanged)
    return () => window.removeEventListener(PLAN_NODES_CHANGED, onChanged)
  }, [reload])

  // 写操作的统一收尾：成功通知外面；失败记错误并整表重拉（本地乐观状态可能已经不对）
  const commit = useCallback(async (work: () => Promise<void>) => {
    try {
      await work()
      setError(null)
      changedRef.current?.()
    } catch (e) {
      setError(errorText(e))
      await reload()
    }
  }, [reload])

  const add = useCallback<ChecklistData['add']>(async (projectTagId, title, parentId, extra) => {
    try {
      const node = await addPlanNode(projectTagId, title, parentId, extra)
      setNodes((prev) => [...prev, node])
      setError(null)
      changedRef.current?.()
      return node
    } catch (e) {
      setError(errorText(e))
      return null
    }
  }, [])

  const update = useCallback<ChecklistData['update']>(async (id, patch) => {
    const now = localNow()
    setNodes((prev) => prev.map((n) => (n.id !== id ? n : {
      ...n,
      ...(patch.title !== undefined ? { title: patch.title } : null),
      ...(patch.status !== undefined ? {
        status: patch.status,
        completedAt: patch.status === 'done' ? (n.completedAt ?? now) : patch.status === 'active' ? null : n.completedAt,
      } : null),
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : null),
      ...(patch.priority !== undefined ? { priority: patch.priority } : null),
      ...(patch.note !== undefined ? { note: patch.note?.trim() ? patch.note.trim() : null } : null),
    })))
    await commit(() => updatePlanNode(id, patch))
  }, [commit])

  const move = useCallback<ChecklistData['move']>(async (id, target) => {
    // 位置要重排兄弟、子树可能整体换清单，乐观更新算不全——直接写后端再重拉
    await commit(async () => {
      await movePlanNode(id, target)
      await reload()
    })
  }, [commit, reload])

  const remove = useCallback<ChecklistData['remove']>(async (id) => {
    // 删的是整棵子树：本地先把子孙一起拿掉
    setNodes((prev) => {
      const doomed = new Set([id])
      let grew = true
      while (grew) {
        grew = false
        for (const n of prev) {
          if (n.parentId != null && doomed.has(n.parentId) && !doomed.has(n.id)) {
            doomed.add(n.id)
            grew = true
          }
        }
      }
      return prev.filter((n) => !doomed.has(n.id))
    })
    await commit(() => deletePlanNode(id))
  }, [commit])

  return { nodes, loading, error, reload, add, update, move, remove }
}
