// ══════════════════════════════════════════════
// ChatController — 暗影体全局状态（跨组件单例）
//
// 聊天页(ChatScreen)与全局浮层(AgentDock/语音手势)共享同一会话：
// 消息流 / LLM 历史 / Omni 语音 / 会话持久化 / AI 标题全在这里，
// React 侧用 useChatController() 订阅。对齐 desktop "Fairy 跨界面存在"的定位。
// ══════════════════════════════════════════════

import type { ChatAudioAttachment, ChatMessage } from '../../types'
import { mockWaveform } from '../mock'
import { runQueryLoop } from '../llm/query-loop'
import { createAssistantMessage, createUserMessage } from '../llm/types'
import type { Message } from '../llm/types'
import {
  DEFAULT_CONFIG,
  buildSystemPrompt,
  getDashScopeApiKey,
  loadConfig,
  updateConfig,
  type AgentConfig,
} from './agent-config'
import { generateSessionTitle } from '../ai/session-title'
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
} from '../solevupdb'
import {
  omniConnect,
  omniStartRecording,
  omniStop,
  omniStopAndCommit,
  omniStopAndTranscribe,
  subscribeOmni,
} from '../omni'

const DEFAULT_OMNI_MODEL = 'qwen3.5-omni-flash-realtime'

let idSeq = 0
function nextId(): string {
  idSeq += 1
  return `m${Date.now()}_${idSeq}`
}

type Listener = () => void

class ChatControllerImpl {
  messages: ChatMessage[] = []
  sessionId: string | null = null
  isProcessing = false
  config: AgentConfig = DEFAULT_CONFIG
  /** 最近一次活动（语音/发送）来自浮层还是聊天页 —— 浮层据此决定是否弹出 */
  lastActivityAt = 0

  private conversation: Message[] = []
  private listeners = new Set<Listener>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private titleDone = new Set<string>()
  private cancelStream: (() => void) | null = null
  private omniAgentId: string | null = null
  private omniUserId: string | null = null
  private omniUnsub: (() => void) | null = null
  private transcribeResolve: ((text: string | null) => void) | null = null
  private initialized = false

