// ══════════════════════════════════════════════
// Session Picker — 历史会话（对齐 desktop components/SessionPicker.tsx）
// desktop 是停靠在聊天栏旁边的抽屉，手机屏幕放不下，改成底部面板；
// 列表、全文搜索、片段高亮和跳转、改名、重新起标题、删除的逻辑逐项对应。
// 会话列表由父级持有（和 desktop 一样）：打开时清空白会话、重拉，onRefresh 时再拉。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DeviceEventEmitter,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { alpha, fonts, theme } from '../../theme'
import { loadConfig } from '../../lib/agent/agent-config'
import {
  fetchSessionMessages,
  patchSession,
  searchChatSessions,
  type ChatSessionInfo,
  type SessionSearchHit,
} from '../../lib/agent/agent-memory'
import { generateSessionTitle } from '../../lib/ai/session-title'
import {
  getFeatureModel,
  emitFeatureBindingUpdated,
  listModelFreeQuotas,
  setFeatureModel,
  subscribeFeatureBindingUpdated,
  type ModelFreeQuota,
} from '../../lib/models/model-audit'
import { modelSelectOption } from '../../lib/models/model-display'
import {
  ensureModelCatalog,
  listCachedModels,
  refreshModelCatalog,
  type ModelDef,
} from '../../lib/models/registry'
import SelectField from '../models/SelectField'

export interface SessionPickerProps {
  readonly visible: boolean
  readonly sessions: readonly ChatSessionInfo[]
  readonly currentSessionId: string | null
  /**
   * jumpToTimestamp：搜索命中片段时传入，用于切会话后定位到对应气泡。
   * session 是这一行的完整信息：搜索能搜到列表上限之外的旧会话，它不一定在 sessions 里，
   * 父级要用它拿标题，否则会把已有标题的会话当成没标题，自动起名就把原标题盖掉了。
   */
  readonly onSelect: (id: string, jumpToTimestamp: string | undefined, session: ChatSessionInfo) => void
  readonly onNewSession: () => void
  readonly onDelete: (id: string) => void
  readonly onClose: () => void
  /**
   * 让父级重拉会话列表。
   * 带 changedSessionId：主人改过名 / 重新生成过标题，父级要 titleFlow.lock(它)；
   * 不带：同步导入改了数据，只重拉。
   */
  readonly onRefresh?: (changedSessionId?: string) => void
}

/** Modal 不可见时不渲染内容，打开就是一次重新挂载：和 desktop 每次打开都重新挂载抽屉一样，搜索词不留 */
export default function SessionPicker(props: SessionPickerProps) {
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={props.onClose}>
          <PickerBody {...props} />
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  )
}

