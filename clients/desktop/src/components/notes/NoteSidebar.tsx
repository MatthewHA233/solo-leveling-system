// ══════════════════════════════════════════════
// 笔记左栏：搜索键 + 收藏 + 页面树（无限层级，拖拽排序 / 拖进别的页面当子页面）+ 回收站 / 新建
//   选中 = 凸起的小钛片 + 淡橙环；层级 = 刻槽导轨（不用左侧竖线）
// ══════════════════════════════════════════════

import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, FilePlus2, FileText, MoreHorizontal, PenLine, Plus, Search, Star, StarOff, Trash2 } from 'lucide-react'
import type { NotePageMeta } from '../../lib/notes-api'
import Tooltip from '../Tooltip'
import { pageTitle, resolveDrop, zoneFromOffset, type DropZone } from './note-model'
import { dropDraggedBlocksOnPage } from './notes-store'
import PopMenu from './PopMenu'
import type { NoteTree } from './use-note-tree'

export interface NoteSidebarProps {
  readonly tree: NoteTree
  readonly selectedId: string | null
  readonly expanded: ReadonlySet<string>
  readonly onToggleExpand: (id: string, open?: boolean) => void
  readonly onSelect: (id: string) => void
  readonly onCreate: (parentId: string | null) => void
  readonly onTrash: (id: string) => void
  readonly onOpenSearch: () => void
  readonly trashOpen: boolean
  readonly onToggleTrash: (anchor: HTMLElement) => void
}

interface DropHint {
  readonly id: string
  readonly zone: DropZone
}

