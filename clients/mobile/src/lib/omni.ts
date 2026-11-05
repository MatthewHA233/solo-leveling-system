// ══════════════════════════════════════════════
// Omni Realtime — native OmniModule 的 JS 封装（对应 desktop lib.rs 的 omni_* 命令 + omni://* 事件）
// 事件名和桌面端一致：
//   omni://status / omni://text_chunk / omni://audio_chunk / omni://user_transcript
//   omni://tool_call / omni://usage
// WS + 录音 + 播放全在 native（Kotlin），JS 只收事件。
// ══════════════════════════════════════════════

import { DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native'

export interface OmniRecording {
  /** 录到的块数（100 ms 一块）；0 表示松手时麦克风还没开始录 */
  readonly chunks: number
  readonly wavBase64: string
  readonly durationMs: number
}

export interface OmniAiAudio {
  readonly wavBase64: string
  readonly durationMs: number
}

export interface OmniPlaybackState {
  readonly hasAudio: boolean
  /** 已经连续播空了多少毫秒；还有音频没播完时为 0 */
  readonly drainedMs: number
}

interface OmniNative {
  connect(apiKey: string, model: string, voice: string, systemPrompt: string, toolsJson: string): Promise<boolean>
  sendAudio(pcmBase64: string): Promise<boolean>
  commit(): Promise<boolean>
  sendText(text: string): Promise<boolean>
  toolResult(callId: string, output: string): Promise<boolean>
  startRecording(): Promise<boolean>
  stopRecording(): Promise<OmniRecording>
  stopAndCommit(): Promise<boolean>
  stopAndTranscribe(): Promise<boolean>
  stop(): Promise<boolean>
  playbackState(): Promise<OmniPlaybackState>
  takeAiAudio(): Promise<OmniAiAudio | null>
}

const Native: OmniNative | null =
  Platform.OS === 'android' ? ((NativeModules.OmniRealtime as OmniNative) ?? null) : null

export type OmniStatus = 'connected' | 'audio_done' | 'disconnected' | 'error'

export interface OmniToolCall {
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

export interface OmniCallbacks {
  onStatus?: (status: OmniStatus, message?: string) => void
  onText?: (delta: string) => void
  onUserTranscript?: (text: string) => void
  onUsage?: (model: string, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number }) => void
  /** 回复音频到达（已经在 native 播放，这里只报字节数；整段音频用 omniTakeAiAudio 取） */
  onAudioChunk?: (bytes: number) => void
  /** 工具调用：执行后用 omniToolResult 回传 */
  onToolCall?: (call: OmniToolCall) => void
}

export function omniAvailable(): boolean {
  return Native != null
}

/** 录音权限（Android 运行时权限） */
export async function ensureMicPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    { title: '麦克风权限', message: '语音对话需要使用麦克风', buttonPositive: '允许', buttonNegative: '拒绝' },
  )
  return granted === PermissionsAndroid.RESULTS.GRANTED
}

export function subscribeOmni(cb: OmniCallbacks): () => void {
  const subs = [
    DeviceEventEmitter.addListener('omni://status', (e: { status: OmniStatus; message?: string }) => {
      cb.onStatus?.(e.status, e.message)
    }),
    DeviceEventEmitter.addListener('omni://text_chunk', (e: { text: string }) => {
      cb.onText?.(e.text)
    }),
    DeviceEventEmitter.addListener('omni://user_transcript', (e: { text: string }) => {
      cb.onUserTranscript?.(e.text)
    }),
    DeviceEventEmitter.addListener('omni://usage', (e: { model: string; usageJson: string }) => {
      try { cb.onUsage?.(e.model, JSON.parse(e.usageJson)) } catch {}
    }),
    DeviceEventEmitter.addListener('omni://audio_chunk', (e: { bytes: number }) => {
      cb.onAudioChunk?.(e.bytes)
    }),
    DeviceEventEmitter.addListener('omni://tool_call', (e: OmniToolCall) => {
      cb.onToolCall?.(e)
    }),
  ]
  return () => subs.forEach((s) => s.remove())
}

/** 关闭旧连接并建新连接；tools 是 Realtime API 扁平格式（{type, name, description, parameters}） */
export async function omniConnect(
  apiKey: string,
  model: string,
  voice: string,
  systemPrompt: string,
  tools: unknown = [],
): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.connect(apiKey, model, voice, systemPrompt, JSON.stringify(tools ?? []))
}

export async function omniStartRecording(): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.startRecording()
}

/** 停止录音、不提交：拿到气泡用的 WAV，之后再 omniCommit */
export async function omniStopRecording(): Promise<OmniRecording> {
  if (!Native) throw new Error('Omni native module 不可用')
  return Native.stopRecording()
}

export async function omniCommit(): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.commit()
}

export async function omniStopAndCommit(): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.stopAndCommit()
}

export async function omniStopAndTranscribe(): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.stopAndTranscribe()
}

export async function omniSendAudio(pcmBase64: string): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.sendAudio(pcmBase64)
}

export async function omniSendText(text: string): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.sendText(text)
}

/** 回传工具执行结果，触发 AI 继续生成回复 */
export async function omniToolResult(callId: string, output: string): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.toolResult(callId, output)
}

export async function omniStop(): Promise<void> {
  if (!Native) return
  await Native.stop().catch(() => {})
}

/** 回复音频的播放进度（对应 desktop 轮询 omniLastSourceEndedRef） */
export async function omniPlaybackState(): Promise<OmniPlaybackState> {
  if (!Native) return { hasAudio: false, drainedMs: 0 }
  return Native.playbackState()
}

/** 取走本轮回复音频（对应 desktop 把 omniAiPcmChunksRef 拼成 WAV） */
export async function omniTakeAiAudio(): Promise<OmniAiAudio | null> {
  if (!Native) return null
  return Native.takeAiAudio()
}