function PickerBody({
  sessions, currentSessionId, onSelect, onNewSession, onDelete, onClose, onRefresh,
}: SessionPickerProps) {
  const [query, setQuery] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // 长按 / ⋯ 菜单 + 改名 + 重新起标题进行中（Set：多个会话可并发重新起标题，互不顶掉状态）
  const [menu, setMenu] = useState<ChatSessionInfo | null>(null)
  const [renaming, setRenaming] = useState<ChatSessionInfo | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [regenIds, setRegenIds] = useState<ReadonlySet<string>>(new Set())
  const [models, setModels] = useState<readonly ModelDef[]>(() => listCachedModels())
  const [freeQuotas, setFreeQuotas] = useState<ModelFreeQuota[]>([])
  const [titleModel, setTitleModel] = useState('qwen3.6-flash')
  const [serverHits, setServerHits] = useState<SessionSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  // 同步导入后重跑一次当前搜索
  const [syncTick, setSyncTick] = useState(0)
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [modelRows, quotaRows, boundModel] = await Promise.all([
          ensureModelCatalog(),
          listModelFreeQuotas(),
          getFeatureModel('session_title', 'qwen3.6-flash'),
        ])
        if (cancelled) return
        setModels(modelRows)
        setFreeQuotas(quotaRows)
        setTitleModel(boundModel)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => subscribeFeatureBindingUpdated((detail) => {
    if (detail.feature === 'session_title' && detail.modelId) setTitleModel(detail.modelId)
  }), [])

  // 手机端不扫额度，模型数据只会被同步改；会话也可能被另一台设备改名或删除。
  // desktop 的 model-free-quota-updated 对应这里。当前打开的会话被删时怎么办归父级（见 solevupIsChatSessionDeleted）
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('SolevupDbChanged', () => {
      void listModelFreeQuotas().then(setFreeQuotas).catch(() => {})
      void refreshModelCatalog().then(setModels)
      void getFeatureModel('session_title', 'qwen3.6-flash').then(setTitleModel)
      setSyncTick((t) => t + 1)
      onRefresh?.()
    })
    return () => sub.remove()
  }, [onRefresh])

  // 全文搜索：query 非空时 debounce 250ms（走 SQL LIKE，含 chat_messages.content 全文匹配，不只是 title/summary）
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setServerHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    setServerHits(null)
    let cancelled = false
    const timer = setTimeout(() => {
      searchChatSessions(q, 50)
        .then((rows) => { if (!cancelled) { setServerHits(rows); setSearching(false) } })
        .catch(() => { if (!cancelled) { setServerHits([]); setSearching(false) } })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, syncTick])

  // 搜索状态下：返回命中（带 snippets）；否则把 sessions 包成同样的形状复用 SessionRow 渲染
  const filtered = useMemo<SessionSearchHit[]>(() => {
    if (!query.trim()) return sessions.map((s) => ({ session: s, snippets: [] }))
    return serverHits ?? []
  }, [sessions, query, serverHits])

  const titleModelOptions = useMemo(() => {
    const quotaByModel = new Map(freeQuotas.map((q) => [q.model_id, q]))
    const textModels = models.filter((m) => m.category === 'text' && m.provider !== 'anthropic')
    return textModels.map((m) => modelSelectOption(m, quotaByModel.get(m.id)))
  }, [freeQuotas, models])

  const currentTitleModel = useMemo(() => {
    if (titleModelOptions.some((opt) => opt.value === titleModel)) return titleModel
    return titleModelOptions[0]?.value ?? titleModel
  }, [titleModel, titleModelOptions])

  const changeTitleModel = useCallback(async (modelId: string) => {
    setTitleModel(modelId)
    try {
      await setFeatureModel('session_title', modelId)
      emitFeatureBindingUpdated('session_title', modelId)
    } catch {}
  }, [])

  const startRename = useCallback((s: ChatSessionInfo) => {
    setRenaming(s)
    setRenameDraft(sessionTitle(s))
    setMenu(null)
  }, [])

  const commitRename = useCallback(async () => {
    const s = renaming
    setRenaming(null)
    if (!s) return
    const title = renameDraft.trim()
    if (!title || title === sessionTitle(s)) return
    try {
      await patchSession(s.id, { title })
      onRefresh?.(s.id)
    } catch (e) {
      console.error('[SessionPicker] 重命名失败', e)
    }
  }, [renaming, renameDraft, onRefresh])

  const regenTitle = useCallback(async (s: ChatSessionInfo) => {
    setMenu(null)
    if (regenIds.has(s.id)) return
    setRegenIds((prev) => new Set(prev).add(s.id))
    try {
      const msgs = await fetchSessionMessages(s.id)
      if (msgs.length === 0) return
      const title = await generateSessionTitle(msgs, await loadConfig())
      if (title) {
        await patchSession(s.id, { title })
        onRefresh?.(s.id)
      }
    } catch (e) {
      console.error('[SessionPicker] 重新生成标题失败', e)
    } finally {
      setRegenIds((prev) => {
        const next = new Set(prev)
        next.delete(s.id)
        return next
      })
    }
  }, [onRefresh, regenIds])

  const highlight = query.trim()

  return (
    <Pressable style={styles.sheet} onPress={() => {}}>
      <View style={styles.handle} />

      {/* Header：标题 + 计数 + 收起键 */}
      <View style={styles.header}>
        <Text style={styles.title}>历史会话</Text>
        <Text style={styles.count}>{searching ? '···' : `${filtered.length}/${sessions.length}`}</Text>
        <View style={styles.flex} />
        <Pressable hitSlop={10} accessibilityRole="button" accessibilityLabel="收起" onPress={onClose}>
          <Text style={styles.closeText}>收起</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View style={styles.searchBox}>
        <TextInput
          ref={inputRef}
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="搜索标题、摘要或对话内容..."
          placeholderTextColor={theme.inkFaint}
          returnKeyType="search"
        />
        {query !== '' && (
          <Pressable
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="清空搜索"
            style={styles.searchClear}
            onPress={() => { setQuery(''); inputRef.current?.focus() }}
          >
            <Text style={styles.searchClearText}>×</Text>
          </Pressable>
        )}
      </View>

      {/* Title model + New session 同行 */}
      <Text style={styles.label}>会话总结模型</Text>
      <View style={styles.toolRow}>
        <View style={styles.flex}>
          <SelectField
            value={currentTitleModel}
            title="会话总结模型"
            options={titleModelOptions.length > 0 ? titleModelOptions : [{ value: currentTitleModel, label: currentTitleModel }]}
            onChange={(id) => { void changeTitleModel(id) }}
          />
        </View>
        <Pressable accessibilityRole="button" style={styles.newBtn} onPress={onNewSession}>
          <Text style={styles.newBtnText}>新建会话</Text>
        </Pressable>
      </View>

      {/* List */}
      <FlatList
        style={styles.flex}
        contentContainerStyle={styles.listContent}
        data={filtered}
        keyExtractor={(hit) => hit.session.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={styles.empty}>
            {sessions.length === 0 ? '还没有历史会话' : searching ? '搜索中…' : '没有匹配的会话'}
          </Text>
        }
        renderItem={({ item: hit }) => (
          <SessionRow
            session={hit.session}
            snippets={hit.snippets}
            highlight={highlight}
            active={hit.session.id === currentSessionId}
            confirming={confirmId === hit.session.id}
            regenerating={regenIds.has(hit.session.id)}
            onPress={() => onSelect(hit.session.id, undefined, hit.session)}
            onJumpToSnippet={(timestamp) => onSelect(hit.session.id, timestamp, hit.session)}
            onConfirmDelete={() => { onDelete(hit.session.id); setConfirmId(null) }}
            onCancelDelete={() => setConfirmId(null)}
            onOpenMenu={() => setMenu(hit.session)}
          />
        )}
      />

      {/* 操作菜单（desktop 的右键菜单）：长按一行或点 ⋯ */}
      <Modal visible={menu != null} transparent animationType="slide" onRequestClose={() => setMenu(null)}>
        <Pressable style={styles.backdrop} onPress={() => setMenu(null)}>
          <Pressable style={styles.menuSheet} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.menuTitle} numberOfLines={1}>{menu ? sessionTitle(menu) : ''}</Text>
            <MenuItem label="重命名" onPress={() => { if (menu) startRename(menu) }} />
            <MenuItem label="重新生成标题" onPress={() => { if (menu) void regenTitle(menu) }} />
            <View style={styles.menuRule} />
            <MenuItem label="删除" danger onPress={() => { if (menu) setConfirmId(menu.id); setMenu(null) }} />
          </Pressable>
        </Pressable>
      </Modal>

      {/* 改名：desktop 是行内输入框，手机上键盘会盖住靠下的行，换成对话框 */}
      <Modal visible={renaming != null} transparent animationType="fade" onRequestClose={() => setRenaming(null)}>
        <Pressable style={styles.renameBackdrop} onPress={() => setRenaming(null)}>
          <Pressable style={styles.renameCard} onPress={() => {}}>
            <Text style={styles.renameTitle}>重命名</Text>
            <TextInput
              style={styles.renameInput}
              value={renameDraft}
              onChangeText={setRenameDraft}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={() => { void commitRename() }}
            />
            <View style={styles.renameActions}>
              <Pressable style={styles.renameBtn} onPress={() => setRenaming(null)}>
                <Text style={styles.renameBtnText}>取消</Text>
              </Pressable>
              <Pressable style={[styles.renameBtn, styles.renameBtnPrimary]} onPress={() => { void commitRename() }}>
                <Text style={[styles.renameBtnText, styles.renameBtnPrimaryText]}>保存</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Pressable>
  )
}

