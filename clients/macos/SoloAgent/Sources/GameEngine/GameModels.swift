import Foundation

// MARK: - Enums

enum QuestType: String, Codable, CaseIterable {
    case daily
    case main
    case side
    case hidden
    case emergency
}

enum QuestStatus: String, Codable {
    case pending
    case active
    case completed
    case failed
    case expired
}

enum QuestDifficulty: String, Codable, CaseIterable {
    case E, D, C, B, A, S

    var color: String {
        switch self {
        case .E: return "gray"
        case .D: return "green"
        case .C: return "blue"
        case .B: return "purple"
        case .A: return "orange"
        case .S: return "red"
        }
    }
}

enum ActivityCategory: String, Codable, CaseIterable {
    case coding, writing, learning, browsing, media, social
    case gaming, communication, design, reading, work
    case creative, shopping, research, meeting, idle, unknown
}

// MARK: - Quest

struct Quest: Identifiable, Codable {
    let id: String
    var type: QuestType
    var title: String
    var description: String
    var difficulty: QuestDifficulty
    var status: QuestStatus
    var expReward: Int
    var source: String
    var context: String
    var deadline: Date?
    var createdAt: Date
    var completedAt: Date?

    init(
        id: String = "quest_\(UUID().uuidString.prefix(8))",
        type: QuestType,
        title: String,
        description: String,
        difficulty: QuestDifficulty,
        status: QuestStatus = .active,
        expReward: Int = 0,
        source: String = "auto",
        context: String = "",
        deadline: Date? = nil,
        createdAt: Date = Date(),
        completedAt: Date? = nil
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.description = description
        self.difficulty = difficulty
        self.status = status
        self.expReward = expReward
        self.source = source
        self.context = context
        self.deadline = deadline
        self.createdAt = createdAt
        self.completedAt = completedAt
    }
}

// MARK: - Player Stats

struct PlayerStats: Codable, Equatable {
    var focus: Int = 50
    var productivity: Int = 50
    var consistency: Int = 50
    var creativity: Int = 50
    var wellness: Int = 50

    mutating func applyModifier(stat: String, value: Int) {
        switch stat {
        case "focus": focus = max(0, min(100, focus + value))
        case "productivity": productivity = max(0, min(100, productivity + value))
        case "consistency": consistency = max(0, min(100, consistency + value))
        case "creativity": creativity = max(0, min(100, creativity + value))
        case "wellness": wellness = max(0, min(100, wellness + value))
        default: break
        }
    }

    static let allStatNames = ["focus", "productivity", "consistency", "creativity", "wellness"]
}

// MARK: - Buff

struct ActiveBuff: Identifiable, Codable {
    let id: String
    var name: String
    var effects: [String: Double]
    var activatedAt: Date
    var expiresAt: Date?
    var isDebuff: Bool

    var isExpired: Bool {
        guard let expiresAt else { return false }
        return Date() > expiresAt
    }
}

// MARK: - Player

struct Player: Codable {
    var name: String = "Player"
    var level: Int = 1
    var exp: Int = 0
    var title: String = "觉醒者"
    var stats: PlayerStats = PlayerStats()
    var activeBuffs: [ActiveBuff] = []
    var titlesUnlocked: [String] = ["觉醒者"]
    var totalQuestsCompleted: Int = 0
    var createdAt: Date = Date()

    var expToNext: Int { Self.expForLevel(level) }

    var expProgress: Double {
        guard expToNext > 0 else { return 0 }
        return Double(exp) / Double(expToNext)
    }

    var availableTitle: String {
        var best = "觉醒者"
        for (title, info) in Self.titles {
            if level >= info.minLevel {
                best = title
            }
        }
        return best
    }

    // MARK: - Level Table

    static let levelTable: [Int: Int] = [
        1: 100, 2: 200, 3: 400, 4: 700, 5: 1100,
        6: 1600, 7: 2200, 8: 3000, 9: 4000, 10: 5500,
    ]

    static func expForLevel(_ level: Int) -> Int {
        if let exp = levelTable[level] { return exp }
        return 5500 + (level - 10) * 1000
    }

    // MARK: - Titles

    struct TitleInfo {
        let minLevel: Int
        let description: String
    }

    static let titles: [(String, TitleInfo)] = [
        ("觉醒者", TitleInfo(minLevel: 1, description: "刚刚觉醒的玩家")),
        ("E级猎人", TitleInfo(minLevel: 3, description: "初出茅庐")),
        ("D级猎人", TitleInfo(minLevel: 5, description: "崭露头角")),
        ("C级猎人", TitleInfo(minLevel: 8, description: "实力不俗")),
        ("B级猎人", TitleInfo(minLevel: 12, description: "令人瞩目")),
        ("A级猎人", TitleInfo(minLevel: 18, description: "顶尖高手")),
        ("S级猎人", TitleInfo(minLevel: 25, description: "超越极限")),
        ("国家级猎人", TitleInfo(minLevel: 35, description: "国之栋梁")),
        ("影之君主", TitleInfo(minLevel: 50, description: "独自升级，登顶巅峰")),
    ]
}

// MARK: - Difficulty Exp Ranges

let difficultyExpRanges: [QuestDifficulty: (min: Int, max: Int)] = [
    .E: (5, 15), .D: (15, 30), .C: (30, 60),
    .B: (60, 120), .A: (120, 250), .S: (250, 500),
]

// MARK: - Daily Quest Templates

struct DailyQuestTemplate {
    let title: String
    let description: String
    let difficulty: QuestDifficulty
    let expReward: Int
    let category: String
}

let dailyQuestTemplates: [DailyQuestTemplate] = [
    DailyQuestTemplate(
        title: "晨间训练",
        description: "完成至少 15 分钟的运动或拉伸。身体是革命的本钱。",
        difficulty: .D, expReward: 20, category: "wellness"
    ),
    DailyQuestTemplate(
        title: "知识汲取",
        description: "阅读至少 30 分钟的书籍、文档或教程。",
        difficulty: .D, expReward: 20, category: "learning"
    ),
    DailyQuestTemplate(
        title: "专注时刻",
        description: "完成至少 1 小时不间断的深度工作。",
        difficulty: .C, expReward: 30, category: "focus"
    ),
]
