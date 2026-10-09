// ══════════════════════════════════════════════
// 笔记编辑器的块定义：BlockNote 自带的全部块 + 三个 Notion 式的自定义件（界面在 note-blocks.tsx）
//   · callout     提示框：图标 + 色调 + 一段行内文字
//   · pageLink    子页面链接块：显示目标页的图标和标题，点了跳过去
//   · pageMention 行内 @页面
//   代码块换成带语法高亮的版本，默认语言 = 纯文本。
// ══════════════════════════════════════════════

import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react'
import { CALLOUT_TONES } from '../note-visuals'
import { columnBlockSpec, columnListBlockSpec } from './columns'
import { CalloutView, MentionChip, PageLinkView } from './note-blocks'

// 「``` + 空格」建代码块时语言是空串：BlockNote 在支持列表里找不到就直接抛错，整个转换作废（Notion 用户最常用的就是这个手势）。
// 给纯文本挂一个空串别名，空语言就落到纯文本
const NOTE_CODE_OPTIONS = {
  ...codeBlockOptions,
  defaultLanguage: 'text',
  supportedLanguages: {
    ...codeBlockOptions.supportedLanguages,
    text: {
      ...codeBlockOptions.supportedLanguages.text,
      name: '纯文本',
      aliases: [...(codeBlockOptions.supportedLanguages.text.aliases ?? []), ''],
    },
  },
}

const createCalloutBlock = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: {
      emoji: { default: '💡' },
      tone: { default: 'amber', values: CALLOUT_TONES },
    },
    content: 'inline',
  },
  {
    render: ({ block, editor, contentRef }) => (
      <CalloutView
        emoji={block.props.emoji}
        tone={block.props.tone}
        editable={editor.isEditable}
        contentRef={contentRef}
        onChange={(props) => editor.updateBlock(block, { props })}
      />
    ),
  },
)

const createPageLinkBlock = createReactBlockSpec(
  {
    type: 'pageLink',
    propSchema: { pageId: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block }) => <PageLinkView pageId={block.props.pageId} />,
  },
)

const pageMention = createReactInlineContentSpec(
  {
    type: 'pageMention',
    propSchema: { pageId: { default: '' } },
    content: 'none',
  },
  {
    render: ({ inlineContent }) => <MentionChip pageId={inlineContent.props.pageId} />,
  },
)

export const noteSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(NOTE_CODE_OPTIONS),
    callout: createCalloutBlock(),
    pageLink: createPageLinkBlock(),
    // 分栏：自己写的（见 columns.ts）
    columnList: columnListBlockSpec,
    column: columnBlockSpec,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    pageMention,
  },
})

export type NoteEditorInstance = typeof noteSchema.BlockNoteEditor
export type NotePartialBlock = typeof noteSchema.PartialBlock
