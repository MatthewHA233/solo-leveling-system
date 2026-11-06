// ══════════════════════════════════════════════
// 长按消息的菜单：复制 / 查看本轮请求
// 桌面端可以直接选中文字复制；手机端的 selectable Text 在流式更新和横向滚动里不稳，统一走长按菜单
// ══════════════════════════════════════════════

import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import { solevupCopyText } from '../../lib/solevupdb'
import { showTip } from './tip'
import type { ApiRequestSnapshot } from '../../lib/llm/api'
import type { FairyMessage, OmniDebugInfo } from './types'

/** 长按复制的文字：语音消息复制转写，压缩提示复制摘要 */
export function copyableText(message: FairyMessage): string {
  return message.summary || message.content || message.audio?.transcript || ''
}

export default function MessageActionSheet({ message, onClose, onDebug, onOmniDebug }: {
  message: FairyMessage | null
  onClose: () => void
  onDebug?: (snapshots: readonly ApiRequestSnapshot[]) => void
  onOmniDebug?: (info: OmniDebugInfo) => void
}) {
  const text = message ? copyableText(message) : ''
  const snapshots = message?.debugSnapshots
  const omniInfo = message?.omniDebugInfo

  const copy = () => {
    onClose()
    solevupCopyText(text)
      .then((ok) => showTip(ok ? '已复制' : '复制失败'))
      .catch(() => showTip('复制失败'))
  }

  return (
    <Modal visible={!!message} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          {text.length > 0 && <Item label="复制" onPress={copy} />}
          {snapshots && onDebug && (
            <Item label="查看本轮 AI 请求" onPress={() => { onClose(); onDebug(snapshots) }} />
          )}
          {omniInfo && onOmniDebug && (
            <Item label="查看本轮 Omni 上下文" onPress={() => { onClose(); onOmniDebug(omniInfo) }} />
          )}
          {text.length === 0 && !snapshots && !omniInfo && (
            <View style={styles.item}><Text style={styles.empty}>这条消息没有可操作的内容</Text></View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function Item({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.item} accessibilityRole="button" onPress={onPress}>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.3)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  card: { width: '100%', maxWidth: 300, backgroundColor: theme.surface, borderRadius: 14, paddingVertical: 4 },
  item: { paddingHorizontal: 18, paddingVertical: 13 },
  label: { fontSize: 14, color: theme.ink },
  empty: { fontSize: 13, color: theme.inkFaint },
})
