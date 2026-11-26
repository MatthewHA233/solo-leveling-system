// ══════════════════════════════════════════════
// 想法卡片：你自己写下的东西都收在这里，按时间倒序
//   两个来路：插在某一页里的批注（带着涂上的原文和所在的语境）；在这里直接写的（未关联语境，可以随时关联）
//   左边是每天写了几张的热力图，右边顶上直接写、下面是全部卡片。点卡片回到原处。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, FileText, Link2 } from 'lucide-react'
import {
  createThought, fetchThoughtHeatmap, fetchThoughts, updateNotePage,
  type ThoughtCard, type ThoughtDay,
} from '../../lib/notes-api'
import MoveToPicker from './MoveToPicker'
import { formatNoteTime, pageTitle } from './note-model'
import { announceIndexChanged, NOTES_INDEX_CHANGED_EVENT, openNotePage } from './notes-store'

const PAGE_SIZE = 60
/** 热力图画多少周 */
const HEAT_WEEKS = 20
const RELOAD_DELAY_MS = 300
/** 单独写的长文在卡片里最多露多少字，其余点开看 */
const CARD_TEXT_MAX = 420

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 一天写了几张 → 深浅档（0 = 没写） */
function heatLevel(count: number): number {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count <= 3) return 2
  if (count <= 6) return 3
  return 4
}

interface HeatCell {
  readonly key: string
  readonly count: number
  readonly future: boolean
}

/** 最近 HEAT_WEEKS 周，一列一周（周一在上），最后一列是本周 */
function buildHeatColumns(days: ReadonlyMap<string, number>, today: Date): HeatCell[][] {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  // 退到本周周一，再往前退 HEAT_WEEKS - 1 周
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (HEAT_WEEKS - 1) * 7)
  const todayKey = dayKey(today)
  const columns: HeatCell[][] = []
  for (let w = 0; w < HEAT_WEEKS; w += 1) {
    const col: HeatCell[] = []
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d)
      const key = dayKey(date)
      col.push({ key, count: days.get(key) ?? 0, future: key > todayKey })
    }
    columns.push(col)
  }
  return columns
}

