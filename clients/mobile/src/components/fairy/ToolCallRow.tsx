// ══════════════════════════════════════════════
// 聊天里的一次工具调用（对应 desktop components/ToolCallRow.tsx）：
// 一条浅灰的窄条，状态点 + 工具的中文名 + 参数摘要 + 耗时；点开看参数和结果，各自能复制，也能整次一起复制；
// 函数名在点开后的左下角。
// 状态点：运行中蓝色闪烁，跑完变绿，没跑成变红。
// 数据和文字规则在 lib/agent/tool-call-view.ts（两端共用）
//
// 和桌面端的差异：
//   · 复制走系统剪贴板的原生桥，成功后弹 Toast（桌面端按钮上直接变成「已复制」）
//   · 长按整行弹消息菜单，菜单里的「复制」复制整次调用
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { fonts, theme } from '../../theme'
import {
  formatToolDuration,
  prettyToolArgs,
  toolArgsSummary,
  toolCallCopyText,
  toolCallStatus,
  toolLabel,
  type ToolCallStatus,
  type ToolCallView,
} from '../../lib/agent/tool-call-view'
import { solevupCopyText } from '../../lib/solevupdb'
import { IconChevronDown, IconChevronUp, IconCopy, IconWrench } from './icons'
import { showTip } from './tip'

const LONG_PRESS_MS = 350

const STATUS_COLOR: Record<ToolCallStatus, string> = {
  running: theme.accent,
  done: '#3FA86A',
  failed: theme.danger,
}

function copy(text: string): void {
  solevupCopyText(text)
    .then((ok) => showTip(ok ? '已复制' : '复制失败'))
    .catch(() => showTip('复制失败'))
}

function StatusDot({ status }: { status: ToolCallStatus }) {
  const pulse = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (status !== 'running') {
      pulse.setValue(1)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 450, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 450, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [pulse, status])
  return <Animated.View style={[styles.dot, { backgroundColor: STATUS_COLOR[status], opacity: pulse }]} />
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Pressable style={styles.copyBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel={label} onPress={() => copy(text)}>
      <IconCopy size={12} color={theme.inkSoft} />
      <Text style={styles.copyText}>{label}</Text>
    </Pressable>
  )
}

function Section({ title, text, maxHeight }: { title: string; text: string; maxHeight: number }) {
  return (
    <View>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <CopyButton text={text} label="复制" />
      </View>
      <ScrollView style={[styles.well, { maxHeight }]} contentContainerStyle={styles.wellContent} nestedScrollEnabled>
        <Text style={styles.code}>{text}</Text>
      </ScrollView>
    </View>
  )
}

export default function ToolCallRow({ call, onLongPress }: {
  call: ToolCallView
  onLongPress?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const status = toolCallStatus(call)
  const summary = toolArgsSummary(call.arguments)
  const label = toolLabel(call.name)
  const statusText = status === 'running'
    ? '运行中'
    : status === 'failed'
      ? '失败'
      : call.durationMs !== undefined ? formatToolDuration(call.durationMs) : ''
  const Chevron = expanded ? IconChevronUp : IconChevronDown

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.row}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        delayLongPress={LONG_PRESS_MS}
        onPress={() => setExpanded(!expanded)}
        onLongPress={onLongPress}
      >
        <StatusDot status={status} />
        <IconWrench size={13} color={theme.inkSoft} />
        <Text style={styles.name} numberOfLines={1}>{label}</Text>
        <Text style={styles.summary} numberOfLines={1}>{summary}</Text>
        {statusText ? (
          <Text style={[styles.status, status === 'failed' && styles.statusFailed, status === 'running' && styles.statusRunning]}>
            {statusText}
          </Text>
        ) : null}
        <Chevron size={14} color={theme.inkFaint} />
      </Pressable>
      {expanded && (
        <View style={styles.panel}>
          <Section title="参数" text={prettyToolArgs(call.arguments)} maxHeight={160} />
          {call.result !== undefined
            ? <Section title="结果" text={call.result} maxHeight={240} />
            : <Text style={styles.sectionTitle}>还在运行，结果出来后显示在这里</Text>}
          <View style={styles.footer}>
            <Text style={styles.fnName} numberOfLines={1}>{label === call.name ? '' : call.name}</Text>
            <CopyButton text={toolCallCopyText(call)} label="复制全部" />
          </View>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.sunk, borderRadius: 10, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 8 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  name: { flexShrink: 0, maxWidth: '55%', fontSize: 12.5, fontWeight: '700', color: theme.ink },
  summary: { flex: 1, minWidth: 0, fontSize: 12, color: theme.inkSoft },
  status: { fontSize: 11, color: theme.inkFaint },
  statusRunning: { color: theme.accent },
  statusFailed: { color: theme.danger },
  panel: { gap: 10, paddingHorizontal: 10, paddingBottom: 10 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  sectionTitle: { fontSize: 11, color: theme.inkFaint },
  well: { backgroundColor: theme.surface, borderRadius: 8 },
  wellContent: { paddingHorizontal: 10, paddingVertical: 8 },
  code: { fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 17, color: theme.inkSoft },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 },
  copyText: { fontSize: 11, color: theme.inkSoft },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  fnName: { flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: 11, color: theme.inkFaint },
})
