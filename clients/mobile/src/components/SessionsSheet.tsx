// ══════════════════════════════════════════════
// SessionsSheet — 聊天会话列表（desktop SessionPicker 的手机版）
// 列表/切换/新建/删除 + ⋯ 菜单（重命名 / 重新生成标题，对齐 desktop 右键菜单）
// ══════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { theme, alpha } from '../theme'
import ConfirmDialog from './ConfirmDialog'
import { regenerateTitleForSession } from '../lib/ai/session-title'
import {
  solevupDeleteChatSession,
  solevupListChatSessions,
  solevupPatchChatSession,
  type ChatSessionRow,
} from '../lib/solevupdb'

interface Props {
  readonly visible: boolean
  readonly currentSessionId: string | null
  readonly fallbackApiKey: string | null
  readonly apiBase: string
  readonly onClose: () => void
  readonly onSelect: (session: ChatSessionRow) => void
  readonly onCreate: () => void
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)} 天前`
  return iso.slice(0, 10)
}

export default function SessionsSheet({
  visible, currentSessionId, fallbackApiKey, apiBase, onClose, onSelect, onCreate,
}: Props) {
  const [sessions, setSessions] = useState<ChatSessionRow[]>([])
  const [pendingDelete, setPendingDelete] = useState<ChatSessionRow | null>(null)
  const [menuFor, setMenuFor] = useState<ChatSessionRow | null>(null)
  const [renameFor, setRenameFor] = useState<ChatSessionRow | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // 多个会话可并发重新起标题，互不顶掉状态（对齐 desktop Set 设计）
  const [regenerating, setRegenerating] = useState<Set<string>>(new Set())

  const reload = useCallback(() => {
    solevupListChatSessions(100).then(setSessions).catch(() => {})
  }, [])

  useEffect(() => {
    if (visible) reload()
  }, [visible, reload])

  const confirmDelete = useCallback(async () => {
    const s = pendingDelete
    setPendingDelete(null)
    if (!s) return
    await solevupDeleteChatSession(s.id).catch(() => {})
    reload()
  }, [pendingDelete, reload])

  const startRename = useCallback((s: ChatSessionRow) => {
    setMenuFor(null)
    setRenameFor(s)
    setRenameDraft(s.title)
  }, [])

  const commitRename = useCallback(async () => {
    const s = renameFor
    const title = renameDraft.trim()
    setRenameFor(null)
    if (!s || !title || title === s.title) return
    await solevupPatchChatSession(s.id, title, null).catch(() => {})
    reload()
  }, [renameFor, renameDraft, reload])

  const regenerateTitle = useCallback(async (s: ChatSessionRow) => {
    setMenuFor(null)
    setRegenerating((prev) => new Set(prev).add(s.id))
    try {
      await regenerateTitleForSession(s.id, { fallbackApiKey, apiBase })
      reload()
    } finally {
      setRegenerating((prev) => {
        const next = new Set(prev)
        next.delete(s.id)
        return next
      })
    }
  }, [fallbackApiKey, apiBase, reload])

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.topbar}>
          <Pressable hitSlop={10} onPress={onClose}><Text style={styles.closeText}>关闭</Text></Pressable>
          <Text style={styles.title}>历史会话</Text>
          <Pressable hitSlop={10} onPress={onCreate}><Text style={styles.newText}>新建</Text></Pressable>
        </View>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {sessions.length === 0 && <Text style={styles.empty}>还没有会话</Text>}
          {sessions.map((s) => {
            const active = s.id === currentSessionId
            const busy = regenerating.has(s.id)
            return (
              <Pressable
                key={s.id}
                style={[styles.row, active && styles.rowOn]}
                onPress={() => onSelect(s)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowTitle, active && { color: theme.accent }]} numberOfLines={1}>
                    {s.title}
                  </Text>
                  <Text style={styles.rowMeta}>{relTime(s.updatedAt)} · {s.messageCount} 条</Text>
                </View>
                {busy && <ActivityIndicator size="small" color={theme.accent} />}
                {active && !busy && <Text style={styles.rowNow}>当前</Text>}
                <Pressable hitSlop={8} style={styles.moreBtn} onPress={() => setMenuFor(s)}>
                  <Text style={styles.moreText}>⋯</Text>
                </Pressable>
              </Pressable>
            )
          })}
        </ScrollView>

        {/* ── 行操作菜单（对齐 desktop 右键菜单：重命名/重新生成标题/删除） ── */}
        <Modal visible={menuFor != null} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
          <Pressable style={styles.menuBackdrop} onPress={() => setMenuFor(null)}>
            <Pressable style={styles.menuSheet} onPress={() => {}}>
              <Text style={styles.menuTitle} numberOfLines={1}>{menuFor?.title}</Text>
              <Pressable style={styles.menuItem} onPress={() => menuFor && startRename(menuFor)}>
                <Text style={styles.menuItemText}>重命名</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={() => menuFor && void regenerateTitle(menuFor)}>
                <Text style={styles.menuItemText}>重新生成标题</Text>
              </Pressable>
              <Pressable
                style={styles.menuItem}
                onPress={() => { const s = menuFor; setMenuFor(null); if (s) setPendingDelete(s) }}
              >
                <Text style={[styles.menuItemText, { color: theme.danger }]}>删除会话</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* ── 重命名 ── */}
        <Modal visible={renameFor != null} transparent animationType="fade" onRequestClose={() => setRenameFor(null)}>
          <Pressable style={styles.menuBackdrop} onPress={() => setRenameFor(null)}>
            <Pressable style={styles.renameCard} onPress={() => {}}>
              <Text style={styles.menuTitle}>重命名会话</Text>
              <TextInput
                style={styles.renameInput}
                value={renameDraft}
                onChangeText={setRenameDraft}
                autoFocus
                maxLength={30}
                onSubmitEditing={() => void commitRename()}
              />
              <View style={styles.renameActions}>
                <Pressable style={styles.renameBtn} onPress={() => setRenameFor(null)}>
                  <Text style={styles.renameBtnText}>取消</Text>
                </Pressable>
                <Pressable
                  style={[styles.renameBtn, styles.renameBtnPrimary]}
                  onPress={() => void commitRename()}
                >
                  <Text style={[styles.renameBtnText, { color: '#FFF' }]}>保存</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        <ConfirmDialog
          open={pendingDelete != null}
          title="删除会话"
          body={`删除「${pendingDelete?.title ?? ''}」？消息记录将一并清除。`}
          confirmText="删除"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 16, paddingBottom: 10,
  },
  closeText: { fontSize: 14, color: theme.accent },
  title: { fontSize: 16, fontWeight: '700', color: theme.ink },
  newText: { fontSize: 14, color: theme.accent, fontWeight: '600' },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 18, paddingBottom: 30 },
  empty: { textAlign: 'center', color: theme.inkFaint, paddingVertical: 50, fontSize: 13 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: theme.surface, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8,
  },
  rowOn: { backgroundColor: alpha(theme.accent, 0.07) },
  rowTitle: { fontSize: 14, fontWeight: '600', color: theme.ink },
  rowMeta: { fontSize: 11, color: theme.inkFaint, marginTop: 2 },
  rowNow: { fontSize: 11, color: theme.accent, fontWeight: '600' },
  moreBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  moreText: { fontSize: 16, color: theme.inkSoft, fontWeight: '700' },

  menuBackdrop: {
    flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)',
    justifyContent: 'center', paddingHorizontal: 40,
  },
  menuSheet: { backgroundColor: theme.surface, borderRadius: 14, paddingVertical: 6 },
  menuTitle: {
    fontSize: 12, color: theme.inkFaint, paddingHorizontal: 16, paddingVertical: 10,
  },
  menuItem: { paddingHorizontal: 16, paddingVertical: 13 },
  menuItemText: { fontSize: 14, color: theme.ink },

  renameCard: { backgroundColor: theme.surface, borderRadius: 14, padding: 16 },
  renameInput: {
    backgroundColor: theme.sunk, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: theme.ink,
    marginTop: 4,
  },
  renameActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  renameBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10, backgroundColor: theme.sunk },
  renameBtnPrimary: { backgroundColor: theme.accent },
  renameBtnText: { fontSize: 13, color: theme.inkSoft, fontWeight: '600' },
})
