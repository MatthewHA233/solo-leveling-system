// ══════════════════════════════════════════════
// ActivityFormPanel — 活动添加 / 编辑面板
// ══════════════════════════════════════════════

import { useState, useEffect } from 'react'
import { X, ArrowRight, Plus, Trash2 } from 'lucide-react'
import type { ChronosActivity, ChronosEvent } from '../types'
import { theme, categoryColors, categoryLabels } from '../theme'

interface Props {
  mode: 'add' | 'edit'
  initialActivity?: ChronosActivity
  initialStartMinute?: number
  initialEndMinute?: number
  pushedStart?: number | null
  pushedEnd?: number | null
  pushedVersion?: number
  onTimeChange?: (startMinute: number, endMinute: number) => void
  onSave: (activity: Omit<ChronosActivity, 'id'>) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}

// ── 时间工具 ──

function minutesToTime(m: number): string {
  const clamped = Math.max(0, Math.min(1439, m))
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function fmtDuration(mins: number): string {
  if (!isFinite(mins) || mins <= 0) return '--'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// ── 常量 ──

const CATEGORIES = Object.keys(categoryColors)
const QUICK_DURATIONS = [15, 30, 60, 90, 120]

// ── 迷你时间轴预览 ──

function MiniTimeline({ startMinute, endMinute, category }: {
  startMinute: number
  endMinute: number
  category: string
}) {
  const color = categoryColors[category] ?? theme.textSecondary
  const nowPct = (new Date().getHours() * 60 + new Date().getMinutes()) / 1440 * 100
  const hasTime = isFinite(startMinute) && isFinite(endMinute) && endMinute > startMinute
  const startPct = startMinute / 1440 * 100
  const widthPct = Math.max(0.5, (endMinute - startMinute) / 1440 * 100)

  return (
    <div style={{ position: 'relative', height: 12, background: 'rgba(255,255,255,0.04)', borderRadius: 3, overflow: 'hidden' }}>
      {[6, 12, 18].map(h => (
        <div key={h} style={{
          position: 'absolute', left: `${h / 24 * 100}%`, top: 0,
          width: 1, height: '100%', background: 'rgba(255,255,255,0.08)',
        }} />
      ))}
      {hasTime && (
        <div style={{
          position: 'absolute', top: 2, height: 8, borderRadius: 2,
          left: `${startPct}%`, width: `${widthPct}%`,
          background: `linear-gradient(90deg, ${color}cc, ${color})`,
          boxShadow: `0 0 8px ${color}66`,
          transition: 'all 0.2s ease',
        }} />
      )}
      {!hasTime && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          fontSize: 10, color: theme.textMuted, whiteSpace: 'nowrap',
          fontFamily: theme.fontBody,
        }}>
          未选择时间段
        </div>
      )}
      <div style={{
        position: 'absolute', top: 0,
        left: `${nowPct}%`, width: 1, height: '100%', background: '#00ffff55',
      }} />
    </div>
  )
}

// ── Section Label ──

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
    }}>
      <div style={{ width: 2, height: 12, background: theme.electricBlue, borderRadius: 1, flexShrink: 0 }} />
      <span style={{
        fontSize: 10, fontWeight: 600, fontFamily: theme.fontBody,
        color: theme.textSecondary, letterSpacing: 2,
        textTransform: 'uppercase',
      }}>
        {children}
      </span>
    </div>
  )
}

// ── 主组件 ──

