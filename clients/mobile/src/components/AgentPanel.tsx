// ══════════════════════════════════════════════
// AgentPanel — Fairy 悬浮对话气泡（对应 desktop FairyWindow 的面板 + App.tsx 的 ChatPanel / SessionPicker 接线）
// 内容是 fairy/FairyChatPanel；这里管定位、键盘避让、上下拖动调高和几个弹层的开关。
// 桌面端是独立透明窗口，手机端是全局层：底部位置和气泡尖不动，面板向上长高，
// 点外部蒙版或往下拉收起。
//
// 高度两档（底部弹层的常见做法）：「全屏」顶到状态栏下面，「半屏」约三分之二。
// 拖把手或头部跟手走，松手按位置和速度弹到最近的一档，往下拉过头就收起；选中的档位记在本机。
// 键盘起来只是临时压矮，收起后回到原来那档（以前压矮了就回不去，下次打开还是那个矮样子）。
// 打开、收起都有过渡：蒙版淡入淡出，面板从下面浮上来。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, Easing, PanResponder, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { theme } from '../theme'
import type { ChatSessionInfo } from '../lib/agent/agent-memory'
import { MAX_CHAT_IMAGES, pickChatImages, type PickedImage } from '../lib/chatimage'
import type { ChatImageAttachment } from '../types'
import { useChatController } from '../lib/agent/use-chat-controller'
import { solevupGetPref, solevupSetPref } from '../lib/solevupdb'
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

type Detent = 'half' | 'full'
const DETENT_PREF = 'fairy_panel_detent'
/** 面板底到屏幕底：TabBar + 气泡尖 */
const DOCK_BOTTOM = 104
/** 拉满时顶部离状态栏 */
const TOP_GAP = 10
/** 面板最矮：头部、会话条、输入坞之外至少还能看见一两条消息 */
const PANEL_MIN = 320
const HALF_RATIO = 0.66
/** 往下拉过这么多，或者半屏以下快速往下甩，就收起 */
const DISMISS_PULL = 90
const DISMISS_VELOCITY = 1.0
/** 松手后按速度往前多算这么多毫秒再找最近的档 */
const PROJECT_MS = 160
const SPRING = { damping: 26, stiffness: 280, mass: 0.9 }
/** 按住不到这么久松手算误触 */
const VOICE_MIN_HOLD_MS = 500

// 进程内记住，开关面板不用再读库
let rememberedDetent: Detent = 'full'
let detentLoaded = false

