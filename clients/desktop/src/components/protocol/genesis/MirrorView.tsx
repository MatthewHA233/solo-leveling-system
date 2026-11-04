// ══════════════════════════════════════════════
// 协议志 · 开局 ① 责任之镜：把「最近最不如意的事」照出来
//   每条不如意 = 一张便利贴，贴在镜子上；贴上写的是 AI 誊短的一句，带蜡笔手记（涂抹 / 划线 / 圈）
//   悬停（或键盘聚焦）一张，掀起来看原话；改清单就在这里改，不退回别的步骤
// ══════════════════════════════════════════════

import { useState, type CSSProperties } from 'react'
import { Chapter, ListInput, System } from './genesis-parts'
import { InkText, Origin } from './InkText'
import { MAX_ITEMS, noteText, type GenesisDoc, type InkNote } from './genesis-model'
import { PAPERS, hash, jitter } from './notebook-ink'
import './mirror.css'

function Note({ index, source, note }: { readonly index: number; readonly source: string; readonly note: InkNote | null }) {
  const seed = hash(source)
  const style = {
    '--rot': `${jitter(seed, 3).toFixed(1)}deg`,
    '--dy': `${Math.round(jitter(seed, 7, 8))}px`,
    '--paper': PAPERS[index % PAPERS.length],
  } as CSSProperties
  return (
    <div className="mr-note nb-paper" style={style} tabIndex={0} role="note" aria-label={`第 ${index + 1} 条：${note ? noteText(note) : source}。原话：${source}`}>
      <span className="mr-no" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
      {note
        ? <InkText note={note} className="mr-short" />
        // 还没誊好：先把原话贴上去
        : <p className="mr-short mr-raw nb-hand">{source}</p>}
      <Origin source={source} />
    </div>
  )
}

/** 镜子本体：便利贴按清单顺序贴，镜面最下方是系统的一句话 */
export function Mirror({ items, notes, condensing }: {
  readonly items: readonly string[]
  readonly notes: readonly InkNote[]
  readonly condensing: boolean
}) {
  return (
    <div className="mr-mirror nb-frame">
      <div className="mr-glass nb-window" aria-hidden />
      <div className="mr-board">
        {items.map((source, i) => (
          <Note key={`${i}:${source}`} index={i} source={source} note={notes.find((n) => n.source === source) ?? null} />
        ))}
      </div>
      <div className="nb-frame-caption">
        {condensing ? <span className="gn-busy">系统正在把它们誊到便利贴上……</span> : '它们不是判决，是起点的坐标'}
      </div>
    </div>
  )
}

export default function MirrorView({ doc, now, condensing, onSubmit, onRecondense }: {
  readonly doc: GenesisDoc
  readonly now: boolean
  readonly condensing: boolean
  readonly onSubmit: (items: string[]) => void
  /** 整面镜子重誊一遍 */
  readonly onRecondense: () => void
}) {
  const [editing, setEditing] = useState(false)
  const writing = editing || doc.stage === 'frustrations' || doc.frustrations.length === 0

  return (
    <Chapter
      n={1}
      title="责任之镜"
      sub="最近最不如意的事"
      now={now}
      actions={!writing && (
        <>
          <button type="button" className="gn-head-btn" disabled={condensing} onClick={onRecondense}>重新誊写</button>
          <button type="button" className="gn-head-btn" onClick={() => setEditing(true)}>改</button>
        </>
      )}
    >
      {writing ? (
        <>
          <System>
            在开始之前，我需要先看清你现在站在哪里。<br />
            写下最近最不如意的事：那些让你在深夜里觉得「我怎么又这样了」的时刻。不用修饰，也不用替自己辩解。一条一行，1~{MAX_ITEMS} 条。
          </System>
          <ListInput
            initial={doc.frustrations}
            placeholder={'比如：又一次刷视频刷到凌晨三点，第二天什么都没做成。'}
            submit={editing ? '贴回镜子上' : '写好了'}
            onSubmit={(items) => {
              onSubmit(items)
              setEditing(false)
            }}
            onCancel={editing ? () => setEditing(false) : undefined}
          />
        </>
      ) : (
        <Mirror items={doc.frustrations} notes={doc.notes} condensing={condensing} />
      )}
    </Chapter>
  )
}
