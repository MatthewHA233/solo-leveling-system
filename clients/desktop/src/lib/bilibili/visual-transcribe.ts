// ══════════════════════════════════════════════
// 图文转录的后台流程：按间隔截图 → 逐张读字 → 大模型拼成带时间点的全文 → 落库（kind=visual）
// 和转录面板里「滚动文章」那一套是同一条流水线（BiliTranscribePanel.runOcrFull），
// 这里不带预览和界面状态，给任务面板在后台跑（Fairy 发起的转录走这里）
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { getDashScopeApiKey, loadConfig } from '../agent/agent-config'
import { logModelUsage } from '../model-audit'
import { stitchOcrToSegments } from '../ocr-stitch'

const OCR_MODEL = 'qwen-vl-ocr'
const OCR_FEATURE = 'bili_ocr_transcribe'
const OCR_CONCURRENCY = 5
const MIN_INTERVAL_SEC = 1
const MAX_INTERVAL_SEC = 60
const FALLBACK_INTERVAL_SEC = 5

interface OcrFrame { index: number; path: string; ts_sec: number }

export type VisualStage = 'extracting' | 'reading' | 'stitching'

export interface VisualTranscribeJob {
  readonly bvid: string
  readonly title?: string
  readonly filePath: string
  /** 每隔几秒截一张；不给就用设置里的默认值（转录面板里调过的那个） */
  readonly intervalSec?: number | null
  readonly onStage?: (stage: VisualStage) => void
}

/** 这次用的截图间隔：传了用传的，否则用设置里的默认值 */
export function resolveFrameInterval(intervalSec?: number | null): number {
  const raw = intervalSec && intervalSec > 0 ? intervalSec : loadConfig().ocrFrameIntervalSec
  const value = Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_INTERVAL_SEC
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, value))
}

async function readFrame(path: string, apiKey: string): Promise<string> {
  const once = () => invoke<string>('qwen_vl_ocr', { imagePath: path, apiKey, model: OCR_MODEL })
  try {
    return (await once()) ?? ''
  } catch {
    // 单张失败重试一次，还不行就当这张没字
    try { return (await once()) ?? '' } catch { return '' }
  }
}

/** 跑完整条流水线；失败抛错（任务面板显示成「转录失败」） */
export async function runVisualTranscribe(job: VisualTranscribeJob): Promise<void> {
  const apiKey = getDashScopeApiKey(loadConfig())
  if (!apiKey) throw new Error('未配置 API Key（设置 → AI 模型）')
  const intervalSec = resolveFrameInterval(job.intervalSec)
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  job.onStage?.('extracting')
  const { frames } = await invoke<{ frames: OcrFrame[] }>('extract_video_frames', { filePath: job.filePath, intervalSec })
  if (frames.length === 0) throw new Error('没有截到画面')

  job.onStage?.('reading')
  const texts = new Array<string>(frames.length).fill('')
  let next = 0
  const worker = async () => {
    for (let i = next++; i < frames.length; i = next++) texts[i] = await readFrame(frames[i].path, apiKey)
  }
  await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, frames.length) }, worker))

  job.onStage?.('stitching')
  const res = await stitchOcrToSegments(frames.map((f, i) => ({ ts: f.ts_sec, text: texts[i] })))
  if (res.segments.length === 0) throw new Error('画面上没有读到成段的文字，可以把截图间隔调小再试')

  // 和音频转录同一种 JSONL（end = 下一段的起点）
  const jsonl = res.segments
    .map((s, i) => JSON.stringify({ start: s.start, end: res.segments[i + 1]?.start ?? s.start + 5, text: s.text }))
    .join('\n')

  await invoke('update_bili_transcript', {
    filePath: job.filePath, kind: 'visual', text: jsonl,
    modelId: res.model, promptType: 'ocr_stitch', source: 'frame_ocr_stitch', saveHistory: true,
  })

  void logModelUsage({
    feature: OCR_FEATURE, modelId: res.model, startedAt, durationMs: Date.now() - startedMs, success: true,
    metadata: {
      bvid: job.bvid, title: job.title, filePath: job.filePath, frameCount: frames.length, intervalSec,
      segmentCount: res.segments.length, pipeline: 'frame_ocr_stitch',
    },
  })
}
