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

    // MARK: ReAct 架构
    let memory: AgentMemory
    let agentLoop: AgentLoop

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

        // 初始化 ReAct 记忆 + 循环
        let mem = AgentMemory()
        mem.load()
        self.memory = mem
        self.agentLoop = AgentLoop(
            tools: AgentTools.all,
            memory: mem,
            manager: agentManager
        )

        // 检查是否需要开始新会话（上次活动 > 4 小时前）
        if mem.shouldStartNewSession() {
            mem.resetForNewSession()
        }

        // 加载历史对话（UI 显示用）
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

            // /new — 重置 ReAct 会话
            if command == "/new" {
                memory.resetForNewSession()
                pushSystem("新会话已开始，记忆已清空", icon: "arrow.counterclockwise")
                return
            }

            if let skill = skills[command] {
                let result = await skill.execute(args: args, agent: self, manager: manager)
                pushAgent(result, icon: skill.icon)
            } else {
                pushAgent("未知命令: \(command)\n输入 /help 查看可用命令", icon: "questionmark.circle")
            }
        } else {
            // 自然语言 → ReAct AgentLoop
            await runAgentLoop(trimmed, manager: manager)
        }
    }

    // MARK: - System Push

    func pushSystem(_ text: String, icon: String = "bolt.fill") {
        messages.append(AgentMessage(role: .system, content: text, icon: icon))
    }

    // MARK: - Proactive Inquiry (主动询问)

    /// 主动发起一轮对话 — AI 根据 systemInstruction 生成首条消息并等待用户回复
    func proactiveInquiry(_ instruction: String) async {
        guard !isProcessing else { return }
        guard let manager = agentManager else { return }

        isProcessing = true
        defer { isProcessing = false }

        // 在聊天记录中标注这是主动询问
        pushSystem("主动询问触发", icon: "questionmark.bubble")

        // 构建 system prompt，将 inquiry 指令融入
        let basePrompt = buildSystemPrompt(manager: manager)
        let fullPrompt = """
        \(basePrompt)

        ## 主动询问指令
        \(instruction)
        请直接向用户提问，不要解释你为什么要问。语气简短友好。
        """

        var streamingMsgIdx: Int? = nil

        await agentLoop.run(
            userMessage: "[系统触发：主动询问]",
            systemPrompt: fullPrompt,
            maxIterations: 3
        ) { [weak self] event in
            guard let self else { return }

            switch event {
            case .textDelta(let delta):
                if streamingMsgIdx == nil {
                    let msg = AgentMessage(role: .agent, content: "", icon: "questionmark.bubble", isStreaming: true)
                    self.messages.append(msg)
                    streamingMsgIdx = self.messages.count - 1
                }
                if let idx = streamingMsgIdx {
                    self.messages[idx].content += delta
                }

            case .toolCallStarted(let name, _):
                let display = self.toolDisplayName(name)
                self.pushSystem("正在调用：\(display)…", icon: "gearshape.2")

            case .toolCallResult:
                break

            case .done:
                if let idx = streamingMsgIdx {
                    self.messages[idx].isStreaming = false
                    if self.messages[idx].content.isEmpty {
                        self.messages[idx].content = "在做什么呢？"
                    }
                    streamingMsgIdx = nil
                }
                ChatHistoryStore.save(self.messages)

            case .error(let msg):
                if let idx = streamingMsgIdx {
                    self.messages[idx].isStreaming = false
                    self.messages[idx].content = "出错：\(msg)"
                    streamingMsgIdx = nil
                } else {
                    self.pushAgent("出错：\(msg)", icon: "exclamationmark.triangle")
                }
            }
        }
    }

    // MARK: - Agent Reply

    func pushAgent(_ text: String, icon: String = "sparkles") {
        messages.append(AgentMessage(role: .agent, content: text, icon: icon))
        ChatHistoryStore.save(messages)
    }

    // MARK: - ReAct Loop

    private func runAgentLoop(_ text: String, manager: AgentManager) async {
        let systemPrompt = buildSystemPrompt(manager: manager)
        var streamingMsgIdx: Int? = nil

        await agentLoop.run(
            userMessage: text,
            systemPrompt: systemPrompt,
            maxIterations: 8
        ) { [weak self] event in
            guard let self else { return }

            switch event {
            case .textDelta(let delta):
                if streamingMsgIdx == nil {
                    let msg = AgentMessage(role: .agent, content: "", icon: "sparkles", isStreaming: true)
                    self.messages.append(msg)
                    streamingMsgIdx = self.messages.count - 1
                }
                if let idx = streamingMsgIdx {
                    self.messages[idx].content += delta
                }

            case .toolCallStarted(let name, _):
                let display = self.toolDisplayName(name)
                self.pushSystem("正在调用：\(display)…", icon: "gearshape.2")

            case .toolCallResult:
                break  // 结果已注入 memory，不需额外 UI

            case .done:
                if let idx = streamingMsgIdx {
                    self.messages[idx].isStreaming = false
                    if self.messages[idx].content.isEmpty {
                        self.messages[idx].content = "操作完成"
                    }
                    streamingMsgIdx = nil
                }
                ChatHistoryStore.save(self.messages)

            case .error(let msg):
                if let idx = streamingMsgIdx {
                    self.messages[idx].isStreaming = false
                    self.messages[idx].content = "出错：\(msg)"
                    streamingMsgIdx = nil
                } else {
                    self.pushAgent("出错：\(msg)", icon: "exclamationmark.triangle")
                }
            }
        }
    }

    // MARK: - System Prompt

    private func buildSystemPrompt(manager: AgentManager) -> String {
        let now = Int(Date().timeIntervalSince1970)
        let contextHint = manager.contextAdvisor.buildContextHint(
            startTs: now - 1800, endTs: now, config: manager.config
        )

        let questLine = manager.config.mainQuest.map { "用户主线目标：\($0)\n" } ?? ""

        return """
        你是「暗影智能体」，独自升级系统的 AI 代理。你的职责是理解用户意图，调用合适的工具执行操作，然后给出综合分析和建议。

        \(contextHint.isEmpty ? "" : "## 当前上下文\n\(contextHint)\n")
        \(questLine)
        规则：
        - 优先调用工具获取数据，再综合分析
        - 回复简洁有力，用中文
        - 如果用户请求不需要工具，直接回复（不超过 3 句）
        """
    }

    // MARK: - Tool Display Names

    private func toolDisplayName(_ name: String) -> String {
        switch name {
        case "get_screen_context": return "屏幕上下文"
        case "get_today_cards": return "今日卡片"
        case "get_game_status": return "游戏状态"
        case "get_recent_activity": return "近期活动"
        case "get_context_rules": return "规则列表"
        case "reorganize_cards": return "整理卡片"
        case "analyze_batch": return "重新分析"
        case "set_main_quest": return "更新主线"
        case "add_context_rule": return "添加规则"
        case "remove_context_rule": return "删除规则"
        case "set_window_task": return "记录窗口映射"
        case "get_window_mappings": return "查看映射"
        case "record_away": return "记录离开"
        default: return name
        }
    }
}
