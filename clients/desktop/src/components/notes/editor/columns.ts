// ══════════════════════════════════════════════
// 笔记分栏（自己写的，不用 BlockNote 的 GPL 分栏包）
//   结构：columnList（并排的一组栏，至少两栏）→ column（一栏，里面是普通块）
//   BlockNote 核心（MPL）本来就认识这两个节点名：块 id、侧边 ⋮⋮ 菜单、删空的栏自动收起都是核心做的，
//   这里只补三件事：
//   1. 两个节点的定义（以及注册成块，好让正文 JSON 里能存 / 能读）
//   2. 拖块到另一块的左右边缘 → 竖向落点线 → 松手变成并排两栏（落在已有分栏里就多加一栏）
//   3. 拖两栏之间的缝调栏宽（拖的时候只改样式，松手才写一次，撤销一步就回去）
// ══════════════════════════════════════════════

import { createBlockSpecFromTiptapNode, createExtension, fixColumnList, fragmentToBlocks, isEmptyColumn } from '@blocknote/core'
import type { ComputeDropPositionContext, DropCursorOptions } from '@blocknote/core/extensions'
import { mergeAttributes, Node } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
// 只取类型（运行时没有循环引用）：note-schema 用到这里的块定义，这里的函数操作的就是那个编辑器
import type { NoteEditorInstance, NotePartialBlock } from './note-schema'

/** 一行最多几栏（再多就挤得没法看了） */
export const MAX_COLUMNS = 5
/**
 * 「放到左边 / 右边」的感应区（按块宽的比例，夹在上下限里）：
 * 左边从块的左缘往里算——拿 ⋮⋮ 拖着往下走时鼠标在块的左外侧，不会误判成分栏；
 * 右边给得宽一些：块一般铺满整行，字很短时右缘离得远，太窄了根本找不到
 */
const LEFT_ZONE = { ratio: 0.12, min: 40, max: 64 }
const RIGHT_ZONE = { ratio: 0.25, min: 80, max: 200 }

const zoneWidth = (w: number, z: { ratio: number; min: number; max: number }) =>
  Math.min(Math.max(w * z.ratio, z.min), z.max)
/** 鼠标离两栏之间的缝多近算「抓到了缝」 */
const RESIZE_GRAB_PX = 8
/** 拖缝时每栏至少留多宽 */
const MIN_COLUMN_PX = 90

// ── 1. 节点 + 块定义 ──

// 优先级调低：ProseMirror 需要「随便补一个块」时（比如删掉最后一块）按 schema 里的先后挑第一个能放的，
// 分栏排在普通块前面的话，删空页面会被补成一组空的两栏
const NODE_PRIORITY = 10

const ColumnListNode = Node.create({
  name: 'columnList',
  priority: NODE_PRIORITY,
  group: 'childContainer bnBlock blockGroupChild',
  // 至少两栏：只剩一栏时核心会把它拆回普通块
  content: 'column column+',
  parseHTML() {
    return [{ tag: 'div[data-node-type="columnList"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'bn-block-column-list', 'data-node-type': 'columnList' }), 0]
  },
})

const ColumnNode = Node.create({
  name: 'column',
  priority: NODE_PRIORITY,
  group: 'childContainer bnBlock',
  content: 'blockContainer+',
  addAttributes() {
    return {
      // 栏宽是相对比例（flex-grow），默认每栏 1
      width: {
        default: 1,
        parseHTML: (el: HTMLElement) => {
          const v = Number(el.getAttribute('data-width'))
          return Number.isFinite(v) && v > 0 ? v : 1
        },
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-width': String(attrs.width),
          style: `flex-grow: ${Number(attrs.width) || 1}`,
        }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-node-type="column"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'bn-block-column', 'data-node-type': 'column' }), 0]
  },
})

// ── 2. 拖到左右边缘 → 分栏 ──

interface SideDrop {
  readonly targetId: string
  readonly side: 'left' | 'right'
}

/** 最近一次 dragover 算出来的「侧边落点」：按编辑器视图分开记 */
const pendingSideDrop = new WeakMap<EditorView, SideDrop>()

