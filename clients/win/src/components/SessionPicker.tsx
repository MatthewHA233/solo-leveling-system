// ══════════════════════════════════════════════
// Session Picker — 历史会话选择器（Modal）
// 列出最近会话、简单模糊搜索、点击切换
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Plus, Search, X } from 'lucide-react'
import { theme } from '../theme'
import type { ChatSessionInfo } from '../lib/agent/agent-memory'

interface Props {
  readonly sessions: readonly ChatSessionInfo[]
  readonly currentSessionId: string | null
  readonly onSelect: (id: string) => void
  readonly onNewSession: () => void
  readonly onClose: () => void
}

export default function SessionPicker({
  sessions, currentSessionId, onSelect, onNewSession, onClose,
}: Props) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => {
      const t = s.title?.toLowerCase() ?? ''
      const sm = s.summary?.toLowerCase() ?? ''
      return t.includes(q) || sm.includes(q)
    })
  }, [sessions, query])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: theme.fontBody,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 92vw)', maxHeight: '72vh',
          display: 'flex', flexDirection: 'column',
          background: theme.panel,
          border: `1px solid ${theme.glassBorder}`,
          borderRadius: 10,
          boxShadow: `0 0 28px ${theme.electricBlue}22`,
          overflow: 'hidden',
        }}
      >
        {/* 头部 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px',
          borderBottom: `1px solid ${theme.divider}`,
        }}>
          <span style={{
            fontSize: 12, fontWeight: 700,
            fontFamily: theme.fontDisplay,
            color: theme.electricBlue, letterSpacing: 2,
            textShadow: `0 0 8px ${theme.electricBlue}60`,
          }}>
            历史会话
          </span>
          <span style={{ fontSize: 11, color: theme.textMuted, marginLeft: 6 }}>
            {filtered.length} / {sessions.length}
          </span>
          <button
            onClick={onClose}
            title="关闭 (Esc)"
            style={{
              marginLeft: 'auto',
              background: 'none', border: 'none', cursor: 'pointer',
              color: theme.textMuted, padding: 2,
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={14} />
          </button>
        </div>

        {/* 搜索框 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px',
          borderBottom: `1px solid ${theme.divider}`,
        }}>
          <Search size={13} style={{ color: theme.textMuted, flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题或摘要..."
            style={{
              flex: 1, background: 'transparent', border: 'none',
              color: theme.textPrimary, fontFamily: theme.fontBody,
              fontSize: 12, outline: 'none',
            }}
          />
        </div>

        {/* 新建按钮 */}
        <div style={{ padding: '6px 8px', borderBottom: `1px solid ${theme.divider}` }}>
          <button
            onClick={onNewSession}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 10px',
              background: 'rgba(0,229,255,0.08)',
              border: `1px dashed ${theme.electricBlue}55`,
              borderRadius: 6,
              color: theme.electricBlue,
              fontSize: 12, fontFamily: theme.fontBody,
              cursor: 'pointer',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,229,255,0.14)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0,229,255,0.08)')}
          >
            <Plus size={13} />
            新建会话
          </button>
        </div>

        {/* 列表 */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.length === 0 && (
            <div style={{
              padding: '32px 16px', textAlign: 'center',
              color: theme.textMuted, fontSize: 12,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            }}>
              <MessageSquare size={22} style={{ opacity: 0.4 }} />
              {sessions.length === 0 ? '还没有历史会话' : '没有匹配的会话'}
            </div>
          )}

          {filtered.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === currentSessionId}
              onClick={() => { onSelect(s.id); onClose() }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function SessionRow({
  session, active, onClick,
}: {
  session: ChatSessionInfo
  active: boolean
  onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const updated = formatRelativeTime(session.updated_at)
  const title = session.title?.trim() || '未命名会话'
  const preview = session.summary?.trim() || ''

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '10px 14px',
        borderBottom: `1px solid ${theme.divider}`,
        cursor: 'pointer',
        background: active
          ? 'rgba(0,229,255,0.10)'
          : hover ? 'rgba(255,255,255,0.03)' : 'transparent',
        borderLeft: active ? `2px solid ${theme.electricBlue}` : '2px solid transparent',
        transition: 'background 0.15s',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: preview ? 3 : 0,
      }}>
        <div style={{
          flex: 1, minWidth: 0,
          fontSize: 13, fontWeight: 600,
          color: active ? theme.electricBlue : theme.textPrimary,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
        <div style={{
          fontSize: 10, color: theme.textMuted,
          fontFamily: theme.fontMono, flexShrink: 0,
        }}>
          {updated}
        </div>
      </div>
      {preview && (
        <div style={{
          fontSize: 11, color: theme.textSecondary,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          opacity: 0.7,
        }}>
          {preview}
        </div>
      )}
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!isFinite(then)) return ''
  const diffMs = Date.now() - then
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} 小时前`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay} 天前`
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
