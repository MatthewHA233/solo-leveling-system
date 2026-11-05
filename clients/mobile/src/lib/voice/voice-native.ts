// ══════════════════════════════════════════════
// SolevupVoice NativeModule 的类型与入口
// 对应 desktop 的 voice_* / fish_tts_* / save_audio_file / get_audio_dir 命令
// （android/.../voice/VoiceModule.kt）
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'

import type { AsrContextTurn } from './asr-hints'

export interface VoiceStartRequest {
  readonly apiKey: string
  readonly model: string
  readonly workspaceId?: string | null
  readonly vocabulary: readonly string[]
  readonly context: readonly AsrContextTurn[]
  readonly languageHints: readonly string[]
}

/** voiceStop 的返回（android/.../voice/VoiceSession.kt VoiceResult，字段和桌面端一致） */
export interface VoiceAsrResult {
  readonly session: number
  readonly text: string
  readonly wavBase64: string
  readonly durationMs: number
  readonly hadSpeech: boolean
  readonly model: string
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number } | null
  readonly attempts: number
  readonly fallback: boolean
  readonly device: string | null
  /** 录音掉帧次数、中途重开麦克风次数（排查断录用） */
  readonly glitches?: number
  readonly captureRestarts?: number
  readonly timings: {
    readonly micOpenMs: number | null
    readonly asrConnectMs: number | null
    readonly asrStartMs: number | null
    readonly firstPartialMs: number | null
    readonly finalizeMs: number | null
    readonly totalMs: number
  }
}

export interface PcmPlaybackState {
  readonly hasAudio: boolean
  /** 已经连续播空了多少毫秒（对应桌面端 currentTime - nextStartTime）；还有音频没播完时为 0 */
  readonly drainedMs: number
  readonly totalBytes: number
}

export interface WavAudio {
  readonly wavBase64: string
  readonly durationMs: number
}

interface VoiceNative {
  voiceStart(req: VoiceStartRequest): Promise<number>
  voiceStop(): Promise<VoiceAsrResult>
  voiceCancel(): Promise<void>
  fishTtsConnect(apiKey: string, referenceId: string, sampleRate: number, model: string, eventId: string): Promise<void>
  fishTtsSendText(text: string): Promise<void>
  fishTtsFlush(): Promise<void>
  fishTtsStop(eventId: string): Promise<void>
  fishTtsPlaybackState(eventId: string): Promise<PcmPlaybackState | null>
  fishTtsTakeAudio(eventId: string): Promise<WavAudio | null>
  saveAudioFile(sessionId: string, wavBase64: string, timestamp: string): Promise<string>
  getAudioDir(): Promise<string>
  playAudioFile(relativePath: string): Promise<void>
  stopAudioPlayback(): Promise<void>
}

export const voiceNative: VoiceNative | null =
  Platform.OS === 'android' ? ((NativeModules.SolevupVoice as VoiceNative) ?? null) : null

export function requireVoiceNative(): VoiceNative {
  if (!voiceNative) throw new Error('语音 native module 不可用')
  return voiceNative
}

// ── 音频文件（对应 desktop save_audio_file / get_audio_dir） ──

/** 保存一条语音消息 WAV；返回相对路径 "{session_id}/{filename}"，供 DB 存储 */
export function saveAudioFile(sessionId: string, wavBase64: string, timestamp: string): Promise<string> {
  return requireVoiceNative().saveAudioFile(sessionId, wavBase64, timestamp)
}

export async function getAudioDir(): Promise<string> {
  return requireVoiceNative().getAudioDir()
}

/** 回放一条已落盘的语音（气泡点播放）；放完或失败发 voice://playback_end { path, error? } */
export function playAudioFile(relativePath: string): Promise<void> {
  return requireVoiceNative().playAudioFile(relativePath)
}

export async function stopAudioPlayback(): Promise<void> {
  await voiceNative?.stopAudioPlayback()
}
