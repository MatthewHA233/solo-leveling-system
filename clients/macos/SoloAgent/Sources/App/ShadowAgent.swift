import Foundation

// MARK: - Data Models

struct AgentMessage: Identifiable, Codable {
    let id: UUID
    let timestamp: Date
    let role: AgentMessageRole
    var content: String
    let icon: String?
    var isStreaming: Bool = false
    /// 语音消息文件名（存储在 ~/.config/solo-agent/voice/）
    var voiceFile: String?
    /// 语音时长（秒）
    var voiceDuration: Double?

    init(role: AgentMessageRole, content: String, icon: String?, isStreaming: Bool = false, voiceFile: String? = nil, voiceDuration: Double? = nil) {
        self.id = UUID()
        self.timestamp = Date()
        self.role = role
        self.content = content
        self.icon = icon
        self.isStreaming = isStreaming
        self.voiceFile = voiceFile
        self.voiceDuration = voiceDuration
    }

    enum CodingKeys: String, CodingKey {
        case id, timestamp, role, content, icon, voiceFile, voiceDuration
    }
}

// MARK: - Voice File Storage

enum VoiceFileStore {
    static let directory: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/solo-agent/voice")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// 保存 WAV 数据到磁盘，返回文件名
    static func save(_ wavData: Data) -> String {
        let filename = "voice-\(UUID().uuidString.prefix(8)).wav"
        let url = directory.appendingPathComponent(filename)
        try? wavData.write(to: url, options: .atomic)
        return filename
    }

    /// 获取语音文件完整路径
    static func url(for filename: String) -> URL {
        directory.appendingPathComponent(filename)
    }
}

enum AgentMessageRole: String, Codable {
    case user
    case agent
    case system
}

// MARK: - Chat Persistence

enum ChatHistoryStore {
    private static let fileURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/solo-agent")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("chat-history.json")
    }()

    static func load() -> [AgentMessage] {
        guard FileManager.default.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([AgentMessage].self, from: data)) ?? []
    }

    static func save(_ messages: [AgentMessage]) {
        // 只持久化 user/agent 消息，保留最近 200 条
        let persistable = messages
            .filter { $0.role != .system }
            .suffix(200)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(Array(persistable)) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}

// MARK: - Shadow Agent

@MainActor
final class ShadowAgent: ObservableObject {
    @Published var messages: [AgentMessage] = []
    @Published var isProcessing: Bool = false

    private let skills: [String: any AgentSkill]
    private weak var agentManager: AgentManager?

    /// 所有可用 skills（供 ChatInputBar 补全用）
    var availableSkills: [any AgentSkill] {
        skills.values.sorted { $0.command < $1.command }
    }

    init(agentManager: AgentManager) {
        self.agentManager = agentManager

        // 注册内置 Skills
        let allSkills: [any AgentSkill] = [
            ReorganizeSkill(),
            AnalyzeSkill(),
            RegenerateSkill(),
            StatusSkill(),
            ContextSkill(),
            RuleSkill(),
            HelpSkill(),
        ]
        var dict: [String: any AgentSkill] = [:]
        for skill in allSkills {
            dict[skill.command] = skill
        }
        self.skills = dict

        // 加载历史对话
        let history = ChatHistoryStore.load()
        if history.isEmpty {
            pushSystem("暗影智能体已上线，输入 /help 查看可用命令", icon: "bolt.fill")
        } else {
            self.messages = history
            pushSystem("对话已恢复（\(history.count) 条历史）", icon: "arrow.counterclockwise")
        }
    }

