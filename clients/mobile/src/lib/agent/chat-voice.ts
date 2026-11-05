// ══════════════════════════════════════════════
// 语音流程（对应 desktop App.tsx 的 getVoiceService 回调 + 右 Alt 长按逻辑）
//
// 级联（默认）：按住 → 流式 ASR 边说边出字 → 松手定稿 → 文字进 chat-send（和打字同一个大脑）→ 回复朗读
// 实时（实验）：按住 → 音频直送 Omni WS → 回复走 chat-omni
//
// 和桌面端的差异：
//   · 触发换成手势：TabBar 长按 320ms 才开始，所以按下即开录、立刻进 listening（桌面端先开录，600ms 后才给反馈）
//   · 松手去抖（RELEASE_DEBOUNCE）不搬：那是蓝牙键盘假 keyup 的问题；误触靠 App / AgentPanel 的最短 500ms 判断
//   · 录音气泡没有 blob URL：波形由 waveformFromWavBase64 算，落盘后才能回放
//   · 取消时把边说边出字留下的那条气泡收掉（桌面端会留一条没发出去的话在屏幕上）
// ══════════════════════════════════════════════

import { logModelUsage } from '../models/model-audit'
import { omniStop } from '../omni'
import { withImageMarker } from './chat-images'
import {
  buildAsrContext,
  createVoiceService,
  saveAudioFile,
  type VoiceService,
} from '../voice'
import { waveformFromWavBase64 } from '../../components/fairy/fairy-format'
import type { OmniDebugItem } from '../../components/fairy/types'
import type { ChatCore } from './chat-core'
import type { OmniFlow } from './chat-omni'
import type { PromptFlow } from './chat-prompt'
import type { HandleSend } from './chat-send'
import { makeSessionMessage, type SessionFlow } from './chat-sessions'
import { TOOL_DEFINITIONS } from './tools'

function toRealtimeTools(tools: typeof TOOL_DEFINITIONS) {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }))
}

export interface VoiceFlow {
  readonly pressStart: () => void
  /** commit = 在发送区松手且按够了时长；否则取消 */
  readonly pressEnd: (commit: boolean) => void
  /** 手势被系统打断：录音和回复都停 */
  readonly pressCancel: () => void
  /** 切会话：丢掉还没变成消息的录音 */
  readonly abortForSessionChange: () => void
}

