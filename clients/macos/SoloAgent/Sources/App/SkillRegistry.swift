import Foundation

// MARK: - Skill Protocol

@MainActor
protocol AgentSkill {
    var command: String { get }
    var label: String { get }
    var icon: String { get }
    var description: String { get }
    func execute(args: String, agent: ShadowAgent, manager: AgentManager) async -> String
}

// MARK: - /reorganize

struct ReorganizeSkill: AgentSkill {
    let command = "/reorganize"
    let label = "整理卡片"
    let icon = "sparkles"
    let description = "合并今日碎片卡片"

    func execute(args: String, agent: ShadowAgent, manager: AgentManager) async -> String {
        agent.pushSystem("开始整理今日卡片...", icon: "arrow.triangle.2.circlepath")
        let success = await manager.reorganizeTodayCards()
        if success {
            return "今日卡片整理完成"
        } else {
            return "整理失败：AI 未配置或 batchManager 不可用"
        }
    }
}

// MARK: - /analyze

struct AnalyzeSkill: AgentSkill {
    let command = "/analyze"
    let label = "重新分析"
    let icon = "film"
    let description = "重新分析指定批次（Phase 1 + Phase 2）"

    func execute(args: String, agent: ShadowAgent, manager: AgentManager) async -> String {
        let batchId = args.trimmingCharacters(in: .whitespaces)
        guard !batchId.isEmpty else {
            return "用法: /analyze <batchId>"
        }
        agent.pushSystem("重新分析批次 \(batchId)...", icon: "film")
        let success = await manager.reanalyzeBatch(batchId)
        if success {
            return "批次 \(batchId) 重新分析完成"
        } else {
            return "重新分析失败：AI 未配置或 batchManager 不可用"
        }
    }
}

// MARK: - /regenerate

struct RegenerateSkill: AgentSkill {
    let command = "/regenerate"
    let label = "重新生成"
    let icon = "arrow.clockwise"
    let description = "重新生成指定批次的卡片"

    func execute(args: String, agent: ShadowAgent, manager: AgentManager) async -> String {
        let batchId = args.trimmingCharacters(in: .whitespaces)
        guard !batchId.isEmpty else {
            return "用法: /regenerate <batchId>"
        }
        agent.pushSystem("重新生成批次 \(batchId) 的卡片...", icon: "arrow.clockwise")
        let success = await manager.regenerateCards(batchId)
        if success {
            return "批次 \(batchId) 卡片重新生成完成"
        } else {
            return "重新生成失败：AI 未配置或 batchManager 不可用"
        }
    }
}

// MARK: - /status

struct StatusSkill: AgentSkill {
    let command = "/status"
    let label = "系统状态"
    let icon = "gauge.with.dots.needle.33percent"
    let description = "系统诊断 — 显示 AI 配置与运行状态"

    func execute(args: String, agent: ShadowAgent, manager: AgentManager) async -> String {
        let config = manager.config
        let aiEnabled = config.aiEnabled
        let provider = config.aiProvider
        let model = provider == "openai" ? config.openaiModel : config.geminiModel
        let hasKey: Bool = {
            if provider == "openai" {
                return config.openaiApiKey != nil && !config.openaiApiKey!.isEmpty
            } else {
                return config.geminiApiKey != nil && !config.geminiApiKey!.isEmpty
            }
        }()

        var lines: [String] = []
        lines.append("── 系统诊断 ──")
        lines.append("运行状态: \(manager.statusText)")
        lines.append("捕获: \(manager.isCapturing ? "运行中" : "已停止") | 隐私模式: \(manager.isPaused ? "开" : "关")")
        lines.append("今日截图: \(manager.captureCount)")
        lines.append("")
        lines.append("── AI 配置 ──")
        lines.append("AI 启用: \(aiEnabled ? "是" : "否")")
        lines.append("提供商: \(provider)")
        lines.append("模型: \(model)")
        lines.append("API Key: \(hasKey ? "已配置" : "未配置")")
        lines.append("")
        lines.append("── 游戏引擎 ──")
        lines.append("等级: Lv.\(manager.player.level) \(manager.player.title)")
        lines.append("经验: \(manager.player.exp)/\(manager.player.expToNext)")
        lines.append("活跃任务: \(manager.activeQuests.count)")
        lines.append("活跃 Buff: \(manager.activeBuffs.count)")

        return lines.joined(separator: "\n")
    }
}

