// ══════════════════════════════════════════════
// Omni 实时（实验）语音的回复流程（对应 desktop App.tsx 的 omni://* 监听段）
// 只在 aiMode=omni 时订阅。打字在这个模式下仍走 chat-send 的常规模型。
//
// 和桌面端的差异：
//   · 音频在 native 播：不解码 PCM、不管 AudioContext；播完靠 omniPlaybackState，整段 WAV 靠 omniTakeAiAudio
//   · audio_done 之后等播完期间主人又开口：不再发 idle（桌面端会把「在听」盖掉）
//   · 中途断线也回到 idle。桌面端这种情况 Fairy 会一直停在思考
// ══════════════════════════════════════════════

import { randomUUID } from '../llm/uuid'
import { logModelUsage, realtimeUsageToDashScope, type RealtimeUsage } from '../models/model-audit'
import type { ModelCallLog } from '../llm/api'
import {
  omniPlaybackState,
  omniStop,
  omniTakeAiAudio,
  omniToolResult,
  subscribeOmni,
} from '../omni'
import { saveAudioFile } from '../voice'
import type { OmniDebugInfo } from '../../components/fairy/types'
import { waveformFromWavBase64 } from '../../components/fairy/fairy-format'
import type { SessionMessage } from './agent-memory'
import type { ChatCore } from './chat-core'
import type { PromptFlow } from './chat-prompt'
import { makeSessionMessage, type SessionFlow } from './chat-sessions'
import { executeAgentTool } from './tools'

const PLAYBACK_POLL_MS = 100
/** 连续播空这么久算播完（和 tts-pipeline 同一个余量） */
const PLAYBACK_TAIL_MS = 200
const PLAYBACK_TIMEOUT_MS = 60_000
const USAGE_WAIT_MS = 1500
const USAGE_POLL_MS = 80

export interface OmniFlow {
  /** 配置变了调用：按当前 aiMode 挂上或摘掉监听 */
  readonly syncSubscription: () => void
  /** 主人开口：之前那轮等播完的不再发 idle */
  readonly onPressStart: () => void
  /** 切会话：丢掉正在进行的这一轮 */
  readonly reset: () => void
  readonly markUsageStart: () => void
  readonly clearUsageStart: () => void
  readonly snapshot: () => OmniDebugInfo
  readonly getDebugInfo: () => OmniDebugInfo | null
  readonly setDebugInfo: (info: OmniDebugInfo | null) => void
  readonly markUserInputPending: () => void
  readonly markUserInputPersisted: () => void
  readonly setLastUserInput: (text: string) => void
}

