// ══════════════════════════════════════════════
// ChatCore — Fairy 主流程共用的状态（对应 desktop App.tsx 里 chat 相关的 useState / useRef）
//
// desktop 这些是 App 组件的 state 和 ref；手机端 Fairy 跨页面存在，放在组件树外面的单例里。
// 发送、语音、会话、Omni 各流程（chat-send / chat-voice / chat-sessions / chat-omni）只改这里，
// React 侧经 chat-controller 订阅。
// ══════════════════════════════════════════════

import type { PickedImage } from '../chatimage'
import type {
  FairyGazeTarget,
  FairyJumpTarget,
  FairyState,
} from '../../components/fairy/types'
import type { ChatMessage } from '../../types'
import { DEFAULT_SESSION_TITLE } from '../ai/session-title-flow'
import { contextBudget, estimateContextTokens, type ContextBudget } from '../llm/context-window'
import type { Message } from '../llm/types'
import { randomUUID } from '../llm/uuid'
import { buildAsrVocabulary } from '../voice/asr-hints'
import { DEFAULT_CONFIG, loadConfig, updateConfig, type AgentConfig } from './agent-config'
import type { ChatSessionInfo, SessionMessage } from './agent-memory'
import { solevupListSyncedSettings, solevupSaveSyncedSetting } from '../solevupdb'
import type { Compactor } from './chat-compaction'
import { configUpdatesFromSettings, seedWrites, settingWrites } from './synced-settings'
import { finishToolCall, toolCallLine, type ToolCallView } from './tool-call-view'

/** 流式增量最多这么久刷新一次界面（一批网络数据里有很多个 delta，不用每个都渲染） */
const STREAM_EMIT_MS = 50

export interface ReplyControl {
  readonly interrupt: () => void
}

/** 展开转录的那张语境卡（desktop activeContextRef）。手机端还没有语境卡界面，目前总是 null */
export interface ActiveContext {
  readonly cardId: string
  readonly text: string
  readonly title: string
}

/** 锁定的卡片（desktop focusedCardRef）。手机端还没有洪流域锁定，目前总是 null */
export interface FocusedCard {
  readonly cardId: string
  readonly kind: 'thought' | 'bili_transcript'
  readonly title: string | null
  readonly text: string
  readonly sourceLabel: string | null
  readonly refPath: string | null
  readonly linkBroken: boolean
}

export interface LastBiliContext {
  readonly cardId: string
  readonly title: string | null
  readonly refPath: string
}

/** 工具调用在聊天里的那条消息 */
export function toolCallMessage(call: ToolCallView, timestamp: string): ChatMessage {
  return { id: `tool-${call.id}`, role: 'system', content: toolCallLine(call), timestamp, tool: call }
}

export class ChatCore {
  // ── 界面状态 ──
  messages: ChatMessage[] = []
  sessionId: string | null = null
  sessionTitle = DEFAULT_SESSION_TITLE
  sessions: ChatSessionInfo[] = []
  isProcessing = false
  fairyState: FairyState = 'idle'
  /** 边说边出字：录音浮层显示，松手后清空 */
  partialText = ''
  config: AgentConfig = DEFAULT_CONFIG
  /** 上下文占用（历史 token / 压缩门槛），历史变了才重算 */
  contextRatio = 0
  jumpTo: FairyJumpTarget | null = null
  gazeTarget: FairyGazeTarget | null = null

  // ── 流程内部 ──
  /** 给模型看的对话历史（desktop conversationRef） */
  conversation: Message[] = []
  /** 上下文压缩（规则见 chat-compaction.ts）：门槛按当前聊天模型算，每轮发送时刷新；chat-sessions 建好后挂上来 */
  contextBudget: ContextBudget = contextBudget(null)
  contextOverhead = 0
  compactor: Compactor | null = null
  /** 当前会话的消息行（desktop persistedBufferRef），整表回写和起标题都用它 */
  persistedBuffer: SessionMessage[] = []
  /** Omni 连接用的完整提示词（desktop systemPromptRef） */
  systemPrompt = ''
  /** 打字和级联语音用：静态段作系统提示词，动态段作本轮 <system-reminder> */
  promptParts = { staticPrompt: '', dynamicContext: '' }
  asrVocabulary: string[] = buildAsrVocabulary({})
  /** 回复轮次号：被打断的轮次收尾时不再动 Fairy 状态和「处理中」标志 */
  replyTurn = 0
  /** 最后读走对话历史的轮次：比它旧的轮次收尾时不能再写历史 */
  conversationOwner = 0
  replyControl: ReplyControl | null = null
  /** 语音发送时取走待发的图片（输入框注册） */
  takeVoiceImages: () => readonly PickedImage[] = () => []
  /** 上一轮回复收尾完成（新一轮先等它，否则历史会缺上一轮） */
  turnSettled: Promise<void> = Promise.resolve()
  /** 被另一台设备删除后改道：旧会话 id → 新会话 id */
  rerouted = new Map<string, string>()
  activeContext: ActiveContext | null = null
  focusedCard: FocusedCard | null = null
  lastBiliContext: LastBiliContext | null = null
  /** 配置变了（模式、人设……）：Omni 监听和预热提示词跟着调整 */
  onConfigChanged: (() => void) | null = null

