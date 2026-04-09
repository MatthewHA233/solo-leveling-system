// ══════════════════════════════════════════════
// Voice Service — 语音管线编排
//
// 流程: 录音 → 展示音频气泡 → Qwen-ASR 转写 → 展示文字
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import type { AgentConfig } from '../agent/agent-config'
import { createVoiceRecorder } from './voice-recorder'
import type { VoiceRecorder } from './voice-recorder'

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

// ASR WebSocket 端点（需要在 Rust 后端发起，因为浏览器不能设 Authorization header）
const ASR_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'

export function createVoiceService(
  getConfig: () => AgentConfig,
  _getContext: () => string,
  callbacks: VoiceCallbacks,
): VoiceService {
  let phase: VoicePhase = 'idle'
  let recorder: VoiceRecorder | null = null

  // Session 隔离：每次新录音自增，旧 session 的所有异步回调检查此值后放弃执行
  let sessionSeq = 0

  const setPhase = (p: VoicePhase) => {
    phase = p
    callbacks.onPhaseChange(p)
  }

  const startRecording = async () => {
    // 新 session 开始：使所有旧 session 的异步回调失效
    sessionSeq++

    // phase 兜底
    if (phase !== 'idle') phase = 'idle'

    recorder = createVoiceRecorder()
    try {
      await recorder.start()
      setPhase('listening')
    } catch (err) {
      callbacks.onError(`麦克风访问失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const stopAndProcess = async () => {
    if (phase !== 'listening' || !recorder) return
    setPhase('thinking')

    const mySeq = sessionSeq
    const sessionMsgId = crypto.randomUUID()

    const result = await recorder.stop()
    recorder = null

    if (mySeq !== sessionSeq) return

    if (!result) {
      callbacks.onError('录音过短或无声，已取消')
      setPhase('idle')
      return
    }

    // 通知 UI 展示录音气泡（立即）
    callbacks.onUserAudio?.(result.wavBase64, result.durationMs, sessionMsgId)

    // 调用 ASR 转写
    const config = getConfig()
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
        // ASR 失败是非致命的，气泡已展示，仅记录
        const msg = err instanceof Error ? err.message : String(err)
        callbacks.onError(`语音转文字失败: ${msg}`)
      }
    }

    if (mySeq !== sessionSeq) return
    setPhase('idle')
  }

  const cancel = () => {
    if (recorder) { recorder.stop(); recorder = null }
    setPhase('idle')
  }

  const getAudioLevel = (): number => {
    if (recorder && phase === 'listening') return recorder.getAudioLevel()
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
