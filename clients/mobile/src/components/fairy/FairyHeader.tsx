// ══════════════════════════════════════════════
// 面板头部 + 会话条（对应 desktop ChatPanel Header / 会话条 / Spine）
//
// 和桌面端的差异：
//   · 侧脊不搬：窄屏让不出 24px。它表达的状态并入这里的状态行
//     （待命一个圆点，思考 / 在听 / 说话用现成的 FairyStateIndicator；音量涨落由 ListeningBar 负责）
//   · 摄像头键不搬：桌面端 CAMERA_PRESENCE_ENABLED=false，手机也没有这个能力
//   · Tooltip 换成长按 Toast + 无障碍标签；上下文段码条可以直接点，且常驻显示百分比
//   · headerPanHandlers：头部同时是 AgentPanel 上下拖动调高的把手
// ══════════════════════════════════════════════

import { Pressable, StyleSheet, Text, View, type GestureResponderHandlers } from 'react-native'
import { alpha, theme } from '../../theme'
import FairyStateIndicator from '../FairyStateIndicator'
import { CONTEXT_SEGMENTS, STATE_LABEL, contextPercent, litSegments } from './fairy-format'
import { IconHistory, IconSettings, IconVolume, IconVolumeOff } from './icons'
import { showTip } from './tip'
import type { FairyState } from './types'

export function FairyHeader({ agentName, fairyState, contextRatio, ttsEnabled, onToggleTts, onOpenSettings, headerPanHandlers, gutter = 14 }: {
  agentName: string
  fairyState: FairyState
  contextRatio: number
  ttsEnabled?: boolean
  onToggleTts?: () => void
  onOpenSettings?: () => void
  headerPanHandlers?: GestureResponderHandlers
  gutter?: number
}) {
  const pct = contextPercent(contextRatio)
  const lit = litSegments(contextRatio, CONTEXT_SEGMENTS)
  const contextTip = `上下文占用 ${pct}%（满了会自动压缩较早的对话）`
  const ttsTip = ttsEnabled ? '打字时也朗读：开' : '打字时也朗读：关（语音提问总会语音回答）'
  return (
    <View style={[styles.header, { paddingHorizontal: gutter }]} {...headerPanHandlers}>
      <View style={styles.titleCol}>
        <Text style={styles.name} numberOfLines={1}>{agentName}</Text>
        <View style={styles.statusRow}>
          {fairyState === 'idle' ? (
            <View style={styles.idleDot} />
          ) : (
            <FairyStateIndicator state={fairyState} color={theme.accent} scale={0.45} />
          )}
          <Text style={styles.status}>{STATE_LABEL[fairyState]}</Text>
          <Text style={styles.sep}>·</Text>
          <Pressable
            style={styles.context}
            hitSlop={8}
            accessibilityLabel={contextTip}
            onPress={() => showTip(contextTip)}
          >
            <Text style={styles.status}>上下文</Text>
            <View style={styles.segments}>
              {Array.from({ length: CONTEXT_SEGMENTS }, (_, i) => (
                <View key={i} style={[styles.segment, i < lit && styles.segmentOn]} />
              ))}
            </View>
            <Text style={styles.percent}>{pct}%</Text>
          </Pressable>
        </View>
      </View>
      {onToggleTts && (
        <Pressable
          style={[styles.key, ttsEnabled && styles.keyOn]}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={ttsTip}
          accessibilityState={{ selected: !!ttsEnabled }}
          onPress={onToggleTts}
          onLongPress={() => showTip(ttsTip)}
        >
          {ttsEnabled ? <IconVolume size={15} color={theme.accent} /> : <IconVolumeOff size={15} color={theme.inkSoft} />}
        </Pressable>
      )}
      {onOpenSettings && (
        <Pressable
          style={styles.key}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Fairy 设置"
          onPress={onOpenSettings}
          onLongPress={() => showTip('Fairy 设置')}
        >
          <IconSettings size={15} color={theme.inkSoft} />
        </Pressable>
      )}
    </View>
  )
}

/** 会话条：历史键 + 当前会话标题，都能打开历史会话 */
export function SessionStrip({ sessionTitle, sessionsOpen, onOpenSessions, gutter = 14 }: {
  sessionTitle?: string
  sessionsOpen?: boolean
  onOpenSessions: () => void
  gutter?: number
}) {
  const historyTip = sessionsOpen ? '收起历史会话' : '历史会话'
  const stripTip = sessionsOpen ? '收起历史会话' : '打开历史会话'
  return (
    <View style={[styles.strip, { paddingHorizontal: gutter }]}>
      <Pressable
        style={[styles.key, styles.keySmall, sessionsOpen && styles.keyOn]}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={historyTip}
        onPress={onOpenSessions}
        onLongPress={() => showTip(historyTip)}
      >
        <IconHistory size={14} color={sessionsOpen ? theme.accent : theme.inkSoft} />
      </Pressable>
      <Pressable
        style={[styles.well, sessionsOpen && styles.wellOpen]}
        accessibilityRole="button"
        accessibilityLabel={stripTip}
        onPress={onOpenSessions}
        onLongPress={() => showTip(stripTip)}
      >
        <Text style={styles.wellLabel}>会话</Text>
        <Text style={styles.wellTitle} numberOfLines={1}>{sessionTitle?.trim() || '新会话'}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  titleCol: { flex: 1, minWidth: 0 },
  name: { fontSize: 18, fontWeight: '700', color: theme.ink },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  idleDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#3FA86A' },
  status: { fontSize: 11, color: theme.inkSoft },
  sep: { fontSize: 11, color: theme.inkFaint },
  context: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  segments: { flexDirection: 'row', gap: 1.5 },
  segment: { width: 2.5, height: 8, borderRadius: 1, backgroundColor: theme.line },
  segmentOn: { backgroundColor: theme.accent },
  percent: { fontSize: 11, color: theme.inkFaint, fontVariant: ['tabular-nums'] },
  key: {
    width: 30, height: 30, borderRadius: 8, backgroundColor: theme.sunk,
    alignItems: 'center', justifyContent: 'center',
  },
  keySmall: { width: 28, height: 28 },
  keyOn: { backgroundColor: alpha(theme.accent, 0.12) },
  strip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 10 },
  well: {
    flex: 1, minWidth: 0, height: 28, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, borderRadius: 8, backgroundColor: theme.sunk,
  },
  wellOpen: { backgroundColor: alpha(theme.accent, 0.12) },
  wellLabel: { fontSize: 10.5, color: theme.inkFaint, letterSpacing: 1.2 },
  wellTitle: { flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: '700', color: theme.ink },
})
