// ══════════════════════════════════════════════
// VoiceGestureOverlay — 全局按住说话手势浮层（微信「按住说话」式布局）
// 中央按钮长按触发；原位松手 = 发送，上滑到取消钮带 = 取消
// 底部大弧形录音面板（声波 + 计时），取消钮悬在面板上方拇指可达处
// ══════════════════════════════════════════════

import { StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import FairyStateIndicator from './FairyStateIndicator'

export type VoiceZone = 'send' | 'cancel'

interface Props {
  readonly visible: boolean
  readonly zone: VoiceZone
  readonly recordMs: number
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function VoiceGestureOverlay({ visible, zone, recordMs }: Props) {
  const { width: W } = useWindowDimensions()
  if (!visible) return null

  const cancelOn = zone === 'cancel'
  // 弧形面板：超宽圆角矩形伸出屏幕底，只露出顶部一段弧
  const arcW = W * 1.5
  const arcH = 300
  const arcVisible = 132

  return (
    <View style={styles.root} pointerEvents="none">
      {/* 提示文字（取消钮上方） */}
      <Text style={[styles.hint, cancelOn && styles.hintCancel]}>
        {cancelOn ? '松开 取消' : '松开 发送 · 上滑 取消'}
      </Text>

      {/* 取消钮：屏幕中下部居中，拇指上滑可达 */}
      <View style={[styles.cancelBtn, cancelOn && styles.cancelBtnOn]}>
        <Text style={[styles.cancelIcon, cancelOn && styles.cancelIconOn]}>×</Text>
      </View>

      {/* 底部弧形录音面板 */}
      <View
        style={[
          styles.arc,
          {
            width: arcW,
            height: arcH,
            left: (W - arcW) / 2,
            bottom: arcVisible - arcH,
            borderTopLeftRadius: arcW / 2,
            borderTopRightRadius: arcW / 2,
          },
          cancelOn && styles.arcCancel,
        ]}
      >
        <View style={styles.arcInner}>
          {cancelOn ? (
            <Text style={styles.arcCancelText}>松开手指取消发送</Text>
          ) : (
            <>
              <FairyStateIndicator state="listening" scale={0.75} />
              <Text style={styles.time}>{fmtMs(recordMs)}</Text>
            </>
          )}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 90,
    backgroundColor: 'rgba(10, 12, 18, 0.55)',
  },
  hint: {
    position: 'absolute',
    bottom: '41%',
    alignSelf: 'center',
    fontSize: 13,
    color: 'rgba(255,255,255,0.65)',
  },
  hintCancel: { color: 'rgba(255,120,120,0.95)' },
  cancelBtn: {
    position: 'absolute',
    bottom: '30%',
    alignSelf: 'center',
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnOn: {
    backgroundColor: '#E5484D',
    transform: [{ scale: 1.18 }],
  },
  cancelIcon: { fontSize: 30, color: 'rgba(255,255,255,0.85)', fontWeight: '600', lineHeight: 34 },
  cancelIconOn: { color: '#FFFFFF' },
  arc: {
    position: 'absolute',
    backgroundColor: 'rgb(13, 30, 64)',
    borderWidth: 1.5,
    borderColor: 'rgba(80, 200, 255, 0.35)',
    alignItems: 'center',
  },
  arcCancel: {
    backgroundColor: 'rgb(36, 18, 24)',
    borderColor: 'rgba(255, 110, 110, 0.35)',
  },
  arcInner: {
    marginTop: 34,
    alignItems: 'center',
    gap: 10,
  },
  time: { fontSize: 16, fontWeight: '700', color: 'rgba(160, 215, 255, 0.95)', fontVariant: ['tabular-nums'] },
  arcCancelText: { marginTop: 14, fontSize: 13, color: 'rgba(255, 150, 150, 0.85)' },
})
