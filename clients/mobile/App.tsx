/**
 * Solevup — 手机端
 * 昼夜表 / 暗影体 / 洪流域 / 协议志 / 感知
 * 暗影体为全局智能体层：中央按钮短按 = 底部轻对话条（矮），dock「展开」= 聊天弹层（高）；
 * 长按 = 任意界面按住说话（上滑取消），松手发送后轻对话条浮出，不离开当前界面。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { StatusBar, StyleSheet, View, useWindowDimensions } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import TabBar from './src/components/TabBar'
import type { TabKey, VoiceGestureHandlers } from './src/components/TabBar'
import VoiceGestureOverlay, { type VoiceZone } from './src/components/VoiceGestureOverlay'
import AgentPanel from './src/components/AgentPanel'
import DayNightScreen from './src/screens/DayNightScreen'
import PerceptionScreen from './src/screens/PerceptionScreen'
import TorrentScreen from './src/screens/TorrentScreen'
import ProtocolScreen from './src/screens/ProtocolScreen'
import { theme } from './src/theme'
import { chatController } from './src/lib/agent/chat-controller'
import { useChatController } from './src/lib/agent/use-chat-controller'
import { ensureMicPermission } from './src/lib/omni'

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={theme.bg} />
      <AppContent />
    </SafeAreaProvider>
  )
}

function AppContent() {
  const insets = useSafeAreaInsets()
  const ctrl = useChatController()
  const { width: W, height: H } = useWindowDimensions()
  const [tab, setTab] = useState<TabKey>('daynight')

  // ── 全局语音手势状态 ──
  const [voiceActive, setVoiceActive] = useState(false)
  const [voiceZone, setVoiceZone] = useState<VoiceZone>('send')
  const [recordMs, setRecordMs] = useState(0)
  const [panelOpen, setPanelOpen] = useState(false)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordMsRef = useRef(0)
  const voiceStartedRef = useRef(false)
  const zoneRef = useRef<VoiceZone>('send')

  useEffect(() => {
    void chatController.init()
  }, [])

  const zoneAt = useCallback((_x: number, y: number): VoiceZone => {
    // 手指上滑离开底部带（取消钮 bottom 30% 起算）即进入取消
    return y < H * 0.72 ? 'cancel' : 'send'
  }, [H])

  const stopTimer = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
  }

  const voice: VoiceGestureHandlers = {
    onStart: () => {
      setVoiceActive(true)
      setVoiceZone('send')
      zoneRef.current = 'send'
      setRecordMs(0)
      recordMsRef.current = 0
      voiceStartedRef.current = false
      recordTimerRef.current = setInterval(() => {
        recordMsRef.current += 100
        setRecordMs(recordMsRef.current)
      }, 100)
      void (async () => {
        const ok = await ensureMicPermission()
        if (!ok) {
          chatController.pushSystemNote('未授予麦克风权限')
          return
        }
        try {
          await chatController.startVoice()
          voiceStartedRef.current = true
        } catch (e) {
          chatController.pushSystemNote(`语音启动失败：${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },
    onMove: (x, y) => {
      const z = zoneAt(x, y)
      if (z !== zoneRef.current) {
        zoneRef.current = z
        setVoiceZone(z)
      }
    },
    onEnd: (x, y) => {
      stopTimer()
      setVoiceActive(false)
      const z = zoneAt(x, y)
      const ms = recordMsRef.current
      setRecordMs(0)
      recordMsRef.current = 0
      if (!voiceStartedRef.current || z === 'cancel' || ms < 500) {
        chatController.cancelVoice()
        return
      }
      // 松手发送 → 浮出临时面板（已展开则面板本身就是完整界面）
      setPanelOpen(true)
      chatController.stopVoiceCommit(ms)
    },
    onCancel: () => {
      stopTimer()
      setVoiceActive(false)
      setRecordMs(0)
      recordMsRef.current = 0
      chatController.cancelVoice()
    },
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.body}>
        {tab === 'daynight' ? (
          <DayNightScreen />
        ) : tab === 'torrent' ? (
          <TorrentScreen />
        ) : tab === 'protocol' ? (
          <ProtocolScreen />
        ) : (
          <PerceptionScreen />
        )}
      </View>



      <View style={{ paddingBottom: insets.bottom, backgroundColor: theme.surface }}>
        <TabBar
          active={tab}
          onChange={(k) => { setPanelOpen(false); setTab(k) }}
          onCenterPress={() => setPanelOpen((v) => !v)}
          voice={voice}
          orbState={
            voiceActive
              ? 'listening'
              : ctrl.isProcessing
                ? (ctrl.messages[ctrl.messages.length - 1]?.streaming && ctrl.messages[ctrl.messages.length - 1]?.content
                    ? 'speaking'
                    : 'thinking')
                : 'idle'
          }
        />
      </View>

      {/* 暗影体临时面板：顶部拖拽调高，点击外部收起 */}
      <AgentPanel visible={panelOpen} onClose={() => setPanelOpen(false)} />

      {/* 按住说话手势浮层（最顶层） */}
      <VoiceGestureOverlay visible={voiceActive} zone={voiceZone} recordMs={recordMs} />
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  body: {
    flex: 1,
    backgroundColor: theme.bg,
  },
})

export default App
