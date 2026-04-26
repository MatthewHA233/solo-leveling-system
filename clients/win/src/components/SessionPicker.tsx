// ══════════════════════════════════════════════
// Session Picker — 历史会话侧栏（docked，不遮挡聊天面板）
// 停靠在聊天面板左侧，点击切换不关闭，可删除旧会话
// 使用 HudFrame 保持与其它 HUD 面板一致的视觉语言
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Plus, Search, X, Trash2 } from 'lucide-react'
import { theme } from '../theme'
import { HudFrame } from './hud'
import Tooltip from './Tooltip'
import type { ChatSessionInfo } from '../lib/agent/agent-memory'

interface Props {
  readonly sessions: readonly ChatSessionInfo[]
  readonly currentSessionId: string | null
  readonly dockRight?: number
  readonly onSelect: (id: string) => void
  readonly onNewSession: () => void
  readonly onDelete: (id: string) => void
  readonly onClose: () => void
}

const clip4 = `polygon(4px 0, calc(100% - 4px) 0, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0 calc(100% - 4px), 0 4px)`

export default function SessionPicker({
  sessions, currentSessionId, dockRight = 340, onSelect, onNewSession, onDelete, onClose,
}: Props) {
  const [query, setQuery] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
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

  const accent = theme.electricBlue

  return (
    <div
      className="session-picker-root"
      style={{
        position: 'fixed',
        top: 60,
        right: dockRight,
        bottom: 0,
        width: 308,
        display: 'flex', flexDirection: 'column',
        background: `
          linear-gradient(180deg, rgba(4,10,26,0.96) 0%, rgba(2,6,14,0.98) 100%)
        `,
        borderLeft: `1px solid ${accent}22`,
        boxShadow: `-8px 0 30px rgba(0,0,0,0.55), inset 0 0 40px ${accent}08`,
        fontFamily: theme.fontBody,
        zIndex: 100,
        overflow: 'hidden',
      }}
    >
      <div className="hud-scanlines" style={{ opacity: 0.35 }} />
      {/* 开灯瞬间的纵向亮闪，从左侧边切入 */}
      <div className="session-picker-edge-flash" />

      {/* 与其它 HUD 面板一致的装饰框 */}
      <HudFrame
        color={accent}
        accent={theme.warningOrange}
        topLabel="历史会话"
        bottomLabel="ARCHIVE"
        showNotchTop
        showNotchBottom
        showConnectors
        notchWidth={72}
        notchDepth={7}
        cornerSize={14}
      />

      {/* Header */}
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '18px 18px 10px',
        flexShrink: 0,
      }}>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 9.5, color: theme.textPrimary,
          fontFamily: theme.fontMono, letterSpacing: 1,
          padding: '1px 6px',
          border: `1px solid ${theme.hudFrameSoft}`,
          clipPath: clip4, WebkitClipPath: clip4,
        }}>
          {filtered.length}/{sessions.length}
        </span>
        <Tooltip content="收起 (Esc)">
        <button
          onClick={onClose}
          style={{
            background: `${accent}12`,
            border: `1px solid ${accent}55`,
            clipPath: clip4, WebkitClipPath: clip4,
            cursor: 'pointer',
            color: accent, padding: '3px 4px',
            display: 'flex', alignItems: 'center',
          }}
        >
          <X size={12} />
        </button>
        </Tooltip>
      </div>

      {/* Search */}
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', alignItems: 'center', gap: 6,
        margin: '0 14px',
        padding: '5px 10px',
        border: `1px solid ${theme.hudFrameSoft}`,
        background: 'rgba(0,229,255,0.03)',
        clipPath: clip4, WebkitClipPath: clip4,
        flexShrink: 0,
      }}>
        <Search size={11} style={{ color: theme.textPrimary, flexShrink: 0 }} />
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

      {/* New session */}
      <div style={{ position: 'relative', zIndex: 1, padding: '8px 14px 6px', flexShrink: 0 }}>
        <button
          className="hud-new-session-btn"
          onClick={onNewSession}
          style={{
            width: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '6px 10px',
            background: `linear-gradient(90deg, ${accent}20 0%, ${theme.shadowPurple}10 100%)`,
            border: `1px solid ${accent}66`,
            clipPath: clip4, WebkitClipPath: clip4,
            color: accent,
            fontSize: 11.5, fontFamily: theme.fontBody,
            fontWeight: 700, letterSpacing: 1.2,
            textShadow: `0 0 6px ${accent}AA`,
            cursor: 'pointer',
            transition: 'background 0.15s, box-shadow 0.15s',
          }}
        >
          <Plus size={12} />
          新建会话
        </button>
      </div>

      {/* List */}
      <div style={{ position: 'relative', zIndex: 1, flex: 1, overflowY: 'auto', padding: '0 2px' }}>
        {filtered.length === 0 && (
          <div style={{
            padding: '24px 12px', textAlign: 'center',
            color: theme.textMuted, fontSize: 11,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          }}>
            <MessageSquare size={18} style={{ opacity: 0.4 }} />
            {sessions.length === 0 ? '还没有历史会话' : '没有匹配的会话'}
          </div>
        )}

        {filtered.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === currentSessionId}
            confirming={confirmId === s.id}
            onClick={() => onSelect(s.id)}
            onRequestDelete={() => setConfirmId(s.id)}
            onConfirmDelete={() => { onDelete(s.id); setConfirmId(null) }}
            onCancelDelete={() => setConfirmId(null)}
          />
        ))}
      </div>
    </div>
  )
}

