import Foundation

// MARK: - Tool Call Record

struct ToolCallRecord: Codable {
    let id: String
    let name: String
    let arguments: String  // JSON string
}

// MARK: - Session Message

struct SessionMessage: Codable {
    /// "user" | "assistant" | "tool"
    let role: String
    let content: String?
    /// assistant 携带的工具调用
    let toolCalls: [ToolCallRecord]?
    /// tool 回复时对应的 call id
    let toolCallId: String?
    /// tool 回复时的工具名称
    let name: String?
    let timestamp: Date

    init(
        role: String,
        content: String? = nil,
        toolCalls: [ToolCallRecord]? = nil,
        toolCallId: String? = nil,
        name: String? = nil
    ) {
        self.role = role
        self.content = content
        self.toolCalls = toolCalls
        self.toolCallId = toolCallId
        self.name = name
        self.timestamp = Date()
    }
}

// MARK: - Agent Memory

@MainActor
final class AgentMemory {
    var messages: [SessionMessage] = []
    let maxMessages: Int = 40
    var sessionSummary: String?

    private static let fileURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/solo-agent")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("memory.json")
    }()

    // MARK: - Build LLM Messages

    /// 构建发往 LLM 的消息数组（OpenAI-compatible 格式）
    func buildLLMMessages(systemPrompt: String) -> [[String: Any]] {
        var result: [[String: Any]] = []

        result.append(["role": "system", "content": systemPrompt])

        if let summary = sessionSummary {
            result.append([
                "role": "system",
                "content": "本轮会话开始前的历史摘要：\(summary)",
            ])
        }

        for msg in messages {
            switch msg.role {
            case "user":
                if let content = msg.content {
                    result.append(["role": "user", "content": content])
                }

            case "assistant":
                var entry: [String: Any] = ["role": "assistant"]
                if let content = msg.content, !content.isEmpty {
                    entry["content"] = content
                } else {
                    entry["content"] = NSNull()
                }
                if let toolCalls = msg.toolCalls, !toolCalls.isEmpty {
                    entry["tool_calls"] = toolCalls.map { tc -> [String: Any] in
                        [
                            "id": tc.id,
                            "type": "function",
                            "function": [
                                "name": tc.name,
                                "arguments": tc.arguments,
                            ] as [String: Any],
                        ]
                    }
                }
                result.append(entry)

            case "tool":
                var entry: [String: Any] = ["role": "tool", "content": msg.content ?? ""]
                if let tcid = msg.toolCallId { entry["tool_call_id"] = tcid }
                if let n = msg.name { entry["name"] = n }
                result.append(entry)

            default:
                break
            }
        }

        return result
    }

    // MARK: - Append

    func appendUser(_ content: String) {
        messages.append(SessionMessage(role: "user", content: content))
    }

    func appendAssistant(text: String?, toolCalls: [ToolCallRecord]?) {
        messages.append(SessionMessage(
            role: "assistant",
            content: text,
            toolCalls: toolCalls
        ))
    }

    func appendToolResult(toolCallId: String, name: String, result: String) {
        messages.append(SessionMessage(
            role: "tool",
            content: result,
            toolCallId: toolCallId,
            name: name
        ))
    }

    // MARK: - Session Management

    /// 上次消息距今 > 4 小时则应开始新会话
    func shouldStartNewSession() -> Bool {
        guard let lastMsg = messages.last else { return false }
        return Date().timeIntervalSince(lastMsg.timestamp) > 4 * 3600
    }

    /// 重置为新会话，保留旧会话的简短摘要
    func resetForNewSession() {
        guard !messages.isEmpty else { return }
        let count = messages.count
        let first = messages.first?.timestamp
        let dateStr = first.map {
            DateFormatter.localizedString(from: $0, dateStyle: .short, timeStyle: .short)
        } ?? "之前"
        sessionSummary = "上次会话（\(dateStr)）共 \(count) 条消息。"
        messages = []
        save()
    }

    // MARK: - Trim

    /// 超出 maxMessages 时丢弃最旧的一半并记录摘要
    func trimIfNeeded() async {
        guard messages.count > maxMessages else { return }
        let dropCount = maxMessages / 2
        let dropped = messages.prefix(dropCount)
        let firstTs = dropped.first?.timestamp
        let dateStr = firstTs.map {
            DateFormatter.localizedString(from: $0, dateStyle: .short, timeStyle: .short)
        } ?? "之前"
        let existing = sessionSummary.map { $0 + " " } ?? ""
        sessionSummary = "\(existing)（\(dateStr) 起的 \(dropCount) 条早期消息已压缩）"
        messages.removeFirst(dropCount)
        save()
    }

    // MARK: - Persist

    func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = .prettyPrinted
        let payload = MemoryPayload(messages: messages, sessionSummary: sessionSummary)
        guard let data = try? encoder.encode(payload) else { return }
        try? data.write(to: Self.fileURL, options: .atomic)
    }

    func load() {
        guard FileManager.default.fileExists(atPath: Self.fileURL.path),
              let data = try? Data(contentsOf: Self.fileURL) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let payload = try? decoder.decode(MemoryPayload.self, from: data) {
            messages = payload.messages
            sessionSummary = payload.sessionSummary
        }
    }

    private struct MemoryPayload: Codable {
        var messages: [SessionMessage]
        var sessionSummary: String?
    }
}
