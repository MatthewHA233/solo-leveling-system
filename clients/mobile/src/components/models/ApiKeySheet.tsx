// ══════════════════════════════════════════════
// API Key 管理（对齐 desktop ApiKeyPopover / ApiKeyField）：同一个 Key 库，按提供商分开看
// 桌面端挂在按钮下的 Popover 换成底部弹层
// ══════════════════════════════════════════════

import { useCallback, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { alpha, fonts, theme } from '../../theme'
import { openExternalUrl, type ModelApiKey } from '../../lib/models/model-audit'
import { solevupCopyText } from '../../lib/solevupdb'
import { KEY_PROVIDER_META, tone, type KeyProvider } from './model-utils'
import { Segmented } from './parts'

function ApiKeyField({ value, onChange, placeholder, readOnly }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  readOnly?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!value) return
    try {
      await solevupCopyText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }, [value])

  return (
    <View style={styles.field}>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.inkFaint}
        secureTextEntry={!revealed}
        editable={!readOnly}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable hitSlop={6} style={styles.fieldBtn} onPress={() => setRevealed((v) => !v)}>
        <Text style={styles.fieldBtnText}>{revealed ? '隐藏' : '显示'}</Text>
      </Pressable>
      <Pressable hitSlop={6} style={styles.fieldBtn} disabled={!value} onPress={() => void handleCopy()}>
        <Text style={[styles.fieldBtnText, !value && styles.fieldBtnOff, copied && styles.fieldBtnDone]}>
          {copied ? '已复制' : '复制'}
        </Text>
      </Pressable>
    </View>
  )
}

