// ══════════════════════════════════════════════
// 暗影聊天 — 简洁多模态对话
// 文字 / 图片 / 语音 · 流式回复 · 普通 / Omni
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Animated,
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
import { theme } from '../theme'
import type {
  AiMode,
  ChatAudioAttachment,
  ChatImageAttachment,
  ChatMessage,
} from '../types'
import { mockWaveform } from '../lib/mock'
import { fmtDuration } from '../lib/time'
import { runQueryLoop } from '../lib/llm/query-loop'
import { createAssistantMessage, createUserMessage } from '../lib/llm/types'
import type { Message } from '../lib/llm/types'
import {
  DEFAULT_CONFIG,
  buildSystemPrompt,
  getDashScopeApiKey,
  loadConfig,
  updateConfig,
} from '../lib/agent/agent-config'
import type { AgentConfig } from '../lib/agent/agent-config'
import ModelCenter from '../components/ModelCenter'
import {
  solevupAppendChatMessages,
  solevupCleanupEmptyChatSessions,
  solevupCreateChatSession,
  solevupGetActiveModelApiKey,
  solevupGetChatMessages,
  solevupGetFeatureBinding,
  solevupInsertModelCallLog,
  solevupListChatSessions,
  solevupPatchChatSession,
  type ChatMessageDbRow,
  type ChatSessionRow,
} from '../lib/solevupdb'
import SessionsSheet from '../components/SessionsSheet'
import QuickModelSheet from '../components/QuickModelSheet'
import { getModelDef } from '../lib/models/registry'
import { generateSessionTitle } from '../lib/ai/session-title'
import {
  ensureMicPermission,
  omniConnect,
  omniStartRecording,
  omniStop,
  omniStopAndCommit,
  subscribeOmni,
} from '../lib/omni'

const DEFAULT_OMNI_MODEL = 'qwen3.5-omni-flash-realtime'


// 占位图（纯 RN 演示用色块，接入相册后换真实图）
const SAMPLE_IMAGES: ChatImageAttachment[] = [
  { id: 's1', label: '昼夜表截图', tint: '#4C86E0' },
  { id: 's2', label: '代码片段', tint: '#3FA86A' },
  { id: 's3', label: '白板草图', tint: '#8A63C9' },
  { id: 's4', label: '日程表', tint: '#D98A3D' },
  { id: 's5', label: '书页照片', tint: '#BE8A4A' },
  { id: 's6', label: '数据图表', tint: '#D26591' },
]

