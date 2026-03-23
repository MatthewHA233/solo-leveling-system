import Foundation

/// 上下文感知引擎 — 聚合信号源，生成 contextHint 注入 AI 提示词
@MainActor
final class ContextAdvisor {
    private let persistence: PersistenceManager
    private let ruleClassifier: RuleClassifier
    private var userRules: [ContextRule] = []

    init(persistence: PersistenceManager, ruleClassifier: RuleClassifier) {
        self.persistence = persistence
        self.ruleClassifier = ruleClassifier
        self.userRules = ContextRuleStore.load()
    }

    // MARK: - Build Context Hint

    /// 构建上下文提示，注入 AI 分析管道
    func buildContextHint(startTs: Int, endTs: Int, config: AgentConfig) -> String {
        var sections: [String] = []

        // 1. 查询时间范围内的活动记录
        let startDate = Date(timeIntervalSince1970: TimeInterval(startTs))
        let endDate = Date(timeIntervalSince1970: TimeInterval(endTs))
        let activities = persistence.activitiesWithScreenshots(from: startDate, to: endDate)

        // 如果没有精确范围内的记录，fallback 到最近 50 条
        let records = activities.isEmpty ? persistence.recentActivities(limit: 50) : activities

        guard !records.isEmpty else {
            // 至少输出主线目标
            if let quest = config.mainQuest, !quest.isEmpty {
                return "用户当前主线目标：\(quest)"
            }
            return ""
        }

        // 2. 聚合各 app 使用时长和窗口标题关键词
        var appDurations: [String: Int] = [:]  // appName -> 出现次数
        var windowKeywords: [String: Int] = [:]  // 关键词 -> 出现次数
        var activeApps: [String] = []

        for record in records {
            let appName = record.appName ?? "Unknown"
            appDurations[appName, default: 0] += 1

            if let title = record.windowTitle, !title.isEmpty {
                // 提取有意义的关键词
                let keywords = extractKeywords(from: title)
                for kw in keywords {
                    windowKeywords[kw, default: 0] += 1
                }
            }

            if !activeApps.contains(appName) {
                activeApps.append(appName)
            }
        }

        // 按出现次数排序的 app 列表
        let sortedApps = appDurations.sorted { $0.value > $1.value }
        let topApps = sortedApps.prefix(5).map { "\($0.key)(\($0.value)次)" }
        if !topApps.isEmpty {
            sections.append("活跃应用：\(topApps.joined(separator: "、"))")
        }

        // 高频窗口关键词
        let topKeywords = windowKeywords.sorted { $0.value > $1.value }
            .prefix(8)
            .map { $0.key }
        if !topKeywords.isEmpty {
            sections.append("窗口关键词：\(topKeywords.joined(separator: "、"))")
        }

        // 3. 规则引擎分类分布
        var categoryDist: [String: Int] = [:]
        for record in records {
            let classification = ruleClassifier.classify(
                appName: record.appName,
                windowTitle: record.windowTitle
            )
            categoryDist[classification.category.rawValue, default: 0] += 1
        }
        let topCategories = categoryDist.sorted { $0.value > $1.value }
            .prefix(3)
            .map { "\($0.key)(\($0.value))" }
        if !topCategories.isEmpty {
            sections.append("活动类别分布：\(topCategories.joined(separator: "、"))")
        }

        // 4. 匹配用户修正规则
        var matchedRules: [String] = []
        for rule in userRules {
            let pattern = rule.pattern.lowercased()
            for record in records {
                let appName = (record.appName ?? "").lowercased()
                let title = (record.windowTitle ?? "").lowercased()
                if appName.contains(pattern) || title.contains(pattern) {
                    matchedRules.append(rule.interpretation)
                    break
                }
            }
        }
        if !matchedRules.isEmpty {
            sections.append("用户教学规则匹配：\(matchedRules.joined(separator: "；"))")
        }

        // 5. 操作状态时间线
        let timeFmt = DateFormatter()
        timeFmt.dateFormat = "HH:mm:ss"
        var stateTimeline: [String] = []
        for record in records {
            let time = timeFmt.string(from: record.timestamp)
            let idle = Int(record.idleSeconds)
            let state: String
            if record.activityState == "active" && idle < 3 {
                state = "主动操作"
            } else if record.activityState == "active" && idle < 15 {
                state = "阅览"
            } else if record.activityState == "active" && idle < 60 {
                state = "等待"
            } else {
                state = "放置"
            }
            stateTimeline.append("[\(time)] \(state)(idle=\(idle)s) \(record.appName ?? "")")
        }
        if !stateTimeline.isEmpty {
            sections.append("操作状态时间线：\n\(stateTimeline.joined(separator: "\n"))")
        }

        // 6. 应用切换时间线
        var switchEvents: [String] = []
        var prevApp: String? = nil
        for record in records {
            let app = record.appName ?? "Unknown"
            if app != prevApp {
                let time = timeFmt.string(from: record.timestamp)
                let title = String((record.windowTitle ?? "").prefix(40))
                switchEvents.append("[\(time)] → \(app): \(title)")
                prevApp = app
            }
        }
        if !switchEvents.isEmpty {
            sections.append("应用切换时间线：\n\(switchEvents.joined(separator: "\n"))")
        }

        // 7. 主线目标
        if let quest = config.mainQuest, !quest.isEmpty {
            sections.append("用户当前主线目标：\(quest)")
        }

        // 8. 窗口记忆（优先级最高的上下文来源）
        let windowMemoryLines = buildWindowMemoryHint(records: records)
        if !windowMemoryLines.isEmpty {
            sections.insert("【窗口记忆（主人确认）】\n\(windowMemoryLines)", at: 0)
        }

        // 组装输出
        guard !sections.isEmpty else { return "" }
        return sections.joined(separator: "\n")
    }

