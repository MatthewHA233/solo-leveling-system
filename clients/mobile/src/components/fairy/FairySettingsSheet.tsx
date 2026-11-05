// ══════════════════════════════════════════════
// Fairy 设置（对齐 desktop components/SettingsPanel.tsx 里和 Fairy 有关的部分）
// desktop 是居中弹窗 + 左侧栏，手机改成底部面板 + 分段切换；钛合金外观不搬。
//   · AI 人设、语音：逐项对应，多放了 desktop 只在草稿里、没有界面的语音字段（「高级」里）
//   · 模型和百炼 / Anthropic 的 Key：在 ModelCenter，这里不重复
//   · 网络代理：端口存在原生层（lib/network.ts），留空跟随系统 VPN 或系统代理
//   · 窗口、截图、追踪、独显、数据库位置：手机端没有对应的东西，没搬
//
// 配置走 chatController：它手里的 config 是运行中读的那份，和 desktop App.tsx 的 config 状态是一个角色。
// 绕开它直接存盘的话，它手里还是旧值，新人设不生效，下一次 ctrl.updateConfig 还会把存盘的内容盖回去。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { chatController } from '../../lib/agent/chat-controller'
import { loadProxyPort, saveProxyPort } from '../../lib/network'
import { solevupCopyText } from '../../lib/solevupdb'
import { resolveFishApiKey, saveFishApiKey } from '../../lib/voice'
import { fonts, theme } from '../../theme'
import { Segmented } from '../models/parts'
import { tone } from '../models/model-utils'
import { IconChevronDown, IconChevronUp, IconClose } from './icons'
import {
  changedFields,
  draftFromConfig,
  isDraftDirty,
  rebaseDraft,
  type SettingsDraft,
} from './SettingsDraft'
import { showTip } from './tip'

interface Props {
  readonly visible: boolean
  readonly onClose: () => void
}

type SectionId = 'persona' | 'voice' | 'network'

const SECTION_LIST: { value: SectionId; label: string }[] = [
  { value: 'persona', label: 'AI 人设' },
  { value: 'voice', label: '语音' },
  { value: 'network', label: '网络' },
]

const AI_MODE_OPTIONS: { value: SettingsDraft['aiMode']; label: string }[] = [
  { value: 'regular', label: '级联语音（推荐）' },
  { value: 'omni', label: '实时语音（实验）' },
]

const FISH_MODEL_OPTIONS = [
  { value: 's1', label: 's1' },
  { value: 's2-pro', label: 's2-pro' },
]