// MARK: - /context

struct ContextSkill: AgentSkill {
    let command = "/context"
    let label = "上下文信号"
    let icon = "eye"
    let description = "显示当前上下文信号 + 规则列表"

    func execute(args: String, agent: ShadowAgent, manager: AgentManager) async -> String {
        return manager.contextAdvisor.currentContextSummary(config: manager.config)
    }
}

// MARK: - /rule

struct RuleSkill: AgentSkill {
    let command = "/rule"
    let label = "规则管理"
    let icon = "book"
    let description = "管理上下文规则（add/list/remove）"

    func execute(args: String, agent: ShadowAgent, manager: AgentManager) async -> String {
        let trimmed = args.trimmingCharacters(in: .whitespaces)

        // /rule list
        if trimmed.isEmpty || trimmed == "list" {
            let rules = manager.contextAdvisor.rules
            if rules.isEmpty {
                return "暂无规则\n用法: /rule add <pattern> = <interpretation>"
            }
            var lines = ["── 上下文规则（\(rules.count) 条）──"]
            for (i, rule) in rules.enumerated() {
                lines.append("[\(i)] \(rule.pattern) → \(rule.interpretation)")
            }
            return lines.joined(separator: "\n")
        }

        // /rule add <pattern> = <interpretation>
        if trimmed.hasPrefix("add ") {
            let content = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespaces)
            let parts = content.components(separatedBy: " = ")
            guard parts.count == 2,
                  !parts[0].trimmingCharacters(in: .whitespaces).isEmpty,
                  !parts[1].trimmingCharacters(in: .whitespaces).isEmpty else {
                return "用法: /rule add <pattern> = <interpretation>\n例: /rule add ccrun终端 = 用 Claude Code 编程"
            }
            let pattern = parts[0].trimmingCharacters(in: .whitespaces)
            let interpretation = parts[1].trimmingCharacters(in: .whitespaces)
            let rule = ContextRule(pattern: pattern, interpretation: interpretation)
            manager.contextAdvisor.addRule(rule)
            return "规则已添加: \(pattern) → \(interpretation)"
        }

        // /rule remove <index>
        if trimmed.hasPrefix("remove ") {
            let indexStr = String(trimmed.dropFirst(7)).trimmingCharacters(in: .whitespaces)
            guard let index = Int(indexStr) else {
                return "用法: /rule remove <index>\n先用 /rule list 查看索引"
            }
            let rules = manager.contextAdvisor.rules
            guard index >= 0 && index < rules.count else {
                return "索引超出范围（共 \(rules.count) 条规则）"
            }
            let removed = rules[index]
            manager.contextAdvisor.removeRule(at: index)
            return "已删除规则[\(index)]: \(removed.pattern) → \(removed.interpretation)"
        }

        return "用法:\n  /rule list — 列出规则\n  /rule add <pattern> = <interpretation> — 添加规则\n  /rule remove <index> — 删除规则"
    }
}

// MARK: - /help

struct HelpSkill: AgentSkill {
    let command = "/help"
    let label = "帮助"
    let icon = "questionmark.circle"
    let description = "列出所有可用命令"

    func execute(args: String, agent: ShadowAgent, manager: AgentManager) async -> String {
        let allSkills: [any AgentSkill] = [
            ReorganizeSkill(),
            AnalyzeSkill(),
            RegenerateSkill(),
            StatusSkill(),
            ContextSkill(),
            RuleSkill(),
            HelpSkill(),
        ]
        var lines: [String] = ["── 可用命令 ──"]
        for skill in allSkills {
            lines.append("\(skill.command) — \(skill.label)")
            lines.append("  \(skill.description)")
        }
        lines.append("")
        lines.append("也可以直接输入关键词（如「整理」「状态」「上下文」「规则」）")
        return lines.joined(separator: "\n")
    }
}
