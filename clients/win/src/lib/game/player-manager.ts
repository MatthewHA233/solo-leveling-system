// ══════════════════════════════════════════════
// Player Manager — 移植自 macOS PlayerManager.swift
// 玩家状态管理（不可变模式）
// ══════════════════════════════════════════════

import type {
  Player, ActiveBuff, PlayerStats,
} from './models'
import {
  applyStatModifier, expForLevel, availableTitle,
  ALL_STAT_NAMES, isBuffExpired,
} from './models'
import type { GameEventBus } from './event-bus'

// ── Player Manager ──

export class PlayerManager {
  private _player: Player
  private readonly bus: GameEventBus

  constructor(player: Player, eventBus: GameEventBus) {
    this._player = player
    this.bus = eventBus
  }

  get player(): Player {
    return this._player
  }

  // ── Experience ──

  gainExp(amount: number, source = 'quest'): void {
    if (amount <= 0) return

    // Apply exp multiplier buffs
    let multiplier = 1.0
    for (const buff of this._player.activeBuffs) {
      const expMul = buff.effects['exp_multiplier']
      if (expMul !== undefined) {
        multiplier *= expMul
      }
    }

    const actualAmount = Math.floor(amount * multiplier)
    let exp = this._player.exp + actualAmount
    let level = this._player.level

    this.bus.emit('expGained', {
      amount: actualAmount,
      source,
      multiplier,
    })

    // Check level up(s)
    while (exp >= expForLevel(level)) {
      exp -= expForLevel(level)
      level += 1
      this.onLevelUp(level)
    }

    this._player = { ...this._player, exp, level }
  }

  private onLevelUp(newLevel: number): void {
    const newTitle = availableTitle(newLevel)
    const titleChanged = newTitle !== this._player.title

    let titlesUnlocked = this._player.titlesUnlocked
    let title = this._player.title

    if (titleChanged && !titlesUnlocked.includes(newTitle)) {
      titlesUnlocked = [...titlesUnlocked, newTitle]
      title = newTitle
    }

    // Stat boost on level up: +1 to all stats
    let stats = this._player.stats
    for (const stat of ALL_STAT_NAMES) {
      stats = applyStatModifier(stats, stat, 1)
    }

    this._player = {
      ...this._player,
      level: newLevel,
      title,
      titlesUnlocked,
      stats,
    }

    this.bus.emit('levelUp', {
      new_level: newLevel,
      title,
      title_changed: titleChanged,
    })
  }

  // ── Buffs ──

  applyBuff(buff: ActiveBuff): void {
    // Remove existing buff with same id
    const filtered = this._player.activeBuffs.filter((b) => b.id !== buff.id)
    const activeBuffs = [...filtered, buff]

    // Apply stat effects
    let stats = this._player.stats
    for (const [stat, value] of Object.entries(buff.effects)) {
      if (stat !== 'exp_multiplier') {
        stats = applyStatModifier(stats, stat, value)
      }
    }

    this._player = { ...this._player, activeBuffs, stats }

    const eventType = buff.isDebuff ? 'debuffActivated' : 'buffActivated'
    this.bus.emit(eventType, {
      buff_id: buff.id,
      buff_name: buff.name,
      effects: buff.effects,
    })
  }

  removeBuff(buffId: string): void {
    const removed = this._player.activeBuffs.find((b) => b.id === buffId)
    if (!removed) return

    const activeBuffs = this._player.activeBuffs.filter((b) => b.id !== buffId)

    // Reverse stat effects
    let stats = this._player.stats
    for (const [stat, value] of Object.entries(removed.effects)) {
      if (stat !== 'exp_multiplier') {
        stats = applyStatModifier(stats, stat, -value)
      }
    }

    this._player = { ...this._player, activeBuffs, stats }

    const eventType = removed.isDebuff ? 'debuffExpired' : 'buffExpired'
    this.bus.emit(eventType, {
      buff_id: removed.id,
      buff_name: removed.name,
    })
  }

  cleanupExpiredBuffs(): void {
    const expired = this._player.activeBuffs.filter(isBuffExpired)
    for (const buff of expired) {
      this.removeBuff(buff.id)
    }
  }

  // ── Stats ──

  updateStats(changes: Record<string, number>): void {
    let stats = this._player.stats
    for (const [stat, value] of Object.entries(changes)) {
      stats = applyStatModifier(stats, stat, value)
    }

    this._player = { ...this._player, stats }

    this.bus.emit('statChanged', { changes })
  }

  // ── Quest Counter ──

  incrementQuestsCompleted(): void {
    this._player = {
      ...this._player,
      totalQuestsCompleted: this._player.totalQuestsCompleted + 1,
    }
  }
}
