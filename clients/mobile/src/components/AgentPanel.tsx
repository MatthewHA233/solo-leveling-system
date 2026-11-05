// ══════════════════════════════════════════════
// AgentPanel — Fairy 悬浮对话气泡（对应 desktop FairyWindow 的面板 + App.tsx 的 ChatPanel / SessionPicker 接线）
// 内容是 fairy/FairyChatPanel；这里管定位、键盘避让、上下拖动调高和几个弹层的开关。
// 桌面端是独立透明窗口，手机端是全局层：底部位置和气泡尖不动，消息区向上长高，
// 点外部蒙版收起。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, PanResponder, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { theme } from '../theme'
import type { ChatSessionInfo } from '../lib/agent/agent-memory'
import { MAX_CHAT_IMAGES, pickChatImages, type PickedImage } from '../lib/chatimage'
import type { ChatImageAttachment } from '../types'
import { useChatController } from '../lib/agent/use-chat-controller'
import { useStableKeyboardInset } from '../lib/use-keyboard-inset'
import FairyChatPanel from './fairy/FairyChatPanel'
import FairySettingsSheet from './fairy/FairySettingsSheet'
import SessionPicker from './fairy/SessionPicker'
import { showTip } from './fairy/tip'
import { stopFairyAudio } from './fairy/useAudioPlayback'
import ModelCenter from './ModelCenter'

interface Props {
  readonly visible: boolean
  readonly onClose: () => void
}

const BODY_MIN = 120
const BODY_INIT = 180
/** 消息区以外的结构（把手、头部、会话条、输入坞、内边距）大约占的高度 */
const PANEL_CHROME = 250
/** 按住不到这么久松手算误触 */
const VOICE_MIN_HOLD_MS = 500

