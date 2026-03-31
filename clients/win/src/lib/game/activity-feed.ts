// ══════════════════════════════════════════════
// Activity Feed — 移植自 macOS ActivityFeed.swift
// FIFO 50 条动态列表
// ══════════════════════════════════════════════

export type FeedItemType =
  | 'capture' | 'exp' | 'quest' | 'levelUp'
  | 'buff' | 'system' | 'ai'

export interface ActivityFeedItem {
  readonly id: string
  readonly timestamp: string      // ISO string
  readonly type: FeedItemType
  readonly icon: string
  readonly title: string
  readonly subtitle: string
  readonly expAmount: number
}

export function createFeedItem(
  type: FeedItemType,
  icon: string,
  title: string,
  subtitle = '',
  expAmount = 0,
): ActivityFeedItem {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    icon,
    title,
    subtitle,
    expAmount,
  }
}

// ── Color Key ──

const COLOR_KEY_MAP: Record<FeedItemType, string> = {
  capture: 'blue',
  exp: 'green',
  quest: 'purple',
  levelUp: 'gold',
  buff: 'purple',
  system: 'secondary',
  ai: 'cyan',
}

export function feedItemColorKey(type: FeedItemType): string {
  return COLOR_KEY_MAP[type] ?? 'secondary'
}

// ── Category → Icon ──

const CATEGORY_ICONS: Record<string, string> = {
  coding: '💻',
  writing: '✏️',
  learning: '📖',
  reading: '📖',
  browsing: '🌐',
  media: '▶️',
  social: '💬',
  gaming: '🎮',
  communication: '📧',
  design: '🎨',
  work: '💼',
  creative: '✨',
  shopping: '🛒',
  research: '🔍',
  meeting: '👥',
  idle: '🌙',
  unknown: '❓',
}

export function iconForCategory(category: string): string {
  return CATEGORY_ICONS[category] ?? '❓'
}

// ── Feed Manager ──

const MAX_ITEMS = 50

export interface ActivityFeed {
  readonly items: readonly ActivityFeedItem[]
}

export function createActivityFeed(): ActivityFeed {
  return { items: [] }
}

export function pushFeedItem(
  feed: ActivityFeed,
  item: ActivityFeedItem,
): ActivityFeed {
  const next = [...feed.items, item]
  if (next.length > MAX_ITEMS) {
    return { items: next.slice(next.length - MAX_ITEMS) }
  }
  return { items: next }
}

export function latestFeedItem(feed: ActivityFeed): ActivityFeedItem | null {
  return feed.items.length > 0 ? feed.items[feed.items.length - 1] : null
}
