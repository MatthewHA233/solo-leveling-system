import Foundation

// MARK: - AgentTool Protocol

@MainActor
protocol AgentTool {
    var name: String { get }
    var description: String { get }
    var parameters: [String: Any] { get }
    func execute(args: [String: Any], manager: AgentManager) async throws -> String
}

extension AgentTool {
    var toolDefinition: [String: Any] {
        [
            "type": "function",
            "function": [
                "name": name,
                "description": description,
                "parameters": parameters,
            ] as [String: Any],
        ]
    }
}

// MARK: - Tool Error

enum ToolError: LocalizedError {
    case missingArgument(String)
    case executionFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingArgument(let arg): return "缺少参数：\(arg)"
        case .executionFailed(let msg): return "执行失败：\(msg)"
        }
    }
}

// MARK: - Tool Registry

@MainActor
enum AgentTools {
    static let all: [any AgentTool] = [
        GetScreenContextTool(),
        GetTodayCardsTool(),
        GetGameStatusTool(),
        GetRecentActivityTool(),
        GetContextRulesTool(),
        ReorganizeCardsTool(),
        AnalyzeBatchTool(),
        SetMainQuestTool(),
        AddContextRuleTool(),
        RemoveContextRuleTool(),
    ]
}

// MARK: - Query Tools

struct GetScreenContextTool: AgentTool {
    let name = "get_screen_context"
    let description = "获取当前屏幕上下文：前台应用名称、窗口标题、活动状态"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [:] as [String: Any],
        "required": [] as [String],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        return manager.currentScreenContext()
    }
}

struct GetTodayCardsTool: AgentTool {
    let name = "get_today_cards"
    let description = "获取今日所有 AI 生成的活动卡片 JSON 摘要"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [:] as [String: Any],
        "required": [] as [String],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        let cards = manager.persistence.allActivityCardsToday()
        if cards.isEmpty {
            return "今日暂无活动卡片"
        }
        let summaries = cards.map { card -> [String: Any] in
            [
                "title": card.title,
                "category": card.category,
                "startTime": card.startTime,
                "endTime": card.endTime,
                "summary": card.summary,
                "batchId": String(card.batchId.prefix(8)),
            ] as [String: Any]
        }
        if let data = try? JSONSerialization.data(withJSONObject: summaries, options: .prettyPrinted),
           let str = String(data: data, encoding: .utf8) {
            return "今日活动卡片（\(cards.count) 张）：\n\(str)"
        }
        return "今日 \(cards.count) 张卡片（序列化失败）"
    }
}

struct GetGameStatusTool: AgentTool {
    let name = "get_game_status"
    let description = "获取游戏引擎当前状态：等级、经验值、活跃任务、Buff 列表"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [:] as [String: Any],
        "required": [] as [String],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        let player = manager.player
        let quests = manager.activeQuests
        let buffs = manager.activeBuffs

        var lines: [String] = [
            "等级：Lv.\(player.level) \(player.title)",
            "经验：\(player.exp)/\(player.expToNext) EXP",
            "活跃任务：\(quests.count) 个",
            "活跃 Buff：\(buffs.count) 个",
        ]

        if !quests.isEmpty {
            lines.append("任务列表：")
            for q in quests.prefix(5) {
                lines.append("  - \(q.title) [\(q.difficulty.rawValue)级] \(q.expReward)EXP")
            }
        }

        if let mainQuest = manager.config.mainQuest, !mainQuest.isEmpty {
            lines.append("主线目标：\(mainQuest)")
        }

        if !buffs.isEmpty {
            lines.append("Buff：\(buffs.prefix(3).map { $0.name }.joined(separator: "、"))")
        }

        return lines.joined(separator: "\n")
    }
}

struct GetRecentActivityTool: AgentTool {
    let name = "get_recent_activity"
    let description = "获取最近 N 分钟的原始活动历史，默认 30 分钟"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [
            "minutes": [
                "type": "number",
                "description": "查询时间范围（分钟），默认 30",
            ] as [String: Any],
        ] as [String: Any],
        "required": [] as [String],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        let minutes = args["minutes"] as? Int ?? 30
        let now = Date()
        let startDate = Date(timeIntervalSinceNow: -Double(minutes) * 60)
        let activities = manager.persistence.activitiesWithScreenshots(from: startDate, to: now)

        if activities.isEmpty {
            return "最近 \(minutes) 分钟内暂无活动记录"
        }

        var appCounts: [String: Int] = [:]
        for act in activities {
            let app = act.appName ?? "Unknown"
            appCounts[app, default: 0] += 1
        }