export default function ThoughtsView() {
  const [cards, setCards] = useState<readonly ThoughtCard[]>([])
  const [heat, setHeat] = useState<readonly ThoughtDay[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [linking, setLinking] = useState<{ card: ThoughtCard; anchor: DOMRect } | null>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)

  const reload = useCallback(async () => {
    try {
      const [list, days] = await Promise.all([fetchThoughts({ limit: PAGE_SIZE }), fetchThoughtHeatmap('')])
      setCards(list)
      setHasMore(list.length >= PAGE_SIZE)
      setHeat(days)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  // 别处存了正文（多了 / 少了批注）：这里跟着重拉
  useEffect(() => {
    let timer: number | null = null
    const onChanged = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => { void reload() }, RELOAD_DELAY_MS)
    }
    window.addEventListener(NOTES_INDEX_CHANGED_EVENT, onChanged)
    return () => {
      if (timer != null) window.clearTimeout(timer)
      window.removeEventListener(NOTES_INDEX_CHANGED_EVENT, onChanged)
    }
  }, [reload])

  const loadMore = async () => {
    const last = cards[cards.length - 1]
    if (!last) return
    try {
      const more = await fetchThoughts({ before: last.createdAt, limit: PAGE_SIZE })
      const seen = new Set(cards.map((c) => c.id))
      setCards([...cards, ...more.filter((c) => !seen.has(c.id))])
      setHasMore(more.length >= PAGE_SIZE)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const submit = async () => {
    const text = draft.trim()
    if (!text || saving) return
    setSaving(true)
    try {
      await createThought(text)
      setDraft('')
      announceIndexChanged()
      await reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
      draftRef.current?.focus()
    }
  }

  const link = async (card: ThoughtCard, target: string) => {
    try {
      await updateNotePage(card.id, { contextPageId: target })
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  // 输入框跟着内容长高
  useEffect(() => {
    const el = draftRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [draft])

  const dayCounts = useMemo(() => new Map(heat.map((d) => [d.day, d.count])), [heat])
  const today = useMemo(() => new Date(), [])
  const columns = useMemo(() => buildHeatColumns(dayCounts, today), [dayCounts, today])
  const total = useMemo(() => heat.reduce((n, d) => n + d.count, 0), [heat])
  const todayCount = dayCounts.get(dayKey(today)) ?? 0

  return (
    <div className="nt-thoughts">
      <aside className="nt-thoughts-side">
        <div className="nt-thoughts-title">想法卡片</div>
        <div className="nt-thoughts-stats">
          <div><span className="nt-thoughts-num">{total}</span><span className="nt-thoughts-unit">张</span></div>
          <div><span className="nt-thoughts-num">{heat.length}</span><span className="nt-thoughts-unit">天写过</span></div>
          <div><span className="nt-thoughts-num">{todayCount}</span><span className="nt-thoughts-unit">今天</span></div>
        </div>
        <div className="nt-heat" aria-label="每天写了几张">
          {columns.map((col) => (
            <div key={col[0].key} className="nt-heat-col">
              {col.map((cell) => (
                <span
                  key={cell.key}
                  className="nt-heat-cell"
                  data-level={cell.future ? undefined : heatLevel(cell.count)}
                  data-future={cell.future ? '1' : undefined}
                  aria-label={`${cell.key}：${cell.count} 张`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="nt-thoughts-note">
          在任何一页里选中一片字、点「批注」，写下的话就是一张想法卡片，会带着那片原文出现在这里。
        </div>
      </aside>

      <main className="nt-thoughts-main">
        <div className="nt-compose">
          <textarea
            ref={draftRef}
            className="nt-compose-input"
            rows={1}
            value={draft}
            placeholder="直接写一条（没贴着任何语境，以后可以随时关联）"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div className="nt-compose-foot">
            <span className="ti-keycap nt-keycap">Ctrl Enter</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="ti-key ti-key-primary nt-foot-key" disabled={!draft.trim() || saving}
              onClick={() => { void submit() }}>
              {saving ? '正在记…' : '记下'}
            </button>
          </div>
        </div>

        {error && <div className="nt-float-error">{error}</div>}
        {!loading && cards.length === 0 && !error && (
          <div className="nt-thoughts-empty">还没有想法卡片。上面直接写一条，或者去某一页里批注。</div>
        )}

        {cards.map((card) => (
          <article key={card.id} className="nt-card" data-origin={card.origin}>
            <header className="nt-card-head">
              <span className="nt-card-time">{formatNoteTime(card.createdAt)}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="nt-row-key" style={{ opacity: 1 }} aria-label="回到原处"
                onClick={() => openNotePage(card.pageId, card.blockId || undefined)}>
                <ArrowUpRight size={13} />
              </button>
            </header>
            {card.quote && <blockquote className="nt-card-quote">{card.quote}</blockquote>}
            <div className="nt-card-text">
              {card.text.length > CARD_TEXT_MAX ? `${card.text.slice(0, CARD_TEXT_MAX)}…` : card.text}
            </div>
            <footer className="nt-card-foot">
              {card.contextPageId ? (
                <button type="button" className="nt-context-chip"
                  onClick={() => openNotePage(card.contextPageId ?? card.pageId, card.origin === 'inline' ? card.blockId : undefined)}>
                  <span className="nt-crumb-icon">{card.contextIcon ?? <FileText size={12} />}</span>
                  {pageTitle({ title: card.contextTitle })}
                </button>
              ) : (
                <>
                  <span className="nt-kind-note">未关联语境</span>
                  <button type="button" className="nt-ghost-key"
                    onClick={(e) => setLinking({ card, anchor: e.currentTarget.getBoundingClientRect() })}>
                    <Link2 size={12} />关联语境
                  </button>
                </>
              )}
              {card.anchors.map((a) => (
                <button key={a.id} type="button" className="nt-anchor-ref" onClick={() => openNotePage(a.id)}>
                  #{pageTitle(a)}
                </button>
              ))}
            </footer>
          </article>
        ))}

        {hasMore && (
          <button type="button" className="ti-key nt-foot-key nt-thoughts-more" onClick={() => { void loadMore() }}>
            更早的
          </button>
        )}
      </main>

      {linking && (
        <MoveToPicker
          anchor={linking.anchor}
          title="关联到哪个语境"
          excludeId={linking.card.id}
          onPick={(target) => { void link(linking.card, target) }}
          onClose={() => setLinking(null)}
        />
      )}
    </div>
  )
}
