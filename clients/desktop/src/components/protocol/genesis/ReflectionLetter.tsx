// ══════════════════════════════════════════════
// 协议志 · 开局 ③ 照见：系统照一遍
//   系统的回应写成一封信：横格纸、钢笔蓝；「- 」开头的每条落差前画一个坐标十字；最后那句压在信尾
// ══════════════════════════════════════════════

import type { ReactNode } from 'react'
import { Play } from 'lucide-react'
import { Chapter, System } from './genesis-parts'
import './reflection.css'

type Block = { readonly kind: 'para' | 'coord' | 'gap' | 'coda'; readonly text: string }

/** 信的段落：空行是一行空白，「- 」是坐标，最后一段是信尾 */
function toBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const last = lines.reduce((at, l, i) => (l !== '' && !l.startsWith('-') ? i : at), -1)
  return lines
    .map((l, i): Block => {
      if (l === '') return { kind: 'gap', text: '' }
      if (/^[-*•·]\s*/.test(l)) return { kind: 'coord', text: l.replace(/^[-*•·]\s*/, '') }
      return { kind: i === last && i > 0 ? 'coda' : 'para', text: l }
    })
    // 连着的空行只留一行
    .filter((b, i, all) => b.kind !== 'gap' || (i > 0 && all[i - 1].kind !== 'gap'))
}

export function Letter({ text }: { readonly text: string }) {
  return (
    <div className="rf-letter">
      <span className="nb-tape rf-tape" aria-hidden />
      <div className="rf-paper nb-hand">
        {toBlocks(text).map((b, i) => (b.kind === 'gap' ? <div key={i} className="rf-gap" /> : <p key={i} className={`rf-${b.kind}`}>{b.text}</p>))}
      </div>
    </div>
  )
}

export default function ReflectionLetter({ reflection, now, busy, locked, filmAvailable, onReflect, onOpenFilm, next }: {
  readonly reflection: string | null
  readonly now: boolean
  readonly busy: boolean
  /** 别的章的 AI 正在跑：这一章的 AI 按钮先按不了 */
  readonly locked: boolean
  readonly filmAvailable: boolean
  readonly onReflect: () => void
  readonly onOpenFilm: () => void
  /** 这一章是当前步骤时，信下面的「继续」 */
  readonly next?: ReactNode
}) {
  return (
    <Chapter
      n={3}
      title="照见"
      sub="系统照一遍：只陈述，不评判"
      now={now}
      actions={(
        <>
          {filmAvailable && <button type="button" className="gn-head-btn" onClick={onOpenFilm}><Play size={11} />觉醒片</button>}
          {reflection && !busy && <button type="button" className="gn-head-btn" disabled={locked} onClick={onReflect}>重新照一次</button>}
        </>
      )}
    >
      {busy && <System><span className="gn-busy">系统正在看你写下的东西……</span></System>}
      {reflection && !busy && <Letter text={reflection} />}
      {!reflection && !busy && <div className="gn-actions"><button type="button" className="ti-key gn-go" disabled={locked} onClick={onReflect}>让系统照一遍</button></div>}
      {reflection && !busy && next}
    </Chapter>
  )
}