export default function ApiKeySheet({
  visible,
  apiKeys,
  activeId,
  provider,
  onProviderChange,
  creating,
  newLabel,
  newValue,
  legacyKey,
  onStartCreate,
  onCancelCreate,
  onNewLabel,
  onNewValue,
  onSaveNew,
  onImportLegacy,
  onActivate,
  onDelete,
  onClose,
}: {
  visible: boolean
  apiKeys: readonly ModelApiKey[]
  activeId: string | null
  provider: KeyProvider
  onProviderChange: (p: KeyProvider) => void
  creating: boolean
  newLabel: string
  newValue: string
  /** 旧版手填在配置里、还没进 Key 库的百炼 Key；有值时给一个存入入口 */
  legacyKey: string | null
  onStartCreate: () => void
  onCancelCreate: () => void
  onNewLabel: (v: string) => void
  onNewValue: (v: string) => void
  onSaveNew: () => void
  onImportLegacy: () => void
  onActivate: (key: ModelApiKey) => void
  onDelete: (key: ModelApiKey) => void
  onClose: () => void
}) {
  const meta = KEY_PROVIDER_META[provider]
  const openPage = () => { void openExternalUrl(meta.url).catch(() => {}) }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.handle} />

            <Segmented
              value={provider}
              options={(['dashscope', 'anthropic'] as const).map((p) => ({ value: p, label: KEY_PROVIDER_META[p].label }))}
              onChange={(v) => onProviderChange(v as KeyProvider)}
            />

            <View style={styles.headRow}>
              <View style={styles.headText}>
                <Text style={styles.title}>API Key</Text>
                <Text style={styles.muted}>{meta.hint}</Text>
              </View>
              <Pressable hitSlop={6} accessibilityRole="link" onPress={openPage}>
                <Text style={styles.link}>访问{meta.pageName}</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {!creating && (
                <Pressable style={styles.plainBtn} onPress={onStartCreate}>
                  <Text style={styles.plainBtnText}>新建 API Key</Text>
                </Pressable>
              )}

              {creating && (
                <View style={styles.editor}>
                  <Text style={styles.editorTitle}>新建 API Key</Text>
                  <TextInput
                    style={styles.input}
                    value={newLabel}
                    onChangeText={onNewLabel}
                    placeholder="名称，例如：主账号 / 测试 Key"
                    placeholderTextColor={theme.inkFaint}
                  />
                  <ApiKeyField value={newValue} onChange={onNewValue} placeholder="sk-..." />
                  <View style={styles.editorBtns}>
                    <Pressable style={[styles.plainBtn, styles.flex]} onPress={onCancelCreate}>
                      <Text style={styles.plainBtnSoft}>取消</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.plainBtn, styles.flex, !newValue.trim() && styles.disabled]}
                      disabled={!newValue.trim()}
                      onPress={onSaveNew}
                    >
                      <Text style={styles.plainBtnText}>保存并切换</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {provider === 'dashscope' && apiKeys.length === 0 && !!legacyKey && (
                <View style={styles.legacy}>
                  <Text style={styles.muted}>检测到手动填写的 API Key，存入 Key 库后才能按 Key 记账。</Text>
                  <Pressable style={styles.plainBtn} onPress={onImportLegacy}>
                    <Text style={styles.plainBtnText}>存入 Key 库</Text>
                  </Pressable>
                </View>
              )}

              {apiKeys.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.muted}>还没有保存 API Key</Text>
                  <Text style={styles.emptyLine}>
                    请访问
                    <Text style={styles.link} onPress={openPage}> {meta.pageName} </Text>
                    申请 API Key
                  </Text>
                </View>
              ) : apiKeys.map((key) => (
                <View key={key.id} style={styles.row}>
                  <View style={styles.rowHead}>
                    <Text style={styles.rowLabel} numberOfLines={1}>{key.label}</Text>
                    {key.id === activeId && <Text style={styles.activeBadge}>使用中</Text>}
                  </View>
                  <ApiKeyField value={key.api_key} onChange={() => {}} readOnly />
                  <Text style={styles.rowMeta}>用量会记录到此 Key：{key.id.slice(0, 8)}</Text>
                  <View style={styles.rowBtns}>
                    <Pressable
                      hitSlop={6}
                      disabled={key.id === activeId}
                      onPress={() => onActivate(key)}
                    >
                      <Text style={[styles.rowAction, { color: key.id === activeId ? theme.inkFaint : tone.green }]}>切换</Text>
                    </Pressable>
                    <Pressable hitSlop={6} onPress={() => onDelete(key)}>
                      <Text style={[styles.rowAction, { color: tone.danger }]}>删除</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingBottom: 24, maxHeight: '85%',
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.line, marginTop: 10, marginBottom: 12 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginTop: 12, marginBottom: 10 },
  headText: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink },
  muted: { fontSize: 12, lineHeight: 18, color: theme.inkSoft },
  link: { fontSize: 12, color: theme.accent, textDecorationLine: 'underline' },
  list: { flexGrow: 0 },

  plainBtn: { height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.sunk, marginBottom: 10 },
  plainBtnText: { fontSize: 13, fontWeight: '600', color: theme.ink },
  plainBtnSoft: { fontSize: 13, color: theme.inkSoft },
  disabled: { opacity: 0.5 },

  editor: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: theme.bg, marginBottom: 10 },
  editorTitle: { fontSize: 13, fontWeight: '700', color: theme.ink },
  editorBtns: { flexDirection: 'row', gap: 8 },
  input: { height: 40, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.surface, fontSize: 13, color: theme.ink },

  field: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 40, paddingLeft: 12, paddingRight: 6, borderRadius: 10, backgroundColor: theme.sunk },
  fieldInput: { flex: 1, minWidth: 0, padding: 0, fontSize: 13, color: theme.ink, fontFamily: fonts.mono },
  fieldBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  fieldBtnText: { fontSize: 12, color: theme.inkSoft },
  fieldBtnOff: { color: theme.inkFaint },
  fieldBtnDone: { color: tone.green },

  legacy: { gap: 8, marginBottom: 10 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 18, paddingHorizontal: 16, borderRadius: 10, backgroundColor: theme.bg, marginBottom: 10 },
  emptyLine: { fontSize: 12, lineHeight: 18, color: theme.inkSoft, textAlign: 'center' },

  row: { padding: 12, borderRadius: 12, backgroundColor: theme.bg, marginBottom: 8 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  rowLabel: { flexShrink: 1, fontSize: 13, fontWeight: '700', color: theme.ink },
  activeBadge: {
    fontSize: 10, fontWeight: '700', color: tone.green,
    backgroundColor: alpha(tone.green, 0.1), borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden',
  },
  rowMeta: { fontSize: 10, color: theme.inkSoft, marginTop: 5 },
  rowBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 18, marginTop: 8 },
  rowAction: { fontSize: 13, fontWeight: '600', paddingVertical: 2 },
})
