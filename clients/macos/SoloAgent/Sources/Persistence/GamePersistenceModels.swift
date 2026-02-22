import Foundation
import SwiftData

// MARK: - Player Record

@Model
final class PlayerRecord {
    var name: String
    var level: Int
    var exp: Int
    var title: String

    // Stats (stored flat)
    var statFocus: Int
    var statProductivity: Int
    var statConsistency: Int
    var statCreativity: Int
    var statWellness: Int

    var titlesUnlockedData: Data?
    var totalQuestsCompleted: Int
    var createdAt: Date
    var updatedAt: Date

    init(
        name: String = "Player",
        level: Int = 1,
        exp: Int = 0,
        title: String = "觉醒者",
        statFocus: Int = 50,
        statProductivity: Int = 50,
        statConsistency: Int = 50,
        statCreativity: Int = 50,
        statWellness: Int = 50,
        titlesUnlockedData: Data? = nil,
        totalQuestsCompleted: Int = 0,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.name = name
        self.level = level
        self.exp = exp
        self.title = title
        self.statFocus = statFocus
        self.statProductivity = statProductivity
        self.statConsistency = statConsistency
        self.statCreativity = statCreativity
        self.statWellness = statWellness
        self.titlesUnlockedData = titlesUnlockedData
        self.totalQuestsCompleted = totalQuestsCompleted
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    // MARK: - Conversions

    func toPlayer() -> Player {
        var player = Player()
        player.name = name
        player.level = level
        player.exp = exp
        player.title = title
        player.stats = PlayerStats(
            focus: statFocus,
            productivity: statProductivity,
            consistency: statConsistency,
            creativity: statCreativity,
            wellness: statWellness
        )
        player.totalQuestsCompleted = totalQuestsCompleted
        player.createdAt = createdAt

        if let data = titlesUnlockedData,
           let titles = try? JSONDecoder().decode([String].self, from: data) {
            player.titlesUnlocked = titles
        }

        return player
    }

    func update(from player: Player) {
        name = player.name
        level = player.level
        exp = player.exp
        title = player.title
        statFocus = player.stats.focus
        statProductivity = player.stats.productivity
        statConsistency = player.stats.consistency
        statCreativity = player.stats.creativity
        statWellness = player.stats.wellness
        totalQuestsCompleted = player.totalQuestsCompleted
        titlesUnlockedData = try? JSONEncoder().encode(player.titlesUnlocked)
        updatedAt = Date()
    }
}

// MARK: - Quest Record

@Model
final class QuestRecord {
    @Attribute(.unique) var questId: String
    var type: String
    var title: String
    var questDescription: String
    var difficulty: String
    var status: String
    var expReward: Int
    var source: String
    var context: String
    var deadline: Date?
    var createdAt: Date
    var completedAt: Date?

    init(
        questId: String,
        type: String,
        title: String,
        questDescription: String,
        difficulty: String,
        status: String,
        expReward: Int = 0,
        source: String = "auto",
        context: String = "",
        deadline: Date? = nil,
        createdAt: Date = Date(),
        completedAt: Date? = nil
    ) {
        self.questId = questId
        self.type = type
        self.title = title
        self.questDescription = questDescription
        self.difficulty = difficulty
        self.status = status
        self.expReward = expReward
        self.source = source
        self.context = context
        self.deadline = deadline
        self.createdAt = createdAt
        self.completedAt = completedAt
    }

    func toQuest() -> Quest {
        Quest(
            id: questId,
            type: QuestType(rawValue: type) ?? .side,
            title: title,
            description: questDescription,
            difficulty: QuestDifficulty(rawValue: difficulty) ?? .C,
            status: QuestStatus(rawValue: status) ?? .active,
            expReward: expReward,
            source: source,
            context: context,
            deadline: deadline,
            createdAt: createdAt,
            completedAt: completedAt
        )
    }

    func update(from quest: Quest) {
        type = quest.type.rawValue
        title = quest.title
        questDescription = quest.description
        difficulty = quest.difficulty.rawValue
        status = quest.status.rawValue
        expReward = quest.expReward
        source = quest.source
        context = quest.context
        deadline = quest.deadline
        completedAt = quest.completedAt
    }
}

// MARK: - Buff Record

@Model
final class BuffRecord {
    @Attribute(.unique) var buffId: String
    var name: String
    var effectsData: Data?
    var activatedAt: Date
    var expiresAt: Date?
    var isDebuff: Bool

    init(
        buffId: String,
        name: String,
        effectsData: Data? = nil,
        activatedAt: Date = Date(),
        expiresAt: Date? = nil,
        isDebuff: Bool = false
    ) {
        self.buffId = buffId
        self.name = name
        self.effectsData = effectsData
        self.activatedAt = activatedAt
        self.expiresAt = expiresAt
        self.isDebuff = isDebuff
    }

    func toBuff() -> ActiveBuff {
        var effects: [String: Double] = [:]
        if let data = effectsData {
            effects = (try? JSONDecoder().decode([String: Double].self, from: data)) ?? [:]
        }
        return ActiveBuff(
            id: buffId,
            name: name,
            effects: effects,
            activatedAt: activatedAt,
            expiresAt: expiresAt,
            isDebuff: isDebuff
        )
    }

    func update(from buff: ActiveBuff) {
        name = buff.name
        effectsData = try? JSONEncoder().encode(buff.effects)
        activatedAt = buff.activatedAt
        expiresAt = buff.expiresAt
        isDebuff = buff.isDebuff
    }
}
