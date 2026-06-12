// ══════════════════════════════════════════════
// 通用确认框：标题 + 正文 + 取消/确认两按钮
// danger=true 时确认按钮用 danger 红，否则用 accent 蓝
// 复用：删除标签、删除分类、清除数据等需要二次确认的场景
// ══════════════════════════════════════════════

import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../theme'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body?: string
  confirmText?: string
  cancelText?: string
  /** 可选第三按钮（渲染在取消与确认之间，ghost 风格）：如「仅此节点」 */
  secondaryText?: string
  onSecondary?: () => void
  danger?: boolean
  /** AUDIT-021：强制场景下隐藏"取消"按钮（不渲染） */
  hideCancel?: boolean
  /** AUDIT-021：false 时点背景 / 系统返回键不会关闭对话框 */
  dismissible?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmText = '确认',
  cancelText = '取消',
  secondaryText,
  onSecondary,
  danger,
  hideCancel,
  dismissible = true,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  // dismissible=false 时：点背景 / 系统返回键 都拦住，只能走 onConfirm
  const onBackdrop = dismissible ? onCancel : () => {}
  const onRequestClose = dismissible ? onCancel : () => {}
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onRequestClose}>
      <Pressable style={styles.backdrop} onPress={onBackdrop}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          {!!body && <Text style={styles.body}>{body}</Text>}
          <View style={styles.row}>
            {!hideCancel && (
              <Pressable style={styles.cancelBtn} onPress={onCancel}>
                <Text style={styles.cancelText}>{cancelText}</Text>
              </Pressable>
            )}
            {!!secondaryText && onSecondary && (
              <Pressable style={styles.cancelBtn} onPress={onSecondary}>
                <Text style={[styles.cancelText, { color: theme.accent }]}>{secondaryText}</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.confirmBtn, danger ? styles.confirmDanger : styles.confirmAccent]}
              onPress={onConfirm}
            >
              <Text style={styles.confirmText}>{confirmText}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,24,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#FFF',
    borderRadius: 18,
    paddingHorizontal: 22,
    paddingTop: 20,
    paddingBottom: 14,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: theme.ink,
    marginBottom: 10,
  },
  body: {
    fontSize: 13.5,
    color: theme.inkSoft,
    lineHeight: 21,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  cancelBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
  },
  cancelText: {
    fontSize: 14,
    color: theme.inkSoft,
    fontWeight: '600',
  },
  confirmBtn: {
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 12,
  },
  confirmAccent: {
    backgroundColor: theme.accent,
  },
  confirmDanger: {
    backgroundColor: theme.danger,
  },
  confirmText: {
    fontSize: 14,
    color: '#FFF',
    fontWeight: '700',
  },
})
