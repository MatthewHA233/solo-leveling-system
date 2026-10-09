// 块菜单「移动到」：选一个页面，把块（连同子块）挪到那一页末尾。↑↓ 选、回车确定、Esc 关

import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import Floating from './Floating'
import { ancestorsOf, pageTitle } from './note-model'
import { useNotePagesMap } from './notes-store'

const LIMIT = 30
/** 块菜单关闭时会把焦点还给编辑器（晚于这个浮层出现）：这段时间里焦点被拿走就抢回来 */
const FOCUS_GUARD_MS = 600

export default function MoveToPicker({ anchor, excludeId, onPick, onClose }: {
  readonly anchor: DOMRect
  /** 当前页（不能移到自己这一页） */
  readonly excludeId: string
  readonly onPick: (pageId: string) => void
  readonly onClose: () => void
}) {
  const pages = useNotePagesMap()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    input?.focus()
    const until = performance.now() + FOCUS_GUARD_MS
    const onFocusIn = (e: FocusEvent) => {
      if (performance.now() > until) return
      if (input && e.target !== input) input.focus()
    }
    document.addEventListener('focusin', onFocusIn, true)
    const timer = window.setTimeout(() => document.removeEventListener('focusin', onFocusIn, true), FOCUS_GUARD_MS)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('focusin', onFocusIn, true)
    }
  }, [])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...pages.values()]
      .filter((p) => p.id !== excludeId && (!q || pageTitle(p).toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, LIMIT)
  }, [pages, query, excludeId])

  const current = Math.min(active, Math.max(rows.length - 1, 0))
  const pick = (id: string) => {
    onPick(id)
    onClose()
  }

  return (
    <Floating anchor={anchor} onClose={onClose} width={340} className="nt-move">
      <div className="nt-emoji-head"><span className="nt-float-title">移动到</span></div>
      <input
        ref={inputRef}
        className="nt-inline-input"
        style={{ margin: '0 4px 6px', width: 'calc(100% - 8px)' }}
        placeholder="搜索页面…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0) }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(current + 1, rows.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(current - 1, 0)) }
          if (e.key === 'Enter') {
            e.preventDefault()
            const row = rows[current]
            if (row) pick(row.id)
          }
        }}
      />
      <div className="nt-trash-list">
        {rows.length === 0 && <div className="nt-search-empty">{query.trim() ? '没有匹配的页面' : '没有别的页面可以移过去'}</div>}
        {rows.map((p, i) => {
          const path = ancestorsOf(p.id, pages).map((a) => pageTitle(a)).join(' / ')
          return (
            <button
              key={p.id}
              type="button"
              className="nt-search-row"
              data-active={i === current ? '1' : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p.id)}
              style={{ padding: '6px 8px' }}
            >
              <span className="nt-search-icon" style={{ fontSize: 15 }}>{p.icon ?? <FileText size={14} />}</span>
              <span className="nt-search-text">
                <span className="nt-search-title" style={{ fontSize: 13 }}>{pageTitle(p)}</span>
                {path && <span className="nt-search-path">{path}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </Floating>
  )
}