export function createOmniFlow(core: ChatCore, sessions: SessionFlow, prompt: PromptFlow): OmniFlow {
  let unsubscribe: (() => void) | null = null
  let textAcc = ''
  let agentMsgId: string | null = null   // 当前 AI 回复气泡的消息 ID
  let debugInfo: OmniDebugInfo | null = null  // 本轮 Omni 上下文快照（随气泡写入）
  let lastUsage: ModelCallLog | null = null   // 本轮 Omni 模型审计快照（随气泡持久化）
  let usageStartedAt = 0                      // 本轮 Omni 调用起点，独立于按压时间
  let lastUserInput = ''                      // Omni 本轮用户输入（转写）
  let userInputPersisted = false
  let idleWaitToken = 0                       // 等播完期间主人又开口 / 切会话：旧的等待作废
  let waitingPlayback = false
  let awaitingConnection = false              // 主人开口后、新连接就绪前：事件队列里剩下的都是被打断那一轮的，丢掉

  const snapshot = (): OmniDebugInfo => {
    const cfg = core.config
    return {
      systemPrompt: core.systemPrompt,
      model: cfg.omniModel,
      voice: cfg.omniVoice || 'Tina',
      ts: new Date().toISOString(),
      items: [],
    }
  }

  const resetTurnState = () => {
    textAcc = ''
    agentMsgId = null
    lastUserInput = ''
    userInputPersisted = false
  }

  const finishBubble = (msgId: string | null) => {
    if (msgId) core.patchMessage(msgId, (m) => (m.streaming ? { ...m, streaming: false } : m))
  }

  /**
   * 这一轮等不到 audio_done 了（主人开口打断 / 切走实时模式）：native 换连接时旧连接不再发事件，
   * 这里给气泡收尾、把已有的文字落库；不清掉的话下一轮的文字会接到这个旧气泡上。
   */
  const closeInterruptedTurn = () => {
    const msgId = agentMsgId
    textAcc = ''
    agentMsgId = null
    if (!msgId) return
    const bubble = core.messages.find((m) => m.id === msgId)
    const partial = (bubble?.content ?? '').trim()
    core.patchMessage(msgId, (m) => ({
      ...m, streaming: false, ...(m.content ? { content: `${m.content}……（被打断）` } : {}),
    }))
    if (partial) {
      sessions.persistRows(core.sessionId, [{
        ...makeSessionMessage('assistant', partial),
        id: msgId,
        timestamp: bubble?.timestamp ?? new Date().toISOString(),
      }]).catch((e) => console.warn('[Omni] 被打断的回复写入失败', e))
    }
  }

  /** 用真实播放状态等候：audio_done 之后可能还有音频在队列里 */
  const waitPlaybackThenIdle = () => {
    const token = ++idleWaitToken
    const startedAt = Date.now()
    waitingPlayback = true
    const check = () => {
      if (token !== idleWaitToken) return
      const finish = () => {
        waitingPlayback = false
        core.emitFairy('idle')
      }
      if (Date.now() - startedAt >= PLAYBACK_TIMEOUT_MS) {
        finish()
        return
      }
      omniPlaybackState().then((st) => {
        if (token !== idleWaitToken) return
        if (!st.hasAudio || st.drainedMs >= PLAYBACK_TAIL_MS) finish()
        else setTimeout(check, PLAYBACK_POLL_MS)
      }).catch(() => {
        if (token === idleWaitToken) finish()
      })
    }
    check()
  }

  const onAudioDone = () => {
    const msgId = agentMsgId
    const userInput = lastUserInput.trim()
    const alreadyPersisted = userInputPersisted
    const aiText = (msgId ? core.messages.find((m) => m.id === msgId)?.content ?? '' : '').trim()
    const debugSnap = debugInfo ?? undefined
    const aiMsgTimestamp = (msgId ? core.messages.find((m) => m.id === msgId)?.timestamp : null) ?? new Date().toISOString()
    textAcc = ''
    agentMsgId = null

    if (msgId) {
      // 给已有气泡收尾（兜底：text_chunk 时若快照还为空则在此补上）
      core.patchMessage(msgId, (m) => ({
        ...m, streaming: false, ...(debugSnap && !m.omniDebugInfo ? { omniDebugInfo: debugSnap } : {}),
      }))
    }
    core.setProcessing(false)
    waitPlaybackThenIdle()
    // 对话完成后刷新 system prompt，确保下一次 session 的 instructions 包含本轮对话
    prompt.refreshSystemPrompt().catch(() => {})

    // ── Omni 持久化：保存本轮 user input + assistant 回复 ──
    const sid = core.sessionId
    const persistTurn = async () => {
      const newPairs: SessionMessage[] = []
      if (userInput && !alreadyPersisted) newPairs.push(makeSessionMessage('user', userInput))

      // AI 音频落盘后再写 DB；usage 若稍晚到（最多等 1500ms）也能附上
      const wav = await omniTakeAiAudio().catch(() => null)
      let aiAudioPath: string | undefined
      if (wav && sid) {
        // 落盘失败不阻塞
        aiAudioPath = await saveAudioFile(sid, wav.wavBase64, aiMsgTimestamp).catch(() => undefined)
      }
      let bubbleId = msgId
      if (wav) {
        const audio = {
          path: aiAudioPath ?? null,
          durationMs: wav.durationMs,
          waveform: waveformFromWavBase64(wav.wavBase64),
        }
        if (msgId) {
          core.patchMessage(msgId, (m) => ({ ...m, audio }))
        } else {
          // 极少情况：没有文字但有音频，建新气泡
          bubbleId = randomUUID()
          const id = bubbleId
          core.setMessages((prev) => [...prev, {
            id, role: 'agent', content: '', audio, timestamp: aiMsgTimestamp,
            ...(debugSnap ? { omniDebugInfo: debugSnap } : {}),
          }])
        }
      }
      if (aiText || aiAudioPath) {
        let usage = lastUsage
        if (!usage) {
          const deadline = Date.now() + USAGE_WAIT_MS
          while (!usage && Date.now() < deadline) {
            await new Promise<void>((r) => setTimeout(r, USAGE_POLL_MS))
            usage = lastUsage
          }
        }
        const aiMsg: SessionMessage = {
          ...makeSessionMessage('assistant', aiText, aiAudioPath, wav?.durationMs),
          id: bubbleId ?? randomUUID(),
          timestamp: aiMsgTimestamp,
        }
        newPairs.push(usage ? { ...aiMsg, usage } : aiMsg)
        lastUsage = null
      }
      if (newPairs.length > 0) await sessions.persistRows(sid, newPairs)
    }
    persistTurn()
      .catch((e) => console.warn('[Omni] 本轮写入失败', e))
      .finally(() => {
        // 主人已经开始下一句：lastUserInput 是新一轮的，不能清
        if (lastUserInput.trim() === userInput) {
          lastUserInput = ''
          userInputPersisted = false
        }
      })
  }

  const callbacks: Parameters<typeof subscribeOmni>[0] = {
    onText: (delta) => {
      if (awaitingConnection) return
      textAcc += delta
      core.emitFairy('speaking')

      // 第一条 text.delta：立刻建气泡（附带本轮 debug 快照）
      if (!agentMsgId) {
        const id = randomUUID()
        agentMsgId = id
        // 确保 debug 快照存在；若为空则就地补建（兜底）
        if (!debugInfo) debugInfo = snapshot()
        const debugSnap = debugInfo
        const content = textAcc
        core.setMessages((prev) => [...prev, {
          id, role: 'agent', content, streaming: true,
          timestamp: new Date().toISOString(),
          omniDebugInfo: debugSnap,
        }])
      } else {
        // 后续 delta：实时更新文字
        const content = textAcc
        core.patchMessage(agentMsgId, (m) => ({ ...m, content }), true)
      }
    },

    // Omni 原生工具调用：WS 端触发 → 这里执行 → omniToolResult 回传
    onToolCall: (payload) => {
      if (awaitingConnection) return
      void (async () => {
        console.log('[Omni] tool_call', payload.name)
        core.emitFairy('thinking')
        let argsPreview = payload.arguments
        try { argsPreview = JSON.stringify(JSON.parse(payload.arguments), null, 0) } catch {}
        const toolMsgId = `tool-${payload.call_id}`
        core.addSystemNote(`⚙ ${payload.name}(${argsPreview})`, toolMsgId)
        let result: string
        try {
          result = await executeAgentTool(payload.name, payload.arguments)
        } catch (err) {
          result = `工具执行失败：${err instanceof Error ? err.message : String(err)}`
        }
        const preview = result.length > 300 ? result.slice(0, 300) + '…' : result
        core.patchMessage(toolMsgId, (m) => ({ ...m, content: m.content + `\n→ ${preview}` }))
        try {
          await omniToolResult(payload.call_id, result)
        } catch (err) {
          console.error('[Omni] omni_tool_result failed', err)
        }
      })()
    },

    // Omni Realtime 一轮结束携带 usage：写入审计 + 立即贴到当前 agent 气泡
    onUsage: (model, usage) => {
      const startedMs = usageStartedAt || Date.now()
      void logModelUsage({
        feature: 'fairy_omni_chat',
        modelId: model,
        startedAt: new Date(startedMs).toISOString(),
        durationMs: Date.now() - startedMs,
        usage: realtimeUsageToDashScope(usage as RealtimeUsage),
        success: true,
        metadata: { source: 'omni-realtime' },
      }).then((call) => {
        if (!call) return
        lastUsage = call
        // 优先贴到当前在写的气泡，否则兜底到最后一条 agent 气泡
        const targetId = agentMsgId
          ?? [...core.messages].reverse().find((m) => m.role === 'agent')?.id
          ?? null
        if (targetId) core.patchMessage(targetId, (m) => ({ ...m, usage: call }))
      }).finally(() => {
        if (usageStartedAt === startedMs) usageStartedAt = 0
      })
    },

    onStatus: (status, message) => {
      if (status === 'connected') {
        awaitingConnection = false
      } else if (status === 'audio_done') {
        if (!awaitingConnection) onAudioDone()
      } else if (status === 'error') {
        const msgId = agentMsgId
        resetTurnState()
        finishBubble(msgId)
        core.addSystemNote(`Omni 错误: ${message ?? '未知'}`)
        idleWaitToken += 1
        waitingPlayback = false
        core.setProcessing(false)
        core.emitFairy('idle')
      } else if (status === 'disconnected') {
        // 回复途中断线（没等到 audio_done）。等播完期间、录音期间的断开是正常的换连接
        if (waitingPlayback || core.fairyState === 'listening' || core.fairyState === 'idle') return
        const msgId = agentMsgId
        resetTurnState()
        finishBubble(msgId)
        core.setProcessing(false)
        core.emitFairy('idle')
      }
    },
  }

  return {
    syncSubscription: () => {
      if (core.config.aiMode === 'omni') {
        if (!unsubscribe) unsubscribe = subscribeOmni(callbacks)
      } else if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
        // 回复途中切走：退订后收不到 audio_done，气泡和 Fairy 都会停在半路。连接也停掉，别继续播
        idleWaitToken += 1
        waitingPlayback = false
        closeInterruptedTurn()
        void omniStop()
        if (!core.isProcessing && core.fairyState !== 'listening') core.emitFairy('idle')
      }
    },
    onPressStart: () => {
      idleWaitToken += 1
      waitingPlayback = false
      debugInfo = null
      closeInterruptedTurn()
      // 只有实时模式才会有新连接（connected 清这个标志）；级联模式下没有监听，不用管
      awaitingConnection = core.config.aiMode === 'omni'
    },
    reset: () => {
      idleWaitToken += 1
      waitingPlayback = false
      const msgId = agentMsgId
      resetTurnState()
      finishBubble(msgId)
      usageStartedAt = 0
      lastUsage = null
      debugInfo = null
    },
    markUsageStart: () => { usageStartedAt = Date.now() },
    clearUsageStart: () => { usageStartedAt = 0 },
    snapshot,
    getDebugInfo: () => debugInfo,
    setDebugInfo: (info) => { debugInfo = info },
    markUserInputPending: () => { userInputPersisted = false },
    markUserInputPersisted: () => { userInputPersisted = true },
    setLastUserInput: (text) => { lastUserInput = text },
  }
}