  private listeners = new Set<() => void>()
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private configVersion = 0
  version = 0

  // ── 订阅 ──

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  emit(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    this.version += 1
    for (const fn of this.listeners) fn()
  }

  private emitSoon(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => this.emit(), STREAM_EMIT_MS)
  }

  // ── 消息 ──

  setMessages(updater: (prev: ChatMessage[]) => ChatMessage[]): void {
    this.messages = updater(this.messages)
    this.emit()
  }

  /** 改一条消息；其他消息对象引用不变（气泡有 memo）。stream = 流式增量，界面合并刷新 */
  patchMessage(id: string, patch: (m: ChatMessage) => ChatMessage, stream = false): void {
    this.messages = this.messages.map((m) => (m.id === id ? patch(m) : m))
    if (stream) this.emitSoon()
    else this.emit()
  }

  /** 流式增量：气泡在就改，不在就建 */
  upsertStreaming(id: string, patch: (m: ChatMessage) => ChatMessage, create: () => ChatMessage): void {
    if (this.messages.some((m) => m.id === id)) {
      this.patchMessage(id, patch, true)
    } else {
      this.messages = [...this.messages, create()]
      this.emit()
    }
  }

  addSystemNote(content: string, id: string = randomUUID()): void {
    this.setMessages((prev) => [...prev, {
      id, role: 'system', content, timestamp: new Date().toISOString(),
    }])
  }

  /** 工具开始跑：聊天里加一行；id 按调用 id 定，结果出来时按它找回这一条 */
  addToolCall(call: ToolCallView): void {
    this.setMessages((prev) => [...prev, toolCallMessage(call, new Date().toISOString())])
  }

  /** 工具跑完：把结果记到对应的那一行上 */
  finishToolCall(callId: string, result: string): void {
    this.patchMessage(`tool-${callId}`, (m) => (m.tool ? { ...m, tool: finishToolCall(m.tool, result) } : m))
  }

  // ── 状态 ──

  emitFairy(state: FairyState): void {
    this.fairyState = state
    this.emit()
  }

  setProcessing(value: boolean): void {
    this.isProcessing = value
    this.emit()
  }

  setConversation(history: Message[]): void {
    this.conversation = history
    this.contextRatio = estimateContextTokens(history, this.contextOverhead) / this.contextBudget.trigger
  }

  // ── 配置 ──

  /** 对应 desktop handleConfigUpdate：同步更新手里这份并存盘 */
  applyConfigUpdate(updates: Partial<AgentConfig>): void {
    for (const { key, value } of settingWrites(this.config, updates)) {
      solevupSaveSyncedSetting(key, value, false).catch((e) => console.warn('[Sync] 保存同步设置失败', e))
    }
    this.configVersion += 1
    this.config = updateConfig(this.config, updates)
    this.onConfigChanged?.()
    this.emit()
  }

  /** 同步进来的设置只更新配置，不写回同步表（规则见 synced-settings.ts） */
  async applySyncedSettings(): Promise<void> {
    const updates = configUpdatesFromSettings(await solevupListSyncedSettings(), this.config)
    if (Object.keys(updates).length === 0) return
    this.configVersion += 1
    this.config = updateConfig(this.config, updates)
    this.onConfigChanged?.()
    this.emit()
  }

  /** 启动时：用户改过默认值就写种子，再用同步表里的值 */
  async initSyncedSettings(): Promise<void> {
    const rows = await solevupListSyncedSettings()
    await Promise.all(
      seedWrites(rows, this.config, DEFAULT_CONFIG).map((w) => solevupSaveSyncedSetting(w.key, w.value, true)),
    )
    await this.applySyncedSettings()
  }

  /** 发送、开录前重读一次，别处直接存盘的配置也能生效（读的途中又改过就以手里这份为准） */
  async refreshConfig(): Promise<AgentConfig> {
    const version = this.configVersion
    const fresh = await loadConfig(this.config)
    if (version === this.configVersion) {
      const modeChanged = fresh.aiMode !== this.config.aiMode
      this.config = fresh
      if (modeChanged) this.onConfigChanged?.()
    }
    return this.config
  }
}