        let sorted = appCounts.sorted { $0.value > $1.value }
        let lines = sorted.prefix(10).map { "\($0.key): 约 \($0.value * 2) 秒" }
        return "最近 \(minutes) 分钟活动（\(activities.count) 条记录）：\n\(lines.joined(separator: "\n"))"
    }
}

struct GetContextRulesTool: AgentTool {
    let name = "get_context_rules"
    let description = "获取所有用户教学规则列表（用于教 AI 理解特定活动上下文）"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [:] as [String: Any],
        "required": [] as [String],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        let rules = manager.contextAdvisor.rules
        if rules.isEmpty {
            return "暂无规则"
        }
        let lines = rules.enumerated().map { "[\($0.offset)] \($0.element.pattern) → \($0.element.interpretation)" }
        return "规则列表（\(rules.count) 条）：\n\(lines.joined(separator: "\n"))"
    }
}

// MARK: - Action Tools

struct ReorganizeCardsTool: AgentTool {
    let name = "reorganize_cards"
    let description = "合并整理今日碎片活动卡片"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [:] as [String: Any],
        "required": [] as [String],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        let success = await manager.reorganizeTodayCards()
        return success ? "今日卡片整理完成" : "整理失败：AI 未配置或不可用"
    }
}

struct AnalyzeBatchTool: AgentTool {
    let name = "analyze_batch"
    let description = "重新分析指定批次（Phase 1 视频转录 + Phase 2 卡片生成）"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [
            "batchId": [
                "type": "string",
                "description": "批次 ID（可从 get_today_cards 结果中获取）",
            ] as [String: Any],
        ] as [String: Any],
        "required": ["batchId"],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        guard let batchId = args["batchId"] as? String, !batchId.isEmpty else {
            throw ToolError.missingArgument("batchId")
        }
        let success = await manager.reanalyzeBatch(batchId)
        return success ? "批次 \(batchId.prefix(8)) 重新分析完成" : "重新分析失败：AI 未配置或不可用"
    }
}

struct SetMainQuestTool: AgentTool {
    let name = "set_main_quest"
    let description = "更新用户当前的主线目标"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [
            "quest": [
                "type": "string",
                "description": "新的主线目标描述",
            ] as [String: Any],
        ] as [String: Any],
        "required": ["quest"],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        guard let quest = args["quest"] as? String, !quest.isEmpty else {
            throw ToolError.missingArgument("quest")
        }
        manager.updateMainQuest(quest)
        return "主线目标已更新：\(quest)"
    }
}

struct AddContextRuleTool: AgentTool {
    let name = "add_context_rule"
    let description = "添加用户教学规则，让 AI 更准确理解活动上下文"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [
            "pattern": [
                "type": "string",
                "description": "匹配模式（如应用名或窗口标题关键词）",
            ] as [String: Any],
            "interpretation": [
                "type": "string",
                "description": "对应解释（如「用户在用 Claude Code 进行 AI 辅助编程」）",
            ] as [String: Any],
        ] as [String: Any],
        "required": ["pattern", "interpretation"],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        guard let pattern = args["pattern"] as? String, !pattern.isEmpty else {
            throw ToolError.missingArgument("pattern")
        }
        guard let interpretation = args["interpretation"] as? String, !interpretation.isEmpty else {
            throw ToolError.missingArgument("interpretation")
        }
        let rule = ContextRule(pattern: pattern, interpretation: interpretation)
        manager.contextAdvisor.addRule(rule)
        return "规则已添加：\(pattern) → \(interpretation)"
    }
}

struct RemoveContextRuleTool: AgentTool {
    let name = "remove_context_rule"
    let description = "删除指定索引的用户教学规则"
    let parameters: [String: Any] = [
        "type": "object",
        "properties": [
            "index": [
                "type": "number",
                "description": "规则索引（从 0 开始，可用 get_context_rules 查看）",
            ] as [String: Any],
        ] as [String: Any],
        "required": ["index"],
    ]

    func execute(args: [String: Any], manager: AgentManager) async throws -> String {
        guard let indexDouble = args["index"] as? Double ?? (args["index"] as? Int).map(Double.init) else {
            throw ToolError.missingArgument("index")
        }
        let index = Int(indexDouble)
        let rules = manager.contextAdvisor.rules
        guard index >= 0 && index < rules.count else {
            return "索引超出范围（共 \(rules.count) 条规则）"
        }
        let removed = rules[index]
        manager.contextAdvisor.removeRule(at: index)
        return "已删除规则[\(index)]：\(removed.pattern) → \(removed.interpretation)"
    }
}
