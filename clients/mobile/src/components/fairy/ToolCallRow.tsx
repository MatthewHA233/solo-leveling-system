// ══════════════════════════════════════════════
// 聊天里的一次工具调用（对应 desktop components/ToolCallRow.tsx）：
// 一行灰色小字，状态点 + 工具的中文名 + 参数摘要 + 耗时；点开看参数和结果，各自能复制，也能整次一起复制；
// 函数名在点开后的左下角。
// 状态点：运行中蓝色闪烁，跑完变绿，没跑成变红。
// 数据和文字规则在 lib/agent/tool-call-view.ts（两端共用）
//
// 和桌面端的差异：
//   · 复制走系统剪贴板的原生桥，成功后弹 Toast（桌面端按钮上直接变成「已复制」）
//   · 长按整行弹消息菜单，菜单里的「复制」复制整次调用
//   · 不画成卡片：没有底色和内边距，像正文里的一行注记；点开的内容挂在左边一条细竖线下面。
//     连续几次调用紧挨着排（间距在 FairyMessageList）
//
//   · 参数和结果直接铺开，长的先显示前一段、点「展开全部」看完（桌面端是限高可滚的框；
//     手机列表里再套竖向滚动框，手指滑的是小框，聊天列表就滚不动了）
//
// 上下文整理留的行也画成同样的一行（文字规则在 tool-call-view.ts 末尾）：
//   · CompactRow：分界处的压缩提示，点开看摘要、能复制
//   · ContextRow：当时在底部加的一行。清理工具结果点开看清了哪些；整理上下文点它跳到分界那条
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import { fonts, theme } from '../../theme'
import {
  approxCount,
  clearedToolGroups,
  COMPACT_ROW_LABEL,
  COMPACT_ROW_NOTE,
  compactRowSummary,
  contextEventLabel,
  contextEventNote,
  contextEventSize,
  contextEventSummary,
  formatToolDuration,
  prettyToolArgs,
  toolArgsSummary,
  toolCallCopyText,
  toolCallStatus,
  toolLabel,
  type ContextEventView,
  type ToolCallStatus,
  type ToolCallView,
} from '../../lib/agent/tool-call-view'
import { solevupCopyText } from '../../lib/solevupdb'
import { charLabel } from './fairy-format'
import { IconChevronDown, IconChevronRight, IconChevronUp, IconCopy } from './icons'
import { showTip } from './tip'

const LONG_PRESS_MS = 350
/** 参数、结果点开后先显示这么多字 */
const PREVIEW_CHARS = 800

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
      <IconCopy size={11} color={theme.inkFaint} />
      <Text style={styles.copyText}>{label}</Text>
    </Pressable>
  )
}