function SessionRow({
  session, active, confirming, onClick, onRequestDelete, onConfirmDelete, onCancelDelete,
}: {
  session: ChatSessionInfo
  active: boolean
  confirming: boolean
  onClick: () => void
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const updated = formatRelativeTime(session.updated_at)
  const title = session.title?.trim() || '未命名会话'
  const preview = session.summary?.trim() || ''

  return (
    <div
      className="session-row"
      onClick={confirming ? undefined : onClick}
      style={{
        position: 'relative',
        padding: '8px 14px',
        borderBottom: `1px solid ${theme.hudFrameSoft}`,
        cursor: confirming ? 'default' : 'pointer',
        background: active
          ? `linear-gradient(90deg, ${theme.electricBlue}1E 0%, ${theme.electricBlue}05 100%)`
          : undefined,
        borderLeft: active ? `2px solid ${theme.electricBlue}` : '2px solid transparent',
      }}
    >
      {confirming ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, fontSize: 11, color: theme.dangerRed, fontFamily: theme.fontMono, letterSpacing: 0.5 }}>
            删除 "{title.slice(0, 12)}"?
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onConfirmDelete() }}
            style={{
              padding: '3px 8px',
              fontSize: 10, fontFamily: theme.fontMono, fontWeight: 700, letterSpacing: 1,
              background: `${theme.dangerRed}22`,
              border: `1px solid ${theme.dangerRed}88`,
              color: theme.dangerRed,
              cursor: 'pointer',
              clipPath: clip4, WebkitClipPath: clip4,
            }}
          >删除</button>
          <button
            onClick={(e) => { e.stopPropagation(); onCancelDelete() }}
            style={{
              padding: '3px 8px',
              fontSize: 10, fontFamily: theme.fontMono, letterSpacing: 1,
              background: 'transparent',
              border: `1px solid ${theme.hudFrameSoft}`,
              color: theme.textPrimary,
              cursor: 'pointer',
              clipPath: clip4, WebkitClipPath: clip4,
            }}
          >取消</button>
        </div>
      ) : (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: preview ? 2 : 0,
          }}>
            <div style={{
              flex: 1, minWidth: 0,
              fontSize: 12, fontWeight: 600,
              color: active ? theme.electricBlue : theme.textPrimary,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {title}
            </div>
            <div style={{
              fontSize: 11, color: theme.textPrimary,
              fontFamily: theme.fontMono, flexShrink: 0,
            }}>
              {updated}
            </div>
            <Tooltip content="删除">
            <button
              className="session-del-btn"
              onClick={(e) => { e.stopPropagation(); onRequestDelete() }}
              style={{
                background: 'none', border: 'none', padding: 2,
                color: theme.textPrimary, cursor: 'pointer',
                display: 'flex', alignItems: 'center',
              }}
            >
              <Trash2 size={11} />
            </button>
            </Tooltip>
          </div>
          {preview && (
            <div style={{
              fontSize: 10.5, color: theme.textPrimary,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              opacity: 0.72,
            }}>
              {preview}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!isFinite(then)) return ''
  const now = Date.now()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}时前`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}天前`
  const d = new Date(iso)
  const thisYear = new Date(now).getFullYear()
  const thatYear = d.getFullYear()
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  if (thatYear === thisYear) return md
  if (thatYear === thisYear - 1) return `去年${md}`
  if (thatYear === thisYear - 2) return `前年${md}`
  return `${thatYear}年${md}`
}
