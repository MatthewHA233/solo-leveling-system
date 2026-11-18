// ══════════════════════════════════════════════
// 转录的两个接口：在转录好的视频里找、让电脑下载并转录（desktop src/lib/bili-transcribe-api.ts 的手机端）。
// 数据来源 ② 桌面端：视频和转录都在电脑上，这里经局域网请求；连不上时抛 DesktopUnreachableError
// ══════════════════════════════════════════════

import { desktopRequest, DesktopApiError } from './desktop-api'

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

function searchPath(q: TranscriptSearch): string {
  const parts: string[] = []
  if (q.video) parts.push(`video=${encodeURIComponent(q.video)}`)
  if (q.keywords?.length) parts.push(`keywords=${encodeURIComponent(q.keywords.join('\n'))}`)
  if (q.afterSec && q.afterSec > 0) parts.push(`after_sec=${q.afterSec}`)
  if (q.perVideo !== undefined) parts.push(`per_video=${q.perVideo}`)
  if (q.limit !== undefined) parts.push(`limit=${q.limit}`)
  return `/api/bilibili/transcripts/search${parts.length ? `?${parts.join('&')}` : ''}`
}

export async function searchVideoTranscripts(q: TranscriptSearch): Promise<TranscriptHit[]> {
  const json = await desktopRequest<TranscriptHit[]>('GET', searchPath(q))
  if (!json.success || !json.data) throw new DesktopApiError(json.error || '查找转录失败')
  return json.data
}

export async function requestVideoTranscribe(
  bvids: readonly string[], kind: TranscribeKind, intervalSec?: number,
): Promise<TranscribeRequestResult> {
  const json = await desktopRequest<TranscribeRequestResult>(
    'POST', '/api/bilibili/transcribe-request', { bvids, kind, interval_sec: intervalSec ?? null },
  )
  if (!json.success || !json.data) throw new DesktopApiError(json.error || '发起转录失败')
  return json.data
}
