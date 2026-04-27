// ══════════════════════════════════════════════
// BiliHistoryDialog — B 站历史鱼线图弹窗
// 同步状态控制 + 鱼线图瀑布流：左主轴 + 时间节点 + 支线 + 卡片
// 默认所有视频都会自动入档到管线，所以无"加入活动"操作；
// 绿色高亮特权给"已下载"（看完只看进度条）
// ══════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X, RefreshCw, Pause, Play, LogIn, ChevronDown, ChevronLeft, ChevronRight, Settings, FolderOpen } from 'lucide-react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { useDataDays, hasDataOrIsToday } from '../hooks/useDataDays'
import BiliIcon from './icons/BiliIcon'
import DatePickerPopover from './DatePickerPopover'
import BiliVideoPanel from './BiliVideoPanel'
import HudSelect from './HudSelect'
import { openBiliLogin, getBiliNav, formatViewTime } from '../lib/bilibili/api'
import { fetchBiliSpans } from '../lib/local-api'
import type { BiliSpan } from '../lib/local-api'
import type { BiliCursor } from '../lib/bilibili/useHistory'
import { loadConfig, updateConfig } from '../lib/agent/agent-config'
import type { AgentConfig } from '../lib/agent/agent-config'
import { theme, hud } from '../theme'
import Tooltip from './Tooltip'

// ── 布局常量 ──
const RAIL_X = 86              // 主轴 x 坐标
const RAIL_AREA_W = 116        // 主轴占据的左侧宽度
const BRANCH_W = 18            // 支线伸出宽度
const CARD_W = 220
const CARD_GAP_X = 14          // 列间横向间隔
const CARD_GAP_Y = 58          // 行间纵向间隔（必须够宽，给走线留通道）
const CARD_TOP_PAD = 44        // 首行上方留白（要 ≥ 28 才容得下首行 col=3 的走线 lane）
const HOUR_GAP_EXTRA = 28      // 两个不同小时之间的额外间距
const CARD_H = 200
const MAX_COLS = 4             // 一行最多 4 张卡片
const GAP_DASHED_MIN = 60      // ≥1h 主轴虚线警示

interface Props {
  readonly open: boolean
  readonly initialDate: Date

  // 来自 useBiliHistory，与原 BiliHistoryMonitor 完全一致
  readonly isLoading: boolean
  readonly error: string | null
  readonly lastUpdated: Date | null
  readonly countdown: number
  readonly intervalSeconds: number
  readonly isPaused: boolean
  readonly windowClosed: boolean
  readonly cursor: BiliCursor | null
  readonly hasMoreRemote: boolean
  readonly onPause: () => void
  readonly onResume: () => void
  readonly onRefresh: () => void
  readonly onSetInterval: (s: number) => void
  readonly onClose: () => void
}

// ── 工具函数 ──
function fmtHHMM(dt: string): string {
  const s = String(dt)
  // 优先用正则提取"日期或 T 或空格之后的第一个 HH:MM"，避免把日期里的数字误当作时间
  const m1 = s.match(/[T\s](\d{1,2}):(\d{2})/)
  if (m1) return `${m1[1].padStart(2, '0')}:${m1[2]}`
  // 纯时间格式（无日期前缀）
  const m2 = s.match(/^(\d{1,2}):(\d{2})/)
  if (m2) return `${m2[1].padStart(2, '0')}:${m2[2]}`
  // 兜底：Date 解析（处理时间戳数字等）
  const d = new Date(s.includes(' ') ? s.replace(' ', 'T') : s)
  if (!isNaN(d.getTime())) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return '--:--'
}

/** 跨天前缀：返回 {prefix, time}，prefix 为 "昨" / "明" / "N天前" / "N天后" 或 null */
function fmtTimeLabel(startAt: string, dayStr: string): { prefix: string | null; time: string } {
  const time = fmtHHMM(startAt)
  const m = String(startAt).match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return { prefix: null, time }
  const startKey = `${m[1]}-${m[2]}-${m[3]}`
  if (startKey === dayStr) return { prefix: null, time }
  const startD = new Date(`${startKey}T00:00:00`)
  const dayD = new Date(`${dayStr}T00:00:00`)
  const diffDays = Math.round((dayD.getTime() - startD.getTime()) / 86400000)
  if (diffDays === 1) return { prefix: '昨', time }
  if (diffDays === -1) return { prefix: '明', time }
  if (diffDays > 0) return { prefix: `${diffDays}天前`, time }
  return { prefix: `${-diffDays}天后`, time }
}

function fmtDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—'
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}分钟`
  return `${Math.floor(m / 60)}小时${m % 60 ? `${m % 60}分钟` : ''}`
}

// → 当日相对分钟（裁剪到 [0, 1440]）；用 Date 解析容错任意格式
function dtToMinute(dt: string, dayStr: string): number {
  const d = new Date(typeof dt === 'string' && dt.includes(' ') ? dt.replace(' ', 'T') : dt)
  if (isNaN(d.getTime())) return 0
  const dKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (dKey === dayStr) return d.getHours() * 60 + d.getMinutes()
  return dKey < dayStr ? 0 : 1440
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface PlacedCard {
  span: BiliSpan
  col: number
  top: number          // 卡片（含同行同伴）的 top
  nodeY: number        // 节点在主轴上的 y（行内均匀分布，绝不溢出本行 [top, top+CARD_H]）
  cardsInRow: number   // 同一行的卡片数量
  startMin: number
}

/**
 * 按"小时桶"分组，每行只放同一小时的卡片，最多 cols 列
 * nodeY 在每行内均匀分布：top + CARD_H * (col + 1) / (N + 1)
 *   - 这样主轴节点不会"漂移"——每行只占据自己卡片那段 y 范围，
 *     底部主轴自然停在最后一行卡片范围内，不再"腾空"
 */
function layoutMasonry(spans: BiliSpan[], dayStr: string, cols: number): { placed: PlacedCard[]; height: number } {
  const sorted = [...spans].sort((a, b) => (a.start_at < b.start_at ? -1 : 1))
  const placed: PlacedCard[] = []
  let cursorY = CARD_TOP_PAD
  let prevHour = -1

  // 按小时分组
  const buckets: BiliSpan[][] = []
  for (const s of sorted) {
    const h = Math.floor(dtToMinute(s.start_at, dayStr) / 60)
    if (buckets.length === 0 || h !== Math.floor(dtToMinute(buckets[buckets.length - 1][0].start_at, dayStr) / 60)) {
      buckets.push([s])
    } else {
      buckets[buckets.length - 1].push(s)
    }
  }

  for (const bucket of buckets) {
    const hour = Math.floor(dtToMinute(bucket[0].start_at, dayStr) / 60)
    if (prevHour !== -1) cursorY += HOUR_GAP_EXTRA
    prevHour = hour

    const rowCount = Math.ceil(bucket.length / cols)
    for (let r = 0; r < rowCount; r++) {
      const rowStart = r * cols
      const rowEnd = Math.min(rowStart + cols, bucket.length)
      const cardsInRow = rowEnd - rowStart
      const top = cursorY + r * (CARD_H + CARD_GAP_Y)
      for (let i = rowStart; i < rowEnd; i++) {
        const span = bucket[i]
        const col = i - rowStart
        const startMin = dtToMinute(span.start_at, dayStr)
        const nodeY = top + (CARD_H * (col + 1)) / (cardsInRow + 1)
        placed.push({ span, col, top, nodeY, cardsInRow, startMin })
      }
    }
    cursorY = cursorY + rowCount * (CARD_H + CARD_GAP_Y) - CARD_GAP_Y
  }

  // height 严格贴合最后一行卡片底部（cursorY 就是末行 bottom），主轴只多出 8px 收尾
  const height = placed.length > 0 ? cursorY + 8 : 60
  return { placed, height }
}

// ══════════════════════════════════════════════
// 主组件
// ══════════════════════════════════════════════
export default function BiliHistoryDialog({
  open, initialDate,
  isLoading, error, lastUpdated, countdown, intervalSeconds, isPaused,
  windowClosed, cursor, hasMoreRemote: _hasMoreRemote,
  onPause, onResume, onRefresh, onSetInterval, onClose,
}: Props) {
  const [date, setDate] = useState<Date>(initialDate)
  const [spans, setSpans] = useState<BiliSpan[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchErr, setFetchErr] = useState<string | null>(null)
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [isOpening, setIsOpening] = useState(false)
  const [detailSpan, setDetailSpan] = useState<BiliSpan | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [biliUname, setBiliUname] = useState<string | null>(() => {
    try { return localStorage.getItem('bili.uname') } catch { return null }
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [config, setConfig] = useState<AgentConfig>(() => loadConfig())
  const settingsAnchorRef = useRef<HTMLButtonElement | null>(null)
  const settingsPopRef = useRef<HTMLDivElement | null>(null)
  const updateBiliConfig = useCallback((patch: Partial<AgentConfig>) => {
    setConfig((prev) => updateConfig(prev, patch))
  }, [])

  const dateAnchorRef = useRef<HTMLButtonElement | null>(null)
  const galleryRef = useRef<HTMLDivElement | null>(null)
  const galleryInnerRef = useRef<HTMLDivElement | null>(null)
  const [containerW, setContainerW] = useState(900)

  // 拉取当日 spans
  const loadSpans = useCallback(async (d: Date) => {
    setLoading(true); setFetchErr(null)
    try {
      const data = await fetchBiliSpans(d)
      setSpans(data)
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : String(e))
      setSpans([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) loadSpans(date) }, [open, date, loadSpans])

  // 同步后刷新当前日列表
  useEffect(() => {
    if (open && lastUpdated) loadSpans(date)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUpdated])

  // 拉登录态 + 用户名：只在"明确登录/明确未登录"时改状态；
  // 网络抖动 / 命令超时 / 与同步抢窗口失败 → 保留之前的判定，避免误闪"未登录"。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    getBiliNav()
      .then((nav) => {
        if (cancelled) return
        if (nav.is_login && nav.uname) {
          setBiliUname(nav.uname)
          try { localStorage.setItem('bili.uname', nav.uname) } catch {}
        } else if (!nav.is_login) {
          // 窗口存在 + API 明确说未登录 → 清空缓存
          setBiliUname(null)
          try { localStorage.removeItem('bili.uname') } catch {}
        }
      })
      .catch(() => {
        // 窗口未开 / 超时 / 通道被同步占用 → 保持现状，不要 flip 成"未登录"
      })
    return () => { cancelled = true }
  }, [open, lastUpdated])

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (detailSpan) setDetailSpan(null)
      else if (settingsOpen) setSettingsOpen(false)
      else if (datePickerOpen) setDatePickerOpen(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, detailSpan, datePickerOpen, settingsOpen, onClose])

  // 设置弹层 click-outside
  useEffect(() => {
    if (!settingsOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (settingsPopRef.current?.contains(t)) return
      if (settingsAnchorRef.current?.contains(t)) return
      setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [settingsOpen])

  // 监测画廊宽度（决定列数）
  useEffect(() => {
    if (!open) return
    const el = galleryInnerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setContainerW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  const dayStr = useMemo(() => dayKey(date), [date])

  // 计算列数 — 至少 1 列，根据容器宽度自适应
  const cols = useMemo(() => {
    const usable = Math.max(0, containerW - RAIL_AREA_W - BRANCH_W - 16)
    const n = Math.max(1, Math.floor((usable + CARD_GAP_X) / (CARD_W + CARD_GAP_X)))
    return Math.min(n, MAX_COLS)
  }, [containerW])

  const { placed, height } = useMemo(
    () => layoutMasonry(spans, dayStr, cols),
    [spans, dayStr, cols],
  )

  // 切日时回到顶部
  useEffect(() => {
    if (!open || !galleryRef.current) return
    galleryRef.current.scrollTo({ top: 0, behavior: 'auto' })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dayStr])

  // 前后日切换：基于 B站 day-counts 判断目标日是否有观看记录（today 始终可达）
  const biliDataDays = useDataDays(date, 'bili')
  const prevDate = useMemo(() => { const d = new Date(date); d.setDate(d.getDate() - 1); return d }, [date])
  const nextDate = useMemo(() => { const d = new Date(date); d.setDate(d.getDate() + 1); return d }, [date])
  const prevHasData = hasDataOrIsToday(prevDate, biliDataDays)
  const nextHasData = hasDataOrIsToday(nextDate, biliDataDays)
  const goPrev = useCallback(() => { if (prevHasData) { setDate(prevDate); setDetailSpan(null) } }, [prevHasData, prevDate])
  const goNext = useCallback(() => { if (nextHasData) { setDate(nextDate); setDetailSpan(null) } }, [nextHasData, nextDate])

  const handleOpenLogin = useCallback(async () => {
    setLoginError(null); setIsOpening(true)
    try { await openBiliLogin() }
    catch (e) { setLoginError(e instanceof Error ? e.message : String(e)) }
    finally { setIsOpening(false) }
  }, [])

  if (!open) return null

  const dateLabel = date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]
  const downloadedCount = spans.filter((s) => s.downloaded).length
  const totalCount = spans.length

  return (
    <>
      <style>{`
        @keyframes bhd-overlay-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes bhd-pop { from { opacity: 0; transform: translate(-50%, -50%) scale(0.97); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
        .bhd-icon-btn {
          background: rgba(0,229,255,0.05);
          border: 1px solid ${theme.hudFrameSoft};
          color: ${theme.textSecondary};
          width: 26px; height: 26px;
          display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer;
          clip-path: ${hud.chamfer8};
          -webkit-clip-path: ${hud.chamfer8};
          transition: all 0.15s ease;
        }
        .bhd-icon-btn:hover:not(:disabled) { color: ${theme.electricBlue}; border-color: ${theme.electricBlue}; box-shadow: 0 0 8px ${theme.electricBlue}55; }
        .bhd-date-trigger {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 5px 12px;
          background: rgba(0,229,255,0.08);
          border: 1px solid ${theme.electricBlue}66;
          color: ${theme.electricBlue};
          cursor: pointer;
          clip-path: ${hud.chamfer8};
          -webkit-clip-path: ${hud.chamfer8};
          font-family: ${theme.fontMono};
          font-size: 12px; font-weight: 700; letter-spacing: 0.6px;
          text-shadow: 0 0 6px ${theme.electricBlue}AA;
        }
        .bhd-date-trigger:hover { background: rgba(0,229,255,0.16); }
        .bhd-card {
          position: absolute;
          background: rgba(8, 14, 28, 0.96);
          border: 1px solid ${theme.hudFrameSoft};
          cursor: pointer;
          overflow: hidden;
          color: ${theme.textPrimary};
          contain: layout paint;
          transform: translateZ(0);
        }
        .bhd-card:hover {
          border-color: ${theme.electricBlue};
          z-index: 5;
        }
        .bhd-card.downloaded { border-color: ${theme.expGreen}55; }
        .bhd-card.downloaded:hover { border-color: ${theme.expGreen}; }
      `}</style>

      {/* 遮罩（无 backdrop-filter，避免滚动卡顿） */}
      <div
        onClick={() => { if (detailSpan) setDetailSpan(null); else onClose() }}
        style={{
          position: 'fixed', inset: 0, zIndex: 900,
          background: 'rgba(2, 6, 16, 0.84)',
          animation: 'bhd-overlay-in 0.16s ease-out',
        }}
      />

      {/* 弹窗主体 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(1100px, 92vw)',
          height: 'min(820px, 88vh)',
          zIndex: 901,
          display: 'flex', flexDirection: 'column',
          background: theme.hudFill,
          border: `1px solid ${theme.hudFrame}`,
          clipPath: hud.chamfer12, WebkitClipPath: hud.chamfer12,
          boxShadow: `0 24px 80px rgba(0,0,0,0.8), 0 0 60px ${theme.hudHalo}, inset 0 1px 0 rgba(255,255,255,0.04)`,
          overflow: 'hidden',
          animation: 'bhd-pop 0.18s ease-out',
        }}
      >
        {/* 顶栏：标题 + 日期 picker + 计数 + 同步按钮 */}
        <div style={{
          position: 'relative',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 16px',
          borderBottom: `1px solid ${theme.hudFrameSoft}`,
          flexShrink: 0,
          background: 'linear-gradient(180deg, rgba(0,229,255,0.05) 0%, transparent 100%)',
        }}>
          <BiliIcon size={16} style={{ color: theme.electricBlue, filter: `drop-shadow(0 0 6px ${theme.electricBlue}AA)` }} />
          <span style={{
            fontFamily: theme.fontDisplay, fontSize: 13, fontWeight: 700,
            letterSpacing: 1.6, color: theme.electricBlue,
            textShadow: `0 0 8px ${theme.electricBlue}88`,
          }}>
            B站历史浏览记录
          </span>

          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 12 }}>
            <Tooltip content={prevHasData ? '前一天' : '前一天无数据'}>
              <button
                className="bhd-icon-btn"
                disabled={!prevHasData}
                onClick={goPrev}
                style={{
                  opacity: prevHasData ? 1 : 0.3,
                  cursor: prevHasData ? 'pointer' : 'not-allowed',
                }}
              >
                <ChevronLeft size={12} />
              </button>
            </Tooltip>
            <button
              ref={dateAnchorRef}
              className="bhd-date-trigger"
              onClick={() => setDatePickerOpen((v) => !v)}
            >
              <span>{dateLabel}</span>
              <span style={{ color: theme.textSecondary, fontWeight: 500 }}>周{weekday}</span>
              <ChevronDown size={12} />
            </button>
            <Tooltip content={nextHasData ? '后一天' : '后一天无数据'}>
              <button
                className="bhd-icon-btn"
                disabled={!nextHasData}
                onClick={goNext}
                style={{
                  opacity: nextHasData ? 1 : 0.3,
                  cursor: nextHasData ? 'pointer' : 'not-allowed',
                }}
              >
                <ChevronRight size={12} />
              </button>
            </Tooltip>
          </div>

          <span style={{
            fontFamily: theme.fontMono, fontSize: 11,
            color: theme.textSecondary, letterSpacing: 0.5,
          }}>
            {loading ? (
              <span style={{ color: theme.textMuted }}>加载中…</span>
            ) : (
              <span style={{
                color: theme.electricBlue,
                textShadow: `0 0 6px ${theme.electricBlue}66`,
                fontWeight: 700,
              }}>
                {totalCount} 条
              </span>
            )}
            {downloadedCount > 0 && (
              <>
                <span style={{ color: theme.textMuted, opacity: 0.6 }}>{' · '}</span>
                <span style={{ color: theme.expGreen, textShadow: `0 0 6px ${theme.expGreen}88`, fontWeight: 700 }}>
                  {downloadedCount} 已下载
                </span>
              </>
            )}
            {isLoading && <span style={{ color: theme.textMuted }}>{' · 同步中'}</span>}
          </span>

          <div style={{ flex: 1 }} />

          <Tooltip content="B站设置">
            <button
              ref={settingsAnchorRef}
              className="bhd-icon-btn"
              onClick={() => setSettingsOpen((v) => !v)}
              style={{ color: settingsOpen ? theme.electricBlue : undefined }}
            >
              <Settings size={12} />
            </button>
          </Tooltip>
          <Tooltip content="关闭 (Esc)">
            <button className="bhd-icon-btn" onClick={onClose}>
              <X size={13} />
            </button>
          </Tooltip>
        </div>

        {/* 状态行：登录 + 同步状态 + 间隔 */}
        <div style={{
          position: 'relative',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 16px',
          borderBottom: `1px solid ${theme.hudFrameSoft}`,
          flexShrink: 0,
        }}>
          <button
            disabled={isOpening}
            onClick={handleOpenLogin}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: !biliUname ? `${theme.electricBlue}18` : 'rgba(255,255,255,0.04)',
              border: `1px solid ${loginError ? theme.dangerRed : !biliUname ? theme.electricBlue : theme.glassBorder}`,
              borderRadius: 3, padding: '4px 10px',
              color: loginError ? theme.dangerRed : !biliUname ? theme.electricBlue : theme.textSecondary,
              cursor: 'pointer', fontSize: 11, fontFamily: theme.fontBody,
              opacity: isOpening ? 0.6 : 1,
            }}
          >
            <LogIn size={11} />
            {isOpening
              ? '打开中…'
              : biliUname
                ? `已登录 ${biliUname}，可重新登录`
                : '浏览器打开 B站 初始化读取历史数据'}
          </button>
          <span style={{ fontSize: 11, color: loginError ? theme.dangerRed : theme.textSecondary, display: 'flex', alignItems: 'center', gap: 6 }}>
            {(loginError ?? error ?? fetchErr) ? (
              <>{loginError ?? error ?? fetchErr}</>
            ) : (
              <>
                {lastUpdated && (
                  <span style={{ color: theme.textSecondary }}>
                    上次 {String(lastUpdated.getHours()).padStart(2, '0')}:{String(lastUpdated.getMinutes()).padStart(2, '0')}
                  </span>
                )}
                {windowClosed && (
                  <span style={{ color: theme.textSecondary }}>· 窗口已关闭</span>
                )}
                {isPaused ? (
                  <span style={{ color: theme.textSecondary }}>· 已暂停</span>
                ) : lastUpdated ? (
                  <span style={{ color: theme.textSecondary }}>· {countdown}s 后{windowClosed ? '重试' : '同步'}</span>
                ) : (
                  <span style={{ color: theme.textSecondary }}>等待首次同步</span>
                )}
              </>
            )}
          </span>
          <HudSelect
            inline
            value={String(intervalSeconds)}
            onChange={(v) => onSetInterval(Number(v))}
            options={[
              { value: '30', label: '30s 一次' },
              { value: '60', label: '1min 一次' },
              { value: '120', label: '2min 一次' },
              { value: '300', label: '5min 一次' },
            ]}
          />
          <div style={{ flex: 1 }} />
          <Tooltip content={isPaused ? '继续' : '暂停'}>
            <button className="bhd-icon-btn" onClick={isPaused ? onResume : onPause}>
              {isPaused ? <Play size={12} /> : <Pause size={12} />}
            </button>
          </Tooltip>
          <Tooltip content="立即同步">
            <button className="bhd-icon-btn" onClick={() => { onRefresh(); loadSpans(date) }}>
              <RefreshCw size={12} />
            </button>
          </Tooltip>
        </div>

        {settingsOpen && (
          <div
            ref={settingsPopRef}
            style={{
              position: 'absolute',
              top: 38,
              right: 12,
              zIndex: 50,
              width: 320,
              background: '#0a0f1c',
              border: `1px solid ${theme.hudFrame}`,
              borderRadius: 4,
              boxShadow: `0 8px 28px rgba(0,0,0,0.7), 0 0 24px ${theme.hudHalo}`,
              padding: '12px 14px',
              fontFamily: theme.fontBody,
            }}
          >
            <div style={{ fontSize: 11, color: theme.electricBlue, letterSpacing: 1, marginBottom: 10, fontWeight: 700 }}>
              B站设置
            </div>

            {/* 下载路径 */}
            <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 4 }}>视频下载存储位置</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <input
                type="text"
                value={config.biliDownloadPath}
                onChange={(e) => updateBiliConfig({ biliDownloadPath: e.target.value })}
                placeholder="E:\\BiliDownloads"
                style={{
                  flex: 1, fontSize: 11, padding: '4px 6px',
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${theme.glassBorder}`,
                  borderRadius: 2,
                  color: theme.textSecondary,
                  fontFamily: theme.fontMono,
                }}
              />
              <Tooltip content="选择目录">
                <button
                  className="bhd-icon-btn"
                  onClick={async () => {
                    const sel = await openDialog({
                      directory: true,
                      multiple: false,
                      title: '选择 B 站视频下载位置',
                      defaultPath: config.biliDownloadPath || undefined,
                    })
                    if (sel && typeof sel === 'string') updateBiliConfig({ biliDownloadPath: sel })
                  }}
                >
                  <FolderOpen size={12} />
                </button>
              </Tooltip>
            </div>
            <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 10 }}>
              合并后的 mp4 会保存到此目录。需系统已安装 ffmpeg。
            </div>

            {/* 画质 */}
            <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 4 }}>下载画质偏好</div>
            <HudSelect
              value={config.biliDownloadQuality}
              onChange={(v) => updateBiliConfig({ biliDownloadQuality: v as AgentConfig['biliDownloadQuality'] })}
              options={[
                { value: 'auto',       label: '自动',  hint: '账号最高可得' },
                { value: '4k',         label: '4K',    hint: 'qn=120 · 大会员' },
                { value: '1080p_plus', label: '1080P+', hint: 'qn=112 · 高码率·大会员' },
                { value: '1080p',      label: '1080P',  hint: 'qn=80' },
                { value: '720p',       label: '720P',   hint: 'qn=64 · 省流' },
                { value: '480p',       label: '480P',   hint: 'qn=32 · 极省流' },
              ]}
            />
            <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 6 }}>
              选高于权限的会自动回退到可用最高。
            </div>
          </div>
        )}

        {/* 主体：鱼线图画廊 */}
        <div
          ref={galleryRef}
          style={{ position: 'relative', flex: 1, overflowY: 'auto', overflowX: 'hidden' }}
        >
          {spans.length === 0 && !loading ? (
            <div style={{
              padding: '60px 16px', textAlign: 'center',
              color: theme.textMuted, fontSize: 13, letterSpacing: 1,
            }}>
              ── 当日无观看记录 ──
            </div>
          ) : (
            <div ref={galleryInnerRef} style={{
              position: 'relative',
              height,
              paddingBottom: 16,
            }}>
              <FishboneRail
                placed={placed}
                height={height}
                cardW={CARD_W}
                gap={CARD_GAP_X}
                hoveredId={hoveredId}
              />
              {placed.map((p) => (
                <Card
                  key={p.span.bvid}
                  placed={p}
                  cardW={CARD_W}
                  gap={CARD_GAP_X}
                  onOpenDetail={() => setDetailSpan(p.span)}
                  onHover={(h) => setHoveredId(h ? p.span.bvid : null)}
                />
              ))}
              {/* HTML 时间标签层（绝对定位，不进 SVG，杜绝裁剪） */}
              <TimeLabels placed={placed} hoveredId={hoveredId} dayStr={dayStr} />
            </div>
          )}

        </div>

        {/* 底栏 */}
        <div style={{
          position: 'relative',
          padding: '6px 16px',
          borderTop: `1px solid ${theme.hudFrameSoft}`,
          fontSize: 11, color: theme.textMuted,
          display: 'flex', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <span>关闭弹窗后后台继续同步</span>
          {cursor && <span>最旧记录: {formatViewTime(cursor.viewAt)}</span>}
        </div>

        {/* 详情浮层：放在弹窗 body 顶层，避开滚动容器 */}
        {detailSpan && (
          <DetailOverlay span={detailSpan} onClose={() => setDetailSpan(null)} />
        )}
      </div>

      {datePickerOpen && (
        <DatePickerPopover
          anchorRef={dateAnchorRef}
          value={date}
          mode="bili"
          onChange={(d) => { setDate(d); setDetailSpan(null) }}
          onClose={() => setDatePickerOpen(false)}
        />
      )}
    </>
  )
}

