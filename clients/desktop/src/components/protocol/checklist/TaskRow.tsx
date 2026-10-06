// 清单里的一行任务：折叠箭头 · 勾选框（圈色 = 优先级）· 标题（点选中，再点改名）· 右侧日期 / 子任务进度 / 所在清单

import { memo, useEffect, useRef } from 'react'
import { Check, ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react'
import type { PlanNode } from '../../../types'
import { theme, ti } from '../../../theme'
import { dueLabel } from './model'

/** 优先级颜色：高 = 红、中 = 琥珀、低 = 冰蓝、无 = 钛灰 */
export const PRIORITY_COLOR = ['#7A756E', '#9ED8F2', '#F0B25A', '#FF5B5B'] as const
export const PRIORITY_LABEL = ['无', '低', '中', '高'] as const

export const ROW_INDENT = 20

export interface TaskRowProps {
  readonly node: PlanNode
  readonly depth: number
  readonly today: string
  readonly selected: boolean
  readonly editing: boolean
  readonly collapsed: boolean
  readonly openChildren: number
  readonly totalChildren: number
  /** 跨清单视图里显示所在清单 + 父任务面包屑 */
  readonly context?: string
  readonly onSelect: () => void
  readonly onToggleDone: () => void
  readonly onToggleCollapse: () => void
  readonly onStartEdit: () => void
  /** 不传 = 这一行不能直接加子任务（平铺视图） */
  readonly onAddChild?: () => void
  readonly onEditKey: (e: React.KeyboardEvent<HTMLInputElement>, value: string) => void
  readonly onCommitTitle: (value: string) => void
}

function TaskRow(props: TaskRowProps) {
  const { node, depth, today, selected, editing, collapsed, openChildren, totalChildren, context } = props
  const done = node.status === 'done'
  const ring = PRIORITY_COLOR[node.priority]
  const overdue = !done && node.dueDate != null && node.dueDate < today
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  return (
    <div
      className="pt-row"
      data-selected={selected ? '1' : undefined}
      onClick={props.onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        minHeight: 34,
        padding: `0 10px 0 ${8 + depth * ROW_INDENT}px`,
        borderRadius: 5,
        cursor: 'default',
      }}
    >
      {/* 折叠箭头：有子任务才有；没有时占位，保证同层对齐 */}
      <span style={{ width: 14, flexShrink: 0, display: 'inline-flex', justifyContent: 'center' }}>
        {totalChildren > 0 && (
          <button
            type="button"
            className="pt-caret"
            aria-label={collapsed ? '展开子任务' : '收起子任务'}
            onClick={(e) => { e.stopPropagation(); props.onToggleCollapse() }}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
      </span>

      <button
        type="button"
        aria-label={done ? '标记为未完成' : '标记为完成'}
        onClick={(e) => { e.stopPropagation(); props.onToggleDone() }}
        style={{
          width: 16, height: 16, flexShrink: 0, padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 4, cursor: 'pointer',
          border: `1.5px solid ${done ? theme.textMuted : ring}`,
          background: done ? theme.textMuted : node.priority > 0 ? `${ring}1F` : 'transparent',
          color: '#0B0A09',
        }}
      >
        {done && <Check size={11} strokeWidth={3.2} />}
      </button>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '5px 0' }}>
        {editing ? (
          <input
            ref={inputRef}
            defaultValue={node.title}
            className="pt-inline-input"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => props.onEditKey(e, e.currentTarget.value)}
            onBlur={(e) => props.onCommitTitle(e.currentTarget.value)}
          />
        ) : (
          <span
            onClick={(e) => {
              // 已选中的行再点标题 = 改名（像改文件名）
              if (!selected) return
              e.stopPropagation()
              props.onStartEdit()
            }}
            onDoubleClick={(e) => { e.stopPropagation(); props.onStartEdit() }}
            style={{
              fontSize: 13.5, lineHeight: 1.45,
              color: done ? theme.textMuted : theme.textPrimary,
              textDecoration: done ? 'line-through' : 'none',
              fontWeight: depth === 0 ? 600 : 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              cursor: selected ? 'text' : 'default',
            }}
          >
            {node.title}
          </span>
        )}
        {context && !editing && (
          <span style={{ fontSize: 10.5, color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {context}
          </span>
        )}
      </div>

      {/* 右侧信息 */}
      {!editing && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {props.onAddChild && (
            <button
              type="button"
              className="pt-row-add"
              aria-label="添加子任务"
              onClick={(e) => { e.stopPropagation(); props.onAddChild?.() }}
            >
              <Plus size={12} strokeWidth={2.6} />
            </button>
          )}
          {node.note && <FileText size={12} color={theme.textMuted} aria-label="有备注" />}
          {totalChildren > 0 && (
            <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: theme.textMuted }}>
              {totalChildren - openChildren}/{totalChildren}
            </span>
          )}
          {node.dueDate && (
            <span style={{
              fontSize: 11, fontWeight: 700,
              color: done ? theme.textMuted : overdue ? '#FF6B5B' : node.dueDate === today ? ti.led : theme.textSecondary,
            }}>
              {dueLabel(node.dueDate, today)}
            </span>
          )}
        </span>
      )}
    </div>
  )
}

export default memo(TaskRow)
