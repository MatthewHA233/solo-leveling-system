import Foundation

// MARK: - Event Types

enum GameEventType: String, CaseIterable {
    // Perception
    case screenCaptured
    case windowChanged
    case userIdle
    case userActive

    // Cognition
    case contextAnalyzed

    // Game
    case questTriggered
    case questCompleted
    case questFailed
    case buffActivated
    case buffExpired
    case debuffActivated
    case debuffExpired
    case levelUp
    case expGained
    case statChanged

    // System
    case notificationPush
    case systemStart
    case systemStop
}

// MARK: - Event

struct GameEvent {
    let type: GameEventType
    var data: [String: Any]
    let timestamp: Date
    let source: String

    init(type: GameEventType, data: [String: Any] = [:], source: String = "system") {
        self.type = type
        self.data = data
        self.timestamp = Date()
        self.source = source
    }
}

// MARK: - Event Bus

typealias GameEventHandler = @MainActor (GameEvent) -> Void

@MainActor
final class GameEventBus {
    private var handlers: [GameEventType: [(id: UUID, handler: GameEventHandler)]] = [:]
    private var history: [GameEvent] = []
    private let maxHistory = 500

    @discardableResult
    func on(_ eventType: GameEventType, handler: @escaping GameEventHandler) -> UUID {
        let id = UUID()
        handlers[eventType, default: []].append((id: id, handler: handler))
        return id
    }

    func off(_ eventType: GameEventType, id: UUID) {
        handlers[eventType]?.removeAll { $0.id == id }
    }

    func emit(_ event: GameEvent) {
        history.append(event)
        if history.count > maxHistory {
            history.removeFirst(history.count - maxHistory)
        }

        let eventHandlers = handlers[event.type] ?? []
        for (_, handler) in eventHandlers {
            handler(event)
        }
    }

    func emit(_ type: GameEventType, data: [String: Any] = [:], source: String = "system") {
        emit(GameEvent(type: type, data: data, source: source))
    }

    func getHistory(type: GameEventType? = nil, limit: Int = 50) -> [GameEvent] {
        let filtered: [GameEvent]
        if let type {
            filtered = history.filter { $0.type == type }
        } else {
            filtered = history
        }
        return Array(filtered.suffix(limit))
    }
}