// ══════════════════════════════════════════════
// 鱼线图主轴：节点跟随卡片 + 支线 + 长间隔虚线
// 仅 1 个 SVG，无 drop-shadow 过滤器（保证流畅）
// ══════════════════════════════════════════════
function FishboneRail({
  placed, height, cardW, gap, hoveredId,
}: {
  placed: PlacedCard[]
  height: number
  cardW: number
  gap: number
  hoveredId: string | null
}) {
  const cardLeftX = (col: number) => RAIL_AREA_W + BRANCH_W + col * (cardW + gap)

  // 主轴段：连接相邻节点；长间隔虚线
  const segments: { y1: number; y2: number; dashed: boolean }[] = []
  for (let i = 0; i < placed.length - 1; i++) {
    const a = placed[i]
    const b = placed[i + 1]
    segments.push({
      y1: a.nodeY,
      y2: b.nodeY,
      dashed: b.startMin - a.startMin >= GAP_DASHED_MIN,
    })
  }

  return (
    <svg
      style={{
        position: 'absolute', left: 0, top: 0,
        width: '100%', height,
        pointerEvents: 'none',
        zIndex: 6,                        // 浮在卡片之上（走线本身在间隙，节点圆显于卡片之上）
        transform: 'translateZ(0)',
      }}
    >
      {/* ── 主轴（special spine） ── */}
      <defs>
        <linearGradient id="bhd-spine-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={theme.electricBlue} stopOpacity="0.25" />
          <stop offset="50%" stopColor={theme.electricBlue} stopOpacity="0.95" />
          <stop offset="100%" stopColor={theme.electricBlue} stopOpacity="0.25" />
        </linearGradient>
      </defs>
      {/* 主轴 halo（外层粗描边作为 glow） */}
      <line
        x1={RAIL_X} y1={0}
        x2={RAIL_X} y2={height}
        stroke={theme.electricBlue}
        strokeWidth={8}
        strokeOpacity={0.12}
      />
      {/* 主轴主线（带渐变） */}
      <line
        x1={RAIL_X} y1={0}
        x2={RAIL_X} y2={height}
        stroke="url(#bhd-spine-grad)"
        strokeWidth={2.5}
      />
      {/* 主轴外层细线条（高亮边缘） */}
      <line
        x1={RAIL_X - 3} y1={0}
        x2={RAIL_X - 3} y2={height}
        stroke={theme.electricBlue}
        strokeWidth={1}
        strokeOpacity={0.35}
      />
      <line
        x1={RAIL_X + 3} y1={0}
        x2={RAIL_X + 3} y2={height}
        stroke={theme.electricBlue}
        strokeWidth={1}
        strokeOpacity={0.35}
      />

      {/* 长间隔（≥1h）虚线覆盖在主轴上，警示色 */}
      {segments.filter((s) => s.dashed).map((s, i) => (
        <line
          key={`dash-${i}`}
          x1={RAIL_X} y1={s.y1 + 4}
          x2={RAIL_X} y2={s.y2 - 4}
          stroke={theme.warningOrange}
          strokeWidth={1.6}
          strokeDasharray="4 5"
          strokeOpacity={0.85}
        />
      ))}

      {/* ── 支线 + 节点 ── 时间标签由外部 TimeLabels 渲染 */}
      {placed.map((p) => {
        const cx = cardLeftX(p.col)
        const cardTopMid = cx + cardW / 2
        const dropY = p.top
        const downloaded = p.span.downloaded
        const isHi = hoveredId === p.span.bvid
        const color = isHi ? (downloaded ? theme.expGreen : theme.electricBlue) : 'rgba(255,255,255,0.55)'
        // 走线：从节点 → 右走到 col 专属竖线 → 上走到行上方 lane → 右走到卡顶中线 → 下走入卡片
        // 每个 col 都有专属的竖线 x 和 lane y，避免与其他列重合
        const railExitX = RAIL_X + 6 + p.col * 6     // 92 / 98 / 104 / 110（< 卡片起始 x=134）
        const laneY = p.top - 6 - p.col * 7           // 行 top 之上 6~27 的窄通道
        const path = `
          M ${RAIL_X + 6} ${p.nodeY}
          L ${railExitX} ${p.nodeY}
          L ${railExitX} ${laneY}
          L ${cardTopMid} ${laneY}
          L ${cardTopMid} ${dropY - 1}
        `
        return (
          <g key={p.span.bvid}>
            <path
              d={path}
              fill="none"
              stroke={color}
              strokeWidth={isHi ? 2 : 1.2}
              strokeLinejoin="round"
              strokeOpacity={isHi ? 1 : 0.55}
            />
            <circle cx={cardTopMid} cy={dropY - 1} r={isHi ? 3.4 : 2.5} fill={color} stroke="#02060e" strokeWidth={1} />
            <circle cx={RAIL_X} cy={p.nodeY} r={5} fill="#02060e" stroke={theme.electricBlue} strokeWidth={1.6} />
            <circle cx={RAIL_X} cy={p.nodeY} r={2} fill={isHi ? color : theme.electricBlue} />
          </g>
        )
      })}
    </svg>
  )
}

