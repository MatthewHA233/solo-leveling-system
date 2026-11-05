// ══════════════════════════════════════════════
// Voice Recorder — 流式录音（仅「实时（实验）」语音模式使用）
// 默认的级联语音走 VoiceSession（android/.../voice/），录音和识别都在 native。
//
// 桌面端这里是 WebView 麦克风：边录边把 PCM 块回调给 JS，再由 JS 发给 Rust。
// 手机端麦克风本来就在 native（OmniModule + VoiceCapture），PCM 块直推 WS、不经过 JS，
// 这个封装只保留 start / stop / 音量 / 状态：stop 时拿到 WAV，音量来自 voice://level。
// 重采样和 PCM16 → WAV 也都在 native（VoiceCapture、wavBytes）。
// ══════════════════════════════════════════════

import { DeviceEventEmitter } from 'react-native'

import { omniStartRecording, omniStopRecording, type OmniRecording } from '../omni'

/** 流式录音器：PCM 块在 native 直接流出，stop() 时返回整段录音（给语音气泡） */
export interface StreamingVoiceRecorder {
  readonly start: () => Promise<void>
  readonly stop: () => Promise<OmniRecording | null>
  readonly getAudioLevel: () => number
  readonly isRecording: () => boolean
}

const SLOW_START_MS = 800

export function createStreamingRecorder(): StreamingVoiceRecorder {
  let recording = false
  let startedAt = 0
  let level = 0
  let levelSub: { remove: () => void } | null = null

  const start = async () => {
    startedAt = Date.now()
    level = 0
    levelSub?.remove()
    // session 0 = 实时模式的录音（级联模式的会话号从 1 开始）
    levelSub = DeviceEventEmitter.addListener('voice://level', (e: { session: number; level: number }) => {
      if (e.session === 0) level = e.level
    })
    try {
      await omniStartRecording()
    } catch (err) {
      levelSub?.remove()
      levelSub = null
      throw err
    }
    recording = true
    const totalMs = Date.now() - startedAt
    if (totalMs > SLOW_START_MS) {
      console.warn(`[StreamRecorder] 麦克风打开较慢：就绪共 ${totalMs}ms`)
    }
  }

  const stop = async (): Promise<OmniRecording | null> => {
    levelSub?.remove()
    levelSub = null
    if (!recording) return null
    recording = false
    const result = await omniStopRecording()
    if (result.chunks === 0) {
      console.warn(`[StreamRecorder] 本次没录到任何音频块：录音 ${Date.now() - startedAt}ms`)
    }
    return result
  }

  const getAudioLevel = (): number => (recording ? level : 0)

  return { start, stop, getAudioLevel, isRecording: () => recording }
}
