// ══════════════════════════════════════════════
// 调试弹窗（对应 desktop DebugRequestModal.tsx + OmniDebugModal.tsx，手机端放一个文件）
//   · DebugRequestModal：每轮发给 AI 的完整 payload（快照来自 chat-controller 的 onRequestSnapshot）
//   · OmniDebugModal：发给 Omni 实时会话的上下文
//
// 和桌面端的差异：
//   · 配色走浅色主题
//   · 窄屏把头部信息折成两行，翻页键单独一行
//   · 时刻显示本地时间（桌面端已同步修正，原来 ISO 串直接截取拿到的是 UTC）
//   · Omni 语音没有 <audio controls>：点一下先落到 omni-debug 目录再用原生层播放
//   · 这里的文字可以长按选中复制（调试时要抄内容）
// ══════════════════════════════════════════════

import { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { alpha, fonts, theme } from '../../theme'
import type { ApiRequestSnapshot } from '../../lib/llm/api'
import { saveAudioFile } from '../../lib/voice/voice-native'
import { fmtClockSeconds, prettyJson, previewText, splitLongText } from './fairy-format'
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronUp, IconClose, IconPlay, IconStop } from './icons'
import { useAudioPlayback } from './useAudioPlayback'
import type { OmniDebugInfo, OmniDebugItem } from './types'

// ── 角色配置 ──

const ROLE_CFG: Record<string, { label: string; color: string }> = {
  system: { label: 'SYSTEM', color: '#7C5CC4' },
  user: { label: 'USER', color: '#2F7FD1' },
  assistant: { label: 'ASSISTANT', color: '#2F8F5B' },
  tool: { label: 'TOOL', color: '#B7791F' },
}
const getRoleCfg = (role: string) => ROLE_CFG[role] ?? { label: role.toUpperCase(), color: '#7A7F87' }

const TOOL_COLOR = '#B7791F'

// ── 公用：长文字（pre-wrap），超长分段防止 Android 单个 Text 空白 ──

function Pre({ text, color = theme.ink }: { text: string; color?: string }) {
  return (
    <View>
      {splitLongText(text).map((part, i) => (
        <Text key={i} selectable style={[styles.pre, { color }]}>{part}</Text>
      ))}
    </View>
  )
}

// ── 工具调用卡片 ──

interface ToolCallRaw {
  id?: string
  function?: { name?: string; arguments?: string }
}

function ToolCallCard({ tc }: { tc: ToolCallRaw }) {
  const name = tc.function?.name ?? '(unknown)'
  const args = prettyJson(tc.function?.arguments ?? '{}')
  return (
    <View style={styles.toolCard}>
      <Text style={styles.toolName}>
        ƒ {name}
        {tc.id ? <Text style={styles.toolId}>{`  ${tc.id}`}</Text> : null}
      </Text>
      <Pre text={args} color={TOOL_COLOR} />
    </View>
  )
}

// ── 单条消息块 ──

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  // 多模态消息的 content 可能是数组：别让渲染层拿到对象崩掉
  try { return JSON.stringify(content, null, 2) } catch { return String(content) }
}

function MessageBlock({ msg, index }: {
  msg: ApiRequestSnapshot['messages'][number]
  index: number
}) {
  const isSystem = msg.role === 'system'
  const [open, setOpen] = useState(!isSystem) // system 默认折叠
  const cfg = getRoleCfg(msg.role)

  const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  const text = contentText(msg.content)

  // 折叠时的预览文字
  const preview = hasToolCalls
    ? `[工具调用 × ${(msg.tool_calls as unknown[]).length}]`
    : previewText(text)

  return (
    <View style={[styles.block, { borderColor: alpha(cfg.color, 0.16), backgroundColor: alpha(cfg.color, 0.04) }]}>
      {/* 消息头（点击展开/折叠） */}
      <Pressable
        style={[styles.blockHead, open && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: alpha(cfg.color, 0.16) }]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
      >
        <Text style={[styles.blockLabel, { color: cfg.color }]}>[{index}] {cfg.label}</Text>
        {msg.tool_call_id ? (
          <Text style={styles.blockMeta} numberOfLines={1}>← {msg.tool_call_id.slice(0, 24)}</Text>
        ) : null}
        <Text style={[styles.blockMeta, styles.blockPreview]} numberOfLines={1}>{open ? '' : preview}</Text>
        {open ? <IconChevronUp size={12} color={theme.inkFaint} /> : <IconChevronDown size={12} color={theme.inkFaint} />}
      </Pressable>

      {/* 消息内容 */}
      {open && (
        <View style={styles.blockBody}>
          {text.length > 0 && <Pre text={text} />}
          {hasToolCalls && (msg.tool_calls as ToolCallRaw[]).map((tc, i) => (
            <ToolCallCard key={i} tc={tc} />
          ))}
          {text.length === 0 && !hasToolCalls && <Text style={styles.emptyBody}>(空)</Text>}
        </View>
      )}
    </View>
  )
}

