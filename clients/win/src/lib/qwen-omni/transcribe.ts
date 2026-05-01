// ══════════════════════════════════════════════
// Qwen Video Transcription — DashScope OpenAI 兼容流式接口
//
// 流程：
//   1) Rust 命令 qwen_video_upload(file_path) → oss://...   （仅一次）
//   2) fetch /chat/completions stream=true 跑音视频/仅音频/仅画面模式
//   3) 解析 SSE，逐 token 回调 onChunk
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { createJsonlLineBuffer, type TranscriptSegment } from './segments'
import type { DashScopeUsage } from '../model-audit'

const CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

export type TranscribeKind = 'visual' | 'audio' | 'combined'
export type PromptType = 'general' | 'text'
export type MediaType = 'video' | 'audio'

/** 画面（视觉）转录 prompt — 屏幕正文/OCR 优先，输出 JSONL，每段一行 */
export const VISUAL_TRANSCRIBE_PROMPT = `请你只针对这个视频画面中的"可读正文/字幕/弹幕/UI文字"按时间戳生成逐字转录。严格按 JSONL（JSON Lines）格式输出：每一行一个独立的 JSON 对象，不要外层数组，不要 markdown 围栏，不要任何解释文字。

每行的 JSON 必须包含字段：
- start: 段落起始秒数（数字，例如 0.0、12.5）
- end: 段落结束秒数（数字）
- text: 该时间段画面中可见正文的逐字摘录（字符串）
- tags: 字符串数组，可选标签子集 ["article","subtitle","ui","danmaku","none"]

要求：
1. 这是 OCR/正文摘录任务，不是分镜描述任务。不要描述镜头、人物动作、画面风格、背景、头像、按钮、点赞数等边角料，除非画面完全没有可读正文。
2. text 必须直接写屏幕上可见的正文原文；不要加前缀或解释。禁止使用："正文是："、"画面显示："、"接下来说了："、"文字内容为："、"可以看到："、"继续展示："。
3. 不要总结、不要改写、不要提炼观点、不要补全屏幕外内容、不要用省略号代替看得见的内容。可见多少就逐字抄多少；看不清的少数字可用 [?] 标记。
4. 对滚动文章/帖子/评论区：每次新正文出现就输出一段；已经完整输出过的正文不要重复；新出现的句子和段落不能漏。
5. 只在画面没有任何可读正文时，才输出一条极简说明，例如 "无可读正文"，tags 设为 ["none"]。
6. 不要描述声音内容（人声 / 背景音 / 音乐留给音频转录）。
7. 屏幕上出现的数字、英文、符号、标点按原样抄录；不要把阿拉伯数字改成中文数字，也不要把中文数字强行改写，除非屏幕本身就是那样写的。
8. text 中不要换行符。

示例：
{"start":0.0,"end":2.5,"text":"真的每个女生都慕强吗？","tags":["article"]}
{"start":2.5,"end":5.0,"text":"我不Care政治正确，我现在就要终结这个问题，信不信由你们。","tags":["article"]}
{"start":5.0,"end":9.0,"text":"以心离心离婚了分手了被绿了记得回来给我点赞。","tags":["article"]}`

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

/** 通用音视频合并转录 prompt — 聚焦场景+人声，JSONL */
export const COMBINED_GENERAL_PROMPT = `请你对这个视频进行音视频综合转录，严格按 JSONL（JSON Lines）格式输出：每一行一个独立的 JSON 对象，不要外层数组，不要 markdown 围栏，不要任何解释文字。

每行 JSON 必须包含字段：
- start: 起始秒数（数字，例如 0.0、12.5）
- end: 结束秒数（数字）
- text: 该段核心内容（字符串）
- kind: 字符串，取值 "speech" | "bgm" | "sfx" | "ambient" | "scene"
- speaker: 说话人标识（字符串或 null；非 speech 时设 null）

字段说明：
- speech: 人声对白/旁白，text = 完整转录
- scene: 画面事件/场景，text = 镜头语言、人物动作、屏幕上的文字/UI（按原样抄录）
- bgm/sfx/ambient: 背景音乐 / 音效 / 环境音，text = 简短描述

要求：
1. 按事件分段，每段 1–5 秒
2. 有人声时输出 speech 段，完整转录；若同时画面有重要文字/UI 变化，另加一行 scene
3. 无人声时：有视觉事件 → scene；背景音乐 → bgm；音效 → sfx；环境音 → ambient
4. 屏幕字幕与人声冲突时，以字幕为准修正专有名词/数字/英文术语
5. 【数字规则·硬性】技术参数/度量/单位/倍率/百分比/版本号一律阿拉伯数字（156ms、1.4×、1080p、Conc=8）；惯用语/概数保留中文（"两三个""一会儿"）
6. text 中不要换行符

示例：
{"start":0.0,"end":3.2,"text":"主讲人：Flash 模式延迟为 156ms，Plus 模式为 220ms","kind":"speech","speaker":"主讲人"}
{"start":3.2,"end":5.0,"text":"幻灯片标题：性能对比实验 · Flash vs Plus","kind":"scene","speaker":null}
{"start":5.0,"end":7.5,"text":"低沉电子节拍渐入","kind":"bgm","speaker":null}`

