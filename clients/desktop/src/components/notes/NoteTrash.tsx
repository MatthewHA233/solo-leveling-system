// 笔记回收站浮层：列「被删的那一层」页面，可打开只读查看 / 恢复 / 彻底删除 / 清空

import { useEffect, useState } from 'react'
import { FileText, RotateCcw, Trash2, X } from 'lucide-react'
import { fetchNoteTrash, type NotePageMeta } from '../../lib/notes-api'
import Floating from './Floating'
import { formatNoteTime, pageTitle } from './note-model'

export default function NoteTrash({ anchor, refreshKey, onOpen, onRestore, onPurge, onEmpty, onClose }: {
  readonly anchor: HTMLElement
  /** 外面恢复 / 删除后加一，让列表重拉 */
  readonly refreshKey: number
  readonly onOpen: (id: string) => void
  readonly onRestore: (id: string) => void
  readonly onPurge: (id: string) => void
  readonly onEmpty: () => void
  readonly onClose: () => void
}) {
  const [items, setItems] = useState<readonly NotePageMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let alive = true
    fetchNoteTrash()
      .then((r) => { if (alive) { setItems(r); setError(null) } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [refreshKey])

  const f = filter.trim().toLowerCase()
  const shown = (items ?? []).filter((p) => !f || pageTitle(p).toLowerCase().includes(f))

  return (
    <Floating anchor={anchor} onClose={onClose} placement="right-start" width={360} className="nt-trash">
      <div className="nt-emoji-head">
        <span className="nt-float-title">回收站</span>
        <span style={{ flex: 1 }} />
        {items && items.length > 0 && (
          <button type="button" className="ti-key nt-mini-key" data-danger="1" onClick={onEmpty}>
            <Trash2 size={12} />清空
          </button>
        )}
      </div>
      <input
        className="nt-inline-input"
        style={{ margin: '0 10px 8px', width: 'calc(100% - 20px)' }}
        placeholder="按标题筛选"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="nt-trash-list">
        {error && <div className="nt-float-error">{error}</div>}
        {items === null && !error && <div className="nt-search-empty">读取中…</div>}
        {items !== null && shown.length === 0 && (
          <div className="nt-search-empty">{items.length === 0 ? '回收站是空的' : '没有匹配的页面'}</div>
        )}
        {shown.map((p) => (
          <div key={p.id} className="nt-trash-row" onClick={() => onOpen(p.id)}>
            <span className="nt-row-icon">{p.icon ?? <FileText size={13} />}</span>
            <span className="nt-trash-text">
              <span className="nt-row-title">{pageTitle(p)}</span>
              <span className="nt-trash-time">删除于 {formatNoteTime(p.deletedAt)}</span>
            </span>
            <button type="button" className="nt-row-key" style={{ opacity: 1 }} aria-label="恢复"
              onClick={(e) => { e.stopPropagation(); onRestore(p.id) }}>
              <RotateCcw size={12} />
            </button>
            <button type="button" className="nt-row-key" data-danger="1" style={{ opacity: 1 }} aria-label="彻底删除"
              onClick={(e) => { e.stopPropagation(); onPurge(p.id) }}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </Floating>
  )
}
