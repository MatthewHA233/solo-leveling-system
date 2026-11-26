// ══════════════════════════════════════════════
// 提示菜单（/ @ #）的滚动闸
//   BlockNote 的提示菜单在整个文档上听 scroll（捕获阶段）：菜单开着的时候，窗口里任何地方滚一下
//   （聊天栏、左栏、菜单自己的候选列表）它都要重新量位置、让菜单重画一遍。界面节点多的时候一次
//   要上百毫秒到一秒，菜单重画又会带出新的滚动，连起来就是整个窗口卡死。
//   这里把它原来那个监听摘掉，换成一个带闸的：只有滚动的是编辑器的祖先（编辑器真的跟着动了）
//   才放行，而且一帧里最多算一次。
// ══════════════════════════════════════════════

import type { EditorView } from '@tiptap/pm/view'

interface ScrollListeningView {
  handleScroll: () => void
  rootEl?: Document | ShadowRoot | null
}

const isScrollListeningView = (v: unknown): v is ScrollListeningView => {
  if (typeof v !== 'object' || v === null) return false
  const o = v as { handleScroll?: unknown; rootEl?: unknown }
  return typeof o.handleScroll === 'function' && o.rootEl != null
}

/** 给这个编辑器的提示菜单装上闸；返回拆掉的函数 */
export function guardSuggestionScroll(view: EditorView): () => void {
  // pluginViews 是 ProseMirror 的内部字段：升级后要是没了，就什么都不做（退回原来的行为）
  const pluginViews = (view as unknown as { pluginViews?: readonly unknown[] }).pluginViews ?? []
  const undo: Array<() => void> = []
  for (const pv of pluginViews) {
    if (!isScrollListeningView(pv)) continue
    const root = pv.rootEl as Document | ShadowRoot
    const original = pv.handleScroll
    let frame: number | null = null
    const guarded = (e: Event) => {
      const target = e.target
      const moved = target === root || target === document
        || (target instanceof Node && target.contains(view.dom))
      if (!moved || frame != null) return
      frame = requestAnimationFrame(() => { frame = null; original() })
    }
    root.removeEventListener('scroll', original, true)
    root.addEventListener('scroll', guarded, true)
    undo.push(() => {
      if (frame != null) cancelAnimationFrame(frame)
      root.removeEventListener('scroll', guarded, true)
    })
  }
  return () => undo.forEach((fn) => fn())
}
