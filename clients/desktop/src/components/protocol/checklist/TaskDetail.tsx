// 协议志 · 清单右栏：选中任务的详情——标题、日期、优先级、所在清单、备注、子任务、删除

import { useEffect, useMemo, useState } from 'react'
import { Check, Trash2, X } from 'lucide-react'
import type { ActivityPalette, PlanPriority } from '../../../types'
import { theme, ti, tiInput } from '../../../theme'
import HudSelect from '../../HudSelect'
import ConfirmDialog from '../../ConfirmDialog'
import { PRIORITY_COLOR, PRIORITY_LABEL } from './TaskRow'
import type { ChecklistData } from './use-checklist'
import { addDays, ancestorTitles, childrenIndex, dueLabel, subtreeIds } from './model'

export interface TaskDetailProps {
  readonly data: ChecklistData
  readonly palette: ActivityPalette
  readonly taskId: number | null
  readonly today: string
  readonly onSelectTask: (id: number | null) => void
}

/** 下周一 */
function nextMonday(today: string): string {
  const [y, m, d] = today.split('-').map(Number)
  const dow = new Date(y, m - 1, d).getDay()
  return addDays(today, ((8 - dow) % 7) || 7)
}

const label = (text: string) => (
  <div style={{ fontSize: 11, fontWeight: 800, color: theme.textSecondary, letterSpacing: '0.1em', marginBottom: 6 }}>{text}</div>
)

