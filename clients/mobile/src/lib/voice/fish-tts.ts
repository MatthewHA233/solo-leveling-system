// ══════════════════════════════════════════════
// Fish TTS 客户端 — native 后端版（对应 desktop fish-tts-tauri.ts）
// 通过 Kotlin 后端连接 WebSocket（android/.../voice/FishTtsClient.kt）
//
// 代理：和桌面端一样走「网络代理」设置的本机端口（lib/network.ts、AppProxy.kt）。
// 手机上这个设置可以留空：Clash 一类工具以系统 VPN 形式工作，对 App 透明，手动配置的系统 HTTP 代理 OkHttp 也会自动遵守。
// 端口在原生层生效，所以这里没有 proxyPort。
//
// 音频：桌面端把 PCM 发给前端，由 WebAudio 播放并收集成 WAV。
// 手机端直接在 native 进 AudioTrack 并攒 WAV，前端只收进度；播放进度和整段音频按需查询。
// ══════════════════════════════════════════════

import { DeviceEventEmitter } from 'react-native'

import { randomUUID } from '../llm/uuid'
import { solevupDeleteModelApiKey, solevupGetActiveModelApiKey, solevupUpsertModelApiKey } from '../solevupdb'
import { requireVoiceNative, type PcmPlaybackState, type WavAudio } from './voice-native'

export interface FishTTSConfig {
  apiKey: string
  referenceId: string
  model: string  // s1 或 s2-pro
  sampleRate?: number
}

export interface FishTTSClient {
  connect: () => Promise<void>
  sendText: (text: string) => Promise<void>
  flush: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
  /** 播放进度：native 的 AudioTrack 还有没有音频没播完 */
  getPlayback: () => Promise<PcmPlaybackState | null>
  /** 取走这一轮已收到的音频（打断时是已收到的那一部分） */
  takeAudio: () => Promise<WavAudio | null>
}

/** 所有设备共用这一行，同步时按 LWW 合并，不会各存一条（desktop model-audit.ts 用同一个 id） */
const FISH_KEY_ID = 'fish-audio'

export async function resolveFishApiKey(): Promise<string | null> {
  const stored = await solevupGetActiveModelApiKey('fish').catch(() => null)
  return stored?.apiKey || null
}

/** 空值 = 删除，删除也会同步到其他设备 */
export async function saveFishApiKey(value: string | null): Promise<void> {
  const key = value?.trim()
  if (!key) {
    await solevupDeleteModelApiKey(FISH_KEY_ID)
    return
  }
  await solevupUpsertModelApiKey({ id: FISH_KEY_ID, label: 'Fish Audio', apiKey: key, provider: 'fish', activate: true })
}

/**
 * 创建 Fish TTS 客户端（native 后端）
 *
 * 音频到达事件 "fish-tts-audio-{id}"（只带字节数，音频已经在播了）
 * 完成事件 "fish-tts-finish-{id}"
 */
export function createFishTTS(
  config: FishTTSConfig,
  onAudioChunk?: (byteLength: number) => void,
  onFinish?: () => void,
): FishTTSClient {
  const native = requireVoiceNative()
  let connected = false
  // 已经向 native 发起过连接、还没停过：合成完（connected=false）之后音频可能还在播，stop 仍要通知 native 停声
  let started = false
  let unlistenAudio: (() => void) | null = null
  let unlistenFinish: (() => void) | null = null
  // 每个 client 实例一份独立 event_id，native 端事件名加后缀，避免新旧 WS 串扰
  const eventId = randomUUID()

  const connect = async (): Promise<void> => {
    // 监听音频事件（带 event_id 后缀）
    const audioSub = DeviceEventEmitter.addListener(`fish-tts-audio-${eventId}`, (e: { bytes: number }) => {
      onAudioChunk?.(e.bytes)
    })
    unlistenAudio = () => audioSub.remove()

    // 监听完成事件
    const finishSub = DeviceEventEmitter.addListener(`fish-tts-finish-${eventId}`, () => {
      connected = false
      onFinish?.()
      cleanup()   // 自动清理监听器，防止下次调用叠音
    })
    unlistenFinish = () => finishSub.remove()

    // 调用 native 后端连接
    started = true
    await native.fishTtsConnect(
      config.apiKey,
      config.referenceId,
      config.sampleRate ?? 24000,
      config.model,
      eventId,
    )

    // 建连途中已经 stop 了：不再算连上
    if (!started) return
    connected = true
    console.log('[FishTTS] 已连接')
  }

  const sendText = async (text: string): Promise<void> => {
    if (!connected) throw new Error('未连接')
    await native.fishTtsSendText(text)
  }

  const flush = async (): Promise<void> => {
    if (!connected) return
    await native.fishTtsFlush()
  }

  // 桌面端是 if (!connected) return：它的声音在前端 AudioContext，打断时另外关。
  // 手机端声音在 native：服务端合成完（fish-tts-finish）往往早于播完，这时打断也必须停 AudioTrack。
  const stop = async (): Promise<void> => {
    if (!started) return
    started = false
    cleanup()
    await native.fishTtsStop(eventId)
  }

  const cleanup = () => {
    connected = false
    if (unlistenAudio) { unlistenAudio(); unlistenAudio = null }
    if (unlistenFinish) { unlistenFinish(); unlistenFinish = null }
  }

  return {
    connect,
    sendText,
    flush,
    stop,
    isConnected: () => connected,
    getPlayback: () => native.fishTtsPlaybackState(eventId),
    takeAudio: () => native.fishTtsTakeAudio(eventId),
  }
}
