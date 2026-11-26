// ══════════════════════════════════════════════
// 笔记左栏：搜索键 + 两个固定入口（想法卡片 / 语境库）+ 收藏 + 锚点 + 页面树 + 回收站 / 新建
//   锚点和页面是同一棵树（无限层级，拖拽排序 / 拖进别的页面当子页面），按顶层那一页的种类分到两节里；
//   锚点一节是一份目录：最上面一层是领域（像图书分类，主人自己定），领域是一种结点，结点里可以再套结点，
//   锚点挂在结点底下；结点只用来归拢，点它是展开 / 收起，不是打开一页。还没归进领域的锚点排在最后。
//   一个锚点可以在别的结点里放分身（同一个锚点出现在几个领域里）：分身那一格显示的是锚点本身的名字和引用数，
//   点它就是打开那个锚点，去掉分身不影响锚点。
//   锚点行右边的数字 = 被引用了几处。单独写的想法卡片、语境页不进树，各在自己的入口里。
//   选中 = 凸起的小钛片 + 淡橙环；层级 = 刻槽导轨（不用左侧竖线）
// ══════════════════════════════════════════════

import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, CopyPlus, FilePlus2, FileText, Folder, FolderPlus, Hash, Library, MessageSquareQuote, MoreHorizontal, PenLine, Pin, Plus, Search, Star, StarOff, Trash2 } from 'lucide-react'
import type { NotePageKind, NotePageMeta } from '../../lib/notes-api'
import Tooltip from '../Tooltip'
import { pageTitle, resolveDrop, zoneFromOffset, type DropZone } from './note-model'
import { dropDraggedBlocksOnPage } from './notes-store'
import MoveToPicker from './MoveToPicker'
import PopMenu from './PopMenu'
import type { NoteTree } from './use-note-tree'

/** 两个固定入口的选中值（和页面 id 放在同一个「当前选中」里，前面带 @ 不会和页面 id 撞） */
export const THOUGHTS_VIEW = '@thoughts'
export const CONTEXTS_VIEW = '@contexts'

/** 不进页面树的种类：各在自己的入口里 */
const HIDDEN_ROOT_KINDS: readonly string[] = ['thought', 'context']

export interface NoteSidebarProps {
  readonly tree: NoteTree
  /** 锚点 id → 被引用了几处 */
  readonly anchorRefs: ReadonlyMap<string, number>
  readonly selectedId: string | null
  readonly expanded: ReadonlySet<string>
  readonly onToggleExpand: (id: string, open?: boolean) => void
  readonly onSelect: (id: string) => void
  /** 返回新建那一页的 id（没建成是 null） */
  readonly onCreate: (parentId: string | null, kind?: NotePageKind) => Promise<string | null>
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
  // 正在给哪个锚点挑「分身放到哪个结点里」
  const [aliasPick, setAliasPick] = useState<{ anchorId: string; rect: DOMRect } | null>(null)
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
  const roots = (tree.index.children.get(null) ?? []).filter((p) => !HIDDEN_ROOT_KINDS.includes(p.kind))
  const domainRoots = roots.filter((p) => p.kind === 'group')
  const looseAnchors = roots.filter((p) => p.kind === 'anchor' || p.kind === 'alias')
  const pageRoots = roots.filter((p) => p.kind !== 'anchor' && p.kind !== 'group' && p.kind !== 'alias')

  /** 新建一个结点（parentId 为空 = 新建领域），建完直接让它改名 */
  const createNode = async (parentId: string | null) => {
    const id = await props.onCreate(parentId, 'group')
    if (id) setRenaming(id)
  }

