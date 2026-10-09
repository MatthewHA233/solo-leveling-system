// 笔记编辑器自定义块的界面（schema 在 note-schema.tsx）：提示框 / 子页面链接 / 行内 @页面

import { useState } from 'react'
import { ArrowUpRight, FileText, FileX } from 'lucide-react'
import EmojiPicker from '../EmojiPicker'
import { pageTitle } from '../note-model'
import { openNotePage, useNotePagesMap } from '../notes-store'
import { CALLOUT_TONES, CALLOUT_TONE_COLOR, CALLOUT_TONE_LABEL, type CalloutTone } from '../note-visuals'

export function CalloutView({ emoji, tone, editable, contentRef, onChange }: {
  readonly emoji: string
  readonly tone: CalloutTone
  readonly editable: boolean
  readonly contentRef: (node: HTMLElement | null) => void
  readonly onChange: (props: { emoji?: string; tone?: CalloutTone }) => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <div className="nt-callout" data-tone={tone} style={{ ['--tone' as string]: CALLOUT_TONE_COLOR[tone] }}>
      <button
        type="button"
        className="nt-callout-icon"
        contentEditable={false}
        disabled={!editable}
        onClick={(e) => { const el = e.currentTarget; setAnchor((cur) => (cur ? null : el)) }}
        aria-label="换图标 / 色调"
      >
        {emoji}
      </button>
      <div className="nt-callout-body" ref={contentRef} />
      {anchor && (
        <EmojiPicker
          anchor={anchor}
          onClose={() => setAnchor(null)}
          onPick={(e) => onChange({ emoji: e })}
          footer={(
            <div className="nt-tone-row">
              <span className="nt-float-title">色调</span>
              {CALLOUT_TONES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="nt-tone-key"
                  data-active={t === tone ? '1' : undefined}
                  style={{ ['--tone' as string]: CALLOUT_TONE_COLOR[t] }}
                  onClick={() => onChange({ tone: t })}
                >
                  <span className="nt-tone-dot" />{CALLOUT_TONE_LABEL[t]}
                </button>
              ))}
            </div>
          )}
        />
      )}
    </div>
  )
}

export function PageLinkView({ pageId }: { readonly pageId: string }) {
  const meta = useNotePagesMap().get(pageId)
  if (!meta) {
    return (
      <div className="nt-pagelink" data-missing="1" contentEditable={false}>
        <span className="nt-pagelink-icon"><FileX size={16} /></span>
        <span className="nt-pagelink-title">页面已不在（可能在回收站里）</span>
      </div>
    )
  }
  return (
    <div
      className="nt-pagelink"
      contentEditable={false}
      role="link"
      tabIndex={0}
      onClick={() => openNotePage(pageId)}
      onKeyDown={(e) => { if (e.key === 'Enter') openNotePage(pageId) }}
    >
      <span className="nt-pagelink-icon">{meta.icon ?? <FileText size={16} />}</span>
      <span className="nt-pagelink-title">{pageTitle(meta)}</span>
      <ArrowUpRight size={13} className="nt-pagelink-arrow" />
    </div>
  )
}

export function MentionChip({ pageId }: { readonly pageId: string }) {
  const meta = useNotePagesMap().get(pageId)
  return (
    <span
      className="nt-mention"
      data-missing={meta ? undefined : '1'}
      onClick={() => { if (meta) openNotePage(pageId) }}
    >
      <span className="nt-mention-icon">{meta?.icon ?? '📄'}</span>
      {meta ? pageTitle(meta) : '已删除的页面'}
    </span>
  )
}
