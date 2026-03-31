// ══════════════════════════════════════════════
// Exp Engine — 移植自 macOS ExpEngine.swift
// 被动经验计算 + 专注连击
// ══════════════════════════════════════════════

import type { GameEventBus, GameEvent } from './event-bus'
import type { PlayerManager } from './player-manager'
import { focusStreakMessage } from './system-messages'

// ── Passive Exp Rules ──

interface PassiveExpRule {
  readonly baseExp: number
  readonly focusMultiplier: boolean
}

const PASSIVE_EXP_RULES: Record<string, PassiveExpRule> = {
  coding:        { baseExp: 3, focusMultiplier: true },
  writing:       { baseExp: 3, focusMultiplier: true },
  learning:      { baseExp: 4, focusMultiplier: true },
  work:          { baseExp: 2, focusMultiplier: true },
  creative:      { baseExp: 3, focusMultiplier: true },
  design:        { baseExp: 3, focusMultiplier: true },
  reading:       { baseExp: 2, focusMultiplier: true },
  browsing:      { baseExp: 1, focusMultiplier: false },
  communication: { baseExp: 1, focusMultiplier: false },
  social:        { baseExp: 0, focusMultiplier: false },
  media:         { baseExp: 0, focusMultiplier: false },
  gaming:        { baseExp: 0, focusMultiplier: false },
  idle:          { baseExp: 0, focusMultiplier: false },
  unknown:       { baseExp: 0, focusMultiplier: false },
}

// ── Focus Streak Bonuses ──

const FOCUS_STREAK_BONUSES: readonly { threshold: number; bonus: number }[] = [
  { threshold: 3, bonus: 5 },
  { threshold: 6, bonus: 15 },
  { threshold: 10, bonus: 30 },
  { threshold: 15, bonus: 50 },
]

// ── Engine State ──

export interface ExpEngineState {
  readonly focusStreak: number
  readonly lastStreakBonus: number
  readonly totalPassiveExp: number
}

export function createExpEngineState(): ExpEngineState {
  return { focusStreak: 0, lastStreakBonus: 0, totalPassiveExp: 0 }
}

// ── Core Logic ──

export interface ExpEngineResult {
  readonly state: ExpEngineState
  readonly expGained: number
  readonly streakBonus: number
  readonly streakMessage: string | null
}

export function processContextAnalyzed(
  state: ExpEngineState,
  category: string,
  focusScore: number,
): ExpEngineResult {
  const rule = PASSIVE_EXP_RULES[category]

  if (!rule || rule.baseExp <= 0) {
    // Non-productive: decay streak if low focus
    if (focusScore < 0.3) {
      return {
        state: { ...state, focusStreak: 0, lastStreakBonus: 0 },
        expGained: 0,
        streakBonus: 0,
        streakMessage: null,
      }
    }
    return { state, expGained: 0, streakBonus: 0, streakMessage: null }
  }

  // Focus multiplier
  let totalExp = rule.baseExp
  if (rule.focusMultiplier && focusScore > 0.5) {
    const multiplier = 1.0 + (focusScore - 0.5) * 2
    totalExp = Math.floor(rule.baseExp * multiplier)
  }

  // Update streak
  let focusStreak: number
  if (focusScore >= 0.6) {
    focusStreak = state.focusStreak + 1
  } else {
    focusStreak = Math.max(0, state.focusStreak - 1)
  }

  // Streak bonus
  let streakBonus = 0
  let lastStreakBonus = state.lastStreakBonus
  for (const { threshold, bonus } of FOCUS_STREAK_BONUSES) {
    if (focusStreak >= threshold && threshold > lastStreakBonus) {
      streakBonus = bonus
      lastStreakBonus = threshold
    }
  }

  let streakMessage: string | null = null
  if (streakBonus > 0) {
    totalExp += streakBonus
    streakMessage = focusStreakMessage(focusStreak, streakBonus)
  }

  return {
    state: {
      focusStreak,
      lastStreakBonus,
      totalPassiveExp: state.totalPassiveExp + totalExp,
    },
    expGained: totalExp,
    streakBonus,
    streakMessage,
  }
}

// ── Bus Integration ──

export function setupExpEngine(
  bus: GameEventBus,
  playerManager: PlayerManager,
  getState: () => ExpEngineState,
  setState: (s: ExpEngineState) => void,
): string {
  return bus.on('contextAnalyzed', (event: GameEvent) => {
    const category = (event.data.category as string) ?? 'idle'
    const focusScore = (event.data.focus_score as number) ?? 0.0

    const result = processContextAnalyzed(getState(), category, focusScore)
    setState(result.state)

    if (result.streakMessage) {
      bus.emit('notificationPush', {
        title: result.streakMessage,
        style: 'exp',
      })
    }

    if (result.expGained > 0) {
      playerManager.gainExp(result.expGained, `passive:${category}`)
    }
  })
}