// ── 弹窗外壳 ──

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* 里层接住点击：点内容不关闭 */}
        <Pressable style={styles.card} onPress={() => {}}>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function CloseKey({ onClose }: { onClose: () => void }) {
  return (
    <Pressable style={styles.navKey} hitSlop={10} accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose}>
      <IconClose size={16} color={theme.inkSoft} />
    </Pressable>
  )
}

// ── AI 请求内容 ──

export default function DebugRequestModal({ snapshots, onClose }: {
  snapshots: readonly ApiRequestSnapshot[]
  onClose: () => void
}) {
  const [activeIdx, setActiveIdx] = useState(0)
  if (snapshots.length === 0) return null

  const snap = snapshots[Math.min(activeIdx, snapshots.length - 1)]
  const systemMsg = snap.messages.find((m) => m.role === 'system')
  const otherMsgs = snap.messages.filter((m) => m.role !== 'system')

  return (
    <ModalShell onClose={onClose}>
      <View style={styles.head}>
        <View style={styles.headTitleRow}>
          <Text style={[styles.title, { color: ROLE_CFG.assistant.color }]}>AI 请求内容</Text>
          <Text style={styles.headMeta} numberOfLines={1}>{snap.model}</Text>
          <View style={styles.spacer} />
          <CloseKey onClose={onClose} />
        </View>
        <View style={styles.headMetaRow}>
          <Text style={styles.headMeta}>max_tokens {snap.maxTokens}</Text>
          <Text style={styles.headMeta}>{snap.messages.length} 条消息</Text>
          {snap.tools && <Text style={styles.headMeta}>{snap.tools.length} 个工具</Text>}
          <Text style={styles.headMeta}>{fmtClockSeconds(snap.timestamp)}</Text>
        </View>
        {snapshots.length > 1 && (
          <View style={styles.pager}>
            <Pressable
              style={[styles.navKey, activeIdx === 0 && styles.navOff]}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="上一次调用"
              disabled={activeIdx === 0}
              onPress={() => setActiveIdx((i) => Math.max(0, i - 1))}
            >
              <IconChevronLeft size={14} color={theme.inkSoft} />
            </Pressable>
            <Text style={styles.pagerText}>第 {activeIdx + 1}/{snapshots.length} 次调用</Text>
            <Pressable
              style={[styles.navKey, activeIdx === snapshots.length - 1 && styles.navOff]}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="下一次调用"
              disabled={activeIdx === snapshots.length - 1}
              onPress={() => setActiveIdx((i) => Math.min(snapshots.length - 1, i + 1))}
            >
              <IconChevronRight size={14} color={theme.inkSoft} />
            </Pressable>
          </View>
        )}
      </View>

      {/* 说明 */}
      <Text style={styles.note}>OpenAI 格式 → 换行符已还原为真实换行，工具调用参数已格式化，点击消息头可折叠</Text>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {systemMsg && <MessageBlock key={`${activeIdx}-system`} msg={systemMsg} index={0} />}
        {otherMsgs.map((msg, i) => (
          <MessageBlock key={`${activeIdx}-${i}`} msg={msg} index={systemMsg ? i + 1 : i} />
        ))}
      </ScrollView>
    </ModalShell>
  )
}

// ── Omni 上下文 ──

function CollapsibleSection({ label, color, preview, children }: {
  label: string
  color: string
  preview?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <View style={styles.section}>
      <Pressable
        style={styles.sectionHead}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
      >
        <View style={[styles.sectionDot, { backgroundColor: color }]} />
        <Text style={[styles.sectionLabel, { color }]}>{label}</Text>
        <Text style={[styles.blockMeta, styles.blockPreview]} numberOfLines={1}>{!open && preview ? preview : ''}</Text>
        {open ? <IconChevronUp size={12} color={theme.inkFaint} /> : <IconChevronDown size={12} color={theme.inkFaint} />}
      </Pressable>
      {open && <View style={styles.sectionBody}>{children}</View>}
    </View>
  )
}

function OmniAudioPlayer({ item }: { item: OmniDebugItem }) {
  const [path, setPath] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const { playing, problem, toggle } = useAudioPlayback(path)

  const onPress = () => {
    if (path) {
      toggle(path)
      return
    }
    if (!item.wavBase64) return
    Promise.resolve()
      .then(() => saveAudioFile('omni-debug', item.wavBase64 as string, item.ts))
      .then((saved) => {
        setPath(saved)
        toggle(saved)
      })
      .catch(() => setSaveFailed(true))
  }

  const message = saveFailed ? '语音写入失败，无法播放' : problem
  return (
    <View style={styles.omniAudio}>
      <Pressable style={styles.omniPlay} hitSlop={8} accessibilityRole="button" accessibilityLabel={playing ? '停止' : '播放'} onPress={onPress}>
        {playing ? <IconStop color="#FFFFFF" /> : <IconPlay color="#FFFFFF" />}
      </Pressable>
      <Text style={styles.headMeta}>{playing ? '播放中' : '点击播放'}</Text>
      {message && <Text style={styles.omniProblem}>{message}</Text>}
    </View>
  )
}

