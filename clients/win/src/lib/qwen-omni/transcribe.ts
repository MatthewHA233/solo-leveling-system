// ══════════════════════════════════════════════
// Qwen Video Transcription — DashScope OpenAI 兼容流式接口
//
// 流程：
//   1) Rust 命令 qwen_video_upload(file_path) → oss://...   （仅一次）
//   2) fetch /chat/completions stream=true 用不同 prompt 跑两路
//      - 画面转录：聚焦视觉
//      - 音频转录：聚焦人声 + 字幕 + 音乐 + 环境音
//   3) 解析 SSE，逐 token 回调 onChunk
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { createJsonlLineBuffer, type TranscriptSegment } from './segments'
import type { DashScopeUsage } from '../model-audit'

const CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

export type TranscribeKind = 'visual' | 'audio'

/** 画面（视觉）转录 prompt — 输出 JSONL，每段一行 */
export const VISUAL_TRANSCRIBE_PROMPT = `请你针对这个视频的"画面"按时间戳生成结构化转录，严格按 JSONL（JSON Lines）格式输出：每一行一个独立的 JSON 对象，不要外层数组，不要 markdown 围栏，不要任何解释文字。

每行的 JSON 必须包含字段：
- start: 段落起始秒数（数字，例如 0.0、12.5）
- end: 段落结束秒数（数字）
- text: 该段画面描述（字符串）
- tags: 字符串数组，可选标签子集 ["camera","action","scene","subtitle","ui","danmaku"]

要求：
1. 按事件分段，每段 1–5 秒
2. text 描述：镜头语言、人物动作/表情、场景、文字与 UI 元素；屏幕上出现的字幕、弹幕完整抄录到 text
3. 不要描述声音内容（人声 / 背景音 / 音乐留给音频转录）
4. 【数字规则·硬性】"技术参数 / 度量 / 含单位 / 倍率 / 百分比 / 版本号 / 配置值"一律阿拉伯数字（156ms、1.4×、1080p、Conc=8、v0.1.1）；只有"惯用语 / 概数"保留中文（"两三个""一会儿""第一次""七八成"）。屏幕上出现的字幕、弹幕请**逐字按原样抄录**（屏幕写"156ms"就抄"156ms"，不要改成中文数字）
5. text 中不要换行符

示例：
{"start":0.0,"end":2.5,"text":"开场画面：黑底白字标题 Qwen3.5-Omni-Plus","tags":["scene","subtitle"]}
{"start":2.5,"end":5.0,"text":"镜头切换到主讲人正脸特写","tags":["camera"]}`

/** 音频转录 prompt — 输出 JSONL，每段一行 */
export const AUDIO_TRANSCRIBE_PROMPT = `请你只针对这个视频的"音频"按时间戳生成结构化转录，严格按 JSONL（JSON Lines）格式输出：每一行一个独立的 JSON 对象，不要外层数组，不要 markdown 围栏，不要任何解释文字。

每行的 JSON 必须包含字段：
- start: 段落起始秒数（数字，例如 0.0、12.5）
- end: 段落结束秒数（数字）
- text: 该段音频内容（字符串）
- speaker: 说话人标识（字符串或 null；无人声时设 null）
- kind: 字符串，取值 "speech" | "bgm" | "sfx" | "ambient"

要求：
1. 按事件分段，每段 1–5 秒
2. speech 段 text 完整转录人声对白/旁白/念白；非 speech 段 text 为简短描述
3. 不要描述画面内容（视觉留给画面转录）
4. 如果视频画面有字幕（说话人配套的逐字幕、PPT 上的术语 / 数字 / 产品名 / 公式 / 代码等），优先以字幕为准来修正人声中识别不清的专有名词、数字、英文术语；字幕和发音冲突时以字幕为准
5. 【数字规则·硬性】凡是"技术参数 / 度量 / 含单位 / 倍率 / 百分比 / 版本号 / 配置值 / 比分 / 编号"这一类数字，无论说话人念的是"一百五十六"还是"two hundred"，转录时**必须**写成阿拉伯数字 + 单位：
   - "一百五十六毫秒" → 156ms
   - "两百二十毫秒" → 220ms
   - "两百一十八" → 218
   - "一点四倍" → 1.4 倍
   - "Conc 等于八" → Conc=8
   - "三十六种语言" → 36 种语言
   - "一百一十三种" → 113 种
   只有"惯用语 / 概数 / 序数口语"才保留中文（"两三个""一会儿""第一次""七八成"）。绝对禁止把带单位的数字写成"一百五十六毫秒""两百二十毫秒"这种中文数字形式。
6. text 中不要换行符

示例：
{"start":0.0,"end":3.2,"text":"主讲人：Flash 模式延迟为 156ms，而 Plus 模式为 220ms","speaker":"主讲人","kind":"speech"}
{"start":3.2,"end":7.5,"text":"主讲人：高并发 Conc=8 场景下，Flash 吞吐量 TPS 提升至 Plus 的 1.4 倍","speaker":"主讲人","kind":"speech"}
{"start":7.5,"end":9.0,"text":"低沉电子节拍渐入","speaker":null,"kind":"bgm"}`

