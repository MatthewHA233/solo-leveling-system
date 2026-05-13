// ══════════════════════════════════════════════
// Voice Recorder — 麦克风录音 → 16kHz mono WAV
// 移植自 macOS VoiceService.swift (recording部分)
// ══════════════════════════════════════════════

export interface RecordingResult {
  readonly wavBase64: string    // base64 encoded WAV
  readonly durationMs: number
  readonly maxLevel: number
}

export interface VoiceRecorder {
  readonly start: () => Promise<void>
  readonly stop: () => Promise<RecordingResult | null>
  readonly getAudioLevel: () => number
  readonly isRecording: () => boolean
}

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

  const CHUNK_SAMPLES = 1600  // 100ms at 16kHz

  const start = async (opts: StreamingRecorderOptions) => {
    onChunkCb = opts.onChunk
    accumulator = []

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: { ideal: TARGET_SAMPLE_RATE }, channelCount: 1 },
      video: false,
    })

    audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
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
        onChunkCb?.(float32ToPcm16(new Float32Array(chunk)))
      }
    }
    source.connect(processor)
    processor.connect(audioCtx.destination)

    recording = true
  }

  const stop = async (): Promise<void> => {
    if (!recording) return
    recording = false

    // flush remaining samples
    if (accumulator.length > 0 && onChunkCb) {
      onChunkCb(float32ToPcm16(new Float32Array(accumulator)))
      accumulator = []
    }
    onChunkCb = null

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

export function createVoiceRecorder(): VoiceRecorder {
  let audioCtx: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  let analyser: AnalyserNode | null = null
  let processor: ScriptProcessorNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let recording = false
  let chunks: Float32Array[] = []
  let startTime = 0
  let maxLevel = 0

  const start = async () => {
    stop() // 确保干净
    chunks = []
    maxLevel = 0

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: { ideal: TARGET_SAMPLE_RATE }, channelCount: 1 },
      video: false,
    })

    audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    source = audioCtx.createMediaStreamSource(mediaStream)

    // Analyser for audio level
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)

    // ScriptProcessor to capture raw PCM
    processor = audioCtx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      const copy = new Float32Array(input.length)
      copy.set(input)
      chunks.push(copy)

      // Track max level
      for (let i = 0; i < input.length; i++) {
        const abs = Math.abs(input[i])
        if (abs > maxLevel) maxLevel = abs
      }
    }
    source.connect(processor)
    processor.connect(audioCtx.destination)

    recording = true
    startTime = Date.now()
  }

  const stop = async (): Promise<RecordingResult | null> => {
    if (!recording) return null
    recording = false

    const durationMs = Date.now() - startTime

    // Cleanup audio nodes
    if (processor) { processor.disconnect(); processor = null }
    if (source) { source.disconnect(); source = null }
    if (analyser) { analyser.disconnect(); analyser = null }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop())
      mediaStream = null
    }

    const sampleRate = audioCtx?.sampleRate ?? TARGET_SAMPLE_RATE
    if (audioCtx && audioCtx.state !== 'closed') {
      await audioCtx.close()
    }
    audioCtx = null

    if (chunks.length === 0) return null

    // Merge chunks
    const totalLength = chunks.reduce((s, c) => s + c.length, 0)
    const merged = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    chunks = []

    // Resample if needed
    const samples = sampleRate !== TARGET_SAMPLE_RATE
      ? resample(merged, sampleRate, TARGET_SAMPLE_RATE)
      : merged

    // Check if audio is too quiet
    if (maxLevel < 0.001) {
      console.warn('[VoiceRecorder] 录音过短或无声')
      return null
    }

    // Convert to 16-bit WAV
    const wavBytes = float32ToWav(samples, TARGET_SAMPLE_RATE)
    const wavBase64 = arrayBufferToBase64(wavBytes)

    return { wavBase64, durationMs, maxLevel }
  }

  const getAudioLevel = (): number => {
    if (!analyser) return 0
    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i]
    return sum / data.length / 255
  }

  return {
    start,
    stop,
    getAudioLevel,
    isRecording: () => recording,
  }
}

// ── Resample (linear interpolation) ──

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

// ── Float32 → 16-bit PCM WAV ──

function float32ToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)                            // chunk size
  view.setUint16(20, 1, true)                             // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true)
  view.setUint16(32, numChannels * bytesPerSample, true)
  view.setUint16(34, bitsPerSample, true)

  // data chunk
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // PCM samples (float32 → int16)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const int16 = clamped < 0 ? clamped * 32768 : clamped * 32767
    view.setInt16(offset, int16, true)
    offset += 2
  }

  return buffer
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
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
