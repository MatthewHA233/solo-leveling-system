// ══════════════════════════════════════════════
// Voice Service — 按住说话的语音管线编排
//
// 级联（默认，aiMode=regular）：Rust 原生录音 + 百炼流式识别（voice_start / voice_stop）
//   → 定稿文本进主循环（和打字同一个 Fairy：同一模型、工具、记忆、历史）
//   · 边说边出字：voice://partial → onPartialTranscript
//   · 松手：录音 WAV（语音气泡回放）+ 用量与各段耗时（模型审计）+ 定稿文本
//   · 失败重连、重放、批量兜底都在 Rust 端（src-tauri/src/voice/）
// 实时（实验，aiMode=omni）：WebView 录音 → Omni Realtime WS，独立的小模型大脑，保留作对照
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'

import { getDashScopeApiKey, getOmniApiKey, type AgentConfig } from '../agent/agent-config'
import { getFeatureModel } from '../model-audit'
import { createStreamingRecorder, pcm16ChunksToWavBlob } from './voice-recorder'
import type { StreamingVoiceRecorder } from './voice-recorder'
import type { AsrHints } from './asr-hints'

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking'

export const DEFAULT_ASR_MODEL = 'qwen-audio-3.1-asr-flash-streaming'
const ASR_LANGUAGE_HINTS = ['zh', 'en']

/** Rust voice_stop 的返回（src-tauri/src/voice/mod.rs VoiceResult） */
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

export interface VoiceCallbacks {
  readonly onPhaseChange: (phase: VoicePhase) => void
  readonly onAudioLevel: (level: number) => void
  readonly onError: (message: string) => void
  /** 边说边出字（级联模式）；sessionMsgId 与后续音频气泡、定稿文本对应同一条消息 */
  readonly onPartialTranscript?: (text: string, sessionMsgId: string) => void
  /** 录音完成后立即触发，展示音频气泡 */
  readonly onUserAudio?: (wavBase64: string, durationMs: number, sessionMsgId: string) => void
  /** 定稿文本 */
  readonly onTranscript?: (text: string, sessionMsgId: string) => void
  /** 一次识别的结果与用量（记模型审计） */
  readonly onAsrResult?: (result: VoiceAsrResult, startedAt: string) => void
  /** 实时模式：录音已提交，开始等回复 */
  readonly onOmniCommitted?: () => void
}

export interface VoiceService {
  readonly startRecording: () => Promise<void>
  readonly stopAndProcess: () => Promise<void>
  readonly cancel: () => void
  readonly getPhase: () => VoicePhase
  readonly getAudioLevel: () => number
}

