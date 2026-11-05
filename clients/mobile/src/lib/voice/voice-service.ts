// ══════════════════════════════════════════════
// Voice Service — 按住说话的语音管线编排
//
// 级联（默认，aiMode=regular）：native 录音 + 百炼流式识别（voiceStart / voiceStop）
//   → 定稿文本进主循环（和打字同一个 Fairy：同一模型、工具、记忆、历史）
//   · 边说边出字：voice://partial → onPartialTranscript
//   · 松手：录音 WAV（语音气泡回放）+ 用量与各段耗时（模型审计）+ 定稿文本
//   · 失败重连、重放、批量兜底都在 native 端（android/.../voice/）
// 实时（实验，aiMode=omni）：native 录音 → Omni Realtime WS，独立的小模型大脑，保留作对照
// ══════════════════════════════════════════════

import { DeviceEventEmitter } from 'react-native'

import { randomUUID } from '../llm/uuid'
import { ensureMicPermission, omniCommit, omniConnect, omniStop } from '../omni'
import { solevupGetActiveModelApiKey, solevupGetFeatureBinding } from '../solevupdb'
import type { AsrHints } from './asr-hints'
import { interruptReplyTts } from './tts-pipeline'
import { requireVoiceNative, type VoiceAsrResult } from './voice-native'
import { createStreamingRecorder } from './voice-recorder'
import type { StreamingVoiceRecorder } from './voice-recorder'

export type { VoiceAsrResult } from './voice-native'

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking'

export const DEFAULT_ASR_MODEL = 'qwen-audio-3.1-asr-flash-streaming'
export const DEFAULT_OMNI_MODEL = 'qwen3.5-omni-flash-realtime'
const ASR_LANGUAGE_HINTS = ['zh', 'en']

/** 语音管线用到的配置字段（AgentConfig 的子集） */
export interface VoiceServiceConfig {
  readonly aiMode?: 'regular' | 'omni'
  readonly omniModel?: string
  readonly omniVoice?: string
  readonly dashscopeApiKey?: string | null
  readonly openaiApiKey?: string | null
  readonly omniApiKey?: string | null
  readonly asrApiKey?: string | null
}

export interface VoiceCallbacks {
  readonly onPhaseChange: (phase: VoicePhase) => void
  /** 录音音量 0~1（桌面端走 voice://level 直接广播给 Fairy 悬浮窗；手机端转给浮层） */
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
}