let idSeq = 0
function nextId(): string {
  idSeq += 1
  return `m${Date.now()}_${idSeq}`
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<ChatImageAttachment[]>([])
  const [aiMode, setAiMode] = useState<AiMode>('omni')
  const [isProcessing, setIsProcessing] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordMs, setRecordMs] = useState(0)
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [quickModelOpen, setQuickModelOpen] = useState(false)
  const [boundModels, setBoundModels] = useState<{ fairy_chat: string; fairy_omni_chat: string }>({
    fairy_chat: 'qwen3.6-flash',
    fairy_omni_chat: DEFAULT_OMNI_MODEL,
  })
  const [sessionId, setSessionId] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_CONFIG)

  const scrollRef = useRef<ScrollView>(null)
  const cancelStreamRef = useRef<(() => void) | null>(null)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const configRef = useRef<AgentConfig>(DEFAULT_CONFIG)
  // LLM 对话历史（llm Message 类型，与 desktop conversationRef 同构）
  const conversationRef = useRef<Message[]>([])

  // 切换会话：装载消息 + 重建 LLM 对话历史
  const switchToSession = useCallback(async (s: ChatSessionRow) => {
    setSessionId(s.id)
    setSessionsOpen(false)
    try {
      const rows = await solevupGetChatMessages(s.id)
      setMessages(rows.map((r) => ({
        id: r.id,
        role: (r.role === 'user' || r.role === 'agent' || r.role === 'system' ? r.role : 'system') as ChatMessage['role'],
        content: r.content ?? '',
        timestamp: Date.parse(r.timestamp) || Date.now(),
        reasoning: r.reasoning ?? undefined,
        audio: r.durationMs
          ? { durationMs: r.durationMs, waveform: mockWaveform(26), transcript: r.content ?? undefined }
          : undefined,
      })))
      conversationRef.current = rows
        .filter((r) => (r.role === 'user' || r.role === 'agent') && (r.content ?? '').trim())
        .slice(-12)
        .map((r) => (r.role === 'user' ? createUserMessage(r.content!) : createAssistantMessage(r.content!)))
    } catch {
      setMessages([])
      conversationRef.current = []
    }
  }, [])

  const createNewSession = useCallback(async () => {
    const s = await solevupCreateChatSession().catch(() => null)
    if (!s) return
    setSessionId(s.id)
    setSessionsOpen(false)
    setMessages([])
    conversationRef.current = []
  }, [])

  // 会话标题：消息够 4 条且仍是「新会话」时用 session_title 绑定模型生成（对齐 desktop）
  const titleDoneRef = useRef<Set<string>>(new Set())
  const maybeGenerateTitle = useCallback(async (sid: string, msgs: ChatMessage[]) => {
    if (titleDoneRef.current.has(sid)) return
    const meaningful = msgs.filter((m) => m.role !== 'system' && (m.content || m.audio?.transcript))
    if (meaningful.length < 4) return
    const current = (await solevupListChatSessions(50).catch(() => []))
      .find((x) => x.id === sid)
    if (!current || current.title !== '新会话') { titleDoneRef.current.add(sid); return }
    titleDoneRef.current.add(sid)
    const syncedKey = await solevupGetActiveModelApiKey().catch(() => null)
    const apiKey = syncedKey?.apiKey || getDashScopeApiKey(configRef.current)
    if (!apiKey) return
    const model = (await solevupGetFeatureBinding('session_title').catch(() => null)) || 'qwen3.6-flash'
    const title = await generateSessionTitle(msgs, {
      apiKey, apiBase: configRef.current.openaiApiBase, model,
    })
    if (title) void solevupPatchChatSession(sid, title, null).catch(() => {})
  }, [])


  const refreshBoundModels = useCallback(() => {
    void Promise.all([
      solevupGetFeatureBinding('fairy_chat').catch(() => null),
      solevupGetFeatureBinding('fairy_omni_chat').catch(() => null),
    ]).then(([chat, omni]) => {
      setBoundModels((prev) => ({
        fairy_chat: chat || prev.fairy_chat,
        fairy_omni_chat: omni || prev.fairy_omni_chat,
      }))
    })
  }, [])

  useEffect(() => {
    loadConfig().then((cfg) => {
      configRef.current = cfg
      setConfig(cfg)
    })
    refreshBoundModels()
    // 会话初始化（对齐 desktop initChatSession：最近会话 <4h 恢复，否则新建）
    void (async () => {
      try {
        const recent = (await solevupListChatSessions(1))[0]
        let activeId: string | null = null
        if (recent && Date.now() - Date.parse(recent.updatedAt) < 4 * 3_600_000) {
          await switchToSession(recent)
          activeId = recent.id
        } else {
          const s = await solevupCreateChatSession()
          if (s) { setSessionId(s.id); activeId = s.id }
        }
        // except 必须是当前激活会话：否则刚新建的空会话会被自己清掉，
        // 后续消息 append 到已删除会话被外键拒绝 → 历史全丢
        void solevupCleanupEmptyChatSessions(activeId).catch(() => {})
      } catch {}
    })()
  }, [switchToSession])

  // 会话持久化（debounce；INSERT OR REPLACE by id 幂等，流式中间态也安全）
  useEffect(() => {
    if (!sessionId || messages.length === 0) return
    const t = setTimeout(() => {
      const rows: ChatMessageDbRow[] = messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content || (m.audio?.transcript ?? ''),
        timestamp: new Date(m.timestamp).toISOString(),
        durationMs: m.audio?.durationMs ?? null,
        reasoning: m.reasoning ?? null,
      }))
      void solevupAppendChatMessages(sessionId, rows).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [messages, sessionId])

  const handleConfigSave = useCallback((updates: Partial<AgentConfig>) => {
    setConfig((prev) => {
      const next = updateConfig(prev, updates)
      configRef.current = next
      return next
    })
  }, [])

  useEffect(() => {
    return () => {
      cancelStreamRef.current?.()
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
    }
  }, [])

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }))
  }, [])

  useEffect(() => {
    scrollToEnd()
  }, [messages, scrollToEnd])

  // 真实 LLM 流式回复（与 desktop handleSend 同构：runQueryLoop + conversationRef 紧凑历史）
  // key/模型优先用 LAN 同步过来的 model_api_keys / feature_bindings，手填仅作 fallback
  const runAgentReply = useCallback(
    (req: { text: string; hasImages: boolean; hasAudio: boolean; imageCount: number }) => {
      setIsProcessing(true)
      const agentId = nextId()
      setMessages((prev) => [
        ...prev,
        { id: agentId, role: 'agent', content: '', timestamp: Date.now(), streaming: true },
      ])

      const abort = new AbortController()
      cancelStreamRef.current = () => abort.abort()

      const userMsg = createUserMessage(req.text)
      void (async () => {
        const cfg = configRef.current
        // 同步过来的激活 key 优先（desktop 同步），fallback 到模型面板手填
        const syncedKey = await solevupGetActiveModelApiKey().catch(() => null)
        const apiKey = syncedKey?.apiKey || getDashScopeApiKey(cfg)
        if (!apiKey) {
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== agentId),
            {
              id: nextId(),
              role: 'system',
              content: '未配置 API Key — 与电脑同步一次，或点右上角「模型」手动填入',
              timestamp: Date.now(),
            },
          ])
          setIsProcessing(false)
          cancelStreamRef.current = null
          setModelSheetOpen(true)
          return
        }
        // 模型：feature_bindings 的 fairy_chat 绑定优先（与 desktop getFeatureModel 同语义）
        const boundModel = await solevupGetFeatureBinding('fairy_chat').catch(() => null)
        const model = boundModel || cfg.chatModel

        try {
          const result = await runQueryLoop({
            messages: [...conversationRef.current.slice(-20), userMsg],
            systemPrompt: buildSystemPrompt(cfg),
            apiOptions: {
              apiKey,
              apiBase: cfg.openaiApiBase,
              model,
              maxTokens: 8000,
              signal: abort.signal,
              feature: 'fairy_chat',
              // 用量落库（本机 model_call_log，下轮同步推回 desktop）
              onUsageLogged: (info) => {
                void solevupInsertModelCallLog({
                  apiKeyId: syncedKey?.id ?? null,
                  feature: info.feature,
                  modelId: info.modelId,
                  startedAt: info.startedAt,
                  durationMs: info.durationMs,
                  promptTextTokens: info.usage.prompt_tokens ?? 0,
                  completionTextTokens: info.usage.completion_tokens ?? 0,
                  success: true,
                }).catch(() => {})
              },
            },
            maxIterations: 1, // 第一版无工具调用，单轮即止
            onEvent: (ev) => {
              if (ev.type === 'textDelta') {
                setMessages((prev) =>
                  prev.map((m) => (m.id === agentId ? { ...m, content: m.content + ev.delta } : m)),
                )
              } else if (ev.type === 'reasoningDelta') {
                // 推演通道：思考流只进 UI（reasoning 字段），不进对话历史（对齐 desktop）
                setMessages((prev) =>
                  prev.map((m) => (m.id === agentId ? { ...m, reasoning: (m.reasoning ?? '') + ev.delta } : m)),
                )
              } else if (ev.type === 'error') {
                setMessages((prev) => [
                  ...prev.map((m) => (m.id === agentId ? { ...m, streaming: false } : m)),
                  { id: nextId(), role: 'system' as const, content: `错误：${ev.message}`, timestamp: Date.now() },
                ])
              }
            },
          })
          // 紧凑化历史（对齐 desktop：保留最近 12 条）
          conversationRef.current = [...conversationRef.current, userMsg, ...result].slice(-12)
          if (sessionIdRef.current) {
            setMessages((prev) => {
              void maybeGenerateTitle(sessionIdRef.current!, prev)
              return prev
            })
          }
        } catch (e) {
          if (!abort.signal.aborted) {
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: 'system', content: `请求失败：${e instanceof Error ? e.message : String(e)}`, timestamp: Date.now() },
            ])
          }
        } finally {
          setMessages((prev) =>
            prev.map((m) => (m.id === agentId ? { ...m, streaming: false } : m)),
          )
          setIsProcessing(false)
          cancelStreamRef.current = null
        }
      })()
    },
    [],
  )

  const handleSend = useCallback(() => {
    const text = input.trim()
    if ((!text && pendingImages.length === 0) || isProcessing) return
    const imgs = pendingImages
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
        images: imgs.length > 0 ? imgs : undefined,
      },
    ])
    setInput('')
    setPendingImages([])
    runAgentReply({ text, hasImages: imgs.length > 0, hasAudio: false, imageCount: imgs.length })
  }, [input, pendingImages, isProcessing, runAgentReply])

  // ── Omni 实时语音（native OmniModule：WS + 录音 + 播放都在 Kotlin） ──
  const omniAgentIdRef = useRef<string | null>(null)
  const omniUserIdRef = useRef<string | null>(null)

  // 订阅 omni 事件（文字 delta / 用户转写 / usage / 状态）
  useEffect(() => {
    return subscribeOmni({
      onText: (delta) => {
        const id = omniAgentIdRef.current
        if (!id) return
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m)),
        )
      },
      onUserTranscript: (text) => {
        const id = omniUserIdRef.current
        if (!id) return
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id && m.audio ? { ...m, audio: { ...m.audio, transcript: text } } : m,
          ),
        )
      },
      onUsage: (model, usage) => {
        void (async () => {
          const key = await solevupGetActiveModelApiKey().catch(() => null)
          void solevupInsertModelCallLog({
            apiKeyId: key?.id ?? null,
            feature: 'fairy_omni_chat',
            modelId: model,
            startedAt: new Date().toISOString(),
            promptTextTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
            completionTextTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
            success: true,
          }).catch(() => {})
        })()
      },
      onStatus: (status, message) => {
        if (status === 'audio_done' || status === 'disconnected') {
          const id = omniAgentIdRef.current
          if (id) {
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)))
            omniAgentIdRef.current = null
          }
          setIsProcessing(false)
        } else if (status === 'error') {
          setMessages((prev) => [
            ...prev,
            { id: nextId(), role: 'system', content: `Omni 错误：${message ?? '未知'}`, timestamp: Date.now() },
          ])
          setIsProcessing(false)
        }
      },
    })
  }, [])

  const startRecording = useCallback(() => {
    if (isProcessing) return
    if (aiMode !== 'omni') {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'system', content: '语音对话请切换到 Omni 全模态模式（右上角）', timestamp: Date.now() },
      ])
      return
    }
    setRecording(true)
    setRecordMs(0)
    recordTimerRef.current = setInterval(() => setRecordMs((ms) => ms + 100), 100)

    // 按下立即开录（native 在 WS 就绪前缓存 chunk），连接并行建立
    void (async () => {
      const ok = await ensureMicPermission()
      if (!ok) {
        setRecording(false)
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'system', content: '未授予麦克风权限', timestamp: Date.now() },
        ])
        return
      }
      try {
        await omniStartRecording()
        const cfg = configRef.current
        const syncedKey = await solevupGetActiveModelApiKey().catch(() => null)
        const apiKey = syncedKey?.apiKey || getDashScopeApiKey(cfg)
        if (!apiKey) {
          await omniStop()
          setRecording(false)
          setMessages((prev) => [
            ...prev,
            { id: nextId(), role: 'system', content: '未配置 API Key — 先与电脑同步或在「模型」里填入', timestamp: Date.now() },
          ])
          return
        }
        const boundModel = await solevupGetFeatureBinding('fairy_omni_chat').catch(() => null)
        await omniConnect(apiKey, boundModel || DEFAULT_OMNI_MODEL, '', buildSystemPrompt(cfg))
      } catch (e) {
        setRecording(false)
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'system', content: `语音启动失败：${e instanceof Error ? e.message : String(e)}`, timestamp: Date.now() },
        ])
      }
    })()
  }, [isProcessing, aiMode])

  const stopRecording = useCallback(() => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
    if (!recording) return
    setRecording(false)
    const ms = recordMs
    setRecordMs(0)
    if (aiMode !== 'omni') return
    if (ms < 500) {
      void omniStop()
      return
    }
    // 用户语音气泡（转写到达后由 onUserTranscript 填充）+ AI 回复气泡
    const userId = nextId()
    const agentId = nextId()
    omniUserIdRef.current = userId
    omniAgentIdRef.current = agentId
    const audio: ChatAudioAttachment = { durationMs: ms, waveform: mockWaveform(26) }
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', content: '', timestamp: Date.now(), audio },
      { id: agentId, role: 'agent', content: '', timestamp: Date.now(), streaming: true },
    ])
    setIsProcessing(true)
    void omniStopAndCommit().catch((e) => {
      setMessages((prev) => [
        ...prev.map((m) => (m.id === agentId ? { ...m, streaming: false } : m)),
        { id: nextId(), role: 'system' as const, content: `发送失败：${e instanceof Error ? e.message : String(e)}`, timestamp: Date.now() },
      ])
      setIsProcessing(false)
    })
  }, [recording, recordMs, aiMode])

  const toggleImage = useCallback((img: ChatImageAttachment) => {
    setPendingImages((prev) =>
      prev.some((p) => p.id === img.id)
        ? prev.filter((p) => p.id !== img.id)
        : [...prev, img],
    )
  }, [])

  const lastMsg = messages[messages.length - 1]
  const showTyping = isProcessing && (!lastMsg || lastMsg.role !== 'agent')
  const canSend = (input.trim().length > 0 || pendingImages.length > 0) && !isProcessing

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* ── 头部 ── */}
      <View style={styles.header}>
        <Text style={styles.headerName}>暗影系统</Text>
        <View style={styles.headerRight}>
          <Pressable style={styles.modeToggle} onPress={() => setSessionsOpen(true)}>
            <Text style={styles.modeText}>会话</Text>
          </Pressable>
          <Pressable
            style={styles.modeToggle}
            disabled={isProcessing}
            onPress={() => setAiMode((m) => (m === 'omni' ? 'regular' : 'omni'))}
          >
            <Text style={styles.modeText}>{aiMode === 'omni' ? 'Omni 全模态' : '普通对话'}</Text>
          </Pressable>
          <Pressable style={styles.modeToggle} onPress={() => setQuickModelOpen(true)}>
            <Text style={styles.modeText} numberOfLines={1}>
              {(() => {
                const id = aiMode === 'omni' ? boundModels.fairy_omni_chat : boundModels.fairy_chat
                return getModelDef(id)?.display_name ?? id
              })()}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* ── 消息 ── */}
      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {messages.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>和暗影系统聊聊</Text>
            <Text style={styles.emptySub}>
              发文字、图片或语音{'\n'}它会结合你今天的活动记录回应
            </Text>
          </View>
        )}

        {messages.map((msg) => (
          <Bubble key={msg.id} message={msg} />
        ))}

        {showTyping && <TypingDots />}
      </ScrollView>

      {/* ── 待发图片 ── */}
      {pendingImages.length > 0 && (
        <View style={styles.pendingBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {pendingImages.map((img) => (
              <Pressable
                key={img.id}
                style={[styles.pendingTile, { backgroundColor: img.tint }]}
                onPress={() => toggleImage(img)}
              >
                <Text style={styles.pendingLabel}>{img.label}</Text>
                <View style={styles.pendingRemove}>
                  <Text style={styles.pendingRemoveText}>×</Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── 输入栏 ── */}
      <View style={styles.inputBar}>
        <Pressable style={styles.plusBtn} onPress={() => setPickerOpen(true)} disabled={isProcessing}>
          <Text style={styles.plusText}>＋</Text>
        </Pressable>
        <View style={styles.inputPill}>
          <TextInput
            style={styles.textInput}
            value={input}
            onChangeText={setInput}
            placeholder="输入消息"
            placeholderTextColor={theme.inkFaint}
            multiline
            editable={!isProcessing}
          />
        </View>
        {canSend ? (
          <Pressable style={styles.sendBtn} onPress={handleSend}>
            <Text style={styles.sendArrow}>↑</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.micBtn, recording && styles.micBtnRec]}
            onPressIn={startRecording}
            onPressOut={stopRecording}
            disabled={isProcessing}
          >
            <MicIcon color={recording ? '#FFFFFF' : theme.inkSoft} />
          </Pressable>
        )}
      </View>

      {/* ── 图片选择 ── */}
      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setPickerOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>选择图片</Text>
            <Text style={styles.sheetHint}>演示用占位图 · 接入相册后换真实图片</Text>
            <View style={styles.pickerGrid}>
              {SAMPLE_IMAGES.map((img) => {
                const on = pendingImages.some((p) => p.id === img.id)
                return (
                  <Pressable
                    key={img.id}
                    style={[styles.pickerTile, { backgroundColor: img.tint }, on && styles.pickerTileOn]}
                    onPress={() => toggleImage(img)}
                  >
                    <Text style={styles.pickerLabel}>{img.label}</Text>
                    {on && <Text style={styles.pickerCheck}>✓</Text>}
                  </Pressable>
                )
              })}
            </View>
            <Pressable style={styles.sheetBtn} onPress={() => setPickerOpen(false)}>
              <Text style={styles.sheetBtnText}>
                完成{pendingImages.length > 0 ? ` (${pendingImages.length})` : ''}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── 录音浮层 ── */}
      {recording && (
        <View style={styles.recordOverlay} pointerEvents="none">
          <View style={styles.recordCard}>
            <RecordPulse />
            <Text style={styles.recordTime}>{fmtDuration(recordMs)}</Text>
            <Text style={styles.recordHint}>松开手指发送语音</Text>
          </View>
        </View>
      )}

      {/* ── 模型设置 ── */}
      <SessionsSheet
        visible={sessionsOpen}
        currentSessionId={sessionId}
        fallbackApiKey={getDashScopeApiKey(config)}
        apiBase={config.openaiApiBase}
        onClose={() => setSessionsOpen(false)}
        onSelect={(sess) => { void switchToSession(sess) }}
        onCreate={() => { void createNewSession() }}
      />
      <QuickModelSheet
        visible={quickModelOpen}
        feature={aiMode === 'omni' ? 'fairy_omni_chat' : 'fairy_chat'}
        currentModel={aiMode === 'omni' ? boundModels.fairy_omni_chat : boundModels.fairy_chat}
        onClose={() => setQuickModelOpen(false)}
        onPicked={(id) => {
          setBoundModels((prev) =>
            aiMode === 'omni' ? { ...prev, fairy_omni_chat: id } : { ...prev, fairy_chat: id },
          )
        }}
        onOpenCenter={() => setModelSheetOpen(true)}
      />
      <ModelCenter
        visible={modelSheetOpen}
        config={config}
        onClose={() => { setModelSheetOpen(false); refreshBoundModels() }}
        onSaveConfig={handleConfigSave}
      />
    </KeyboardAvoidingView>
  )
}