// PCM16 Uint8Array → base64
function pcm16ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function pcm16Level(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = bytes.byteLength / 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true) / 32768
    sum += v * v
  }
  return n > 0 ? Math.sqrt(sum / n) : 0
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function createVoiceService(
  getConfig: () => AgentConfig,
  getSystemPrompt: () => string,
  callbacks: VoiceCallbacks,
  getOmniTools: () => unknown = () => [],
  getAsrHints: () => AsrHints = () => ({ vocabulary: [], context: [] }),
): VoiceService {
  let phase: VoicePhase = 'idle'
  let streamRecorder: StreamingVoiceRecorder | null = null
  let omniPcmChunks: Uint8Array[] = []   // Omni 录音 PCM 缓冲，用于生成用户气泡音频
  let omniRecordStartMs = 0
  let micOpenMs = 0

  // 级联会话：Rust 会话号（-1 = 尚未拿到）、本条消息 id、开始时间、中间结果监听
  let cascadeActive = false
  let cascadeSession = -1
  let cascadeMsgId = ''
  let cascadeStartedAt = ''
  let unlistenPartial: (() => void) | null = null
  let lastLevel = 0

  // Session 隔离：每次新录音自增，旧 session 的所有异步回调检查此值后放弃执行
  let sessionSeq = 0
  let startingSeq: number | null = null
  // 启动还没完成就松开了：记下来，启动完成后立刻收尾，不静默丢弃
  let stopRequestedSeq: number | null = null

  const setPhase = (p: VoicePhase) => {
    phase = p
    callbacks.onPhaseChange(p)
  }

  const clearStarting = (seq: number) => {
    if (startingSeq === seq) startingSeq = null
  }

  const dropPartialListener = () => {
    unlistenPartial?.()
    unlistenPartial = null
  }

  // Omni 用户转写：监听在服务创建时就挂好，转给当前等转写的那条语音。
  // 实时模型边说边转写，commit 后「转写完成」几乎立刻就到；等 commit 返回再挂监听会错过它
  // ——语音不入库、不出字、起标题也数不到用户消息（2026-10-05 的事故根因）
  let omniPending: { msgId: string; got: boolean } | null = null
  void listen<{ text: string }>('omni://user_transcript', ({ payload }) => {
    const pending = omniPending
    const text = payload.text.trim()
    if (!pending || pending.got || !text) return
    pending.got = true
    callbacks.onTranscript?.(text, pending.msgId)
  })

  // 音量（给 getAudioLevel）；录音超过 90 秒或麦克风中断时 Rust 自动停止 → 按松手处理
  void listen<{ session: number; level: number }>('voice://level', ({ payload }) => {
    if (payload.session === cascadeSession) lastLevel = payload.level
  })
  void listen<{ session: number; message?: string }>('voice://auto_stop', ({ payload }) => {
    if (cascadeActive && payload.session === cascadeSession && phase === 'listening') {
      callbacks.onError(payload.message ?? '单次录音最长 90 秒，已自动结束')
      void stopAndProcess()
    }
  })

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

  const finishStart = (mySeq: number) => {
    clearStarting(mySeq)
    setPhase('listening')
    if (stopRequestedSeq === mySeq) {
      stopRequestedSeq = null
      void stopAndProcess()
    }
  }

  const failStart = (mySeq: number, message: string) => {
    if (mySeq !== sessionSeq) {
      clearStarting(mySeq)
      return
    }
    clearStarting(mySeq)
    stopRequestedSeq = null
    callbacks.onError(message)
    setPhase('idle')
  }

  // ── 级联：Rust 原生录音 + 流式识别 ──
  const startCascade = async (mySeq: number, config: AgentConfig) => {
    const apiKey = getDashScopeApiKey(config)
    if (!apiKey) {
      failStart(mySeq, '未配置百炼 API Key，无法语音识别')
      return
    }
    cascadeActive = true
    cascadeSession = -1
    cascadeMsgId = crypto.randomUUID()
    cascadeStartedAt = new Date().toISOString()
    lastLevel = 0
    const msgId = cascadeMsgId
    try {
      // 先挂监听再开录，不漏最早的中间结果
      dropPartialListener()
      const unlisten = await listen<{ session: number; text: string }>('voice://partial', ({ payload }) => {
        if (mySeq === sessionSeq && payload.session === cascadeSession && payload.text) {
          callbacks.onPartialTranscript?.(payload.text, msgId)
        }
      })
      if (mySeq !== sessionSeq) {
        unlisten()
        clearStarting(mySeq)
        return
      }
      unlistenPartial = unlisten
      const [model, hints] = await Promise.all([
        getFeatureModel('fairy_voice_asr', DEFAULT_ASR_MODEL),
        Promise.resolve(getAsrHints()),
      ])
      if (mySeq !== sessionSeq) {
        clearStarting(mySeq)
        return
      }
      const session = await invoke<number>('voice_start', {
        req: {
          apiKey,
          model,
          vocabulary: hints.vocabulary,
          context: hints.context,
          languageHints: ASR_LANGUAGE_HINTS,
        },
      })
      if (mySeq !== sessionSeq) {
        // 启动途中被取消：Rust 那边的新会话也作废。又开始了新一次录音就不用管：
        // voice_start 自己会换掉旧会话，这里取消的反而是新的
        if (!cascadeActive) invoke('voice_cancel').catch(() => {})
        clearStarting(mySeq)
        return
      }
      cascadeSession = session
      finishStart(mySeq)
    } catch (err) {
      dropPartialListener()
      cascadeActive = false
      failStart(mySeq, `语音启动失败：${errorText(err)}`)
    }
  }

  const stopCascade = async (mySeq: number) => {
    const msgId = cascadeMsgId
    const startedAt = cascadeStartedAt
    let result: VoiceAsrResult
    try {
      result = await invoke<VoiceAsrResult>('voice_stop')
    } catch (err) {
      dropPartialListener()
      cascadeActive = false
      if (mySeq !== sessionSeq) return
      callbacks.onError(`语音识别失败：${errorText(err)}`)
      setPhase('idle')
      return
    }
    dropPartialListener()
    cascadeActive = false
    if (mySeq !== sessionSeq) return

    callbacks.onAsrResult?.(result, startedAt)
    if (result.durationMs > 0 && result.wavBase64) {
      callbacks.onUserAudio?.(result.wavBase64, result.durationMs, msgId)
    }
    const text = result.text.trim()
    if (!text) {
      callbacks.onError(result.hadSpeech
        ? '没听清，再说一次？'
        : '没听到声音：检查一下麦克风，或者按住右 Alt 稍等再开口')
      setPhase('idle')
      return
    }
    // 保持 thinking：之后的状态（说话 / 空闲）由回复流程接管
    callbacks.onTranscript?.(text, msgId)
  }

  // ── 实时（实验）：WebView 录音 → Omni Realtime ──
  const startOmni = async (mySeq: number, config: AgentConfig, omniApiKey: string) => {
    // 用局部 sr，防止 await 期间 cancel()/stopAndProcess() 把闭包 streamRecorder 置 null
    const sr = createStreamingRecorder()
    streamRecorder = sr
    omniPcmChunks = []
    omniRecordStartMs = Date.now()
    // 麦克风与 WS 并行启动；WS 就绪前录到的块先攒着，连上后按顺序补发
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
            // 音量广播给 Fairy 悬浮窗（级联模式下由 Rust 发同名事件）
            void emit('voice://level', { session: 0, level: pcm16Level(pcm16) })
            if (wsReady) sendChunk(pcm16)
            else unsent.push(pcm16)
          },
        }).then(() => { micOpenMs = Date.now() - micT0 }),
      ])
      if (mySeq !== sessionSeq || streamRecorder !== sr) {
        clearStarting(mySeq)
        await sr.stop().catch(() => {})
        // 新一次录音已经在用连接了：这里再停，停掉的是它的会话
        if (streamRecorder === null) invoke('omni_stop').catch(() => {})
        return
      }
      finishStart(mySeq)
    } catch (err) {
      await sr.stop().catch(() => {})
      if (streamRecorder === sr) streamRecorder = null
      if (streamRecorder === null) invoke('omni_stop').catch(() => {})
      failStart(mySeq, `Omni ASR 启动失败: ${errorText(err)}`)
    }
  }

  const stopOmni = async (mySeq: number, sessionMsgId: string) => {
    const sr = streamRecorder
    streamRecorder = null
    await sr?.stop()

    // 一块都没录到（麦克风刚开就松手）：不去 commit 空缓冲，否则服务端只回一句看不懂的错误
    if (omniPcmChunks.length === 0) {
      invoke('omni_stop').catch(() => {})
      callbacks.onError(`没录到声音：麦克风打开用了 ${micOpenMs} ms，松开时还没开始录。按住右 Alt 稍等再开口`)
      setPhase('idle')
      return
    }

    // 立刻生成用户语音气泡（先无文字，transcript 到来后由 App.tsx 更新）
    const durationMs = Date.now() - omniRecordStartMs
    if (callbacks.onUserAudio) {
      const blob = pcm16ChunksToWavBlob(omniPcmChunks, 16000)
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(blob)
      })
      callbacks.onUserAudio(dataUrl.split(',')[1], durationMs, sessionMsgId)
    }
    omniPcmChunks = []

    // commit 之前就登记好"这条语音在等转写"，转写一到就能对上
    const pending = { msgId: sessionMsgId, got: false }
    omniPending = pending
    try {
      await invoke('omni_commit')
    } catch (err) {
      if (omniPending === pending) omniPending = null
      if (mySeq !== sessionSeq) return
      callbacks.onError(`Omni commit 失败: ${errorText(err)}`)
      setPhase('idle')
      return
    }
    if (mySeq === sessionSeq) callbacks.onOmniCommitted?.()

    // idle 由 App.tsx 的 omni://status 处理器在音频真正播完后统一发出
    await waitOmniAudioDone(30_000)
    if (omniPending === pending) omniPending = null
    // 兜底：一轮结束仍没收到转写（服务端没给 / 识别为空），也要把这段录音存进会话，只是没有文字
    if (!pending.got) {
      pending.got = true
      callbacks.onTranscript?.('', sessionMsgId)
    }
  }

  // ── 对外接口 ──

  const startRecording = async () => {
    sessionSeq++
    const mySeq = sessionSeq
    startingSeq = mySeq
    if (phase !== 'idle') phase = 'idle'

    const config = getConfig()
    const omniApiKey = getOmniApiKey(config)
    if (config.aiMode === 'omni' && omniApiKey) {
      await startOmni(mySeq, config, omniApiKey)
    } else {
      await startCascade(mySeq, config)
    }
  }

  const stopAndProcess = async () => {
    if (phase !== 'listening') {
      // 还在启动中就松开：不丢弃，等启动完成后由 finishStart 接着收尾
      if (startingSeq != null) stopRequestedSeq = startingSeq
      return
    }
    setPhase('thinking')
    const mySeq = sessionSeq
    if (cascadeActive) {
      await stopCascade(mySeq)
    } else if (streamRecorder) {
      await stopOmni(mySeq, crypto.randomUUID())
    } else {
      setPhase('idle')
    }
  }

  const cancel = () => {
    sessionSeq++
    startingSeq = null
    stopRequestedSeq = null
    if (cascadeActive) {
      cascadeActive = false
      dropPartialListener()
      invoke('voice_cancel').catch(() => {})
    }
    if (streamRecorder) {
      streamRecorder.stop().catch(() => {})
      streamRecorder = null
    }
    invoke('omni_stop').catch(() => {}) // 实时模式下也打断正在播的回复；没有会话时是空操作
    setPhase('idle')
  }

  const getAudioLevel = (): number => {
    if (phase !== 'listening') return 0
    if (cascadeActive) return lastLevel
    return streamRecorder?.getAudioLevel() ?? 0
  }

  return {
    startRecording,
    stopAndProcess,
    cancel,
    getPhase: () => phase,
    getAudioLevel,
  }
}
