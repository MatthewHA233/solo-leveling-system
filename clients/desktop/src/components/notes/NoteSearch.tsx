// ══════════════════════════════════════════════
// 笔记快速查找（Ctrl+P，和 Notion 一样）：没输入时列最近编辑的页面，输入后全文搜标题 + 正文
//   ↑↓ 选、回车打开、Esc 关
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Search } from 'lucide-react'
import { searchNotes, type NotePageMeta, type NoteSearchHit } from '../../lib/notes-api'
import { ancestorsOf, formatNoteTime, pageTitle, type PageIndex } from './note-model'

const RECENT_LIMIT = 12
const SEARCH_DEBOUNCE_MS = 140

interface Row {
  readonly meta: NotePageMeta
  readonly snippet: string
}

export default function NoteSearch({ index, onOpen, onClose }: {
  readonly index: PageIndex
  readonly onOpen: (id: string) => void
  readonly onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<readonly NoteSearchHit[]>([])
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const q = query.trim()

  useEffect(() => {
    // 清空输入时不用清结果：没输入时列表走「最近编辑」，旧结果不会显示
    if (!q) return
    let alive = true
    const timer = window.setTimeout(() => {
      searchNotes(q)
        .then((r) => { if (alive) { setHits(r); setError(null) } })
        .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    }, SEARCH_DEBOUNCE_MS)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [q])

  const rows: readonly Row[] = useMemo(() => {
    if (q) return hits.map((h) => ({ meta: h, snippet: h.snippet }))
    return [...index.byId.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, RECENT_LIMIT)
      .map((m) => ({ meta: m, snippet: '' }))
  }, [q, hits, index])

  // 结果变少时光标别落到列表外
  const current = Math.min(active, Math.max(rows.length - 1, 0))

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const open = (id: string) => {
    onOpen(id)
    onClose()
  }

  return createPortal(
    <div className="nt-search-backdrop" onMouseDown={onClose}>
      <div className="nt-search-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nt-search-input-row">
          <Search size={16} />
          <input
            autoFocus
            className="nt-search-input"
            placeholder="搜索页面标题和正文…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Escape') { e.preventDefault(); onClose() }
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(current + 1, rows.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(current - 1, 0)) }
              if (e.key === 'Enter') {
                e.preventDefault()
                const row = rows[current]
                if (row) open(row.meta.id)
              }
            }}
          />
        </div>
        <div className="nt-search-label">{q ? `搜索结果 · ${rows.length}` : '最近编辑'}</div>
        <div ref={listRef} className="nt-search-list">
          {q && error && <div className="nt-float-error">{error}</div>}
          {rows.map((row, i) => {
            const path = ancestorsOf(row.meta.id, index.byId).map((a) => pageTitle(a)).join(' / ')
            return (
              <button
                key={row.meta.id}
                type="button"
                data-row={i}
                className="nt-search-row"
                data-active={i === current ? '1' : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => open(row.meta.id)}
              >
                <span className="nt-search-icon">{row.meta.icon ?? <FileText size={15} />}</span>
                <span className="nt-search-text">
                  <span className="nt-search-title"><Highlight text={pageTitle(row.meta)} query={q} /></span>
                  {row.snippet && <span className="nt-search-snippet"><Highlight text={row.snippet} query={q} /></span>}
                  {path && <span className="nt-search-path">{path}</span>}
                </span>
                <span className="nt-search-time">{formatNoteTime(row.meta.updatedAt)}</span>
              </button>
            )
          })}
          {q && !error && rows.length === 0 && <div className="nt-search-empty">没有找到「{q}」</div>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 命中的字标橙 */
function Highlight({ text, query }: { readonly text: string; readonly query: string }) {
  if (!query) return <>{text}</>
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  let at = lower.indexOf(needle)
  while (at >= 0 && needle) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at} className="nt-hit">{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
    at = lower.indexOf(needle, from)
  }
  if (from < text.length) parts.push(text.slice(from))
  return <>{parts}</>
}