export default function FairySettingsSheet({ visible, onClose }: Props) {
  // ── 草稿（不实时写入，点保存才生效）。放在 Modal 外面，关掉面板不丢，和 desktop 一样 ──
  const [baseline, setBaseline] = useState<SettingsDraft>(() => draftFromConfig(chatController.config))
  const [draft, setDraft] = useState<SettingsDraft>(baseline)
  const [saved, setSaved] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('persona')
  // Fish Key 存在 Key 库里（跟着同步），不在配置里，打开面板时取
  const [fishKey, setFishKey] = useState('')
  const [fishKeySaved, setFishKeySaved] = useState('')
  // 代理端口存在原生层（不同步），打开面板时取
  const [proxyPort, setProxyPort] = useState('')
  const [proxyPortSaved, setProxyPortSaved] = useState('')
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dirty = isDraftDirty(draft, baseline) || fishKey.trim() !== fishKeySaved || proxyPort.trim() !== proxyPortSaved

  useEffect(() => {
    if (!visible) return
    const config = chatController.config
    setDraft((prev) => rebaseDraft(prev, baseline, config))
    setBaseline(draftFromConfig(config))
    let alive = true
    resolveFishApiKey().then((key) => {
      if (!alive) return
      // 面板关着时留着的未保存草稿不覆盖
      setFishKey((prev) => (prev.trim() !== fishKeySaved ? prev : key ?? ''))
      setFishKeySaved(key ?? '')
    }).catch(() => {})
    loadProxyPort().then((port) => {
      if (!alive) return
      const text = port ? String(port) : ''
      setProxyPort((prev) => (prev.trim() !== proxyPortSaved ? prev : text))
      setProxyPortSaved(text)
    }).catch(() => {})
    return () => { alive = false }
    // 只在打开时取一次；baseline 是这次打开前的起点，不需要跟着变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current)
  }, [])

  const update = useCallback(<K extends keyof SettingsDraft>(field: K, value: SettingsDraft[K]) => {
    setDraft((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }, [])

  const handleApply = useCallback(() => {
    const updates = changedFields(draft, baseline)
    if (Object.keys(updates).length > 0) chatController.updateConfig(updates)
    if (fishKey.trim() !== fishKeySaved) {
      saveFishApiKey(fishKey).then(() => setFishKeySaved(fishKey.trim())).catch((e) => {
        console.warn('[Settings] 保存 Fish Key 失败', e)
        setSaved(false)
        showTip(`Fish Key 没保存上：${e instanceof Error ? e.message : String(e)}`)
      })
    }
    if (proxyPort.trim() !== proxyPortSaved) {
      saveProxyPort(proxyPort).then((port) => {
        const text = port ? String(port) : ''
        setProxyPort(text)
        setProxyPortSaved(text)
      }).catch((e) => {
        setSaved(false)
        showTip(`代理端口没保存上：${e instanceof Error ? e.message : String(e)}`)
      })
    }
    // 回退规则可能改了值（名称留空回到 Fairy），输入框跟着显示实际存下的内容
    const fresh = draftFromConfig(chatController.config)
    setBaseline(fresh)
    setDraft(fresh)
    setSaved(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(false), 2000)
  }, [draft, baseline, fishKey, fishKeySaved, proxyPort, proxyPortSaved])

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.handle} />

            <View style={styles.headRow}>
              <Text style={styles.title}>设置</Text>
              <Pressable hitSlop={8} accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose}>
                <IconClose size={18} color={theme.inkSoft} />
              </Pressable>
            </View>

            <Segmented
              value={activeSection}
              options={SECTION_LIST}
              onChange={(v) => setActiveSection(v as SectionId)}
            />

            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {activeSection === 'persona' && <PersonaSection draft={draft} update={update} />}
              {activeSection === 'voice' && (
                <VoiceSection draft={draft} update={update} fishKey={fishKey} onFishKeyChange={(v) => { setFishKey(v); setSaved(false) }} />
              )}
              {activeSection === 'network' && (
                <Field
                  label="代理端口"
                  technical
                  value={proxyPort}
                  onChange={(v) => { setProxyPort(v); setSaved(false) }}
                  placeholder="留空就跟随系统"
                  hint="Anthropic 和 Fish 语音从这个本机端口（127.0.0.1）出去，填手机上代理软件的端口，比如 2080。留空就跟随系统 VPN 或系统代理。只对这台设备生效。"
                />
              )}
            </ScrollView>

            <View style={styles.footer}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !dirty }}
                disabled={!dirty}
                onPress={handleApply}
                style={[styles.saveBtn, dirty && styles.saveBtnOn]}
              >
                <Text style={[styles.saveText, dirty && styles.saveTextOn]}>{saved ? '已应用 ✓' : '保存'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  )
}

type UpdateDraft = <K extends keyof SettingsDraft>(field: K, value: SettingsDraft[K]) => void

// ── AI 人设 ──

function PersonaSection({ draft, update }: { draft: SettingsDraft; update: UpdateDraft }) {
  return (
    <>
      <Field
        label="称呼用户为"
        value={draft.agentCallUser}
        onChange={(v) => update('agentCallUser', v)}
        placeholder="主人"
      />
      <Field
        label="名称"
        value={draft.agentName}
        onChange={(v) => update('agentName', v)}
        placeholder="Fairy"
      />
      <Field
        label="人设描述"
        value={draft.agentPersona}
        onChange={(v) => update('agentPersona', v)}
        placeholder="描述 AI 的性格、语气和行为风格..."
        rows={4}
      />
      <Field
        label="主线目标"
        value={draft.mainQuest}
        onChange={(v) => update('mainQuest', v)}
        placeholder="当前最重要的目标，会注入到 AI 上下文中..."
        rows={2}
      />
    </>
  )
}

// ── 语音 ──

