// ══════════════════════════════════════════════
// 协议志 · 开局 ② 悬着的愿：一直想做、却没做成的事
//   每条愿望 = 一张竖写的七夕短笺，系在竹枝上，还悬着；短笺上是 AI 誊短的一句 + 蜡笔手记
//   悬停（或键盘聚焦）一张，看原话；改清单就在这里改，不退回、也不重照
// ══════════════════════════════════════════════

import { useState, type CSSProperties } from 'react'
import { Chapter, ListInput, System } from './genesis-parts'
import { InkText, Origin } from './InkText'
import { MAX_ITEMS, noteText, type GenesisDoc, type InkNote } from './genesis-model'
import { STRIP_PAPERS, hash, jitter } from './notebook-ink'
import './wishes.css'

/** 一根竹枝最多挂几张，多了另起一根 */
const PER_BRANCH = 6
/** 还没誊好时，短笺上先露原话的开头 */
const PREVIEW_CHARS = 12

function Strip({ index, source, note }: { readonly index: number; readonly source: string; readonly note: InkNote | null }) {
  const seed = hash(source)
  const style = {
    '--rot': `${jitter(seed, 2.4).toFixed(1)}deg`,
    '--hang': `${16 + Math.round(Math.abs(jitter(seed, 18, 9)))}px`,
    '--paper': STRIP_PAPERS[index % STRIP_PAPERS.length],
  } as CSSProperties
  return (
    <div className="ws-strip nb-paper" style={style} tabIndex={0} role="note" aria-label={`第 ${index + 1} 个愿望：${note ? noteText(note) : source}。原话：${source}`}>
      <span className="ws-hole" aria-hidden />
      {note
        ? <InkText note={note} vertical className="ws-text nb-vertical" />
        : <p className="ws-text ws-raw nb-hand">{source.length > PREVIEW_CHARS ? `${source.slice(0, PREVIEW_CHARS)}……` : source}</p>}
      <Origin source={source} />
    </div>
  )
}

/** 夜空 + 竹枝：短笺按清单顺序挂，一根枝挂满了另起一根 */
export function WishBranches({ items, notes, condensing }: {
  readonly items: readonly string[]
  readonly notes: readonly InkNote[]
  readonly condensing: boolean
}) {
  const branches = Array.from({ length: Math.ceil(items.length / PER_BRANCH) }, (_, b) => items.slice(b * PER_BRANCH, (b + 1) * PER_BRANCH))
  return (
    <div className="ws-sky nb-frame">
      <div className="ws-night nb-window" aria-hidden />
      {branches.map((row, b) => (
        <div key={b} className="ws-branch">
          <span className="ws-pole" aria-hidden />
          {row.map((source, i) => (
            <Strip key={`${i}:${source}`} index={b * PER_BRANCH + i} source={source} note={notes.find((n) => n.source === source) ?? null} />
          ))}
        </div>
      ))}
      <div className="nb-frame-caption">
        {condensing ? <span className="gn-busy">系统正在把它们誊到短笺上……</span> : '还悬着的，都是真的想要的'}
      </div>
    </div>
  )
}

export default function WishStrips({ doc, now, condensing, onSubmit, onRecondense }: {
  readonly doc: GenesisDoc
  readonly now: boolean
  readonly condensing: boolean
  readonly onSubmit: (items: string[]) => void
  readonly onRecondense: () => void
}) {
  const [editing, setEditing] = useState(false)
  const writing = editing || doc.stage === 'wishes' || doc.wishes.length === 0

  return (
    <Chapter
      n={2}
      title="悬着的愿"
      sub="一直想做、却没做成的事"
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
            现在第二个问题。写下一直想做、却一直没做成的事：心里清楚想要、试过或者没敢试、到现在还悬在那里的事。不用管现在看起来可不可能，也不用管别人会不会笑。一条一行，1~{MAX_ITEMS} 条。
          </System>
          <ListInput
            initial={doc.wishes}
            placeholder={'比如：想做出一个真的有人用、能养活自己的产品。'}
            submit={editing ? '挂回竹枝上' : '写好了，照我一遍'}
            onSubmit={(items) => {
              onSubmit(items)
              setEditing(false)
            }}
            onCancel={editing ? () => setEditing(false) : undefined}
          />
        </>
      ) : (
        <WishBranches items={doc.wishes} notes={doc.wishNotes} condensing={condensing} />
      )}
    </Chapter>
  )
}
