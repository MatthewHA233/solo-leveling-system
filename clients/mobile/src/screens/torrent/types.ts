import type { TorrentCapture } from '../../lib/perception'

export type TorrentParserId = 'bilibili' | (string & {})

export type TorrentSourceRef = {
  rowId: number
  eventTimeMs: number
  packageName: string
  windowClass: string
  text?: string
}

export type TorrentFormalActionDraft = {
  parserId: TorrentParserId
  parserVersion: number
  key: string
  packageName: string
  appLabel: string
  kind: string
  startTs: number
  endTs: number
  title?: string
  upName?: string
  isStory?: boolean
  payload: Record<string, unknown>
  sourceRefs: TorrentSourceRef[]
}

export type TorrentFormalCardDraft = {
  parserId: TorrentParserId
  parserVersion: number
  key: string
  packageName: string
  appLabel: string
  cardKind: string
  startTs: number
  endTs: number
  title?: string
  upName?: string
  payload: Record<string, unknown>
  sourceRefs: TorrentSourceRef[]
}

export type TorrentParserModule<TListItem> = {
  id: TorrentParserId
  version: number
  displayName: string
  packages: readonly string[]
  accent: string
  canParse: (item: TorrentCapture) => boolean
  getPackageLabel: (packageName: string | null | undefined) => string
  buildFeedListItems: (items: TorrentCapture[]) => TListItem[]
  buildActionListItems: (items: TorrentCapture[]) => TListItem[]
  buildFormalActions?: (items: TorrentCapture[]) => TorrentFormalActionDraft[]
  buildFormalCards?: (items: TorrentCapture[]) => TorrentFormalCardDraft[]
}

export function sourceRefsInRange(
  items: TorrentCapture[],
  startTs: number,
  endTs: number,
  cap: number = 64,
): TorrentSourceRef[] {
  const out: TorrentSourceRef[] = []
  for (const item of items) {
    if (item.eventTimeMs < startTs || item.eventTimeMs > endTs) continue
    out.push({
      rowId: item.rowId,
      eventTimeMs: item.eventTimeMs,
      packageName: item.packageName,
      windowClass: item.windowClass,
      text: item.text,
    })
    if (out.length >= cap) break
  }
  return out
}
