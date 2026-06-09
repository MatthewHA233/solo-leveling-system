import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Hash, Image as ImageIcon, Type, List, ListOrdered, AtSign, Send } from 'lucide-react'
import { hud, theme } from '../theme'
import { HudFrameSkeleton, HudTabButton, CornerArt, ChartHeaderFrame } from './hud'

type ThoughtMode = 'plain' | 'context'

interface ThoughtCard {
  readonly id: string
  readonly text: string
  readonly topic: string
  readonly mode: ThoughtMode
  readonly createdAt: string
  readonly contextLabel?: string
}

const THOUGHT_STORAGE_KEY = 'slu.torrent.thoughtCards.v1'

interface ThoughtDayGroup {
  readonly key: string
  readonly date: Date
  readonly cards: readonly ThoughtCard[]
}


function loadThoughtCards(): ThoughtCard[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(THOUGHT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is ThoughtCard => {
        if (!item || typeof item !== 'object') return false
        const x = item as Record<string, unknown>
        return typeof x.id === 'string'
          && typeof x.text === 'string'
          && typeof x.topic === 'string'
          && (x.mode === 'plain' || x.mode === 'context')
          && typeof x.createdAt === 'string'
      })
      .slice(0, 200)
  } catch {
    return []
  }
}

function saveThoughtCards(cards: readonly ThoughtCard[]) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THOUGHT_STORAGE_KEY, JSON.stringify(cards.slice(0, 200)))
    }
  } catch {
    // localStorage 可能被 WebView/隐私设置禁用；写入失败时只丢弃本次本地缓存。
  }
}

function dayKeyFromIso(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10) || 'unknown'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dateFromDayKey(key: string): Date | null {
  const [year, month, day] = key.split('-').map((part) => Number(part))
  if (!year || !month || !day) return null
  const d = new Date(year, month - 1, day)
  return Number.isNaN(d.getTime()) ? null : d
}

function groupThoughtCards(cards: readonly ThoughtCard[]): ThoughtDayGroup[] {
  const map = new Map<string, ThoughtCard[]>()
  for (const card of cards) {
    const key = dayKeyFromIso(card.createdAt)
    const list = map.get(key)
    if (list) {
      list.push(card)
    } else {
      map.set(key, [card])
    }
  }
  return Array.from(map.entries()).map(([key, list]) => ({
    key,
    date: dateFromDayKey(key) ?? new Date(list[0]?.createdAt ?? Date.now()),
    cards: list,
  }))
}

function formatDayHeading(date: Date): string {
  if (Number.isNaN(date.getTime())) return '未知日期'
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  })
}