export default function NoteSidebar(props: NoteSidebarProps) {
  const { tree, selectedId, expanded } = props
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  // 收藏区和页面树里可能同时出现同一页：改名 / 菜单按行 key 区分，别两处一起冒输入框
  const [menu, setMenu] = useState<{ page: NotePageMeta; anchor: HTMLElement; rowKey: string } | null>(null)
  const trashRef = useRef<HTMLButtonElement>(null)
  // 从正文里拖块（⋮⋮）悬停到的页面：松手 = 把块移到那一页
  const [blockDropId, setBlockDropId] = useState<string | null>(null)
  const selectedRef = useRef(selectedId)
  useEffect(() => { selectedRef.current = selectedId })

  // 编辑器的拖拽监听挂在 document 捕获阶段，而且离编辑器 250px 内的落点会被它拽回正文里；
  // 所以这里在更早的 window 捕获阶段截住「拖块到侧栏页面上」，不让它往下传
  useEffect(() => {
    const pageAt = (e: Event): string | null => {
      const de = e as globalThis.DragEvent
      if (!de.dataTransfer?.types.includes('blocknote/html')) return null
      const row = e.target instanceof Element ? e.target.closest('.nt-side-scroll .nt-row[data-page-id]') : null
      const id = row instanceof HTMLElement ? row.dataset.pageId ?? null : null
      return id && id !== selectedRef.current ? id : null
    }
    const onOver = (e: Event) => {
      const id = pageAt(e)
      setBlockDropId(id)
      if (!id) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const de = e as globalThis.DragEvent
      if (de.dataTransfer) de.dataTransfer.dropEffect = 'move'
    }
    const onDrop = (e: Event) => {
      const id = pageAt(e)
      setBlockDropId(null)
      if (!id) return
      e.preventDefault()
      e.stopImmediatePropagation()
      dropDraggedBlocksOnPage(id)
    }
    const onEnd = () => setBlockDropId(null)
    window.addEventListener('dragover', onOver, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragend', onEnd, true)
    return () => {
      window.removeEventListener('dragover', onOver, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragend', onEnd, true)
    }
  }, [])

  const favorites = tree.pages.filter((p) => p.favorite).sort((a, b) => pageTitle(a).localeCompare(pageTitle(b), 'zh-Hans-CN'))
  const roots = tree.index.children.get(null) ?? []

  const onDragOverRow = (e: DragEvent<HTMLDivElement>, page: NotePageMeta) => {
    if (!dragId || dragId === page.id) return
    const rect = e.currentTarget.getBoundingClientRect()
    const zone = zoneFromOffset(e.clientY - rect.top, rect.height)
    if (!resolveDrop(dragId, page, zone, tree.index)) {
      setDropHint(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropHint?.id !== page.id || dropHint.zone !== zone) setDropHint({ id: page.id, zone })
  }

  const onDropRow = (e: DragEvent<HTMLDivElement>, page: NotePageMeta) => {
    e.preventDefault()
    const hint = dropHint
    const id = dragId
    setDropHint(null)
    setDragId(null)
    if (!id || !hint || hint.id !== page.id) return
    const target = resolveDrop(id, page, hint.zone, tree.index)
    if (!target) return
    if (hint.zone === 'inside') props.onToggleExpand(page.id, true)
    void tree.move(id, target.parentId, target.index)
  }

  const renderRow = (page: NotePageMeta, depth: number, inFavorites: boolean): React.ReactNode => {
    const kids = tree.index.children.get(page.id) ?? []
    const key = inFavorites ? `fav:${page.id}` : page.id
    const open = !inFavorites && expanded.has(page.id)
    const selected = selectedId === page.id
    const hint = !inFavorites && dropHint?.id === page.id
      ? dropHint.zone
      : !inFavorites && blockDropId === page.id ? 'inside' : undefined
    return (
      <div key={key}>
        <div
          className="nt-row"
          data-selected={selected ? '1' : undefined}
          data-drop={hint}
          data-dragging={dragId === page.id ? '1' : undefined}
          data-page-id={inFavorites ? undefined : page.id}
          draggable={!inFavorites && renaming !== key}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', pageTitle(page))
            setDragId(page.id)
          }}
          onDragEnd={() => { setDragId(null); setDropHint(null) }}
          onDragOver={inFavorites ? undefined : (e) => onDragOverRow(e, page)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropHint?.id === page.id) setDropHint(null)
          }}
          onDrop={inFavorites ? undefined : (e) => onDropRow(e, page)}
          onClick={() => props.onSelect(page.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ page, anchor: e.currentTarget, rowKey: key })
          }}
        >
          {Array.from({ length: depth }, (_, i) => <span key={i} className="nt-guide" />)}
          <div className="nt-row-body">
            <span className="nt-caret-slot">
              {!inFavorites && kids.length > 0 && (
                <button type="button" className="nt-caret" aria-label={open ? '收起' : '展开'}
                  onClick={(e) => { e.stopPropagation(); props.onToggleExpand(page.id) }}>
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              )}
            </span>
            <span className="nt-row-icon">{page.icon ?? <FileText size={13} />}</span>
            {renaming === key ? (
              <input
                autoFocus
                className="nt-inline-input"
                defaultValue={page.title}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Escape') setRenaming(null)
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                onBlur={(e) => {
                  const v = e.currentTarget.value
                  setRenaming(null)
                  if (v !== page.title) void tree.rename(page.id, v)
                }}
              />
            ) : (
              <span className="nt-row-title" data-untitled={page.title.trim() ? undefined : '1'}>{pageTitle(page)}</span>
            )}
            <Tooltip content="更多（删除、改名、收藏）">
              <button type="button" className="nt-row-key" aria-label="更多"
                onClick={(e) => { e.stopPropagation(); setMenu({ page, anchor: e.currentTarget, rowKey: key }) }}>
                <MoreHorizontal size={12} />
              </button>
            </Tooltip>
            {!inFavorites && (
              <Tooltip content="在里面新建子页面">
                <button type="button" className="nt-row-key" aria-label="新建子页面"
                  onClick={(e) => { e.stopPropagation(); props.onCreate(page.id) }}>
                  <Plus size={12} strokeWidth={2.6} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        {open && (kids.length > 0
          ? kids.map((k) => renderRow(k, depth + 1, false))
          : null)}
      </div>
    )
  }

  return (
    <aside className="nt-sidebar">
      <div className="nt-side-top">
        <button type="button" className="nt-search-key" onClick={props.onOpenSearch}>
          <Search size={13} />
          <span>搜索</span>
          <span style={{ flex: 1 }} />
          <span className="ti-keycap nt-keycap">Ctrl P</span>
        </button>
      </div>

      <div className="nt-side-scroll"
        onDragOver={(e) => {
          // 拖到空白处 = 放到顶层末尾
          if (dragId && e.target === e.currentTarget) { e.preventDefault(); setDropHint(null) }
        }}
        onDrop={(e) => {
          if (!dragId || e.target !== e.currentTarget) return
          e.preventDefault()
          const id = dragId
          setDragId(null)
          void tree.move(id, null, roots.filter((r) => r.id !== id).length)
        }}
      >
        {favorites.length > 0 && (
          <>
            <div className="nt-section"><span className="nt-section-label">收藏</span><span className="pt-section-rule" /></div>
            {favorites.map((p) => renderRow(p, 0, true))}
          </>
        )}

        <div className="nt-section">
          <span className="nt-section-label">页面</span>
          <span className="pt-section-rule" />
          <Tooltip content="新建页面">
            <button type="button" className="nt-row-key" style={{ opacity: 1 }} aria-label="新建页面" onClick={() => props.onCreate(null)}>
              <Plus size={12} strokeWidth={2.6} />
            </button>
          </Tooltip>
        </div>
        {roots.map((p) => renderRow(p, 0, false))}
        {!tree.loading && roots.length === 0 && (
          <div className="nt-side-empty">还没有页面</div>
        )}
      </div>

      <div className="ti-groove-h" style={{ margin: '0 10px' }} />
      <div className="nt-side-foot">
        <button ref={trashRef} type="button" className="ti-key nt-foot-key" data-active={props.trashOpen ? '1' : undefined}
          onClick={() => { if (trashRef.current) props.onToggleTrash(trashRef.current) }}>
          <Trash2 size={13} />回收站
        </button>
        <button type="button" className="ti-key ti-key-primary nt-foot-key" style={{ flex: 1 }} onClick={() => props.onCreate(null)}>
          <FilePlus2 size={13} />新建页面
        </button>
      </div>

      {menu && (
        <PopMenu
          anchor={menu.anchor}
          placement="right-start"
          onClose={() => setMenu(null)}
          items={[
            {
              key: 'fav',
              label: menu.page.favorite ? '取消收藏' : '收藏',
              icon: menu.page.favorite ? StarOff : Star,
              onSelect: () => { void tree.setFavorite(menu.page.id, !menu.page.favorite) },
            },
            { key: 'rename', label: '重命名', icon: PenLine, onSelect: () => setRenaming(menu.rowKey) },
            { key: 'child', label: '新建子页面', icon: Plus, onSelect: () => props.onCreate(menu.page.id) },
            'sep',
            { key: 'trash', label: '移到回收站', icon: Trash2, danger: true, onSelect: () => props.onTrash(menu.page.id) },
          ]}
        />
      )}
    </aside>
  )
}
