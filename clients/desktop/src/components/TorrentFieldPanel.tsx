import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Hash, Image as ImageIcon, Type, List, ListOrdered, AtSign, Send, Check, ChevronDown, ChevronUp, Pencil, Plus } from 'lucide-react'
import { hud, theme } from '../theme'
import { HudFrameSkeleton, HudTabButton, CornerArt, ChartHeaderFrame } from './hud'
import type { ContextFeedItem, AnchorBinding, AnchorRef, AnchorCategory } from '../lib/local-api'
import { fetchContextFeed, addContextCard, deleteContextCard, updateContextCard, fetchCardBindings, deleteBinding, addBinding, updateAnchor, addAnchorToBinding } from '../lib/local-api'
import AnchorTextRenderer, { AnchorChip, ANCHOR_CAT_COLOR, ANCHOR_CAT_SHORT } from './AnchorTextRenderer'
import AnchorFieldMap from './AnchorFieldMap'
import CardHoverEffect from './CardHoverEffect'
import TranscriptPlayerWindow from './TranscriptPlayerWindow'
import { fetchBiliTranscriptSentences, type TranscriptSentence } from '../lib/bili-transcript'
import ConfirmDialog from './ConfirmDialog'
import Tooltip from './Tooltip'

// 老想法卡迁移标记；原 localStorage 数据保留作备份不删
const THOUGHT_STORAGE_KEY = 'slu.torrent.thoughtCards.v1'
const MIGRATED_KEY = 'slu.torrent.migrated.v1'

// feed 滚动容器底部内边距。sticky 的 bottom 偏移以内容盒为基准（padding 区不算），
// 收起胶囊要贴住可视底边必须把这个值补回去（同 dayHeader 吸顶要求 paddingTop: 0 的原因）
const FEED_BOTTOM_PAD = 14

interface FeedDayGroup {
  readonly key: string
  readonly date: Date
  readonly cards: readonly ContextFeedItem[]
}

/** 把 localStorage 里的老想法卡一次性导入 DB（幂等，保留原始时间戳）。返回是否真的迁移了。 */
async function migrateLocalThoughts(): Promise<boolean> {
  try {
    if (typeof localStorage === 'undefined') return false
    if (localStorage.getItem(MIGRATED_KEY)) return false
    const raw = localStorage.getItem(THOUGHT_STORAGE_KEY)
    if (!raw) { localStorage.setItem(MIGRATED_KEY, '1'); return false }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) {
      localStorage.setItem(MIGRATED_KEY, '1')
      return false
    }
    // 倒序存储 → 正序导入，让最早的卡先落库
    const ordered = [...parsed].reverse()
    let migrated = 0
    for (const it of ordered) {
      if (!it || typeof it !== 'object') continue
      const x = it as Record<string, unknown>
      const text = typeof x.text === 'string' ? x.text.trim() : ''
      if (!text) continue
      const createdAt = typeof x.createdAt === 'string' ? x.createdAt : undefined
      const label = typeof x.contextLabel === 'string' ? x.contextLabel : undefined
      await addContextCard(text, label, createdAt)
      migrated++
    }
    localStorage.setItem(MIGRATED_KEY, '1')
    return migrated > 0
  } catch (e) {
    console.error('[Torrent] 想法卡迁移失败', e)
    return false
  }
}

// 兼容两种时间：ISO（想法卡，带 T + 时区）与 "YYYY-MM-DD HH:MM:SS"（bili，UTC 无标记）
function parseTs(s: string): Date {
  let v = s.includes('T') ? s : s.replace(' ', 'T')
  if (v.length > 10 && !/[Z+]/.test(v.slice(10))) v += 'Z'  // 无时区视为 UTC
  return new Date(v)
}