function VoiceSection({ draft, update, fishKey, onFishKeyChange }: {
  draft: SettingsDraft
  update: UpdateDraft
  fishKey: string
  onFishKeyChange: (value: string) => void
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  return (
    <>
      <Text style={styles.note}>长按底部中央按钮说话，松手发送，上滑取消。</Text>

      <Text style={styles.label}>语音模式</Text>
      <View style={styles.block}>
        <Segmented
          value={draft.aiMode}
          options={AI_MODE_OPTIONS}
          onChange={(v) => update('aiMode', v as SettingsDraft['aiMode'])}
        />
      </View>

      {draft.aiMode === 'regular' ? (
        <>
          <Text style={styles.note}>语音识别复用「模型中心」里的百炼 API Key。</Text>
          <Field
            label="Fish API Key"
            secret
            value={fishKey}
            onChange={onFishKeyChange}
            placeholder="Fish Audio API Key（TTS）"
            hint="和已配对的设备共用。没有 Fish Key 时，Fairy 只回文字，不出声。"
          />
          <Field
            label="Fish 音色 ID"
            technical
            value={draft.fishReferenceId}
            onChange={(v) => update('fishReferenceId', v)}
          />
          <Text style={styles.label}>Fish 模型</Text>
          <View style={styles.block}>
            <Segmented
              value={draft.fishModel}
              options={FISH_MODEL_OPTIONS}
              onChange={(v) => update('fishModel', v)}
            />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.note}>全模态模式：ASR + TTS 均由 Omni WS 处理，无需额外配置</Text>
          <Field
            label="输出音色 ID"
            technical
            value={draft.omniVoice}
            onChange={(v) => update('omniVoice', v)}
            placeholder="cosyvoice-v3.5-plus-bailian-..."
          />
        </>
      )}

      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>打字时也朗读</Text>
          <Text style={styles.hint}>打字提问的回复也用 Fish 念出来，语音提问总会语音回答。Fish Key 在级联语音下填写。</Text>
        </View>
        <Switch
          accessibilityLabel="打字时也朗读"
          value={draft.ttsEnabled}
          onValueChange={(v) => update('ttsEnabled', v)}
          trackColor={{ true: theme.accent, false: theme.line }}
          thumbColor={theme.surface}
        />
      </View>

      <Pressable
        style={styles.advancedHead}
        accessibilityRole="button"
        accessibilityState={{ expanded: advancedOpen }}
        onPress={() => setAdvancedOpen((v) => !v)}
      >
        <Text style={styles.advancedTitle}>高级</Text>
        {advancedOpen
          ? <IconChevronUp size={14} color={theme.inkSoft} />
          : <IconChevronDown size={14} color={theme.inkSoft} />}
      </Pressable>

      {advancedOpen && (
        <>
          <Field
            label="Omni API Key"
            secret
            value={draft.omniApiKey}
            onChange={(v) => update('omniApiKey', v)}
            placeholder="留空则复用百炼 Key"
            hint="只影响实时语音。"
          />
          <Field
            label="Omni 模型"
            technical
            value={draft.omniModel}
            onChange={(v) => update('omniModel', v)}
            placeholder="qwen3.5-omni-flash-realtime"
            hint="模型中心里「Fairy 全模态聊天」的绑定优先，读不到绑定时才用这里。"
          />
          <Field
            label="Omni 接口地址"
            technical
            value={draft.omniApiBase}
            onChange={(v) => update('omniApiBase', v)}
            placeholder="wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
            hint="暂未生效：连接地址目前写死在客户端里。"
          />
          <Field
            label="ASR API Key"
            secret
            value={draft.asrApiKey}
            onChange={(v) => update('asrApiKey', v)}
            placeholder="留空则复用百炼 Key"
            hint="有百炼 Key 时不会用到这里，只在一个百炼 Key 都没有时才用。"
          />
          <Field
            label="ASR 模型"
            technical
            value={draft.asrModel}
            onChange={(v) => update('asrModel', v)}
            placeholder="qwen3-asr-flash-realtime"
            hint="暂未生效：语音识别用模型中心里「Fairy 语音识别」的绑定。"
          />
        </>
      )}

      <Text style={styles.note}>聊天模型和百炼、Anthropic 的 Key 在「模型中心」里设置。</Text>
    </>
  )
}