/** 拖动中的块（⋮⋮ 拖起来时，核心把它们放在 view.dragging 里） */
function draggedBlockIds(view: EditorView): string[] {
  const slice = view.dragging?.slice
  if (!slice) return []
  try {
    return fragmentToBlocks(slice.content).map((b) => b.id)
  } catch {
    return []
  }
}

/** 光标所在高度上的「顶层块」：根级的块，或分栏里一栏的直接子块（缩进的子块算到它的顶层祖先上） */
function topLevelBlockAt(view: EditorView, x: number, y: number): { node: PMNode; pos: number } | null {
  const rect = view.dom.getBoundingClientRect()
  const style = getComputedStyle(view.dom)
  const left = rect.left + parseFloat(style.paddingLeft) + 2
  const right = rect.right - parseFloat(style.paddingRight) - 2
  const hit = view.posAtCoords({ left: Math.min(Math.max(x, left), right), top: y })
  if (!hit) return null

  const findIn = (pos: number) => {
    const $p = view.state.doc.resolve(pos)
    let found: { node: PMNode; pos: number } | null = null
    // 从里往外走，记下最外层那个合格的块
    for (let d = $p.depth; d > 0; d--) {
      const node = $p.node(d)
      if (node.type.name !== 'blockContainer') continue
      const parent = $p.node(d - 1)
      if (parent.type.name === 'column' || (parent.type.name === 'blockGroup' && d - 1 === 1)) {
        found = { node, pos: $p.before(d) }
      }
    }
    return found
  }
  return findIn(hit.pos) ?? (hit.inside >= 0 ? findIn(hit.inside + 1) : null)
}

function columnCountOf(view: EditorView, blockPos: number): number {
  const $p = view.state.doc.resolve(blockPos)
  for (let d = $p.depth; d > 0; d--) {
    if ($p.node(d).type.name === 'columnList') return $p.node(d).childCount
  }
  return 1
}

/** 给编辑器的落点线钩子：左右边缘画竖线，其余照旧（块之间的横线） */
export function computeColumnDropPosition({ view, event, defaultPosition }: ComputeDropPositionContext) {
  pendingSideDrop.delete(view)
  const dragged = draggedBlockIds(view)
  if (dragged.length === 0) return defaultPosition

  const target = topLevelBlockAt(view, event.clientX, event.clientY)
  if (!target) return defaultPosition
  const targetId = target.node.attrs.id as string | undefined
  if (!targetId || dragged.includes(targetId)) return defaultPosition

  const dom = view.nodeDOM(target.pos)
  if (!(dom instanceof HTMLElement)) return defaultPosition
  const r = dom.getBoundingClientRect()
  if (event.clientY < r.top || event.clientY > r.bottom) return defaultPosition

  // 鼠标跑到正文区外面（左边 ⋮⋮ 那一溜、右边空白）时，BlockNote 会把拖动事件的 x 夹到正文边缘再转发一次（synthetic）。
  // 左边那次转发正好落在「放左边」的感应区里——拿 ⋮⋮ 竖着往下拖就会一直出竖线。所以转发来的只认右边：
  // 拖过右边缘 = 想放右边，这是自然的手势；左边只认鼠标真的进到块里面靠左那一条
  const synthetic = (event as DragEvent & { synthetic?: boolean }).synthetic === true
  let side: SideDrop['side'] | null = null
  if (!synthetic && event.clientX >= r.left && event.clientX < r.left + zoneWidth(r.width, LEFT_ZONE)) side = 'left'
  else if (event.clientX > r.right - zoneWidth(r.width, RIGHT_ZONE)) side = 'right'
  if (!side) return defaultPosition

  // 目标已经在分栏里、而且满栏了：不再加
  const inColumns = columnCountOf(view, target.pos)
  if (inColumns >= MAX_COLUMNS) return defaultPosition

  pendingSideDrop.set(view, { targetId, side })
  return { pos: target.pos, orientation: side === 'left' ? 'block-vertical-left' as const : 'block-vertical-right' as const }
}

type AnyEditor = NoteEditorInstance