function dayKeyFromIso(iso: string): string {
  const d = parseTs(iso)
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

function groupFeedItems(cards: readonly ContextFeedItem[]): FeedDayGroup[] {
  const map = new Map<string, ContextFeedItem[]>()
  for (const card of cards) {
    const key = dayKeyFromIso(card.created_at)
    const list = map.get(key)
    if (list) list.push(card)
    else map.set(key, [card])
  }
  return Array.from(map.entries()).map(([key, list]) => ({
    key,
    date: dateFromDayKey(key) ?? new Date(list[0]?.created_at ?? Date.now()),
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
  const d = parseTs(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type TorrentSubview = 'cards' | 'context' | 'anchors'

export default function TorrentFieldPanel() {
  const [subview, setSubview] = useState<TorrentSubview>('cards')
  const [thoughtDraft, setThoughtDraft] = useState('')
  const [feed, setFeed] = useState<ContextFeedItem[]>([])
  const [jumpCardId, setJumpCardId] = useState<string | null>(null)
  // 从锚点域点视频标题：跳到语境库后要「注视」该卡（带 tick 以便重复点击同一卡也能重新触发）
  const [gazeReq, setGazeReq] = useState<{ cardId: string; tick: number } | null>(null)

  // 从锚点域「跳到语境」：切到语境库后滚动到对应卡
  useEffect(() => {
    if (subview !== 'context' || !jumpCardId) return
    const el = document.getElementById(`torrent-card-${jumpCardId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setJumpCardId(null)
  }, [subview, jumpCardId])

  const reload = useCallback(async () => {
    try {
      setFeed(await fetchContextFeed())
    } catch (e) {
      console.error('[Torrent] 语境流加载失败', e)
    }
  }, [])

  // 首次：迁移老想法卡 → 加载 feed
  useEffect(() => {
    let alive = true
    ;(async () => {
      await migrateLocalThoughts()
      if (alive) await reload()
    })()
    return () => { alive = false }
  }, [reload])

  // 跨组件实时刷新：聊天沉淀想法卡 / B站转录完成后，外部 dispatch 此事件即重拉
  useEffect(() => {
    const onUpdate = () => { void reload() }
    window.addEventListener('solevup:context-updated', onUpdate)
    return () => window.removeEventListener('solevup:context-updated', onUpdate)
  }, [reload])

  const submitThought = async () => {
    const text = thoughtDraft.trim()
    if (!text) return
    setThoughtDraft('')
    try {
      await addContextCard(text)
      await reload()
    } catch (e) {
      console.error('[Torrent] 写想法卡失败', e)
    }
  }

  // 删除先弹确认（误删无价想法不可接受），确认后才真删
  const [pendingDelete, setPendingDelete] = useState<ContextFeedItem | null>(null)
  const requestRemove = (id: string) => {
    setPendingDelete(feed.find((f) => f.id === id) ?? null)
  }
  const confirmRemove = async () => {
    const card = pendingDelete
    setPendingDelete(null)
    if (!card) return
    try {
      await deleteContextCard(card.id)
      await reload()
      // 级联删掉的锚点/绑定要让别处实时跟随（展开中的转录高亮、bili 卡 chips、锚点域）
      window.dispatchEvent(new CustomEvent('solevup:context-updated'))
    } catch (e) {
      console.error('[Torrent] 删除语境卡失败', e)
    }
  }

  // 想法卡片 tab 只看想法卡；语境库 tab 只看语境卡（转录视频），想法卡不进语境库
  const thoughts = useMemo(() => feed.filter((f) => f.kind === 'thought'), [feed])
  const contextCards = useMemo(() => feed.filter((f) => f.kind === 'bili_transcript'), [feed])

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
        <HudTabButton
          label="锚点域"
          active={subview === 'anchors'}
          color={theme.shadowPurple}
          width={82}
          height={24}
          onClick={() => setSubview('anchors')}
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
              key="cards"
              draft={thoughtDraft}
              cards={thoughts}
              showCompose
              onDraftChange={setThoughtDraft}
              onSubmit={submitThought}
              onRemove={requestRemove}
              onJumpToContext={(cardId) => {
                setSubview('context')
                setJumpCardId(cardId)
              }}
            />
          ) : subview === 'context' ? (
            <ThoughtDock
              key="context"
              draft={thoughtDraft}
              cards={contextCards}
              showCompose={false}
              onDraftChange={setThoughtDraft}
              onSubmit={submitThought}
              onRemove={requestRemove}
              gazeReq={gazeReq}
            />
          ) : (
            <AnchorFieldMap
              cards={feed}
              onJumpToCard={(cardId) => {
                setSubview('context')
                setJumpCardId(cardId)
                // 跳到语境库后注视该视频卡（锁定框 + 广播给暗影系统）
                setGazeReq((prev) => ({ cardId, tick: (prev?.tick ?? 0) + 1 }))
              }}
            />
          )}
        </main>
      </div>

      {/* 转录回放悬浮窗：全局单实例，逐句点击通过事件唤起 */}
      <TranscriptPlayerWindow />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="DELETE CARD"
        danger
        question="删除这张想法卡？"
        details={pendingDelete ? [
          <span key="preview" style={{ color: theme.textSecondary }}>
            “{pendingDelete.text.length > 60 ? pendingDelete.text.slice(0, 59) + '…' : pendingDelete.text}”
          </span>,
          '卡上的锚定记录会一并删除，不可恢复。',
        ] : []}
        confirmLabel="删除"
        onConfirm={() => { void confirmRemove() }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

function ThoughtDock({
  draft,
  cards,
  showCompose,
  onDraftChange,
  onSubmit,
  onRemove,
  onJumpToContext,
  gazeReq,
}: {
  readonly draft: string
  readonly cards: readonly ContextFeedItem[]
  readonly showCompose: boolean
  readonly onDraftChange: (text: string) => void
  readonly onSubmit: () => void
  readonly onRemove: (id: string) => void
  readonly onJumpToContext?: (cardId: string) => void
  readonly gazeReq?: { cardId: string; tick: number } | null
}) {
  return (
    <section style={styles.flomoBoard}>
      <FlomoSidebar cards={cards} />
      <FlomoMain
        draft={draft}
        cards={cards}
        showCompose={showCompose}
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
        onRemove={onRemove}
        onJumpToContext={onJumpToContext}
        gazeReq={gazeReq}
      />
    </section>
  )
}

// ── 左侧栏：想法 / 语境 / 天 统计 ────────
function FlomoSidebar({ cards }: { readonly cards: readonly ContextFeedItem[] }) {
  const thoughtCount = cards.filter((c) => c.kind === 'thought').length
  const biliCount = cards.filter((c) => c.kind === 'bili_transcript').length
  const days = useMemo(() => {
    const set = new Set(cards.map((c) => dayKeyFromIso(c.created_at)))
    return Math.max(1, set.size)
  }, [cards])

  return (
    <aside style={styles.flomoSidebar}>
      <div style={styles.statsRow}>
        <Stat value={thoughtCount} label="想法" />
        <Stat value={biliCount} label="语境" />
        <Stat value={days} label="天" />
      </div>

      <button type="button" style={styles.navItemActive}>
        <span style={styles.navDot} />全部
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
  showCompose,
  onDraftChange,
  onSubmit,
  onRemove,
  onJumpToContext,
  gazeReq,
}: {
  readonly draft: string
  readonly cards: readonly ContextFeedItem[]
  readonly showCompose: boolean
  readonly onDraftChange: (text: string) => void
  readonly onSubmit: () => void
  readonly onRemove: (id: string) => void
  readonly onJumpToContext?: (cardId: string) => void
  readonly gazeReq?: { cardId: string; tick: number } | null
}) {
  const [focused, setFocused] = useState(false)
  // 锁定卡（粘性悬浮）：移开鼠标不熄灭，直到悬浮别的卡或离开本界面；
  // 整个 feed 共享一个 id，锁定框才能跨卡滑动跟随
  const [hoveredCard, setHoveredCard] = useState<string | null>(null)
  const expanded = focused || draft.trim().length > 0
  const dayGroups = useMemo(() => groupFeedItems(cards), [cards])

  // 锚点域点视频标题跳来 → 注视锁定该卡（tick 变即重锁，等卡进入 feed 后生效）
  useEffect(() => {
    if (!gazeReq) return
    if (cards.some((c) => c.id === gazeReq.cardId)) setHoveredCard(gazeReq.cardId)
  }, [gazeReq, cards])

  // 锁定的卡广播给右侧暗影系统（注入聊天上下文，主人说"这张卡片"AI 立刻知道）
  useEffect(() => {
    if (!hoveredCard) return
    const card = cards.find((c) => c.id === hoveredCard)
    if (!card) {
      // 卡被删了：解除锁定并清掉广播
      setHoveredCard(null)
      window.dispatchEvent(new CustomEvent('solevup:card-focus', { detail: { clear: true } }))
      return
    }
    window.dispatchEvent(new CustomEvent('solevup:card-focus', {
      detail: {
        cardId: card.id,
        kind: card.kind,
        title: card.title,
        text: card.text,
        sourceLabel: card.source_label,
        refPath: card.ref_path, // B 站卡的转录文件路径（注视即锚定要后台拉全文）
      },
    }))
  }, [hoveredCard, cards])

  // 离开本界面（切 tab / 切页面卸载）→ 解除锁定广播
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('solevup:card-focus', { detail: { clear: true } }))
  }, [])

  // 右侧聊天栏"取消注视"也走 card-focus 的 clear 语义 → 本地锁定框跟着熄灭
  useEffect(() => {
    const onFocusEvent = (e: Event) => {
      const d = (e as CustomEvent).detail as { clear?: boolean } | undefined
      if (d?.clear) setHoveredCard(null)
    }
    window.addEventListener('solevup:card-focus', onFocusEvent)
    return () => window.removeEventListener('solevup:card-focus', onFocusEvent)
  }, [])

  return (
    <div style={styles.flomoMain}>
      <style>{`
        .torrent-feed-scroll::-webkit-scrollbar {
          width: 0;
          height: 0;
          display: none;
        }
        .torrent-sentence-row {
          border-left: 2px solid transparent;
          transition: background 0.15s, border-color 0.15s;
        }
        .torrent-sentence-row:hover {
          background: ${theme.electricBlue}0D;
        }
        .torrent-sentence-row.is-active {
          border-left-color: ${theme.electricBlue};
          background: ${theme.electricBlue}10;
        }
      `}</style>
      {showCompose && (
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
            <Tooltip content="Ctrl+Enter 发送">
              <button
                type="button"
                onClick={onSubmit}
                disabled={!draft.trim()}
                style={{
                  ...styles.composerSend,
                  opacity: draft.trim() ? 1 : 0.35,
                  cursor: draft.trim() ? 'pointer' : 'default',
                }}
              >
                <Send size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      <div className="torrent-feed-scroll" style={styles.feed}>
        {cards.length === 0 ? (
          <div style={styles.feedEmpty}>
            {showCompose ? '写一句留下来。' : '还没有语境卡。转录 B 站视频、或在「想法卡片」里写一句，都会汇入这里。'}
          </div>
        ) : (
          dayGroups.map((group) => (
            <section key={group.key} style={styles.daySection}>
              <div style={styles.dayHeader}>
                <span style={styles.dayHeaderTitle}>{formatDayHeading(group.date)}</span>
                <span style={styles.dayHeaderCount}>{group.cards.length} CARD</span>
              </div>
              <div style={styles.dayMemoStack}>
                {group.cards.map((card) => (
                  <CardHoverEffect
                    key={card.id}
                    layoutId="torrent-card-hover"
                    active={hoveredCard === card.id}
                    onEnter={() => setHoveredCard(card.id)}
                  >
                    {card.kind === 'bili_transcript'
                      ? <BiliContextCard item={card} />
                      : <ThoughtMemoCard item={card} onRemove={onRemove} onJumpToContext={onJumpToContext} />}
                  </CardHoverEffect>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

// ── 锚点 hook：加载卡上的绑定 + 删除（框选创建已下线，新建走聊天锚定/Fairy 工具）──
function useCardAnchors(cardId: string, enabled: boolean) {
  const [bindings, setBindings] = useState<AnchorBinding[]>([])

  const reload = useCallback(async () => {
    if (!enabled) return
    try { setBindings(await fetchCardBindings(cardId)) }
    catch (e) { console.error('[Anchor] 加载锚点失败', e) }
  }, [cardId, enabled])

  useEffect(() => { void reload() }, [reload])

  // 锚点句被编辑（手动/AI）时高亮上的锚点实时刷新
  useEffect(() => {
    const onUpdate = () => { void reload() }
    window.addEventListener('solevup:context-updated', onUpdate)
    return () => window.removeEventListener('solevup:context-updated', onUpdate)
  }, [reload])

  const remove = useCallback(async (id: string) => {
    try { await deleteBinding(id); await reload() }
    catch (e) { console.error('[Anchor] 删除失败', e) }
  }, [reload])

  return { bindings, remove }
}

// ── 想法卡片（你的话；纯文本 + 锚点标签，不可框选、不进语境库）────
// 编辑态锚点草稿：id=null 表示本次新增（保存时才落库）
interface DraftAnchor { id: string | null; keyword: string; category: AnchorCategory }

const CAT_ORDER: readonly AnchorCategory[] = ['motive', 'view', 'practice']

function ThoughtMemoCard({ item, onRemove, onJumpToContext }: {
  readonly item: ContextFeedItem
  readonly onRemove: (id: string) => void
  readonly onJumpToContext?: (cardId: string) => void
}) {
  const [bindings, setBindings] = useState<AnchorBinding[]>([])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftAnchors, setDraftAnchors] = useState<DraftAnchor[]>([])
  const [saving, setSaving] = useState(false)

  const anchors = useMemo<AnchorRef[]>(() => {
    const seen = new Set<string>()
    return bindings.flatMap((b) => b.anchors).filter((a) => {
      if (seen.has(a.id)) return false
      seen.add(a.id)
      return true
    })
  }, [bindings])

  useEffect(() => {
    let alive = true
    const load = () => {
      fetchCardBindings(item.id)
        .then((bs) => { if (alive) setBindings(bs) })
        .catch(() => {})
    }
    load()
    // 锚点句被编辑（手动/AI）时 chips 实时刷新——feed 重拉不会换 item.id，必须自己监听
    window.addEventListener('solevup:context-updated', load)
    return () => {
      alive = false
      window.removeEventListener('solevup:context-updated', load)
    }
  }, [item.id])

  const beginEdit = () => {
    setDraft(item.text)
    setDraftAnchors(anchors.map((a) => ({ id: a.id, keyword: a.keyword, category: a.category })))
    setEditing(true)
  }

  const saveEdit = async () => {
    const text = draft.trim()
    if (!text) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      if (text !== item.text) await updateContextCard(item.id, text)

      // 锚点草稿 diff：已有的改句子/类别走 PATCH；新增的挂到整卡绑定（没有就先建）
      const origById = new Map(anchors.map((a) => [a.id, a]))
      let bindingId = bindings.find((b) => b.start_pos === 0)?.id ?? bindings[0]?.id ?? null
      for (const d of draftAnchors) {
        const kw = d.keyword.trim()
        if (d.id) {
          const orig = origById.get(d.id)
          if (!orig) continue
          const patch: { keyword?: string; category?: AnchorCategory } = {}
          if (kw && kw !== orig.keyword) patch.keyword = kw
          if (d.category !== orig.category) patch.category = d.category
          if (patch.keyword !== undefined || patch.category !== undefined) await updateAnchor(d.id, patch)
        } else if (kw) {
          if (bindingId) {
            await addAnchorToBinding(bindingId, kw, d.category)
          } else {
            const created = await addBinding({
              card_id: item.id, start_pos: 0, end_pos: text.length,
              selected_text: text, user_speech: text,
              anchors: [{ keyword: kw, category: d.category }],
            })
            bindingId = created.id
          }
        }
      }

      setEditing(false)
      window.dispatchEvent(new CustomEvent('solevup:context-updated'))
    } catch (e) {
      console.error('[Torrent] 更新想法卡失败', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <article
      id={`torrent-card-${item.id}`}
      style={{ ...styles.memoCard, ...(editing ? styles.memoCardEditing : null) }}
    >
      <div style={styles.memoMeta}>
        <span style={{ flexShrink: 0 }}>{formatTimeOnly(item.created_at)}</span>
        {/* 语境标签完整显示（超宽省略）；有来源卡 id 时可点击跳转到语境库对应卡 */}
        {item.source_label && (
          item.source_card_id && onJumpToContext ? (
            // wrapStyle 必须给 Tooltip 包裹层：flex 收缩约束打在内层按钮上没用，
            // 包裹层 min-width:auto 不肯收缩会撑出右边界、挤掉编辑/删除按钮
            <Tooltip content="跳转到语境卡" display="flex" wrapStyle={{ minWidth: 0, flexShrink: 1 }}>
              <button
                type="button"
                onClick={() => onJumpToContext(item.source_card_id!)}
                style={styles.memoSourceLink}
                onMouseEnter={(e) => (e.currentTarget.style.color = theme.electricBlue)}
                onMouseLeave={(e) => (e.currentTarget.style.color = theme.textMuted)}
              >
                · {item.source_label}
              </button>
            </Tooltip>
          ) : (
            <span style={styles.memoSourceText}>· {item.source_label}</span>
          )
        )}
        <span style={{ flex: 1 }} />
        {!editing && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Tooltip content="编辑">
              <button
                type="button"
                onClick={beginEdit}
                style={styles.memoDelete}
              >
                <Pencil size={11} />
              </button>
            </Tooltip>
            <Tooltip content="删除">
              <button type="button" onClick={() => onRemove(item.id)} style={styles.memoDelete}>×</button>
            </Tooltip>
          </span>
        )}
      </div>
      {editing ? (
        <>
          {/* flomo 式无缝行内编辑：正文原位变可写，无边框方盒 */}
          <textarea
            value={draft}
            autoFocus
            rows={Math.max(3, draft.split('\n').length + 1)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void saveEdit()
              if (e.key === 'Escape') setEditing(false)
            }}
            style={styles.memoEditArea}
          />
          {/* 字数居左、取消/确认居右；整行收紧贴近下方锚点句 chips */}
          <div style={styles.memoEditBar}>
            <span style={styles.memoEditCount}>{draft.trim().length} 字</span>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => setEditing(false)} style={styles.memoEditCancel}>取消</button>
            <Tooltip content="保存 · Ctrl+Enter">
              <button
                type="button"
                onClick={() => void saveEdit()}
                disabled={!draft.trim() || saving}
                style={{ ...styles.memoEditSave, opacity: !draft.trim() || saving ? 0.4 : 1 }}
              >
                <Check size={14} />
              </button>
            </Tooltip>
          </div>
        </>
      ) : (
        <p style={styles.memoBody}>{item.text}</p>
      )}
      {editing ? (
        // 编辑态锚点草稿：点类别前缀循环切换、点句子原位改字、+ 新增；取消全不保存，打勾才落库
        <div style={styles.anchorChips}>
          {draftAnchors.map((d, i) => (
            <EditableAnchorChip
              key={d.id ?? `new-${i}`}
              value={d}
              onCycleCategory={() => setDraftAnchors((prev) => prev.map((x, j) =>
                j === i ? { ...x, category: CAT_ORDER[(CAT_ORDER.indexOf(x.category) + 1) % CAT_ORDER.length] } : x))}
              onKeywordChange={(kw) => setDraftAnchors((prev) => prev.map((x, j) =>
                j === i ? { ...x, keyword: kw } : x))}
            />
          ))}
          <Tooltip content="添加锚点句">
            <button
              type="button"
              onClick={() => setDraftAnchors((prev) => [...prev, { id: null, keyword: '', category: 'motive' }])}
              style={styles.anchorAddBtn}
            >
              <Plus size={11} />
            </button>
          </Tooltip>
        </div>
      ) : (
        anchors.length > 0 && (
          <div style={styles.anchorChips}>
            {anchors.map((a) => (
              <AnchorChip key={a.id} anchor={a} />
            ))}
          </div>
        )
      )}
    </article>
  )
}

// ── 编辑态锚点 chip：类别段可点循环切换，句子段原位 input ────────
function EditableAnchorChip({ value, onCycleCategory, onKeywordChange }: {
  readonly value: DraftAnchor
  readonly onCycleCategory: () => void
  readonly onKeywordChange: (kw: string) => void
}) {
  const c = ANCHOR_CAT_COLOR[value.category]
  // 动态估宽：CJK 按 1em、ASCII 按 0.55em，外加余量（mono 小字号下足够准）
  const w = Math.max(5, value.keyword.split('').reduce(
    (acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 1 : 0.55), 0) + 1.5)
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'stretch',
      maxWidth: '100%',
      borderRadius: 3,
      overflow: 'hidden',
      border: `1px solid ${c}55`,
      fontFamily: theme.fontMono,
      fontSize: 10.5,
      lineHeight: 1.5,
    }}>
      <Tooltip content="切换类别" display="flex">
        <button
          type="button"
          onClick={onCycleCategory}
          style={{
            display: 'flex', alignItems: 'center',
            background: c, color: '#051018',
            fontWeight: 700, padding: '1px 5px', letterSpacing: '0.08em',
            flexShrink: 0, border: 'none', cursor: 'pointer',
            fontFamily: theme.fontMono, fontSize: 10.5,
          }}
        >
          {ANCHOR_CAT_SHORT[value.category]}
        </button>
      </Tooltip>
      <input
        value={value.keyword}
        placeholder="锚点句…"
        autoFocus={value.id === null && !value.keyword}
        onChange={(e) => onKeywordChange(e.target.value)}
        style={{
          background: `${c}14`, color: c,
          padding: '1px 7px', border: 'none', outline: 'none',
          fontFamily: theme.fontMono, fontSize: 10.5,
          // content-box：估宽只管文字，padding 在宽度之外，不削尾字
          boxSizing: 'content-box',
          width: `${w}em`, maxWidth: 280, minWidth: 0,
        }}
      />
    </span>
  )
}

// ── B 站转录语境卡（封面 + 标题 + 摘要 + 展开逐句转录）────────────

/** 把整文坐标系的绑定切片平移到某一句的局部坐标系（句内无交集则过滤掉） */
function sliceBindingsForSentence(
  bindings: readonly AnchorBinding[], offset: number, len: number,
): AnchorBinding[] {
  return bindings
    .filter((b) => b.start_pos < offset + len && b.end_pos > offset)
    .map((b) => ({
      ...b,
      start_pos: Math.max(0, b.start_pos - offset),
      end_pos: Math.min(len, b.end_pos - offset),
    }))
}

function fmtStamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

function BiliContextCard({ item }: { readonly item: ContextFeedItem }) {
  const [expanded, setExpanded] = useState(false)
  const [sentences, setSentences] = useState<TranscriptSentence[] | null>(null)
  const [loading, setLoading] = useState(false)
  // 悬浮窗播放进度 → 点亮当前句
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const fullText = useMemo(
    () => (sentences ? sentences.map((s) => s.text).join('') : null),
    [sentences],
  )
  // 始终加载锚点：折叠态也要知道这张卡有没有标记（突出显示 + 关键词 chips）
  const a = useCardAnchors(item.id, true)
  const marked = a.bindings.length > 0
  // 折叠态展示去重后的锚点关键词
  const markedAnchors = useMemo(() => {
    const seen = new Set<string>()
    return a.bindings.flatMap((b) => b.anchors).filter((an) => {
      if (seen.has(an.id)) return false
      seen.add(an.id)
      return true
    })
  }, [a.bindings])

  // 展开转录 → 把这张设为「当前对话语境卡」，右侧栏聊天会锚定到它
  useEffect(() => {
    if (expanded && fullText) {
      window.dispatchEvent(new CustomEvent('solevup:active-context', {
        detail: { cardId: item.id, text: fullText, title: item.title ?? item.bvid ?? '语境卡' },
      }))
    } else {
      window.dispatchEvent(new CustomEvent('solevup:active-context', {
        detail: { cardId: item.id, clear: true },
      }))
    }
  }, [expanded, fullText, item.id, item.title, item.bvid])

  const toggle = async () => {
    if (loading) return
    if (!expanded && sentences === null && item.ref_path) {
      setLoading(true)
      const list = await fetchBiliTranscriptSentences(item.ref_path)
      setSentences(list ?? [{ text: '（无转录文本）', start: null, offset: 0 }])
      setLoading(false)
    }
    setExpanded((v) => !v)
  }

  // 悬浮窗播放进度 → 找到最后一句 start <= 当前秒的句子点亮
  useEffect(() => {
    if (!expanded || !sentences) return
    const onTime = (e: Event) => {
      const d = (e as CustomEvent).detail as { refPath?: string | null; sec?: number } | undefined
      if (!d || d.refPath !== item.ref_path || typeof d.sec !== 'number') {
        setActiveIdx(null)
        return
      }
      let idx: number | null = null
      for (let i = 0; i < sentences.length; i++) {
        const st = sentences[i].start
        if (st !== null && st <= d.sec) idx = i
      }
      setActiveIdx(idx)
    }
    window.addEventListener('solevup:transcript-time', onTime)
    return () => window.removeEventListener('solevup:transcript-time', onTime)
  }, [expanded, sentences, item.ref_path])

  // 整句点击 → 唤起/复用转录回放悬浮窗并 seek 到句首
  const playSentence = (s: TranscriptSentence) => {
    if (!item.ref_path) return
    window.dispatchEvent(new CustomEvent('solevup:transcript-play', {
      detail: { refPath: item.ref_path, title: item.title, sec: s.start },
    }))
  }

  const coverSrc = item.cover_url
    ? `http://localhost:49733/api/bilibili/cover?url=${encodeURIComponent(item.cover_url)}`
    : null

  const canExpand = Boolean(item.ref_path)

  return (
    <article id={`torrent-card-${item.id}`} style={{ ...styles.biliCard, ...(marked ? styles.biliCardMarked : null) }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* 封面 + 标题：点击直达 B 站历史的详情+转录面板 */}
        <Tooltip content="打开 B 站历史详情与转录面板" disabled={!item.bvid} display="flex">
          <div
            onClick={item.bvid ? () => {
              window.dispatchEvent(new CustomEvent('solevup:open-bili-detail', { detail: { bvid: item.bvid } }))
            } : undefined}
            style={{ ...styles.biliHead, flex: 1, cursor: item.bvid ? 'pointer' : 'default' }}
          >
            {coverSrc && <img src={coverSrc} alt="" style={styles.biliCover} referrerPolicy="no-referrer" />}
            <div style={styles.biliHeadText}>
              <div style={styles.biliKind}>
                B站转录 · {formatTimeOnly(item.created_at)}
                {marked && <span style={styles.anchorBadge}>◆ {a.bindings.length} 处锚点</span>}
              </div>
              <div style={styles.biliTitle}>{item.title ?? item.bvid ?? '未知视频'}</div>
            </div>
          </div>
        </Tooltip>

        {/* 折叠态：摘要区点击展开转录 */}
        {!expanded && (
          <Tooltip
            content="点击展开转录"
            disabled={!canExpand}
            display="flex"
            wrapStyle={{ flexDirection: 'column' }}
          >
            <div
              onClick={canExpand ? toggle : undefined}
              style={{ display: 'flex', flexDirection: 'column', gap: 8, cursor: canExpand ? 'pointer' : 'default' }}
            >
              <p style={{ ...styles.biliSummary, ...(canExpand ? styles.biliPreviewFade : null) }}>
                {item.text + (item.text.length >= 150 ? '…' : '')}
              </p>
              {markedAnchors.length > 0 && (
                <div style={styles.anchorChips}>
                  {markedAnchors.map((an) => (
                    <AnchorChip key={an.id} anchor={an} />
                  ))}
                </div>
              )}
              {canExpand && (
                <div style={styles.biliPreviewHint}>
                  {loading ? '加载中…' : <>展开转录 <ChevronDown size={12} /></>}
                </div>
              )}
            </div>
          </Tooltip>
        )}
      </div>

      {expanded && sentences !== null && (
        <>
          {/* 逐句转录：时间戳 + 句子（锚点高亮按句切片）；整句点击 → 悬浮窗跳播 */}
          <div style={styles.transcriptList}>
            {sentences.map((s, i) => (
              <div
                key={`${s.offset}-${i}`}
                className={`torrent-sentence-row${activeIdx === i ? ' is-active' : ''}`}
                onClick={item.ref_path ? () => playSentence(s) : undefined}
                style={{
                  ...styles.sentenceRow,
                  cursor: item.ref_path ? 'pointer' : 'default',
                }}
              >
                <span style={{
                  ...styles.sentenceStamp,
                  ...(activeIdx === i ? styles.sentenceStampActive : null),
                }}>
                  {s.start !== null ? fmtStamp(s.start) : '--:--'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <AnchorTextRenderer
                    text={s.text}
                    bindings={sliceBindingsForSentence(a.bindings, s.offset, s.text.length)}
                    onRemoveBinding={a.remove}
                  />
                </div>
              </div>
            ))}
          </div>
          <button type="button" style={styles.biliCollapseBar} onClick={toggle}>
            收起 <ChevronUp size={12} />
          </button>
        </>
      )}
    </article>
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
  // 安静深底（flomo 式）：不抢内容的戏，只留极淡的顶部冷光
  backdrop: {
    position: 'absolute',
    inset: 0,
    background: `
      radial-gradient(ellipse at 50% -10%, rgba(90,160,210,0.05), transparent 55%),
      linear-gradient(180deg, rgba(4,9,20,0.96), rgba(1,3,8,0.98))
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
    paddingTop: 0, // 不留缝：sticky 日期头要贴住滚动口顶边，padding 会露出滚动内容
    paddingBottom: FEED_BOTTOM_PAD,
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
    // 近实底 + 毛玻璃：之前 0.78 透明度会让滚过的卡片文字从表头底下透出来（"标题有缝"观感）
    background: 'linear-gradient(180deg, rgba(3,10,22,0.99), rgba(3,10,22,0.92))',
    backdropFilter: 'blur(5px)',
    WebkitBackdropFilter: 'blur(5px)',
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
    gap: 0, // 卡片间距由 CardHoverEffect 的 pad(6)×2 提供，保持原 12px 视觉间距
  },
  // flomo 式卡片：圆角 + 投影 + 呼吸内距（chamfer 裁切会剪掉阴影，卡片感尽失，弃用）
  memoCard: {
    padding: '13px 16px',
    // 必须用 longhand：编辑态用 borderColor 覆盖，shorthand 混用会在退出编辑时
    // 被 React 清空 borderColor 回落到 currentcolor（白框 bug）
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'rgba(120,170,220,0.14)',
    background: 'linear-gradient(180deg, rgba(14,24,40,0.92), rgba(9,16,28,0.90))',
    borderRadius: 10,
    boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    scrollSnapAlign: 'start',
    scrollSnapStop: 'always',
    scrollMarginTop: 8,
    transition: 'border-color 0.18s, box-shadow 0.18s',
  },
  // 编辑中：边框与投影亮起（flomo 编辑态的绿框语义，用本面板的 flameTeal）
  memoCardEditing: {
    borderColor: `${theme.flameTeal}77`,
    boxShadow: `0 2px 14px rgba(0,0,0,0.42), 0 0 0 1px ${theme.flameTeal}30`,
  },
  memoEditArea: {
    border: 'none',
    outline: 'none',
    background: 'transparent',
    resize: 'none',
    width: '100%',
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    fontSize: 14,
    lineHeight: 1.7,
    padding: 0,
  },
  memoEditBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingTop: 2,
  },
  memoEditCount: {
    fontSize: 10,
    color: theme.textMuted,
    fontFamily: theme.fontMono,
    letterSpacing: '0.06em',
  },
  memoEditCancel: {
    border: 'none',
    background: 'transparent',
    color: theme.textMuted,
    fontFamily: theme.fontBody,
    fontSize: 12,
    padding: '4px 8px',
    cursor: 'pointer',
  },
  memoEditSave: {
    width: 32,
    height: 26,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 7,
    background: theme.flameTeal,
    color: theme.background,
    cursor: 'pointer',
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
  // 语境来源标签：完整显示、超宽省略；可点击形态继承字色，hover 转电蓝
  memoSourceLink: {
    border: 'none',
    background: 'transparent',
    color: theme.textMuted,
    fontFamily: theme.fontMono,
    fontSize: 10,
    letterSpacing: '0.1em',
    padding: 0,
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    flexShrink: 1,
    transition: 'color 0.15s',
  },
  memoSourceText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    flexShrink: 1,
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
  // ── B 站转录语境卡 ──
  biliCard: {
    padding: '12px 16px 13px',
    border: `1px solid ${theme.electricBlue}30`,
    background: 'linear-gradient(180deg, rgba(8,28,40,0.90), rgba(7,15,27,0.90))',
    borderRadius: 10,
    boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    transition: 'border-color 0.18s, box-shadow 0.18s',
  },
  biliHead: {
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
  },
  biliCover: {
    width: 88,
    height: 55,
    objectFit: 'cover',
    flexShrink: 0,
    border: `1px solid ${theme.hudFrameSoft}`,
    borderRadius: 2,
  },
  biliHeadText: {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  biliKind: {
    fontFamily: theme.fontMono,
    fontSize: 9.5,
    letterSpacing: '0.14em',
    color: theme.electricBlue,
  },
  biliTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: theme.textPrimary,
    lineHeight: 1.4,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  biliSummary: {
    margin: 0,
    color: theme.textSecondary,
    fontSize: 12.5,
    lineHeight: 1.65,
    whiteSpace: 'pre-wrap',
  },
  // 有锚点标记的语境卡：神秘紫描边 + 内里紫色微光（呼应锚点渐变框）
  biliCardMarked: {
    borderColor: 'rgba(168,85,247,0.55)',
    background: 'linear-gradient(180deg, rgba(124,58,237,0.10), rgba(0,0,0,0.30))',
  },
  anchorBadge: {
    marginLeft: 8,
    color: 'rgb(192,132,252)',
    fontSize: 9.5,
    letterSpacing: '0.12em',
    textShadow: '0 0 8px rgba(168,85,247,0.6)',
  },
  // 折叠预览：底部渐隐（mask 渐变），暗示下面还有内容
  biliPreviewFade: {
    maxHeight: 88,
    overflow: 'hidden',
    WebkitMaskImage: 'linear-gradient(180deg, #000 40%, transparent 98%)',
    maskImage: 'linear-gradient(180deg, #000 40%, transparent 98%)',
  },
  biliPreviewHint: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: -4,
    color: theme.electricBlue,
    fontFamily: theme.fontBody,
    fontSize: 11,
    letterSpacing: '0.08em',
    opacity: 0.85,
  },
  // 收起胶囊：sticky 吸底（同 dayHeader 吸顶语义）——展开很长时不用滚到卡尾也能收起。
  // bottom 把 FEED_BOTTOM_PAD 补回去再抬 8px，悬浮在可视底边上方；
  // 居中小胶囊形态：浮在转录上像 HUD 控件，落回卡尾也自然
  biliCollapseBar: {
    position: 'sticky',
    bottom: 8 - FEED_BOTTOM_PAD,
    zIndex: 2,
    alignSelf: 'center',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    border: `1px solid ${theme.electricBlue}55`,
    borderRadius: 999,
    background: 'rgba(7,15,27,0.93)',
    boxShadow: `0 4px 14px rgba(0,0,0,0.55), 0 0 10px ${theme.electricBlue}26`,
    color: theme.electricBlue,
    fontFamily: theme.fontMono,
    fontSize: 10.5,
    letterSpacing: '0.12em',
    padding: '4px 16px',
    cursor: 'pointer',
  },
  anchorChips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 8,
  },
  // 编辑态"添加锚点句"按钮：虚线空 chip
  anchorAddBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    alignSelf: 'stretch',
    borderRadius: 3,
    border: `1px dashed ${theme.textMuted}66`,
    background: 'transparent',
    color: theme.textMuted,
    cursor: 'pointer',
    padding: 0,
  },
  // ── 逐句转录（可调旋钮：行距 / 时间戳列宽 / 字号）──
  transcriptList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    color: theme.textSecondary,
    fontSize: 12.5,
  },
  sentenceRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 9,
    padding: '2px 6px 2px 4px',
    borderRadius: 3,
  },
  sentenceStamp: {
    flexShrink: 0,
    width: 38,
    textAlign: 'right',
    fontFamily: theme.fontMono,
    fontSize: 10,
    letterSpacing: '0.05em',
    color: `${theme.electricBlue}88`,
    userSelect: 'none',
  },
  sentenceStampActive: {
    color: theme.electricBlue,
    textShadow: `0 0 8px ${theme.electricBlue}99`,
  },
}
