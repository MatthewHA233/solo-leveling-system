// 锚点相关的块和行内件的界面（schema 在 note-schema.tsx）：
//   · 锚点句块：锚点页里的一条句子，带三类之一、能看以前的各版
//   · # 引用：行内的 #词，指向一个锚点，可以再点到其中某一句
//   · 转录行：语境页里的一句转录，前面带时间，点了跳播

import { useEffect, useState } from 'react'
import { ArrowUpRight, History } from 'lucide-react'
import {
  fetchAnchorSentences, fetchSentenceVersions,
  type AnchorSentence, type SentenceVersion,
} from '../../../lib/notes-api'
import Floating from '../Floating'
import { formatNoteTime, pageTitle } from '../note-model'
import { NOTES_TRANSCRIPT_SEEK_EVENT, openNotePage, useAnchorSentenceInfo, useNotePagesMap } from '../notes-store'
import { SENTENCE_CATEGORIES, SENTENCE_CATEGORY_COLOR, SENTENCE_CATEGORY_LABEL, type SentenceCategory } from '../note-visuals'
import PopMenu from '../PopMenu'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ── 锚点句块 ──

export function AnchorSentenceView({ blockId, category, editable, contentRef, onCategory }: {
  readonly blockId: string
  readonly category: SentenceCategory
  readonly editable: boolean
  readonly contentRef: (node: HTMLElement | null) => void
  readonly onCategory: (category: SentenceCategory) => void
}) {
  const { pageId, info } = useAnchorSentenceInfo(blockId)
  const [catAnchor, setCatAnchor] = useState<HTMLElement | null>(null)
  const [verAnchor, setVerAnchor] = useState<HTMLElement | null>(null)
  const version = info?.version ?? 0
  return (
    <div className="nt-sentence" style={{ ['--cat' as string]: SENTENCE_CATEGORY_COLOR[category] }}>
      <button
        type="button"
        className="nt-sentence-cat"
        contentEditable={false}
        disabled={!editable}
        onClick={(e) => { const el = e.currentTarget; setCatAnchor((cur) => (cur ? null : el)) }}
        aria-label="这一句属于哪一类"
      >
        <span className="nt-sentence-dot" />
        {SENTENCE_CATEGORY_LABEL[category]}
      </button>
      <div className="nt-sentence-body" ref={contentRef} />
      {version > 0 && (
        <button
          type="button"
          className="nt-sentence-ver"
          contentEditable={false}
          onClick={(e) => { const el = e.currentTarget; setVerAnchor((cur) => (cur ? null : el)) }}
          aria-label="看这一句以前的各版"
        >
          <History size={11} />第 {version} 版{info && info.refs > 0 ? ` · ${info.refs} 处引用` : ''}
        </button>
      )}
      {catAnchor && (
        <PopMenu
          anchor={catAnchor}
          onClose={() => setCatAnchor(null)}
          items={SENTENCE_CATEGORIES.map((c) => ({
            key: c || 'none',
            label: SENTENCE_CATEGORY_LABEL[c],
            checked: c === category,
            onSelect: () => onCategory(c),
          }))}
        />
      )}
      {verAnchor && pageId && (
        <SentenceVersions pageId={pageId} blockId={blockId} anchor={verAnchor} onClose={() => setVerAnchor(null)} />
      )}
    </div>
  )
}

function SentenceVersions({ pageId, blockId, anchor, onClose }: {
  readonly pageId: string
  readonly blockId: string
  readonly anchor: HTMLElement
  readonly onClose: () => void
}) {
  const [versions, setVersions] = useState<readonly SentenceVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    fetchSentenceVersions(pageId, blockId)
      .then((v) => { if (alive) setVersions(v) })
      .catch((e: unknown) => { if (alive) setError(errorText(e)) })
    return () => { alive = false }
  }, [pageId, blockId])
  return (
    <Floating anchor={anchor} onClose={onClose} placement="bottom-end" width={380} className="nt-versions">
      <div className="nt-float-title">这一句的各版</div>
      {error && <div className="nt-float-error">{error}</div>}
      {!versions && !error && <div className="nt-float-hint">正在读取…</div>}
      {versions?.map((v, i) => (
        <div key={v.version} className="nt-version" data-current={i === 0 ? '1' : undefined}>
          <div className="nt-version-head">
            <span className="nt-version-no">第 {v.version} 版{i === 0 ? '（现在）' : ''}</span>
            <span className="nt-version-time">{formatNoteTime(v.updatedAt)}</span>
          </div>
          <div className="nt-version-text">{v.text}</div>
        </div>
      ))}
      <div className="nt-float-hint">隔十分钟以上再改，才算新的一版。</div>
    </Floating>
  )
}

