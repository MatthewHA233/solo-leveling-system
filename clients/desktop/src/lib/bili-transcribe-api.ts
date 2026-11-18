// ══════════════════════════════════════════════
// 转录的两个接口：在转录好的视频里找、让电脑下载并转录。
// 手机端同名文件导出相同，那边经局域网请求这台电脑
// ══════════════════════════════════════════════

import { API_BASE } from './local-api'

export interface TranscriptLine {
  readonly start: number | null
  readonly text: string
}

export interface TranscriptHit {
  readonly bvid: string
  readonly title: string
  readonly author_name: string
  readonly path: string | null
  /** combined | audio | visual */
  readonly kind: string
  readonly transcribed_at: string
  /** 整份转录有几句 */
  readonly total: number
  /** 符合条件的有几句（lines 可能只是前几句） */
  readonly matched: number
  readonly lines: readonly TranscriptLine[]
}

export interface TranscriptSearch {
  readonly video?: string
  readonly keywords?: readonly string[]
  readonly afterSec?: number
  readonly perVideo?: number
  readonly limit?: number
}

export type TranscribeKind = 'audio' | 'visual'

export interface TranscribeRequestResult {
  readonly accepted: readonly { readonly bvid: string; readonly title: string; readonly cover: string }[]
  /** 不在观看记录里的 BV 号 */
  readonly unknown: readonly string[]
  readonly kind: string
}

/** 一个视频的下载 / 转录进度（电脑的任务面板报的，应用重启就清空） */
export interface VideoJobStatus {
  readonly bvid: string
  readonly title: string
  readonly phase: 'download' | 'transcribe'
  /** 下载：queued fetching_meta downloading_video downloading_audio merging done error paused cancelled；转录：queued extracting uploading transcribing done error */
  readonly stage: string
  readonly percent: number | null
  readonly message: string | null
  /** 距上次变化过了几秒 */
  readonly age_sec: number
}

function searchPath(q: TranscriptSearch): string {
  const parts: string[] = []
  if (q.video) parts.push(`video=${encodeURIComponent(q.video)}`)
  if (q.keywords?.length) parts.push(`keywords=${encodeURIComponent(q.keywords.join('\n'))}`)
  if (q.afterSec && q.afterSec > 0) parts.push(`after_sec=${q.afterSec}`)
  if (q.perVideo !== undefined) parts.push(`per_video=${q.perVideo}`)
  if (q.limit !== undefined) parts.push(`limit=${q.limit}`)
  return `/api/bilibili/transcripts/search${parts.length ? `?${parts.join('&')}` : ''}`
}

async function request<T>(path: string, init: RequestInit | undefined, failMessage: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init)
  const json = (await res.json()) as { success: boolean; data?: T; error?: string }
  if (!json.success || json.data === undefined || json.data === null) throw new Error(json.error || failMessage)
  return json.data
}

export function searchVideoTranscripts(q: TranscriptSearch): Promise<TranscriptHit[]> {
  return request(searchPath(q), undefined, '查找转录失败')
}

export function requestVideoTranscribe(
  bvids: readonly string[], kind: TranscribeKind, intervalSec?: number,
): Promise<TranscribeRequestResult> {
  return request('/api/bilibili/transcribe-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bvids, kind, interval_sec: intervalSec ?? null }),
  }, '发起转录失败')
}

/** 这些视频下载 / 转录到哪一步了；不给 BV 号 = 全部 */
export function getVideoJobStatus(bvids: readonly string[] = []): Promise<VideoJobStatus[]> {
  const query = bvids.length > 0 ? `?bvids=${encodeURIComponent(bvids.join(','))}` : ''
  return request(`/api/bilibili/job-status${query}`, undefined, '查不到任务进度')
}

/** 任务面板报一条进度（只有桌面端有这个） */
export function reportVideoJobStatus(
  status: Pick<VideoJobStatus, 'bvid' | 'phase' | 'stage'> & { title?: string; percent?: number | null; message?: string | null },
): Promise<boolean> {
  return request('/api/bilibili/job-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(status),
  }, '上报任务进度失败')
}
