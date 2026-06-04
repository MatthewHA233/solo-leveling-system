// ══════════════════════════════════════════════
// Session Picker — 历史会话侧栏（docked，不遮挡聊天面板）
// 停靠在聊天面板左侧，点击切换不关闭，可删除旧会话
// 使用 HudFrame 保持与其它 HUD 面板一致的视觉语言
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Plus, Search, X, Trash2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { theme } from '../theme'
import { HudFrame } from './hud'
import Tooltip from './Tooltip'
import type { ChatSessionInfo, SessionSearchHit } from '../lib/agent/agent-memory'
import { searchChatSessions } from '../lib/agent/agent-memory'
import type { ModelDef, ModelFreeQuota } from '../lib/local-api'
import { getFeatureModel, listModelFreeQuotas, setFeatureModel } from '../lib/model-audit'
import { MODEL_SELECT_POPUP_WIDTH, modelSelectOption } from '../lib/model-display'
import HudSelect from './HudSelect'

interface Props {
  readonly sessions: readonly ChatSessionInfo[]
  readonly currentSessionId: string | null
  readonly dockRight?: number
  /** jumpToTimestamp：搜索命中片段时传入，用于切会话后定位到对应气泡 */
  readonly onSelect: (id: string, jumpToTimestamp?: string) => void
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
  const [models, setModels] = useState<ModelDef[]>([])
  const [freeQuotas, setFreeQuotas] = useState<ModelFreeQuota[]>([])
  const [titleModel, setTitleModel] = useState('qwen3.5-flash')
  const [serverHits, setServerHits] = useState<SessionSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [modelRows, quotaRows, boundModel] = await Promise.all([
          invoke<ModelDef[]>('list_models'),
          listModelFreeQuotas(),
          getFeatureModel('session_title', 'qwen3.5-flash'),
        ])
        if (cancelled) return
        setModels(modelRows)
        setFreeQuotas(quotaRows)
        setTitleModel(boundModel)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onBindingUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ feature?: string; modelId?: string }>).detail
      if (detail?.feature === 'session_title' && detail.modelId) setTitleModel(detail.modelId)
    }
    window.addEventListener('model-feature-binding-updated', onBindingUpdated)
    return () => window.removeEventListener('model-feature-binding-updated', onBindingUpdated)
  }, [])

  useEffect(() => {
    const onQuotaUpdated = () => { void listModelFreeQuotas().then(setFreeQuotas).catch(() => {}) }
    window.addEventListener('model-free-quota-updated', onQuotaUpdated)
    return () => window.removeEventListener('model-free-quota-updated', onQuotaUpdated)
  }, [])

  // 服务端全文搜索：query 非空时 debounce 250ms 调 /api/sessions/search
  // （走 SQL LIKE，含 chat_messages.content 全文匹配，不只是 title/summary）
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setServerHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    setServerHits(null)
    let cancelled = false
    const timer = window.setTimeout(() => {
      searchChatSessions(q, 50)
        .then((rows) => { if (!cancelled) { setServerHits(rows); setSearching(false) } })
        .catch(() => { if (!cancelled) { setServerHits([]); setSearching(false) } })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query])

  // 搜索状态下：返回 SessionSearchHit[]（带 snippets）；否则把本地 sessions 包成 hit shape 复用 SessionRow 渲染
  const filtered = useMemo<SessionSearchHit[]>(() => {
    if (!query.trim()) return sessions.map((s) => ({ session: s, snippets: [] }))
    return serverHits ?? []
  }, [sessions, query, serverHits])

  const titleModelOptions = useMemo(() => {
    const quotaByModel = new Map(freeQuotas.map((q) => [q.model_id, q]))
    const textModels = models.filter((m) => m.category === 'text')
    return textModels.map((m) => modelSelectOption(m, quotaByModel.get(m.id)))
  }, [freeQuotas, models])

  const currentTitleModel = useMemo(() => {
    if (titleModelOptions.some((opt) => opt.value === titleModel)) return titleModel
    return titleModelOptions[0]?.value ?? titleModel
  }, [titleModel, titleModelOptions])

  const changeTitleModel = useCallback(async (modelId: string) => {
    setTitleModel(modelId)
    try {
      await setFeatureModel('session_title', modelId)
      window.dispatchEvent(new CustomEvent('model-feature-binding-updated', {
        detail: { feature: 'session_title', modelId },
      }))
    } catch {}
  }, [])

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
          {searching ? '...' : `${filtered.length}/${sessions.length}`}
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
          placeholder="搜索标题、摘要或对话内容..."
          style={{
            flex: 1, background: 'transparent', border: 'none',
            color: theme.textPrimary, fontFamily: theme.fontBody,
            fontSize: 12, outline: 'none',
            minWidth: 0,
          }}
        />
        {query && (
          <Tooltip content="清空搜索">
            <button
              onClick={() => { setQuery(''); inputRef.current?.focus() }}
              aria-label="清空搜索"
              style={{
                flexShrink: 0,
                width: 16, height: 16,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: '50%',
                background: `${theme.textMuted}28`,
                border: 'none',
                color: theme.textPrimary,
                cursor: 'pointer',
                padding: 0,
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${theme.dangerRed}55`
                e.currentTarget.style.color = '#fff'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = `${theme.textMuted}28`
                e.currentTarget.style.color = theme.textPrimary
              }}
            >
              <X size={10} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* Title model + New session 同行（label 在上，下行 [HudSelect | + 新建会话]）*/}
      <div style={{
        position: 'relative', zIndex: 1,
        margin: '8px 14px 6px',
        display: 'grid',
        gap: 5,
        flexShrink: 0,
      }}>
        <div style={{
          color: theme.textMuted,
          fontFamily: theme.fontMono,
          fontSize: 9.5,
          letterSpacing: 0.8,
        }}>
          会话总结模型
        </div>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <HudSelect
              value={currentTitleModel}
              options={titleModelOptions.length > 0 ? titleModelOptions : [{ value: currentTitleModel, label: currentTitleModel }]}
              onChange={changeTitleModel}
              popupWidth={MODEL_SELECT_POPUP_WIDTH}
            />
          </div>
          <button
            className="hud-new-session-btn"
            onClick={onNewSession}
            style={{
              flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              padding: '0 10px',
              background: `linear-gradient(90deg, ${accent}20 0%, ${theme.shadowPurple}10 100%)`,
              border: `1px solid ${accent}66`,
              clipPath: clip4, WebkitClipPath: clip4,
              color: accent,
              fontSize: 11, fontFamily: theme.fontBody,
              fontWeight: 700, letterSpacing: 1.0,
              textShadow: `0 0 6px ${accent}AA`,
              cursor: 'pointer',
              transition: 'background 0.15s, box-shadow 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            <Plus size={12} />
            新建会话
          </button>
        </div>
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

        {filtered.map((hit) => (
          <SessionRow
            key={hit.session.id}
            session={hit.session}
            snippets={hit.snippets}
            highlight={query.trim()}
            active={hit.session.id === currentSessionId}
            confirming={confirmId === hit.session.id}
            onClick={() => onSelect(hit.session.id)}
            onJumpToSnippet={(timestamp) => onSelect(hit.session.id, timestamp)}
            onRequestDelete={() => setConfirmId(hit.session.id)}
            onConfirmDelete={() => { onDelete(hit.session.id); setConfirmId(null) }}
            onCancelDelete={() => setConfirmId(null)}
          />
        ))}
      </div>
    </div>
  )
}

function SessionRow({
  session, snippets, highlight, active, confirming, onClick, onJumpToSnippet, onRequestDelete, onConfirmDelete, onCancelDelete,
}: {
  session: ChatSessionInfo
  snippets: readonly { role: string; excerpt: string; timestamp: string }[]
  highlight: string
  active: boolean
  confirming: boolean
  onClick: () => void
  onJumpToSnippet: (timestamp: string) => void
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
            marginBottom: preview || snippets.length > 0 ? 2 : 0,
          }}>
            <div style={{
              flex: 1, minWidth: 0,
              fontSize: 12, fontWeight: 600,
              color: active ? theme.electricBlue : theme.textPrimary,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              <Highlight text={title} keyword={highlight} />
            </div>
            <div style={{
              fontSize: 11, color: theme.textPrimary,
              fontFamily: theme.fontMono, flexShrink: 0,
            }}>
              {updated}
            </div>
            {!highlight && (
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
            )}
          </div>
          {preview && snippets.length === 0 && (
            <div style={{
              fontSize: 10.5, color: theme.textPrimary,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              opacity: 0.72,
            }}>
              <Highlight text={preview} keyword={highlight} />
            </div>
          )}
          {snippets.length > 0 && (
            <div style={{ marginTop: 4, display: 'grid', gap: 3 }}>
              {snippets.map((snip, idx) => (
                <Tooltip key={`${snip.timestamp}-${idx}`} content="跳转到此消息" display="block">
                  <button
                    onClick={(e) => { e.stopPropagation(); onJumpToSnippet(snip.timestamp) }}
                    style={{
                      appearance: 'none',
                      textAlign: 'left',
                      background: 'rgba(0,229,255,0.04)',
                      border: `1px solid ${theme.hudFrameSoft}`,
                      borderLeft: `2px solid ${snip.role === 'user' ? theme.electricBlue : theme.shadowPurple}`,
                      color: theme.textPrimary,
                      padding: '4px 6px',
                      fontSize: 10.5,
                      fontFamily: theme.fontBody,
                      lineHeight: 1.45,
                      cursor: 'pointer',
                      opacity: 0.92,
                      display: 'block',
                      width: '100%',
                    }}
                  >
                    <span style={{
                      color: theme.textMuted,
                      fontFamily: theme.fontMono,
                      fontSize: 9,
                      letterSpacing: 0.5,
                      marginRight: 5,
                    }}>
                      {snip.role === 'user' ? '你' : snip.role === 'assistant' ? 'Fairy' : snip.role}
                    </span>
                    <Highlight text={snip.excerpt} keyword={highlight} />
                  </button>
                </Tooltip>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Highlight({ text, keyword }: { text: string; keyword: string }) {
  const k = keyword.trim()
  if (!k) return <>{text}</>
  // 大小写不敏感切分；保留原文片段
  const lowerText = text.toLowerCase()
  const lowerK = k.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let i = lowerText.indexOf(lowerK)
  let n = 0
  while (i >= 0) {
    if (i > cursor) parts.push(text.slice(cursor, i))
    parts.push(
      <mark
        key={`m-${n++}`}
        style={{
          background: `${theme.warningOrange}40`,
          color: theme.warningOrange,
          padding: '0 1px',
          borderRadius: 2,
          fontWeight: 700,
        }}
      >
        {text.slice(i, i + k.length)}
      </mark>
    )
    cursor = i + k.length
    i = lowerText.indexOf(lowerK, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
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
