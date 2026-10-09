// ══════════════════════════════════════════════
// 点 ⋮⋮ 弹出的块菜单（照 Notion）：
//   删除 / 创建副本 / 转换成 ▸ / 移动到 / 颜色 ▸（表格另有行列标题）
//   「转换成」里有「页面」：块文字当标题、子块当正文，原地换成子页面链接
//   菜单作用在「⋮⋮ 所在的块」；它在多选范围里时，作用在整片选区（和 Notion 一样）
// ══════════════════════════════════════════════

import { useContext, type ComponentType, type ReactNode } from 'react'
import { SideMenuExtension } from '@blocknote/core/extensions'
import {
  AddBlockButton, BlockColorsItem, DragHandleButton, SideMenu, TableColumnHeaderItem, TableRowHeaderItem,
  useBlockNoteEditor, useComponentsContext, useExtensionState, usePortalElement,
} from '@blocknote/react'
import {
  ChevronsUpDown, Code2, Copy, CornerDownRight, FileText, Heading1, Heading2, Heading3,
  Lightbulb, List, ListChecks, ListOrdered, Palette, Pilcrow, Quote, Repeat2, Trash2,
} from 'lucide-react'
import { inlineToPlainText, NoteBlockActionsContext } from './block-actions'
import type { NoteEditorInstance } from './note-schema'

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>

interface TurnIntoOption {
  readonly key: string
  readonly label: string
  readonly icon: Icon
  /** 目标块；page = 转成子页面（特殊处理） */
  readonly to: { type: string; props?: Record<string, unknown> } | 'page'
}

const TURN_INTO: readonly TurnIntoOption[] = [
  { key: 'paragraph', label: '文本', icon: Pilcrow, to: { type: 'paragraph' } },
  { key: 'h1', label: '一级标题', icon: Heading1, to: { type: 'heading', props: { level: 1, isToggleable: false } } },
  { key: 'h2', label: '二级标题', icon: Heading2, to: { type: 'heading', props: { level: 2, isToggleable: false } } },
  { key: 'h3', label: '三级标题', icon: Heading3, to: { type: 'heading', props: { level: 3, isToggleable: false } } },
  { key: 'page', label: '页面', icon: FileText, to: 'page' },
  { key: 'bullet', label: '无序列表', icon: List, to: { type: 'bulletListItem' } },
  { key: 'numbered', label: '有序列表', icon: ListOrdered, to: { type: 'numberedListItem' } },
  { key: 'check', label: '待办清单', icon: ListChecks, to: { type: 'checkListItem' } },
  { key: 'toggle', label: '折叠列表', icon: ChevronsUpDown, to: { type: 'toggleListItem' } },
  { key: 'th1', label: '可折叠一级标题', icon: Heading1, to: { type: 'heading', props: { level: 1, isToggleable: true } } },
  { key: 'th2', label: '可折叠二级标题', icon: Heading2, to: { type: 'heading', props: { level: 2, isToggleable: true } } },
  { key: 'th3', label: '可折叠三级标题', icon: Heading3, to: { type: 'heading', props: { level: 3, isToggleable: true } } },
  { key: 'code', label: '代码', icon: Code2, to: { type: 'codeBlock' } },
  { key: 'quote', label: '引用', icon: Quote, to: { type: 'quote' } },
  { key: 'callout', label: '提示框', icon: Lightbulb, to: { type: 'callout' } },
]

const TYPE_LABEL: Record<string, string> = {
  paragraph: '文本', heading: '标题', bulletListItem: '无序列表', numberedListItem: '有序列表',
  checkListItem: '待办清单', toggleListItem: '折叠列表', codeBlock: '代码', quote: '引用', callout: '提示框',
  table: '表格', image: '图片', video: '视频', audio: '音频', file: '文件', divider: '分割线', pageLink: '页面链接',
}

type AnyBlock = ReturnType<NoteEditorInstance['getBlock']> & object

/** 有文字可转的块（行内内容 / 代码）；表格、图片、分割线、页面链接不能「转换成」 */
function isConvertible(block: AnyBlock): boolean {
  return Array.isArray(block.content)
}

function blockLabel(block: AnyBlock): string {
  const props = block.props as Record<string, unknown>
  if (block.type === 'heading') return `${props.isToggleable ? '可折叠' : ''}${['一', '二', '三', '四', '五', '六'][Number(props.level) - 1] ?? ''}级标题`
  return TYPE_LABEL[block.type] ?? block.type
}

function isCurrent(block: AnyBlock, opt: TurnIntoOption): boolean {
  if (opt.to === 'page' || opt.to.type !== block.type) return false
  if (block.type !== 'heading') return true
  const props = block.props as Record<string, unknown>
  return props.level === opt.to.props?.level && Boolean(props.isToggleable) === opt.to.props?.isToggleable
}