export default function ActivityFormPanel({
  mode, initialActivity, initialStartMinute = 480, initialEndMinute,
  pushedStart, pushedEnd, pushedVersion = 0,
  onTimeChange, onSave, onDelete, onClose,
}: Props) {
  const init = initialActivity
  const defaultEnd = Math.min((init?.endMinute ?? initialEndMinute ?? initialStartMinute + 60), 1440)

  const [title, setTitle] = useState(init?.title ?? '')
  const [category, setCategory] = useState(init?.category ?? 'coding')
  const [startTime, setStartTime] = useState(minutesToTime(init?.startMinute ?? initialStartMinute))
  const [endTime, setEndTime] = useState(minutesToTime(defaultEnd))
  const [goalAlignment, setGoalAlignment] = useState(init?.goalAlignment ?? '')
  const [events, setEvents] = useState<Omit<ChronosEvent, 'id'>[]>(
    init?.events.map(e => ({ minute: e.minute, label: e.label, title: e.title })) ?? []
  )
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (pushedVersion === 0) return
    if (pushedStart == null) {
      setStartTime('')
      setEndTime('')
    } else {
      setStartTime(minutesToTime(pushedStart))
      setEndTime(minutesToTime(Math.min(pushedEnd ?? pushedStart + 60, 1440)))
    }
  }, [pushedVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  const startMinute = startTime ? timeToMinutes(startTime) : NaN
  const endMinute = endTime ? timeToMinutes(endTime) : NaN
  const duration = endMinute - startMinute

  const applyDuration = (mins: number) => {
    if (!startTime) return
    const s = timeToMinutes(startTime)
    const e = Math.min(s + mins, 1440)
    setEndTime(minutesToTime(e))
    onTimeChange?.(s, e)
  }

  const addEvent = () => {
    const evMin = events.length > 0
      ? Math.min(events[events.length - 1].minute + 15, endMinute - 5)
      : startMinute
    setEvents(prev => [...prev, { minute: Math.max(evMin, startMinute), label: String(prev.length + 1), title: '' }])
  }

  const updateEvent = (i: number, field: 'minute' | 'title', val: string | number) => {
    setEvents(prev => prev.map((e, idx) => idx === i ? { ...e, [field]: val } : e))
  }

  const removeEvent = (i: number) => {
    setEvents(prev => prev.filter((_, idx) => idx !== i).map((e, idx) => ({ ...e, label: String(idx + 1) })))
  }

  const handleSave = async () => {
    if (!title.trim()) { setError('请输入活动名称'); return }
    if (!startTime || !endTime) { setError('请选择时间段'); return }
    if (duration <= 0) { setError('结束时间必须晚于开始时间'); return }
    setSaving(true)
    setError('')
    try {
      await onSave({
        title: title.trim(),
        category,
        startMinute,
        endMinute,
        goalAlignment: goalAlignment.trim() || undefined,
        events: events.map((e, i) => ({ ...e, id: `event-${i}`, label: String(i + 1) })),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    try {
      await onDelete()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const color = categoryColors[category] ?? theme.textSecondary

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontFamily: theme.fontBody }}>
      <style>{`
        .act-input:focus { border-color: ${theme.electricBlue}66 !important; box-shadow: 0 0 0 2px ${theme.electricBlue}18; }
        .act-time-input:focus { border-color: ${theme.electricBlue}66 !important; }
        .cat-btn:hover { transform: translateY(-1px); }
        .chip-btn:hover { border-color: ${theme.electricBlue}60 !important; color: ${theme.textPrimary} !important; }
        .action-btn:hover:not(:disabled) { background: rgba(255,255,255,0.06) !important; }
      `}</style>

      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 16px', flexShrink: 0,
        borderBottom: `1px solid ${theme.divider}`,
        background: `linear-gradient(90deg, ${color}08, transparent)`,
      }}>
        <div style={{ width: 3, height: 18, background: color, borderRadius: 2, flexShrink: 0,
          boxShadow: `0 0 6px ${color}` }} />
        <span style={{
          fontSize: 11, fontWeight: 700, fontFamily: theme.fontBody,
          color: theme.textSecondary, letterSpacing: 2, textTransform: 'uppercase', flex: 1,
        }}>
          {mode === 'add' ? '新建活动' : '编辑活动'}
        </span>
        {duration > 0 && (
          <span style={{
            fontSize: 11, fontWeight: 700, fontFamily: theme.fontMono,
            color: theme.expGreen,
            background: `${theme.expGreen}12`,
            padding: '2px 8px', borderRadius: 3,
            border: `1px solid ${theme.expGreen}30`,
            letterSpacing: 0.5,
          }}>
            {fmtDuration(duration)}
          </span>
        )}
        <button onClick={onClose} style={{
          background: 'none', border: 'none',
          color: theme.textMuted, cursor: 'pointer',
          padding: '2px', lineHeight: 1, display: 'flex',
          transition: 'color 0.15s',
        }}><X size={14} /></button>
      </div>

      {/* ── Form Body ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 18 }}>

        {/* 迷你时间轴 */}
        <MiniTimeline startMinute={startMinute} endMinute={endMinute} category={category} />

        {/* 标题 */}
        <input
          className="act-input"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="活动名称..."
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose() }}
          style={{
            width: '100%', background: 'transparent',
            border: 'none', borderBottom: `2px solid ${color}44`,
            color: theme.textPrimary, fontSize: 16, fontWeight: 600,
            fontFamily: theme.fontBody,
            padding: '4px 0', outline: 'none', boxSizing: 'border-box',
            transition: 'border-color 0.2s',
          }}
        />

        {/* 时间段 */}
        <div>
          <SectionLabel>时间段</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="time" value={startTime} placeholder="--:--"
              className="act-time-input"
              onChange={e => {
                setStartTime(e.target.value)
                if (e.target.value && endTime) onTimeChange?.(timeToMinutes(e.target.value), timeToMinutes(endTime))
              }}
              style={timeInputStyle} />
            <ArrowRight size={12} style={{ color: theme.textMuted, flexShrink: 0 }} />
            <input type="time" value={endTime} placeholder="--:--"
              className="act-time-input"
              onChange={e => {
                setEndTime(e.target.value)
                if (startTime && e.target.value) onTimeChange?.(timeToMinutes(startTime), timeToMinutes(e.target.value))
              }}
              style={timeInputStyle} />
          </div>
          {/* 快速时长 */}
          <div style={{ display: 'flex', gap: 5, marginTop: 10, flexWrap: 'wrap' }}>
            {QUICK_DURATIONS.map(d => (
              <button key={d} className="chip-btn" onClick={() => applyDuration(d)}
                style={{
                  ...chipStyle,
                  borderColor: duration === d ? `${theme.electricBlue}80` : `${theme.electricBlue}20`,
                  color: duration === d ? theme.electricBlue : theme.textSecondary,
                  background: duration === d ? `${theme.electricBlue}12` : 'transparent',
                  fontWeight: duration === d ? 600 : 400,
                }}>
                {d < 60 ? `${d}m` : `${d / 60}h`}
              </button>
            ))}
          </div>
        </div>

        {/* 分类 */}
        <div>
          <SectionLabel>分类</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
            {CATEGORIES.map(cat => {
              const c = categoryColors[cat]
              const selected = category === cat
              return (
                <button key={cat} className="cat-btn" onClick={() => setCategory(cat)}
                  style={{
                    background: selected ? `${c}18` : 'transparent',
                    border: `1px solid ${selected ? c + '99' : c + '22'}`,
                    borderRadius: 5, padding: '6px 4px',
                    color: selected ? c : `${c}99`,
                    fontSize: 11, fontWeight: selected ? 600 : 400,
                    cursor: 'pointer',
                    fontFamily: theme.fontBody,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                    transition: 'all 0.15s',
                    boxShadow: selected ? `0 0 8px ${c}22` : undefined,
                  }}>
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: selected ? c : `${c}44`, flexShrink: 0,
                    boxShadow: selected ? `0 0 4px ${c}` : undefined,
                  }} />
                  {categoryLabels[cat]}
                </button>
              )
            })}
          </div>
        </div>

        {/* 目标关联 */}
        <div>
          <SectionLabel>目标关联 <span style={{ color: theme.textMuted, letterSpacing: 0 }}>（可选）</span></SectionLabel>
          <input
            className="act-input"
            value={goalAlignment}
            onChange={e => setGoalAlignment(e.target.value)}
            placeholder="关联到哪个目标..."
            style={textInputStyle}
          />
        </div>

        {/* 事件 */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
              <div style={{ width: 2, height: 12, background: theme.electricBlue, borderRadius: 1 }} />
              <span style={{ fontSize: 10, fontWeight: 600, fontFamily: theme.fontBody, color: theme.textSecondary, letterSpacing: 2, textTransform: 'uppercase' }}>
                事件
              </span>
            </div>
            <button className="chip-btn" onClick={addEvent}
              style={{ ...chipStyle, padding: '3px 10px', color: theme.electricBlue, borderColor: `${theme.electricBlue}40`, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Plus size={11} /> 添加
            </button>
          </div>
          {events.length === 0 && (
            <div style={{ fontSize: 12, color: theme.textMuted, textAlign: 'center', padding: '8px 0', fontFamily: theme.fontBody }}>
              — 暂无事件 —
            </div>
          )}
          {events.map((ev, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 7 }}>
              <span style={{ fontSize: 11, color: color, minWidth: 16, textAlign: 'right', fontFamily: theme.fontMono }}>{ev.label}</span>
              <input type="time" value={minutesToTime(ev.minute)}
                className="act-time-input"
                onChange={e => updateEvent(i, 'minute', timeToMinutes(e.target.value))}
                style={{ ...timeInputStyle, flex: '0 0 90px', fontSize: 11 }} />
              <input value={ev.title}
                className="act-input"
                onChange={e => updateEvent(i, 'title', e.target.value)}
                placeholder="描述..."
                style={{ ...textInputStyle, flex: 1 }} />
              <button onClick={() => removeEvent(i)}
                style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', padding: '2px', lineHeight: 1, display: 'flex', transition: 'color 0.15s' }}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        {error && (
          <div style={{
            fontSize: 12, color: theme.dangerRed, fontFamily: theme.fontBody,
            padding: '6px 10px', background: `${theme.dangerRed}0e`, borderRadius: 4,
            border: `1px solid ${theme.dangerRed}33`,
          }}>
            {error}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{
        padding: '10px 16px', borderTop: `1px solid ${theme.divider}`,
        display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center',
      }}>
        {mode === 'edit' && onDelete && (
          <button className="action-btn" onClick={handleDelete} disabled={deleting}
            style={{
              ...actionBtnStyle,
              borderColor: confirmDelete ? theme.dangerRed : `${theme.dangerRed}35`,
              color: confirmDelete ? theme.dangerRed : `${theme.dangerRed}77`,
              background: confirmDelete ? `${theme.dangerRed}0e` : 'transparent',
            }}>
            {deleting ? '…' : confirmDelete
              ? <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Trash2 size={12} /> 确认删除</span>
              : <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Trash2 size={12} /> 删除</span>
            }
          </button>
        )}
        {confirmDelete && (
          <button className="action-btn" onClick={() => setConfirmDelete(false)} style={actionBtnStyle}>
            取消
          </button>
        )}
        <div style={{ flex: 1 }} />
        {!confirmDelete && (
          <>
            <button className="action-btn" onClick={onClose} style={actionBtnStyle}>取消</button>
            <button className="action-btn" onClick={handleSave} disabled={saving}
              style={{
                ...actionBtnStyle,
                borderColor: `${color}80`, color: color,
                background: `${color}0e`,
                fontWeight: 600,
              }}>
              {saving ? '…' : mode === 'add' ? '创建' : '更新'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ── 样式常量 ──

const timeInputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: `1px solid ${theme.glassBorder}`,
  borderRadius: 4, color: theme.textPrimary,
  padding: '5px 8px', fontFamily: theme.fontMono,
  fontSize: 12, outline: 'none', colorScheme: 'dark',
  transition: 'border-color 0.2s, box-shadow 0.2s',
}

const textInputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: `1px solid ${theme.glassBorder}`,
  borderRadius: 4, color: theme.textPrimary,
  padding: '5px 10px', fontFamily: theme.fontBody,
  fontSize: 12, outline: 'none', width: '100%',
  boxSizing: 'border-box',
  transition: 'border-color 0.2s, box-shadow 0.2s',
}

const chipStyle: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${theme.glassBorder}`,
  borderRadius: 4, padding: '3px 10px',
  color: theme.textSecondary, fontFamily: theme.fontBody,
  fontSize: 11, cursor: 'pointer',
  transition: 'all 0.15s',
}

const actionBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${theme.glassBorder}`,
  borderRadius: 4, color: theme.textSecondary,
  padding: '6px 16px', fontFamily: theme.fontBody,
  fontSize: 12, cursor: 'pointer',
  transition: 'all 0.15s',
}
