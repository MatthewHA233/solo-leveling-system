// ══════════════════════════════════════════════
// AgentPanel — 暗影体悬浮对话气泡（矮 ⇄ 高 自身原地延展）
// 一套内容：head + 消息流 + 输入行。「展开」只是消息区窗口
// 向上长高（maxHeight 插值），底部位置/输入行/气泡尖完全不动。
// 消息流始终渲染全部历史并贴底，窗口变大自然露出更早的消息。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { theme, alpha } from '../theme'
import { useChatController } from '../lib/agent/use-chat-controller'
import { useStableKeyboardInset } from '../lib/use-keyboard-inset'
import { getModelDef } from '../lib/models/registry'
import { solevupGetFeatureBinding } from '../lib/solevupdb'
import type { AiMode } from '../types'
import FairyStateIndicator from './FairyStateIndicator'
import QuickModelSheet from './QuickModelSheet'
import ModelCenter from './ModelCenter'

interface Props {
  readonly visible: boolean
  readonly onClose: () => void
}

const BODY_MIN = 120
const BODY_INIT = 180

export default function AgentPanel({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets()
  const { height: H } = useWindowDimensions()
  const ctrl = useChatController()
  const [input, setInput] = useState('')
  const keyboardInset = useStableKeyboardInset(visible)
  const scrollRef = useRef<ScrollView>(null)

  // ── 顶部拖拽调高（bottom sheet 式）：bodyH 直接驱动消息区高度 ──
  const bodyH = useRef(new Animated.Value(BODY_INIT)).current
  const bodyHNow = useRef(BODY_INIT)
  const dragStartH = useRef(BODY_INIT)
  const bodyMaxRef = useRef(400)
  const dragPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
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

  // ── 对话模式 + 模型绑定（与聊天页/desktop 顶栏同方案） ──
  const [aiMode, setAiMode] = useState<AiMode>('omni')
  const [boundModels, setBoundModels] = useState<{ fairy_chat: string; fairy_omni_chat: string }>({
    fairy_chat: 'qwen3.6-flash',
    fairy_omni_chat: 'qwen3.5-omni-flash-realtime',
  })
  const [quickModelOpen, setQuickModelOpen] = useState(false)
  const [modelCenterOpen, setModelCenterOpen] = useState(false)

  useEffect(() => {
    if (!visible) return
    void Promise.all([
      solevupGetFeatureBinding('fairy_chat').catch(() => null),
      solevupGetFeatureBinding('fairy_omni_chat').catch(() => null),
    ]).then(([chat, omni]) => {
      setBoundModels((prev) => ({
        fairy_chat: chat || prev.fairy_chat,
        fairy_omni_chat: omni || prev.fairy_omni_chat,
      }))
    })
  }, [visible])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || ctrl.isProcessing) return
    setInput('')
    void ctrl.sendText(text)
  }, [input, ctrl])

  if (!visible) return null

  const msgs = ctrl.messages
  const boundModelId = aiMode === 'omni' ? boundModels.fairy_omni_chat : boundModels.fairy_chat
  const bottom = keyboardInset > 0 ? keyboardInset + 8 : 104
  // 拖拽上限：顶部留出安全区 + 一口呼吸，底部结构（head/输入行/padding ~110）不动
  bodyMaxRef.current = Math.max(BODY_INIT, H - insets.top - 44 - bottom - 110)

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* 灰色蒙版：点击面板外部即收起 */}
      <Pressable style={styles.mask} onPress={onClose} />

      <View style={[styles.wrap, { bottom }]} pointerEvents="box-none">
        <View style={styles.dock}>
          <View style={styles.tail} />
          {/* 顶部拖拽柄：grabber + 标题行，上下拖动调高 */}
          <View style={styles.dragHandle} {...dragPan.panHandlers}>
            <View style={styles.grabber} />
            <View style={styles.head}>
              <View style={styles.titleRow}>
                <Text style={styles.title}>暗影体</Text>
                {ctrl.isProcessing && (
                  <FairyStateIndicator
                    state={msgs[msgs.length - 1]?.streaming && msgs[msgs.length - 1]?.content ? 'speaking' : 'thinking'}
                    color={theme.accent}
                    scale={0.55}
                  />
                )}
              </View>
            </View>
          </View>

          {/* 模式 + 模型 chips（desktop 顶栏同款） */}
          <View style={styles.chipsRow}>
            <Pressable
              style={styles.chip}
              disabled={ctrl.isProcessing}
              onPress={() => setAiMode((m) => (m === 'omni' ? 'regular' : 'omni'))}
            >
              <Text style={styles.chipText}>{aiMode === 'omni' ? 'Omni 全模态' : '普通对话'}</Text>
            </Pressable>
            <Pressable style={[styles.chip, styles.chipShrink]} onPress={() => setQuickModelOpen(true)}>
              <Text style={styles.chipText} numberOfLines={1}>
                {getModelDef(boundModelId)?.display_name ?? boundModelId}
              </Text>
            </Pressable>
          </View>

          <Animated.View style={{ height: bodyH }}>
            <ScrollView
              ref={scrollRef}
              contentContainerStyle={{ paddingBottom: 4 }}
              onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
              {msgs.map((m) => {
                if (m.role === 'system') {
                  return <Text key={m.id} style={styles.sysText}>{m.content}</Text>
                }
                const isUser = m.role === 'user'
                const text = m.content || m.audio?.transcript || (m.audio ? '[语音]' : '')
                return (
                  <View key={m.id} style={[styles.line, isUser && styles.lineUser]}>
                    <Text style={[styles.lineText, isUser && styles.lineTextUser]}>
                      {text}{m.streaming && !m.content ? '…' : ''}
                    </Text>
                  </View>
                )
              })}
            </ScrollView>
          </Animated.View>

          <View style={styles.inputRow}>
            <Pressable style={styles.plusBtn}>
              <Text style={styles.plusText}>＋</Text>
            </Pressable>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="继续问…"
              placeholderTextColor={theme.inkFaint}
              onSubmitEditing={send}
              returnKeyType="send"
            />
            <Pressable
              style={[styles.sendBtn, (!input.trim() || ctrl.isProcessing) && { opacity: 0.4 }]}
              disabled={!input.trim() || ctrl.isProcessing}
              onPress={send}
            >
              <Text style={styles.sendText}>↑</Text>
            </Pressable>
          </View>
        </View>
      </View>

      <QuickModelSheet
        visible={quickModelOpen}
        feature={aiMode === 'omni' ? 'fairy_omni_chat' : 'fairy_chat'}
        currentModel={boundModelId}
        onClose={() => setQuickModelOpen(false)}
        onPicked={(id) => {
          setBoundModels((prev) =>
            aiMode === 'omni' ? { ...prev, fairy_omni_chat: id } : { ...prev, fairy_chat: id },
          )
        }}
        onOpenCenter={() => setModelCenterOpen(true)}
      />
      <ModelCenter
        visible={modelCenterOpen}
        config={ctrl.config}
        onClose={() => setModelCenterOpen(false)}
        onSaveConfig={(updates) => ctrl.updateConfig(updates)}
      />
    </View>
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
    paddingBottom: 10,
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
    marginBottom: 6,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  title: { fontSize: 12, fontWeight: '700', color: theme.inkSoft },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chipsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: theme.accentSoft,
  },
  chipShrink: { flexShrink: 1 },
  chipText: { fontSize: 12, color: theme.accent, fontWeight: '500' },
  line: {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    backgroundColor: theme.sunk,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 6,
  },
  lineUser: {
    alignSelf: 'flex-end',
    backgroundColor: alpha(theme.accent, 0.1),
  },
  lineText: { fontSize: 13, color: theme.ink, lineHeight: 19 },
  lineTextUser: { color: theme.accent },
  sysText: { fontSize: 11, color: theme.inkFaint, textAlign: 'center', marginBottom: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  plusBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.sunk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: { fontSize: 19, color: theme.inkSoft, lineHeight: 22 },
  input: {
    flex: 1,
    backgroundColor: theme.sunk,
    borderRadius: 18,
    paddingHorizontal: 13,
    paddingVertical: 8,
    fontSize: 13,
    color: theme.ink,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
})
