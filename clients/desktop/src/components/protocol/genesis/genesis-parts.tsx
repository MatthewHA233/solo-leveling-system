// 协议志 · 开局的小件：每一章的章名、系统说的话、写清单的输入框

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MAX_ITEMS, toItems } from './genesis-model'
// 梦想记事本的手写字体和共用手感：先于各章自己的样式表载入，各章才能覆盖它
import 'lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css'
import './notebook.css'

/** 一章：编号 + 手写章名 + 一行小字，右边是这一章的按钮；正在做的这一章自动滚进视野 */
export function Chapter({ n, title, sub, now = false, actions, children }: {
  readonly n: number
  readonly title: string
  readonly sub: string
  readonly now?: boolean
  readonly actions?: ReactNode
  readonly children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    // 只滚开局自己的滚动区（scrollIntoView 会连外层面板一起推）
    const el = ref.current
    const scroller = el?.closest('.pl-main')
    if (!now || !el || !scroller) return
    const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [now])
  return (
    <section ref={ref} className="gn-step">
      <header className="gn-step-head">
        <span className="gn-step-no">{String(n).padStart(2, '0')}</span>
        <span className="gn-step-title">{title}</span>
        <span className="gn-step-sub">{sub}</span>
        {actions && <span className="gn-step-actions">{actions}</span>}
      </header>
      {children}
    </section>
  )
}

/** 系统说的话：冰蓝、一段一段 */
export function System({ children }: { readonly children: ReactNode }) {
  return <div className="gn-system"><span className="gn-sys-mark" aria-hidden />{children}</div>
}

export function ListInput({ initial, placeholder, submit, onSubmit, onCancel }: {
  readonly initial: readonly string[]
  readonly placeholder: string
  readonly submit: string
  readonly onSubmit: (items: string[]) => void
  /** 就地改的时候才有：不改了，原样放回去 */
  readonly onCancel?: () => void
}) {
  const [text, setText] = useState(() => initial.join('\n'))
  const items = toItems(text)
  const ok = items.length >= 1 && items.length <= MAX_ITEMS
  return (
    <div className="gn-input">
      <textarea className="pl-textarea" rows={7} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
      <div className="gn-input-foot">
        <span className="gn-count" data-over={items.length > MAX_ITEMS ? '1' : undefined}>{items.length} / {MAX_ITEMS}</span>
        <span className="gn-actions">
          {onCancel && <button type="button" className="pl-chip-btn" onClick={onCancel}>不改了</button>}
          <button type="button" className="ti-key gn-go" disabled={!ok} onClick={() => onSubmit(items)}>{submit}</button>
        </span>
      </div>
    </div>
  )
}
