// ══════════════════════════════════════════════
// Voice Service — 语音管线编排
// 移植自 macOS VoiceService.swift + OverlayManager
//
// 流程: 录音 → Qwen3 Omni(音频SSE) → Fish TTS(Tauri后端) → 播放
// ══════════════════════════════════════════════

import type { AgentConfig } from '../agent/agent-config'
import { createVoiceRecorder } from './voice-recorder'
import type { VoiceRecorder } from './voice-recorder'
import { createFishTTSTauri } from './fish-tts-tauri'

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface VoiceCallbacks {
  readonly onPhaseChange: (phase: VoicePhase) => void
  readonly onTranscript: (text: string, sessionMsgId: string) => void
  readonly onAudioLevel: (level: number) => void
  readonly onError: (message: string) => void
  readonly onUserAudio?: (wavBase64: string, durationMs: number) => void
}

export interface VoiceService {
  readonly startRecording: () => Promise<void>
  readonly stopAndProcess: () => Promise<void>
  readonly cancel: () => void
  readonly getPhase: () => VoicePhase
  readonly getAudioLevel: () => number
}

// 文本分块（按标点切分）
const PUNCTUATION = new Set('。！？；.!?;')

function shouldFlushTTS(buffer: string): boolean {
  if (buffer.length < 2) return false
  return PUNCTUATION.has(buffer[buffer.length - 1])
}

