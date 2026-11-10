// ══════════════════════════════════════════════
// 单条消息（对应 desktop ChatPanel Bubble）：
//   · 系统消息：一行等宽小字
//   · 工具调用：单独一行，点开看参数和结果（ToolCallRow）
//   · 压缩提示：同样一行小字，点一下展开摘要（desktop CompactNotice）
//   · 主人语音：语音条 + 转写
//   · 主人文字（含边说边出的中间结果）：右侧气泡
//   · Fairy：文字直接落在面板上（markdown）
//
// 和桌面端的差异：
//   · 桌面端靠选中文字复制；手机端长按消息弹菜单（复制 + 调试入口），由 FairyMessageList 统一处理
//   · 用量小牌桌面端紧跟在最后一句后面（CSS 把最后一段改成行内）；RN 的 Text 里嵌带弹窗的 Pressable 不可靠，放在正文下一行
//   · fadeSlideIn 入场动画没搬：历史会话一次加载几百条时会全部闪一遍
// ══════════════════════════════════════════════

import { memo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { alpha, fonts, theme } from '../../theme'
import type { ApiRequestSnapshot } from '../../lib/llm/api'
import ModelUsageBadge from '../models/ModelUsageBadge'
import AudioBubble from './AudioBubble'
import FairyMarkdown from './FairyMarkdown'
import { IconBug, IconRadio } from './icons'
import { BubbleImages } from './ImageAttachments'
import { MetaIconBtn, MsgMeta } from './MessageMeta'
import ReasoningBlock from './ReasoningBlock'
import ToolCallRow from './ToolCallRow'
import { TEXT_LINE_HEIGHT, TEXT_SIZE, isSystemError } from './fairy-format'
import type { FairyMessage, OmniDebugInfo } from './types'

const LONG_PRESS_MS = 350

export interface FairyBubbleProps {
  readonly message: FairyMessage
  readonly agentName: string
  readonly userCallsign: string
  readonly onDebug?: (snapshots: readonly ApiRequestSnapshot[]) => void
  readonly onOmniDebug?: (info: OmniDebugInfo) => void
  readonly onLongPress?: (message: FairyMessage) => void
}

// ── 系统 / 工具消息 ──

function CompactNotice({ message, onLongPress }: Pick<FairyBubbleProps, 'message' | 'onLongPress'>) {
  const [expanded, setExpanded] = useState(false)
  return (
    <View>
      <Pressable
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        delayLongPress={LONG_PRESS_MS}
        onPress={() => setExpanded(!expanded)}
        onLongPress={onLongPress ? () => onLongPress(message) : undefined}
      >
        <Text style={styles.system}>{message.content}  {expanded ? '收起 ▾' : '看摘要 ▸'}</Text>
      </Pressable>
      {expanded && (
        <ScrollView style={styles.summaryWell} contentContainerStyle={styles.summaryContent} nestedScrollEnabled>
          <Text style={styles.summaryText}>{message.summary}</Text>
        </ScrollView>
      )}
    </View>
  )
}

export function SystemLine({ message, onLongPress }: Pick<FairyBubbleProps, 'message' | 'onLongPress'>) {
  if (message.tool) return <ToolCallRow call={message.tool} onLongPress={onLongPress ? () => onLongPress(message) : undefined} />
  if (message.summary) return <CompactNotice message={message} onLongPress={onLongPress} />
  const isErr = isSystemError(message.content)
  return (
    <Pressable delayLongPress={LONG_PRESS_MS} onLongPress={onLongPress ? () => onLongPress(message) : undefined}>
      <Text style={[styles.system, isErr && styles.systemError]}>{message.content}</Text>
    </Pressable>
  )
}

// ── 主人 ──

export function UserBubble({ message, userCallsign, onLongPress }: Pick<FairyBubbleProps, 'message' | 'userCallsign' | 'onLongPress'>) {
  const audio = message.audio
  const transcript = audio ? (audio.transcript || message.content) : ''
  return (
    <View>
      <MsgMeta label={userCallsign} ts={message.timestamp} align="right" />
      <View style={styles.userRow}>
        <Pressable
          style={styles.userBubble}
          delayLongPress={LONG_PRESS_MS}
          onLongPress={onLongPress ? () => onLongPress(message) : undefined}
        >
          {message.images && message.images.length > 0 && <BubbleImages images={message.images} />}
          {audio ? (
            <>
              <AudioBubble audio={audio} fallbackSeed={message.id} />
              {transcript ? <Text style={styles.transcript}>{transcript}</Text> : null}
            </>
          ) : message.content.length > 0 ? (
            <Text style={styles.userText}>{message.content}</Text>
          ) : null}
        </Pressable>
      </View>
    </View>
  )
}

// ── Fairy ──

export function AgentBubble({ message, agentName, onDebug, onOmniDebug, onLongPress }: Omit<FairyBubbleProps, 'userCallsign'>) {
  const snapshots = message.debugSnapshots
  const omniInfo = message.omniDebugInfo
  const hasContent = message.content.length > 0
  // 桌面端只看正文有没有开始；手机端多一个 streaming 标记：这轮结束了正文仍为空（出错 / 打断），不再一直显示「正在思考」
  const answered = hasContent || !message.streaming
  return (
    <View>
      <MsgMeta
        label={agentName}
        ts={message.timestamp}
        align="left"
        fairy
        actions={
          <>
            {snapshots && onDebug && (
              <MetaIconBtn tip="查看本轮 AI 请求" onPress={() => onDebug(snapshots)}>
                <IconBug size={13} color={theme.inkFaint} />
              </MetaIconBtn>
            )}
            {omniInfo && onOmniDebug && (
              <MetaIconBtn tip="查看本轮 Omni 上下文" onPress={() => onOmniDebug(omniInfo)}>
                <IconRadio size={13} color={theme.inkFaint} />
              </MetaIconBtn>
            )}
          </>
        }
      />
      {message.reasoning ? <ReasoningBlock text={message.reasoning} answered={answered} /> : null}
      {message.images && message.images.length > 0 && <BubbleImages images={message.images} />}
      <Pressable delayLongPress={LONG_PRESS_MS} onLongPress={onLongPress ? () => onLongPress(message) : undefined}>
        {hasContent ? (
          <FairyMarkdown text={message.content} streaming={!!message.streaming} />
        ) : message.streaming && !message.reasoning ? (
          <Text style={styles.pending}>…</Text>
        ) : null}
      </Pressable>
      {message.usage ? (
        <View style={styles.usageRow}>
          <ModelUsageBadge call={message.usage} minimal />
        </View>
      ) : null}
      {message.audio ? (
        <View style={styles.agentAudio}>
          <AudioBubble audio={message.audio} fallbackSeed={message.id} />
        </View>
      ) : null}
    </View>
  )
}

function FairyBubble({ message, agentName, userCallsign, onDebug, onOmniDebug, onLongPress }: FairyBubbleProps) {
  if (message.role === 'system') return <SystemLine message={message} onLongPress={onLongPress} />
  if (message.role === 'user') return <UserBubble message={message} userCallsign={userCallsign} onLongPress={onLongPress} />
  return <AgentBubble message={message} agentName={agentName} onDebug={onDebug} onOmniDebug={onOmniDebug} onLongPress={onLongPress} />
}

// 流式时只有最后一条在变，其他消息不用重渲染（前提是 message 对象引用稳定、回调稳定）
export default memo(FairyBubble)

const styles = StyleSheet.create({
  system: {
    fontFamily: fonts.mono, fontSize: 11, lineHeight: 18,
    color: theme.inkSoft, opacity: 0.85,
  },
  systemError: { color: theme.danger, opacity: 1 },
  summaryWell: { marginTop: 6, maxHeight: 280, backgroundColor: theme.sunk, borderRadius: 8 },
  summaryContent: { paddingHorizontal: 12, paddingVertical: 8 },
  summaryText: { fontSize: 12, lineHeight: 20, color: theme.inkSoft },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  userBubble: {
    maxWidth: '88%', backgroundColor: alpha(theme.accent, 0.1), borderRadius: 14,
    paddingHorizontal: 12, paddingTop: 8, paddingBottom: 9,
  },
  userText: { fontSize: TEXT_SIZE, lineHeight: TEXT_LINE_HEIGHT - 1, color: theme.ink },
  transcript: { marginTop: 7, fontSize: TEXT_SIZE - 0.5, lineHeight: TEXT_LINE_HEIGHT - 1, color: theme.inkSoft },
  pending: { fontSize: TEXT_SIZE, lineHeight: TEXT_LINE_HEIGHT, color: theme.inkFaint },
  usageRow: { flexDirection: 'row', marginTop: 2 },
  agentAudio: {
    alignSelf: 'flex-start', marginTop: 8, backgroundColor: theme.sunk, borderRadius: 12,
    paddingHorizontal: 10, paddingVertical: 7,
  },
})
