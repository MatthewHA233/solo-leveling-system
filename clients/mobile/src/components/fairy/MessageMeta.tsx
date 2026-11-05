// ══════════════════════════════════════════════
// 消息元信息：呼号 · 时刻（对应 desktop ChatPanel MsgMeta / MetaIconBtn）
// 调试键常驻显示（桌面端同样常驻）；Tooltip 换成长按 Toast + 无障碍标签
// ══════════════════════════════════════════════

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import { displayCallsign, fmtClock } from './fairy-format'
import { showTip } from './tip'

export function MsgMeta({ label, ts, align, fairy = false, actions }: {
  label: string
  ts: number | string
  align: 'left' | 'right'
  fairy?: boolean
  actions?: React.ReactNode
}) {
  return (
    <View style={[styles.row, align === 'right' && styles.rowRight]}>
      {fairy ? (
        <Text style={styles.fairy}>{displayCallsign(label)}</Text>
      ) : (
        <Text style={styles.user}>{label}</Text>
      )}
      <Text style={styles.clock}>{fmtClock(ts)}</Text>
      {actions}
    </View>
  )
}

/** 元信息行里的小动作按钮（debug 等） */
export function MetaIconBtn({ tip, onPress, children }: {
  tip: string
  onPress: () => void
  children: React.ReactNode
}) {
  return (
    <Pressable
      style={styles.iconBtn}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={tip}
      onPress={onPress}
      onLongPress={() => showTip(tip)}
    >
      {children}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 },
  rowRight: { justifyContent: 'flex-end' },
  fairy: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, color: theme.accent },
  user: { fontSize: 11, color: theme.inkSoft },
  clock: { fontSize: 11, color: theme.inkFaint, fontVariant: ['tabular-nums'] },
  iconBtn: { padding: 2, alignItems: 'center', justifyContent: 'center' },
})