// ── 气泡 ──

function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === 'system') {
    return <Text style={styles.systemMsg}>{message.content}</Text>
  }
  const isUser = message.role === 'user'
  return (
    <View style={[styles.bubbleRow, { justifyContent: isUser ? 'flex-end' : 'flex-start' }]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
        {message.images && message.images.length > 0 && (
          <View style={styles.bubbleImages}>
            {message.images.map((img) => (
              <View key={img.id} style={[styles.bubbleImage, { backgroundColor: img.tint }]}>
                <Text style={styles.bubbleImageText}>{img.label}</Text>
              </View>
            ))}
          </View>
        )}
        {message.audio && <AudioBubble audio={message.audio} isUser={isUser} />}
        {!isUser && message.reasoning ? <ReasoningBlock message={message} /> : null}
        {message.content.length > 0 && (
          <Text style={[styles.bubbleText, { color: isUser ? '#FFFFFF' : theme.ink }]}>
            {message.content}
          </Text>
        )}
        {message.streaming && message.content.length === 0 && !message.reasoning && (
          <Text style={[styles.bubbleText, { color: theme.inkFaint }]}>…</Text>
        )}
      </View>
    </View>
  )
}

// ── 推演通道（思考流；对齐 desktop ChatPanel 行为：流式自动展开，正文到达后折叠可点开） ──