export default function AgentPanel({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets()
  const { height: H } = useWindowDimensions()
  const ctrl = useChatController()
  const keyboardInset = useStableKeyboardInset(visible)

  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [modelCenterOpen, setModelCenterOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ── 顶部拖拽调高（bottom sheet 式）：bodyH 直接驱动消息区高度 ──
  const bodyH = useRef(new Animated.Value(BODY_INIT)).current
  const bodyHNow = useRef(BODY_INIT)
  const dragStartH = useRef(BODY_INIT)
  const bodyMaxRef = useRef(400)
  const dragPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        dragStartH.current = bodyHNow.current
      },
      onPanResponderMove: (_e, g) => {
        // 向上拖 dy<0 → 变高
        const next = Math.min(bodyMaxRef.current, Math.max(BODY_MIN, dragStartH.current - g.dy))
        bodyHNow.current = next
        bodyH.setValue(next)
      },
    }),
  ).current

  const bottom = keyboardInset > 0 ? keyboardInset + 8 : 104
  // 拖拽上限：顶部留出安全区 + 一口呼吸，消息区以外的结构不动
  const bodyMax = Math.max(BODY_MIN, H - insets.top - 44 - bottom - PANEL_CHROME)
  bodyMaxRef.current = bodyMax

  // 键盘弹起后放不下：先把消息区压矮，别顶出屏幕
  useEffect(() => {
    if (bodyHNow.current > bodyMax) {
      bodyHNow.current = bodyMax
      bodyH.setValue(bodyMax)
    }
  }, [bodyMax, bodyH])

  // 关闭面板时停掉气泡回放（回复朗读不停：Fairy 是全局的，收起面板不等于让她闭嘴）
  useEffect(() => {
    if (!visible) return
    return () => {
      stopFairyAudio()
      ctrl.clearJump()
    }
  }, [visible, ctrl])

  // ── 输入坞的按住说话 ──
  const [recording, setRecording] = useState(false)
  const [recordMs, setRecordMs] = useState(0)
  const recordStartRef = useRef(0)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopRecordTimer = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
  }
  useEffect(() => stopRecordTimer, [])

  const onVoicePressIn = useCallback(() => {
    stopFairyAudio()
    recordStartRef.current = Date.now()
    setRecordMs(0)
    setRecording(true)
    recordTimerRef.current = setInterval(() => setRecordMs(Date.now() - recordStartRef.current), 100)
    ctrl.voicePressStart()
  }, [ctrl])

  const onVoicePressOut = useCallback(() => {
    stopRecordTimer()
    setRecording(false)
    ctrl.voicePressEnd(Date.now() - recordStartRef.current >= VOICE_MIN_HOLD_MS)
  }, [ctrl])

  // ── 会话选择器（对应 desktop toggleSessionPicker）──
  const toggleSessionPicker = useCallback(() => {
    setSessionsOpen((open) => {
      if (!open) ctrl.loadSessionsForPicker()
      return !open
    })
  }, [ctrl])

  const closeSessionPicker = useCallback(() => setSessionsOpen(false), [])

  const onSelectSession = useCallback((id: string, jumpToTimestamp: string | undefined, session: ChatSessionInfo) => {
    setSessionsOpen(false)
    void ctrl.selectSession(id, jumpToTimestamp, session)
  }, [ctrl])

  const onNewSession = useCallback(() => {
    setSessionsOpen(false)
    void ctrl.newSession()
  }, [ctrl])

  const onDeleteSession = useCallback((id: string) => {
    void ctrl.deleteSession(id)
  }, [ctrl])

  const [pendingImages, setPendingImages] = useState<readonly PickedImage[]>([])
  const pendingImagesRef = useRef(pendingImages)
  pendingImagesRef.current = pendingImages
  const imageGateRef = useRef<() => boolean>(() => true)

  useEffect(() => {
    ctrl.setVoiceImageSource(() => {
      const images = pendingImagesRef.current
      if (images.length === 0 || !imageGateRef.current()) return []
      pendingImagesRef.current = []
      setPendingImages([])
      return images
    })
  }, [ctrl])

  const onSend = useCallback((text: string) => {
    void ctrl.sendText(text, pendingImages)
    setPendingImages([])
  }, [ctrl, pendingImages])

  const onPressAttach = useCallback(() => {
    const room = MAX_CHAT_IMAGES - pendingImages.length
    if (room <= 0) {
      showTip(`一次最多发 ${MAX_CHAT_IMAGES} 张`)
      return
    }
    pickChatImages(room).then(({ images, failed, skipped }) => {
      if (skipped > 0) showTip(`一次最多发 ${MAX_CHAT_IMAGES} 张，多选的 ${skipped} 张没有加上`)
      if (failed > 0) showTip(`有 ${failed} 张图片读不了`)
      if (images.length > 0) setPendingImages((prev) => [...prev, ...images].slice(0, MAX_CHAT_IMAGES))
    }).catch((e) => showTip(`选图失败：${e instanceof Error ? e.message : String(e)}`))
  }, [pendingImages.length])

  const onRemoveImage = useCallback((image: ChatImageAttachment) => {
    setPendingImages((prev) => prev.filter((p) => p.id !== image.id))
  }, [])

  return (
    <>
      {visible && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {/* 灰色蒙版：点击面板外部即收起 */}
          <Pressable style={styles.mask} onPress={onClose} />

          <View style={[styles.wrap, { bottom }]} pointerEvents="box-none">
            <View style={styles.dock}>
              <View style={styles.tail} />
              <View style={styles.dragHandle} {...dragPan.panHandlers}>
                <View style={styles.grabber} />
              </View>
              <FairyChatPanel
                messages={ctrl.messages}
                isProcessing={ctrl.isProcessing}
                onSend={onSend}
                pendingImages={pendingImages}
                imageGateRef={imageGateRef}
                onPressAttach={onPressAttach}
                onRemoveImage={onRemoveImage}
                agentName={ctrl.config.agentName}
                userCallsign={ctrl.config.agentCallUser}
                gazeTarget={ctrl.gazeTarget}
                onClearGaze={ctrl.clearGaze}
                aiMode={ctrl.config.aiMode}
                onToggleAiMode={ctrl.toggleAiMode}
                ttsEnabled={ctrl.config.ttsEnabled}
                onToggleTts={ctrl.toggleTts}
                onOpenSessions={toggleSessionPicker}
                sessionsOpen={sessionsOpen}
                sessionTitle={ctrl.sessionTitle}
                fairyState={ctrl.fairyState}
                contextRatio={ctrl.contextRatio}
                jumpTo={ctrl.jumpTo}
                onOpenModelCenter={() => setModelCenterOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
                listContainerStyle={{ height: bodyH }}
                headerPanHandlers={dragPan.panHandlers}
                gutter={0}
                placeholder="继续问…"
                onVoicePressIn={onVoicePressIn}
                onVoicePressOut={onVoicePressOut}
                recording={recording}
                recordMs={recordMs}
              />
            </View>
          </View>

          <SessionPicker
            visible={sessionsOpen}
            sessions={ctrl.sessions}
            currentSessionId={ctrl.sessionId}
            onSelect={onSelectSession}
            onNewSession={onNewSession}
            onDelete={onDeleteSession}
            onClose={closeSessionPicker}
            onRefresh={ctrl.refreshSessions}
          />
          <ModelCenter
            visible={modelCenterOpen}
            config={ctrl.config}
            onClose={() => setModelCenterOpen(false)}
            onSaveConfig={ctrl.updateConfig}
          />
        </View>
      )}

      {/* 常驻挂载：面板收起时设置里没保存的草稿不能丢 */}
      <FairySettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )
}

const styles = StyleSheet.create({
  mask: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(10, 12, 18, 0.22)',
  },
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 12,
  },
  dock: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 0,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
    borderWidth: 1,
    borderColor: theme.line,
  },
  tail: {
    position: 'absolute',
    bottom: -7.5,
    left: '50%',
    marginLeft: -7,
    width: 14,
    height: 14,
    backgroundColor: theme.surface,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.line,
    transform: [{ rotate: '45deg' }],
  },
  dragHandle: {
    marginHorizontal: -14,
    paddingHorizontal: 14,
    paddingBottom: 2,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.line,
  },
})
