// ══════════════════════════════════════════════
// Session Picker — 历史会话侧栏（docked，不遮挡聊天面板）
// 停靠在聊天面板左侧，点击切换不关闭，可删除旧会话
// 钛板侧抽屉：和其它弹层同一套材质
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, Pencil, Plus, RefreshCw, Search, X, Trash2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { theme, tiSurface, ti, tiInput, tiTitle } from '../theme'
import Tooltip from './Tooltip'
import DockCoupler, { useDockAnchor, type DockPhase } from './ui/DockCoupler'
import type { ChatSessionInfo, SessionSearchHit } from '../lib/agent/agent-memory'
import { searchChatSessions, fetchSessionMessages, patchSession } from '../lib/agent/agent-memory'
import { generateSessionTitle } from '../lib/ai/session-title'
import { loadConfig } from '../lib/agent/agent-config'
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
  /** 重命名/重新生成标题后让父级重拉会话列表 */
  readonly onRefresh?: (changedSessionId?: string) => void
  /** 抽屉动画阶段：open = 滑出并上锁；closing = 退锁并缩回（父级播完再卸载） */
  readonly phase?: DockPhase
}

/** 抽屉宽度：比通讯栏窄一档（历史列表不需要那么宽） */
const DRAWER_W = 272
/** 只切左边两个角：右边是接缝，贴着通讯栏 */
const DRAWER_CLIP = 'polygon(12px 0, 100% 0, 100% 100%, 12px 100%, 0 calc(100% - 12px), 0 12px)'
/** 宿主：右侧通讯栏那块钛板（带 data-chassis 的才是板本身，抽屉自己也挂着 right-panel-hud 借滚动条样式） */
const HOST_SELECTOR = '[data-chassis].right-panel-hud'


