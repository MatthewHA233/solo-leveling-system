// ══════════════════════════════════════════════
// Voice Recorder — WebView 麦克风流式录音（仅「实时（实验）」语音模式使用）
// 默认的级联语音走 Rust 原生录音（src-tauri/src/voice/），开麦快得多；
// 这里另外提供 PCM16 → WAV 的工具，给语音气泡回放用
// ══════════════════════════════════════════════

/** Omni 模式用：流式 PCM16 块回调（每次约 100ms / 1600 samples / 3200 bytes） */
export interface StreamingRecorderOptions {
  /** 每块 PCM16 LE mono 16kHz 字节，回调频率 ~10次/秒 */
  readonly onChunk: (pcm16: Uint8Array) => void
}

/** 流式录音器：边录边回调 PCM 块，stop() 时 RecordingResult 为 null（数据已流出） */
export interface StreamingVoiceRecorder {
  readonly start: (opts: StreamingRecorderOptions) => Promise<void>
  readonly stop: () => Promise<void>
  readonly getAudioLevel: () => number
  readonly isRecording: () => boolean
}

export function createStreamingRecorder(): StreamingVoiceRecorder {
  let audioCtx: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  let analyser: AnalyserNode | null = null
  let processor: ScriptProcessorNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let recording = false
  let accumulator: number[] = []   // float32 samples accumulator
  let onChunkCb: ((pcm16: Uint8Array) => void) | null = null
  let chunksEmitted = 0
  let startedAt = 0

  const CHUNK_SAMPLES = 1600  // 100ms at 16kHz
  const RESUME_TIMEOUT_MS = 500
  const SLOW_START_MS = 800

  const start = async (opts: StreamingRecorderOptions) => {
    onChunkCb = opts.onChunk
    accumulator = []
    chunksEmitted = 0
    startedAt = Date.now()

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: { ideal: TARGET_SAMPLE_RATE }, channelCount: 1 },
      video: false,
    })
    const micMs = Date.now() - startedAt

    audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    // 右 Alt 由 Rust 全局钩子触发，不算页面内的用户手势：新建的 AudioContext 可能停在 suspended，
    // onaudioprocess 一次都不回调，服务端只收到空缓冲。主动 resume，带超时以免卡住整个录音
    if (audioCtx.state === 'suspended') {
      await Promise.race([
        audioCtx.resume(),
        new Promise<void>((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS)),
      ])
    }
    source = audioCtx.createMediaStreamSource(mediaStream)

    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)

    processor = audioCtx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (e) => {
      if (!recording) return
      const input = e.inputBuffer.getChannelData(0)
      // resample if needed, then accumulate
      const sampleRate = audioCtx?.sampleRate ?? TARGET_SAMPLE_RATE
      const samples = sampleRate !== TARGET_SAMPLE_RATE
        ? Array.from(resample(new Float32Array(input), sampleRate, TARGET_SAMPLE_RATE))
        : Array.from(input)
      accumulator.push(...samples)

      // emit chunks when we have enough samples
      while (accumulator.length >= CHUNK_SAMPLES) {
        const chunk = accumulator.splice(0, CHUNK_SAMPLES)
        chunksEmitted++
        onChunkCb?.(float32ToPcm16(new Float32Array(chunk)))
      }
    }
    source.connect(processor)
    processor.connect(audioCtx.destination)

    recording = true
    const totalMs = Date.now() - startedAt
    if (totalMs > SLOW_START_MS) {
      console.warn(`[StreamRecorder] 麦克风打开较慢：getUserMedia ${micMs}ms，就绪共 ${totalMs}ms`)
    }
  }

  const stop = async (): Promise<void> => {
    if (!recording) return
    recording = false

    // flush remaining samples
    if (accumulator.length > 0 && onChunkCb) {
      chunksEmitted++
      onChunkCb(float32ToPcm16(new Float32Array(accumulator)))
      accumulator = []
    }
    onChunkCb = null
    if (chunksEmitted === 0) {
      console.warn(`[StreamRecorder] 本次没录到任何音频块：AudioContext=${audioCtx?.state ?? 'null'}，录音 ${Date.now() - startedAt}ms`)
    }

    if (processor) { processor.disconnect(); processor = null }
    if (source) { source.disconnect(); source = null }
    if (analyser) { analyser.disconnect(); analyser = null }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop())
      mediaStream = null
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      await audioCtx.close()
    }
    audioCtx = null
  }

  const getAudioLevel = (): number => {
    if (!analyser) return 0
    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i]
    return sum / data.length / 255
  }

  return { start, stop, getAudioLevel, isRecording: () => recording }
}

// ── Float32 array → PCM16 Uint8Array (LE, mono) ──

function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const int16 = clamped < 0 ? clamped * 32768 : clamped * 32767
    view.setInt16(i * 2, int16, true)
  }
  return out
}

const TARGET_SAMPLE_RATE = 16000

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate
  const outLength = Math.round(input.length / ratio)
  const output = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio
    const low = Math.floor(srcIdx)
    const high = Math.min(low + 1, input.length - 1)
    const frac = srcIdx - low
    output[i] = input[low] * (1 - frac) + input[high] * frac
  }
  return output
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

// ── 公共工具：PCM16 字节数组 → WAV Blob（用于 Omni 录音和 AI 回复气泡）──

export function pcm16ChunksToWavBlob(chunks: Uint8Array[], sampleRate: number): Blob {
  const totalBytes = chunks.reduce((s, c) => s + c.length, 0)
  const wav = new ArrayBuffer(44 + totalBytes)
  const view = new DataView(wav)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + totalBytes, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)          // PCM
  view.setUint16(22, 1, true)          // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, totalBytes, true)
  let offset = 44
  for (const chunk of chunks) {
    new Uint8Array(wav, offset, chunk.length).set(chunk)
    offset += chunk.length
  }
  return new Blob([wav], { type: 'audio/wav' })
}
