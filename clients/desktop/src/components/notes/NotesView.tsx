// ══════════════════════════════════════════════
// 笔记（Notion 式）：左边页面树，右边单页编辑；全部存本地 SQLite + 本地附件目录
//   这里是所有文字的底座：普通页、锚点页、想法卡片、语境页都是它的页面（见 lib/notes-api.ts 的 NotePageKind）。
//   左栏顶上两个固定入口不是页面：想法卡片（全部批注 + 单独写的）和语境库（转录过的视频那张表）
// ══════════════════════════════════════════════

import './notes.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FilePlus2, X } from 'lucide-react'
import { emptyNoteTrash, fetchAnchorStats, purgeNotePage, type NotePageKind } from '../../lib/notes-api'
import { useConfirm } from '../../hooks/useConfirm'
import { ancestorsOf, subtreeIds } from './note-model'
import NotePageView from './NotePageView'
import ContextLibraryView from './ContextLibraryView'
import NoteSearch from './NoteSearch'
import NoteSidebar, { CONTEXTS_VIEW, THOUGHTS_VIEW } from './NoteSidebar'
import NoteTrash from './NoteTrash'
import { NOTES_INDEX_CHANGED_EVENT, NOTES_OPEN_EVENT } from './notes-store'
import { fillMissingContextPages } from './context-autofill'
import ThoughtsView from './ThoughtsView'
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

export default function NotesView({ active = true }: {
  /** 笔记面板此刻是不是主舞台上显示的那一块（不是的时候不抢全局快捷键） */
  readonly active?: boolean
}) {
  const tree = useNoteTree()
  const [selectedId, setSelectedId] = useState<string | null>(loadSelected)
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [searchOpen, setSearchOpen] = useState(false)
  const [trashAnchor, setTrashAnchor] = useState<HTMLElement | null>(null)
  const [trashKey, setTrashKey] = useState(0)
  const [confirm, confirmDialog] = useConfirm()
  // 从回收站点开的页面不在页面树里，别被「选中项无效 → 落到第一页」的兜底踢走
  const [viewingTrashed, setViewingTrashed] = useState<string | null>(null)

  // 跳到某一页的某一块（从引用、想法卡片点回原处）；tick 让同一块再点一次也会再跳
  const [focus, setFocus] = useState<{ pageId: string; blockId: string; tick: number } | null>(null)
  const [anchorRefs, setAnchorRefs] = useState<ReadonlyMap<string, number>>(new Map())

  const { index } = tree
  // 兜底落到的第一页：只在树里看得见的页面里挑（想法卡片、语境页不进树）
  const roots = useMemo(
    () => (index.children.get(null) ?? []).filter((p) => p.kind === 'page' || p.kind === 'anchor'),
    [index],
  )

  const isSpecial = selectedId === THOUGHTS_VIEW || selectedId === CONTEXTS_VIEW
  // 实际显示的：两个固定入口照用；页面还在（或是从回收站点开的）就用它，否则落到第一个顶层页面
  //（首次进来 / 被删 / 本机记的 id 失效都走这条）
  const currentId = tree.loading || isSpecial || (selectedId != null && (index.byId.has(selectedId) || viewingTrashed === selectedId))
    ? selectedId
    : roots[0]?.id ?? null

  // 每个锚点被引用了几处（侧栏锚点行右边的数字）：进来拉一次，之后哪一页存了正文就重拉
  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const load = () => {
      fetchAnchorStats()
        .then((stats) => { if (alive) setAnchorRefs(new Map(stats.map((s) => [s.anchorId, s.refs]))) })
        .catch((e: unknown) => console.error('[Notes] 读取锚点统计失败', e))
    }
    const onChanged = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(load, 400)
    }
    load()
    window.addEventListener(NOTES_INDEX_CHANGED_EVENT, onChanged)
    return () => {
      alive = false
      if (timer != null) window.clearTimeout(timer)
      window.removeEventListener(NOTES_INDEX_CHANGED_EVENT, onChanged)
    }
  }, [])

  // 转录过的视频自动补成语境页：进来跑一趟，窗口回到前台再看一眼有没有新转录的
  useEffect(() => {
    const run = () => { void fillMissingContextPages() }
    run()
    // 一个视频刚转录完（你点的或 Fairy 转的）：任务面板会发这个事件，当场补上它的那一页
    window.addEventListener('focus', run)
    window.addEventListener('solevup:context-updated', run)
    return () => {
      window.removeEventListener('focus', run)
      window.removeEventListener('solevup:context-updated', run)
    }
  }, [])

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

  const open = useCallback((id: string, blockId?: string) => {
    if (id === THOUGHTS_VIEW || id === CONTEXTS_VIEW) {
      setViewingTrashed(null)
      setSelectedId(id)
      return
    }
    setViewingTrashed(index.byId.has(id) ? null : id)
    setSelectedId(id)
    if (blockId) setFocus((prev) => ({ pageId: id, blockId, tick: (prev?.tick ?? 0) + 1 }))
    expandMany(ancestorsOf(id, index.byId).map((a) => a.id))
  }, [index, expandMany])

  // 编辑器里的链接块 / @页面 / # 引用 / 面包屑点了：切过去（带着块 id 就再跳到那一块）
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string; blockId?: string }>).detail
      if (detail?.id) open(detail.id, detail.blockId)
    }
    window.addEventListener(NOTES_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(NOTES_OPEN_EVENT, onOpen)
  }, [open])

  // Ctrl+P 快速查找（顺手挡住 WebView 的打印对话框）；面板没显示时不接
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

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

  const create = useCallback(async (parentId: string | null, kind?: NotePageKind) => {
    const page = await tree.create(parentId, kind ? { kind } : undefined)
    if (!page) return null
    if (parentId) expandMany([parentId, ...ancestorsOf(parentId, index.byId).map((a) => a.id)])
    // 结点只是目录里的一格，不是能打开的页：建完留在原处，由左栏直接让它改名
    if (page.kind === 'group') return page.id
    setViewingTrashed(null)
    setSelectedId(page.id)
    return page.id
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
        anchorRefs={anchorRefs}
        selectedId={currentId}
        expanded={expanded}
        onToggleExpand={toggleExpand}
        onSelect={(id) => open(id)}
        onCreate={create}
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
        {currentId === THOUGHTS_VIEW ? (
          <ThoughtsView />
        ) : currentId === CONTEXTS_VIEW ? (
          <ContextLibraryView />
        ) : currentId ? (
          <NotePageView
            key={currentId}
            pageId={currentId}
            focus={focus && focus.pageId === currentId ? focus : null}
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
