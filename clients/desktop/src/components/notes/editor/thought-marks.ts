// ══════════════════════════════════════════════
// 批注（想法卡片）在正文里的两种记号，都是带着批注 id 的文字样式：
//   · thought     你写的那段话（紫字，插批注时自动带一对括号）
//   · thoughtHl   涂上的那片原文（可以跨段）；和 thought 用同一个 id 连在一起
//   后端每次存正文时按 id 把它们收成一张想法卡片（src-tauri/src/notes_index.rs，样式名两边要一致）。
//
//   两个样式都不「粘」：光标在记号的边上打字，打出来的是普通字，不会把批注越拖越长。
//   唯一要补的是批注里夹着 # 引用时：引用本身不带样式，光标贴着它就会被当成在批注外面，
//   所以这里有个小插件，发现光标两边（跳过引用）是同一条批注，就让接下来打的字仍然算批注。
// ══════════════════════════════════════════════

import { createExtension, createStyleSpecFromTipTapMark } from '@blocknote/core'
import { Mark } from '@tiptap/core'
import type { Mark as PMMark, MarkType, Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

export const THOUGHT_STYLE = 'thought'
export const THOUGHT_HL_STYLE = 'thoughtHl'

/** 插批注时自动带上的一对括号（批注原话存进卡片时会去掉这一层） */
const BRACKETS = '（）'

function idMark(name: string, className: string) {
  return Mark.create({
    name,
    inclusive: false,
    addAttributes() {
      return {
        // 属性名必须叫 stringValue：BlockNote 把样式的值存在这个名字下
        stringValue: {
          default: undefined,
          keepOnSplit: true,
          parseHTML: (el: HTMLElement) => el.getAttribute('data-value'),
          renderHTML: (attrs: { stringValue?: string }) =>
            (attrs.stringValue !== undefined ? { 'data-value': attrs.stringValue } : {}),
        },
      }
    },
    parseHTML() {
      return [{ tag: `span[data-style-type="${name}"]` }]
    },
    renderHTML({ HTMLAttributes }) {
      return ['span', { ...HTMLAttributes, 'data-style-type': name, class: className }, 0]
    },
  })
}

export const thoughtStyleSpec = createStyleSpecFromTipTapMark(idMark(THOUGHT_STYLE, 'nt-thought'), 'string')
export const thoughtHlStyleSpec = createStyleSpecFromTipTapMark(idMark(THOUGHT_HL_STYLE, 'nt-thought-hl'), 'string')

function markId(marks: readonly PMMark[], type: MarkType | undefined): string {
  if (!type) return ''
  const found = marks.find((m) => m.type === type)
  const value: unknown = found?.attrs.stringValue
  return typeof value === 'string' ? value : ''
}

/** 从父节点的第 index 个子节点起往一个方向找最近的一段文字，返回它带的批注 id（中间的 # 引用这类行内小件跳过去） */
function nearestTextThought(parent: PMNode, index: number, step: 1 | -1, type: MarkType): string {
  for (let i = index; i >= 0 && i < parent.childCount; i += step) {
    const child = parent.child(i)
    if (child.isText) return markId(child.marks, type)
    if (!child.isInline || !child.isAtom) return ''
  }
  return ''
}

/** 光标两边（跳过引用）是同一条批注时，这条批注的 id；否则 '' */
function thoughtAroundCursor(state: EditorState): string {
  const type = state.schema.marks[THOUGHT_STYLE]
  const { selection } = state
  if (!type || !selection.empty) return ''
  const $pos = selection.$from
  if (!$pos.parent.inlineContent) return ''
  // 光标落在一段文字中间：那段文字自己说了算
  if ($pos.textOffset > 0) return markId($pos.parent.child($pos.index()).marks, type)
  const left = nearestTextThought($pos.parent, $pos.index() - 1, -1, type)
  if (!left) return ''
  return left === nearestTextThought($pos.parent, $pos.index(), 1, type) ? left : ''
}

const keepThoughtKey = new PluginKey('nt-keep-thought')

function keepThoughtAcrossRefs(_trs: readonly Transaction[], _old: EditorState, state: EditorState): Transaction | null {
  const type = state.schema.marks[THOUGHT_STYLE]
  if (!type) return null
  const id = thoughtAroundCursor(state)
  if (!id) return null
  const current = state.storedMarks ?? state.selection.$from.marks()
  if (type.isInSet(current)) return null
  return state.tr.setStoredMarks([...current, type.create({ stringValue: id })])
}

/** 交给编辑器的扩展（useCreateBlockNote 的 extensions） */
export const ThoughtExtension = createExtension(() => ({
  key: 'nt-thought',
  prosemirrorPlugins: [
    new Plugin({ key: keepThoughtKey, appendTransaction: keepThoughtAcrossRefs }),
  ],
}))

/** 光标 / 选区碰到的那条批注（在批注的话里，或在它涂的那片原文里）；没有是 '' */
export function thoughtAtSelection(state: EditorState): string {
  const thought = state.schema.marks[THOUGHT_STYLE]
  const hl = state.schema.marks[THOUGHT_HL_STYLE]
  const { $from, empty, from, to } = state.selection
  if (empty) {
    const around = thoughtAroundCursor(state)
    if (around) return around
    const here = [...$from.marks(), ...($from.nodeAfter?.marks ?? [])]
    return markId(here, thought) || markId(here, hl)
  }
  let found = ''
  state.doc.nodesBetween(from, to, (node) => {
    if (found || !node.isText) return
    found = markId(node.marks, thought) || markId(node.marks, hl)
  })
  return found
}

/** 光标在不在某条批注的话里（往批注里插 # 引用时后面不补空格，免得把批注切开） */
export function cursorInThought(state: EditorState): boolean {
  return thoughtAroundCursor(state) !== ''
}

/**
 * 插一条批注：有选区就把选中的那片原文涂上（可以跨段），在选区末尾放一对括号、光标落在括号中间；
 * 没有选区就只在光标处放括号。返回新批注的 id；这里放不了字（比如选中的是图片）返回 null。
 */
export function insertThought(view: EditorView): string | null {
  const { state } = view
  const thought = state.schema.marks[THOUGHT_STYLE]
  const hl = state.schema.marks[THOUGHT_HL_STYLE]
  if (!thought || !hl) return null
  const { from, to, empty } = state.selection
  if (!state.doc.resolve(to).parent.inlineContent) return null

  const id = crypto.randomUUID()
  let tr = state.tr
  if (!empty) tr = tr.addMark(from, to, hl.create({ stringValue: id }))
  tr = tr.insert(to, state.schema.text(BRACKETS, [thought.create({ stringValue: id })]))
  tr = tr.setSelection(TextSelection.create(tr.doc, to + 1))
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return id
}

/** 删掉一条批注：它的话整段删掉，涂上的那片原文恢复原样（夹在话里的 # 引用留下，变成普通引用） */
export function removeThought(view: EditorView, id: string): void {
  const { state } = view
  const thought = state.schema.marks[THOUGHT_STYLE]
  const hl = state.schema.marks[THOUGHT_HL_STYLE]
  if (!thought || !hl || !id) return
  const ranges: Array<[number, number]> = []
  state.doc.descendants((node, pos) => {
    if (node.isText && markId(node.marks, thought) === id) ranges.push([pos, pos + node.nodeSize])
  })
  let tr = state.tr.removeMark(0, state.doc.content.size, hl.create({ stringValue: id }))
  // 从后往前删，前面的位置不受影响
  for (const [start, end] of ranges.reverse()) tr = tr.delete(start, end)
  view.dispatch(tr)
  view.focus()
}