/** 文字/PPT 型音视频合并转录 prompt — 屏幕正文/OCR + 人声，JSONL */
export const COMBINED_TEXT_PROMPT = `请你对这个视频进行"屏幕正文优先"的转录，适合讲座、幻灯片演示、教程、代码演示、文章阅读/滚动浏览类视频。严格按 JSONL（JSON Lines）格式输出：每一行一个独立的 JSON 对象，不要外层数组，不要 markdown 围栏，不要任何解释文字。

每行 JSON 必须包含字段：
- start: 起始秒数（数字，例如 0.0、12.5）
- end: 结束秒数（数字）
- text: 该段人声或屏幕正文的逐字转录（字符串）
- kind: 字符串，取值 "speech" | "slide" | "bgm" | "sfx" | "ambient"
- speaker: 说话人标识（字符串或 null；非 speech 时设 null）

字段说明：
- speech: 人声讲解/旁白，text = 完整转录
- slide: 屏幕上出现的文字内容（幻灯片、代码、公式、文章/知乎/网页正文），text = 直接写原文逐字摘录（保留标点，不换行）
- bgm/sfx/ambient: 背景音乐 / 音效 / 环境音，text = 简短描述

【核心要求·最重要】
1. 每当屏幕正文发生变化（滚动、切页、弹窗）就立即输出一条 slide 段；每段 1–4 秒
2. slide 的 text 必须直接写**当前帧屏幕上可见的正文原文**。禁止使用："正文是："、"画面显示："、"接下来说了："、"文字内容为："、"可以看到："、"继续展示："。
3. 不要总结、不要改写、不要提炼观点、不要省略、不要缩写、不要用自己的话解释。可见多少就逐字抄多少；看不清的少数字可用 [?] 标记。
4. 对于滚动浏览长文（如知乎、微信文章、网页），每次滚动都视为新内容，必须抄录新出现的段落；已在前一段中完整抄录过的内容不要重复
5. speech 与 slide 并发时各起一行；不要把人声和屏幕文字合并进同一段
6. 屏幕字幕与人声冲突时以字幕为准修正专有名词/数字/英文术语
7. 屏幕上出现的数字、英文、符号、标点按原样抄录；不要把阿拉伯数字改成中文数字，也不要把中文数字强行改写，除非屏幕本身就是那样写的
8. text 中不要换行符

示例（滚动浏览文章）：
{"start":0.0,"end":2.5,"text":"真的每个女生都慕强吗？","kind":"slide","speaker":null}
{"start":2.5,"end":5.0,"text":"我不Care政治正确，我现在就要终结这个问题，信不信由你们。","kind":"slide","speaker":null}
{"start":5.0,"end":7.5,"text":"以心离心离婚了分手了被绿了记得回来给我点赞。","kind":"slide","speaker":null}`

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
  return invoke<string>('qwen_video_upload', { apiKey, model, filePath })
}

/**
 * 从视频中提取音轨为 m4a，返回本地音频文件路径。
 * 结果在同目录缓存，重复调用直接复用。
 */
export async function extractAudio(filePath: string): Promise<string> {
  return invoke<string>('qwen_audio_extract', { filePath })
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
  /** video_url 或 input_audio */
  mediaType?: MediaType
  /** input_audio.format，例如 m4a/mp3/wav */
  audioFormat?: string
}): () => void {
  const { ossUrl, apiKey, model, prompt, kind, callbacks, mediaType = 'video', audioFormat = 'm4a' } = opts
  const controller = new AbortController()
  const lineBuf = createJsonlLineBuffer(kind)
  let totalText = ''

  ;(async () => {
    try {
      const mediaContent = mediaType === 'audio'
        ? { type: 'input_audio', input_audio: { data: ossUrl, format: audioFormat } }
        : { type: 'video_url', video_url: { url: ossUrl } }

      const body = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        modalities: ['text'],
        enable_thinking: false,
        messages: [
          {
            role: 'user',
            content: [
              mediaContent,
              { type: 'text', text: prompt },
            ],
          },
        ],
      }
      console.log('[Transcribe] 请求 chat/completions', {
        model,
        ossUrl,
        mediaType,
        audioFormat,
        promptLen: prompt.length,
        enableThinking: body.enable_thinking,
      })

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
              const choiceDelta = json?.choices?.[0]?.delta
              const delta: string | undefined = choiceDelta?.content
              const reasoning: string | undefined = choiceDelta?.reasoning_content
              const finishReason: string | undefined = json?.choices?.[0]?.finish_reason
              const usage = json?.usage
              if (usage) callbacks.onUsage?.(usage)
              if (delta) {
                totalText += delta
                callbacks.onChunk(delta)
                const segs = lineBuf.push(delta)
                if (segs.length && callbacks.onSegment) callbacks.onSegment(segs)
              } else if (reasoning) {
                if (eventCount <= 3) {
                  console.warn('[Transcribe] 收到 reasoning_content；请求已设置 enable_thinking=false', reasoning.slice(0, 120))
                }
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
        console.log('[Transcribe] AbortError（用户停止），已累计', totalText.length, '字')
        // 有部分内容时保存，避免浪费已消耗的 token
        if (totalText.trim()) {
          const tail = lineBuf.flush()
          if (tail.length && callbacks.onSegment) callbacks.onSegment(tail)
          callbacks.onDone(totalText)
        }
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