export default function TaskDetail({ data, palette, taskId, today, onSelectTask }: TaskDetailProps) {
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n] as const)), [data.nodes])
  const index = useMemo(() => childrenIndex(data.nodes.filter((n) => n.status !== 'archived')), [data.nodes])
  const node = taskId != null ? byId.get(taskId) ?? null : null
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 换了任务（或外面改了它）就同步输入框
  useEffect(() => {
    setTitle(node?.title ?? '')
    setNote(node?.note ?? '')
  }, [node?.id, node?.title, node?.note])

  const tagOptions = useMemo(() => [...palette.tags]
    .sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'zh-Hans-CN'))
    .map((t) => ({ value: String(t.id), label: t.fullPath.split(',').join(' › ') })), [palette.tags])

  if (!node) {
    return (
      <div style={shellStyle}>
        <div style={{ margin: 'auto', padding: 24, textAlign: 'center', color: theme.textMuted, fontSize: 12.5, lineHeight: 1.8 }}>
          点一条任务，在这里看详情、<br />定日期和优先级、写备注
        </div>
      </div>
    )
  }

  const kids = index.get(node.id) ?? []
  const done = node.status === 'done'
  const descendantCount = subtreeIds(index, node.id).length - 1
  const crumbs = ancestorTitles(byId, node)

  const saveTitle = () => {
    const t = title.trim()
    if (!t) { setTitle(node.title); return }
    if (t !== node.title) void data.update(node.id, { title: t })
  }
  const saveNote = () => {
    if ((note.trim() || null) !== (node.note ?? null)) void data.update(node.id, { note: note.trim() || null })
  }
  const setDue = (due: string | null) => void data.update(node.id, { dueDate: due })
  const dueChoices: { label: string; value: string }[] = [
    { label: '今天', value: today },
    { label: '明天', value: addDays(today, 1) },
    { label: '下周一', value: nextMonday(today) },
  ]

  return (
    <div style={shellStyle}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 标题行 */}
        <div>
          {crumbs.length > 0 && (
            <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {crumbs.join(' › ')}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <button
              type="button"
              aria-label={done ? '标记为未完成' : '标记为完成'}
              onClick={() => void data.update(node.id, { status: done ? 'active' : 'done' })}
              style={{
                width: 20, height: 20, marginTop: 3, flexShrink: 0, padding: 0, cursor: 'pointer', borderRadius: 5,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: `1.5px solid ${done ? theme.textMuted : PRIORITY_COLOR[node.priority]}`,
                background: done ? theme.textMuted : 'transparent', color: '#0B0A09',
              }}
            >
              {done && <Check size={13} strokeWidth={3.2} />}
            </button>
            <textarea
              value={title}
              rows={1}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur() } }}
              style={{
                flex: 1, minWidth: 0, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
                color: done ? theme.textMuted : theme.textPrimary, textDecoration: done ? 'line-through' : 'none',
                fontFamily: theme.fontBody, fontSize: 16, fontWeight: 800, lineHeight: 1.45, fieldSizing: 'content',
              } as React.CSSProperties}
            />
          </div>
        </div>

        {/* 日期 */}
        <div>
          {label('日期')}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {dueChoices.map((c) => (
              <button key={c.label} type="button" className="ti-key" data-active={node.dueDate === c.value ? '1' : undefined}
                onClick={() => setDue(node.dueDate === c.value ? null : c.value)} style={{ height: 26, padding: '0 10px', fontSize: 12 }}>
                {c.label}
              </button>
            ))}
            <input
              type="date"
              value={node.dueDate ?? ''}
              onChange={(e) => setDue(e.target.value || null)}
              style={{ ...tiInput, height: 26, padding: '0 8px', fontSize: 12, fontFamily: theme.fontMono, colorScheme: 'dark' }}
            />
            {node.dueDate && (
              <button type="button" className="ti-key" aria-label="清除日期" onClick={() => setDue(null)} style={{ width: 26, height: 26 }}>
                <X size={12} />
              </button>
            )}
          </div>
          {node.dueDate && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: node.dueDate < today && !done ? '#FF6B5B' : theme.textSecondary }}>
              {dueLabel(node.dueDate, today)}{node.dueDate < today && !done ? ' · 已逾期' : ''}
            </div>
          )}
        </div>

        {/* 优先级 */}
        <div>
          {label('优先级')}
          <div className="ti-well" style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 5 }}>
            {([0, 1, 2, 3] as PlanPriority[]).map((p) => {
              const on = node.priority === p
              return (
                <button key={p} type="button" className="dn-seg" aria-pressed={on}
                  onClick={() => void data.update(node.id, { priority: p })}
                  style={{
                    height: 24, padding: '0 12px', border: 'none', borderRadius: 4, cursor: 'pointer',
                    fontFamily: theme.fontBody, fontSize: 12, fontWeight: on ? 900 : 600,
                    color: on ? '#140A04' : theme.textSecondary,
                    background: on ? `linear-gradient(180deg, rgba(255,255,255,0.38), rgba(255,255,255,0) 65%), ${p === 0 ? '#A8A39C' : PRIORITY_COLOR[p]}` : 'transparent',
                  }}>
                  {PRIORITY_LABEL[p]}
                </button>
              )
            })}
          </div>
        </div>

        {/* 所在清单 */}
        <div>
          {label('清单')}
          <HudSelect
            value={String(node.projectTagId)}
            options={tagOptions}
            popupWidth={320}
            onChange={(v) => {
              const tagId = Number(v)
              if (tagId === node.projectTagId) return
              // 换清单：整棵子树搬过去，挂到新清单顶层末尾
              const roots = (index.get(null) ?? []).filter((n) => n.projectTagId === tagId)
              void data.move(node.id, { projectTagId: tagId, parentId: null, index: roots.length })
            }}
          />
          {descendantCount > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, color: theme.textMuted }}>换清单时 {descendantCount} 个子任务会一起搬过去</div>
          )}
        </div>

        {/* 备注 */}
        <div>
          {label('备注')}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            placeholder="想法、链接、拆解思路……"
            rows={5}
            style={{ ...tiInput, width: '100%', resize: 'vertical', padding: '8px 10px', fontFamily: theme.fontBody, fontSize: 12.5, lineHeight: 1.6 }}
          />
        </div>

        {/* 子任务 */}
        <div>
          {label(`子任务${kids.length ? ` · ${kids.filter((k) => k.status === 'done').length}/${kids.length}` : ''}`)}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {kids.map((k) => (
              <div key={k.id} className="pt-row" onClick={() => onSelectTask(k.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, padding: '0 8px', borderRadius: 4 }}>
                <button type="button" aria-label="勾选"
                  onClick={(e) => { e.stopPropagation(); void data.update(k.id, { status: k.status === 'done' ? 'active' : 'done' }) }}
                  style={{
                    width: 14, height: 14, flexShrink: 0, padding: 0, cursor: 'pointer', borderRadius: 3,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    border: `1.5px solid ${k.status === 'done' ? theme.textMuted : PRIORITY_COLOR[k.priority]}`,
                    background: k.status === 'done' ? theme.textMuted : 'transparent', color: '#0B0A09',
                  }}>
                  {k.status === 'done' && <Check size={10} strokeWidth={3.2} />}
                </button>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: k.status === 'done' ? theme.textMuted : theme.textPrimary, textDecoration: k.status === 'done' ? 'line-through' : 'none' }}>
                  {k.title}
                </span>
              </div>
            ))}
            <input
              className="pt-inline-input"
              placeholder="+ 添加子任务，回车保存"
              style={{ marginTop: 4 }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.key !== 'Enter') return
                const t = e.currentTarget.value.trim()
                if (!t) return
                const input = e.currentTarget
                void data.add(node.projectTagId, t, node.id).then((n) => { if (n) input.value = '' })
              }}
            />
          </div>
        </div>
      </div>

      {/* 底部：时间 + 删除 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', flexShrink: 0,
        borderTop: '1px solid rgba(0,0,0,0.88)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
      }}>
        <span style={{ flex: 1, fontSize: 10.5, color: theme.textMuted, fontFamily: theme.fontMono }}>
          建于 {node.createdAt.slice(0, 16).replace('T', ' ')}
          {node.completedAt && <span style={{ color: ti.ok }}> · 完成于 {node.completedAt.slice(0, 16).replace('T', ' ')}</span>}
        </span>
        <button type="button" className="ti-key" aria-label="删除任务"
          onClick={() => (descendantCount > 0 ? setConfirmDelete(true) : (onSelectTask(null), void data.remove(node.id)))}
          style={{ height: 28, padding: '0 10px', gap: 5, color: theme.dangerRed, fontSize: 12 }}>
          <Trash2 size={13} /> 删除
        </button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="删除任务"
        danger
        question={`删除「${node.title}」？`}
        details={[`它下面的 ${descendantCount} 个子任务会一起删掉；排在昼夜表上的计划块也会清掉。`]}
        confirmLabel="删除"
        onConfirm={() => { setConfirmDelete(false); onSelectTask(null); void data.remove(node.id) }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}

const shellStyle: React.CSSProperties = {
  width: 310, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0,
  background: 'rgba(0,0,0,0.16)',
  borderLeft: '1px solid rgba(0,0,0,0.88)',
  boxShadow: 'inset 1px 0 0 rgba(255,255,255,0.1)',
}