  const onDragOverRow = (e: DragEvent<HTMLDivElement>, page: NotePageMeta) => {
    if (!dragId || dragId === page.id) return
    const rect = e.currentTarget.getBoundingClientRect()
    const zone = zoneFromOffset(e.clientY - rect.top, rect.height)
    // 分身只是一格，里面放不了东西
    if ((page.kind === 'alias' && zone === 'inside') || !resolveDrop(dragId, page, zone, tree.index)) {
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
    // 分身：显示它指向的那个锚点；锚点不在了（进了回收站）这一格就不显示
    const target = page.kind === 'alias' ? tree.index.byId.get(page.aliasOf ?? '') : undefined
    if (page.kind === 'alias' && !target) return null
    const shown = target ?? page
    const isAlias = target != null
    const kids = isAlias ? [] : tree.index.children.get(page.id) ?? []
    const key = inFavorites ? `fav:${page.id}` : page.id
    const open = !inFavorites && expanded.has(page.id)
    const isNode = page.kind === 'group'
    const inAnchorTree = isNode || page.kind === 'anchor'
    const selected = !isNode && selectedId === shown.id
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
          data-page-id={inFavorites || isAlias ? undefined : page.id}
          draggable={!inFavorites && renaming !== key}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', pageTitle(shown))
            setDragId(page.id)
          }}
          onDragEnd={() => { setDragId(null); setDropHint(null) }}
          onDragOver={inFavorites ? undefined : (e) => onDragOverRow(e, page)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropHint?.id === page.id) setDropHint(null)
          }}
          onDrop={inFavorites ? undefined : (e) => onDropRow(e, page)}
          onClick={() => (isNode ? props.onToggleExpand(page.id) : props.onSelect(shown.id))}
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
            <span className="nt-row-icon">{shown.icon ?? (isNode ? <Folder size={13} /> : shown.kind === 'anchor' ? <Hash size={13} /> : <FileText size={13} />)}</span>
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
              <span className="nt-row-title" data-untitled={shown.title.trim() ? undefined : '1'}>
                {isNode && !page.title.trim() ? (depth === 0 ? '未命名领域' : '未命名结点') : pageTitle(shown)}
              </span>
            )}
            {isAlias && <span className="nt-alias-mark">分身</span>}
            {shown.kind === 'anchor' && (props.anchorRefs.get(shown.id) ?? 0) > 0 && (
              <span className="nt-count">{props.anchorRefs.get(shown.id)}</span>
            )}
            <Tooltip content={isAlias ? '更多（去掉这个分身）' : isNode ? '更多（改名、下级结点、删除）' : '更多（删除、改名、收藏）'}>
              <button type="button" className="nt-row-key" aria-label="更多"
                onClick={(e) => { e.stopPropagation(); setMenu({ page, anchor: e.currentTarget, rowKey: key }) }}>
                <MoreHorizontal size={12} />
              </button>
            </Tooltip>
            {!inFavorites && !isAlias && (
              <Tooltip content={isNode ? '在里面新建锚点' : page.kind === 'anchor' ? '在里面新建一个下级锚点' : '在里面新建子页面'}>
                <button type="button" className="nt-row-key" aria-label={inAnchorTree ? '新建锚点' : '新建子页面'}
                  onClick={(e) => { e.stopPropagation(); void props.onCreate(page.id, inAnchorTree ? 'anchor' : 'page') }}>
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
          <span className="nt-section-label">锚点</span>
          <span className="pt-section-rule" />
          <Tooltip content="新建领域（像图书分类那样的一格，锚点归在里面）">
            <button type="button" className="nt-row-key" style={{ opacity: 1 }} aria-label="新建领域" onClick={() => { void createNode(null) }}>
              <FolderPlus size={12} />
            </button>
          </Tooltip>
          <Tooltip content="新建锚点（先不归领域，之后拖进去）">
            <button type="button" className="nt-row-key" style={{ opacity: 1 }} aria-label="新建锚点" onClick={() => { void props.onCreate(null, 'anchor') }}>
              <Plus size={12} strokeWidth={2.6} />
            </button>
          </Tooltip>
        </div>
        {domainRoots.map((p) => renderRow(p, 0, false))}
        {domainRoots.length > 0 && looseAnchors.length > 0 && (
          <div className="nt-subsection">还没归领域</div>
        )}
        {looseAnchors.map((p) => renderRow(p, 0, false))}
        {!tree.loading && domainRoots.length === 0 && looseAnchors.length === 0 && (
          <div className="nt-side-empty">还没有锚点。在正文里打 # 也能新建</div>
        )}

        <div className="nt-section">
          <span className="nt-section-label">页面</span>
          <span className="pt-section-rule" />
          <Tooltip content="新建页面">
            <button type="button" className="nt-row-key" style={{ opacity: 1 }} aria-label="新建页面" onClick={() => { void props.onCreate(null) }}>
              <Plus size={12} strokeWidth={2.6} />
            </button>
          </Tooltip>
        </div>
        {/* 两张特殊的页面：永远排在「页面」最上面，不能拖、不能删、不能改名 */}
        {([
          [THOUGHTS_VIEW, '想法卡片', <MessageSquareQuote key="i" size={14} />],
          [CONTEXTS_VIEW, '语境库·B站', <Library key="i" size={14} />],
        ] as const).map(([id, label, icon]) => (
          <div key={id} className="nt-row" data-selected={selectedId === id ? '1' : undefined}
            onClick={() => props.onSelect(id)}>
            <div className="nt-row-body">
              <span className="nt-caret-slot" />
              <span className="nt-row-icon">{icon}</span>
              <span className="nt-row-title">{label}</span>
              <Tooltip content="特殊页面，固定在最上面">
                <span className="nt-pin-mark"><Pin size={11} /></span>
              </Tooltip>
            </div>
          </div>
        ))}
        {pageRoots.map((p) => renderRow(p, 0, false))}
      </div>

      <div className="ti-groove-h" style={{ margin: '0 10px' }} />
      <div className="nt-side-foot">
        <button ref={trashRef} type="button" className="ti-key nt-foot-key" data-active={props.trashOpen ? '1' : undefined}
          onClick={() => { if (trashRef.current) props.onToggleTrash(trashRef.current) }}>
          <Trash2 size={13} />回收站
        </button>
        <button type="button" className="ti-key ti-key-primary nt-foot-key" style={{ flex: 1 }} onClick={() => { void props.onCreate(null) }}>
          <FilePlus2 size={13} />新建页面
        </button>
      </div>

      {menu && (
        <PopMenu
          anchor={menu.anchor}
          placement="right-start"
          onClose={() => setMenu(null)}
          items={menu.page.kind === 'alias' ? [
            { key: 'open', label: '打开这个锚点', icon: Hash, onSelect: () => { if (menu.page.aliasOf) props.onSelect(menu.page.aliasOf) } },
            'sep',
            { key: 'drop', label: '去掉这个分身（锚点还在）', icon: Trash2, danger: true, onSelect: () => { void tree.removeAlias(menu.page.id) } },
          ] : menu.page.kind === 'group' ? [
            { key: 'rename', label: '重命名', icon: PenLine, onSelect: () => setRenaming(menu.rowKey) },
            { key: 'anchor', label: '在里面新建锚点', icon: Plus, onSelect: () => { void props.onCreate(menu.page.id, 'anchor') } },
            {
              key: 'node',
              label: '在里面新建下级结点',
              icon: FolderPlus,
              onSelect: () => { props.onToggleExpand(menu.page.id, true); void createNode(menu.page.id) },
            },
            'sep',
            { key: 'trash', label: '连同里面的锚点移到回收站', icon: Trash2, danger: true, onSelect: () => props.onTrash(menu.page.id) },
          ] : [
            {
              key: 'fav',
              label: menu.page.favorite ? '取消收藏' : '收藏',
              icon: menu.page.favorite ? StarOff : Star,
              onSelect: () => { void tree.setFavorite(menu.page.id, !menu.page.favorite) },
            },
            { key: 'rename', label: '重命名', icon: PenLine, onSelect: () => setRenaming(menu.rowKey) },
            {
              key: 'child',
              label: menu.page.kind === 'anchor' ? '新建下级锚点' : '新建子页面',
              icon: Plus,
              onSelect: () => { void props.onCreate(menu.page.id, menu.page.kind === 'anchor' ? 'anchor' : 'page') },
            },
            ...(menu.page.kind === 'anchor' ? [{
              key: 'alias',
              label: '在别的领域放一个分身…',
              icon: CopyPlus,
              onSelect: () => setAliasPick({ anchorId: menu.page.id, rect: menu.anchor.getBoundingClientRect() }),
            }] : []),
            'sep',
            { key: 'trash', label: '移到回收站', icon: Trash2, danger: true, onSelect: () => props.onTrash(menu.page.id) },
          ]}
        />
      )}
      {aliasPick && (
        <MoveToPicker
          anchor={aliasPick.rect}
          excludeId={aliasPick.anchorId}
          title="分身放到哪个领域 / 结点里"
          accept={(p) => p.kind === 'group'}
          emptyText="还没有领域。先在「锚点」右边新建一个"
          onPick={(nodeId) => {
            props.onToggleExpand(nodeId, true)
            void tree.create(nodeId, { kind: 'alias', aliasOf: aliasPick.anchorId })
          }}
          onClose={() => setAliasPick(null)}
        />
      )}
    </aside>
  )
}
