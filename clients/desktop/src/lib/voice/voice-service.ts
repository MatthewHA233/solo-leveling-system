// ══════════════════════════════════════════════
// Voice Service — 语音管线编排
//
// 流程 A（默认）: 录音 → qwen-ASR 转写 → onTranscript → handleSend
// 流程 B（aiMode=omni）: 流式录音 → Omni WS → 转写 → onTranscript → handleSend
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { getAsrApiKey, getOmniApiKey, type AgentConfig } from '../agent/agent-config'
import { getFeatureModel } from '../model-audit'
import { createVoiceRecorder, createStreamingRecorder, pcm16ChunksToWavBlob } from './voice-recorder'
import type { VoiceRecorder, StreamingVoiceRecorder } from './voice-recorder'

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface VoiceCallbacks {
  readonly onPhaseChange: (phase: VoicePhase) => void
  readonly onAudioLevel: (level: number) => void
  readonly onError: (message: string) => void
  /** 录音完成后立即触发，展示音频气泡；sessionMsgId 用于后续 transcript 关联 */
  readonly onUserAudio?: (wavBase64: string, durationMs: number, sessionMsgId: string) => void
  /** ASR 转写完成后触发，与对应音频气泡的 sessionMsgId 匹配 */
  readonly onTranscript?: (text: string, sessionMsgId: string) => void
}

export interface VoiceService {
  readonly startRecording: () => Promise<void>
  readonly stopAndProcess: () => Promise<void>
  readonly cancel: () => void
  readonly getPhase: () => VoicePhase
  readonly getAudioLevel: () => number
}

// ASR WebSocket 端点
const ASR_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'