export default function SessionPicker({
  sessions, currentSessionId, dockRight = 340, onSelect, onNewSession, onDelete, onClose, onRefresh,
  phase = 'open',
}: Props) {
  const anchor = useDockAnchor(HOST_SELECTOR)
  const [query, setQuery] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // 右键菜单 + 行内重命名 + 重新起标题进行中（Set：多个会话可并发重新起标题，互不顶掉状态）
  const [menu, setMenu] = useState<{ x: number; y: number; session: ChatSessionInfo } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [regenIds, setRegenIds] = useState<ReadonlySet<string>>(new Set())
  const [models, setModels] = useState<ModelDef[]>([])
  const [freeQuotas, setFreeQuotas] = useState<ModelFreeQuota[]>([])
  const [titleModel, setTitleModel] = useState('qwen3.6-flash')
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
          getFeatureModel('session_title', 'qwen3.6-flash'),
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
    const textModels = models.filter((m) => m.category === 'text' && m.provider !== 'anthropic')
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

  // 右键菜单：点击任意处 / Esc / 再次右键 关闭
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  const commitRename = useCallback(async (id: string, raw: string) => {
    setEditingId(null)
    const title = raw.trim()
    if (!title) return
    try {
      await patchSession(id, { title })
      onRefresh?.(id)
    } catch (e) {
      console.error('[SessionPicker] 重命名失败', e)
    }
  }, [onRefresh])

  const regenTitle = useCallback(async (s: ChatSessionInfo) => {
    setMenu(null)
    let alreadyRunning = false
    setRegenIds((prev) => {
      if (prev.has(s.id)) { alreadyRunning = true; return prev }
      const next = new Set(prev)
      next.add(s.id)
      return next
    })
    if (alreadyRunning) return
    try {
      const msgs = await fetchSessionMessages(s.id)
      if (msgs.length === 0) return
      const title = await generateSessionTitle(msgs, loadConfig())
      if (title) {
        await patchSession(s.id, { title })
        onRefresh?.(s.id)
      }
    } catch (e) {
      console.error('[SessionPicker] 重新生成标题失败', e)
    } finally {
      setRegenIds((prev) => {
        const next = new Set(prev)
        next.delete(s.id)
        return next
      })
    }
  }, [onRefresh])

  // 抽屉贴在通讯栏左边缘上；量不到宿主时退回旧的停靠参数
  const dock: React.CSSProperties = anchor
    ? { left: anchor.seamX - DRAWER_W, top: anchor.top, height: anchor.height }
    : { right: dockRight, top: 52, bottom: 0 }

  return (
    <>
    {/* 外壳：右边缘就是接缝，overflow 裁掉越过接缝的部分 → 抽屉看起来是从通讯栏背后抽出来的 */}
    <div style={{
      position: 'fixed',
      ...dock,
      width: DRAWER_W,
      overflow: 'hidden',
      zIndex: 100,
      pointerEvents: phase === 'closing' ? 'none' : undefined,
      filter: 'drop-shadow(-10px 0 18px rgba(0,0,0,0.55))',
    }}>
    <div
      // right-panel-hud：借用右栏注入的 HUD 滚动条样式（同色细滚动条）
      className="session-picker-root right-panel-hud"
      data-phase={phase}
      style={{
        position: 'relative',
        height: '100%',
        display: 'flex', flexDirection: 'column',
        background: tiSurface.plate,
        clipPath: DRAWER_CLIP,
        // 右沿压一道阴影：通讯栏的板压在抽屉上面
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset -12px 0 14px -10px rgba(0,0,0,0.85)',
        fontFamily: theme.fontBody,
        overflow: 'hidden',
      }}
    >

      {/* Header：菱形 + 粗斜体标题 + 点阵计数 + 收起键 */}
      <div style={{
        position: 'relative', zIndex: 1,
        padding: '14px 14px 10px',
        display: 'flex', alignItems: 'center', gap: 8,
        flexShrink: 0,
      }}>
        <span className="ti-diamond" aria-hidden />
        <span style={{ ...tiTitle, fontSize: 14 }}>历史会话</span>
        <span className="ti-well" style={{ padding: '2px 7px', borderRadius: 4 }}>
          <span className="ti-led" style={{ fontSize: 11 }}>
            {searching ? '···' : `${filtered.length}/${sessions.length}`}
          </span>
        </span>
        <span style={{ flex: 1 }} />
        <Tooltip content="收起 (Esc)">
          <button type="button" className="ti-key" onClick={onClose} aria-label="收起" style={{ width: 26, height: 26, padding: 0 }}>
            <X size={13} />
          </button>
        </Tooltip>
      </div>
      <div className="ti-groove-h" style={{ margin: '0 14px 10px', flexShrink: 0 }} />

      {/* Search */}
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', alignItems: 'center', gap: 6,
        margin: '0 14px',
        padding: '6px 10px',
        ...tiInput,
        flexShrink: 0,
      }}>
        <Search size={12} style={{ color: theme.textMuted, flexShrink: 0 }} />
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
        <div className="ti-label" style={{ fontSize: 10.5 }}>
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
            type="button"
            className="ti-key ti-key-primary"
            onClick={onNewSession}
            style={{ flexShrink: 0, gap: 5, padding: '0 12px', fontSize: 12, whiteSpace: 'nowrap' }}
          >
            <Plus size={13} strokeWidth={2.6} />
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
            editing={editingId === hit.session.id}
            regenerating={regenIds.has(hit.session.id)}
            onClick={() => onSelect(hit.session.id)}
            onJumpToSnippet={(timestamp) => onSelect(hit.session.id, timestamp)}
            onRequestDelete={() => setConfirmId(hit.session.id)}
            onConfirmDelete={() => { onDelete(hit.session.id); setConfirmId(null) }}
            onCancelDelete={() => setConfirmId(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({
                x: Math.min(e.clientX, window.innerWidth - 170),
                y: Math.min(e.clientY, window.innerHeight - 130),
                session: hit.session,
              })
            }}
            onCommitRename={(title) => void commitRename(hit.session.id, title)}
            onCancelRename={() => setEditingId(null)}
          />
        ))}
      </div>

      {/* 右键菜单（portal 到 body，避免被面板 overflow 裁剪）*/}
      {menu && createPortal(
        <div
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            zIndex: 3000,
            minWidth: 152,
            padding: 4,
            background: tiSurface.plate,
            borderRadius: 6,
            boxShadow: tiSurface.popShadow,
            fontFamily: theme.fontBody,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <ContextMenuItem
            icon={<Pencil size={12} />}
            label="重命名"
            onClick={() => { setEditingId(menu.session.id); setMenu(null) }}
          />
          <ContextMenuItem
            icon={<RefreshCw size={12} />}
            label="重新生成标题"
            onClick={() => { void regenTitle(menu.session) }}
          />
          <div className="ti-groove-h" style={{ margin: '4px 6px' }} />
          <ContextMenuItem
            icon={<Trash2 size={12} />}
            label="删除"
            danger
            onClick={() => { setConfirmId(menu.session.id); setMenu(null) }}
          />
        </div>,
        document.body,
      )}
    </div>
    </div>
    {anchor && <DockCoupler anchor={anchor} phase={phase} />}
    </>
  )
}