export interface VoiceService {
  readonly startRecording: () => Promise<void>
  readonly stopAndProcess: () => Promise<void>
  readonly cancel: () => void
  readonly getPhase: () => VoicePhase
  readonly getAudioLevel: () => number
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** 对应 desktop model-audit.ts getFeatureModel：功能绑定的模型，读不到用默认 */
async function getFeatureModel(feature: string, fallback: string): Promise<string> {
  try {
    return (await solevupGetFeatureBinding(feature)) || fallback
  } catch {
    return fallback
  }
}

/**
 * 对应 desktop getDashScopeApiKey（配置字段的先后和它一致）。
 * 手机端的 Key 主要来自电脑同步 / 模型库，所以先查启用中的那条，和 chat-controller、ai/* 同一做法。
 */
async function resolveDashScopeKey(config: VoiceServiceConfig): Promise<string | null> {
  const stored = await solevupGetActiveModelApiKey('dashscope').catch(() => null)
  return stored?.apiKey
    || (config.dashscopeApiKey ?? config.openaiApiKey ?? config.omniApiKey ?? config.asrApiKey ?? null)
}

/** 对应 desktop getOmniApiKey：单独配了 Omni Key 就用它，否则和百炼共用 */
async function resolveOmniKey(config: VoiceServiceConfig): Promise<string | null> {
  return config.omniApiKey ?? resolveDashScopeKey(config)
}

export function createVoiceService(
  getConfig: () => VoiceServiceConfig,
  getSystemPrompt: () => string,
  callbacks: VoiceCallbacks,
  getOmniTools: () => unknown = () => [],
  getAsrHints: () => AsrHints = () => ({ vocabulary: [], context: [] }),
): VoiceService {
  let phase: VoicePhase = 'idle'
  let streamRecorder: StreamingVoiceRecorder | null = null
  let omniRecordStartMs = 0
  let micOpenMs = 0

  // 级联会话：native 会话号（-1 = 尚未拿到）、本条消息 id、开始时间、中间结果监听
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
  DeviceEventEmitter.addListener('omni://user_transcript', (payload: { text: string }) => {
    const pending = omniPending
    const text = payload.text.trim()
    if (!pending || pending.got || !text) return
    pending.got = true
    callbacks.onTranscript?.(text, pending.msgId)
  })

  // 音量（给 getAudioLevel）；录音超过 90 秒或麦克风中断时 native 自动停止 → 按松手处理
  DeviceEventEmitter.addListener('voice://level', (payload: { session: number; level: number }) => {
    if (payload.session === cascadeSession) lastLevel = payload.level
    if (phase === 'listening' && (payload.session === cascadeSession || (payload.session === 0 && streamRecorder))) {
      callbacks.onAudioLevel(payload.level)
    }
  })
  DeviceEventEmitter.addListener('voice://auto_stop', (payload: { session: number; message?: string }) => {
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
      const sub = DeviceEventEmitter.addListener('omni://status', (e: { status: string }) => {
        if (e.status === 'audio_done' || e.status === 'disconnected' || e.status === 'error') {
          clearTimeout(timer)
          finish()
        }
      })
      unlisten = () => sub.remove()
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

  // ── 级联：native 录音 + 流式识别 ──
  const startCascade = async (mySeq: number, config: VoiceServiceConfig) => {
    const apiKey = await resolveDashScopeKey(config)
    if (mySeq !== sessionSeq) {
      clearStarting(mySeq)
      return
    }
    if (!apiKey) {
      failStart(mySeq, '未配置百炼 API Key，无法语音识别')
      return
    }
    cascadeActive = true
    cascadeSession = -1
    cascadeMsgId = randomUUID()
    cascadeStartedAt = new Date().toISOString()
    lastLevel = 0
    const msgId = cascadeMsgId
    try {
      // 先挂监听再开录，不漏最早的中间结果
      dropPartialListener()
      const sub = DeviceEventEmitter.addListener('voice://partial', (payload: { session: number; text: string }) => {
        if (mySeq === sessionSeq && payload.session === cascadeSession && payload.text) {
          callbacks.onPartialTranscript?.(payload.text, msgId)
        }
      })
      unlistenPartial = () => sub.remove()
      const [model, hints] = await Promise.all([
        getFeatureModel('fairy_voice_asr', DEFAULT_ASR_MODEL),
        Promise.resolve(getAsrHints()),
      ])
      if (mySeq !== sessionSeq) {
        clearStarting(mySeq)
        return
      }
      const session = await requireVoiceNative().voiceStart({
        apiKey,
        model,
        vocabulary: hints.vocabulary,
        context: hints.context,
        languageHints: ASR_LANGUAGE_HINTS,
      })
      if (mySeq !== sessionSeq) {
        // 启动途中被取消：native 那边的新会话也作废
        requireVoiceNative().voiceCancel().catch(() => {})
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
      result = await requireVoiceNative().voiceStop()
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
        : '没听到声音：检查一下麦克风，或者按住稍等再开口')
      setPhase('idle')
      return
    }
    // 保持 thinking：之后的状态（说话 / 空闲）由回复流程接管
    callbacks.onTranscript?.(text, msgId)
  }

  // ── 实时（实验）：native 录音 → Omni Realtime ──
  const startOmni = async (mySeq: number, config: VoiceServiceConfig, omniApiKey: string) => {
    // 用局部 sr，防止 await 期间 cancel()/stopAndProcess() 把闭包 streamRecorder 置 null
    const sr = createStreamingRecorder()
    streamRecorder = sr
    omniRecordStartMs = Date.now()
    // 麦克风与 WS 并行启动；WS 就绪前录到的块由 native 先攒着，连上后按顺序补发
    try {
      const omniModel = await getFeatureModel('fairy_omni_chat', config.omniModel || DEFAULT_OMNI_MODEL)
      if (mySeq !== sessionSeq || streamRecorder !== sr) {
        clearStarting(mySeq)
        return
      }
      const micT0 = Date.now()
      await Promise.all([
        omniConnect(omniApiKey, omniModel, config.omniVoice || '', getSystemPrompt(), getOmniTools()),
        sr.start().then(() => { micOpenMs = Date.now() - micT0 }),
      ])
      if (mySeq !== sessionSeq || streamRecorder !== sr) {
        clearStarting(mySeq)
        await sr.stop().catch(() => null)
        void omniStop()
        return
      }
      finishStart(mySeq)
    } catch (err) {
      await sr.stop().catch(() => null)
      if (streamRecorder === sr) streamRecorder = null
      void omniStop()
      failStart(mySeq, `Omni ASR 启动失败: ${errorText(err)}`)
    }
  }

  const stopOmni = async (mySeq: number, sessionMsgId: string) => {
    const sr = streamRecorder
    streamRecorder = null
    const recorded = await sr?.stop()

    // 一块都没录到（麦克风刚开就松手）：不去 commit 空缓冲，否则服务端只回一句看不懂的错误
    if (!recorded || recorded.chunks === 0) {
      void omniStop()
      callbacks.onError(`没录到声音：麦克风打开用了 ${micOpenMs} ms，松开时还没开始录。按住稍等再开口`)
      setPhase('idle')
      return
    }

    // 立刻生成用户语音气泡（先无文字，transcript 到来后由回复流程更新）
    const durationMs = Date.now() - omniRecordStartMs
    callbacks.onUserAudio?.(recorded.wavBase64, durationMs, sessionMsgId)

    // commit 之前就登记好"这条语音在等转写"，转写一到就能对上
    const pending = { msgId: sessionMsgId, got: false }
    omniPending = pending
    try {
      await omniCommit()
    } catch (err) {
      if (omniPending === pending) omniPending = null
      if (mySeq !== sessionSeq) return
      callbacks.onError(`Omni commit 失败: ${errorText(err)}`)
      setPhase('idle')
      return
    }

    // idle 由回复流程的 omni://status 处理器在音频真正播完后统一发出
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

    // 主人一开口就停下正在播的回复（桌面端 App.tsx 按键时调 interrupt；这里兜底，重复调用是空操作）
    interruptReplyTts()

    const granted = await ensureMicPermission().catch(() => false)
    if (mySeq !== sessionSeq) {
      clearStarting(mySeq)
      return
    }
    if (!granted) {
      failStart(mySeq, '未授予麦克风权限')
      return
    }

    const config = getConfig()
    const omniApiKey = config.aiMode === 'omni' ? await resolveOmniKey(config) : null
    if (mySeq !== sessionSeq) {
      clearStarting(mySeq)
      return
    }
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
      await stopOmni(mySeq, randomUUID())
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
      requireVoiceNative().voiceCancel().catch(() => {})
    }
    if (streamRecorder) {
      streamRecorder.stop().catch(() => null)
      streamRecorder = null
    }
    void omniStop() // 实时模式下也打断正在播的回复；没有会话时是空操作
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