function sessionTitle(s: ChatSessionInfo): string {
  return s.title?.trim() || '未命名会话'
}

function MenuItem({ label, danger, onPress }: { label: string; danger?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" style={styles.menuItem} onPress={onPress}>
      <Text style={[styles.menuItemText, danger && styles.dangerText]}>{label}</Text>
    </Pressable>
  )
}

function SessionRow({
  session, snippets, highlight, active, confirming, regenerating,
  onPress, onJumpToSnippet, onConfirmDelete, onCancelDelete, onOpenMenu,
}: {
  session: ChatSessionInfo
  snippets: readonly { role: string; excerpt: string; timestamp: string }[]
  highlight: string
  active: boolean
  confirming: boolean
  regenerating: boolean
  onPress: () => void
  onJumpToSnippet: (timestamp: string) => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
  onOpenMenu: () => void
}) {
  const updated = formatRelativeTime(session.updated_at)
  const title = sessionTitle(session)
  const preview = session.summary?.trim() || ''

  return (
    <Pressable
      style={[styles.row, active && styles.rowOn]}
      disabled={confirming}
      onPress={onPress}
      onLongPress={onOpenMenu}
    >
      {confirming ? (
        <View style={styles.confirmRow}>
          <Text style={styles.confirmText} numberOfLines={1}>删除 "{title.slice(0, 12)}"?</Text>
          <Pressable accessibilityRole="button" style={styles.confirmBtn} onPress={onConfirmDelete}>
            <Text style={[styles.confirmBtnText, styles.dangerText]}>删除</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.confirmBtn} onPress={onCancelDelete}>
            <Text style={styles.confirmBtnText}>取消</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.rowHead}>
            <Text
              style={[styles.rowTitle, active && styles.rowTitleOn, regenerating && styles.rowTitleBusy]}
              numberOfLines={1}
            >
              {regenerating ? '重新起标题中…' : <Highlight text={title} keyword={highlight} />}
            </Text>
            <Text style={styles.rowTime}>{updated}</Text>
            <Pressable hitSlop={10} accessibilityRole="button" accessibilityLabel="更多操作" onPress={onOpenMenu}>
              <Text style={styles.moreText}>⋯</Text>
            </Pressable>
          </View>
          {preview !== '' && snippets.length === 0 && (
            <Text style={styles.preview} numberOfLines={1}>
              <Highlight text={preview} keyword={highlight} />
            </Text>
          )}
          {snippets.length > 0 && (
            <View style={styles.snippets}>
              {snippets.map((snip, idx) => (
                <Pressable
                  key={`${snip.timestamp}-${idx}`}
                  accessibilityRole="button"
                  accessibilityHint="跳转到此消息"
                  style={styles.snippet}
                  onPress={() => onJumpToSnippet(snip.timestamp)}
                >
                  {/* 谁说的：前面一颗小方点（你 = 强调色 / Fairy = 灰） */}
                  <View style={[styles.snipDot, snip.role === 'user' && styles.snipDotUser]} />
                  <Text style={styles.snipText}>
                    <Text style={styles.snipRole}>
                      {snip.role === 'user' ? '你' : snip.role === 'assistant' ? 'Fairy' : snip.role}{'  '}
                    </Text>
                    <Highlight text={snip.excerpt} keyword={highlight} />
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </>
      )}
    </Pressable>
  )
}

function Highlight({ text, keyword }: { text: string; keyword: string }) {
  const k = keyword.trim()
  if (!k) return <>{text}</>
  // 大小写不敏感切分；保留原文片段
  const lowerText = text.toLowerCase()
  const lowerK = k.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let i = lowerText.indexOf(lowerK)
  let n = 0
  while (i >= 0) {
    if (i > cursor) parts.push(text.slice(cursor, i))
    parts.push(
      <Text key={`m-${n++}`} style={styles.mark}>
        {text.slice(i, i + k.length)}
      </Text>,
    )
    cursor = i + k.length
    i = lowerText.indexOf(lowerK, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

function formatRelativeTime(iso: string): string {
  // desktop 写的时间是 to_rfc3339（9 位小数秒），同步过来后按毫秒精度解析，不依赖 Hermes 对长小数的处理
  const then = new Date(iso.replace(/(\.\d{3})\d+/, '$1')).getTime()
  if (!isFinite(then)) return ''
  const now = Date.now()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}时前`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}天前`
  const d = new Date(then)
  const thisYear = new Date(now).getFullYear()
  const thatYear = d.getFullYear()
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  if (thatYear === thisYear) return md
  if (thatYear === thisYear - 1) return `去年${md}`
  if (thatYear === thisYear - 2) return `前年${md}`
  return `${thatYear}年${md}`
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)', justifyContent: 'flex-end' },
  sheet: {
    height: '88%', backgroundColor: theme.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingBottom: 12,
  },
  handle: {
    alignSelf: 'center', width: 36, height: 4, borderRadius: 2,
    backgroundColor: theme.line, marginTop: 10, marginBottom: 12,
  },

  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink },
  count: { fontSize: 11, color: theme.inkFaint, fontFamily: fonts.mono },
  closeText: { fontSize: 13, color: theme.accent },

  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: theme.sunk, borderRadius: 10, paddingHorizontal: 12,
  },
  searchInput: { flex: 1, minWidth: 0, fontSize: 14, color: theme.ink, paddingVertical: 8 },
  searchClear: {
    width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
    backgroundColor: alpha(theme.inkSoft, 0.2),
  },
  searchClearText: { fontSize: 13, lineHeight: 15, color: theme.inkSoft },

  label: { fontSize: 11, color: theme.inkSoft, marginTop: 12, marginBottom: 5 },
  toolRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginBottom: 10 },
  newBtn: {
    justifyContent: 'center', paddingHorizontal: 14, borderRadius: 10,
    backgroundColor: theme.accent,
  },
  newBtnText: { fontSize: 13, fontWeight: '600', color: '#FFF' },

  listContent: { paddingBottom: 12 },
  empty: { textAlign: 'center', color: theme.inkFaint, fontSize: 13, paddingVertical: 40 },

  row: {
    paddingHorizontal: 12, paddingVertical: 11, borderRadius: 10, marginBottom: 2,
  },
  rowOn: { backgroundColor: alpha(theme.accent, 0.07) },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '600', color: theme.ink },
  rowTitleOn: { color: theme.accent },
  rowTitleBusy: { opacity: 0.45 },
  rowTime: { fontSize: 11, color: theme.inkFaint, fontFamily: fonts.mono },
  moreText: { fontSize: 16, fontWeight: '700', color: theme.inkSoft, paddingHorizontal: 2 },
  preview: { fontSize: 12, color: theme.inkSoft, marginTop: 3 },

  snippets: { marginTop: 6, gap: 4 },
  snippet: {
    flexDirection: 'row', gap: 6, backgroundColor: theme.sunk, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 6,
  },
  snipDot: { width: 5, height: 5, borderRadius: 1, marginTop: 6, backgroundColor: theme.inkFaint },
  snipDotUser: { backgroundColor: theme.accent },
  snipText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, color: theme.ink },
  snipRole: { fontSize: 10, color: theme.inkSoft, fontFamily: fonts.mono },
  mark: { backgroundColor: alpha(theme.accent, 0.18), color: theme.accent, fontWeight: '700' },

  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  confirmText: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '700', color: theme.danger },
  confirmBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.sunk },
  confirmBtnText: { fontSize: 13, fontWeight: '600', color: theme.inkSoft },
  dangerText: { color: theme.danger },

  menuSheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingBottom: 24,
  },
  menuTitle: { fontSize: 12, color: theme.inkFaint, paddingHorizontal: 10, paddingBottom: 6 },
  menuItem: { paddingHorizontal: 10, paddingVertical: 13 },
  menuItemText: { fontSize: 14, color: theme.ink },
  menuRule: { height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginVertical: 4 },

  renameBackdrop: {
    flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)', justifyContent: 'center', paddingHorizontal: 32,
  },
  renameCard: { backgroundColor: theme.surface, borderRadius: 14, padding: 16 },
  renameTitle: { fontSize: 14, fontWeight: '700', color: theme.ink, marginBottom: 10 },
  renameInput: {
    backgroundColor: theme.sunk, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, color: theme.ink,
  },
  renameActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  renameBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10, backgroundColor: theme.sunk },
  renameBtnPrimary: { backgroundColor: theme.accent },
  renameBtnText: { fontSize: 13, fontWeight: '600', color: theme.inkSoft },
  renameBtnPrimaryText: { color: '#FFF' },
})