// ══════════════════════════════════════════════
// 时间标签层（HTML，绝对定位，不会被 SVG 视窗裁剪）
// ══════════════════════════════════════════════
function TimeLabels({
  placed, hoveredId, dayStr,
}: {
  placed: PlacedCard[]
  hoveredId: string | null
  dayStr: string
}) {
  return (
    <>
      {placed.map((p) => {
        const isHi = hoveredId === p.span.bvid
        const downloaded = p.span.downloaded
        const accent = downloaded ? theme.expGreen : theme.electricBlue
        const { prefix, time } = fmtTimeLabel(p.span.start_at, dayStr)
        return (
          <div
            key={`tl-${p.span.bvid}`}
            style={{
              position: 'absolute',
              left: 8,
              top: p.nodeY - 11,
              width: 70,
              height: 22,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              padding: '0 4px',
              background: 'rgba(2,6,14,0.95)',
              border: `1px solid ${accent}${isHi ? 'CC' : '55'}`,
              borderRadius: 3,
              fontFamily: theme.fontMono,
              fontSize: 11.5,
              fontWeight: 700,
              color: accent,
              letterSpacing: 0.4,
              textShadow: isHi ? `0 0 6px ${accent}AA` : undefined,
              pointerEvents: 'none',
              zIndex: 7,
              transform: 'translateZ(0)',
              whiteSpace: 'nowrap',
              boxSizing: 'border-box',
            }}
          >
            {prefix && (
              <span style={{
                fontSize: 9.5,
                fontWeight: 600,
                opacity: 0.85,
                color: accent,
              }}>
                {prefix}
              </span>
            )}
            <span>{time}</span>
          </div>
        )
      })}
    </>
  )
}