/** 把拖动的块放到目标块旁边：目标在分栏里就新加一栏，否则把目标和它们包成并排两栏 */
function applySideDrop(editor: AnyEditor, draggedIds: readonly string[], drop: SideDrop) {
  editor.transact(() => {
    const dragged = draggedIds.map((id) => editor.getBlock(id)).filter((b) => b !== undefined)
    if (dragged.length === 0) return
    // 先拿走（核心会顺手收掉被拿空的栏），再按拿走之后的结构找目标
    editor.removeBlocks(dragged.map((b) => b.id))
    const target = editor.getBlock(drop.targetId)
    if (!target) {
      // 理论上不会发生；万一目标没了，至少别把块弄丢
      editor.insertBlocks(dragged, editor.document[editor.document.length - 1], 'after')
      return
    }
    const parent = editor.getParentBlock(drop.targetId)
    const newColumn: NotePartialBlock = { type: 'column', props: { width: 1 }, children: dragged }
    if (parent?.type === 'column') {
      editor.insertBlocks([newColumn], parent.id, drop.side === 'left' ? 'before' : 'after')
      return
    }
    const targetColumn: NotePartialBlock = { type: 'column', props: { width: 1 }, children: [target] }
    editor.replaceBlocks([target.id], [{
      type: 'columnList',
      children: drop.side === 'left' ? [newColumn, targetColumn] : [targetColumn, newColumn],
    }])
  })
}

// ── 3. 拖缝调栏宽 ──
//   悬停高亮和拖动中的预览宽度都放在插件状态里，用「节点装饰」画出来——
//   不能直接改栏的 DOM 属性 / 样式：ProseMirror 盯着自己的 DOM，改了会被当成内容变动去「修复」。
//   松手时才真正写一次栏宽（一步撤销就能回去）。

interface ColumnsUi {
  /** 鼠标停在哪一栏的左缘（这一栏和它左边那栏之间的缝） */
  readonly edgeId: string | null
  /** 正在拖的那条缝 */
  readonly activeId: string | null
  /** 拖动中的预览宽度：栏 id → 比例 */
  readonly preview: Readonly<Record<string, number>> | null
}

const EMPTY_UI: ColumnsUi = { edgeId: null, activeId: null, preview: null }

const columnsPluginKey = new PluginKey<ColumnsUi>('nt-columns')

function setUi(view: EditorView, patch: Partial<ColumnsUi>) {
  view.dispatch(view.state.tr.setMeta(columnsPluginKey, patch))
}

function uiOf(view: EditorView): ColumnsUi {
  return columnsPluginKey.getState(view.state) ?? EMPTY_UI
}

/** 鼠标附近能抓的缝：某一栏（非第一栏）的左缘；只读 DOM 位置，不改 DOM */
function resizableEdgeAt(view: EditorView, target: EventTarget | null, x: number): HTMLElement | null {
  if (!(target instanceof Element) || !view.editable) return null
  const list = target.closest('[data-node-type="columnList"]')
  if (!list || !view.dom.contains(list)) return null
  const columns = Array.from(list.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.nodeType === 'column')
  return columns.slice(1).find((c) => Math.abs(c.getBoundingClientRect().left - x) <= RESIZE_GRAB_PX) ?? null
}

function columnPosById(view: EditorView, id: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null
  view.state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === 'column' && node.attrs.id === id) {
      found = { pos, node }
      return false
    }
    return true
  })
  return found
}