/** 兼容老导出 */
export const DEFAULT_VIDEO_PROMPT = VISUAL_TRANSCRIBE_PROMPT

export interface TranscribeCallbacks {
  onUploadStart?: () => void
  onUploaded?: (ossUrl: string) => void
  /** 原始 delta 文本（rare，仅供日志/原文显示） */
  onChunk: (delta: string) => void
  /** 完整一段 segment 解析出来时回调（可能一次多个） */
  onSegment?: (segments: TranscriptSegment[]) => void
  onUsage?: (usage: DashScopeUsage) => void
  onDone: (fullText: string) => void
  onError: (msg: string) => void
}

/** 上传本地视频到 DashScope，返回 oss:// URL */
export async function uploadVideo(
  filePath: string,
  apiKey: string,
  model: string,
): Promise<string> {
  return invoke<string>('qwen_video_upload', {
    apiKey,
    model,
    filePath,
  })
}

/** 已有 oss:// 的转录（不再重新上传）。返回 abort 函数。 */
export function streamTranscribeFromOss(opts: {
  ossUrl: string
  apiKey: string
  model: string
  prompt: string
  /** 用于按行解析 segment：'visual' | 'audio' */
  kind: TranscribeKind
  callbacks: TranscribeCallbacks
}): () => void {
  const { ossUrl, apiKey, model, prompt, kind, callbacks } = opts
  const controller = new AbortController()
  const lineBuf = createJsonlLineBuffer(kind)

  ;(async () => {
    try {
      const body = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        modalities: ['text'],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'video_url', video_url: { url: ossUrl } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }
      console.log('[Transcribe] 请求 chat/completions', { model, ossUrl, promptLen: prompt.length })

      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-OssResourceResolve': 'enable',
        },
        body: JSON.stringify(body),
      })
      console.log('[Transcribe] 响应状态', resp.status, resp.headers.get('content-type'))

      if (!resp.ok || !resp.body) {
        const errText = await resp.text().catch(() => '')
        console.error('[Transcribe] API 错误', resp.status, errText)
        callbacks.onError(`API 错误 [${resp.status}]: ${errText.slice(0, 500)}`)
        return
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      let totalText = ''
      let eventCount = 0

      const flushDone = () => {
        const tail = lineBuf.flush()
        if (tail.length && callbacks.onSegment) callbacks.onSegment(tail)
        callbacks.onDone(totalText)
      }

      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          console.log('[Transcribe] 流结束 events=', eventCount, 'chars=', totalText.length)
          break
        }
        buf += decoder.decode(value, { stream: true })

        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of event.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') {
              console.log('[Transcribe] [DONE] 收到')
              flushDone()
              return
            }
            try {
              const json = JSON.parse(payload)
              eventCount++
              const delta: string | undefined = json?.choices?.[0]?.delta?.content
              const finishReason: string | undefined = json?.choices?.[0]?.finish_reason
              const usage = json?.usage
              if (usage) callbacks.onUsage?.(usage)
              if (delta) {
                totalText += delta
                callbacks.onChunk(delta)
                const segs = lineBuf.push(delta)
                if (segs.length && callbacks.onSegment) callbacks.onSegment(segs)
              } else if (finishReason || usage) {
                console.log('[Transcribe] 终止事件', { finishReason, usage })
              } else if (eventCount <= 3) {
                console.log('[Transcribe] 首批事件原文', payload.slice(0, 300))
              }
            } catch (parseErr) {
              console.warn('[Transcribe] JSON 解析失败', parseErr, payload.slice(0, 200))
            }
          }
        }
      }
      flushDone()
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        console.log('[Transcribe] AbortError（用户停止）')
        return
      }
      console.error('[Transcribe] 异常', e)
      callbacks.onError(String(e))
    }
  })()

  return () => controller.abort()
}

/**
 * 流式转录：完成上传 + chat/completions stream
 * 返回一个 abort 函数，调用可中断
 */
export function streamTranscribe(opts: {
  filePath: string
  apiKey: string
  model: string
  prompt?: string
  kind?: TranscribeKind
  callbacks: TranscribeCallbacks
}): () => void {
  const { filePath, apiKey, model, prompt, kind, callbacks } = opts
  let inner: (() => void) | null = null
  let aborted = false

  ;(async () => {
    try {
      console.log('[Transcribe] 开始上传', { filePath, model })
      callbacks.onUploadStart?.()
      const ossUrl = await uploadVideo(filePath, apiKey, model)
      if (aborted) {
        console.log('[Transcribe] 上传后已 abort')
        return
      }
      console.log('[Transcribe] 上传完成', ossUrl)
      callbacks.onUploaded?.(ossUrl)
      inner = streamTranscribeFromOss({
        ossUrl, apiKey, model,
        prompt: prompt ?? VISUAL_TRANSCRIBE_PROMPT,
        kind: kind ?? 'visual',
        callbacks,
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      console.error('[Transcribe] 上传异常', e)
      callbacks.onError(String(e))
    }
  })()

  return () => {
    aborted = true
    inner?.()
  }
}
