// ══════════════════════════════════════════════
// 输入坞（对应 desktop ChatPanel 输入坞）：模式 / 模型 chip + 输入框 + 发送
//
// 和桌面端的差异：
//   · Enter 换行、发送走按钮（手机键盘回车就是换行；桌面端 Enter 发送、Shift+Enter 换行）
//   · 进面板不自动弹键盘（桌面端自动聚焦），需要时传 autoFocus
//   · 模型下拉换成现成的 QuickModelSheet；chip 上直接带额度小环
//   · 右 Alt 提示换成「按住说话」：没有文字时发送键变麦克风（沿用 ChatScreen 的交互），是否提供由调用方决定
//   · 图片附件是手机端已有功能，桌面端聊天没有，保留
//   · 处理中也能发送：再发送就打断上一轮（chat-send）。桌面端处理中发不出去，只能按右 Alt 打断
// 麦克风处理中也能按，按下就打断回复（对应桌面端右 Alt）
// ══════════════════════════════════════════════

import { useCallback, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { alpha, theme } from '../../theme'
import type { ChatImageAttachment } from '../../types'
import QuickModelSheet, { quotaRingColor } from '../QuickModelSheet'
import { IconMessage, IconRadio } from './icons'
import { PendingImagesBar } from './ImageAttachments'
import { showTip } from './tip'
import { useFairyModelPicker } from './useFairyModelPicker'

const INPUT_MAX_HEIGHT = 110

function QuotaRing({ percent }: { percent: number }) {
  const pct = Math.max(0, Math.min(100, percent))
  const visible = pct >= 100 ? 100 : Math.min(pct, 94)
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <Svg width={14} height={14} viewBox="0 0 14 14" accessibilityLabel={`免费额度剩余 ${Math.round(pct)}%`}>
      <Circle cx={7} cy={7} r={r} fill="none" stroke={alpha(theme.ink, 0.12)} strokeWidth={2.4} />
      <Circle
        cx={7}
        cy={7}
        r={r}
        fill="none"
        stroke={quotaRingColor(pct)}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeDasharray={`${c} ${c}`}
        strokeDashoffset={c * (1 - visible / 100)}
        transform="rotate(-90 7 7)"
      />
    </Svg>
  )
}

function MicIcon({ color }: { color: string }) {
  return (
    <View style={styles.mic}>
      <View style={[styles.micCapsule, { backgroundColor: color }]} />
      <View style={[styles.micArc, { borderColor: color }]} />
      <View style={[styles.micStem, { backgroundColor: color }]} />
    </View>
  )
}

export interface FairyInputDockProps {
  readonly isProcessing: boolean
  readonly onSend: (text: string) => void
  readonly aiMode: 'regular' | 'omni'
  readonly onToggleAiMode?: () => void
  readonly onOpenModelCenter?: () => void
  readonly placeholder?: string
  readonly autoFocus?: boolean
  readonly gutter?: number
  /** 待发图片（状态在调用方，发送后由调用方清空） */
  readonly pendingImages?: readonly ChatImageAttachment[]
  readonly onPressAttach?: () => void
  readonly onRemoveImage?: (image: ChatImageAttachment) => void
  /** 提供了才显示「按住说话」键 */
  readonly onVoicePressIn?: () => void
  readonly onVoicePressOut?: () => void
  readonly recording?: boolean
}

