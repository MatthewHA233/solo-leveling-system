// 锚点页正文下面的「引用」：别的页面里哪些地方指向了这个锚点，按来源页面分组。
//   引用在批注里：列你的批注和它涂上的那片原文；不在批注里：列那一块的文字。点一条跳回原处。

import { useEffect, useMemo, useState } from 'react'
import { FileText } from 'lucide-react'
import { fetchAnchorBacklinks, type AnchorSentence, type Backlink } from '../../lib/notes-api'
import { formatNoteTime, pageTitle } from './note-model'
import { NOTES_INDEX_CHANGED_EVENT, openNotePage } from './notes-store'

/** 不在批注里的引用，那一块的文字最多显示多少字 */
const BLOCK_TEXT_MAX = 220
/** 「点到了哪一句」的提示里，句子最多显示多少字 */
const SENTENCE_HINT_MAX = 18
const RELOAD_DELAY_MS = 300

interface Group {
  readonly pageId: string
  readonly title: string
  readonly icon: string | null
  readonly items: readonly Backlink[]
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

export default function AnchorBacklinks({ anchorId, refreshKey, sentences }: {
  readonly anchorId: string
  /** 这一页自己存了一次就变（锚点句改了，「点到哪一句」的提示要跟着变） */
  readonly refreshKey: number
  readonly sentences: readonly AnchorSentence[]
}) {
  const [links, setLinks] = useState<readonly Backlink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 别的页面存了也可能多出 / 少掉引用：收到「索引变了」就重拉
  const [externalTick, setExternalTick] = useState(0)

  useEffect(() => {
    let timer: number | null = null
    const onChanged = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => setExternalTick((t) => t + 1), RELOAD_DELAY_MS)
    }
    window.addEventListener(NOTES_INDEX_CHANGED_EVENT, onChanged)
    return () => {
      if (timer != null) window.clearTimeout(timer)
      window.removeEventListener(NOTES_INDEX_CHANGED_EVENT, onChanged)
    }
  }, [])

  useEffect(() => {
    let alive = true
    fetchAnchorBacklinks(anchorId)
      .then((list) => {
        if (!alive) return
        setLinks(list)
        setError(null)
      })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [anchorId, refreshKey, externalTick])

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = []
    const at = new Map<string, number>()
    for (const link of links ?? []) {
      const i = at.get(link.pageId)
      if (i === undefined) {
        at.set(link.pageId, out.length)
        out.push({ pageId: link.pageId, title: link.pageTitle, icon: link.pageIcon, items: [link] })
      } else {
        out[i] = { ...out[i], items: [...out[i].items, link] }
      }
    }
    return out
  }, [links])

  const sentenceText = useMemo(() => new Map(sentences.map((s) => [s.blockId, s.text])), [sentences])

  return (
    <section className="nt-backlinks">
      <div className="nt-section nt-backlinks-head">
        <span className="nt-section-label">引用</span>
        {links && links.length > 0 && <span className="nt-count">{links.length}</span>}
        <span className="pt-section-rule" />
      </div>
      {error && <div className="nt-float-error">{error}</div>}
      {links && links.length === 0 && (
        <div className="nt-backlinks-empty">还没有地方引用这个锚点。在别的页面里打 # 就能引用它。</div>
      )}
      {groups.map((g) => (
        <div key={g.pageId} className="nt-bl-group">
          <button type="button" className="nt-bl-page" onClick={() => openNotePage(g.pageId)}>
            <span className="nt-crumb-icon">{g.icon ?? <FileText size={12} />}</span>
            <span className="nt-bl-page-title">{pageTitle({ title: g.title })}</span>
            <span className="nt-count">{g.items.length}</span>
          </button>
          {g.items.map((it) => {
            const pinned = it.sentenceId ? sentenceText.get(it.sentenceId) : undefined
            return (
              <button
                key={`${it.blockId}:${it.sentenceId}:${it.thoughtId}`}
                type="button"
                className="nt-bl-item"
                onClick={() => openNotePage(it.pageId, it.blockId)}
              >
                {it.thoughtId ? (
                  <>
                    {it.thoughtQuote && <span className="nt-bl-quote">{it.thoughtQuote}</span>}
                    <span className="nt-bl-thought">{it.thoughtText}</span>
                  </>
                ) : (
                  <span className="nt-bl-text">{clip(it.blockText, BLOCK_TEXT_MAX)}</span>
                )}
                <span className="nt-bl-meta">
                  {it.sentenceId && <span className="nt-bl-pin">点到：{pinned ? clip(pinned, SENTENCE_HINT_MAX) : '一条已不在的句子'}</span>}
                  <span>{formatNoteTime(it.createdAt)}</span>
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </section>
  )
}