function convertBlock(editor: NoteEditorInstance, block: AnyBlock, to: { type: string; props?: Record<string, unknown> }) {
  // 代码块的内容是纯文本、别的块是带样式的行内内容：两边互转要把文字显式带过去，
  // 只换 type 的话 ProseMirror 会因为内容不合格把整次更新拒掉
  const crossesPlain = to.type === 'codeBlock' || block.type === 'codeBlock'
  const update = {
    type: to.type,
    props: to.props ?? {},
    ...(crossesPlain ? { content: inlineToPlainText(block.content) } : null),
  }
  editor.updateBlock(block, update as Parameters<NoteEditorInstance['updateBlock']>[1])
}

function ItemLabel({ icon: IconC, text, hint }: { readonly icon: Icon; readonly text: string; readonly hint?: string }) {
  return (
    <span className="nt-bm-label">
      <IconC size={15} strokeWidth={2} />
      <span className="nt-bm-text">{text}</span>
      {hint && <span className="nt-bm-hint">{hint}</span>}
    </span>
  )
}

/** 当前 ⋮⋮ 的块；它在多选里就取整片选区 */
function useTargetBlocks(): { block: AnyBlock | undefined; targets: AnyBlock[] } {
  const editor = useBlockNoteEditor() as unknown as NoteEditorInstance
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block }) as AnyBlock | undefined
  if (!block) return { block, targets: [] }
  const selected = editor.getSelection()?.blocks as AnyBlock[] | undefined
  const targets = selected && selected.some((b) => b.id === block.id) ? selected : [block]
  return { block, targets }
}

export function NoteDragHandleMenu({ children }: { readonly children?: ReactNode }) {
  const Components = useComponentsContext()!
  const editor = useBlockNoteEditor() as unknown as NoteEditorInstance
  const portalElement = usePortalElement()
  const actions = useContext(NoteBlockActionsContext)
  const { block, targets } = useTargetBlocks()

  if (!block) return null
  const convertible = targets.every(isConvertible)
  const multi = targets.length > 1

  return (
    <Components.Generic.Menu.Dropdown className="bn-menu-dropdown bn-drag-handle-menu nt-block-menu">
      <Components.Generic.Menu.Label className="nt-bm-head">
        {multi ? `已选 ${targets.length} 个块` : blockLabel(block)}
      </Components.Generic.Menu.Label>

      <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => editor.removeBlocks(targets)}>
        <ItemLabel icon={Trash2} text="删除" />
      </Components.Generic.Menu.Item>

      {actions && (
        <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => actions.duplicate(targets.map((b) => b.id))}>
          <ItemLabel icon={Copy} text="创建副本" hint="Ctrl+D" />
        </Components.Generic.Menu.Item>
      )}

      {convertible && (
        <Components.Generic.Menu.Root position="right" sub portalElement={portalElement}>
          <Components.Generic.Menu.Trigger sub>
            <Components.Generic.Menu.Item className="bn-menu-item" subTrigger>
              <ItemLabel icon={Repeat2} text="转换成" />
            </Components.Generic.Menu.Item>
          </Components.Generic.Menu.Trigger>
          <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown nt-block-menu nt-turn-into">
            {TURN_INTO.map((opt) => {
              // 转成页面一次只能一个块
              if (opt.to === 'page' && (multi || !actions)) return null
              const current = !multi && isCurrent(block, opt)
              return (
                <Components.Generic.Menu.Item
                  key={opt.key}
                  className="bn-menu-item"
                  checked={current ? true : undefined}
                  onClick={() => {
                    if (opt.to === 'page') {
                      actions?.turnIntoPage(block.id)
                      return
                    }
                    const to = opt.to
                    targets.forEach((t) => convertBlock(editor, t, to))
                  }}
                >
                  <ItemLabel icon={opt.icon} text={opt.label} />
                </Components.Generic.Menu.Item>
              )
            })}
          </Components.Generic.Menu.Dropdown>
        </Components.Generic.Menu.Root>
      )}

      {actions && (
        <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => actions.openMoveTo(targets.map((b) => b.id))}>
          <ItemLabel icon={CornerDownRight} text="移动到" />
        </Components.Generic.Menu.Item>
      )}

      <Components.Generic.Menu.Divider className="nt-bm-sep" />

      <BlockColorsItem><ItemLabel icon={Palette} text="颜色" /></BlockColorsItem>
      <TableRowHeaderItem>{editor.dictionary.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{editor.dictionary.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
      {children}
    </Components.Generic.Menu.Dropdown>
  )
}

/**
 * 块左侧的「＋ ⋮⋮」。分栏里只留 ⋮⋮：右栏块的这组按钮会落在两栏之间的缝上，
 * 两个键都在就把拖缝调宽的那条线整个盖住了（加块用回车或 / 一样方便）
 */
export function NoteSideMenu() {
  const editor = useBlockNoteEditor() as unknown as NoteEditorInstance
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block }) as AnyBlock | undefined
  const inColumn = block ? editor.getParentBlock(block.id)?.type === 'column' : false
  return (
    <SideMenu>
      {!inColumn && <AddBlockButton />}
      <DragHandleButton dragHandleMenu={NoteDragHandleMenu} />
    </SideMenu>
  )
}
