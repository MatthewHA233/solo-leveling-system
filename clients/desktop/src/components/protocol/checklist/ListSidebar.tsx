// 协议志 · 清单左栏：智能视图（今天 / 最近 7 天 / 全部 / 已完成）+ 多层清单树（= 项目标签路径）
// 标签很多（几百个），默认只露有任务的清单；「显示全部标签」打开后才铺满，好往新清单里加任务

import { useMemo, useState } from 'react'
import { CalendarDays, ChevronDown, ChevronRight, CircleCheck, Eye, EyeOff, Layers, Plus, Sun } from 'lucide-react'
import { theme, ti } from '../../../theme'
import Tooltip from '../../Tooltip'
import { SMART_VIEWS, type ChecklistSelection, type ListNode, type SmartView } from './model'

const SMART_ICON: Record<SmartView, typeof Sun> = { today: Sun, week: CalendarDays, all: Layers, done: CircleCheck }

export interface ListSidebarProps {
  readonly tree: readonly ListNode[]
  readonly selection: ChecklistSelection
  readonly onSelect: (sel: ChecklistSelection) => void
  readonly smartCounts: Readonly<Record<SmartView, number>>
  /** 每个标签下未完成的任务数 */
  readonly tagCounts: ReadonlyMap<number, number>
  readonly expanded: ReadonlySet<string>
  readonly onToggleExpand: (key: string) => void
  readonly showAll: boolean
  readonly onToggleShowAll: () => void
  /** 在某个清单下面建子清单（= 新建一个项目标签） */
  readonly onCreateList: (parent: ListNode, name: string) => Promise<void>
}

export default function ListSidebar(props: ListSidebarProps) {
  const { tree, selection, tagCounts, expanded, showAll } = props
  const [creatingUnder, setCreatingUnder] = useState<string | null>(null)
  const selectedKey = selection.kind === 'list' ? selection.key : null

  // 每个节点（含子清单）的任务数
  const counts = useMemo(() => {
    const map = new Map<string, number>()
    const walk = (n: ListNode): number => {
      const total = (n.tagId != null ? tagCounts.get(n.tagId) ?? 0 : 0) + n.children.reduce((s, c) => s + walk(c), 0)
      map.set(n.key, total)
      return total
    }
    tree.forEach(walk)
    return map
  }, [tree, tagCounts])

  // 不展开全部时：有任务的、选中的（及其祖先）、正在新建子清单的才露出来
  const visible = (n: ListNode) =>
    showAll
    || (counts.get(n.key) ?? 0) > 0
    || n.depth === 0
    || (selectedKey != null && (selectedKey === n.key || selectedKey.startsWith(`${n.key}/`)))
    || creatingUnder === n.key

  const renderNode = (n: ListNode): React.ReactNode => {
    const kids = n.children.filter(visible)
    const open = expanded.has(n.key) || (selectedKey?.startsWith(`${n.key}/`) ?? false)
    const count = counts.get(n.key) ?? 0
    const selected = selectedKey === n.key
    return (
      <div key={n.key}>
        <div
          className="pt-list-row"
          data-selected={selected ? '1' : undefined}
          onClick={() => props.onSelect({ kind: 'list', key: n.key })}
          style={{ paddingLeft: 6 + n.depth * 14 }}
        >
          <span style={{ width: 14, flexShrink: 0, display: 'inline-flex', justifyContent: 'center' }}>
            {kids.length > 0 && (
              <button type="button" className="pt-caret" aria-label={open ? '收起' : '展开'}
                onClick={(e) => { e.stopPropagation(); props.onToggleExpand(n.key) }}>
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            )}
          </span>
          <span style={{
            width: n.depth === 0 ? 8 : 5, height: n.depth === 0 ? 8 : 5, borderRadius: 2, flexShrink: 0,
            background: n.color, opacity: n.depth === 0 ? 1 : 0.7,
          }} />
          <span style={{
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: n.depth === 0 ? 13 : 12.5, fontWeight: n.depth === 0 ? 800 : 500,
            color: selected ? theme.textPrimary : n.depth === 0 ? theme.textPrimary : theme.textSecondary,
          }}>
            {n.label}
          </span>
          <Tooltip content="在这里建子清单">
            <button type="button" className="pt-row-add" aria-label="新建子清单"
              onClick={(e) => { e.stopPropagation(); setCreatingUnder(n.key); if (!open) props.onToggleExpand(n.key) }}>
              <Plus size={11} strokeWidth={2.6} />
            </button>
          </Tooltip>
          {count > 0 && <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: selected ? ti.led : theme.textMuted, minWidth: 14, textAlign: 'right' }}>{count}</span>}
        </div>
        {creatingUnder === n.key && (
          <div style={{ paddingLeft: 6 + (n.depth + 1) * 14 + 20, paddingRight: 6, margin: '2px 0 4px' }}>
            <input
              autoFocus
              className="pt-inline-input"
              placeholder="子清单名称，回车建好"
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Escape') setCreatingUnder(null)
                if (e.key === 'Enter') {
                  const name = e.currentTarget.value.trim().replace(/[,，]/g, ' ')
                  if (!name) { setCreatingUnder(null); return }
                  void props.onCreateList(n, name).then(() => setCreatingUnder(null))
                }
              }}
              onBlur={() => setCreatingUnder(null)}
            />
          </div>
        )}
        {open && kids.map(renderNode)}
      </div>
    )
  }

  return (
    <div style={{
      width: 228, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0,
      background: 'rgba(0,0,0,0.2)',
      borderRight: '1px solid rgba(0,0,0,0.88)',
      boxShadow: '1px 0 0 rgba(255,255,255,0.1)',
    }}>
      <div style={{ padding: '12px 8px 8px', display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
        {SMART_VIEWS.map((v) => {
          const Icon = SMART_ICON[v.id]
          const selected = selection.kind === 'smart' && selection.id === v.id
          const count = props.smartCounts[v.id]
          return (
            <div key={v.id} className="pt-list-row" data-selected={selected ? '1' : undefined}
              onClick={() => props.onSelect({ kind: 'smart', id: v.id })} style={{ paddingLeft: 10, height: 32 }}>
              <Icon size={14} color={selected ? ti.led : theme.textSecondary} />
              <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: theme.textPrimary }}>{v.label}</span>
              {count > 0 && v.id !== 'done' && (
                <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: v.id === 'today' ? ti.led : theme.textMuted }}>{count}</span>
              )}
            </div>
          )
        })}
      </div>

      <div className="ti-groove-h" style={{ margin: '0 10px', flexShrink: 0 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px 6px', flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: theme.textSecondary, letterSpacing: '0.12em' }}>清单</span>
        <span style={{ flex: 1 }} />
        <Tooltip content={showAll ? '只看有任务的清单' : '显示全部标签（好往新清单里加任务）'}>
          <button type="button" className="ti-key" data-active={showAll ? '1' : undefined}
            onClick={props.onToggleShowAll} aria-label="显示全部标签" style={{ width: 24, height: 22 }}>
            {showAll ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        </Tooltip>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 16px' }}>
        {tree.map(renderNode)}
      </div>
    </div>
  )
}
