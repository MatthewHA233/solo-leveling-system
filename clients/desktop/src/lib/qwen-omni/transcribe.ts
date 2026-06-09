// ══════════════════════════════════════════════
// Qwen ASR FileTrans — B 站视频音轨转录工具
//
// 流程：
//   1) Rust 命令 qwen_audio_extract(file_path) 提取音轨
//   2) Rust 命令 qwen_video_upload(audio_path) 上传到 DashScope OSS
//   3) Rust 命令 qwen_asr_filetrans(oss://...) 异步 ASR 并返回句级时间戳
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'

export type TranscribeKind = 'visual' | 'audio' | 'combined'

export const ASR_FILETRANS_MODEL = 'qwen3-asr-flash-filetrans'

export interface AsrWord {
  begin_time: number
  end_time: number
  text: string
  punctuation?: string | null
}

export interface AsrSentence {
  sentence_id?: number | null
  begin_time: number
  end_time: number
  language?: string | null
  emotion?: string | null
  text: string
  words: AsrWord[]
}

export interface AsrTranscript {
  channel_id?: number | null
  text?: string | null
  sentences: AsrSentence[]
}

export interface AsrFileTransResult {
  task_id: string
  task_status: string
  transcription_url?: string | null
  usage_seconds?: number | null
  transcripts: AsrTranscript[]
  jsonl: string
  raw_json: unknown
}

/** 上传本地媒体到 DashScope，返回 oss:// URL。函数名沿用历史调用点。 */
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

export async function fileTranscribeAsr(
  fileUrl: string,
  apiKey: string,
  model = ASR_FILETRANS_MODEL,
): Promise<AsrFileTransResult> {
  return invoke<AsrFileTransResult>('qwen_asr_filetrans', {
    fileUrl,
    apiKey,
    model,
    language: 'zh',
    enableWords: true,
    pollIntervalMs: 1500,
    timeoutSecs: 900,
  })
}