export default function FairyInputDock({
  isProcessing,
  onSend,
  aiMode,
  onToggleAiMode,
  onOpenModelCenter,
  placeholder = '说点什么……',
  autoFocus = false,
  gutter = 14,
  pendingImages = [],
  onPressAttach,
  onRemoveImage,
  onVoicePressIn,
  onVoicePressOut,
  recording = false,
}: FairyInputDockProps) {
  const [input, setInput] = useState('')
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const picker = useFairyModelPicker(aiMode)
  const isOmniMode = aiMode === 'omni'

  const hasContent = input.trim().length > 0 || pendingImages.length > 0
  const canSend = hasContent
  const showMic = !hasContent && !!onVoicePressIn

  const refuseImages = useCallback(() => {
    showTip(`${picker.chatModelLabel} 看不了图片，先换一个能看图的模型`)
  }, [picker.chatModelLabel])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed && pendingImages.length === 0) return
    // 选完图又换了模型：图和字都留着，换回来还能发
    if (pendingImages.length > 0 && !picker.chatModelSeesImages) {
      refuseImages()
      return
    }
    onSend(trimmed)
    setInput('')
  }, [input, pendingImages.length, onSend, picker.chatModelSeesImages, refuseImages])

  const handleAttach = useCallback(() => {
    if (picker.chatModelSeesImages) onPressAttach?.()
    else refuseImages()
  }, [picker.chatModelSeesImages, onPressAttach, refuseImages])

  const openModelSheet = useCallback(() => {
    picker.refreshQuotas()
    setModelSheetOpen(true)
  }, [picker])

  const modeTip = isOmniMode
    ? '当前：实时语音（实验）——说话交给独立的小模型，打字仍走常规模型。点击切回级联语音'
    : '当前：级联语音（推荐）——说话和打字都是同一个 Fairy。点击切换实时语音（实验）'
  const modelTip = isOmniMode ? 'Fairy 实时语音模型（实验，只管语音）' : 'Fairy 聊天模型（打字和语音共用）'

  return (
    <View style={[styles.dock, { paddingHorizontal: gutter }]}>
      <View style={styles.chips}>
        {onToggleAiMode && (
          <Pressable
            style={[styles.chip, isOmniMode && styles.chipOn, isProcessing && styles.disabled]}
            disabled={isProcessing}
            accessibilityRole="button"
            accessibilityLabel={modeTip}
            onPress={onToggleAiMode}
            onLongPress={() => showTip(modeTip)}
          >
            {isOmniMode ? <IconRadio size={13} color={theme.accent} /> : <IconMessage size={13} color={theme.inkSoft} />}
            <Text style={[styles.chipText, isOmniMode && styles.chipTextOn]}>{isOmniMode ? '实时语音' : '级联语音'}</Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.chip, styles.chipModel, isProcessing && styles.disabled]}
          disabled={isProcessing}
          accessibilityRole="button"
          accessibilityLabel={modelTip}
          onPress={openModelSheet}
          onLongPress={() => showTip(modelTip)}
        >
          <Text style={styles.chipText} numberOfLines={1}>{picker.currentLabel}</Text>
          {picker.currentMeter !== undefined && <QuotaRing percent={picker.currentMeter} />}
        </Pressable>
      </View>

      {onRemoveImage && <PendingImagesBar images={pendingImages} onRemove={onRemoveImage} />}

      <View style={styles.inputRow}>
        {onPressAttach && (
          <Pressable
            style={styles.roundKey}
            disabled={isProcessing}
            accessibilityRole="button"
            accessibilityLabel="添加图片"
            onPress={handleAttach}
          >
            <Text style={styles.plus}>＋</Text>
          </Pressable>
        )}
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={placeholder}
          placeholderTextColor={theme.inkFaint}
          multiline
          autoFocus={autoFocus}
          textAlignVertical="center"
        />
        {showMic ? (
          <Pressable
            style={[styles.roundKey, recording && styles.micOn]}
            accessibilityRole="button"
            accessibilityLabel="按住说话"
            onPressIn={onVoicePressIn}
            onPressOut={onVoicePressOut}
          >
            <MicIcon color={recording ? '#FFFFFF' : theme.inkSoft} />
          </Pressable>
        ) : (
          <Pressable
            style={[styles.send, !canSend && styles.disabled]}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="发送"
            onPress={handleSend}
          >
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
        )}
      </View>

      <QuickModelSheet
        visible={modelSheetOpen}
        feature={picker.currentFeature}
        currentModel={picker.currentModel}
        onClose={() => setModelSheetOpen(false)}
        onPicked={picker.setPicked}
        onOpenCenter={() => onOpenModelCenter?.()}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  dock: { paddingTop: 8, paddingBottom: 10 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 13, backgroundColor: theme.sunk,
  },
  chipOn: { backgroundColor: theme.accentSoft },
  chipModel: { flexShrink: 1 },
  chipText: { flexShrink: 1, fontSize: 12, color: theme.inkSoft, fontWeight: '500' },
  chipTextOn: { color: theme.accent },
  disabled: { opacity: 0.4 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1, minHeight: 36, maxHeight: INPUT_MAX_HEIGHT,
    paddingHorizontal: 13, paddingTop: 8, paddingBottom: 8, borderRadius: 18,
    backgroundColor: theme.sunk, fontSize: 14, lineHeight: 20, color: theme.ink,
  },
  roundKey: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: theme.sunk,
    alignItems: 'center', justifyContent: 'center',
  },
  micOn: { backgroundColor: theme.accent },
  plus: { fontSize: 19, lineHeight: 22, color: theme.inkSoft },
  send: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: theme.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  sendText: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
  mic: { alignItems: 'center' },
  micCapsule: { width: 9, height: 12, borderRadius: 4.5 },
  micArc: {
    width: 15, height: 7, borderWidth: 1.6, borderTopWidth: 0,
    borderBottomLeftRadius: 8, borderBottomRightRadius: 8, marginTop: -3.5,
  },
  micStem: { width: 1.6, height: 3, marginTop: 0.5 },
})
