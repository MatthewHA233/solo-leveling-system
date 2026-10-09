// ══════════════════════════════════════════════
// 洪流域 · 笔记（Notion 式）：左边页面树，右边单页编辑；全部存本地 SQLite + 本地附件目录
//   和想法卡片的区别：想法卡是随手一条的流，笔记是能无限嵌套、长篇排版的页面
// ══════════════════════════════════════════════

import './notes.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FilePlus2, X } from 'lucide-react'
import { emptyNoteTrash, purgeNotePage } from '../../lib/notes-api'
import { useConfirm } from '../../hooks/useConfirm'
import { ancestorsOf, subtreeIds } from './note-model'
import NotePageView from './NotePageView'
import NoteSearch from './NoteSearch'
import NoteSidebar from './NoteSidebar'
import NoteTrash from './NoteTrash'
import { NOTES_OPEN_EVENT } from './notes-store'
import { useNoteTree } from './use-note-tree'

const SELECTED_KEY = 'slu.notes.selected'
const EXPANDED_KEY = 'slu.notes.expanded'

function loadSelected(): string | null {
  try { return localStorage.getItem(SELECTED_KEY) } catch { return null }
}

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export default function NotesView() {
  const tree = useNoteTree()
  const [selectedId, setSelectedId] = useState<string | null>(loadSelected)
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [searchOpen, setSearchOpen] = useState(false)
  const [trashAnchor, setTrashAnchor] = useState<HTMLElement | null>(null)
  const [trashKey, setTrashKey] = useState(0)
  const [confirm, confirmDialog] = useConfirm()
  // 从回收站点开的页面不在页面树里，别被「选中项无效 → 落到第一页」的兜底踢走
  const [viewingTrashed, setViewingTrashed] = useState<string | null>(null)

  const { index } = tree
  const roots = useMemo(() => index.children.get(null) ?? [], [index])

  // 实际显示的页面：选中的还在（或是从回收站点开的）就用它，否则落到第一个顶层页面
  //（首次进来 / 被删 / 本机记的 id 失效都走这条）
  const currentId = tree.loading || (selectedId != null && (index.byId.has(selectedId) || viewingTrashed === selectedId))
    ? selectedId
    : roots[0]?.id ?? null

  useEffect(() => {
    if (tree.loading) return
    try {
      if (currentId) localStorage.setItem(SELECTED_KEY, currentId)
      else localStorage.removeItem(SELECTED_KEY)
    } catch { /* 本机存不了就算了 */ }
  }, [currentId, tree.loading])

  useEffect(() => {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])) } catch { /* 同上 */ }
  }, [expanded])

  const expandMany = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return
    setExpanded((prev) => {
      if (ids.every((id) => prev.has(id))) return prev
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
  }, [])

  const open = useCallback((id: string) => {
    setViewingTrashed(index.byId.has(id) ? null : id)
    setSelectedId(id)
    expandMany(ancestorsOf(id, index.byId).map((a) => a.id))
  }, [index, expandMany])

  // 编辑器里的链接块 / @页面 / 面包屑点了：切过去
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id
      if (id) open(id)
    }
    window.addEventListener(NOTES_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(NOTES_OPEN_EVENT, onOpen)
  }, [open])

  // Ctrl+P 快速查找（顺手挡住 WebView 的打印对话框）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const revealChildren = useCallback((id: string) => {
    expandMany([id, ...ancestorsOf(id, index.byId).map((a) => a.id)])
  }, [index, expandMany])

  const toggleExpand = useCallback((id: string, force?: boolean) => {
    setExpanded((prev) => {
      const isOpen = prev.has(id)
      const want = force ?? !isOpen
      if (want === isOpen) return prev
      const next = new Set(prev)
      if (want) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const create = useCallback(async (parentId: string | null) => {
    const page = await tree.create(parentId)
    if (!page) return
    if (parentId) expandMany([parentId, ...ancestorsOf(parentId, index.byId).map((a) => a.id)])
    setViewingTrashed(null)
    setSelectedId(page.id)
  }, [tree, index, expandMany])

  const trash = useCallback(async (id: string) => {
    // 正在看的页面在被删的子树里：先挪到父页面 / 相邻页面
    if (currentId && subtreeIds(id, index).has(currentId)) {
      const meta = index.byId.get(id)
      const siblings = index.children.get(meta?.parentId ?? null) ?? []
      const at = siblings.findIndex((s) => s.id === id)
      const fallback = meta?.parentId ?? siblings[at - 1]?.id ?? siblings[at + 1]?.id ?? null
      setSelectedId(fallback)
    }
    await tree.trash(id)
    setTrashKey((k) => k + 1)
  }, [tree, index, currentId])

  const restore = useCallback(async (id: string) => {
    const meta = await tree.restore(id)
    setTrashKey((k) => k + 1)
    if (meta) {
      setViewingTrashed(null)
      setSelectedId(meta.id)
    }
  }, [tree])

  const purge = useCallback(async (id: string) => {
    const ok = await confirm({
      title: '彻底删除',
      question: '彻底删除这个页面？',
      details: ['它的子页面、插进去的图片和文件会一起删掉，不能恢复。'],
      confirmLabel: '彻底删除',
      danger: true,
    })
    if (!ok) return
    try {
      await purgeNotePage(id)
    } catch (e) {
      console.error('[Notes] 彻底删除失败', e)
    }
    if (currentId === id) {
      setViewingTrashed(null)
      setSelectedId(null)
    }
    setTrashKey((k) => k + 1)
  }, [confirm, currentId])

  const emptyTrash = useCallback(async () => {
    const ok = await confirm({
      title: '清空回收站',
      question: '清空回收站里的全部页面？',
      details: ['这些页面和它们的附件会被永久删除，不能恢复。'],
      confirmLabel: '清空',
      danger: true,
    })
    if (!ok) return
    try {
      await emptyNoteTrash()
    } catch (e) {
      console.error('[Notes] 清空回收站失败', e)
    }
    if (viewingTrashed) {
      setViewingTrashed(null)
      setSelectedId(null)
    }
    setTrashKey((k) => k + 1)
  }, [confirm, viewingTrashed])

  const openFromTrash = useCallback((id: string) => {
    setViewingTrashed(id)
    setSelectedId(id)
  }, [])

  return (
    <div className="nt-root">
      <NoteSidebar
        tree={tree}
        selectedId={currentId}
        expanded={expanded}
        onToggleExpand={toggleExpand}
        onSelect={open}
        onCreate={(parentId) => { void create(parentId) }}
        onTrash={(id) => { void trash(id) }}
        onOpenSearch={() => setSearchOpen(true)}
        trashOpen={trashAnchor != null}
        onToggleTrash={(anchor) => setTrashAnchor((cur) => (cur ? null : anchor))}
      />

      <main className="nt-main">
        {tree.error && (
          <div className="nt-error">
            <span>{tree.error}</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="nt-row-key" style={{ opacity: 1 }} aria-label="知道了" onClick={tree.clearError}>
              <X size={12} />
            </button>
          </div>
        )}
        {currentId ? (
          <NotePageView
            key={currentId}
            pageId={currentId}
            tree={tree}
            onRestore={(id) => { void restore(id) }}
            onPurge={(id) => { void purge(id) }}
            onTrash={(id) => { void trash(id) }}
            onRevealChildren={revealChildren}
          />
        ) : (
          <div className="nt-page-empty">
            {tree.loading ? '正在读取笔记…' : (
              <div className="nt-empty-card">
                <div className="nt-empty-title">还没有笔记</div>
                <div className="nt-empty-sub">页面可以无限嵌套；正文里按 / 插入标题、待办、折叠块、代码、图片……</div>
                <button type="button" className="ti-key ti-key-primary nt-foot-key" onClick={() => { void create(null) }}>
                  <FilePlus2 size={14} />新建第一个页面
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {searchOpen && (
        <NoteSearch index={index} onOpen={open} onClose={() => setSearchOpen(false)} />
      )}
      {trashAnchor && (
        <NoteTrash
          anchor={trashAnchor}
          refreshKey={trashKey}
          onOpen={openFromTrash}
          onRestore={(id) => { void restore(id) }}
          onPurge={(id) => { void purge(id) }}
          onEmpty={() => { void emptyTrash() }}
          onClose={() => setTrashAnchor(null)}
        />
      )}
      {confirmDialog}
    </div>
  )
}