function formatTimeOnly(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type TorrentSubview = 'cards' | 'context'

export default function TorrentFieldPanel() {
  const [subview, setSubview] = useState<TorrentSubview>('cards')
  const [thoughtDraft, setThoughtDraft] = useState('')
  const [thoughtCards, setThoughtCards] = useState<ThoughtCard[]>(loadThoughtCards)

  const submitThought = () => {
    const text = thoughtDraft.trim()
    if (!text) return
    const nextCard: ThoughtCard = {
      id: crypto.randomUUID(),
      text,
      topic: '',
      mode: 'plain',
      createdAt: new Date().toISOString(),
    }
    setThoughtCards((prev) => {
      const next = [nextCard, ...prev].slice(0, 200)
      saveThoughtCards(next)
      return next
    })
    setThoughtDraft('')
  }
  const removeThought = (id: string) => {
    setThoughtCards((prev) => {
      const next = prev.filter((card) => card.id !== id)
      saveThoughtCards(next)
      return next
    })
  }

  return (
    <div style={styles.root}>
      <div style={styles.backdrop} />
      <div style={styles.grid} />

      {/* tabs 行：跟 DayNightChart 同结构 — 面板标题 + 视图切换，紧贴顶部，与 ChartHeaderFrame 凹陷条同坐标 */}
      <div style={styles.tabsRow}>
        <span style={styles.tabsTitle}>洪流域</span>
        <span style={styles.tabsLabel}>视图</span>
        <HudTabButton
          label="想法卡片"
          active={subview === 'cards'}
          color={theme.flameTeal}
          width={96}
          height={24}
          onClick={() => setSubview('cards')}
        />
        <HudTabButton
          label="语境库"
          active={subview === 'context'}
          color={theme.electricBlue}
          width={82}
          height={24}
          onClick={() => setSubview('context')}
        />
      </div>

      {/* 框架照搬 DayNightChart：HudFrameSkeleton + 4 CornerArt + 3 切角遮罩 + ChartHeaderFrame */}
      <div style={styles.frameWrap}>
        <HudFrameSkeleton />
        <CornerArt position="tl" />
        <CornerArt position="tr" />
        <CornerArt position="bl" />
        <CornerArt position="br" />

        {/* 右上 frame 切角遮罩（18×18） */}
        <div style={{
          position: 'absolute',
          right: 0, top: 0, width: 18, height: 18,
          background: theme.background,
          clipPath: 'polygon(100% 0, 100% 100%, 0 0)',
          WebkitClipPath: 'polygon(100% 0, 100% 100%, 0 0)',
          zIndex: 65,
          pointerEvents: 'none',
        }} />
        {/* 右下 frame 切角遮罩 */}
        <div style={{
          position: 'absolute',
          right: 0, bottom: 0, width: 18, height: 18,
          background: theme.background,
          clipPath: 'polygon(0 100%, 100% 0, 100% 100%)',
          WebkitClipPath: 'polygon(0 100%, 100% 0, 100% 100%)',
          zIndex: 65,
          pointerEvents: 'none',
        }} />
        {/* 左下 frame 切角遮罩 */}
        <div style={{
          position: 'absolute',
          left: 0, bottom: 0, width: 18, height: 18,
          background: theme.background,
          clipPath: 'polygon(0 0, 100% 100%, 0 100%)',
          WebkitClipPath: 'polygon(0 0, 100% 100%, 0 100%)',
          zIndex: 65,
          pointerEvents: 'none',
        }} />

        {/* 顶部 HUD 装饰带：凹陷凸塔（参考 DayNightChart 同款参数） */}
        <ChartHeaderFrame
          mainHeight={30}
          rightOffset={24}
          paddingRightFull={24.5}
          topOffsetLeft={24}
          topOffsetRight={24}
          slopeLen={14}
          rightSegLen={90}
          notchWidth={150}
        />

        <main style={styles.content}>
          {subview === 'cards' ? (
            <ThoughtDock
              draft={thoughtDraft}
              cards={thoughtCards}
              onDraftChange={setThoughtDraft}
              onSubmit={submitThought}
              onRemove={removeThought}
            />
          ) : (
            <div style={styles.contextPlaceholder}>
              语境库 · 等待接入（B 站 / 微信文章 / 桌面 app 抓取）
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function ThoughtDock({
  draft,
  cards,
  onDraftChange,
  onSubmit,
  onRemove,
}: {
  readonly draft: string
  readonly cards: readonly ThoughtCard[]
  readonly onDraftChange: (text: string) => void
  readonly onSubmit: () => void
  readonly onRemove: (id: string) => void
}) {
  return (
    <section style={styles.flomoBoard}>
      <FlomoSidebar count={cards.length} />
      <FlomoMain
        draft={draft}
        cards={cards}
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
        onRemove={onRemove}
      />
    </section>
  )
}

// ── 左侧栏：仅 3 个数字 + 全部笔记 nav（热力图 / 标签区已砍） ────────
function FlomoSidebar({ count }: { readonly count: number }) {
  const days = useMemo(() => {
    return Math.max(1, Math.ceil(count / 2))
  }, [count])

  return (
    <aside style={styles.flomoSidebar}>
      <div style={styles.statsRow}>
        <Stat value={count} label="笔记" />
        <Stat value={0} label="标签" />
        <Stat value={days} label="天" />
      </div>

      <button type="button" style={styles.navItemActive}>
        <span style={styles.navDot} />全部笔记
      </button>
    </aside>
  )
}

function Stat({ value, label }: { readonly value: number; readonly label: string }) {
  return (
    <div style={styles.statItem}>
      <strong style={styles.statValue}>{value}</strong>
      <span style={styles.statLabel}>{label}</span>
    </div>
  )
}

// ── 右侧主栏：compose 顶部 + feed 倒序 ──────────────────────────
function FlomoMain({
  draft,
  cards,
  onDraftChange,
  onSubmit,
  onRemove,
}: {
  readonly draft: string
  readonly cards: readonly ThoughtCard[]
  readonly onDraftChange: (text: string) => void
  readonly onSubmit: () => void
  readonly onRemove: (id: string) => void
}) {
  const [focused, setFocused] = useState(false)
  const expanded = focused || draft.trim().length > 0
  const dayGroups = useMemo(() => groupThoughtCards(cards), [cards])

  return (
    <div style={styles.flomoMain}>
      <style>{`
        .torrent-feed-scroll::-webkit-scrollbar {
          width: 0;
          height: 0;
          display: none;
        }
      `}</style>
      <div
        style={{
          ...styles.composer,
          minHeight: expanded ? 160 : 64,
          borderColor: expanded ? `${theme.flameTeal}88` : theme.hudFrameSoft,
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') onSubmit()
          }}
          placeholder="现在的想法是…"
          style={{
            ...styles.composerInput,
            minHeight: expanded ? 96 : 28,
          }}
        />
        <div style={styles.composerToolbar}>
          <ToolbarIcon Icon={Hash} />
          <ToolbarIcon Icon={ImageIcon} />
          <ToolbarIcon Icon={Type} />
          <ToolbarIcon Icon={List} />
          <ToolbarIcon Icon={ListOrdered} />
          <span style={styles.toolbarDivider} />
          <ToolbarIcon Icon={AtSign} />
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onSubmit}
            disabled={!draft.trim()}
            style={{
              ...styles.composerSend,
              opacity: draft.trim() ? 1 : 0.35,
              cursor: draft.trim() ? 'pointer' : 'default',
            }}
            title="Ctrl+Enter 发送"
          >
            <Send size={14} />
          </button>
        </div>
      </div>

      <div className="torrent-feed-scroll" style={styles.feed}>
        {cards.length === 0 ? (
          <div style={styles.feedEmpty}>写一句留下来。</div>
        ) : (
          dayGroups.map((group) => {
            return (
            <section
              key={group.key}
              style={styles.daySection}
            >
              <div style={styles.dayHeader}>
                <span style={styles.dayHeaderTitle}>{formatDayHeading(group.date)}</span>
                <span style={styles.dayHeaderCount}>{group.cards.length} MEMO</span>
              </div>
              <div style={styles.dayMemoStack}>
                {group.cards.map((card) => (
                  <article
                    key={card.id}
                    style={styles.memoCard}
                  >
                    <div style={styles.memoMeta}>
                      <span>{formatTimeOnly(card.createdAt)}</span>
                      <button
                        type="button"
                        onClick={() => onRemove(card.id)}
                        style={styles.memoDelete}
                        title="删除"
                      >×</button>
                    </div>
                    <p style={styles.memoBody}>{card.text}</p>
                  </article>
                ))}
              </div>
            </section>
            )
          })
        )}
      </div>
    </div>
  )
}

function ToolbarIcon({ Icon }: { readonly Icon: React.ComponentType<{ size?: number; color?: string }> }) {
  return (
    <span style={styles.toolbarIcon}>
      <Icon size={14} color={theme.textMuted} />
    </span>
  )
}

const styles: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    // 左 20，右 30（让 ChartHeaderFrame 长竖线显示，rightOffset 24 + paddingRightFull 24.5 + 余量）
    paddingLeft: 20,
    paddingRight: 30,
    paddingTop: 0,
    paddingBottom: 20,
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    background: theme.background,
  },
  tabsRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 0,
    height: 30,
    flexShrink: 0,
    padding: '0 24px 0 12px',
    position: 'relative',
    zIndex: 2,
  },
  tabsTitle: {
    alignSelf: 'center',
    fontFamily: theme.fontBody,
    fontSize: 12,
    fontWeight: 600,
    color: theme.textPrimary,
    letterSpacing: 0.4,
    paddingLeft: 12,
    paddingRight: 10,
    marginRight: 4,
    marginTop: 6,
  },
  tabsLabel: {
    alignSelf: 'center',
    fontFamily: theme.fontBody,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: 0.2,
    color: theme.textMuted,
    paddingRight: 6,
    marginRight: 2,
    marginTop: 6,
  },
  backdrop: {
    position: 'absolute',
    inset: 0,
    background: `
      radial-gradient(circle at 18% 16%, rgba(0,255,224,0.13), transparent 27%),
      radial-gradient(circle at 82% 24%, rgba(255,153,51,0.11), transparent 24%),
      linear-gradient(180deg, rgba(4,10,26,0.94), rgba(0,0,0,0.97))
    `,
    pointerEvents: 'none',
  },
  grid: {
    position: 'absolute',
    inset: 0,
    background: `${hud.grid}, ${hud.scanlines}`,
    opacity: 0.72,
    pointerEvents: 'none',
  },
  frameWrap: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
    zIndex: 1,
  },
  content: {
    position: 'absolute',
    inset: 0,
    padding: '12px 18px 18px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    overflow: 'hidden',
  },
  contextPlaceholder: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
  },
  // ── flomo 仿照布局 ─────────────────────────────────
  flomoBoard: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: '220px 1fr',
    gap: 18,
    paddingTop: 6,
  },
  flomoSidebar: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    minWidth: 0,
    paddingRight: 4,
  },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 8,
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
  },
  statValue: {
    fontFamily: theme.fontDisplay,
    fontSize: 20,
    fontWeight: 700,
    color: theme.textPrimary,
    lineHeight: 1,
    letterSpacing: '0.04em',
  },
  statLabel: {
    fontSize: 10,
    color: theme.textMuted,
    letterSpacing: '0.18em',
  },
  navItemActive: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    border: `1px solid ${theme.flameTeal}55`,
    background: 'rgba(0,255,224,0.08)',
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    fontSize: 12,
    letterSpacing: '0.15em',
    cursor: 'pointer',
    textAlign: 'left',
  },
  navDot: {
    width: 6, height: 6,
    background: theme.flameTeal,
    boxShadow: `0 0 6px ${theme.flameTeal}`,
  },
  // 右侧主栏
  flomoMain: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    minHeight: 0,
    minWidth: 0,
  },
  composer: {
    flexShrink: 0,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,0,0,0.34)',
    display: 'flex',
    flexDirection: 'column',
    padding: '10px 12px 8px',
    transition: 'min-height 280ms cubic-bezier(.2,.8,.2,1), border-color 220ms ease',
    overflow: 'hidden',
  },
  composerInput: {
    flex: 1,
    resize: 'none',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    fontSize: 13,
    lineHeight: 1.6,
    transition: 'min-height 280ms cubic-bezier(.2,.8,.2,1)',
  },
  composerToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    paddingTop: 8,
    borderTop: `1px solid ${theme.hudFrameSoft}`,
    marginTop: 6,
  },
  toolbarIcon: {
    width: 24,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    borderRadius: 3,
    transition: 'background 0.15s',
  },
  toolbarDivider: {
    width: 1,
    height: 14,
    background: theme.hudFrameSoft,
    margin: '0 4px',
  },
  composerSend: {
    width: 26,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: theme.flameTeal,
    padding: 0,
  },
  feed: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    overflowY: 'auto',
    overflowX: 'hidden',
    paddingRight: 10,
    paddingTop: 2,
    paddingBottom: 14,
    scrollSnapType: 'y proximity',
    scrollPaddingTop: 8,
    scrollbarWidth: 'none',
    msOverflowStyle: 'none',
    overscrollBehavior: 'contain',
  },
  feedEmpty: {
    color: theme.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    padding: '18px 4px',
  },
  daySection: {
    position: 'relative',
    padding: '0 8px 10px 8px',
    borderLeftWidth: 1,
    borderLeftStyle: 'solid',
    borderLeftColor: 'rgba(0,229,255,0.16)',
    background: 'linear-gradient(90deg, rgba(0,229,255,0.035), rgba(0,0,0,0))',
  },
  dayHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 28,
    padding: '0 4px 0 8px',
    marginBottom: 6,
    background: 'linear-gradient(180deg, rgba(3,10,22,0.96), rgba(3,10,22,0.78))',
    borderBottom: `1px solid ${theme.hudFrameSoft}`,
  },
  dayHeaderTitle: {
    fontFamily: theme.fontMono,
    color: theme.flameTeal,
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.18em',
    textShadow: `0 0 8px ${theme.flameTeal}77`,
  },
  dayHeaderCount: {
    fontFamily: theme.fontMono,
    color: theme.textMuted,
    fontSize: 9,
    letterSpacing: '0.18em',
  },
  dayMemoStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  memoCard: {
    padding: '12px 12px',
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'linear-gradient(180deg, rgba(5,13,27,0.62), rgba(0,0,0,0.28))',
    clipPath: hud.chamfer8,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    scrollSnapAlign: 'start',
    scrollSnapStop: 'always',
    scrollMarginTop: 8,
  },
  memoMeta: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    color: theme.textMuted,
    fontFamily: theme.fontMono,
    fontSize: 10,
    letterSpacing: '0.1em',
  },
  memoDelete: {
    width: 18,
    height: 18,
    border: 'none',
    background: 'transparent',
    color: theme.textMuted,
    lineHeight: 1,
    padding: 0,
    cursor: 'pointer',
    opacity: 0.4,
  },
  memoBody: {
    margin: 0,
    color: theme.textPrimary,
    fontSize: 14,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
  },
}
