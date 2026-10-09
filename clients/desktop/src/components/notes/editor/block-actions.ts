// 块菜单（⋮⋮）要用到的共享件：编辑器外面提供的动作 + 两个纯函数

import { createContext } from 'react'

/** 编辑器外面（NoteEditor）提供的、要碰页面 / 网络的动作 */
export interface NoteBlockActions {
  readonly duplicate: (blockIds: readonly string[]) => void
  readonly turnIntoPage: (blockId: string) => void
  readonly openMoveTo: (blockIds: readonly string[]) => void
}

export const NoteBlockActionsContext = createContext<NoteBlockActions | null>(null)

/** 行内内容 → 纯文本（转代码块、转页面标题用：代码块里不能带粗体 / 链接这类样式） */
export function inlineToPlainText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((it: unknown) => {
    if (typeof it === 'string') return it
    if (typeof it !== 'object' || it === null) return ''
    const o = it as { type?: string; text?: string; content?: unknown }
    if (o.type === 'text') return o.text ?? ''
    if (o.type === 'link') return inlineToPlainText(o.content)
    return ''
  }).join('')
}

/** 去掉块（连同子块）的 id：复制出来的块要让编辑器重新发 id，不然一篇里会有两个同 id 的块 */
export function withoutIds(block: unknown): unknown {
  if (typeof block !== 'object' || block === null) return block
  const { id: _id, children, ...rest } = block as { id?: unknown; children?: unknown }
  void _id
  return { ...rest, children: Array.isArray(children) ? children.map(withoutIds) : [] }
}
