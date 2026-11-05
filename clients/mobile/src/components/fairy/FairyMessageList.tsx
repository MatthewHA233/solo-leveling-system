// ══════════════════════════════════════════════
// 消息列表（对应 desktop ChatPanel 的 Messages 区）
//
// 和桌面端的差异：
//   · 贴底：桌面端每来一个字都拉到底，往上翻的时候也会被拽回来；手机端用手指往上拖之后就不再拽，
//     拖回底部附近才恢复贴底。主人自己发新消息、切会话时一定回到底部
//   · 跳转：桌面端 querySelector + scrollIntoView；手机端记每行的 y，滚到居中后叠一层高亮（节奏相同：1.6s，30% 处最亮）
//   · 手机一次先渲染最近 PAGE 条，往前点「查看更早」：手写 markdown 全量挂载几百条会卡
//   · 复制：长按消息弹菜单（桌面端直接选中文字）
//
// 键盘避让不在这里做：调用方（AgentPanel 的 useStableKeyboardInset）把整个面板顶起来，
// 列表高度变化走 onLayout，贴底状态下自动回到底部。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { alpha, theme } from '../../theme'
import type { ApiRequestSnapshot } from '../../lib/llm/api'
import FairyBubble from './FairyBubble'
import MessageActionSheet from './MessageActionSheet'
import TypingDots from './TypingDots'
import type { FairyJumpTarget, FairyMessage, OmniDebugInfo } from './types'

const PAGE = 120
const BOTTOM_SLOP = 48          // 离底部这么近就算在底部
const JUMP_GIVE_UP_MS = 2500    // 目标消息一直没出现（会话还没加载完 / 已被删）就放弃
const FLASH_MS = 1600
const FLASH_PEAK = 0.3          // 30% 处最亮，对应桌面端 msgJumpFlash

function timeValue(ts: number | string): number {
  return typeof ts === 'number' ? ts : new Date(ts).getTime()
}

export interface FairyMessageListProps {
  readonly messages: readonly FairyMessage[]
  readonly isProcessing: boolean
  readonly agentName: string
  readonly userCallsign: string
  /** 空态第二行；桌面端是「按住右 Alt 说话」，手机端的入口由调用方决定 */
  readonly voiceHint?: string
  readonly jumpTo?: FairyJumpTarget | null
  readonly gutter?: number
  readonly onDebug: (snapshots: readonly ApiRequestSnapshot[]) => void
  readonly onOmniDebug: (info: OmniDebugInfo) => void
}

