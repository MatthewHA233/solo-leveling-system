// 清单里的一行任务（钛合金机体语言，不用左侧竖线）
//   层级 = 左边逐层的刻槽导轨；行与行 = 刻线；选中 = 整行凸起成一块小钛片
//   勾选框 = 下沉小槽（圈色 = 优先级）；右侧读数 = 黑玻璃小窗（日期 / 子任务进度）+ 优先级 LED

import { memo, useEffect, useRef } from 'react'
import { Check, ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react'
import type { PlanNode } from '../../../types'
import { theme } from '../../../theme'
import { dueLabel } from './model'

/** 优先级颜色：高 = 红、中 = 琥珀、低 = 冰蓝、无 = 钛灰 */
export const PRIORITY_COLOR = ['#7A756E', '#9ED8F2', '#F0B25A', '#FF5B5B'] as const
export const PRIORITY_LABEL = ['无', '低', '中', '高'] as const

/** 每深一层多一道导轨的宽度 */
export const ROW_INDENT = 20

/** 层级导轨：每一层一道刻进板面的竖槽，上下行连成一条 */
export function Guides({ depth }: { depth: number }) {
  return <>{Array.from({ length: depth }, (_, i) => <span key={i} className="pt-guide" aria-hidden />)}</>
}

/** 日期读数：今天 / 明天用橙色中文，其余用点阵数字；逾期红 */
export function DueChip({ due, today, done }: { due: string; today: string; done: boolean }) {
  const label = dueLabel(due, today)
  const tone = done ? 'done' : due < today ? 'over' : due === today ? 'today' : 'later'
  const numeric = /^\d/.test(label) || label.includes('月')
  const text = numeric ? `${Number(due.slice(5, 7))}·${due.slice(8)}` : label
  return (
    <span className="pt-chip pt-due" data-tone={tone} data-led={numeric ? '1' : undefined} title={due}>
      {text}
    </span>
  )
}

/** 优先级：信号强度式的 3 格 LED，亮几格 = 几级 */
export function PriorityMeter({ priority }: { priority: number }) {
  if (priority <= 0) return null
  const color = PRIORITY_COLOR[priority]
  return (
    <span className="pt-meter" aria-label={`优先级 ${PRIORITY_LABEL[priority]}`} title={`优先级 · ${PRIORITY_LABEL[priority]}`}>
      {[1, 2, 3].map((lv) => (
        <span key={lv} style={{
          height: 3 + lv * 2.5,
          background: lv <= priority ? color : 'var(--ti-led-off, #3E3A36)',
          boxShadow: lv <= priority ? `0 0 5px ${color}AA` : 'none',
        }} />
      ))}
    </span>
  )
}

/** 勾选框：下沉小槽，圈色 = 优先级；勾上 = 填满钛灰 + 黑勾 */
export function CheckBox({ done, priority, size = 16, onToggle }: { done: boolean; priority: number; size?: number; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="pt-check"
      data-done={done ? '1' : undefined}
      aria-label={done ? '标记为未完成' : '标记为完成'}
      onClick={(e) => { e.stopPropagation(); onToggle() }}
      style={{ width: size, height: size, ['--ring' as string]: PRIORITY_COLOR[priority] }}
    >
      {done && <Check size={size - 5} strokeWidth={3.4} />}
    </button>
  )
}

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
      data-done={done ? '1' : undefined}
      onClick={props.onSelect}
      style={{ ['--pt-indent' as string]: `${8 + depth * ROW_INDENT + 22}px` }}
    >
      <Guides depth={depth} />

      <div className="pt-row-body">
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

        <CheckBox done={done} priority={node.priority} onToggle={props.onToggleDone} />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '6px 0' }}>
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
              className="pt-title"
              data-root={depth === 0 ? '1' : undefined}
              onClick={(e) => {
                // 已选中的行再点标题 = 改名（像改文件名）
                if (!selected) return
                e.stopPropagation()
                props.onStartEdit()
              }}
              onDoubleClick={(e) => { e.stopPropagation(); props.onStartEdit() }}
              style={{ cursor: selected ? 'text' : 'default' }}
            >
              {node.title}
            </span>
          )}
          {context && !editing && <span className="pt-context">{context}</span>}
        </div>

        {/* 右侧读数 */}
        {!editing && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
            {props.onAddChild && (
              <button
                type="button"
                className="pt-row-add"
                aria-label="添加子任务"
                title="添加子任务"
                onClick={(e) => { e.stopPropagation(); props.onAddChild?.() }}
              >
                <Plus size={12} strokeWidth={2.6} />
              </button>
            )}
            {node.note && <FileText size={12} color={theme.textMuted} aria-label="有备注" />}
            <PriorityMeter priority={done ? 0 : node.priority} />
            {totalChildren > 0 && (
              <span className="pt-chip" data-led="1" title="子任务完成数">
                {totalChildren - openChildren}/{totalChildren}
              </span>
            )}
            {node.dueDate && <DueChip due={node.dueDate} today={today} done={done} />}
          </span>
        )}
      </div>
    </div>
  )
}

export default memo(TaskRow)