function startResize(view: EditorView, edge: HTMLElement, startX: number) {
  const leftEl = edge.previousElementSibling
  if (!(leftEl instanceof HTMLElement)) return
  const leftId = leftEl.dataset.id
  const rightId = edge.dataset.id
  if (!leftId || !rightId) return
  const leftW = Number(leftEl.dataset.width) || 1
  const rightW = Number(edge.dataset.width) || 1
  const leftPx = leftEl.getBoundingClientRect().width
  const rightPx = edge.getBoundingClientRect().width
  const totalPx = leftPx + rightPx
  const weightSum = leftW + rightW
  let weights = { left: leftW, right: rightW }

  document.body.classList.add('nt-col-resizing')
  setUi(view, { activeId: rightId, edgeId: rightId, preview: null })

  const onMove = (e: MouseEvent) => {
    const px = Math.min(Math.max(leftPx + (e.clientX - startX), MIN_COLUMN_PX), totalPx - MIN_COLUMN_PX)
    const left = Number(((px / totalPx) * weightSum).toFixed(4))
    weights = { left, right: Number((weightSum - left).toFixed(4)) }
    setUi(view, { preview: { [leftId]: weights.left, [rightId]: weights.right } })
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.classList.remove('nt-col-resizing')
    const left = columnPosById(view, leftId)
    const right = columnPosById(view, rightId)
    const tr = view.state.tr.setMeta(columnsPluginKey, EMPTY_UI)
    if (left && right && (weights.left !== leftW || weights.right !== rightW)) {
      tr.setNodeMarkup(left.pos, undefined, { ...left.node.attrs, width: weights.left })
        .setNodeMarkup(right.pos, undefined, { ...right.node.attrs, width: weights.right })
    }
    view.dispatch(tr)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/** 悬停 / 拖动中的缝加 class，预览宽度加内联 flex-grow（装饰里的 style 会接在节点自己的 style 后面，后写的生效） */
function columnDecorations(state: EditorState): DecorationSet | null {
  const ui = columnsPluginKey.getState(state)
  if (!ui || (!ui.edgeId && !ui.activeId && !ui.preview)) return null
  const decos: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'column') return true
    const id = node.attrs.id as string
    const attrs: Record<string, string> = {}
    if (id === ui.edgeId || id === ui.activeId) attrs.class = 'nt-col-edge'
    const w = ui.preview?.[id]
    if (w !== undefined) attrs.style = `flex-grow: ${w}`
    if (attrs.class || attrs.style) decos.push(Decoration.node(pos, pos + node.nodeSize, attrs))
    return false
  })
  return DecorationSet.create(state.doc, decos)
}

// ── 拖走最后一块后收起空栏 ──
//   用 BlockNote 的接口删 / 挪块时，核心会自己收拾；但普通的上下拖动走的是 ProseMirror 原生的「拖放移动」，
//   两栏里拖空一栏时 ProseMirror 为了满足结构会往空栏里塞一个空段落，留下一个空栏。
//   这里在原生拖放之后补一刀：只处理「这次拖放后空栏变多了」的那组分栏，
//   没被拖动碰到的分栏（比如用斜杠菜单刚建、还空着的）不动。剩一栏时整组拆回普通块（和 Notion 一样）。

/** 每组分栏（按 columnList 的 id）里有几栏是空的。栏本身的 id 不可靠：拖空的栏会被 ProseMirror 整个换成新的空栏 */
function emptyColumnCounts(state: EditorState): Map<string, number> {
  const counts = new Map<string, number>()
  state.doc.descendants((node) => {
    if (node.type.name === 'columnList') {
      let empty = 0
      node.forEach((col) => { if (isEmptyColumn(col)) empty++ })
      counts.set(node.attrs.id as string, empty)
      return false
    }
    return true
  })
  return counts
}

