// ══════════════════════════════════════════════
// 笔记的块编辑器（BlockNote）：/ 斜杠菜单、⋮⋮ 拖拽、Tab 缩进、折叠块、待办、代码高亮、表格、图片……
//   · 每个页面一个编辑器实例（外面按页面 id 换 key），撤销历史不串页
//   · 只负责编辑：内容变了通知外面（onChange），保存节奏由页面统一管
//   · 图片 / 文件上传到本地附件目录，正文里存 note-asset://，显示时换成本地 API 地址
// ══════════════════════════════════════════════

import '@blocknote/mantine/style.css'
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { filterSuggestionItems, fragmentToBlocks, insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { zh } from '@blocknote/core/locales'
import { syntaxHighlighter } from '@blocknote/code-block'
import { BlockNoteView } from '@blocknote/mantine'
import {
  getDefaultReactSlashMenuItems, SideMenuController, SuggestionMenuController, useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from '@blocknote/react'
import { Columns2, Columns3, Columns4, FilePlus2, FileText, Lightbulb, Plus } from 'lucide-react'
import { fetchNotePage, resolveNoteAssetUrl, updateNotePage, uploadNoteAsset, type NotePageMeta } from '../../../lib/notes-api'
import MoveToPicker from '../MoveToPicker'
import { ancestorsOf, blocksToText, pageTitle } from '../note-model'
import { getNotePagesMap, openNotePage, setBlockDropHandler } from '../notes-store'
import { NoteSideMenu } from './BlockActionsMenu'
import { inlineToPlainText, NoteBlockActionsContext, withoutIds, type NoteBlockActions } from './block-actions'
import { insertColumns, noteDropCursor } from './columns'
import { noteSchema, type NoteEditorInstance, type NotePartialBlock } from './note-schema'
import { CJK_SLASH, isEmptyLine, withPinyinAliases } from './slash-aliases'

const NOTE_DICTIONARY = {
  ...zh,
  placeholders: {
    ...zh.placeholders,
    default: '输入文字；按 / 插入块，@ 链接页面',
  },
}

/** @ 菜单最多列几条 */
const MENTION_LIMIT = 12

export interface NoteEditorProps {
  readonly pageId: string
  readonly initialContent: readonly unknown[]
  readonly readOnly: boolean
  /** 内容变了（外面决定什么时候存） */
  readonly onChange: () => void
  /** 编辑器建好后交给外面（保存时读 document、标题回车时聚焦） */
  readonly onReady: (editor: NoteEditorInstance | null) => void
  /** 在当前页下建子页面（斜杠菜单「子页面」/ @ 菜单「新建」/ 块转成页面用） */
  readonly onCreateChildPage: (init?: { title?: string; icon?: string }) => Promise<NotePageMeta | null>
  /** 块菜单里跨页面的操作失败了（移动到、转成页面） */
  readonly onError: (message: string) => void
}

export default function NoteEditor({ pageId, initialContent, readOnly, onChange, onReady, onCreateChildPage, onError }: NoteEditorProps) {
  const editor = useCreateBlockNote({
    schema: noteSchema,
    dictionary: NOTE_DICTIONARY,
    // 空数组会让 BlockNote 报错：没内容就交给它建一个空段落
    initialContent: initialContent.length > 0 ? (initialContent as NotePartialBlock[]) : undefined,
    uploadFile: async (file: File) => (await uploadNoteAsset(file, pageId)).url,
    resolveFileUrl: async (url: string) => resolveNoteAssetUrl(url),
    extensions: [syntaxHighlighter],
    tabBehavior: 'prefer-indent',
    // 落点线：信号橙；拖到块的左右边缘画竖线 = 放成并排分栏（见 columns.ts）
    dropCursor: noteDropCursor,
  }, [])

  useEffect(() => {
    onReady(editor)
    return () => onReady(null)
  }, [editor, onReady])

  const createChildFromSlash = useCallback(async () => {
    const page = await onCreateChildPage()
    if (!page) return
    insertOrUpdateBlockForSlashMenu(editor, { type: 'pageLink', props: { pageId: page.id } })
    // 和 Notion 一样建完直接进新页面（本页的改动在离开时会存掉）
    openNotePage(page.id)
  }, [editor, onCreateChildPage])

  const getSlashItems = useCallback(async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const dict = editor.dictionary.slash_menu
    // 分页符是给导出 PDF 用的，笔记里用不上
    const base = getDefaultReactSlashMenuItems(editor)
      .filter((it) => it.title !== dict.page_break.title)
      .map(withPinyinAliases)
    const callout: DefaultReactSuggestionItem = {
      title: '提示框',
      subtext: '带图标和色调的醒目段落',
      aliases: ['callout', 'tip', 'note', 'tishi', '提示', '标注', '注意'],
      group: dict.quote.group,
      icon: <Lightbulb size={18} />,
      onItemClick: () => { insertOrUpdateBlockForSlashMenu(editor, { type: 'callout' }) },
    }
    const subPage: DefaultReactSuggestionItem = {
      title: '子页面',
      subtext: '在这一页里新建一个子页面',
      aliases: ['page', 'subpage', 'yemian', 'ziyemian', 'zym', '页面', '子页', '新页面'],
      group: '页面',
      icon: <FilePlus2 size={18} />,
      onItemClick: () => { void createChildFromSlash() },
    }
    // 提示框紧跟在「引用」后面（同组才不会被拆成两段）
    const quoteAt = base.findIndex((it) => it.title === dict.quote.title)
    const items = quoteAt >= 0
      ? [...base.slice(0, quoteAt + 1), callout, ...base.slice(quoteAt + 1)]
      : [...base, callout]
    const columnItems: DefaultReactSuggestionItem[] = ([2, 3, 4] as const).map((n) => ({
      title: `${['两', '三', '四'][n - 2]}栏`,
      subtext: `并排的 ${n} 栏；也可以把块拖到另一块的左右边缘`,
      aliases: ['column', 'columns', 'fenlan', 'fl', 'lan', `${n}lan`, '分栏', '并排', `${n}栏`],
      group: '布局',
      icon: n === 2 ? <Columns2 size={18} /> : n === 3 ? <Columns3 size={18} /> : <Columns4 size={18} />,
      onItemClick: () => insertColumns(editor, n),
    }))
    return filterSuggestionItems([...items, subPage, ...columnItems], query)
  }, [editor, createChildFromSlash])

  const getMentionItems = useCallback(async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const pages = getNotePagesMap()
    const q = query.trim().toLowerCase()
    const matched = [...pages.values()]
      .filter((p) => p.id !== pageId && (!q || pageTitle(p).toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MENTION_LIMIT)
    const insertMention = (id: string) => {
      editor.insertInlineContent([{ type: 'pageMention', props: { pageId: id } }, ' '])
    }
    const items: DefaultReactSuggestionItem[] = matched.map((p) => ({
      title: pageTitle(p),
      subtext: ancestorsOf(p.id, pages).map((a) => pageTitle(a)).join(' / ') || undefined,
      group: '链接到页面',
      icon: p.icon ? <span className="nt-suggest-emoji">{p.icon}</span> : <FileText size={16} />,
      onItemClick: () => insertMention(p.id),
    }))
    if (q) {
      items.push({
        title: `新建子页面「${query.trim()}」`,
        group: '新建',
        icon: <Plus size={16} />,
        onItemClick: () => {
          void onCreateChildPage({ title: query.trim() }).then((p) => { if (p) insertMention(p.id) })
        },
      })
    }
    return items
  }, [editor, pageId, onCreateChildPage])

  // ── 块菜单（⋮⋮）里要碰页面 / 网络的动作 ──

  const [moveReq, setMoveReq] = useState<{ blockIds: readonly string[]; anchor: DOMRect } | null>(null)

  const duplicate = useCallback((blockIds: readonly string[]) => {
    const blocks = blockIds.map((id) => editor.getBlock(id)).filter((b) => b !== undefined)
    const last = blocks[blocks.length - 1]
    if (!last) return
    const copies = editor.insertBlocks(blocks.map(withoutIds) as NotePartialBlock[], last, 'after')
    const lastCopy = copies[copies.length - 1]
    try {
      if (lastCopy) editor.setTextCursorPosition(lastCopy, 'end')
    } catch {
      // 图片 / 分割线这类没有文字的块放不了光标，复制本身已经成了
    }
  }, [editor])

  const turnIntoPage = useCallback(async (blockId: string) => {
    const block = editor.getBlock(blockId)
    if (!block) return
    const icon = block.type === 'callout' ? block.props.emoji : undefined
    const page = await onCreateChildPage({ title: inlineToPlainText(block.content).trim(), icon })
    if (!page) return
    // 子块搬进新页面当正文；写失败就别动原块，免得内容两头都没了
    if (block.children.length > 0) {
      try {
        await updateNotePage(page.id, { content: block.children, contentText: blocksToText(block.children) })
      } catch (e) {
        onError(`转成页面失败：${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }
    editor.replaceBlocks([blockId], [{ type: 'pageLink', props: { pageId: page.id } }])
  }, [editor, onCreateChildPage, onError])

  const moveBlocksTo = useCallback(async (blockIds: readonly string[], targetId: string) => {
    const blocks = blockIds.map((id) => editor.getBlock(id)).filter((b) => b !== undefined)
    if (blocks.length === 0) return
    try {
      // 追加到目标页末尾（那一页此刻没打开，直接改它存着的正文）；先写成功再从这里删
      const target = await fetchNotePage(targetId)
      const content = [...target.content, ...blocks.map(withoutIds)]
      await updateNotePage(targetId, { content, contentText: blocksToText(content) })
      editor.removeBlocks(blocks.map((b) => b.id))
    } catch (e) {
      onError(`移动失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [editor, onError])

  // 把正在拖的块丢到侧栏某个页面上：移到那一页（拖到当前页自己身上不算）
  useEffect(() => setBlockDropHandler((targetId) => {
    if (targetId === pageId || readOnly) return
    const slice = editor.prosemirrorView.dragging?.slice
    if (!slice) return
    let ids: string[] = []
    try {
      ids = fragmentToBlocks(slice.content).map((b) => b.id)
    } catch {
      return
    }
    if (ids.length > 0) void moveBlocksTo(ids, targetId)
  }), [editor, pageId, readOnly, moveBlocksTo])

  const actions = useMemo<NoteBlockActions>(() => ({
    duplicate,
    turnIntoPage: (id) => { void turnIntoPage(id) },
    openMoveTo: (blockIds) => {
      const first = blockIds[0]
      const el = first ? document.querySelector(`.nt-editor [data-node-type="blockOuter"][data-id="${first}"]`) : null
      const anchor = el?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2 - 170, window.innerHeight / 3, 0, 0)
      setMoveReq({ blockIds, anchor })
    },
  }), [duplicate, turnIntoPage])

  // Ctrl+D 创建副本（Notion 的快捷键）：有多选复制整片，没有就复制光标所在的块
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'd') return
    e.preventDefault()
    e.stopPropagation()
    const selected = editor.getSelection()?.blocks
    duplicate(selected && selected.length > 0 ? selected.map((b) => b.id) : [editor.getTextCursorPosition().block.id])
  }

  return (
    <NoteBlockActionsContext.Provider value={readOnly ? null : actions}>
      <div onKeyDownCapture={onKeyDownCapture}>
        <BlockNoteView
          editor={editor}
          theme="dark"
          editable={!readOnly}
          slashMenu={false}
          sideMenu={false}
          onChange={onChange}
          className="nt-editor"
        >
          <SideMenuController sideMenu={NoteSideMenu} />
          <SuggestionMenuController triggerCharacter="/" getItems={getSlashItems} />
          <SuggestionMenuController triggerCharacter={CJK_SLASH} getItems={getSlashItems} shouldOpen={isEmptyLine} />
          <SuggestionMenuController triggerCharacter="@" getItems={getMentionItems} />
        </BlockNoteView>
      </div>
      {moveReq && (
        <MoveToPicker
          anchor={moveReq.anchor}
          excludeId={pageId}
          onPick={(target) => { void moveBlocksTo(moveReq.blockIds, target) }}
          onClose={() => setMoveReq(null)}
        />
      )}
    </NoteBlockActionsContext.Provider>
  )
}
