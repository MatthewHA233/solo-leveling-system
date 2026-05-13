import Foundation

/// 玩家状态管理器
@MainActor
final class PlayerManager: ObservableObject {
    @Published var player: Player
    private let bus: GameEventBus

    init(player: Player = Player(), eventBus: GameEventBus) {
        self.player = player
        self.bus = eventBus
    }

    // MARK: - Experience

    func gainExp(_ amount: Int, source: String = "quest") {
        guard amount > 0 else { return }

        // Apply exp multiplier buffs
        var multiplier = 1.0
        for buff in player.activeBuffs {
            if let expMul = buff.effects["exp_multiplier"] {
                multiplier *= expMul
            }
        }

        let actualAmount = Int(Double(amount) * multiplier)
        player.exp += actualAmount

        bus.emit(.expGained, data: [
            "amount": actualAmount,
            "source": source,
            "multiplier": multiplier,
        ])

        // Check level up
        while player.exp >= player.expToNext {
            player.exp -= player.expToNext
            levelUp()
        }
    }

    // MARK: - Level Up

    private func levelUp() {
        player.level += 1

        // Check new title
        let newTitle = player.availableTitle
        let titleChanged = newTitle != player.title
        if titleChanged && !player.titlesUnlocked.contains(newTitle) {
            player.titlesUnlocked.append(newTitle)
            player.title = newTitle
        }

        // Stat boost on level up
        for stat in PlayerStats.allStatNames {
            player.stats.applyModifier(stat: stat, value: 1)
        }

        bus.emit(.levelUp, data: [
            "new_level": player.level,
            "title": player.title,
            "title_changed": titleChanged,
        ])
    }

    // MARK: - Buffs

    func applyBuff(_ buff: ActiveBuff) {
        // Remove existing buff with same id
        player.activeBuffs.removeAll { $0.id == buff.id }
        player.activeBuffs.append(buff)

        // Apply stat effects
        for (stat, value) in buff.effects {
            if stat != "exp_multiplier" {
                player.stats.applyModifier(stat: stat, value: Int(value))
            }
        }

        let eventType: GameEventType = buff.isDebuff ? .debuffActivated : .buffActivated
        bus.emit(eventType, data: [
            "buff_id": buff.id,
            "buff_name": buff.name,
            "effects": buff.effects,
        ])
    }

    func removeBuff(_ buffId: String) {
        guard let index = player.activeBuffs.firstIndex(where: { $0.id == buffId }) else { return }
        let removed = player.activeBuffs.remove(at: index)

        // Reverse stat effects
        for (stat, value) in removed.effects {
            if stat != "exp_multiplier" {
                player.stats.applyModifier(stat: stat, value: -Int(value))
            }
        }

        let eventType: GameEventType = removed.isDebuff ? .debuffExpired : .buffExpired
        bus.emit(eventType, data: [
            "buff_id": removed.id,
            "buff_name": removed.name,
        ])
    }

    /// Remove expired buffs
    func cleanupExpiredBuffs() {
        let expired = player.activeBuffs.filter { $0.isExpired }
        for buff in expired {
            removeBuff(buff.id)
        }
    }

    // MARK: - Stats

    func updateStats(_ changes: [String: Int]) {
        for (stat, value) in changes {
            player.stats.applyModifier(stat: stat, value: value)
        }

        bus.emit(.statChanged, data: [
            "changes": changes,
        ])
    }
}
