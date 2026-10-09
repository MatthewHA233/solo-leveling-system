// 页面图标 / 提示框图标的选择浮层：分组 emoji 网格 + 随机 + 移除（可选再带一排色调键）

import type { ReactNode } from 'react'
import { Dices, X } from 'lucide-react'
import Floating, { type FloatingAnchor } from './Floating'
import { EMOJI_GROUPS, randomEmoji } from './note-visuals'

export default function EmojiPicker({ anchor, onPick, onRemove, onClose, footer }: {
  readonly anchor: FloatingAnchor
  readonly onPick: (emoji: string) => void
  readonly onRemove?: () => void
  readonly onClose: () => void
  /** 额外的一排设置（提示框的色调） */
  readonly footer?: ReactNode
}) {
  const pick = (emoji: string) => {
    onPick(emoji)
    onClose()
  }
  return (
    <Floating anchor={anchor} onClose={onClose} width={332} className="nt-emoji">
      <div className="nt-emoji-head">
        <span className="nt-float-title">选择图标</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ti-key nt-mini-key" onClick={() => pick(randomEmoji())}>
          <Dices size={12} />随机
        </button>
        {onRemove && (
          <button type="button" className="ti-key nt-mini-key" onClick={() => { onRemove(); onClose() }}>
            <X size={12} />移除
          </button>
        )}
      </div>
      <div className="nt-emoji-scroll">
        {EMOJI_GROUPS.map((g) => (
          <div key={g.label}>
            <div className="nt-emoji-group">{g.label}</div>
            <div className="nt-emoji-grid">
              {g.items.map((e) => (
                <button key={e} type="button" className="nt-emoji-cell" onClick={() => pick(e)}>{e}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {footer && <div className="nt-emoji-foot">{footer}</div>}
    </Floating>
  )
}