export function OmniDebugModal({ info, onClose }: {
  info: OmniDebugInfo
  onClose: () => void
}) {
  return (
    <ModalShell onClose={onClose}>
      <View style={styles.head}>
        <View style={styles.headTitleRow}>
          <Text style={[styles.title, { color: theme.ink }]}>Omni 上下文调试</Text>
          <View style={styles.spacer} />
          <CloseKey onClose={onClose} />
        </View>
        <View style={styles.headMetaRow}>
          <Text style={styles.headMono} numberOfLines={1}>{info.model}</Text>
          {info.voice ? <Text style={styles.headMeta}>音色 {info.voice}</Text> : null}
          <Text style={styles.headMeta}>{fmtClockSeconds(info.ts)}</Text>
        </View>
      </View>

      <Text style={styles.note}>每次发起对话时捕获 · Instructions = session.update 的 instructions 字段</Text>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        <CollapsibleSection label="系统指令" color={theme.accent} preview={previewText(info.systemPrompt)}>
          <Pre text={info.systemPrompt} />
        </CollapsibleSection>

        <Text style={styles.sentTitle}>本轮发送给 AI（{info.items.length} 条）</Text>

        {info.items.length === 0 && <Text style={styles.headMeta}>（无）</Text>}

        {info.items.map((item, i) => {
          const isText = item.type === 'text'
          const color = isText ? ROLE_CFG.tool.color : theme.accent
          return (
            <View key={i} style={styles.section}>
              <View style={[styles.sectionHead, styles.itemHead]}>
                <View style={[styles.sectionDot, { backgroundColor: color }]} />
                <Text style={[styles.sectionLabel, { color }]}>{isText ? '文字' : '语音'}</Text>
                <Text style={styles.headMono}>{fmtClockSeconds(item.ts)}</Text>
                {item.type === 'audio' && item.durationMs !== undefined && (
                  <Text style={styles.headMono}>{(item.durationMs / 1000).toFixed(1)}s</Text>
                )}
              </View>
              <View style={styles.sectionBody}>
                {isText && <Pre text={contentText(item.content)} />}
                {item.type === 'audio' && item.wavBase64 ? <OmniAudioPlayer item={item} /> : null}
              </View>
            </View>
          )
        })}
      </ScrollView>
    </ModalShell>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.45)', alignItems: 'center', justifyContent: 'center', padding: 14 },
  card: { width: '100%', height: '86%', backgroundColor: theme.surface, borderRadius: 14, overflow: 'hidden' },
  head: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, gap: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  headTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2 },
  title: { fontSize: 13, fontWeight: '700' },
  headMeta: { flexShrink: 1, fontSize: 11, color: theme.inkFaint },
  headMono: { flexShrink: 1, fontFamily: fonts.mono, fontSize: 11, color: theme.inkSoft },
  spacer: { flex: 1 },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  pagerText: { minWidth: 96, textAlign: 'center', fontSize: 11, color: theme.inkSoft },
  navKey: { padding: 3, alignItems: 'center', justifyContent: 'center' },
  navOff: { opacity: 0.3 },
  note: { paddingHorizontal: 14, paddingVertical: 5, fontSize: 10.5, lineHeight: 15, color: theme.inkFaint, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.lineSoft },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 16, gap: 8 },
  pre: { fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 19 },
  block: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  blockLabel: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  blockMeta: { flexShrink: 1, fontSize: 10.5, color: theme.inkFaint },
  blockPreview: { flex: 1, minWidth: 0 },
  blockBody: { padding: 10, gap: 8 },
  emptyBody: { fontSize: 11, fontStyle: 'italic', color: theme.inkFaint },
  toolCard: {
    borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: alpha(TOOL_COLOR, 0.3),
    backgroundColor: alpha(TOOL_COLOR, 0.05), paddingHorizontal: 10, paddingVertical: 7,
  },
  toolName: { fontSize: 11, fontWeight: '700', color: TOOL_COLOR, marginBottom: 5 },
  toolId: { fontSize: 10, fontWeight: '400', color: theme.inkFaint },
  section: { borderRadius: 8, backgroundColor: theme.sunk, overflow: 'hidden' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  itemHead: { paddingBottom: 4 },
  sectionDot: { width: 6, height: 6, borderRadius: 1.5 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  sectionBody: { paddingHorizontal: 10, paddingBottom: 10 },
  sentTitle: { fontSize: 11, fontWeight: '600', color: theme.inkSoft, marginTop: 4 },
  omniAudio: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  omniPlay: { width: 26, height: 26, borderRadius: 13, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center' },
  omniProblem: { fontSize: 11, color: theme.inkFaint },
})
