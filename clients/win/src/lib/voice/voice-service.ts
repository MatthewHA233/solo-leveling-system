// ══════════════════════════════════════════════
// Voice Service — 语音管线编排
//
// 流程 A（默认）: 录音 → qwen-ASR 转写 → onTranscript → handleSend
// 流程 B（aiMode=omni）: 流式录音 → Omni WS → 转写 → onTranscript → handleSend
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type { AgentConfig } from '../agent/agent-config'
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

  const setPhase = (p: VoicePhase) => {
    phase = p
    callbacks.onPhaseChange(p)
  }

  // ── Omni 模式：等待 AI 音频回复完成 ──
  const waitOmniAudioDone = (timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      let unlisten: (() => void) | null = null
      const timer = setTimeout(() => { unlisten?.(); resolve() }, timeoutMs)
      listen<{ status: string }>('omni://status', (e) => {
        if (e.payload.status === 'audio_done' || e.payload.status === 'disconnected' || e.payload.status === 'error') {
          clearTimeout(timer)
          unlisten?.()
          resolve()
        }
      }).then((fn) => { unlisten = fn })
    })

  const startRecording = async () => {
    sessionSeq++
    if (phase !== 'idle') phase = 'idle'

    const config = getConfig()

    const omniApiKey = config.omniApiKey || config.openaiApiKey
    if (config.aiMode === 'omni' && omniApiKey) {
      // ── Omni 全模态模式：流式录音 → Omni WS → 转写 ──
      streamRecorder = createStreamingRecorder()
      try {
        await invoke('omni_connect', {
          apiKey: omniApiKey,
          model: config.omniModel,
          voice: config.omniVoice || '',
          systemPrompt: getSystemPrompt(),
          tools: getOmniTools(),
        })
        omniPcmChunks = []
        omniRecordStartMs = Date.now()
        await streamRecorder.start({
          onChunk: (pcm16) => {
            omniPcmChunks.push(pcm16)
            invoke('omni_send_audio', { pcmBase64: pcm16ToBase64(pcm16) }).catch(() => {})
          },
        })
        setPhase('listening')
      } catch (err) {
        callbacks.onError(`Omni ASR 启动失败: ${err instanceof Error ? err.message : String(err)}`)
        streamRecorder = null
        invoke('omni_stop').catch(() => {})
      }
    } else {
      // ── 默认批量录音 ──
      batchRecorder = createVoiceRecorder()
      try {
        await batchRecorder.start()
        setPhase('listening')
      } catch (err) {
        batchRecorder = null
        callbacks.onError(`麦克风访问失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const stopAndProcess = async () => {
    if (phase !== 'listening') return
    setPhase('thinking')

    const mySeq = sessionSeq
    const sessionMsgId = crypto.randomUUID()
    const config = getConfig()

    if (config.aiMode === 'omni' && streamRecorder) {
      // ── Omni 流式 ASR 收尾 ──
      await streamRecorder.stop()
      streamRecorder = null

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

      // 监听本次 session 的用户转写，更新已有气泡（一次性）
      listen<{ text: string }>('omni://user_transcript', ({ payload }) => {
        if (mySeq === sessionSeq && payload.text.trim() && callbacks.onTranscript) {
          callbacks.onTranscript(payload.text.trim(), sessionMsgId)
        }
      }).then((unlisten) => {
        // 等 audio_done 后自动解除
        waitOmniAudioDone(30_000).finally(() => unlisten())
      })

      // Omni 模式：AI 直接生成回复（音频+文字），等待 audio_done 信号
      await waitOmniAudioDone(30_000)
      if (mySeq !== sessionSeq) return
      setPhase('idle')
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

      if (config.openaiApiKey) {
        try {
          const asrKey = config.asrApiKey ?? config.openaiApiKey ?? ''
          const transcript = await invoke<string>('qwen_asr_transcribe', {
            wavBase64: result.wavBase64,
            apiKey: asrKey,
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
