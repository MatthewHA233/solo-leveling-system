// 梦想记事本上 AI 誊好的一段手写字：按 AI 排好的行（竖写就是列）一行一块，带蜡笔手记；
// 悬停（或键盘聚焦）那张纸时掀起来看原话

import { Fragment, type ReactNode } from 'react'
import { markLines, type InkNote } from './genesis-model'

/** 竖写时一两位的数字立起来（34、25），长数字照常横躺 */
function upright(text: string): ReactNode {
  return text.split(/(\d+)/).map((part, i) =>
    /^\d{1,2}$/.test(part) ? <span key={i} className="nb-tcy">{part}</span> : <Fragment key={i}>{part}</Fragment>,
  )
}

export function InkText({ note, vertical = false, className }: {
  readonly note: InkNote
  readonly vertical?: boolean
  readonly className?: string
}) {
  return (
    <p className={`nb-ink${className ? ` ${className}` : ''}`}>
      {markLines(note.lines, note.marks).map((line, li) => (
        <span key={li} className="nb-line">
          {line.map((s, i) => {
            const body = vertical ? upright(s.text) : s.text
            return s.kind ? <span key={i} className={`nb-mark nb-${s.kind}`}>{body}</span> : <Fragment key={i}>{body}</Fragment>
          })}
        </span>
      ))}
    </p>
  )
}

/** 盖在纸上的原话：平时藏着，悬停 / 聚焦那张纸时浮出来 */
export function Origin({ source }: { readonly source: string }) {
  return (
    <div className="nb-origin" aria-hidden>
      <span className="nb-origin-label">原话</span>
      {source}
    </div>
  )
}
