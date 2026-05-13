import Foundation

/// 任务引擎 — 生成、管理、追踪任务
@MainActor
final class QuestEngine: ObservableObject {
    @Published var activeQuests: [Quest] = []

    private let playerManager: PlayerManager
    private let bus: GameEventBus
    private let persistence: PersistenceManager

    init(playerManager: PlayerManager, eventBus: GameEventBus, persistence: PersistenceManager) {
        self.playerManager = playerManager
        self.bus = eventBus
        self.persistence = persistence

        // Load persisted quests
        activeQuests = persistence.loadActiveQuests()
    }

    // MARK: - Daily Quests

    func generateDailyQuests() {
        let today = Calendar.current.startOfDay(for: Date())
        let todayStr = formatDateId(today)

        // Check if already generated today
        let existingDaily = activeQuests.filter {
            $0.type == .daily && $0.id.hasPrefix("daily_\(todayStr)")
        }
        if !existingDaily.isEmpty { return }

        for template in dailyQuestTemplates {
            let quest = Quest(
                id: "daily_\(todayStr)_\(UUID().uuidString.prefix(6))",
                type: .daily,
                title: template.title,
                description: template.description,
                difficulty: template.difficulty,
                status: .active,
                expReward: template.expReward,
                source: "daily",
                deadline: Calendar.current.date(bySettingHour: 23, minute: 59, second: 59, of: Date())
            )

            activeQuests.append(quest)
            persistence.saveQuest(quest)

            bus.emit(.questTriggered, data: [
                "quest_id": quest.id,
                "quest_title": quest.title,
                "quest_type": quest.type.rawValue,
                "difficulty": quest.difficulty.rawValue,
                "exp_reward": quest.expReward,
            ])
        }
    }

    // MARK: - Complete / Fail

    func completeQuest(_ questId: String) -> Bool {
        guard let index = activeQuests.firstIndex(where: { $0.id == questId && $0.status == .active }) else {
            return false
        }

        activeQuests[index].status = .completed
        activeQuests[index].completedAt = Date()
        let quest = activeQuests[index]

        persistence.saveQuest(quest)

        // Award exp
        playerManager.gainExp(quest.expReward, source: "quest:\(quest.id)")
        playerManager.player.totalQuestsCompleted += 1

        bus.emit(.questCompleted, data: [
            "quest_id": quest.id,
            "quest_title": quest.title,
            "exp_earned": quest.expReward,
        ])

        return true
    }

    func failQuest(_ questId: String) -> Bool {
        guard let index = activeQuests.firstIndex(where: { $0.id == questId && $0.status == .active }) else {
            return false
        }

        activeQuests[index].status = .failed
        persistence.saveQuest(activeQuests[index])

        bus.emit(.questFailed, data: [
            "quest_id": activeQuests[index].id,
            "quest_title": activeQuests[index].title,
        ])

        return true
    }

    // MARK: - Expiry Check

    func checkExpiredQuests() {
        let now = Date()
        for i in activeQuests.indices {
            if activeQuests[i].status == .active,
               let deadline = activeQuests[i].deadline,
               deadline < now {
                activeQuests[i].status = .expired
                persistence.saveQuest(activeQuests[i])

                bus.emit(.questFailed, data: [
                    "quest_id": activeQuests[i].id,
                    "quest_title": activeQuests[i].title,
                    "reason": "expired",
                ])
            }
        }
    }

    /// Remove completed/failed/expired quests older than 24h from the active list
    func cleanupOldQuests() {
        let cutoff = Date().addingTimeInterval(-24 * 3600)
        activeQuests.removeAll { quest in
            quest.status != .active && quest.createdAt < cutoff
        }
    }

    // MARK: - Helpers

    private func formatDateId(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd"
        return formatter.string(from: date)
    }
}
