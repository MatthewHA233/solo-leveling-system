// ══════════════════════════════════════════════
// Fairy 聊天组件用到的纯函数和常量（对应 desktop ChatPanel 顶部的旋钮和小工具）
// 不依赖 React Native，可以直接用 node 验证
// ══════════════════════════════════════════════

// ── 可调旋钮 ──
export const TEXT_SIZE = 14.5
export const TEXT_LINE_HEIGHT = 23
export const LED_ROW = 3            // 音量柱按格取整（每格高度），桌面端 LED 点阵的取整规则
export const WAVEFORM_BARS = 24
export const LISTEN_BARS = 28
export const CONTEXT_SEGMENTS = 8

export const STATE_LABEL: Record<'idle' | 'thinking' | 'listening' | 'speaking', string> = {
  idle: '待命',
  thinking: '思考中',
  listening: '在听',
  speaking: '说话中',
}

/** 纯 ASCII 的呼号用大写（FAIRY），中文呼号原样显示 */
export function displayCallsign(name: string): string {
  return /^[\x20-\x7E]+$/.test(name) ? name.toUpperCase() : name
}

/** 音量 0–1 → 柱高（按 3px 一格取整） */
export function ledHeight(v: number, maxRows: number): number {
  return Math.max(1, Math.round(Math.min(1, Math.max(0, v)) * maxRows)) * LED_ROW
}

/** voice://level 的原始音量 → 0–1：和 Fairy 悬浮窗同一套映射，先减底噪再放大 */
export function mapVoiceLevel(level: number): number {
  return Math.min(1, Math.max(0, level - 0.012) * 6)
}

/** 上下文段码条亮几格（0–1 向上取整到格，有占用至少亮一格） */
export function litSegments(value: number, count: number): number {
  const clamped = Math.min(1, Math.max(0, value))
  return clamped > 0 ? Math.max(1, Math.ceil(clamped * count)) : 0
}

export function contextPercent(ratio: number): number {
  return Math.round(Math.min(1, ratio) * 100)
}

function toDate(ts: number | string): Date {
  return new Date(ts)
}

/** 消息时刻 HH:MM；非法时间返回空串 */
export function fmtClock(ts: number | string): string {
  const d = toDate(ts)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 调试弹窗里的时刻 HH:MM:SS（本地时区；ISO 字符串直接截取拿到的是 UTC，和气泡时刻差 8 小时） */
export function fmtClockSeconds(ts: number | string): string {
  const d = toDate(ts)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function fmtSec(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/** 思考过程字数标签 */
export function charLabel(length: number): string {
  return length >= 1000 ? `${(length / 1000).toFixed(1)}K` : String(length)
}

/** 系统消息是不是错误（chat-controller 写错误时以「错误」开头） */
export function isSystemError(content: string): boolean {
  return content.startsWith('错误')
}

export function gazeLabel(kind: 'thought' | 'bili_transcript', title: string | null, text: string): string {
  return `${kind === 'thought' ? '想法卡' : `B站《${title ?? '未命名'}》`} · ${text.slice(0, 42)}`
}

/** 尝试格式化 JSON 字符串，失败原样返回 */
export function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

/** 折叠时的预览文字 */
export function previewText(text: string, max = 100): string {
  return text.slice(0, max).replace(/\n+/g, ' ↵ ')
}

/**
 * 超长文字切成多段渲染：Android 单个 Text 太长时可能整段空白（硬件层纹理上限）。
 * 优先在换行处切，切完拼起来和原文一字不差。
 */
export function splitLongText(text: string, chunk = 6000): string[] {
  if (text.length <= chunk) return [text]
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + chunk)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end)
      if (nl > start + chunk / 2) end = nl + 1
      else {
        // 不要切在代理对中间
        const c = text.charCodeAt(end - 1)
        if (c >= 0xd800 && c <= 0xdbff) end -= 1
      }
    }
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}

// ── 语音波形 ──

/** 把任意长度的波形重采样到 bars 根（取每段最大值，短促的音节不被抹平） */
export function resampleWaveform(values: readonly number[], bars: number): number[] {
  if (values.length === 0) return []
  if (values.length === bars) return [...values]
  const out: number[] = []
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * values.length) / bars)
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / bars))
    let peak = 0
    for (let j = from; j < to && j < values.length; j++) peak = Math.max(peak, values[j])
    out.push(peak)
  }
  return out
}

/**
 * 没有真实波形时的占位：桌面端解码失败是随机 0.25~1，这里用路径做种子，
 * 同一条语音每次长得一样（重渲染不会跳）
 */
export function placeholderWaveform(seed: string, bars: number): number[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const out: number[] = []
  for (let i = 0; i < bars; i++) {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    out.push(0.25 + (((h >>> 0) % 1000) / 1000) * 0.75)
  }
  return out
}

function b64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  if (code === 43) return 62
  if (code === 47) return 63
  return -1
}

/** 取 base64 里第 byteIndex 个字节，不用整段解码（录音可能好几 MB） */
function b64ByteAt(b64: string, byteIndex: number): number {
  const group = Math.floor(byteIndex / 3)
  const off = byteIndex % 3
  const p = group * 4
  if (p + 3 >= b64.length) return 0
  const a = b64Value(b64.charCodeAt(p))
  const b = b64Value(b64.charCodeAt(p + 1))
  const c = b64Value(b64.charCodeAt(p + 2))
  const d = b64Value(b64.charCodeAt(p + 3))
  if (off === 0) return ((a << 2) | (b >> 4)) & 0xff
  if (off === 1) return ((b << 4) | (Math.max(c, 0) >> 2)) & 0xff
  return ((Math.max(c, 0) << 6) | Math.max(d, 0)) & 0xff
}

/**
 * 从 16bit PCM WAV 的 base64 算真实波形（RMS 采样，更贴近听感，对应桌面端 decodeAudioData 那段）。
 * 手机端录音 / 回复的 WAV 在 JS 里拿得到（voiceStop / takeAudio），刚落盘时可以算一次放进 audio.waveform。
 * 不是 WAV 或数据太短返回空数组，调用方退回占位波形。每根柱子最多抽样 400 点，长录音也不卡。
 */
export function waveformFromWavBase64(wavBase64: string, bars = WAVEFORM_BARS): number[] {
  const HEADER = 44
  const totalBytes = Math.floor((wavBase64.length * 3) / 4)
  if (totalBytes <= HEADER + bars * 2) return []
  // 'RIFF' 的 base64 前缀
  if (wavBase64.slice(0, 4) !== 'UklG') return []
  const samples = Math.floor((totalBytes - HEADER) / 2)
  const block = Math.floor(samples / bars)
  if (block <= 0) return []
  const step = Math.max(1, Math.floor(block / 400))
  const rms: number[] = []
  for (let i = 0; i < bars; i++) {
    let sum = 0
    let count = 0
    for (let j = 0; j < block; j += step) {
      const at = HEADER + (i * block + j) * 2
      let v = b64ByteAt(wavBase64, at) | (b64ByteAt(wavBase64, at + 1) << 8)
      if (v >= 0x8000) v -= 0x10000
      const f = v / 32768
      sum += f * f
      count++
    }
    rms.push(Math.sqrt(sum / Math.max(1, count)))
  }
  const max = Math.max(...rms, 0.001)
  return rms.map((v) => v / max)
}
