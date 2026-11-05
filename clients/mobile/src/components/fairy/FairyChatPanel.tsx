// ══════════════════════════════════════════════
// Fairy 聊天面板组合件（对应 desktop ChatPanel 的主体）
// 纯组件层：状态全部走 props，不依赖 chat-controller；接线在 AgentPanel。
//
// 自上而下：头部 → 会话条 → 消息列表 → 注视提示 → 正在听 → 输入坞。
// 键盘避让、面板定位、顶部拖拽调高都在调用方：
//   · 调高：把 Animated 高度传给 listContainerStyle（默认 flex:1）
//   · 拖拽把手：把 panHandlers 传给 headerPanHandlers
// ══════════════════════════════════════════════

import { useCallback, useState } from 'react'
import { Animated, StyleSheet, View, type GestureResponderHandlers, type StyleProp, type ViewStyle } from 'react-native'
import { theme } from '../../theme'
import type { ApiRequestSnapshot } from '../../lib/llm/api'
import type { ChatImageAttachment } from '../../types'
import DebugRequestModal, { OmniDebugModal } from './DebugRequestModal'
import { FairyHeader, SessionStrip } from './FairyHeader'
import FairyInputDock from './FairyInputDock'
import FairyMessageList from './FairyMessageList'
import { GazeBar, ListeningBar } from './FairyStatusBars'
import type { FairyGazeTarget, FairyJumpTarget, FairyMessage, FairyState, OmniDebugInfo } from './types'

export interface FairyChatPanelProps {
  readonly messages: readonly FairyMessage[]
  readonly isProcessing: boolean
  readonly onSend: (text: string) => void
  /** 呼号来自 AI 人设配置（名称 / 称呼用户为），不硬编码 */
  readonly agentName?: string
  readonly userCallsign?: string
  /** 主人锁定的卡片（Fairy 正注视的目标），显示注视提示条 */
  readonly gazeTarget?: FairyGazeTarget | null
  readonly onClearGaze?: () => void
  readonly aiMode?: 'regular' | 'omni'
  readonly onToggleAiMode?: () => void
  readonly ttsEnabled?: boolean
  readonly onToggleTts?: () => void
  readonly onOpenSessions?: () => void
  readonly sessionsOpen?: boolean
  /** 当前会话标题（AI 起名 / 手动重命名后更新） */
  readonly sessionTitle?: string
  /** Fairy 此刻的状态：驱动状态行、正在听提示 */
  readonly fairyState?: FairyState
  /** 上下文占用 0–1（历史字符数 / 压缩高水位） */
  readonly contextRatio?: number

  // ── 手机端特有 ──
  /** 跳到某条消息并高亮（历史会话搜索命中） */
  readonly jumpTo?: FairyJumpTarget | null
  readonly onOpenModelCenter?: () => void
  readonly onOpenSettings?: () => void
  readonly style?: StyleProp<ViewStyle>
  /** 消息区容器样式，默认 flex:1；AgentPanel 传 { height: Animated.Value } 调高 */
  readonly listContainerStyle?: Animated.WithAnimatedValue<StyleProp<ViewStyle>>
  readonly headerPanHandlers?: GestureResponderHandlers
  /** 左右留白；放进自带内边距的容器时传 0 */
  readonly gutter?: number
  readonly placeholder?: string
  readonly voiceHint?: string
  readonly autoFocus?: boolean
  readonly pendingImages?: readonly ChatImageAttachment[]
  readonly onPressAttach?: () => void
  readonly onRemoveImage?: (image: ChatImageAttachment) => void
  readonly onVoicePressIn?: () => void
  readonly onVoicePressOut?: () => void
  /** 手指按着输入坞的麦克风（fairyState 还没切到 listening 时也显示「正在听」） */
  readonly recording?: boolean
  readonly recordMs?: number
}

export default function FairyChatPanel({
  messages,
  isProcessing,
  onSend,
  agentName = 'Fairy',
  userCallsign = '主人',
  gazeTarget = null,
  onClearGaze,
  aiMode = 'regular',
  onToggleAiMode,
  ttsEnabled,
  onToggleTts,
  onOpenSessions,
  sessionsOpen,
  sessionTitle,
  fairyState = 'idle',
  contextRatio = 0,
  jumpTo = null,
  onOpenModelCenter,
  onOpenSettings,
  style,
  listContainerStyle,
  headerPanHandlers,
  gutter = 14,
  placeholder,
  voiceHint,
  autoFocus,
  pendingImages,
  onPressAttach,
  onRemoveImage,
  onVoicePressIn,
  onVoicePressOut,
  recording = false,
  recordMs,
}: FairyChatPanelProps) {
  const [activeDebugSnaps, setActiveDebugSnaps] = useState<readonly ApiRequestSnapshot[] | null>(null)
  const [activeOmniDebug, setActiveOmniDebug] = useState<OmniDebugInfo | null>(null)
  const listening = fairyState === 'listening' || recording

  const closeDebug = useCallback(() => setActiveDebugSnaps(null), [])
  const closeOmniDebug = useCallback(() => setActiveOmniDebug(null), [])

  return (
    <View style={[styles.root, style]}>
      <FairyHeader
        agentName={agentName}
        fairyState={fairyState}
        contextRatio={contextRatio}
        ttsEnabled={ttsEnabled}
        onToggleTts={onToggleTts}
        onOpenSettings={onOpenSettings}
        headerPanHandlers={headerPanHandlers}
        gutter={gutter}
      />
      {onOpenSessions && (
        <SessionStrip
          sessionTitle={sessionTitle}
          sessionsOpen={sessionsOpen}
          onOpenSessions={onOpenSessions}
          gutter={gutter}
        />
      )}
      <View style={styles.rule} />

      <Animated.View style={listContainerStyle ?? styles.listFill}>
        <FairyMessageList
          messages={messages}
          isProcessing={isProcessing}
          agentName={agentName}
          userCallsign={userCallsign}
          voiceHint={voiceHint}
          jumpTo={jumpTo}
          gutter={gutter}
          onDebug={setActiveDebugSnaps}
          onOmniDebug={setActiveOmniDebug}
        />
      </Animated.View>

      {activeDebugSnaps && <DebugRequestModal snapshots={activeDebugSnaps} onClose={closeDebug} />}
      {activeOmniDebug && <OmniDebugModal info={activeOmniDebug} onClose={closeOmniDebug} />}

      {gazeTarget && <GazeBar target={gazeTarget} onClear={onClearGaze} gutter={gutter} />}
      {listening && <ListeningBar recordMs={recordMs} gutter={gutter} />}

      <View style={styles.rule} />
      <FairyInputDock
        isProcessing={isProcessing}
        onSend={onSend}
        aiMode={aiMode}
        onToggleAiMode={onToggleAiMode}
        onOpenModelCenter={onOpenModelCenter}
        placeholder={placeholder}
        autoFocus={autoFocus}
        gutter={gutter}
        pendingImages={pendingImages}
        onPressAttach={onPressAttach}
        onRemoveImage={onRemoveImage}
        onVoicePressIn={onVoicePressIn}
        onVoicePressOut={onVoicePressOut}
        recording={recording}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flexShrink: 1 },
  listFill: { flex: 1 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: theme.line },
})
