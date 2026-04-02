// ══════════════════════════════════════════════
// BiliHistoryMonitor — B站历史（虚拟滚动 + 多选 + 无限加载）
// ══════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, RefreshCw, Pause, Play, Tv2, LogIn, CheckSquare, Square, Plus } from 'lucide-react'
import { openBiliLogin, calcProgressFromDb, formatViewTime } from '../lib/bilibili/api'
import { fetchBiliHistoryDb } from '../lib/local-api'
import type { DbBiliItem } from '../lib/local-api'
import type { BiliCursor } from '../lib/bilibili/useHistory'
import { theme } from '../theme'

const ITEM_H = 88   // px，每行固定高度（字体放大后加高）
const OVERSCAN = 4  // 上下各多渲染几行
const PAGE_SIZE = 80

export interface BiliMonitorData {
  isLoading: boolean
  error: string | null
  lastUpdated: Date | null
  countdown: number
  intervalSeconds: number
  isPaused: boolean
  windowClosed: boolean
  cursor: BiliCursor | null
  hasMoreRemote: boolean
  onPause: () => void
  onResume: () => void
  onRefresh: () => void
  onLoadOlderHistory: () => Promise<void>
  onSetInterval: (s: number) => void
  onAddToActivity: (items: DbBiliItem[]) => Promise<void>
}

interface Props extends BiliMonitorData {
  dbStatus: 'loading' | 'live' | 'error'
  onClose: () => void
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const color = pct >= 95 ? theme.expGreen : pct >= 50 ? '#faad14' : theme.electricBlue
  return (
    <div style={{ width: '100%', height: 2, background: 'rgba(255,255,255,0.08)', borderRadius: 2, marginTop: 3 }}>
      <div style={{ height: 2, borderRadius: 2, width: `${pct}%`, background: color }} />
    </div>
  )
}