export default function AgentPanel({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets()
  const { height: H } = useWindowDimensions()
  const ctrl = useChatController()
  const keyboardInset = useStableKeyboardInset(visible)

  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [modelCenterOpen, setModelCenterOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ── 档位 ──
  const [detent, setDetent] = useState<Detent>(rememberedDetent)
  useEffect(() => {
    if (detentLoaded) return
    detentLoaded = true
    solevupGetPref(DETENT_PREF, rememberedDetent).then((v) => {
      if (v === 'half' || v === 'full') {
        rememberedDetent = v
        setDetent(v)
      }
    }).catch(() => {})
  }, [])

  const bottom = keyboardInset > 0 ? keyboardInset + 8 : DOCK_BOTTOM
  const topLimit = insets.top + TOP_GAP
  // 没键盘时面板最高能到多高；键盘起来时现在最高能到多高
  const roomFree = Math.max(PANEL_MIN, H - topLimit - DOCK_BOTTOM)
  const roomNow = Math.max(240, H - topLimit - bottom)
  const panelFor = (d: Detent) => (d === 'full' ? roomFree : Math.max(PANEL_MIN, Math.round(roomFree * HALF_RATIO)))
  const target = Math.min(panelFor(detent), roomNow)

  const panelH = useRef(new Animated.Value(target)).current
  const panelNow = useRef(target)
  const pull = useRef(new Animated.Value(0)).current   // 往下拉出的位移（收起前跟手）
  const appear = useRef(new Animated.Value(0)).current // 0 = 收起，1 = 打开
  const dragging = useRef(false)
  const dragStart = useRef(target)

  useEffect(() => {
    const id = panelH.addListener(({ value }) => { panelNow.current = value })
    return () => panelH.removeListener(id)
  }, [panelH])

  // 拖动的回调在首帧创建，要读的值都走 ref
  const live = useRef({ roomNow, panelFor, onClose })
  live.current = { roomNow, panelFor, onClose }

  const springTo = useCallback((height: number) => {
    Animated.parallel([
      Animated.spring(panelH, { toValue: height, useNativeDriver: false, ...SPRING }),
      Animated.spring(pull, { toValue: 0, useNativeDriver: false, ...SPRING }),
    ]).start()
  }, [panelH, pull])

  const chooseDetent = useCallback((d: Detent) => {
    if (d !== rememberedDetent) solevupSetPref(DETENT_PREF, d).catch(() => {})
    rememberedDetent = d
    setDetent(d)
  }, [])

  const dragPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 5 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        dragging.current = true
        panelH.stopAnimation()
        pull.stopAnimation()
        dragStart.current = panelNow.current
      },
      onPanResponderMove: (_e, g) => {
        const { roomNow: max } = live.current
        const raw = dragStart.current - g.dy // 往上拖 dy<0 → 变高
        if (raw > max) {
          // 顶到头了：阻尼着多给一点，松手弹回
          panelH.setValue(max + Math.min(28, (raw - max) * 0.2))
          pull.setValue(0)
        } else if (raw < PANEL_MIN) {
          // 比最矮还矮：整个面板跟着手往下走，准备收起
          panelH.setValue(PANEL_MIN)
          pull.setValue(PANEL_MIN - raw)
        } else {
          panelH.setValue(raw)
          pull.setValue(0)
        }
      },
      onPanResponderRelease: (_e, g) => {
        dragging.current = false
        const { roomNow: max, panelFor: heightOf, onClose: close } = live.current
        const raw = dragStart.current - g.dy
        const half = Math.min(heightOf('half'), max)
        const full = Math.min(heightOf('full'), max)
        if (PANEL_MIN - raw > DISMISS_PULL || (g.vy > DISMISS_VELOCITY && raw < half)) {
          close()
          return
        }
        const projected = raw - g.vy * PROJECT_MS
        const d: Detent = full - half < 24 || projected > (half + full) / 2 ? 'full' : 'half'
        chooseDetent(d)
        springTo(d === 'full' ? full : half)
      },
      onPanResponderTerminate: () => {
        dragging.current = false
        springTo(Math.min(live.current.panelFor(rememberedDetent), live.current.roomNow))
      },
    }),
  ).current

  // ── 打开 / 收起的过渡；收起动画放完才卸载 ──
  const [rendered, setRendered] = useState(visible)
  useEffect(() => {
    if (visible) {
      setRendered(true)
      panelH.stopAnimation()
      panelH.setValue(target)
      pull.setValue(0)
      Animated.spring(appear, { toValue: 1, useNativeDriver: true, damping: 22, stiffness: 240, mass: 0.8 }).start()
    } else {
      Animated.timing(appear, { toValue: 0, duration: 170, easing: Easing.in(Easing.quad), useNativeDriver: true })
        .start(({ finished }) => { if (finished) setRendered(false) })
    }
    // 只跟着开关走；打开那一刻的 target 直接用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // 档位、键盘、屏幕高度变了：弹到新高度（拖动中不动）
  useEffect(() => {
    if (!visible || dragging.current) return
    springTo(target)
  }, [target, visible, springTo])

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

  const sheetMotion = {
    opacity: appear,
    transform: [
      { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) },
      { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
    ],
  }

  return (
    <>
      {rendered && (
        <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'box-none' : 'none'}>
          {/* 灰色蒙版：点击面板外部即收起 */}
          <Animated.View style={[styles.mask, { opacity: appear }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
          </Animated.View>

          <Animated.View style={[styles.wrap, { bottom }, sheetMotion]} pointerEvents="box-none">
            <Animated.View style={[styles.dock, { height: panelH, transform: [{ translateY: pull }] }]}>
              <View style={styles.tail} />
              <View style={styles.dragHandle} {...dragPan.panHandlers}>
                <View style={styles.grabber} />
              </View>
              <FairyChatPanel
                style={styles.chatFill}
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
                headerPanHandlers={dragPan.panHandlers}
                gutter={0}
                placeholder="继续问…"
                onVoicePressIn={onVoicePressIn}
                onVoicePressOut={onVoicePressOut}
                recording={recording}
                recordMs={recordMs}
              />
            </Animated.View>
          </Animated.View>

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
    // 打开时从气泡尖那里放大出来
    transformOrigin: 'center bottom',
  },
  dock: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingTop: 0,
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
  // 把手区域放宽，好抓
  dragHandle: {
    marginHorizontal: -14,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 6,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: theme.line,
  },
  chatFill: { flex: 1 },
})
