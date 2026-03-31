// ══════════════════════════════════════════════
// Event Bus — 移植自 macOS EventBus.swift
// ══════════════════════════════════════════════

export type GameEventType =
  // Perception
  | 'screenCaptured' | 'windowChanged' | 'userIdle' | 'userActive'
  // Cognition
  | 'contextAnalyzed'
  // Game
  | 'questTriggered' | 'questCompleted' | 'questFailed'
  | 'buffActivated' | 'buffExpired' | 'debuffActivated' | 'debuffExpired'
  | 'levelUp' | 'expGained' | 'statChanged'
  // System
  | 'notificationPush' | 'systemStart' | 'systemStop'

export interface GameEvent {
  readonly type: GameEventType
  readonly data: Record<string, unknown>
  readonly timestamp: string
  readonly source: string
}

function createEvent(
  type: GameEventType,
  data: Record<string, unknown> = {},
  source = 'system',
): GameEvent {
  return { type, data, timestamp: new Date().toISOString(), source }
}

export type GameEventHandler = (event: GameEvent) => void

export class GameEventBus {
  private handlers = new Map<GameEventType, Map<string, GameEventHandler>>()
  private history: GameEvent[] = []
  private readonly maxHistory = 500

  on(eventType: GameEventType, handler: GameEventHandler): string {
    const id = crypto.randomUUID()
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Map())
    }
    this.handlers.get(eventType)!.set(id, handler)
    return id
  }

  off(eventType: GameEventType, id: string): void {
    this.handlers.get(eventType)?.delete(id)
  }

  emit(event: GameEvent): void
  emit(type: GameEventType, data?: Record<string, unknown>, source?: string): void
  emit(
    eventOrType: GameEvent | GameEventType,
    data?: Record<string, unknown>,
    source?: string,
  ): void {
    const event: GameEvent =
      typeof eventOrType === 'string'
        ? createEvent(eventOrType, data, source)
        : eventOrType

    this.history.push(event)
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory)
    }

    const eventHandlers = this.handlers.get(event.type)
    if (eventHandlers) {
      for (const handler of eventHandlers.values()) {
        handler(event)
      }
    }
  }

  getHistory(type?: GameEventType, limit = 50): GameEvent[] {
    const filtered = type
      ? this.history.filter((e) => e.type === type)
      : this.history
    return filtered.slice(-limit)
  }
}