function ContextMenuItem({ icon, label, danger, onClick }: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  onClick: () => void
}) {
  const color = danger ? theme.dangerRed : theme.textPrimary
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        color,
        fontSize: 11.5,
        fontFamily: theme.fontBody,
        letterSpacing: 0.5,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.12s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? `${theme.dangerRed}1E` : 'rgba(255,255,255,0.07)'
      }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {icon}
      {label}
    </button>
  )
}

function SessionRow({
  session, snippets, highlight, active, confirming, editing, regenerating,
  onClick, onJumpToSnippet, onRequestDelete, onConfirmDelete, onCancelDelete,
  onContextMenu, onCommitRename, onCancelRename,
}: {
  session: ChatSessionInfo
  snippets: readonly { role: string; excerpt: string; timestamp: string }[]
  highlight: string
  active: boolean
  confirming: boolean
  editing: boolean
  regenerating: boolean
  onClick: () => void
  onJumpToSnippet: (timestamp: string) => void
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onCommitRename: (title: string) => void
  onCancelRename: () => void
}) {
  const updated = formatRelativeTime(session.updated_at)
  const title = session.title?.trim() || '未命名会话'
  const preview = session.summary?.trim() || ''

  // 行内重命名只触发一次提交：Enter/Esc 后 unmount 的 blur 不能再 commit
  const renameDoneRef = useRef(false)
  useEffect(() => { if (editing) renameDoneRef.current = false }, [editing])
  const finishRename = (value: string) => {
    if (renameDoneRef.current) return
    renameDoneRef.current = true
    const t = value.trim()
    if (!t || t === title) onCancelRename()
    else onCommitRename(t)
  }

  return (
    <div
      className="session-row"
      onClick={confirming || editing ? undefined : onClick}
      onContextMenu={onContextMenu}
      style={{
        position: 'relative',
        padding: '9px 14px 9px 12px',
        borderBottom: '1px solid rgba(0,0,0,0.88)',
        boxShadow: '0 1px 0 rgba(255,255,255,0.1)',
        cursor: confirming ? 'default' : 'pointer',
        background: active ? 'rgba(255,255,255,0.06)' : undefined,
        borderLeft: active ? `3px solid ${ti.led}` : '3px solid transparent',
      }}
    >
      {confirming ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, fontSize: 11.5, color: theme.dangerRed, fontWeight: 700 }}>
            删除 "{title.slice(0, 12)}"?
          </span>
          <button
            type="button"
            className="ti-key"
            onClick={(e) => { e.stopPropagation(); onConfirmDelete() }}
            style={{ height: 24, padding: '0 10px', fontSize: 11.5, color: theme.dangerRed }}
          >删除</button>
          <button
            type="button"
            className="ti-key"
            onClick={(e) => { e.stopPropagation(); onCancelDelete() }}
            style={{ height: 24, padding: '0 10px', fontSize: 11.5 }}
          >取消</button>
        </div>
      ) : (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: preview || snippets.length > 0 ? 2 : 0,
          }}>
            {editing ? (
              <input
                autoFocus
                defaultValue={title}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') finishRename((e.target as HTMLInputElement).value)
                  if (e.key === 'Escape') { renameDoneRef.current = true; onCancelRename() }
                }}
                onBlur={(e) => finishRename(e.target.value)}
                style={{
                  flex: 1, minWidth: 0,
                  fontSize: 12, fontWeight: 600,
                  fontFamily: theme.fontBody,
                  ...tiInput,
                  boxShadow: `${tiSurface.wellShadow}, 0 0 0 1px ${ti.led}88`,
                  padding: '2px 6px',
                }}
              />
            ) : (
              <div style={{
                flex: 1, minWidth: 0,
                fontSize: 12, fontWeight: 600,
                color: theme.textPrimary,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                opacity: regenerating ? 0.45 : 1,
              }}>
                {regenerating
                  ? '重新起标题中…'
                  : <Highlight text={title} keyword={highlight} />}
              </div>
            )}
            <div style={{
              fontSize: 11, color: theme.textMuted,
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
                      background: tiSurface.well,
                      border: 'none',
                      borderRadius: 4,
                      boxShadow: tiSurface.wellShadow,
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
                    {/* 谁说的：前面一颗小方灯（你 = 信号橙 / Fairy = 冰蓝），不画左侧竖线 */}
                    <span style={{
                      display: 'inline-block', width: 5, height: 5, borderRadius: 1, marginRight: 5, verticalAlign: 1,
                      background: snip.role === 'user' ? ti.led : ti.sys,
                    }} />
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
          background: ti.led,
          color: '#0B0A09',
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