export default function BiliHistoryMonitor({
  isLoading, error, lastUpdated, countdown, intervalSeconds, isPaused,
  windowClosed, cursor, hasMoreRemote, dbStatus,
  onPause, onResume, onRefresh, onLoadOlderHistory, onSetInterval,
  onAddToActivity, onClose,
}: Props) {
  const [items, setItems] = useState<DbBiliItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [unlinkedOnly, setUnlinkedOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [isOpening, setIsOpening] = useState(false)

  // 虚拟滚动
  const containerRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)          // 同步守卫，防止并发重复加载
  const [scrollTop, setScrollTop] = useState(0)
  const [containerH, setContainerH] = useState(300)

  // 监听容器高度
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setContainerH(e.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 初始加载 + filter 切换时重置
  const loadPage = useCallback(async (p: number, reset: boolean) => {
    if (p === 0 && !reset) return
    try {
      const result = await fetchBiliHistoryDb(p, PAGE_SIZE, unlinkedOnly)
      setTotal(result.total)
      setItems((prev) => {
        const merged = reset ? result.items : [...prev, ...result.items]
        // 去重兜底：bvid 是主键，任何情况下不应出现重复
        const seen = new Set<string>()
        return merged.filter((item) => {
          if (seen.has(item.bvid)) return false
          seen.add(item.bvid)
          return true
        })
      })
      setPage(p)
    } catch { /* ignore */ }
  }, [unlinkedOnly])

  // 后端就绪后才加载，避免 ERR_CONNECTION_REFUSED
  useEffect(() => {
    if (dbStatus === 'live') loadPage(0, true)
  }, [loadPage, dbStatus])

  // 同步后刷新列表（轮询每次 lastUpdated 变化）
  useEffect(() => {
    if (lastUpdated && dbStatus === 'live') loadPage(0, true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUpdated])

  // 触发从 B站 API 拉取更旧记录
  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder) return
    setLoadingOlder(true)
    try { await onLoadOlderHistory() }
    finally { setLoadingOlder(false) }
  }, [loadingOlder, onLoadOlderHistory])

  // 滚动触底：先加载 DB 更多页，DB 耗尽后触发 B站 API 拉取
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - ITEM_H * 3

    if (nearBottom && items.length < total && !loadingRef.current) {
      // 还有本地 DB 分页未加载
      loadingRef.current = true
      setLoadingMore(true)
      loadPage(page + 1, false).finally(() => {
        loadingRef.current = false
        setLoadingMore(false)
      })
    } else if (nearBottom && items.length >= total && hasMoreRemote && !loadingOlder) {
      // DB 已全部加载，向 B站 API 拉取更旧历史
      handleLoadOlder()
    }
  }, [items.length, total, page, loadPage, hasMoreRemote, loadingOlder, handleLoadOlder])

  // 虚拟滚动窗口
  const visibleStart = Math.max(0, Math.floor(scrollTop / ITEM_H) - OVERSCAN)
  const visibleEnd   = Math.min(items.length, Math.ceil((scrollTop + containerH) / ITEM_H) + OVERSCAN)

  // 选择操作
  const toggleSelect = (bvid: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(bvid) ? next.delete(bvid) : next.add(bvid)
      return next
    })
  }
  const selectAllUnlinked = () => {
    const bvids = items.filter((i) => !i.event_id).map((i) => i.bvid)
    setSelected(new Set(bvids))
  }
  const clearSelection = () => setSelected(new Set())

  const handleAddToActivity = async () => {
    const toAdd = items.filter((i) => selected.has(i.bvid))
    if (toAdd.length === 0) return
    setAdding(true)
    try {
      await onAddToActivity(toAdd)
      setSelected(new Set())
      await loadPage(0, true)
    } catch { /* ignore */ } finally {
      setAdding(false)
    }
  }

  const handleOpenLogin = async () => {
    setLoginError(null); setIsOpening(true)
    try { await openBiliLogin() }
    catch (e) { setLoginError(e instanceof Error ? e.message : String(e)) }
    finally { setIsOpening(false) }
  }

  const unlinkedInView = items.filter((i) => !i.event_id).length
  const hasMore = items.length < total

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: theme.background, overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: `1px solid ${theme.divider}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Tv2 size={14} style={{ color: theme.electricBlue }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: theme.electricBlue, letterSpacing: 0.5 }}>B站历史浏览记录</span>
          {isLoading && <span style={{ fontSize: 11, color: theme.textMuted }}>同步中…</span>}
          <span style={{ fontSize: 11, color: theme.textMuted }}>{total > 0 ? `${total} 条` : ''}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <button onClick={isPaused ? onResume : onPause} style={iconBtn} title={isPaused ? '继续' : '暂停'}>
            {isPaused ? <Play size={12} /> : <Pause size={12} />}
          </button>
          <button onClick={() => { onRefresh(); loadPage(0, true) }} style={iconBtn} title="立即同步"><RefreshCw size={12} /></button>
          <button onClick={onClose} style={iconBtn} title="关闭"><X size={13} /></button>
        </div>
      </div>

      {/* 登录 + 状态行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: `1px solid ${theme.divider}`, flexShrink: 0 }}>
        <button
          disabled={isOpening}
          onClick={handleOpenLogin}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: windowClosed ? `${theme.electricBlue}18` : 'rgba(255,255,255,0.04)',
            border: `1px solid ${loginError ? theme.dangerRed : windowClosed ? theme.electricBlue : theme.glassBorder}`,
            borderRadius: 3, padding: '4px 8px',
            color: loginError ? theme.dangerRed : windowClosed ? theme.electricBlue : theme.textSecondary,
            cursor: 'pointer', fontSize: 10, fontFamily: theme.fontBody, opacity: isOpening ? 0.6 : 1,
          }}
        >
          <LogIn size={11} />
          {isOpening ? '打开中…' : windowClosed ? '重新登录' : 'B站浏览器'}
        </button>
        <span style={{ fontSize: 11, color: loginError ? theme.dangerRed : theme.textMuted, flex: 1 }}>
          {loginError ?? (windowClosed ? '窗口已关闭' : isPaused ? '已暂停' : lastUpdated ? `${countdown}s 后同步` : '等待首次同步')}
        </span>
        {/* 每 N 秒刷新 */}
        <select
          value={intervalSeconds}
          onChange={(e) => onSetInterval(Number(e.target.value))}
          style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${theme.glassBorder}`, borderRadius: 2, color: theme.textSecondary, fontSize: 11, padding: '2px 4px', cursor: 'pointer' }}
        >
          <option value={30}>30s</option>
          <option value={60}>1min</option>
          <option value={120}>2min</option>
          <option value={300}>5min</option>
        </select>
      </div>

      {/* 工具栏：筛选 + 多选操作 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderBottom: `1px solid ${theme.divider}`, flexShrink: 0 }}>
        <button
          onClick={() => { setUnlinkedOnly(!unlinkedOnly); setSelected(new Set()) }}
          style={{
            ...smallBtn,
            background: unlinkedOnly ? `${theme.electricBlue}20` : 'transparent',
            color: unlinkedOnly ? theme.electricBlue : theme.textSecondary,
            border: `1px solid ${unlinkedOnly ? theme.electricBlue + '50' : theme.glassBorder}`,
          }}
        >
          未入档
        </button>
        <button onClick={selectAllUnlinked} style={{ ...smallBtn, color: theme.textSecondary }}>
          全选未入档
        </button>
        {selected.size > 0 && (
          <>
            <span style={{ fontSize: 11, color: theme.textMuted }}>已选 {selected.size}</span>
            <button onClick={clearSelection} style={{ ...smallBtn, color: theme.textMuted }}>清除</button>
            <button
              disabled={adding}
              onClick={handleAddToActivity}
              style={{
                ...smallBtn,
                background: `${theme.expGreen}20`,
                color: theme.expGreen,
                border: `1px solid ${theme.expGreen}50`,
                opacity: adding ? 0.6 : 1,
              }}
            >
              <Plus size={11} style={{ marginRight: 2 }} />
              {adding ? '写入中…' : '加入活动'}
            </button>
          </>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: theme.textMuted }}>
          {unlinkedInView > 0 ? `${unlinkedInView} 条未入档` : ''}
        </span>
      </div>

      {/* 虚拟列表容器 */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', position: 'relative' }}
      >
        {error === 'BILI_NOT_LOGGED_IN' ? (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#faad14', marginBottom: 6 }}>未登录 B站</div>
            <div style={{ fontSize: 11, color: theme.textMuted }}>点击「B站浏览器」完成登录</div>
          </div>
        ) : error ? (
          <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 12, color: theme.dangerRed }}>{error}</div>
        ) : dbStatus !== 'live' ? (
          <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12, color: theme.textMuted }}>
            后端连接中…
          </div>
        ) : items.length === 0 && !isLoading ? (
          <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12, color: theme.textMuted }}>
            {unlinkedOnly ? '没有未加入活动的记录' : '暂无历史记录，等待首次同步…'}
          </div>
        ) : (
          <>
            {/* 撑开总高度 */}
            <div style={{ height: items.length * ITEM_H + (hasMore || hasMoreRemote ? ITEM_H : 0), position: 'relative' }}>
              {items.slice(visibleStart, visibleEnd).map((item, idx) => {
                const realIdx = visibleStart + idx
                const isSelected = selected.has(item.bvid)
                const linked = !!item.event_id
                const progress = item.progress === -1 ? 1 : item.duration > 0 ? Math.min(1, item.progress / item.duration) : 0
                const isDone = progress >= 0.95
                return (
                  <div
                    key={item.bvid}
                    onClick={() => toggleSelect(item.bvid)}
                    style={{
                      position: 'absolute', top: realIdx * ITEM_H, left: 0, right: 0,
                      height: ITEM_H, display: 'flex', gap: 8, padding: '8px 12px',
                      borderBottom: `1px solid ${theme.divider}`,
                      background: isSelected ? `${theme.electricBlue}12` : 'transparent',
                      cursor: 'pointer', boxSizing: 'border-box', alignItems: 'flex-start',
                    }}
                  >
                    {/* 勾选框 */}
                    <div style={{ flexShrink: 0, marginTop: 2, color: isSelected ? theme.electricBlue : theme.textMuted }}>
                      {isSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                    </div>
                    {/* 封面 */}
                    <img
                      src={`http://localhost:3000/api/bilibili/cover?url=${encodeURIComponent(item.cover)}`}
                      alt=""
                      style={{ width: 66, height: 42, borderRadius: 2, objectFit: 'cover', flexShrink: 0, border: `1px solid ${theme.glassBorder}` }}
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                    {/* 内容 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                        {linked ? (
                          <span style={{ fontSize: 10, background: `${theme.expGreen}25`, color: theme.expGreen, padding: '1px 5px', borderRadius: 2, flexShrink: 0, fontWeight: 600 }}>已入档</span>
                        ) : (
                          <span style={{ fontSize: 10, background: 'rgba(255,255,255,0.06)', color: theme.textMuted, padding: '1px 5px', borderRadius: 2, flexShrink: 0 }}>未入档</span>
                        )}
                        <span style={{ fontSize: 12, color: theme.textPrimary, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
                          {item.title}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: theme.textSecondary, marginBottom: 3 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{item.author_name}</span>
                        <span style={{ flexShrink: 0, color: isDone ? theme.expGreen : theme.textSecondary }}>
                          {isDone ? '已看完' : `${Math.round(progress * 100)}%`} · {formatViewTime(item.view_at)}
                        </span>
                      </div>
                      <ProgressBar value={progress} />
                    </div>
                  </div>
                )
              })}
              {/* 底部提示行 */}
              {(hasMore || hasMoreRemote) && (
                <div style={{
                  position: 'absolute', top: items.length * ITEM_H, left: 0, right: 0,
                  height: ITEM_H, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, color: theme.textMuted,
                }}>
                  {loadingMore || loadingOlder
                    ? '加载中…'
                    : hasMore
                      ? `还有 ${total - items.length} 条，继续下滑`
                      : hasMoreRemote
                        ? '继续下滑，从 B站 加载更旧记录'
                        : null}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* 底栏 */}
      <div style={{ padding: '6px 12px', borderTop: `1px solid ${theme.divider}`, fontSize: 11, color: theme.textMuted, flexShrink: 0, display: 'flex', justifyContent: 'space-between' }}>
        <span>关闭面板后后台继续同步</span>
        {cursor && <span>最旧记录: {formatViewTime(cursor.viewAt)}</span>}
      </div>
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: theme.textSecondary,
  cursor: 'pointer', padding: '3px', display: 'flex', alignItems: 'center', borderRadius: 3,
}

const smallBtn: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${theme.glassBorder}`,
  borderRadius: 3, padding: '3px 8px', fontSize: 11,
  cursor: 'pointer', display: 'flex', alignItems: 'center', fontFamily: 'inherit',
}
