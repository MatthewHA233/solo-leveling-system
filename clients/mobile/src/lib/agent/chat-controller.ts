// ══════════════════════════════════════════════
// ChatController — Fairy 全局状态（跨组件单例，对应 desktop App.tsx 里和聊天有关的部分）
//
// 这里只做组装和对外接口，流程都在各自的文件：
//   chat-core      共用状态、订阅
//   chat-sessions  会话转换、启动恢复、切换 / 新建 / 删除、写库改道、同步事件
//   chat-prompt    提示词取数
//   chat-send      发送主流程（打字和级联语音共用）
//   chat-distill   想法沉淀
//   chat-voice     按住说话
//   chat-omni      实时（实验）语音的回复
// React 侧用 use-chat-controller 订阅。
// ══════════════════════════════════════════════

import { startThoughtOutbox } from '../ai/anchor-outbox'
import { ensureModelCatalog } from '../models/registry'
import { saveFishApiKey } from '../voice'
import { loadConfig, type AgentConfig } from './agent-config'
import type { ChatSessionInfo } from './agent-memory'
import { ChatCore } from './chat-core'
import { createOmniFlow } from './chat-omni'
import { createPromptFlow } from './chat-prompt'
import { createSendFlow } from './chat-send'
import { createSessionFlow } from './chat-sessions'
import { createVoiceFlow } from './chat-voice'

class ChatControllerImpl {
  private readonly core = new ChatCore()
  private readonly sessionFlow = createSessionFlow(this.core, () => {
    this.voiceFlow.abortForSessionChange()
    this.omniFlow.reset()
  })
  private readonly promptFlow = createPromptFlow(this.core)
  private readonly omniFlow = createOmniFlow(this.core, this.sessionFlow, this.promptFlow)
  private readonly handleSend = createSendFlow(this.core, this.sessionFlow, this.promptFlow)
  private readonly voiceFlow = createVoiceFlow(
    this.core, this.sessionFlow, this.promptFlow, this.omniFlow, this.handleSend,
  )
  private initialized = false

  // ── 订阅 ──

  subscribe = (fn: () => void): (() => void) => this.core.subscribe(fn)
  getVersion = (): number => this.core.version

  // ── 读状态 ──

  get messages() { return this.core.messages }
  get sessionId() { return this.core.sessionId }
  get sessionTitle() { return this.core.sessionTitle }
  get sessions() { return this.core.sessions }
  get isProcessing() { return this.core.isProcessing }
  get fairyState() { return this.core.fairyState }
  get partialText() { return this.core.partialText }
  get config() { return this.core.config }
  get contextRatio() { return this.core.contextRatio }
  get jumpTo() { return this.core.jumpTo }
  get gazeTarget() { return this.core.gazeTarget }

  // ── 启动（app 启动调一次）──

  init = async (): Promise<void> => {
    if (this.initialized) return
    this.initialized = true

    const core = this.core
    core.config = await loadConfig()
    // 旧版 Fish Key 存在配置里，不同步：搬进 Key 库，其他设备才拿得到
    if (core.config.fishApiKey) {
      await saveFishApiKey(core.config.fishApiKey)
        .then(() => core.applyConfigUpdate({ fishApiKey: null }))
        .catch((e) => console.warn('[Chat] 迁移 Fish Key 失败', e))
    }
    core.onConfigChanged = () => {
      this.omniFlow.syncSubscription()
      // 实时模式建连时热读提示词：模式、人设一变就重算
      if (core.config.aiMode === 'omni') this.promptFlow.refreshSystemPrompt().catch(() => {})
    }
    this.omniFlow.syncSubscription()
    core.emit()

    void ensureModelCatalog()
    startThoughtOutbox()
    this.sessionFlow.subscribeDbChanges()
    await this.sessionFlow.boot()
    this.promptFlow.startPreheat()
  }

  // ── 配置（设置面板、模型中心、模式和朗读开关都走这里）──

  updateConfig = (updates: Partial<AgentConfig>): void => {
    this.core.applyConfigUpdate(updates)
  }

  toggleAiMode = (): void => {
    this.updateConfig({ aiMode: this.core.config.aiMode === 'omni' ? 'regular' : 'omni' })
  }

  toggleTts = (): void => {
    this.updateConfig({ ttsEnabled: !this.core.config.ttsEnabled })
  }

  // ── 发送（发送中再发送、按住说话、切会话都会打断正在进行的回复）──

  sendText = (text: string): Promise<void> => this.handleSend(text, false)

  clearGaze = (): void => {
    this.core.focusedCard = null
    this.core.gazeTarget = null
    this.core.emit()
  }

  /** 面板收起：消息列表要卸载，跳转目标不留到下次打开，否则重挂载时又跳一次 */
  clearJump = (): void => {
    this.core.jumpTo = null
  }

  // ── 语音 ──

  voicePressStart = (): void => this.voiceFlow.pressStart()
  voicePressEnd = (commit: boolean): void => this.voiceFlow.pressEnd(commit)
  voicePressCancel = (): void => this.voiceFlow.pressCancel()

  // ── 会话（SessionPicker 接线）──

  loadSessionsForPicker = (): void => this.sessionFlow.loadForPicker()
  selectSession = (id: string, jumpToTimestamp: string | undefined, session: ChatSessionInfo): Promise<void> =>
    this.sessionFlow.switchSession(id, jumpToTimestamp, session.title)
  newSession = (): Promise<void> => this.sessionFlow.newSession()
  deleteSession = (id: string): Promise<void> => this.sessionFlow.deleteSession(id)
  refreshSessions = (changedSessionId?: string): void => this.sessionFlow.refreshSessions(changedSessionId)
}

export const chatController = new ChatControllerImpl()
