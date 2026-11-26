// ══════════════════════════════════════════════
// 笔记编辑器的块定义：BlockNote 自带的全部块 + 三个 Notion 式的自定义件（界面在 note-blocks.tsx）
//   · callout     提示框：图标 + 色调 + 一段行内文字
//   · pageLink    子页面链接块：显示目标页的图标和标题，点了跳过去
//   · pageMention 行内 @页面
//   锚点和批注（后端 src-tauri/src/notes_index.rs 按这些名字从正文里抽数据，改名要两边一起改）：
//   · anchorSentence 锚点句块（锚点页里的一条句子，category = 动机 / 观点 / 实践）
//   · anchorRef      行内 #锚点（sentenceId 非空 = 点到了其中某一句）
//   · thought / thoughtHl 两个文字样式：批注的话 / 涂上的原文（见 thought-marks.ts）
//   · transcriptLine 语境页里的一句转录（start = 这句从第几秒开始）
//   代码块换成带语法高亮的版本，默认语言 = 纯文本。
// ══════════════════════════════════════════════

import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs } from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react'
import { asSentenceCategory, CALLOUT_TONES, SENTENCE_CATEGORIES } from '../note-visuals'
import { AnchorRefChip, AnchorSentenceView, TranscriptLineView } from './anchor-blocks'
import { columnBlockSpec, columnListBlockSpec } from './columns'
import { CalloutView, MentionChip, PageLinkView } from './note-blocks'
import { thoughtHlStyleSpec, thoughtStyleSpec } from './thought-marks'

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

const createAnchorSentenceBlock = createReactBlockSpec(
  {
    type: 'anchorSentence',
    propSchema: { category: { default: '', values: SENTENCE_CATEGORIES } },
    content: 'inline',
  },
  {
    render: ({ block, editor, contentRef }) => (
      <AnchorSentenceView
        blockId={block.id}
        category={asSentenceCategory(block.props.category)}
        editable={editor.isEditable}
        contentRef={contentRef}
        onCategory={(category) => editor.updateBlock(block, { props: { category } })}
      />
    ),
  },
)

const createTranscriptLineBlock = createReactBlockSpec(
  {
    type: 'transcriptLine',
    // 没有时间戳的行是 -1
    propSchema: { start: { default: -1 } },
    content: 'inline',
  },
  {
    render: ({ block, contentRef }) => <TranscriptLineView start={block.props.start} contentRef={contentRef} />,
  },
)

const anchorRef = createReactInlineContentSpec(
  {
    type: 'anchorRef',
    propSchema: { anchorId: { default: '' }, sentenceId: { default: '' } },
    content: 'none',
  },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <AnchorRefChip
        anchorId={inlineContent.props.anchorId}
        sentenceId={inlineContent.props.sentenceId}
        editable={editor.isEditable}
        onPickSentence={(sentenceId) => updateInlineContent({
          type: 'anchorRef',
          props: { anchorId: inlineContent.props.anchorId, sentenceId },
        })}
      />
    ),
  },
)

export const noteSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(NOTE_CODE_OPTIONS),
    callout: createCalloutBlock(),
    pageLink: createPageLinkBlock(),
    anchorSentence: createAnchorSentenceBlock(),
    transcriptLine: createTranscriptLineBlock(),
    // 分栏：自己写的（见 columns.ts）
    columnList: columnListBlockSpec,
    column: columnBlockSpec,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    pageMention,
    anchorRef,
  },
  styleSpecs: {
    ...defaultStyleSpecs,
    thought: thoughtStyleSpec,
    thoughtHl: thoughtHlStyleSpec,
  },
})

export type NoteEditorInstance = typeof noteSchema.BlockNoteEditor
export type NotePartialBlock = typeof noteSchema.PartialBlock
