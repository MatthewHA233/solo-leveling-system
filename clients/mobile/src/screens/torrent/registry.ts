import type { TorrentCapture, TorrentFormalAction, TorrentFormalCard } from '../../lib/perception'
import {
  BILI_PACKAGE,
  bilibiliTorrentParser,
  feedKindLabel,
  splitPlayProgressSegments,
  type BiliActionKind,
  type CommentItem,
  type HomeFeedItem,
  type ListItem,
  type PlayProgressSample,
  type VideoSubTab,
} from './parsers/bilibili'
import { wechatTorrentParser, type WeChatListItem, type WxBlock, type WxComment } from './parsers/wechat'
import type { TorrentFormalActionDraft, TorrentFormalCardDraft, TorrentParserModule } from './types'

// 所有 parser 的 ListItem 变体在此汇合（B 站 + 微信 + 后续软件）
export type TorrentListItem = ListItem | WeChatListItem
export type { WeChatListItem, WxBlock, WxComment }
export type {
  BiliActionKind,
  CommentItem,
  HomeFeedItem,
  PlayProgressSample,
  VideoSubTab,
}

export const torrentParserModules: readonly TorrentParserModule<TorrentListItem>[] = [
  bilibiliTorrentParser,
  wechatTorrentParser,
]

/** 已注册 parser 的 id@版本 集合，供正式数据"parser 变了就失效"比对 */
export function registeredParserVersions(): Array<{ id: string; version: number }> {
  return torrentParserModules.map((p) => ({ id: p.id, version: p.version }))
}

export function getTorrentParserForPackage(packageName: string | null | undefined): TorrentParserModule<TorrentListItem> | null {
  if (!packageName) return null
  return torrentParserModules.find((module) => module.packages.includes(packageName)) ?? null
}

export function getTorrentPackageLabel(packageName: string | null | undefined): string {
  const parser = getTorrentParserForPackage(packageName)
  if (parser) return parser.getPackageLabel(packageName)
  if (!packageName) return '应用'
  return packageName.split('.').filter(Boolean).pop() ?? packageName
}

function itemsForParser(items: TorrentCapture[], parser: TorrentParserModule<TorrentListItem>): TorrentCapture[] {
  return items.filter(parser.canParse)
}

export function buildTorrentFeedListItems(items: TorrentCapture[]): TorrentListItem[] {
  return torrentParserModules.flatMap((parser) => parser.buildFeedListItems(itemsForParser(items, parser)))
}

export function buildTorrentActionListItems(items: TorrentCapture[]): TorrentListItem[] {
  return torrentParserModules.flatMap((parser) => parser.buildActionListItems(itemsForParser(items, parser)))
}

export function buildTorrentFormalActionDrafts(items: TorrentCapture[]): TorrentFormalActionDraft[] {
  return torrentParserModules.flatMap((parser) =>
    parser.buildFormalActions ? parser.buildFormalActions(itemsForParser(items, parser)) : [])
}

export function buildTorrentFormalCardDrafts(items: TorrentCapture[]): TorrentFormalCardDraft[] {
  return torrentParserModules.flatMap((parser) =>
    parser.buildFormalCards ? parser.buildFormalCards(itemsForParser(items, parser)) : [])
}

export function buildTorrentActionListItemsFromFormal(items: TorrentFormalAction[]): TorrentListItem[] {
  return torrentParserModules.flatMap((parser) =>
    parser.buildActionListItemsFromFormal
      ? parser.buildActionListItemsFromFormal(items.filter((item) => item.parserId === parser.id))
      : [])
}

export function buildTorrentFeedListItemsFromFormal(items: TorrentFormalCard[]): TorrentListItem[] {
  return torrentParserModules.flatMap((parser) =>
    parser.buildFeedListItemsFromFormal
      ? parser.buildFeedListItemsFromFormal(items.filter((item) => item.parserId === parser.id))
      : [])
}

export const DEFAULT_TORRENT_PACKAGE = BILI_PACKAGE
export const DEFAULT_TORRENT_ACCENT = bilibiliTorrentParser.accent

export function getTorrentFeedKindLabel(kind: HomeFeedItem['kind']): string {
  return feedKindLabel(kind)
}

export const splitTorrentPlayProgressSegments = splitPlayProgressSegments