function Section({ title, text, prose = false }: { title: string; text: string; prose?: boolean }) {
  const [full, setFull] = useState(false)
  const long = text.length > PREVIEW_CHARS
  return (
    <View>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <CopyButton text={text} label="复制" />
      </View>
      <View style={styles.well}>
        <Text style={prose ? styles.prose : styles.code}>{long && !full ? `${text.slice(0, PREVIEW_CHARS)}…` : text}</Text>
        {long && (
          <Pressable hitSlop={8} accessibilityRole="button" onPress={() => setFull(!full)}>
            <Text style={styles.more}>{full ? '收起' : `展开全部 · ${charLabel(text.length)} 字`}</Text>
          </Pressable>
        )}
      </View>
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
  const Chevron = expanded ? IconChevronDown : IconChevronRight

  return (
    <View>
      <Pressable
        style={styles.row}
        hitSlop={{ top: 4, bottom: 4 }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        delayLongPress={LONG_PRESS_MS}
        onPress={() => setExpanded(!expanded)}
        onLongPress={onLongPress}
      >
        <StatusDot status={status} />
        <Text style={styles.name} numberOfLines={1}>{label}</Text>
        <Text style={styles.summary} numberOfLines={1}>{summary}</Text>
        {statusText ? (
          <Text style={[styles.status, status === 'failed' && styles.statusFailed, status === 'running' && styles.statusRunning]}>
            {statusText}
          </Text>
        ) : null}
        <Chevron size={12} color={theme.inkFaint} />
      </Pressable>
      {expanded && (
        <View style={styles.panel}>
          <Section title="参数" text={prettyToolArgs(call.arguments)} />
          {call.result !== undefined
            ? <Section title="结果" text={call.result} />
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

/** 压缩提示：和工具调用同一个样子。fallback = 模型没写成摘要，用的机械摘要 */
export function CompactRow({ summary, fallback, onLongPress }: {
  summary: string
  fallback: boolean
  onLongPress?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const Chevron = expanded ? IconChevronDown : IconChevronRight
  return (
    <View>
      <Pressable
        style={styles.row}
        hitSlop={{ top: 4, bottom: 4 }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        delayLongPress={LONG_PRESS_MS}
        onPress={() => setExpanded(!expanded)}
        onLongPress={onLongPress}
      >
        <View style={[styles.dot, { backgroundColor: fallback ? theme.danger : theme.inkFaint }]} />
        <Text style={styles.name} numberOfLines={1}>{COMPACT_ROW_LABEL}</Text>
        <Text style={styles.summary} numberOfLines={1}>{compactRowSummary(fallback)}</Text>
        <Text style={styles.status}>{approxCount(summary.length)} 字</Text>
        <Chevron size={12} color={theme.inkFaint} />
      </Pressable>
      {expanded && (
        <View style={styles.panel}>
          <Section title="摘要" text={summary} prose />
          <Text style={styles.sectionTitle}>{COMPACT_ROW_NOTE}</Text>
        </View>
      )}
    </View>
  )
}

/**
 * 上下文整理当时留的一行。清理工具结果：点开列出清了哪些；整理上下文：点它跳到分界那条（onJump 带分界的时间）。
 * 右边是上下文从多少降到多少（token）
 */
export function ContextRow({ event, onJump, onLongPress }: {
  event: ContextEventView
  onJump?: (timestamp: string) => void
  onLongPress?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const cleared = event.kind === 'cleared'
  // 正在写摘要：亮色，不能点开也没有可跳的地方
  const compacting = event.kind === 'compacting'
  const boundary = event.boundary
  const Icon = cleared ? (expanded ? IconChevronDown : IconChevronRight) : IconChevronUp
  return (
    <View>
      <Pressable
        style={styles.row}
        hitSlop={{ top: 4, bottom: 4 }}
        accessibilityRole="button"
        accessibilityState={cleared ? { expanded } : undefined}
        accessibilityHint={cleared ? undefined : contextEventNote(event)}
        delayLongPress={LONG_PRESS_MS}
        onPress={() => {
          if (cleared) setExpanded(!expanded)
          else if (boundary) onJump?.(boundary)
        }}
        onLongPress={onLongPress}
      >
        <View style={[styles.dot, { backgroundColor: compacting ? theme.accent : event.kind === 'fallback' ? theme.danger : theme.inkFaint }]} />
        <Text style={styles.name} numberOfLines={1}>{contextEventLabel(event)}</Text>
        <Text style={styles.summary} numberOfLines={1}>{contextEventSummary(event)}</Text>
        <Text style={[styles.status, compacting && styles.statusRunning]}>{contextEventSize(event)}</Text>
        {!compacting && <Icon size={12} color={theme.inkFaint} />}
      </Pressable>
      {cleared && expanded && (
        <View style={styles.panel}>
          <View style={styles.well}>
            {clearedToolGroups(event).map((g) => (
              <View key={g.label} style={styles.groupRow}>
                <Text style={styles.groupName} numberOfLines={1}>{g.count > 1 ? `${g.label} × ${g.count}` : g.label}</Text>
                <Text style={styles.groupChars}>{approxCount(g.chars)} 字</Text>
              </View>
            ))}
          </View>
          <Text style={styles.sectionTitle}>{contextEventNote(event)}</Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  name: { flexShrink: 0, maxWidth: '55%', fontSize: 12, fontWeight: '600', color: theme.inkSoft },
  summary: { flex: 1, minWidth: 0, fontSize: 12, color: theme.inkFaint },
  status: { fontSize: 11, color: theme.inkFaint, fontVariant: ['tabular-nums'] },
  statusRunning: { color: theme.accent },
  statusFailed: { color: theme.danger },
  // 点开的内容挂在状态点正下方的一条细竖线下
  panel: {
    marginLeft: 2.5, marginTop: 2, marginBottom: 2,
    paddingLeft: 10, gap: 6,
    borderLeftWidth: 1, borderLeftColor: theme.line,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  sectionTitle: { fontSize: 11, color: theme.inkFaint },
  well: { backgroundColor: theme.sunk, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, gap: 4 },
  more: { fontSize: 11, color: theme.accent },
  code: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, color: theme.inkSoft },
  prose: { fontSize: 12, lineHeight: 19, color: theme.inkSoft },
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  groupName: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 18, color: theme.inkSoft },
  groupChars: { fontSize: 11, color: theme.inkFaint, fontVariant: ['tabular-nums'] },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 1 },
  copyText: { fontSize: 11, color: theme.inkFaint },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  fnName: { flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: 10.5, color: theme.inkFaint },
})
