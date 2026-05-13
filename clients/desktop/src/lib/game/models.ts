// ══════════════════════════════════════════════
// Game Models — 移植自 macOS GameModels.swift
// ══════════════════════════════════════════════

export type QuestType = 'daily' | 'main' | 'side' | 'hidden' | 'emergency'
export type QuestStatus = 'pending' | 'active' | 'completed' | 'failed' | 'expired'
export type QuestDifficulty = 'E' | 'D' | 'C' | 'B' | 'A' | 'S'

export type ActivityCategory =
  | 'coding' | 'writing' | 'learning' | 'browsing' | 'media' | 'social'
  | 'gaming' | 'communication' | 'design' | 'reading' | 'work'
  | 'creative' | 'shopping' | 'research' | 'meeting' | 'idle' | 'unknown'

// ── Quest ──

export interface Quest {
  readonly id: string
  readonly type: QuestType
  readonly title: string
  readonly description: string
  readonly difficulty: QuestDifficulty
  readonly status: QuestStatus
  readonly expReward: number
  readonly source: string
  readonly context: string
  readonly deadline: string | null      // ISO string
  readonly createdAt: string            // ISO string
  readonly completedAt: string | null   // ISO string
}

export function createQuest(partial: Partial<Quest> & Pick<Quest, 'type' | 'title' | 'description' | 'difficulty'>): Quest {
  return {
    id: partial.id ?? `quest_${crypto.randomUUID().slice(0, 8)}`,
    type: partial.type,
    title: partial.title,
    description: partial.description,
    difficulty: partial.difficulty,
    status: partial.status ?? 'active',
    expReward: partial.expReward ?? 0,
    source: partial.source ?? 'auto',
    context: partial.context ?? '',
    deadline: partial.deadline ?? null,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    completedAt: partial.completedAt ?? null,
  }
}

// ── Player Stats ──

export interface PlayerStats {
  readonly focus: number
  readonly productivity: number
  readonly consistency: number
  readonly creativity: number
  readonly wellness: number
}

export const DEFAULT_STATS: PlayerStats = {
  focus: 50, productivity: 50, consistency: 50, creativity: 50, wellness: 50,
}

export const ALL_STAT_NAMES: (keyof PlayerStats)[] = [
  'focus', 'productivity', 'consistency', 'creativity', 'wellness',
]

export function applyStatModifier(stats: PlayerStats, stat: string, value: number): PlayerStats {
  if (!(stat in stats)) return stats
  const key = stat as keyof PlayerStats
  return { ...stats, [key]: Math.max(0, Math.min(100, stats[key] + value)) }
}

// ── Buff ──

export interface ActiveBuff {
  readonly id: string
  readonly name: string
  readonly effects: Record<string, number>
  readonly activatedAt: string
  readonly expiresAt: string | null
  readonly isDebuff: boolean
}

export function isBuffExpired(buff: ActiveBuff): boolean {
  if (!buff.expiresAt) return false
  return new Date() > new Date(buff.expiresAt)
}

// ── Player ──

export interface Player {
  readonly name: string
  readonly level: number
  readonly exp: number
  readonly title: string
  readonly stats: PlayerStats
  readonly activeBuffs: readonly ActiveBuff[]
  readonly titlesUnlocked: readonly string[]
  readonly totalQuestsCompleted: number
  readonly createdAt: string
}

export const DEFAULT_PLAYER: Player = {
  name: 'Player',
  level: 1,
  exp: 0,
  title: '觉醒者',
  stats: DEFAULT_STATS,
  activeBuffs: [],
  titlesUnlocked: ['觉醒者'],
  totalQuestsCompleted: 0,
  createdAt: new Date().toISOString(),
}

// ── Level Table ──

const LEVEL_TABLE: Record<number, number> = {
  1: 100, 2: 200, 3: 400, 4: 700, 5: 1100,
  6: 1600, 7: 2200, 8: 3000, 9: 4000, 10: 5500,
}

export function expForLevel(level: number): number {
  return LEVEL_TABLE[level] ?? 5500 + (level - 10) * 1000
}

export function expProgress(player: Player): number {
  const needed = expForLevel(player.level)
  return needed > 0 ? player.exp / needed : 0
}

// ── Titles ──

export const TITLES: { name: string; minLevel: number; description: string }[] = [
  { name: '觉醒者', minLevel: 1, description: '刚刚觉醒的玩家' },
  { name: 'E级猎人', minLevel: 3, description: '初出茅庐' },
  { name: 'D级猎人', minLevel: 5, description: '崭露头角' },
  { name: 'C级猎人', minLevel: 8, description: '实力不俗' },
  { name: 'B级猎人', minLevel: 12, description: '令人瞩目' },
  { name: 'A级猎人', minLevel: 18, description: '顶尖高手' },
  { name: 'S级猎人', minLevel: 25, description: '超越极限' },
  { name: '国家级猎人', minLevel: 35, description: '国之栋梁' },
  { name: '影之君主', minLevel: 50, description: '独自升级，登顶巅峰' },
]

export function availableTitle(level: number): string {
  let best = '觉醒者'
  for (const t of TITLES) {
    if (level >= t.minLevel) best = t.name
  }
  return best
}

// ── Difficulty ──

export const DIFFICULTY_COLORS: Record<QuestDifficulty, string> = {
  E: 'gray', D: 'green', C: 'blue', B: 'purple', A: 'orange', S: 'red',
}

export const DIFFICULTY_EXP_RANGES: Record<QuestDifficulty, { min: number; max: number }> = {
  E: { min: 5, max: 15 },
  D: { min: 15, max: 30 },
  C: { min: 30, max: 60 },
  B: { min: 60, max: 120 },
  A: { min: 120, max: 250 },
  S: { min: 250, max: 500 },
}

// ── Daily Quest Templates ──

export interface DailyQuestTemplate {
  readonly title: string
  readonly description: string
  readonly difficulty: QuestDifficulty
  readonly expReward: number
  readonly category: string
}

export const DAILY_QUEST_TEMPLATES: DailyQuestTemplate[] = [
  {
    title: '晨间训练',
    description: '完成至少 15 分钟的运动或拉伸。身体是革命的本钱。',
    difficulty: 'D', expReward: 20, category: 'wellness',
  },
  {
    title: '知识汲取',
    description: '阅读至少 30 分钟的书籍、文档或教程。',
    difficulty: 'D', expReward: 20, category: 'learning',
  },
  {
    title: '专注时刻',
    description: '完成至少 1 小时不间断的深度工作。',
    difficulty: 'C', expReward: 30, category: 'focus',
  },
]
