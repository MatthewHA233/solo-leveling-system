// ══════════════════════════════════════════════
// 输入坞上方的两条提示（对应 desktop ChatPanel ListeningBar / 注视提示条）
// ══════════════════════════════════════════════

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import { IconClose, IconEye } from './icons'
import { LISTEN_BARS, fmtSec, gazeLabel, ledHeight } from './fairy-format'
import { showTip } from './tip'
import { useVoiceLevels } from './useVoiceLevels'
import type { FairyGazeTarget } from './types'

/**
 * 正在听：随主人声音跳动的音量柱（音量来自 voice://level）。
 * recordMs：调用方有录音计时就显示（桌面端没有，手机按住说话时要看得到时长）
 */
export function ListeningBar({ recordMs, gutter = 14 }: { recordMs?: number; gutter?: number }) {
  const levels = useVoiceLevels(true, LISTEN_BARS)
  return (
    <View style={[styles.bar, { marginHorizontal: gutter }]}>
      <View style={styles.dot} />
      <Text style={styles.listening}>正在听</Text>
      <View style={styles.levels}>
        {levels.map((v, i) => (
          <View key={i} style={[styles.level, { height: ledHeight(v, 6), opacity: 0.45 + v * 0.55 }]} />
        ))}
      </View>
      {recordMs != null && <Text style={styles.clock}>{fmtSec(recordMs / 1000)}</Text>}
      <Text style={styles.hint}>松开发送</Text>
    </View>
  )
}

/** 注视提示条：Fairy 正注视主人锁定的卡片 */
export function GazeBar({ target, onClear, gutter = 14 }: {
  target: FairyGazeTarget
  /** 桌面端是广播 solevup:card-focus clear；手机端由调用方清状态 */
  onClear?: () => void
  gutter?: number
}) {
  return (
    <View style={[styles.bar, styles.gaze, { marginHorizontal: gutter }]}>
      <IconEye size={13} color={theme.accent} />
      <Text style={styles.gazeLabel}>注视</Text>
      <Text style={styles.gazeText} numberOfLines={1}>{gazeLabel(target.kind, target.title, target.text)}</Text>
      {onClear && (
        <Pressable
          style={styles.gazeClose}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="取消注视"
          onPress={onClear}
          onLongPress={() => showTip('取消注视')}
        >
          <IconClose size={12} color={theme.inkSoft} />
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginBottom: 8, paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: 8, backgroundColor: theme.sunk,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.accent },
  listening: { fontSize: 12, color: theme.accent },
  levels: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 18 },
  level: { flex: 1, borderRadius: 1, backgroundColor: theme.accent },
  clock: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  hint: { fontSize: 11, color: theme.inkFaint },
  gaze: { gap: 8, paddingVertical: 5, paddingRight: 6 },
  gazeLabel: { fontSize: 12, color: theme.accent },
  gazeText: { flex: 1, minWidth: 0, fontSize: 12, color: theme.inkSoft },
  gazeClose: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
})