function ReasoningBlock({ message }: { message: ChatMessage }) {
  const reasoning = message.reasoning ?? ''
  // 流式且正文未开始 → 思考进行中，强制展开；否则折叠为单行，可手动展开
  const thinkingLive = !!message.streaming && message.content.length === 0
  const [manualOpen, setManualOpen] = useState(false)
  const open = thinkingLive || manualOpen
  const wellRef = useRef<ScrollView>(null)

  if (!open) {
    return (
      <Pressable style={styles.reasoningChip} onPress={() => setManualOpen(true)}>
        <Text style={styles.reasoningChipText}>
          推演 · {reasoning.length >= 1000 ? `${(reasoning.length / 1000).toFixed(1)}K` : reasoning.length} 字 ▸
        </Text>
      </Pressable>
    )
  }
  return (
    <View style={styles.reasoningWrap}>
      <Pressable
        style={styles.reasoningHead}
        disabled={thinkingLive}
        onPress={() => setManualOpen(false)}
      >
        <Text style={styles.reasoningHeadText}>{thinkingLive ? '推演中 ▌' : '推演 ▾'}</Text>
      </Pressable>
      <ScrollView
        ref={wellRef}
        style={styles.reasoningWell}
        nestedScrollEnabled
        onContentSizeChange={() => {
          if (thinkingLive) wellRef.current?.scrollToEnd({ animated: false })
        }}
      >
        <Text style={styles.reasoningText}>{reasoning}</Text>
      </ScrollView>
    </View>
  )
}