export default function FairyMessageList({
  messages,
  isProcessing,
  agentName,
  userCallsign,
  voiceHint = '打字，或长按底部中央按钮说话',
  jumpTo = null,
  gutter = 14,
  onDebug,
  onOmniDebug,
}: FairyMessageListProps) {
  const scrollRef = useRef<ScrollView>(null)
  const stuck = useRef(true)
  const fingerDown = useRef(false)
  const momentum = useRef(false)
  const scrollY = useRef(0)
  const viewH = useRef(0)
  const contentH = useRef(0)
  const compensate = useRef<{ height: number; y: number } | null>(null)
  const rowLayout = useRef(new Map<string, { y: number; height: number }>())

  const [visibleCount, setVisibleCount] = useState(PAGE)
  const [actionMessage, setActionMessage] = useState<FairyMessage | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const flash = useRef(new Animated.Value(0)).current

  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const visibleCountRef = useRef(visibleCount)
  visibleCountRef.current = visibleCount

  const pendingJump = useRef<number | null>(null) // 目标消息的时间值

  const firstId = messages[0]?.id
  const last = messages[messages.length - 1]
  const lastId = last?.id
  const lastRole = last?.role

  const toBottom = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false })
  }, [])

  const isNearBottom = useCallback((y: number) => (
    y + viewH.current >= contentH.current - BOTTOM_SLOP
  ), [])

  // ── 跳转 ──

  const tryJump = useCallback(() => {
    const target = pendingJump.current
    if (target === null) return
    const all = messagesRef.current
    const index = all.findIndex((m) => timeValue(m.timestamp) === target)
    if (index < 0) return
    // 目标在没渲染的那段：先放开窗口，等这一行 onLayout 再来一次
    const needed = all.length - index
    if (needed > visibleCountRef.current) {
      setVisibleCount(needed + PAGE)
      return
    }
    const id = all[index].id
    const layout = rowLayout.current.get(id)
    if (!layout) return
    pendingJump.current = null
    stuck.current = false
    scrollRef.current?.scrollTo({
      y: Math.max(0, layout.y - Math.max(0, (viewH.current - layout.height) / 2)),
      animated: true,
    })
    setFlashId(id)
    flash.stopAnimation()
    flash.setValue(0)
    Animated.sequence([
      Animated.timing(flash, { toValue: 1, duration: FLASH_MS * FLASH_PEAK, useNativeDriver: true }),
      Animated.timing(flash, { toValue: 0, duration: FLASH_MS * (1 - FLASH_PEAK), useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setFlashId(null)
    })
  }, [flash])

  const jumpNonce = jumpTo?.nonce
  const jumpTs = jumpTo?.timestamp
  useEffect(() => {
    if (jumpNonce === undefined || jumpTs === undefined) return
    const target = timeValue(jumpTs)
    if (Number.isNaN(target)) return
    pendingJump.current = target
    stuck.current = false
    tryJump()
    const timer = setTimeout(() => {
      if (pendingJump.current === target) {
        pendingJump.current = null
        stuck.current = isNearBottom(scrollY.current)
      }
    }, JUMP_GIVE_UP_MS)
    return () => clearTimeout(timer)
  }, [jumpNonce, jumpTs, tryJump, isNearBottom])

  // 跳转时会话可能还在加载：消息到了再试
  useEffect(() => { tryJump() }, [messages, tryJump])

  useEffect(() => () => flash.stopAnimation(), [flash])

  // ── 贴底 ──

  // 切会话：窗口复位，回到底部
  useEffect(() => {
    setVisibleCount(PAGE)
    setFlashId(null)
    rowLayout.current.clear()
    if (pendingJump.current === null) {
      stuck.current = true
      toBottom()
    }
  }, [firstId, toBottom])

  // 主人发了新消息：不管翻到哪都回到底部
  useEffect(() => {
    if (lastRole === 'user' && pendingJump.current === null) {
      stuck.current = true
      toBottom()
    }
  }, [lastId, lastRole, toBottom])

  const onContentSizeChange = useCallback((_w: number, height: number) => {
    contentH.current = height
    const keep = compensate.current
    if (keep) {
      // 「查看更早」把内容往下推了：补回同样的距离，眼前的消息不动
      compensate.current = null
      if (height !== keep.height) {
        scrollRef.current?.scrollTo({ y: keep.y + (height - keep.height), animated: false })
      }
      return
    }
    if (stuck.current && pendingJump.current === null) toBottom()
  }, [toBottom])

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    viewH.current = e.nativeEvent.layout.height
    if (stuck.current && pendingJump.current === null) toBottom()
  }, [toBottom])

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y
    scrollY.current = y
    // 只有手指带动的滚动才改变贴底状态；内容长高、程序滚动都不算
    if (fingerDown.current || momentum.current) stuck.current = isNearBottom(y)
  }, [isNearBottom])

  const onRowLayout = useCallback((id: string, e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout
    rowLayout.current.set(id, { y, height })
    if (pendingJump.current !== null) tryJump()
  }, [tryJump])

  const loadEarlier = useCallback(() => {
    compensate.current = { height: contentH.current, y: scrollY.current }
    setVisibleCount((n) => n + PAGE)
  }, [])

  const closeActions = useCallback(() => setActionMessage(null), [])

  const hidden = Math.max(0, messages.length - visibleCount)
  const shown = hidden > 0 ? messages.slice(hidden) : messages

  return (
    <>
      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={[styles.content, { paddingHorizontal: gutter }, messages.length === 0 && styles.contentEmpty]}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={32}
        onScroll={onScroll}
        onScrollBeginDrag={() => { fingerDown.current = true }}
        onScrollEndDrag={(e) => {
          fingerDown.current = false
          if (!momentum.current) stuck.current = isNearBottom(e.nativeEvent.contentOffset.y)
        }}
        onMomentumScrollBegin={() => { momentum.current = true }}
        onMomentumScrollEnd={(e) => {
          momentum.current = false
          stuck.current = isNearBottom(e.nativeEvent.contentOffset.y)
        }}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
      >
        {messages.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>想到什么，就跟 {agentName} 说</Text>
            {voiceHint !== '' && <Text style={styles.emptyHint}>{voiceHint}</Text>}
          </View>
        )}

        {hidden > 0 && (
          <Pressable style={styles.earlier} hitSlop={8} accessibilityRole="button" onPress={loadEarlier}>
            <Text style={styles.earlierText}>查看更早的 {hidden} 条</Text>
          </Pressable>
        )}

        {shown.map((msg) => (
          <View key={msg.id} onLayout={(e) => onRowLayout(msg.id, e)}>
            <FairyBubble
              message={msg}
              agentName={agentName}
              userCallsign={userCallsign}
              onDebug={onDebug}
              onOmniDebug={onOmniDebug}
              onLongPress={setActionMessage}
            />
            {flashId === msg.id && (
              <Animated.View pointerEvents="none" style={[styles.flash, { opacity: flash }]} />
            )}
          </View>
        ))}

        {isProcessing && lastRole !== 'agent' && <TypingDots />}
      </ScrollView>

      <MessageActionSheet
        message={actionMessage}
        onClose={closeActions}
        onDebug={onDebug}
        onOmniDebug={onOmniDebug}
      />
    </>
  )
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { paddingTop: 16, paddingBottom: 12, gap: 16 },
  contentEmpty: { flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 14, color: theme.inkSoft, textAlign: 'center' },
  emptyHint: { fontSize: 12, color: theme.inkFaint, textAlign: 'center' },
  earlier: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 12, backgroundColor: theme.sunk },
  earlierText: { fontSize: 12, color: theme.inkSoft },
  flash: {
    position: 'absolute', top: -4, bottom: -4, left: -6, right: -6,
    borderRadius: 6, backgroundColor: alpha(theme.accent, 0.12),
  },
})
