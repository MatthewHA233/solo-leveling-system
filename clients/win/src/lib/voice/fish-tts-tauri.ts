// ══════════════════════════════════════════════
// Fish TTS 客户端 — Tauri 后端版
// 通过 Rust 后端连接 WebSocket（支持代理）
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface FishTTSConfig {
  apiKey: string
  referenceId: string
  model: string  // s1 或 s2-pro
  sampleRate?: number
  proxyPort?: number
}

export interface FishTTSClient {
  connect: () => Promise<void>
  sendText: (text: string) => Promise<void>
  flush: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

/**
 * 创建 Fish TTS 客户端（Tauri 后端）
 *
 * 音频数据通过事件 "fish-tts-audio" 返回
 * 完成事件 "fish-tts-finish"
 */
export function createFishTTSTauri(
  config: FishTTSConfig,
  onAudioChunk?: (pcm: Uint8Array) => void,
  onFinish?: () => void,
): FishTTSClient {
  let connected = false
  let unlistenAudio: (() => void) | null = null
  let unlistenFinish: (() => void) | null = null

  const connect = async (): Promise<void> => {
    // 监听音频事件
    unlistenAudio = await listen<number[]>('fish-tts-audio', (event) => {
      console.log('[FishTTS-Tauri] 收到音频, 长度:', event.payload.length)
      const pcm = new Uint8Array(event.payload)
      onAudioChunk?.(pcm)
    })

    // 监听完成事件
    unlistenFinish = await listen<void>('fish-tts-finish', () => {
      connected = false
      onFinish?.()
    })

    // 调用 Rust 后端连接
    await invoke('fish_tts_connect', {
      apiKey: config.apiKey,
      referenceId: config.referenceId,
      model: config.model,
      sampleRate: config.sampleRate ?? 24000,
      proxyPort: config.proxyPort ?? 7890,
    })

    connected = true
    console.log('[FishTTS-Tauri] 已连接')
  }

  const sendText = async (text: string): Promise<void> => {
    if (!connected) throw new Error('未连接')
    await invoke('fish_tts_send_text', { text })
  }

  const flush = async (): Promise<void> => {
    if (!connected) return
    await invoke('fish_tts_flush')
  }

  const stop = async (): Promise<void> => {
    if (!connected) return
    await invoke('fish_tts_stop')
    cleanup()
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
  }
}