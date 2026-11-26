// ══════════════════════════════════════════════
// 聊天栏只画最近的一段消息，往上滚到头再接更早的
//   一个会话可以有上千条消息，全画出来是几万个节点，整个窗口的每次重排都跟着变慢。
//   · 默认画最后 TAIL 条；滚到离顶不到 NEAR_TOP 像素就再接 STEP 条，接的时候保持眼前的内容不动
//   · 换会话回到最后 TAIL 条
//   · 要跳到某一条（历史搜索命中、压缩分界）：先调 revealChatMessage(时间戳)，这里把它接进来，
//     调用方照旧用 [data-msg-ts] 去找那个元素
// ══════════════════════════════════════════════

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const TAIL = 60
const STEP = 40
const NEAR_TOP = 600
/** 跳转目标上面多带几条，别让它贴着顶 */
const REVEAL_MARGIN = 6

const REVEAL_EVENT = 'solevup:chat-reveal'

/** 让聊天栏把这个时间戳的消息画出来（它可能在还没接进来的更早那一段里） */
export function revealChatMessage(timestamp: string): void {
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: timestamp }))
}

interface WindowedMessage {
  readonly id: string
  readonly timestamp: string
}

export function useChatWindow<T extends WindowedMessage>(
  messages: readonly T[],
  scrollRef: RefObject<HTMLDivElement | null>,
): { visible: readonly T[]; hiddenCount: number; onScroll: () => void } {
  const [count, setCount] = useState(TAIL)
  const [revealTs, setRevealTs] = useState<string | null>(null)

  // 换会话：回到只画最后一段
  const firstId = messages[0]?.id
  const [seenFirstId, setSeenFirstId] = useState(firstId)
  const [seenLength, setSeenLength] = useState(messages.length)
  if (firstId !== seenFirstId) {
    setSeenFirstId(firstId)
    setSeenLength(messages.length)
    setCount(TAIL)
  } else if (messages.length !== seenLength) {
    // 已经往上接过更早的消息（你正在翻旧的）：来了新消息也不把最上面那几条收走
    if (messages.length > seenLength && count > TAIL) setCount(count + messages.length - seenLength)
    setSeenLength(messages.length)
  }

  useEffect(() => {
    const onReveal = (e: Event) => {
      const ts = (e as CustomEvent<string>).detail
      if (typeof ts === 'string') setRevealTs(ts)
    }
    window.addEventListener(REVEAL_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_EVENT, onReveal)
  }, [])

  // 跳转目标可能比换会话的那次渲染先到，所以每次渲染都按当前的消息重新找它
  let needed = count
  if (revealTs != null) {
    const idx = messages.findIndex((m) => m.timestamp === revealTs)
    if (idx >= 0) needed = Math.max(needed, messages.length - idx + REVEAL_MARGIN)
  }
  const shown = Math.min(messages.length, needed)
  const start = messages.length - shown

  // 往上接更早的消息：接之前量一下高度，接完把滚动位置往下挪同样多，眼前的内容不动
  //   （高度要在接之前当场量：气泡里的图片、折叠块会自己变高，事先记下的不准）
  const pending = useRef<{ height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    const before = pending.current
    if (!el || !before) return
    pending.current = null
    el.scrollTop = before.top + (el.scrollHeight - before.height)
  }, [scrollRef, start])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || el.scrollTop > NEAR_TOP || shown >= messages.length) return
    pending.current = { height: el.scrollHeight, top: el.scrollTop }
    setCount(shown + STEP)
  }, [scrollRef, messages.length, shown])

  return { visible: start > 0 ? messages.slice(start) : messages, hiddenCount: start, onScroll }
}