function collapseColumnsEmptiedByDrop(trs: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null {
  if (!trs.some((tr) => tr.docChanged && tr.getMeta('uiEvent') === 'drop')) return null
  const before = emptyColumnCounts(oldState)
  const listPositions: number[] = []
  newState.doc.descendants((node, pos) => {
    if (node.type.name === 'columnList') {
      const was = before.get(node.attrs.id as string)
      let empty = 0
      node.forEach((col) => { if (isEmptyColumn(col)) empty++ })
      // 这组分栏这次拖放之后多出了空栏 = 有一栏被拖空了
      if (was !== undefined && empty > was) listPositions.push(pos)
      return false
    }
    return true
  })
  if (listPositions.length === 0) return null
  const tr = newState.tr
  // 从后往前修，前面的位置不受影响
  for (const pos of listPositions.reverse()) fixColumnList(tr, pos)
  return tr.docChanged ? tr : null
}

// ── 合成：插件 + 块定义 ──

// editor 的类型不在这里标注：块定义（columnListBlockSpec）本身就是 NoteEditorInstance 的一部分，标了会成环
const ColumnsExtension = createExtension(({ editor }) => ({
  key: 'nt-columns',
  prosemirrorPlugins: [
    new Plugin({
      key: columnsPluginKey,
      state: {
        init: (): ColumnsUi => EMPTY_UI,
        apply: (tr, prev: ColumnsUi): ColumnsUi => {
          const patch = tr.getMeta(columnsPluginKey) as Partial<ColumnsUi> | undefined
          return patch ? { ...prev, ...patch } : prev
        },
      },
      appendTransaction: collapseColumnsEmptiedByDrop,
      props: {
        decorations: columnDecorations,
        handleDrop(view, event, slice, moved) {
          const drop = pendingSideDrop.get(view)
          pendingSideDrop.delete(view)
          if (!drop || !moved) return false
          let ids: string[] = []
          try {
            ids = fragmentToBlocks(slice.content).map((b) => b.id)
          } catch {
            return false
          }
          if (ids.length === 0 || ids.includes(drop.targetId)) return false
          event.preventDefault()
          applySideDrop(editor as unknown as AnyEditor, ids, drop)
          return true
        },
        handleDOMEvents: {
          mousemove(view, event) {
            if (document.body.classList.contains('nt-col-resizing')) return false
            const edgeId = resizableEdgeAt(view, event.target, event.clientX)?.dataset.id ?? null
            // 只在悬停的缝变了时才派发（不是每次鼠标动都派）
            if (edgeId !== uiOf(view).edgeId) setUi(view, { edgeId })
            return false
          },
          mouseleave(view) {
            if (uiOf(view).edgeId && !uiOf(view).activeId) setUi(view, { edgeId: null })
            return false
          },
          mousedown(view, event) {
            if (event.button !== 0) return false
            const edge = resizableEdgeAt(view, event.target, event.clientX)
            if (!edge) return false
            event.preventDefault()
            startResize(view, edge, event.clientX)
            return true
          },
        },
      },
    }),
  ],
}))

export const columnListBlockSpec = createBlockSpecFromTiptapNode(
  { node: ColumnListNode, type: 'columnList', content: 'none' },
  {},
  [ColumnsExtension()],
)

export const columnBlockSpec = createBlockSpecFromTiptapNode(
  { node: ColumnNode, type: 'column', content: 'none' },
  { width: { default: 1 } },
)

/** 编辑器的落点线：信号橙细线 + 分栏钩子 */
export const noteDropCursor: DropCursorOptions = {
  width: 4,
  color: '#FF8A4C',
  hooks: { computeDropPosition: computeColumnDropPosition },
}

/** 斜杠菜单「两栏 / 三栏 / 四栏」：空行就地变成分栏，否则插在下面；光标进第一栏。分栏里不能再套分栏，就放到这组分栏后面 */
export function insertColumns(editor: AnyEditor, count: number) {
  editor.transact(() => {
    const block = editor.getTextCursorPosition().block
    const parent = editor.getParentBlock(block.id)
    const list: NotePartialBlock = {
      type: 'columnList',
      children: Array.from({ length: count }, (): NotePartialBlock => ({ type: 'column', props: { width: 1 }, children: [{ type: 'paragraph' }] })),
    }
    const text = Array.isArray(block.content)
      ? (block.content as { type?: string; text?: string }[]).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('').trim()
      : null
    // 斜杠菜单关掉时可能还留着触发符
    const isEmpty = text !== null && (text === '' || text === '/' || text === '、')
    let inserted
    if (parent?.type === 'column') {
      const outer = editor.getParentBlock(parent.id)
      if (isEmpty && text !== '') editor.updateBlock(block, { content: '' })
      inserted = editor.insertBlocks([list], outer?.id ?? block.id, 'after')
    } else if (isEmpty) {
      inserted = editor.replaceBlocks([block.id], [list]).insertedBlocks
    } else {
      inserted = editor.insertBlocks([list], block.id, 'after')
    }
    const first = inserted[0]?.children[0]?.children[0]
    if (first) editor.setTextCursorPosition(first.id, 'start')
  })
}