  // ── 订阅 ──

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    this.lastActivityAt = Date.now()
    for (const fn of this.listeners) fn()
  }

  private setMessages(updater: (prev: ChatMessage[]) => ChatMessage[]) {
    this.messages = updater(this.messages)
    this.schedulePersist()
    this.emit()
  }

  // ── 初始化（app 启动调一次） ──

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    this.config = await loadConfig()
    this.subscribeOmniEvents()

    // 会话恢复（对齐 desktop initChatSession：最近 <4h 恢复，否则新建）
    try {
      const recent = (await solevupListChatSessions(1))[0]
      let activeId: string | null = null
      if (recent && Date.now() - Date.parse(recent.updatedAt) < 4 * 3_600_000) {
        await this.switchToSession(recent)
        activeId = recent.id
      } else {
        const s = await solevupCreateChatSession()
        if (s) { this.sessionId = s.id; activeId = s.id }
      }
      void solevupCleanupEmptyChatSessions(activeId).catch(() => {})
    } catch {}
    this.emit()
  }

  updateConfig(updates: Partial<AgentConfig>) {
    this.config = updateConfig(this.config, updates)
    this.emit()
  }

  // ── 会话 ──

  async switchToSession(s: ChatSessionRow): Promise<void> {
    this.sessionId = s.id
    try {
      const rows = await solevupGetChatMessages(s.id)
      this.messages = rows.map((r) => ({
        id: r.id,
        role: (r.role === 'user' || r.role === 'agent' || r.role === 'system' ? r.role : 'system') as ChatMessage['role'],
        content: r.content ?? '',
        timestamp: Date.parse(r.timestamp) || Date.now(),
        reasoning: r.reasoning ?? undefined,
        audio: r.durationMs
          ? { durationMs: r.durationMs, waveform: mockWaveform(26), transcript: r.content ?? undefined }
          : undefined,
      }))
      this.conversation = rows
        .filter((r) => (r.role === 'user' || r.role === 'agent') && (r.content ?? '').trim())
        .slice(-12)
        .map((r) => (r.role === 'user' ? createUserMessage(r.content!) : createAssistantMessage(r.content!)))
    } catch {
      this.messages = []
      this.conversation = []
    }
    this.emit()
  }

  async newSession(): Promise<void> {
    const s = await solevupCreateChatSession().catch(() => null)
    if (!s) return
    this.sessionId = s.id
    this.messages = []
    this.conversation = []
    this.emit()
  }

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      const sid = this.sessionId
      if (!sid || this.messages.length === 0) return
      const rows: ChatMessageDbRow[] = this.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content || (m.audio?.transcript ?? ''),
        timestamp: new Date(m.timestamp).toISOString(),
        durationMs: m.audio?.durationMs ?? null,
        reasoning: m.reasoning ?? null,
      }))
      void solevupAppendChatMessages(sid, rows).catch(() => {})
    }, 600)
  }

  // ── 凭证/模型 ──

  private async resolveKey(): Promise<{ apiKey: string; apiKeyId: string | null } | null> {
    const synced = await solevupGetActiveModelApiKey().catch(() => null)
    const apiKey = synced?.apiKey || getDashScopeApiKey(this.config)
    if (!apiKey) return null
    return { apiKey, apiKeyId: synced?.id ?? null }
  }

  // ── 文本聊天（fairy_chat 链路；浮层与聊天页共用） ──

  cancel() {
    this.cancelStream?.()
    this.cancelStream = null
  }

  pushSystemNote(content: string) {
    this.setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'system', content, timestamp: Date.now() },
    ])
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || this.isProcessing) return

    this.setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: trimmed, timestamp: Date.now() },
    ])
    await this.runAgentReply(trimmed)
  }

  private async runAgentReply(text: string): Promise<void> {
    this.isProcessing = true
    const agentId = nextId()
    this.setMessages((prev) => [
      ...prev,
      { id: agentId, role: 'agent', content: '', timestamp: Date.now(), streaming: true },
    ])

    const abort = new AbortController()
    this.cancelStream = () => abort.abort()
    const userMsg = createUserMessage(text)

    const cred = await this.resolveKey()
    if (!cred) {
      this.setMessages((prev) => [
        ...prev.filter((m) => m.id !== agentId),
        { id: nextId(), role: 'system', content: '未配置 API Key — 与电脑同步一次，或在「模型」里填入', timestamp: Date.now() },
      ])
      this.isProcessing = false
      this.emit()
      return
    }
    const boundModel = await solevupGetFeatureBinding('fairy_chat').catch(() => null)
    const model = boundModel || this.config.chatModel

    try {
      const result = await runQueryLoop({
        messages: [...this.conversation.slice(-20), userMsg],
        systemPrompt: buildSystemPrompt(this.config),
        apiOptions: {
          apiKey: cred.apiKey,
          apiBase: this.config.openaiApiBase,
          model,
          maxTokens: 8000,
          signal: abort.signal,
          feature: 'fairy_chat',
          onUsageLogged: (info) => {
            void solevupInsertModelCallLog({
              apiKeyId: cred.apiKeyId,
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
        maxIterations: 1,
        onEvent: (ev) => {
          if (ev.type === 'textDelta') {
            this.setMessages((prev) =>
              prev.map((m) => (m.id === agentId ? { ...m, content: m.content + ev.delta } : m)),
            )
          } else if (ev.type === 'reasoningDelta') {
            this.setMessages((prev) =>
              prev.map((m) => (m.id === agentId ? { ...m, reasoning: (m.reasoning ?? '') + ev.delta } : m)),
            )
          } else if (ev.type === 'error') {
            this.setMessages((prev) => [
              ...prev.map((m) => (m.id === agentId ? { ...m, streaming: false } : m)),
              { id: nextId(), role: 'system' as const, content: `错误：${ev.message}`, timestamp: Date.now() },
            ])
          }
        },
      })
      this.conversation = [...this.conversation, userMsg, ...result].slice(-12)
      void this.maybeGenerateTitle()
    } catch (e) {
      if (!abort.signal.aborted) {
        this.pushSystemNote(`请求失败：${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      this.setMessages((prev) => prev.map((m) => (m.id === agentId ? { ...m, streaming: false } : m)))
      this.isProcessing = false
      this.cancelStream = null
      this.emit()
    }
  }

  // ── Omni 语音（全局手势 + 聊天页共用） ──

  private subscribeOmniEvents() {
    this.omniUnsub?.()
    this.omniUnsub = subscribeOmni({
      onText: (delta) => {
        const id = this.omniAgentId
        if (!id) return
        this.setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m)),
        )
      },
      onUserTranscript: (text) => {
        // 转文字模式：resolve 给 stopVoiceTranscribe
        if (this.transcribeResolve) {
          const resolve = this.transcribeResolve
          this.transcribeResolve = null
          resolve(text)
          return
        }
        const id = this.omniUserId
        if (!id) return
        this.setMessages((prev) =>
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
          const id = this.omniAgentId
          if (id) {
            this.setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)))
            this.omniAgentId = null
          }
          this.isProcessing = false
          this.emit()
        } else if (status === 'error') {
          this.pushSystemNote(`Omni 错误：${message ?? '未知'}`)
          this.isProcessing = false
          this.emit()
        }
      },
    })
  }

  /** 按下开始：立即开录（native 缓存），并行建连 */
  async startVoice(): Promise<void> {
    await omniStartRecording()
    const cred = await this.resolveKey()
    if (!cred) {
      await omniStop()
      throw new Error('未配置 API Key — 先与电脑同步或在「模型」里填入')
    }
    const boundModel = await solevupGetFeatureBinding('fairy_omni_chat').catch(() => null)
    await omniConnect(cred.apiKey, boundModel || DEFAULT_OMNI_MODEL, '', buildSystemPrompt(this.config))
  }

  /** 原位松手：语音消息 + Omni 语音回复 */
  stopVoiceCommit(durationMs: number) {
    const userId = nextId()
    const agentId = nextId()
    this.omniUserId = userId
    this.omniAgentId = agentId
    const audio: ChatAudioAttachment = { durationMs, waveform: mockWaveform(26) }
    this.setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', content: '', timestamp: Date.now(), audio },
      { id: agentId, role: 'agent', content: '', timestamp: Date.now(), streaming: true },
    ])
    this.isProcessing = true
    this.emit()
    void omniStopAndCommit().catch((e) => {
      this.setMessages((prev) => prev.map((m) => (m.id === agentId ? { ...m, streaming: false } : m)))
      this.pushSystemNote(`发送失败：${e instanceof Error ? e.message : String(e)}`)
      this.isProcessing = false
      this.emit()
    })
  }

  /** 左上松手：只转写不回 AI 语音 → 转写文本走文字链路发送 */
  async stopVoiceTranscribe(): Promise<void> {
    const transcript = await new Promise<string | null>((resolve) => {
      this.transcribeResolve = resolve
      // 8s 没等到转写就放弃
      setTimeout(() => {
        if (this.transcribeResolve === resolve) {
          this.transcribeResolve = null
          resolve(null)
        }
      }, 8000)
      void omniStopAndTranscribe().catch(() => {
        if (this.transcribeResolve === resolve) {
          this.transcribeResolve = null
          resolve(null)
        }
      })
    })
    void omniStop()
    if (transcript?.trim()) {
      await this.sendText(transcript.trim())
    } else {
      this.pushSystemNote('没有识别到语音内容')
    }
  }

  /** 右上松手 / 过短：取消 */
  cancelVoice() {
    void omniStop()
  }

  // ── AI 标题 ──

  private async maybeGenerateTitle(): Promise<void> {
    const sid = this.sessionId
    if (!sid || this.titleDone.has(sid)) return
    const meaningful = this.messages.filter((m) => m.role !== 'system' && (m.content || m.audio?.transcript))
    if (meaningful.length < 4) return
    const current = (await solevupListChatSessions(50).catch(() => [])).find((x) => x.id === sid)
    if (!current || current.title !== '新会话') { this.titleDone.add(sid); return }
    this.titleDone.add(sid)
    const cred = await this.resolveKey()
    if (!cred) return
    const model = (await solevupGetFeatureBinding('session_title').catch(() => null)) || 'qwen3.6-flash'
    const title = await generateSessionTitle(this.messages, {
      apiKey: cred.apiKey, apiBase: this.config.openaiApiBase, model,
    })
    if (title) void solevupPatchChatSession(sid, title, null).catch(() => {})
  }
}

export const chatController = new ChatControllerImpl()