    // MARK: - Rule CRUD

    func addRule(_ rule: ContextRule) {
        userRules.append(rule)
        ContextRuleStore.save(userRules)
        AIClient.debugLog("[ContextAdvisor] 添加规则: \(rule.pattern) = \(rule.interpretation)")
    }

    func removeRule(id: UUID) {
        userRules.removeAll { $0.id == id }
        ContextRuleStore.save(userRules)
        AIClient.debugLog("[ContextAdvisor] 删除规则: \(id)")
    }

    func removeRule(at index: Int) {
        guard index >= 0 && index < userRules.count else { return }
        let removed = userRules.remove(at: index)
        ContextRuleStore.save(userRules)
        AIClient.debugLog("[ContextAdvisor] 删除规则[\(index)]: \(removed.pattern)")
    }

    var rules: [ContextRule] { userRules }

    // MARK: - Context Signal Summary (for /context command)

    /// 获取当前上下文信号摘要（供 /context 命令展示）
    func currentContextSummary(config: AgentConfig) -> String {
        let now = Int(Date().timeIntervalSince1970)
        let thirtyMinAgo = now - 1800
        let hint = buildContextHint(startTs: thirtyMinAgo, endTs: now, config: config)

        var lines: [String] = []
        lines.append("── 上下文信号（最近 30 分钟）──")
        if hint.isEmpty {
            lines.append("暂无活动记录")
        } else {
            lines.append(hint)
        }

        lines.append("")
        lines.append("── 用户规则（\(userRules.count) 条）──")
        if userRules.isEmpty {
            lines.append("暂无规则，用 /rule add <pattern> = <interpretation> 添加")
        } else {
            for (i, rule) in userRules.enumerated() {
                lines.append("[\(i)] \(rule.pattern) → \(rule.interpretation)")
            }
        }

        return lines.joined(separator: "\n")
    }

    // MARK: - Window Memory

    /// 从活动记录中提取匹配的窗口记忆，作为强上下文注入
    private func buildWindowMemoryHint(records: [ActivityRecord]) -> String {
        let matcher = WindowTaskMatcher.shared
        var seen = Set<String>()
        var lines: [String] = []

        for record in records {
            guard let bundleId = record.bundleId else { continue }
            let key = bundleId + (record.windowTitle ?? "")
            if seen.contains(key) { continue }
            seen.insert(key)

            if let summary = matcher.contextSummary(bundleId: bundleId, windowTitle: record.windowTitle) {
                lines.append(summary)
            }
        }

        return lines.joined(separator: "\n")
    }

    // MARK: - Helpers

    /// 从窗口标题提取有意义的关键词
    private func extractKeywords(from title: String) -> [String] {
        // 过滤太短或太通用的词
        let stopWords: Set<String> = ["the", "a", "an", "and", "or", "in", "on", "at",
                                       "to", "for", "of", "is", "it", "by", "—", "-", "|",
                                       "with", "from", "this", "that"]
        return title
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count >= 2 && !stopWords.contains($0.lowercased()) }
            .map { $0.lowercased() }
            .removingDuplicates()
    }
}

// MARK: - Array Extension

private extension Array where Element: Hashable {
    func removingDuplicates() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}
