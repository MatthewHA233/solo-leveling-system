// ══════════════════════════════════════════════
// Omni Realtime — native OmniModule 的 JS 封装
// 与 desktop 的 omni 事件语义对齐：
//   omni-status / omni-text / omni-user-transcript / omni-usage
// WS + 录音 + 播放全在 native（Kotlin），JS 只收事件。
// ══════════════════════════════════════════════

import { DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native'

interface OmniNative {
  connect(apiKey: string, model: string, voice: string, systemPrompt: string): Promise<boolean>
  startRecording(): Promise<boolean>
  stopAndCommit(): Promise<boolean>
  stop(): Promise<boolean>
}

const Native: OmniNative | null =
  Platform.OS === 'android' ? ((NativeModules.OmniRealtime as OmniNative) ?? null) : null

export type OmniStatus = 'connected' | 'audio_done' | 'disconnected' | 'error'

export interface OmniCallbacks {
  onStatus?: (status: OmniStatus, message?: string) => void
  onText?: (delta: string) => void
  onUserTranscript?: (text: string) => void
  onUsage?: (model: string, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number }) => void
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
    DeviceEventEmitter.addListener('omni-status', (e: { status: OmniStatus; message?: string }) => {
      cb.onStatus?.(e.status, e.message)
    }),
    DeviceEventEmitter.addListener('omni-text', (e: { text: string }) => {
      cb.onText?.(e.text)
    }),
    DeviceEventEmitter.addListener('omni-user-transcript', (e: { text: string }) => {
      cb.onUserTranscript?.(e.text)
    }),
    DeviceEventEmitter.addListener('omni-usage', (e: { model: string; usageJson: string }) => {
      try { cb.onUsage?.(e.model, JSON.parse(e.usageJson)) } catch {}
    }),
  ]
  return () => subs.forEach((s) => s.remove())
}

export async function omniConnect(apiKey: string, model: string, voice: string, systemPrompt: string): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.connect(apiKey, model, voice, systemPrompt)
}

export async function omniStartRecording(): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.startRecording()
}

export async function omniStopAndCommit(): Promise<void> {
  if (!Native) throw new Error('Omni native module 不可用')
  await Native.stopAndCommit()
}

export async function omniStop(): Promise<void> {
  if (!Native) return
  await Native.stop().catch(() => {})
}