// PCM16 Uint8Array → base64
function pcm16ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function createVoiceService(
  getConfig: () => AgentConfig,
  getSystemPrompt: () => string,
  callbacks: VoiceCallbacks,
  getOmniTools: () => unknown = () => [],
): VoiceService {
  let phase: VoicePhase = 'idle'
  let batchRecorder: VoiceRecorder | null = null
  let streamRecorder: StreamingVoiceRecorder | null = null
  let omniPcmChunks: Uint8Array[] = []   // Omni 录音 PCM 缓冲，用于生成用户气泡音频
  let omniRecordStartMs = 0

  // Session 隔离：每次新录音自增，旧 session 的所有异步回调检查此值后放弃执行
  let sessionSeq = 0
  let startingSeq: number | null = null
  // 启动（连 WS / 开麦克风）还没完成就松开了：记下来，启动完成后立刻收尾，不静默丢弃
  let stopRequestedSeq: number | null = null
  let micOpenMs = 0

  const setPhase = (p: VoicePhase) => {
    phase = p
    callbacks.onPhaseChange(p)
  }

  const clearStarting = (seq: number) => {
    if (startingSeq === seq) startingSeq = null
  }

  // ── Omni 模式：等待 AI 音频回复完成 ──
  const waitOmniAudioDone = (timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      let unlisten: (() => void) | null = null
      let done = false
      const finish = () => {
        if (done) return
        done = true
        unlisten?.()
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      listen<{ status: string }>('omni://status', (e) => {
        if (e.payload.status === 'audio_done' || e.payload.status === 'disconnected' || e.payload.status === 'error') {
          clearTimeout(timer)
          finish()
        }
      }).then((fn) => {
        if (done) { fn(); return }
        unlisten = fn
      })
    })

  const startRecording = async () => {
    sessionSeq++
    const mySeq = sessionSeq
    startingSeq = mySeq
    if (phase !== 'idle') phase = 'idle'

    const config = getConfig()

    const omniApiKey = getOmniApiKey(config)
    if (config.aiMode === 'omni' && omniApiKey) {
      // ── Omni 全模态模式：流式录音 → Omni WS → 转写 ──
      // 用局部 sr，防止 await 期间 cancel()/stopAndProcess() 把闭包 streamRecorder 置 null
      const sr = createStreamingRecorder()
      streamRecorder = sr
      omniPcmChunks = []
      omniRecordStartMs = Date.now()
      // 麦克风与 WS 并行启动：开麦克风常要 1~2 秒，串在连接后面会吞掉按住后的前几秒。
      // WS 就绪前录到的块先攒着，连上后按顺序补发
      let wsReady = false
      const unsent: Uint8Array[] = []
      const sendChunk = (pcm16: Uint8Array) => {
        invoke('omni_send_audio', { pcmBase64: pcm16ToBase64(pcm16) }).catch(() => {})
      }
      try {
        const omniModel = await getFeatureModel('fairy_omni_chat', config.omniModel)
        if (mySeq !== sessionSeq || streamRecorder !== sr) {
          clearStarting(mySeq)
          return
        }
        const micT0 = Date.now()
        await Promise.all([
          invoke('omni_connect', {
            apiKey: omniApiKey,
            model: omniModel,
            voice: config.omniVoice || '',
            systemPrompt: getSystemPrompt(),
            tools: getOmniTools(),
          }).then(() => {
            wsReady = true
            if (mySeq === sessionSeq) unsent.splice(0).forEach(sendChunk)
          }),
          sr.start({
            onChunk: (pcm16) => {
              omniPcmChunks.push(pcm16)
              if (wsReady) sendChunk(pcm16)
              else unsent.push(pcm16)
            },
          }).then(() => { micOpenMs = Date.now() - micT0 }),
        ])
        if (mySeq !== sessionSeq || streamRecorder !== sr) {
          clearStarting(mySeq)
          await sr.stop().catch(() => {})
          invoke('omni_stop').catch(() => {})
          return
        }
        clearStarting(mySeq)
        setPhase('listening')
        if (stopRequestedSeq === mySeq) {
          stopRequestedSeq = null
          void stopAndProcess()
        }
      } catch (err) {
        await sr.stop().catch(() => {})
        if (mySeq !== sessionSeq) {
          clearStarting(mySeq)
          return
        }
        clearStarting(mySeq)
        stopRequestedSeq = null
        callbacks.onError(`Omni ASR 启动失败: ${err instanceof Error ? err.message : String(err)}`)
        if (streamRecorder === sr) streamRecorder = null
        invoke('omni_stop').catch(() => {})
        setPhase('idle')
      }
    } else {
      // ── 默认批量录音 ──
      const br = createVoiceRecorder()
      batchRecorder = br
      try {
        await br.start()
        if (mySeq !== sessionSeq || batchRecorder !== br) {
          clearStarting(mySeq)
          await br.stop().catch(() => {})
          return
        }
        clearStarting(mySeq)
        setPhase('listening')
        if (stopRequestedSeq === mySeq) {
          stopRequestedSeq = null
          void stopAndProcess()
        }
      } catch (err) {
        if (mySeq !== sessionSeq) {
          clearStarting(mySeq)
          return
        }
        clearStarting(mySeq)
        stopRequestedSeq = null
        if (batchRecorder === br) batchRecorder = null
        callbacks.onError(`麦克风访问失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const stopAndProcess = async () => {
    if (phase !== 'listening') {
      // 还在启动中就松开：不丢弃，等启动完成后由 startRecording 接着收尾
      if (startingSeq != null) stopRequestedSeq = startingSeq
      return
    }
    setPhase('thinking')

    const mySeq = sessionSeq
    const sessionMsgId = crypto.randomUUID()
    const config = getConfig()

    if (config.aiMode === 'omni' && streamRecorder) {
      // ── Omni 流式 ASR 收尾 ──
      await streamRecorder.stop()
      streamRecorder = null

      // 一块都没录到（麦克风刚开就松手）：不去 commit 空缓冲，否则服务端只回一句看不懂的错误
      if (omniPcmChunks.length === 0) {
        invoke('omni_stop').catch(() => {})
        callbacks.onError(`没录到声音：麦克风打开用了 ${micOpenMs} ms，松开时还没开始录。按住右 Alt 稍等再开口`)
        setPhase('idle')
        return
      }

      // 立刻生成用户语音气泡（先无文字，transcript 到来后由 App.tsx 更新）
      const durationMs = Date.now() - omniRecordStartMs
      if (omniPcmChunks.length > 0 && callbacks.onUserAudio) {
        const blob = pcm16ChunksToWavBlob(omniPcmChunks, 16000)
        const reader = new FileReader()
        reader.readAsDataURL(blob)
        await new Promise<void>((resolve) => {
          reader.onload = () => {
            const dataUrl = reader.result as string
            const base64 = dataUrl.split(',')[1]
            callbacks.onUserAudio!(base64, durationMs, sessionMsgId)
            resolve()
          }
        })
      }
      omniPcmChunks = []

      try {
        await invoke('omni_commit')
      } catch (err) {
        if (mySeq !== sessionSeq) return
        callbacks.onError(`Omni commit 失败: ${err instanceof Error ? err.message : String(err)}`)
        setPhase('idle')
        return
      }

      // 监听本次 session 的用户转写，更新已有气泡（一次性，audio_done 后自动解除）
      let transcriptUnlisten: (() => void) | null = null
      let transcriptDisposed = false
      listen<{ text: string }>('omni://user_transcript', ({ payload }) => {
        if (mySeq === sessionSeq && payload.text.trim() && callbacks.onTranscript) {
          callbacks.onTranscript(payload.text.trim(), sessionMsgId)
        }
      }).then((u) => {
        if (transcriptDisposed) { u(); return }
        transcriptUnlisten = u
      })
      waitOmniAudioDone(30_000).finally(() => {
        transcriptDisposed = true
        transcriptUnlisten?.()
      })

      // Omni 模式：AI 直接生成回复（音频+文字），等待 audio_done 信号
      // 注意：不在此处 setPhase('idle')。audio_done 只表示 WS 上游推流完成，
      // 实际音频还在 AudioContext 队列里播放。idle 由 App.tsx 的 omni://status
      // 处理器在 src.onended 后统一发出，避免气泡/动画提前结束。
      await waitOmniAudioDone(30_000)
      if (mySeq !== sessionSeq) return
    } else {
      // ── 默认批量 ASR ──
      const result = await batchRecorder?.stop() ?? null
      batchRecorder = null

      if (mySeq !== sessionSeq) return

      if (!result) {
        callbacks.onError('录音过短或无声，已取消')
        setPhase('idle')
        return
      }

      callbacks.onUserAudio?.(result.wavBase64, result.durationMs, sessionMsgId)

      const asrApiKey = getAsrApiKey(config)
      if (asrApiKey) {
        try {
          const transcript = await invoke<string>('qwen_asr_transcribe', {
            wavBase64: result.wavBase64,
            apiKey: asrApiKey,
            model: config.asrModel,
            wsUrl: ASR_WS_URL,
          })

          if (mySeq !== sessionSeq) return

          if (transcript.trim()) {
            callbacks.onTranscript?.(transcript.trim(), sessionMsgId)
          }
        } catch (err) {
          if (mySeq !== sessionSeq) return
          callbacks.onError(`语音转文字失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (mySeq !== sessionSeq) return
      setPhase('idle')
    }
  }

  const cancel = () => {
    sessionSeq++
    startingSeq = null
    stopRequestedSeq = null
    if (batchRecorder) { batchRecorder.stop(); batchRecorder = null }
    if (streamRecorder) { streamRecorder.stop().catch(() => {}); streamRecorder = null }
    invoke('omni_stop').catch(() => {})
    setPhase('idle')
  }

  const getAudioLevel = (): number => {
    if (batchRecorder && phase === 'listening') return batchRecorder.getAudioLevel()
    if (streamRecorder && phase === 'listening') return streamRecorder.getAudioLevel()
    return 0
  }

  return {
    startRecording,
    stopAndProcess,
    cancel,
    getPhase: () => phase,
    getAudioLevel,
  }
}
