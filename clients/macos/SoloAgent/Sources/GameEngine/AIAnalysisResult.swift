import Foundation

/// AI 分析结果模型
struct AIAnalysisResult: Codable {
    let activity: String        // "在用 Swift 实现 AI 客户端"
    let category: String        // "coding"
    let motive: String          // "正在开发新功能"
    let focusScore: Double      // 0.0-1.0
    let mood: String            // "focused"
    let suggestion: AISuggestion?

    enum CodingKeys: String, CodingKey {
        case activity
        case category
        case motive
        case focusScore = "focus_score"
        case mood
        case suggestion
    }
}

/// AI 建议
struct AISuggestion: Codable {
    let type: String            // "buff" | "quest" | "none"
    let detail: String
    let priority: String        // "low" | "medium" | "high"
}