export function createVoiceService(
  getConfig: () => AgentConfig,
  getContext: () => string,
  callbacks: VoiceCallbacks,
): VoiceService {
  let phase: VoicePhase = 'idle'
  let recorder: VoiceRecorder | null = null
  let audioCtx: AudioContext | null = null
  let scheduledTime = 0

  // Session 隔离：每次新录音自增，旧 session 的所有异步回调检查此值后放弃执行
  let sessionSeq = 0
  // 当前 in-flight 的 HTTP 流取消控制器
  let currentAbort: AbortController | null = null

  // PCM 播放器
  let activeSources: { source: AudioBufferSourceNode; endTime: number }[] = []

  const playPcmChunk = (pcm: Uint8Array) => {
    if (!audioCtx) {
      audioCtx = new AudioContext({ sampleRate: 24000 })
      scheduledTime = audioCtx.currentTime
    }

    const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768
    }

    const buffer = audioCtx.createBuffer(1, float32.length, 24000)
    buffer.getChannelData(0).set(float32)

    const source = audioCtx.createBufferSource()
    source.buffer = buffer
    source.connect(audioCtx.destination)

    const now = audioCtx.currentTime
    if (scheduledTime < now) scheduledTime = now
    source.start(scheduledTime)
    const endTime = scheduledTime + buffer.duration
    scheduledTime = endTime

    // 跟踪活跃的音频源
    const mySeq = sessionSeq
    activeSources.push({ source, endTime })

    source.onended = () => {
      // 若 session 已被新录音覆盖，忽略此回调
      if (mySeq !== sessionSeq) return
      activeSources = activeSources.filter(s => s.source !== source)
      if (activeSources.length === 0 && phase === 'speaking') {
        setTimeout(() => {
          if (mySeq === sessionSeq && activeSources.length === 0 && phase === 'speaking') {
            setPhase('idle')
          }
        }, 100)
      }
    }
  }

  const setPhase = (p: VoicePhase) => {
    phase = p
    callbacks.onPhaseChange(p)
  }

  const startRecording = async () => {
    // ── 新 session 开始：使所有旧 session 的异步回调失效 ──
    sessionSeq++

    // 取消正在进行的 HTTP 流（防止旧 for-await 继续写入 onTranscript）
    if (currentAbort) { currentAbort.abort(); currentAbort = null }

    // 停止并释放旧 session 的音频源和 AudioContext
    for (const { source } of activeSources) {
      try { source.stop() } catch { /* ignore */ }
    }
    activeSources = []
    if (audioCtx && audioCtx.state !== 'closed') {
      try { await audioCtx.close() } catch { /* ignore */ }
    }
    audioCtx = null
    scheduledTime = 0

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

    // 每次语音 session 独立的消息 ID 和 session 序号快照
    const sessionMsgId = crypto.randomUUID()
    const mySeq = sessionSeq

    const result = await recorder.stop()
    recorder = null

    // 若已被新 session 抢占，静默退出
    if (mySeq !== sessionSeq) return

    if (!result) {
      callbacks.onError('录音过短或无声，已取消')
      setPhase('idle')
      return
    }

    // 通知 UI 展示录音气泡
    callbacks.onUserAudio?.(result.wavBase64, result.durationMs)

    const config = getConfig()
    if (!config.openaiApiKey) {
      callbacks.onError('AI API Key 未配置')
      setPhase('idle')
      return
    }

    const systemPrompt = buildVoiceSystemPrompt(getContext(), config)
    let fullText = ''
    let textBuffer = ''

    // Fish TTS (Tauri 后端)
    let ttsClient: ReturnType<typeof createFishTTSTauri> | null = null

    if (config.fishApiKey) {
      ttsClient = createFishTTSTauri(
        {
          apiKey: config.fishApiKey,
          referenceId: config.fishReferenceId,
          model: config.fishModel,
          sampleRate: 24000,
          proxyPort: 7890,
        },
        (pcm) => { if (mySeq === sessionSeq) playPcmChunk(pcm) },
        () => {
          if (mySeq !== sessionSeq) return
          ttsClient = null
          setPhase('idle')
        },
      )
      try {
        await ttsClient.connect()
        console.log('[VoiceService] Fish TTS (Tauri) 已连接')
      } catch (err) {
        console.warn('[VoiceService] Fish TTS 连接失败:', err)
        ttsClient = null
      }
    }

    // Qwen3 Omni 流式请求（绑定 AbortController，可被 startRecording 取消）
    const abort = new AbortController()
    currentAbort = abort

    try {
      const stream = streamOmniAudio(config, systemPrompt, result.wavBase64, abort.signal)
      setPhase('speaking')

      for await (const token of stream) {
        // 若 session 已被新录音覆盖，立即停止
        if (mySeq !== sessionSeq) break

        fullText += token
        textBuffer += token
        callbacks.onTranscript(fullText, sessionMsgId)

        if (ttsClient && shouldFlushTTS(textBuffer)) {
          await ttsClient.sendText(textBuffer)
          textBuffer = ''
        }
      }

      if (mySeq !== sessionSeq) return  // 被抢占，不做收尾

      if (ttsClient && textBuffer.length > 0) {
        await ttsClient.sendText(textBuffer)
      }
      if (ttsClient) {
        await ttsClient.flush()
      }

      if (!ttsClient) setPhase('idle')
    } catch (err) {
      if (mySeq !== sessionSeq) return  // abort 导致的错误，忽略
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('abort') && !msg.includes('AbortError')) {
        callbacks.onError(`语音处理失败: ${msg}`)
      }
      if (ttsClient) { await ttsClient.stop(); ttsClient = null }
      if (mySeq === sessionSeq) setPhase('idle')
    } finally {
      if (currentAbort === abort) currentAbort = null
    }
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

// ── Qwen3 Omni Audio Streaming ──

async function* streamOmniAudio(
  config: AgentConfig,
  systemPrompt: string,
  audioBase64: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const url = `${config.openaiApiBase}/v1/chat/completions`

  const body = {
    model: config.voiceModel,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [{
          type: 'input_audio',
          input_audio: {
            data: `data:;base64,${audioBase64}`,
            format: 'wav',
          },
        }],
      },
    ],
    modalities: ['text'],
    stream: true,
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Qwen3 Omni 错误 ${response.status}: ${text.slice(0, 200)}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('无法获取响应流')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return

      try {
        const parsed = JSON.parse(data)
        const content = parsed.choices?.[0]?.delta?.content
        if (content) yield content
      } catch { /* skip */ }
    }
  }
}

// ── System Prompt ──

function buildVoiceSystemPrompt(contextHint: string, config: AgentConfig): string {
  return `你是「暗影智能体」，独自升级系统的 AI 语音助手。

规则：
- 用简短自然的中文回答，像面对面交流一样
- 回答控制在 3-5 句以内
- 不要输出 Markdown 格式符号
- 直接回答问题，不要复述用户说的话

用户主线目标：${config.mainQuest ?? '未设定'}

## 当前上下文
${contextHint}`
}