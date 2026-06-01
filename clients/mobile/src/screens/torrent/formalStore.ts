import {
  saveTorrentFormalDay,
  type TorrentCapture,
  type TorrentFormalActionInput,
  type TorrentFormalCardInput,
  type TorrentFormalSaveResult,
} from '../../lib/perception'
import {
  buildTorrentFormalActionDrafts,
  buildTorrentFormalCardDrafts,
  torrentParserModules,
} from './registry'
import type { TorrentFormalActionDraft, TorrentFormalCardDraft, TorrentParserId } from './types'

export type TorrentFormalPersistResult = {
  parserCount: number
  actionCount: number
  cardCount: number
  results: Array<TorrentFormalSaveResult & { parserId: TorrentParserId; parserVersion: number }>
}

type DraftGroup = {
  parserId: TorrentParserId
  parserVersion: number
  actions: TorrentFormalActionDraft[]
  cards: TorrentFormalCardDraft[]
}

function groupKey(parserId: TorrentParserId, parserVersion: number): string {
  return `${parserId}@${parserVersion}`
}

function getOrCreateGroup(
  groups: Map<string, DraftGroup>,
  parserId: TorrentParserId,
  parserVersion: number,
): DraftGroup {
  const key = groupKey(parserId, parserVersion)
  const existing = groups.get(key)
  if (existing) return existing
  const created: DraftGroup = { parserId, parserVersion, actions: [], cards: [] }
  groups.set(key, created)
  return created
}

function actionInput(d: TorrentFormalActionDraft): TorrentFormalActionInput {
  return {
    key: d.key,
    packageName: d.packageName,
    appLabel: d.appLabel,
    kind: d.kind,
    startTs: d.startTs,
    endTs: d.endTs,
    title: d.title,
    upName: d.upName,
    isStory: d.isStory,
    payload: d.payload,
    sourceRefs: d.sourceRefs,
  }
}

function cardInput(d: TorrentFormalCardDraft): TorrentFormalCardInput {
  return {
    key: d.key,
    packageName: d.packageName,
    appLabel: d.appLabel,
    cardKind: d.cardKind,
    startTs: d.startTs,
    endTs: d.endTs,
    title: d.title,
    upName: d.upName,
    payload: d.payload,
    sourceRefs: d.sourceRefs,
  }
}

export async function persistTorrentFormalDayFromRaw(
  dayKey: string,
  captures: TorrentCapture[],
): Promise<TorrentFormalPersistResult> {
  const actions = buildTorrentFormalActionDrafts(captures)
  const cards = buildTorrentFormalCardDrafts(captures)
  const groups = new Map<string, DraftGroup>()
  for (const parser of torrentParserModules) {
    if (captures.some(parser.canParse)) getOrCreateGroup(groups, parser.id, parser.version)
  }
  for (const action of actions) {
    getOrCreateGroup(groups, action.parserId, action.parserVersion).actions.push(action)
  }
  for (const card of cards) {
    getOrCreateGroup(groups, card.parserId, card.parserVersion).cards.push(card)
  }

  let sourceStartMs = Number.POSITIVE_INFINITY
  let sourceEndMs = 0
  for (const capture of captures) {
    const ts = Number(capture.eventTimeMs)
    if (!Number.isFinite(ts)) continue
    if (ts < sourceStartMs) sourceStartMs = ts
    if (ts > sourceEndMs) sourceEndMs = ts
  }
  if (!Number.isFinite(sourceStartMs)) sourceStartMs = 0
  const results: TorrentFormalPersistResult['results'] = []

  for (const group of groups.values()) {
    const saved = await saveTorrentFormalDay({
      dayKey,
      parserId: group.parserId,
      parserVersion: group.parserVersion,
      sourceStartMs,
      sourceEndMs,
      actions: group.actions.map(actionInput),
      cards: group.cards.map(cardInput),
    })
    results.push({ ...saved, parserId: group.parserId, parserVersion: group.parserVersion })
  }

  return {
    parserCount: groups.size,
    actionCount: results.reduce((sum, r) => sum + r.actionCount, 0),
    cardCount: results.reduce((sum, r) => sum + r.cardCount, 0),
    results,
  }
}
