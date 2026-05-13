// ══════════════════════════════════════════════
// Quest Engine — 移植自 macOS QuestEngine.swift
// 任务生成、管理、追踪
// ══════════════════════════════════════════════

import type { Quest, QuestStatus } from './models'
import { createQuest, DAILY_QUEST_TEMPLATES } from './models'
import type { GameEventBus } from './event-bus'
import type { PlayerManager } from './player-manager'

// ── Quest Engine State ──

export interface QuestEngineState {
  readonly activeQuests: readonly Quest[]
}

export function createQuestEngineState(): QuestEngineState {
  return { activeQuests: [] }
}

// ── Helpers ──

function formatDateId(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function endOfDay(date: Date): string {
  const eod = new Date(date)
  eod.setHours(23, 59, 59, 999)
  return eod.toISOString()
}

// ── Quest Engine ──

export class QuestEngine {
  private _state: QuestEngineState
  private readonly playerManager: PlayerManager
  private readonly bus: GameEventBus

  constructor(
    playerManager: PlayerManager,
    eventBus: GameEventBus,
    initialQuests: readonly Quest[] = [],
  ) {
    this._state = { activeQuests: initialQuests }
    this.playerManager = playerManager
    this.bus = eventBus
  }

  get state(): QuestEngineState {
    return this._state
  }

  get activeQuests(): readonly Quest[] {
    return this._state.activeQuests
  }

  // ── Daily Quests ──

  generateDailyQuests(): void {
    const todayStr = formatDateId(new Date())

    // Check if already generated today
    const existingDaily = this._state.activeQuests.filter(
      (q) => q.type === 'daily' && q.id.startsWith(`daily_${todayStr}`),
    )
    if (existingDaily.length > 0) return

    const newQuests: Quest[] = []

    for (const template of DAILY_QUEST_TEMPLATES) {
      const quest = createQuest({
        id: `daily_${todayStr}_${crypto.randomUUID().slice(0, 6)}`,
        type: 'daily',
        title: template.title,
        description: template.description,
        difficulty: template.difficulty,
        status: 'active',
        expReward: template.expReward,
        source: 'daily',
        deadline: endOfDay(new Date()),
      })

      newQuests.push(quest)

      this.bus.emit('questTriggered', {
        quest_id: quest.id,
        quest_title: quest.title,
        quest_type: quest.type,
        difficulty: quest.difficulty,
        exp_reward: quest.expReward,
      })
    }

    this._state = {
      activeQuests: [...this._state.activeQuests, ...newQuests],
    }
  }

  // ── Complete / Fail ──

  completeQuest(questId: string): boolean {
    const idx = this._state.activeQuests.findIndex(
      (q) => q.id === questId && q.status === 'active',
    )
    if (idx === -1) return false

    const quest = this._state.activeQuests[idx]
    const updated: Quest = {
      ...quest,
      status: 'completed',
      completedAt: new Date().toISOString(),
    }

    this._state = {
      activeQuests: this._state.activeQuests.map((q, i) =>
        i === idx ? updated : q,
      ),
    }

    // Award exp
    this.playerManager.gainExp(updated.expReward, `quest:${updated.id}`)
    this.playerManager.incrementQuestsCompleted()

    this.bus.emit('questCompleted', {
      quest_id: updated.id,
      quest_title: updated.title,
      exp_earned: updated.expReward,
    })

    return true
  }

  failQuest(questId: string): boolean {
    const idx = this._state.activeQuests.findIndex(
      (q) => q.id === questId && q.status === 'active',
    )
    if (idx === -1) return false

    const quest = this._state.activeQuests[idx]
    const updated: Quest = { ...quest, status: 'failed' }

    this._state = {
      activeQuests: this._state.activeQuests.map((q, i) =>
        i === idx ? updated : q,
      ),
    }

    this.bus.emit('questFailed', {
      quest_id: updated.id,
      quest_title: updated.title,
    })

    return true
  }

  // ── Expiry Check ──

  checkExpiredQuests(): void {
    const now = new Date()
    let changed = false
    const updated = this._state.activeQuests.map((quest) => {
      if (
        quest.status === 'active' &&
        quest.deadline &&
        new Date(quest.deadline) < now
      ) {
        changed = true
        this.bus.emit('questFailed', {
          quest_id: quest.id,
          quest_title: quest.title,
          reason: 'expired',
        })
        return { ...quest, status: 'expired' as QuestStatus }
      }
      return quest
    })

    if (changed) {
      this._state = { activeQuests: updated }
    }
  }

  // ── Cleanup ──

  cleanupOldQuests(): void {
    const cutoff = Date.now() - 24 * 3600 * 1000
    this._state = {
      activeQuests: this._state.activeQuests.filter(
        (q) => q.status === 'active' || new Date(q.createdAt).getTime() > cutoff,
      ),
    }
  }
}