// ── 语音气泡 ──

function AudioBubble({ audio, isUser }: { audio: ChatAudioAttachment; isUser: boolean }) {
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const toggle = () => {
    if (playing) {
      if (timerRef.current) clearInterval(timerRef.current)
      setPlaying(false)
      return
    }
    setPlaying(true)
    setProgress(0)
    const step = 100 / (audio.durationMs / 100)
    timerRef.current = setInterval(() => {
      setProgress((p) => {
        const next = p + step
        if (next >= 100) {
          if (timerRef.current) clearInterval(timerRef.current)
          setPlaying(false)
          return 0
        }
        return next
      })
    }, 100)
  }

  const fg = isUser ? '#FFFFFF' : theme.accent
  const dim = isUser ? 'rgba(255,255,255,0.4)' : theme.line
  const played = Math.round((progress / 100) * audio.waveform.length)

  return (
    <View style={styles.audioRow}>
      <Pressable style={[styles.audioPlay, { borderColor: fg }]} onPress={toggle}>
        <Text style={[styles.audioGlyph, { color: fg }]}>{playing ? '❚❚' : '▶'}</Text>
      </Pressable>
      <View style={styles.waveform}>
        {audio.waveform.map((amp, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              marginHorizontal: 0.6,
              height: Math.max(3, amp * 20),
              borderRadius: 1,
              backgroundColor: i < played ? fg : dim,
            }}
          />
        ))}
      </View>
      <Text style={[styles.audioDur, { color: fg }]}>{fmtDuration(audio.durationMs)}</Text>
    </View>
  )
}