// ── 输入框 ──

function Field({ label, value, onChange, placeholder, hint, rows, secret, technical }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  /** 多行输入的起始行数 */
  rows?: number
  /** Key：遮蔽显示，可以切换显示和复制 */
  secret?: boolean
  /** ID、地址、模型名：等宽字体，不自动改写 */
  technical?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!value) return
    try {
      if (!(await solevupCopyText(value))) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }, [value])

  return (
    <View style={styles.block}>
      <Text style={styles.label}>{label}</Text>
      {secret ? (
        <View style={styles.secretRow}>
          <TextInput
            style={styles.secretInput}
            value={value}
            onChangeText={onChange}
            placeholder={placeholder}
            placeholderTextColor={theme.inkFaint}
            secureTextEntry={!revealed}
            // 明文时也不让输入法记下 Key
            keyboardType={revealed && Platform.OS === 'android' ? 'visible-password' : 'default'}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            importantForAutofill="no"
          />
          <Pressable hitSlop={6} style={styles.secretBtn} onPress={() => setRevealed((v) => !v)}>
            <Text style={styles.secretBtnText}>{revealed ? '隐藏' : '显示'}</Text>
          </Pressable>
          <Pressable hitSlop={6} style={styles.secretBtn} disabled={!value} onPress={() => void handleCopy()}>
            <Text style={[styles.secretBtnText, !value && styles.secretBtnOff, copied && styles.secretBtnDone]}>
              {copied ? '已复制' : '复制'}
            </Text>
          </Pressable>
        </View>
      ) : (
        <TextInput
          style={[
            styles.input,
            technical && styles.inputTechnical,
            rows ? [styles.textarea, { minHeight: rows * 20 + 20 }] : null,
          ]}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={theme.inkFaint}
          multiline={!!rows}
          textAlignVertical={rows ? 'top' : 'center'}
          autoCapitalize={technical ? 'none' : 'sentences'}
          autoCorrect={!technical}
          spellCheck={!technical}
        />
      )}
      {!!hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)', justifyContent: 'flex-end' },
  sheet: {
    height: '88%', backgroundColor: theme.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.line, marginTop: 10, marginBottom: 12 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink },

  body: { flex: 1, marginTop: 12 },
  bodyContent: { paddingBottom: 12 },
  block: { marginBottom: 14 },
  label: { fontSize: 12, color: theme.inkSoft, marginBottom: 6 },
  note: { fontSize: 12, lineHeight: 18, color: theme.inkSoft, marginBottom: 14 },
  hint: { fontSize: 11, lineHeight: 16, color: theme.inkSoft, marginTop: 5 },

  input: { height: 40, paddingHorizontal: 12, paddingVertical: 0, borderRadius: 10, backgroundColor: theme.sunk, fontSize: 13, color: theme.ink },
  inputTechnical: { fontFamily: fonts.mono, fontSize: 12 },
  textarea: { height: undefined, paddingVertical: 10, lineHeight: 20 },

  secretRow: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 40, paddingLeft: 12, paddingRight: 6, borderRadius: 10, backgroundColor: theme.sunk },
  secretInput: { flex: 1, minWidth: 0, padding: 0, fontSize: 13, color: theme.ink, fontFamily: fonts.mono },
  secretBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  secretBtnText: { fontSize: 12, color: theme.inkSoft },
  secretBtnOff: { color: theme.inkFaint },
  secretBtnDone: { color: tone.green },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: theme.bg, marginBottom: 14 },
  switchText: { flex: 1, minWidth: 0 },
  switchLabel: { fontSize: 13, color: theme.ink },

  advancedHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line, marginBottom: 6,
  },
  advancedTitle: { fontSize: 13, fontWeight: '600', color: theme.ink },

  footer: { paddingTop: 10, paddingBottom: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
  saveBtn: { height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.sunk },
  saveBtnOn: { backgroundColor: theme.accent },
  saveText: { fontSize: 14, fontWeight: '600', color: theme.inkSoft },
  saveTextOn: { color: theme.surface },
})
