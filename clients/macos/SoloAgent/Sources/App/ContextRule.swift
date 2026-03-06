import Foundation

/// 用户修正规则 — 教 AI 理解上下文的模式匹配规则
struct ContextRule: Codable, Identifiable {
    let id: UUID
    let pattern: String        // "ccrun"、"Terminal 标题含 claude"
    let interpretation: String // "用户在用 Claude Code 进行 AI 辅助编程"
    let createdAt: Date

    init(pattern: String, interpretation: String) {
        self.id = UUID()
        self.pattern = pattern
        self.interpretation = interpretation
        self.createdAt = Date()
    }
}

// MARK: - JSON Persistence

enum ContextRuleStore {
    private static let fileURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/solo-agent")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("context-rules.json")
    }()

    static func load() -> [ContextRule] {
        guard FileManager.default.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL),
              let rules = try? JSONDecoder().decode([ContextRule].self, from: data) else {
            return []
        }
        return rules
    }

    static func save(_ rules: [ContextRule]) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(rules) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
