// ══════════════════════════════════════════════
// 协议志 · 清单（滴答清单式，但清单可以很多层）
//   左：今天 / 最近 7 天 / 全部 / 已完成 + 项目标签树（分类 → 路径各段，最深 4 层）
//   中：任务树（子任务无限嵌套）  右：任务详情
//   任务就是昼夜表「计划」层用的计划节点——这里建的任务，昼夜表上直接能拿去排时间
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityPalette } from '../../../types'
import { addActivityTag } from '../../../lib/local-api'
import ListSidebar from './ListSidebar'
import TaskBoard from './TaskBoard'
import TaskDetail from './TaskDetail'
import { useChecklist } from './use-checklist'
import {
  buildListTree, findListNode, todayTasks, toDateKey, weekGroups,
  type ChecklistSelection, type ListNode, type SmartView,
} from './model'
import './checklist.css'

export interface ChecklistViewProps {
  readonly palette: ActivityPalette
  /** 新建了清单（项目标签）后让 App 重拉调色板 */
  readonly onPaletteChange: () => void
  /** 任务有改动：让昼夜表的计划层跟着刷新 */
  readonly onPlanNodesChange?: () => void
}

// ── 界面偏好（只是本机的便利：选中的视图、折叠状态……读写失败就用默认值） ──
const PREF_KEY = 'slu.protocol.checklist'
/** 面板宽过这个值，详情栏才并排停靠；否则从右边滑出盖在任务区上 */
const DOCK_MIN_WIDTH = 1080
interface Prefs {
  selection: ChecklistSelection
  collapsed: number[]
  expanded: string[]
  showAll: boolean
  defaultTagId: number | null
}
const DEFAULT_PREFS: Prefs = { selection: { kind: 'smart', id: 'today' }, collapsed: [], expanded: [], showAll: false, defaultTagId: null }

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS
  } catch {
    return DEFAULT_PREFS
  }
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)) } catch { /* 本机存不了就算了 */ }
}

/** 「今天」跟着时钟走：过了午夜自动换日 */
function useToday(): string {
  const [today, setToday] = useState(() => toDateKey(new Date()))
  useEffect(() => {
    const t = window.setInterval(() => setToday(toDateKey(new Date())), 60_000)
    return () => window.clearInterval(t)
  }, [])
  return today
}

export default function ChecklistView({ palette, onPaletteChange, onPlanNodesChange }: ChecklistViewProps) {
  const data = useChecklist(onPlanNodesChange)
  const today = useToday()
  const tree = useMemo(() => buildListTree(palette), [palette])
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  // 主面板窄的时候（左栏 + 详情会把任务区挤没），详情改成盖在任务区上的抽屉
  const wrapRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < DOCK_MIN_WIDTH))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => { savePrefs(prefs) }, [prefs])
  const patchPrefs = useCallback((patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })), [])

  // 选中的清单被删掉了（或标签改名）：退回「今天」
  const selection: ChecklistSelection = prefs.selection.kind === 'list' && palette.tags.length > 0 && !findListNode(tree, prefs.selection.key)
    ? { kind: 'smart', id: 'today' }
    : prefs.selection

  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed])
  const expanded = useMemo(() => new Set(prefs.expanded), [prefs.expanded])

  const tagCounts = useMemo(() => {
    const map = new Map<number, number>()
    for (const n of data.nodes) if (n.status === 'active') map.set(n.projectTagId, (map.get(n.projectTagId) ?? 0) + 1)
    return map
  }, [data.nodes])

  const smartCounts = useMemo<Record<SmartView, number>>(() => ({
    today: todayTasks(data.nodes, today).length,
    week: weekGroups(data.nodes, today).reduce((s, g) => s + g.tasks.length, 0),
    all: data.nodes.filter((n) => n.status === 'active').length,
    done: data.nodes.filter((n) => n.status === 'done').length,
  }), [data.nodes, today])

  // 选中的任务被删了就清掉详情
  useEffect(() => {
    if (selectedTaskId != null && !data.nodes.some((n) => n.id === selectedTaskId)) setSelectedTaskId(null)
  }, [data.nodes, selectedTaskId])

  const createList = useCallback(async (parent: ListNode, name: string) => {
    try {
      const tag = await addActivityTag(parent.categoryId, `${parent.fullPath},${name}`)
      onPaletteChange()
      patchPrefs({
        selection: { kind: 'list', key: `${parent.key}/${name}` },
        defaultTagId: tag.id,
        expanded: [...new Set([...prefs.expanded, parent.key])],
      })
    } catch (e) {
      console.error('[Checklist] 新建清单失败', e)
    }
  }, [onPaletteChange, patchPrefs, prefs.expanded])

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', height: '100%', minHeight: 0 }}>
      <ListSidebar
        tree={tree}
        selection={selection}
        onSelect={(sel) => { patchPrefs({ selection: sel }); setSelectedTaskId(null) }}
        smartCounts={smartCounts}
        tagCounts={tagCounts}
        expanded={expanded}
        onToggleExpand={(key) => patchPrefs({ expanded: expanded.has(key) ? prefs.expanded.filter((k) => k !== key) : [...prefs.expanded, key] })}
        showAll={prefs.showAll}
        onToggleShowAll={() => patchPrefs({ showAll: !prefs.showAll })}
        onCreateList={createList}
      />
      <TaskBoard
        data={data}
        palette={palette}
        tree={tree}
        selection={selection}
        today={today}
        selectedTaskId={selectedTaskId}
        onSelectTask={setSelectedTaskId}
        collapsed={collapsed}
        onSetCollapsed={(id, c) => patchPrefs({ collapsed: c ? [...new Set([...prefs.collapsed, id])] : prefs.collapsed.filter((x) => x !== id) })}
        defaultTagId={prefs.defaultTagId}
        onDefaultTagChange={(tagId) => patchPrefs({ defaultTagId: tagId })}
      />
      {/* 详情：只在选中任务时出现 */}
      {selectedTaskId != null && (
        <div className={narrow ? 'pt-detail-drawer' : undefined} style={narrow ? undefined : { display: 'flex', minHeight: 0 }}>
          <TaskDetail
            data={data}
            palette={palette}
            taskId={selectedTaskId}
            today={today}
            onSelectTask={setSelectedTaskId}
          />
        </div>
      )}
    </div>
  )
}