    // MARK: - User Send

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }

        // 追加用户消息
        messages.append(AgentMessage(role: .user, content: trimmed, icon: nil))
        ChatHistoryStore.save(messages)

        isProcessing = true
        defer { isProcessing = false }

        guard let manager = agentManager else {
            pushAgent("系统未就绪，请稍后再试", icon: "exclamationmark.triangle.fill")
            return
        }

        if trimmed.hasPrefix("/") {
            // 解析 /command args
            let parts = trimmed.dropFirst().split(separator: " ", maxSplits: 1)
            let command = "/" + (parts.first.map(String.init) ?? "")
            let args = parts.count > 1 ? String(parts[1]) : ""

            if let skill = skills[command] {
                let result = await skill.execute(args: args, agent: self, manager: manager)
                pushAgent(result, icon: skill.icon)
            } else {
                pushAgent("未知命令: \(command)\n输入 /help 查看可用命令", icon: "questionmark.circle")
            }
        } else {
            // 自然语言 — 先尝试关键词快速匹配
            if let matched = matchSkillByKeyword(trimmed) {
                let result = await matched.execute(args: "", agent: self, manager: manager)
                pushAgent(result, icon: matched.icon)
            } else {
                // AI function calling 调度
                await dispatchViaAI(trimmed, manager: manager)
            }
        }
    }

    // MARK: - System Push

    func pushSystem(_ text: String, icon: String = "bolt.fill") {
        messages.append(AgentMessage(role: .system, content: text, icon: icon))
    }

    // MARK: - Agent Reply

    func pushAgent(_ text: String, icon: String = "sparkles") {
        messages.append(AgentMessage(role: .agent, content: text, icon: icon))
        ChatHistoryStore.save(messages)
    }

    // MARK: - AI Dispatch

    private func dispatchViaAI(_ text: String, manager: AgentManager) async {
        // 构建 tools 定义
        let tools = buildToolDefinitions()

        guard let result = await manager.dispatchAgent(userMessage: text, tools: tools) else {
            pushAgent("AI 未配置或网络异常，请检查设置\n也可直接用 /command 格式", icon: "exclamationmark.triangle")
            return
        }

        // 如果 AI 返回了 tool_call → 执行对应 skill
        if let call = result.toolCall, let skill = skills[call.command] {
            let output = await skill.execute(args: call.args, agent: self, manager: manager)
            pushAgent(output, icon: skill.icon)
            return
        }

        // 如果 AI 返回了文字回复
        if let text = result.textResponse {
            pushAgent(text, icon: "sparkles")
            return
        }

        pushAgent("暂时无法处理这个请求，试试 /help 查看可用指令", icon: "info.circle")
    }

    /// 将注册的 Skills 转换为 OpenAI function calling 的 tools 格式
    private func buildToolDefinitions() -> [[String: Any]] {
        // 不需要暴露 /help 给 AI
        let skipCommands: Set<String> = ["/help"]

        return skills.values
            .filter { !skipCommands.contains($0.command) }
            .map { skill -> [String: Any] in
                let name = String(skill.command.dropFirst()) // 去掉 /
                var properties: [String: Any] = [:]
                var required: [String] = []

                // 需要参数的命令
                let needsArgs: Set<String> = ["/analyze", "/regenerate", "/rule"]
                if needsArgs.contains(skill.command) {
                    properties["args"] = [
                        "type": "string",
                        "description": argDescription(for: skill.command),
                    ] as [String: Any]
                    if skill.command != "/rule" {
                        required.append("args")
                    }
                }

                return [
                    "type": "function",
                    "function": [
                        "name": name,
                        "description": skill.description,
                        "parameters": [
                            "type": "object",
                            "properties": properties,
                            "required": required,
                        ] as [String: Any],
                    ] as [String: Any],
                ] as [String: Any]
            }
    }

    private func argDescription(for command: String) -> String {
        switch command {
        case "/analyze": return "批次 ID"
        case "/regenerate": return "批次 ID"
        case "/rule": return "子命令，如 'list' 或 'add <pattern> = <interpretation>' 或 'remove <index>'"
        default: return "参数"
        }
    }

    // MARK: - Keyword Matching

    private func matchSkillByKeyword(_ text: String) -> (any AgentSkill)? {
        let keywords: [(keywords: [String], command: String)] = [
            (["整理", "合并", "reorganize"], "/reorganize"),
            (["状态", "诊断", "status"], "/status"),
            (["上下文", "context"], "/context"),
            (["规则", "rule"], "/rule"),
            (["帮助", "help", "命令"], "/help"),
        ]
        for entry in keywords {
            for keyword in entry.keywords {
                if text.contains(keyword), let skill = skills[entry.command] {
                    return skill
                }
            }
        }
        return nil
    }
}
