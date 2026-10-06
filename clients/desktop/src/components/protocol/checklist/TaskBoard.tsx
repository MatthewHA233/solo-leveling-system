// ══════════════════════════════════════════════
// 协议志 · 清单中栏：快速添加 + 任务树
//   键盘（改名时）：回车 = 下面接着写一条 · Tab / Shift+Tab = 缩进 / 反缩进
//                   ↑ ↓ = 换行改名 · Alt+↑ / Alt+↓ = 上下挪 · 空标题退格 = 删掉 · Esc = 退出
//   清单视图是树（按子清单分段）；今天 / 最近 7 天 / 已完成 是平铺，每行带所在清单
// ══════════════════════════════════════════════

import { Fragment, useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { ActivityPalette, ActivityTag, PlanNode } from '../../../types'
import { theme, ti, tiInput, tiTitle } from '../../../theme'
import HudSelect from '../../HudSelect'
import TaskRow, { ROW_INDENT } from './TaskRow'
import type { ChecklistData } from './use-checklist'
import {
  ancestorTitles, childrenIndex, doneGroups, findListNode, flattenTaskTree, listPathLabel,
  SMART_VIEWS, tagIdsUnder, todayTasks, weekGroups,
  type ChecklistSelection, type ListNode, type TaskRowItem,
} from './model'

/** 正在写的新任务（还没入库）：挂在哪、插第几个、画在哪一行后面 */
interface Draft {
  readonly projectTagId: number
  readonly parentId: number | null
  readonly index: number
  readonly depth: number
  /** 画在这一行（连同它展开的子孙）后面；null = 画在分段最前 */
  readonly afterId: number | null
}

type Block =
  | { readonly kind: 'tree'; readonly key: string; readonly title: string | null; readonly tagId: number; readonly rows: readonly TaskRowItem[] }
  | { readonly kind: 'flat'; readonly key: string; readonly title: string | null; readonly tasks: readonly PlanNode[] }

export interface TaskBoardProps {
  readonly data: ChecklistData
  readonly palette: ActivityPalette
  readonly tree: readonly ListNode[]
  readonly selection: ChecklistSelection
  readonly today: string
  readonly selectedTaskId: number | null
  readonly onSelectTask: (id: number | null) => void
  readonly collapsed: ReadonlySet<number>
  readonly onSetCollapsed: (id: number, collapsed: boolean) => void
  /** 快速添加默认写进哪个清单 */
  readonly defaultTagId: number | null
  readonly onDefaultTagChange: (tagId: number) => void
}

export default function TaskBoard(props: TaskBoardProps) {
  const { data, palette, tree, selection, today, selectedTaskId, collapsed } = props
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [quick, setQuick] = useState('')
  const quickRef = useRef<HTMLInputElement>(null)

  const tagById = useMemo(() => new Map(palette.tags.map((t) => [t.id, t] as const)), [palette.tags])
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n] as const)), [data.nodes])
  const index = useMemo(() => childrenIndex(data.nodes.filter((n) => n.status !== 'archived')), [data.nodes])
  const listNode = selection.kind === 'list' ? findListNode(tree, selection.key) : null

  /** 同一层的兄弟（顶层要按清单区分，因为 parentId 都是 null） */
  const siblingsOf = useCallback((node: { parentId: number | null; projectTagId: number }) =>
    (index.get(node.parentId) ?? []).filter((n) => n.projectTagId === node.projectTagId && n.status !== 'archived'),
  [index])

  // ── 本视图的分段 ──
  const { blocks, scopeTagIds, doneRoots, title, activeCount } = useMemo(() => {
    const rootsOf = (tagId: number) => (index.get(null) ?? []).filter((n) => n.projectTagId === tagId)
    const treeBlocks = (tagIds: readonly number[], base: ListNode | null): Block[] => tagIds
      .filter((id) => rootsOf(id).some((n) => n.status === 'active') || id === base?.tagId)
      .map((id) => {
        const tag = tagById.get(id)
        // 分段标题：相对当前清单的子路径；正好是当前清单本身就不要标题
        const rel = base && tag && id !== base.tagId
          ? tag.fullPath.split(',').slice(base.depth + 1).join(' › ')
          : null
        const title = base ? rel : (tag ? tag.fullPath.split(',').join(' › ') : null)
        return { kind: 'tree', key: `t:${id}`, title, tagId: id, rows: flattenTaskTree(index, rootsOf(id), collapsed) }
      })

    if (selection.kind === 'list') {
      const ids = listNode ? tagIdsUnder(listNode) : []
      const set = new Set(ids)
      const all = data.nodes.filter((n) => set.has(n.projectTagId))
      return {
        blocks: treeBlocks(ids, listNode),
        scopeTagIds: ids,
        doneRoots: all.filter((n) => n.status === 'done' && n.parentId == null),
        title: listNode ? (listNode.depth === 0 ? listNode.label : listNode.fullPath.split(',').slice(1).join(' › ')) : '清单',
        activeCount: all.filter((n) => n.status === 'active').length,
      }
    }

    const active = data.nodes.filter((n) => n.status === 'active')
    const label = SMART_VIEWS.find((v) => v.id === selection.id)?.label ?? ''
    switch (selection.id) {
      case 'today': {
        const tasks = todayTasks(data.nodes, today)
        return { blocks: [{ kind: 'flat', key: 'today', title: null, tasks }] as Block[], scopeTagIds: [], doneRoots: [], title: label, activeCount: tasks.length }
      }
      case 'week': {
        const groups = weekGroups(data.nodes, today)
        return {
          blocks: groups.map((g) => ({ kind: 'flat', key: g.key, title: g.label, tasks: g.tasks }) as Block),
          scopeTagIds: [], doneRoots: [], title: label,
          activeCount: groups.reduce((s, g) => s + g.tasks.length, 0),
        }
      }
      case 'done': {
        const groups = doneGroups(data.nodes, today)
        return {
          blocks: groups.map((g) => ({ kind: 'flat', key: g.key, title: g.label, tasks: g.tasks }) as Block),
          scopeTagIds: [], doneRoots: [], title: label,
          activeCount: groups.reduce((s, g) => s + g.tasks.length, 0),
        }
      }
      default: {
        // 全部：每个有任务的清单一段
        const ids = [...new Set(active.map((n) => n.projectTagId))]
          .sort((a, b) => (tagById.get(a)?.fullPath ?? '').localeCompare(tagById.get(b)?.fullPath ?? '', 'zh-Hans-CN'))
        return { blocks: treeBlocks(ids, null), scopeTagIds: ids, doneRoots: [], title: label, activeCount: active.length }
      }
    }
  }, [selection, listNode, data.nodes, index, tagById, collapsed, today])

  // 平铺视图每行的「所在清单 › 父任务」
  const contextOf = useCallback((node: PlanNode) => {
    const parts = [listPathLabel(tagById.get(node.projectTagId)), ...ancestorTitles(byId, node)]
    return parts.join(' › ')
  }, [tagById, byId])

  // 所有可见行（跨分段），给 ↑ ↓ 换行用
  const visibleIds = useMemo(() => blocks.flatMap((b) => (b.kind === 'tree' ? b.rows.map((r) => r.node.id) : b.tasks.map((t) => t.id))), [blocks])

  // ── 快速添加的目标清单 ──
  const quickTagOptions = useMemo(() => {
    const ids = new Set<number>(scopeTagIds)
    if (selection.kind === 'smart') {
      data.nodes.forEach((n) => ids.add(n.projectTagId))
      ;[...palette.tags].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)).slice(0, 20).forEach((t) => ids.add(t.id))
    }
    if (props.defaultTagId != null) ids.add(props.defaultTagId)
    return [...ids].map((id) => tagById.get(id)).filter((t): t is ActivityTag => !!t)
      .sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'zh-Hans-CN'))
      .map((t) => ({ value: String(t.id), label: t.fullPath.split(',').join(' › ') }))
  }, [scopeTagIds, selection.kind, data.nodes, palette.tags, props.defaultTagId, tagById])

  const quickTagId = (() => {
    if (listNode?.tagId != null) return listNode.tagId
    if (props.defaultTagId != null && quickTagOptions.some((o) => o.value === String(props.defaultTagId))) return props.defaultTagId
    const first = quickTagOptions[0]
    return first ? Number(first.value) : null
  })()

  const submitQuick = async () => {
    const text = quick.trim()
    if (!text || quickTagId == null) return
    const dueDate = selection.kind === 'smart' && (selection.id === 'today' || selection.id === 'week') ? today : null
    const node = await data.add(quickTagId, text, null, { dueDate })
    if (node) {
      setQuick('')
      props.onDefaultTagChange(quickTagId)
    }
  }

  // ── 改名 / 键盘 ──
  const commitTitle = useCallback((node: PlanNode, value: string) => {
    const t = value.trim()
    if (t && t !== node.title) void data.update(node.id, { title: t })
  }, [data])

  const editNeighbor = (id: number, delta: number) => {
    const i = visibleIds.indexOf(id)
    const next = visibleIds[i + delta]
    if (next != null) {
      setEditingId(next)
      props.onSelectTask(next)
    }
  }

  const indent = async (node: PlanNode) => {
    const sibs = siblingsOf(node)
    const i = sibs.findIndex((s) => s.id === node.id)
    const prev = sibs[i - 1]
    if (!prev) return
    props.onSetCollapsed(prev.id, false)
    await data.move(node.id, { projectTagId: node.projectTagId, parentId: prev.id, index: (index.get(prev.id) ?? []).length })
  }

  const outdent = async (node: PlanNode) => {
    if (node.parentId == null) return
    const parent = byId.get(node.parentId)
    if (!parent) return
    const sibs = siblingsOf(parent)
    await data.move(node.id, { projectTagId: node.projectTagId, parentId: parent.parentId, index: sibs.findIndex((s) => s.id === parent.id) + 1 })
  }

  const shift = async (node: PlanNode, delta: -1 | 1) => {
    const sibs = siblingsOf(node)
    const i = sibs.findIndex((s) => s.id === node.id)
    const target = i + delta
    if (target < 0 || target >= sibs.length) return
    await data.move(node.id, { projectTagId: node.projectTagId, parentId: node.parentId, index: target })
  }

  const onEditKey = (node: PlanNode, e: React.KeyboardEvent<HTMLInputElement>, value: string, flat: boolean) => {
    if (e.nativeEvent.isComposing) return   // 输入法候选里按回车不算
    if (flat && (e.key === 'Enter' || e.key === 'Tab' || (e.key.startsWith('Arrow') && e.altKey))) {
      // 平铺视图里没有树：回车只是保存，不接着写、不缩进、不挪位置
      if (e.key === 'Enter' || e.key === 'Tab') e.preventDefault()
      if (e.key === 'Enter') { commitTitle(node, value); setEditingId(null) }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commitTitle(node, value)
      setEditingId(null)
      const sibs = siblingsOf(node)
      setDraft({
        projectTagId: node.projectTagId, parentId: node.parentId,
        index: sibs.findIndex((s) => s.id === node.id) + 1,
        depth: depthOf(node), afterId: node.id,
      })
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitTitle(node, value)
      void (e.shiftKey ? outdent(node) : indent(node))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingId(null)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      commitTitle(node, value)
      if (e.altKey) void shift(node, e.key === 'ArrowUp' ? -1 : 1)
      else editNeighbor(node.id, e.key === 'ArrowUp' ? -1 : 1)
    } else if (e.key === 'Backspace' && value === '' && (index.get(node.id) ?? []).length === 0) {
      e.preventDefault()
      editNeighbor(node.id, -1)
      void data.remove(node.id)
    }
  }

  const depthOf = (node: PlanNode) => {
    let d = 0
    let cur = node.parentId != null ? byId.get(node.parentId) : undefined
    while (cur && d < 50) {
      d++
      cur = cur.parentId != null ? byId.get(cur.parentId) : undefined
    }
    return d
  }

  const startChildDraft = (node: PlanNode) => {
    props.onSetCollapsed(node.id, false)
    setEditingId(null)
    setDraft({ projectTagId: node.projectTagId, parentId: node.id, index: (index.get(node.id) ?? []).length, depth: depthOf(node) + 1, afterId: node.id })
  }

  // ── 新任务草稿 ──
  const submitDraft = async (d: Draft, value: string) => {
    const text = value.trim()
    if (!text) { setDraft(null); return }
    const before = (index.get(d.parentId) ?? []).filter((n) => n.projectTagId === d.projectTagId).length
    const node = await data.add(d.projectTagId, text, d.parentId)
    if (!node) return
    if (d.index < before) await data.move(node.id, { projectTagId: d.projectTagId, parentId: d.parentId, index: d.index })
    setDraft({ ...d, index: d.index + 1, afterId: node.id })
  }

  const onDraftKey = (d: Draft, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    const value = e.currentTarget.value
    if (e.key === 'Enter') {
      e.preventDefault()
      void submitDraft(d, value)
      e.currentTarget.value = ''
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(null)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const sibs = (index.get(d.parentId) ?? []).filter((n) => n.projectTagId === d.projectTagId)
      if (e.shiftKey) {
        if (d.parentId == null) return
        const parent = byId.get(d.parentId)
        if (!parent) return
        const ps = siblingsOf(parent)
        setDraft({ ...d, parentId: parent.parentId, index: ps.findIndex((s) => s.id === parent.id) + 1, depth: d.depth - 1, afterId: parent.id })
      } else {
        const prev = sibs[d.index - 1]
        if (!prev) return
        props.onSetCollapsed(prev.id, false)
        setDraft({ ...d, parentId: prev.id, index: (index.get(prev.id) ?? []).length, depth: d.depth + 1, afterId: d.afterId ?? prev.id })
      }
    }
  }

  // ── 画 ──
  const renderRow = (item: TaskRowItem, context?: string) => {
    const flat = context !== undefined
    return (
    <TaskRow
      key={item.node.id}
      node={item.node}
      depth={item.depth}
      today={today}
      selected={item.node.id === selectedTaskId}
      editing={item.node.id === editingId}
      collapsed={collapsed.has(item.node.id)}
      openChildren={item.openChildren}
      totalChildren={item.totalChildren}
      context={context}
      onSelect={() => props.onSelectTask(item.node.id)}
      onToggleDone={() => void data.update(item.node.id, { status: item.node.status === 'done' ? 'active' : 'done' })}
      onToggleCollapse={() => props.onSetCollapsed(item.node.id, !collapsed.has(item.node.id))}
      onStartEdit={() => { setDraft(null); setEditingId(item.node.id) }}
      onAddChild={flat ? undefined : () => startChildDraft(item.node)}
      onEditKey={(e, v) => onEditKey(item.node, e, v, flat)}
      onCommitTitle={(v) => { commitTitle(item.node, v); setEditingId((cur) => (cur === item.node.id ? null : cur)) }}
    />
    )
  }

  const draftRow = (d: Draft) => (
    <div key="draft" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 34, padding: `0 10px 0 ${8 + d.depth * ROW_INDENT + 22}px` }}>
      <span style={{ width: 16, height: 16, flexShrink: 0, borderRadius: 4, border: `1.5px dashed ${theme.textMuted}` }} />
      <input
        autoFocus
        className="pt-inline-input"
        placeholder="写下要做的事，回车保存 · Tab 缩进"
        onKeyDown={(e) => onDraftKey(d, e)}
        onBlur={(e) => { const v = e.currentTarget.value; if (v.trim()) void submitDraft(d, v); else setDraft(null) }}
      />
    </div>
  )

  /** 树段：草稿插在锚点行（连同展开的子孙）后面 */
  const renderTree = (b: Extract<Block, { kind: 'tree' }>) => {
    const out: React.ReactNode[] = []
    const d = draft && draft.projectTagId === b.tagId ? draft : null
    let insertAt = b.rows.length
    if (d && d.afterId == null) insertAt = 0
    if (d && d.afterId != null) {
      const at = b.rows.findIndex((r) => r.node.id === d.afterId)
      if (at >= 0) {
        let end = at + 1
        while (end < b.rows.length && b.rows[end].depth > b.rows[at].depth) end++
        insertAt = end
      }
    }
    b.rows.forEach((r, i) => {
      if (d && insertAt === i) out.push(draftRow(d))
      out.push(renderRow(r))
    })
    if (d && insertAt === b.rows.length) out.push(draftRow(d))
    return out
  }

  const empty = blocks.every((b) => (b.kind === 'tree' ? b.rows.length === 0 : b.tasks.length === 0)) && !draft

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 标题 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px 10px', flexShrink: 0 }}>
        <span className="ti-diamond" aria-hidden />
        <span style={{ ...tiTitle, fontSize: 16, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span className="ti-well" style={{ padding: '1px 7px', borderRadius: 4 }}>
          <span className="ti-led" style={{ fontSize: 12 }}>{activeCount}</span>
        </span>
        <span style={{ flex: 1 }} />
        {data.error && <span style={{ fontSize: 11.5, color: theme.dangerRed, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.error}</span>}
      </div>

      {/* 快速添加 */}
      {!(selection.kind === 'smart' && selection.id === 'done') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 18px 12px', flexShrink: 0 }}>
          <div style={{ ...tiInput, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 10px' }}>
            <Plus size={15} color={ti.led} strokeWidth={2.6} />
            <input
              ref={quickRef}
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') { e.preventDefault(); void submitQuick() }
              }}
              placeholder={quickTagId == null ? '先在左边选一个清单' : selection.kind === 'smart' && selection.id !== 'all' ? '添加今天要做的事，回车保存' : '添加任务，回车保存'}
              disabled={quickTagId == null}
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: theme.textPrimary, fontSize: 13.5, fontFamily: theme.fontBody }}
            />
          </div>
          {listNode?.tagId == null && quickTagOptions.length > 0 && quickTagId != null && (
            <div style={{ width: 210, flexShrink: 0 }}>
              <HudSelect
                value={String(quickTagId)}
                options={quickTagOptions}
                onChange={(v) => props.onDefaultTagChange(Number(v))}
                popupWidth={300}
              />
            </div>
          )}
        </div>
      )}

      <div className="ti-groove-h" style={{ margin: '0 18px', flexShrink: 0 }} />

      {/* 任务 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px 24px' }}>
        {data.loading && <div style={{ padding: 20, color: theme.textMuted, fontSize: 12.5 }}>加载中…</div>}
        {!data.loading && empty && (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: theme.textSecondary, fontSize: 13, lineHeight: 1.8 }}>
            {selection.kind === 'smart' && selection.id === 'done' ? '还没有完成的任务' : '这里还没有任务，在上面写下第一件事'}
          </div>
        )}
        {blocks.map((b) => {
          const hasRows = b.kind === 'tree' ? b.rows.length > 0 || draft?.projectTagId === b.tagId : b.tasks.length > 0
          if (!hasRows && b.kind === 'flat') return null
          return (
            <Fragment key={b.key}>
              {b.title && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 8px 4px', fontSize: 11.5, fontWeight: 800, color: theme.textSecondary, letterSpacing: '0.04em' }}>
                  {b.title}
                  {b.kind === 'tree' && (
                    <button type="button" className="pt-row-add" style={{ opacity: 1 }} aria-label="在这个清单里加任务"
                      onClick={() => setDraft({ projectTagId: b.tagId, parentId: null, index: (index.get(null) ?? []).filter((n) => n.projectTagId === b.tagId).length, depth: 0, afterId: b.rows.at(-1)?.node.id ?? null })}>
                      <Plus size={12} strokeWidth={2.6} />
                    </button>
                  )}
                </div>
              )}
              {b.kind === 'tree'
                ? renderTree(b)
                : b.tasks.map((t) => renderRow({ node: t, depth: 0, openChildren: 0, totalChildren: 0 }, contextOf(t)))}
            </Fragment>
          )
        })}

        {/* 本清单已完成的任务：收在底部 */}
        {doneRoots.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button type="button" className="pt-done-toggle" onClick={() => setShowDone((v) => !v)}>
              {showDone ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              已完成 <span style={{ fontFamily: theme.fontMono }}>{doneRoots.length}</span>
            </button>
            {showDone && doneRoots
              .slice()
              .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))
              .map((t) => renderRow({ node: t, depth: 0, openChildren: 0, totalChildren: 0 }, contextOf(t)))}
          </div>
        )}
      </div>
    </div>
  )
}