// ── 输入中 ──

function TypingDots() {
  const d0 = useRef(new Animated.Value(0)).current
  const d1 = useRef(new Animated.Value(0)).current
  const d2 = useRef(new Animated.Value(0)).current
  const dots = [d0, d1, d2]

  useEffect(() => {
    const loops = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(d, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(d, { toValue: 0, duration: 300, useNativeDriver: true }),
          Animated.delay(300 - i * 150),
        ]),
      ),
    )
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <View style={[styles.bubbleRow, { justifyContent: 'flex-start' }]}>
      <View style={[styles.bubble, styles.bubbleAgent, styles.typing]}>
        {dots.map((d, i) => (
          <Animated.View
            key={i}
            style={[
              styles.typingDot,
              {
                opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
                transform: [
                  { translateY: d.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) },
                ],
              },
            ]}
          />
        ))}
      </View>
    </View>
  )
}

// ── 录音脉冲 ──

function RecordPulse() {
  const pulse = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [pulse])
  return (
    <Animated.View
      style={[
        styles.recordDot,
        {
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
          transform: [
            { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.2] }) },
          ],
        },
      ]}
    />
  )
}

// ── 麦克风图标（View 拼） ──

function MicIcon({ color }: { color: string }) {
  return (
    <View style={styles.mic}>
      <View style={[styles.micCapsule, { backgroundColor: color }]} />
      <View style={[styles.micArc, { borderColor: color }]} />
      <View style={[styles.micStem, { backgroundColor: color }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  // 推演通道
  reasoningChip: {
    alignSelf: 'flex-start',
    backgroundColor: theme.sunk,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 6,
  },
  reasoningChipText: {
    fontSize: 11,
    color: theme.inkFaint,
  },
  reasoningWrap: {
    marginBottom: 8,
  },
  reasoningHead: {
    marginBottom: 4,
  },
  reasoningHeadText: {
    fontSize: 11,
    color: theme.inkFaint,
    fontWeight: '600',
  },
  reasoningWell: {
    maxHeight: 150,
    backgroundColor: theme.sunk,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  reasoningText: {
    fontSize: 11,
    lineHeight: 16,
    color: theme.inkSoft,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
  },

  // header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerName: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.ink,
  },
  modeToggle: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: theme.accentSoft,
  },
  modeText: {
    fontSize: 12,
    color: theme.accent,
    fontWeight: '500',
  },
  // list
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 14,
    gap: 9,
    flexGrow: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    paddingBottom: 60,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.ink,
  },
  emptySub: {
    fontSize: 13,
    color: theme.inkFaint,
    textAlign: 'center',
    lineHeight: 20,
  },
  // bubble
  bubbleRow: {
    flexDirection: 'row',
  },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    gap: 6,
  },
  bubbleUser: {
    backgroundColor: theme.accent,
    borderBottomRightRadius: 6,
  },
  bubbleAgent: {
    backgroundColor: theme.surface,
    borderBottomLeftRadius: 6,
  },
  bubbleText: {
    fontSize: 14.5,
    lineHeight: 21,
  },
  bubbleImages: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  bubbleImage: {
    width: 96,
    height: 96,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
  },
  bubbleImageText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  systemMsg: {
    textAlign: 'center',
    fontSize: 12,
    color: theme.inkFaint,
    paddingVertical: 2,
  },
  // audio
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minWidth: 188,
  },
  audioPlay: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioGlyph: {
    fontSize: 10,
  },
  waveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 22,
  },
  audioDur: {
    fontSize: 11,
    fontFamily: 'monospace',
  },
  // typing
  typing: {
    flexDirection: 'row',
    gap: 5,
    paddingVertical: 13,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.inkFaint,
  },
  // pending images
  pendingBar: {
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  pendingTile: {
    width: 60,
    height: 60,
    borderRadius: 10,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  pendingLabel: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '600',
    textAlign: 'center',
  },
  pendingRemove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingRemoveText: {
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: 14,
  },
  // input
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 12,
  },
  plusBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: {
    fontSize: 21,
    color: theme.inkSoft,
    marginTop: -1,
  },
  inputPill: {
    flex: 1,
    backgroundColor: theme.surface,
    borderRadius: 20,
    paddingHorizontal: 15,
    minHeight: 40,
    justifyContent: 'center',
  },
  textInput: {
    fontSize: 14.5,
    color: theme.ink,
    paddingVertical: 9,
    maxHeight: 110,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendArrow: {
    fontSize: 20,
    color: '#FFFFFF',
    fontWeight: '600',
    marginTop: -1,
  },
  micBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtnRec: {
    backgroundColor: theme.danger,
  },
  // mic icon
  mic: {
    alignItems: 'center',
  },
  micCapsule: {
    width: 9,
    height: 12,
    borderRadius: 4.5,
  },
  micArc: {
    width: 15,
    height: 7,
    borderWidth: 1.6,
    borderTopWidth: 0,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    marginTop: -3.5,
  },
  micStem: {
    width: 1.6,
    height: 3,
    marginTop: 0.5,
  },
  // modal
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,24,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 28,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.line,
    marginBottom: 16,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.ink,
  },
  sheetHint: {
    fontSize: 12,
    color: theme.inkFaint,
    marginTop: 3,
    marginBottom: 14,
  },
  pickerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pickerTile: {
    width: '31.7%',
    aspectRatio: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
  },
  pickerTileOn: {
    borderWidth: 3,
    borderColor: theme.accent,
  },
  pickerLabel: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  pickerCheck: {
    position: 'absolute',
    top: 5,
    right: 7,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  sheetBtn: {
    marginTop: 18,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: theme.accent,
    alignItems: 'center',
  },
  sheetBtnText: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '600',
  },
  // record overlay
  recordOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,24,0.3)',
  },
  recordCard: {
    alignItems: 'center',
    gap: 13,
    paddingHorizontal: 44,
    paddingVertical: 32,
    borderRadius: 20,
    backgroundColor: theme.surface,
  },
  recordDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.danger,
  },
  recordTime: {
    fontSize: 26,
    fontWeight: '600',
    color: theme.ink,
    fontFamily: 'monospace',
  },
  recordHint: {
    fontSize: 12,
    color: theme.inkFaint,
  },
})