// ══════════════════════════════════════════════
// 卡片
// ══════════════════════════════════════════════
function Card({
  placed, cardW, gap, onOpenDetail, onHover,
}: {
  placed: PlacedCard
  cardW: number
  gap: number
  onOpenDetail: () => void
  onHover: (hovering: boolean) => void
}) {
  const { span, col, top } = placed
  const downloaded = span.downloaded
  // B站 progress=-1 表示"已看完"哨兵，按 100% 显示；其余按 progress/duration
  const progress = span.progress < 0
    ? 1
    : (span.duration > 0 ? Math.min(1, span.progress / span.duration) : 0)
  const pct = Math.round(progress * 100)
  const accent = downloaded ? theme.expGreen : theme.electricBlue

  const left = RAIL_AREA_W + BRANCH_W + col * (cardW + gap)

  return (
    <div
      className={`bhd-card ${downloaded ? 'downloaded' : ''}`}
      style={{
        left, top, width: cardW,
        borderLeft: `3px solid ${accent}`,
        boxShadow: `inset 4px 0 6px -4px ${accent}88`,
      }}
      onClick={onOpenDetail}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {/* 封面 */}
      <div style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16 / 10',
        background: 'rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}>
        <img
          src={`http://localhost:3000/api/bilibili/cover?url=${encodeURIComponent(span.cover)}`}
          alt=""
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
        {/* 已下载徽标（仅下载完成才显示） */}
        {/* 背景是封面图，颜色不可控 → 用近黑实底 + 暗色描边阴影保证任何底色都能读清 */}
        {downloaded && (
          <span style={{
            position: 'absolute', top: 6, left: 6,
            padding: '2px 7px',
            fontFamily: theme.fontBody,
            fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
            background: 'rgba(2,6,14,0.88)',
            border: `1px solid ${theme.expGreen}`,
            color: theme.expGreen,
            textShadow: '0 0 2px #000, 0 0 2px #000, 0 0 4px rgba(0,0,0,0.9)',
            boxShadow: `0 0 6px ${theme.expGreen}66, 0 1px 2px rgba(0,0,0,0.6)`,
          }}>
            已下载
          </span>
        )}
        {/* 时长 */}
        <span style={{
          position: 'absolute', top: 6, right: 6,
          padding: '2px 6px',
          background: 'rgba(0,0,0,0.7)',
          color: theme.textPrimary,
          fontFamily: theme.fontMono,
          fontSize: 10,
          letterSpacing: 0.3,
        }}>
          {fmtDuration(span.duration)}
        </span>
        {/* 进度条（看完了自然拉满，无需额外徽标） */}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          height: 2,
          background: 'rgba(255,255,255,0.08)',
        }}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            background: accent,
            boxShadow: `0 0 6px ${accent}`,
          }} />
        </div>
      </div>

      {/* 文字 */}
      <div style={{ padding: '8px 10px 10px' }}>
        {/* 标题 */}
        <div style={{
          fontFamily: theme.fontBody,
          fontSize: 12.5, fontWeight: 600,
          color: theme.textPrimary,
          lineHeight: 1.35,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          marginBottom: 5,
        }}>
          {span.title}
        </div>
        {/* UP 主 + 进度 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 11, color: theme.textSecondary,
        }}>
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            maxWidth: '60%',
          }}>
            {span.author_name}
          </span>
          <span style={{
            fontFamily: theme.fontMono,
            color: theme.textMuted,
            letterSpacing: 0.3,
          }}>
            {pct}%
          </span>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════
// 卡片详情浮层：在弹窗内右侧浮出 BiliVideoPanel
// ══════════════════════════════════════════════
function DetailOverlay({ span, onClose }: { span: BiliSpan; onClose: () => void }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0, zIndex: 10,
          background: 'rgba(2, 6, 16, 0.78)',
          animation: 'bhd-overlay-in 0.14s ease-out',
        }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          right: 24, top: 24, bottom: 24,
          width: 380,
          zIndex: 11,
          background: theme.hudFill,
          border: `1px solid ${theme.electricBlue}88`,
          clipPath: hud.chamfer12, WebkitClipPath: hud.chamfer12,
          boxShadow: `0 16px 48px rgba(0,0,0,0.8), 0 0 32px ${theme.electricBlue}55`,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: `1px solid ${theme.hudFrameSoft}`,
          flexShrink: 0,
        }}>
          <span style={{
            fontFamily: theme.fontDisplay, fontSize: 11, fontWeight: 700,
            letterSpacing: 2, color: theme.electricBlue,
            textShadow: `0 0 6px ${theme.electricBlue}AA`,
          }}>
            视频 · 详情
          </span>
          <button
            className="bhd-icon-btn"
            onClick={onClose}
            title="关闭"
            style={{ width: 22, height: 22 }}
          >
            <X size={12} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <BiliVideoPanel span={span} />
        </div>
      </div>
    </>
  )
}
