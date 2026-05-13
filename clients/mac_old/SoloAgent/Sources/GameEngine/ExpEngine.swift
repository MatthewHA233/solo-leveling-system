import Foundation

/// 经验值引擎 — 被动经验计算 + 专注连击
@MainActor
final class ExpEngine {
    private let playerManager: PlayerManager
    private let bus: GameEventBus

    private(set) var focusStreak: Int = 0
    private var lastStreakBonus: Int = 0
    private(set) var totalPassiveExp: Int = 0

    // Passive exp rules: category -> (base_exp, focus_multiplier_enabled)
    static let passiveExpRules: [String: (baseExp: Int, focusMultiplier: Bool)] = [
        "coding":        (3, true),
        "writing":       (3, true),
        "learning":      (4, true),
        "work":          (2, true),
        "creative":      (3, true),
        "design":        (3, true),
        "reading":       (2, true),
        "browsing":      (1, false),
        "communication": (1, false),
        "social":        (0, false),
        "media":         (0, false),
        "gaming":        (0, false),
        "idle":          (0, false),
        "unknown":       (0, false),
    ]

    // Focus streak bonus thresholds
    static let focusStreakBonuses: [(threshold: Int, bonus: Int)] = [
        (3, 5), (6, 15), (10, 30), (15, 50),
    ]

    init(playerManager: PlayerManager, eventBus: GameEventBus) {
        self.playerManager = playerManager
        self.bus = eventBus

        bus.on(.contextAnalyzed) { [weak self] event in
            self?.onContextAnalyzed(event)
        }
    }

    // MARK: - Context Analyzed Handler

    private func onContextAnalyzed(_ event: GameEvent) {
        let category = event.data["category"] as? String ?? "idle"
        let focusScore = event.data["focus_score"] as? Double ?? 0.0

        guard let rule = Self.passiveExpRules[category] else { return }

        if rule.baseExp <= 0 {
            if focusScore < 0.3 {
                focusStreak = 0
                lastStreakBonus = 0
            }
            return
        }

        // Focus multiplier
        var totalExp = rule.baseExp
        if rule.focusMultiplier && focusScore > 0.5 {
            let multiplier = 1.0 + (focusScore - 0.5) * 2
            totalExp = Int(Double(rule.baseExp) * multiplier)
        }

        // Update streak
        if focusScore >= 0.6 {
            focusStreak += 1
        } else {
            focusStreak = max(0, focusStreak - 1)
        }

        // Streak bonus
        var streakBonus = 0
        for (threshold, bonus) in Self.focusStreakBonuses {
            if focusStreak >= threshold && threshold > lastStreakBonus {
                streakBonus = bonus
                lastStreakBonus = threshold
            }
        }

        if streakBonus > 0 {
            totalExp += streakBonus
            bus.emit(.notificationPush, data: [
                "title": SystemMessages.focusStreakMessage(streak: focusStreak, bonus: streakBonus),
                "style": "exp",
            ])
        }

        // Award exp
        if totalExp > 0 {
            playerManager.gainExp(totalExp, source: "passive:\(category)")
            totalPassiveExp += totalExp
        }
    }
}