// ── # 引用 ──

export function AnchorRefChip({ anchorId, sentenceId, editable, onPickSentence }: {
  readonly anchorId: string
  readonly sentenceId: string
  readonly editable: boolean
  readonly onPickSentence: (sentenceId: string) => void
}) {
  const meta = useNotePagesMap().get(anchorId)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  if (!meta) {
    return <span className="nt-anchor-ref" data-missing="1">#已删除的锚点</span>
  }
  return (
    <>
      <span
        className="nt-anchor-ref"
        data-pinned={sentenceId ? '1' : undefined}
        onClick={(e) => {
          // 只读（回收站里的页）时没什么可改的，直接跳过去
          if (!editable) { openNotePage(anchorId, sentenceId || undefined); return }
          const el = e.currentTarget
          setMenuAnchor((cur) => (cur ? null : el))
        }}
      >
        #{pageTitle(meta)}
      </span>
      {menuAnchor && (
        <AnchorRefMenu
          anchorId={anchorId}
          title={pageTitle(meta)}
          sentenceId={sentenceId}
          anchor={menuAnchor}
          onPick={(id) => { onPickSentence(id); setMenuAnchor(null) }}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </>
  )
}

function AnchorRefMenu({ anchorId, title, sentenceId, anchor, onPick, onClose }: {
  readonly anchorId: string
  readonly title: string
  readonly sentenceId: string
  readonly anchor: HTMLElement
  readonly onPick: (sentenceId: string) => void
  readonly onClose: () => void
}) {
  const [sentences, setSentences] = useState<readonly AnchorSentence[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    fetchAnchorSentences(anchorId)
      .then((s) => { if (alive) setSentences(s.filter((x) => x.text.trim())) })
      .catch((e: unknown) => { if (alive) setError(errorText(e)) })
    return () => { alive = false }
  }, [anchorId])
  return (
    <Floating anchor={anchor} onClose={onClose} width={360} className="nt-refmenu">
      <div className="nt-refmenu-head">
        <span className="nt-float-title">#{title}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ti-key nt-mini-key" onClick={() => { openNotePage(anchorId, sentenceId || undefined); onClose() }}>
          <ArrowUpRight size={12} />打开锚点
        </button>
      </div>
      <button type="button" className="nt-refmenu-item" data-active={sentenceId ? undefined : '1'} onClick={() => onPick('')}>
        <span className="nt-refmenu-mark" />整个锚点
      </button>
      {error && <div className="nt-float-error">{error}</div>}
      {!sentences && !error && <div className="nt-float-hint">正在读取锚点句…</div>}
      {sentences?.length === 0 && <div className="nt-float-hint">这个锚点里还没有写锚点句。</div>}
      {sentences?.map((s) => (
        <button
          key={s.blockId}
          type="button"
          className="nt-refmenu-item"
          data-active={s.blockId === sentenceId ? '1' : undefined}
          onClick={() => onPick(s.blockId)}
        >
          <span className="nt-refmenu-mark" />
          <span className="nt-refmenu-text">{s.text}</span>
        </button>
      ))}
      {sentences && sentences.length > 0 && <div className="nt-float-hint">点一句 = 这处引用说的就是这一句。</div>}
    </Floating>
  )
}

// ── 转录行（语境页）──

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h > 0 ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

export function TranscriptLineView({ start, contentRef }: {
  readonly start: number
  readonly contentRef: (node: HTMLElement | null) => void
}) {
  return (
    <div className="nt-transcript">
      {start >= 0 && (
        <button
          type="button"
          className="nt-transcript-time"
          contentEditable={false}
          onClick={() => window.dispatchEvent(new CustomEvent(NOTES_TRANSCRIPT_SEEK_EVENT, { detail: { sec: start } }))}
          aria-label="从这里播放"
        >
          {formatClock(start)}
        </button>
      )}
      <div className="nt-transcript-body" ref={contentRef} />
    </div>
  )
}