export function createVoiceFlow(
  core: ChatCore,
  sessions: SessionFlow,
  prompt: PromptFlow,
  omni: OmniFlow,
  handleSend: HandleSend,
): VoiceFlow {
  let service: VoiceService | null = null
  // 语音气泡录音的落盘任务（消息 id → 落盘结果）：定稿文本可能比落盘先到，持久化前要等它
  const audioSaves = new Map<string, Promise<{ audioPath: string; durationMs: number } | null>>()
  // 语音消息的录音时刻：入库用它当时间戳，保证用户语音排在 AI 回复前面（转写晚到 / 兜底入库时也不乱序）
  const recordedAt = new Map<string, string>()
  /** 这次按住产生的中间结果气泡（还没拿到录音） */
  let partialMsgId: string | null = null

  const setPartial = (text: string) => {
    core.partialText = text
    core.emit()
  }

  const dropPartialBubble = () => {
    const id = partialMsgId
    partialMsgId = null
    if (id) core.setMessages((prev) => prev.filter((m) => m.id !== id))
  }

  const getService = (): VoiceService => {
    if (service) return service
    service = createVoiceService(
      () => core.config,
      () => core.systemPrompt,
      {
        onPhaseChange: (phase) => {
          core.emitFairy(phase)
        },
        onPartialTranscript: (text, sessionMsgId) => {
          // 边说边出字：先以文字气泡出现，录音到手后变成语音气泡（同一条消息 id）
          partialMsgId = sessionMsgId
          core.partialText = text
          core.upsertStreaming(
            sessionMsgId,
            (m) => (m.audio ? { ...m, audio: { ...m.audio, transcript: text } } : { ...m, content: text }),
            () => ({ id: sessionMsgId, role: 'user', content: text, timestamp: new Date().toISOString() }),
          )
        },
        onAsrResult: (r, startedAt) => {
          const u = r.usage
          void logModelUsage({
            feature: 'fairy_voice_asr',
            modelId: r.model,
            startedAt,
            durationMs: r.timings.totalMs,
            usage: u ? {
              prompt_tokens: u.input_tokens,
              completion_tokens: u.output_tokens,
              total_tokens: u.input_tokens + u.output_tokens,
              prompt_tokens_details: { audio_tokens: u.input_tokens },
            } : null,
            success: r.text.trim().length > 0,
            errorMessage: r.text.trim() ? null : (r.hadSpeech ? '有声音但没识别出文字' : '没有录到声音'),
            metadata: {
              timings: r.timings, attempts: r.attempts, fallback: r.fallback,
              device: r.device, audioMs: r.durationMs, hadSpeech: r.hadSpeech,
              glitches: r.glitches, captureRestarts: r.captureRestarts,
            },
          })
        },
        onUserAudio: (wavBase64, durationMs, sessionMsgId) => {
          // 作为用户语音气泡显示；边说边出字时气泡已存在，就地补上音频
          partialMsgId = null
          const existing = core.messages.find((m) => m.id === sessionMsgId)
          const msgTimestamp = existing?.timestamp ?? new Date().toISOString()
          recordedAt.set(sessionMsgId, msgTimestamp)
          const waveform = waveformFromWavBase64(wavBase64)
          if (existing) {
            core.patchMessage(sessionMsgId, (m) => ({
              ...m,
              content: '',
              audio: { durationMs, waveform, transcript: m.audio?.transcript ?? m.content },
            }))
          } else {
            core.setMessages((prev) => [...prev, {
              id: sessionMsgId, role: 'user', content: '',
              audio: { durationMs, waveform }, timestamp: msgTimestamp,
            }])
          }

          // 异步落盘；onTranscript 持久化前会等它
          const sid = core.sessionId
          if (sid) {
            audioSaves.set(sessionMsgId, saveAudioFile(sid, wavBase64, msgTimestamp).then((audioPath) => {
              core.patchMessage(sessionMsgId, (m) => (m.audio ? { ...m, audio: { ...m.audio, path: audioPath } } : m))
              return { audioPath, durationMs }
            }).catch((e) => {
              console.warn('[Voice] 录音落盘失败，消息仍会保存文字', e)
              return null
            }))
          }
          // Omni 模式：把音频 item 追加到已有快照（按下时已创建快照）
          if (core.config.aiMode === 'omni') {
            const audioItem: OmniDebugItem = { type: 'audio', wavBase64, durationMs, ts: new Date().toISOString() }
            const info = omni.getDebugInfo() ?? omni.snapshot()
            omni.setDebugInfo({ ...info, items: [...info.items, audioItem] })
          }
        },
        onTranscript: (text, sessionMsgId) => {
          const isOmniMode = core.config.aiMode === 'omni'
          if (isOmniMode) omni.markUserInputPending()
          partialMsgId = null
          setPartial('')
          // 起标题按「主人说了几句」数；没转写出文字的那句不算
          if (text.trim()) sessions.titleFlow.onUserMessage(text)
          // 待发的图片跟这句语音一起发。实时语音发不了图，留在输入框
          const images = !isOmniMode && text.trim() ? core.takeVoiceImages() : []
          const bubbleImages = images.map(({ id, uri }) => ({ id, uri }))
          // 更新用户气泡的转写文字
          core.patchMessage(sessionMsgId, (m) => ({
            ...(m.audio ? { ...m, audio: { ...m.audio, transcript: text } } : { ...m, content: text }),
            ...(bubbleImages.length > 0 ? { images: bubbleImages } : {}),
          }))

          // 语音消息持久化：等录音落盘拿到 audioPath（落盘失败也照样存文字，别丢主人说的话）
          const sid = core.sessionId
          if (sid) {
            const saving = audioSaves.get(sessionMsgId) ?? Promise.resolve(null)
            audioSaves.delete(sessionMsgId)
            const timestamp = recordedAt.get(sessionMsgId)
            recordedAt.delete(sessionMsgId)
            if (isOmniMode) omni.markUserInputPersisted()
            void saving.then((saved) => sessions.persistRows(sid, [{
              ...makeSessionMessage('user', withImageMarker(text, images.map((i) => i.id)), saved?.audioPath, saved?.durationMs),
              id: sessionMsgId,
              ...(timestamp ? { timestamp } : null),
            }])).catch((e) => console.warn('[Voice] 语音消息持久化失败', e))
          }

          // Omni 模式：音频已经走 WS，工具调用走 omni://tool_call 事件，不回落 handleSend
          if (isOmniMode) {
            omni.setLastUserInput(text)   // 供 audio_done 持久化使用
          } else {
            void handleSend(text, true, images)
          }
        },
        onOmniCommitted: () => omni.onCommitted(),
        onAudioLevel: () => {
          // 音量走 voice://level 事件直接给 FairyOrb / ListeningBar，这里不用处理
        },
        onError: (message) => {
          omni.clearUsageStart()
          core.addSystemNote(message)
          core.emitFairy('idle')
        },
      },
      () => toRealtimeTools(TOOL_DEFINITIONS),
      () => ({ vocabulary: core.asrVocabulary, context: buildAsrContext(core.conversation) }),
    )
    return service
  }

  omni.setVoiceCancel(() => { service?.cancel() })

  const cancelService = () => {
    service?.cancel()
    omni.clearUsageStart()
    dropPartialBubble()
    setPartial('')
  }

  return {
    pressStart: () => {
      // Fairy 正在想或正在说：主人一开口就停下（打断）
      core.replyControl?.interrupt()
      core.replyControl = null
      omni.onPressStart()
      // 实时模式的回复音频在 native 播：按下就停，不等新连接建立
      if (core.config.aiMode === 'omni') void omniStop()
      partialMsgId = null
      setPartial('')
      core.emitFairy('listening')  // 立即给视觉反馈，不等 mic 权限
      // 配置读取和开录并行：getConfig 是同步的，设置面板的改动已经在 core.config 里，这次重读只是兜底
      core.refreshConfig().catch(() => {})
      void getService().startRecording()

      // Omni 语音模式：提前刷 system prompt 并写 debug 快照（onUserAudio 无法知道 systemPrompt）
      if (core.config.aiMode === 'omni') {
        omni.markUsageStart()
        prompt.refreshSystemPrompt().then(() => {
          omni.setDebugInfo({ ...omni.snapshot(), items: omni.getDebugInfo()?.items ?? [] })
        }).catch(() => {})
      }
    },

    pressEnd: (commit) => {
      setPartial('')
      const svc = service
      if (commit && svc && core.fairyState === 'listening') {
        void svc.stopAndProcess()
      } else if (commit && svc?.getPhase() === 'thinking') {
        // 录音已经自己结束（满 90 秒 / 麦克风中断）并交给了回复，松手时别把它取消掉
      } else {
        cancelService()
        core.emitFairy('idle')
      }
    },

    pressCancel: () => {
      core.replyControl?.interrupt()
      core.replyControl = null
      cancelService()
      void omniStop()
      core.emitFairy('idle')
    },

    abortForSessionChange: () => {
      if (!service || service.getPhase() === 'idle') return
      cancelService()
    },
  }
}
