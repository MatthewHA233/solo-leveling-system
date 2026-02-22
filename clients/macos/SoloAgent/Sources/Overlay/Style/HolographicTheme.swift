import SwiftUI

/// 独自升级系统全息风格主题
enum HolographicTheme {

    // MARK: - Primary Colors

    /// 主蓝 #4A9EFF
    static let primaryBlue = Color(red: 0.29, green: 0.62, blue: 1.0)

    /// 副紫 #8B5CF6
    static let accentPurple = Color(red: 0.545, green: 0.361, blue: 0.965)

    /// 经验条绿 #00FF88
    static let expGreen = Color(red: 0.0, green: 1.0, blue: 0.533)

    /// 文字色 #E0F0FF
    static let textPrimary = Color(red: 0.878, green: 0.941, blue: 1.0)

    /// 次要文字
    static let textSecondary = Color(red: 0.6, green: 0.7, blue: 0.8)

    /// 面板深色背景
    static let panelBackground = Color(red: 0.0, green: 0.03, blue: 0.08)

    /// 错误/危险红
    static let dangerRed = Color(red: 1.0, green: 0.3, blue: 0.3)

    /// 警告橙
    static let warningOrange = Color(red: 1.0, green: 0.6, blue: 0.2)

    // MARK: - Difficulty Colors

    static func difficultyColor(_ difficulty: QuestDifficulty) -> Color {
        switch difficulty {
        case .E: return .gray
        case .D: return .green
        case .C: return primaryBlue
        case .B: return accentPurple
        case .A: return warningOrange
        case .S: return dangerRed
        }
    }

    // MARK: - Gradients

    static let borderGradient = LinearGradient(
        colors: [primaryBlue, accentPurple, primaryBlue],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let expBarGradient = LinearGradient(
        colors: [expGreen.opacity(0.8), expGreen],
        startPoint: .leading,
        endPoint: .trailing
    )

    static let panelGradient = LinearGradient(
        colors: [
            panelBackground.opacity(0.9),
            Color(red: 0.02, green: 0.05, blue: 0.12).opacity(0.85),
        ],
        startPoint: .top,
        endPoint: .bottom
    )

    // MARK: - Fonts

    static let titleFont: Font = .system(size: 14, weight: .bold, design: .monospaced)
    static let bodyFont: Font = .system(size: 12, weight: .regular, design: .monospaced)
    static let captionFont: Font = .system(size: 10, weight: .regular, design: .monospaced)
    static let levelFont: Font = .system(size: 28, weight: .heavy, design: .monospaced)
    static let miniLevelFont: Font = .system(size: 11, weight: .bold, design: .monospaced)

    // MARK: - Dimensions

    static let miniBarSize = CGSize(width: 200, height: 36)
    static let fullPanelSize = CGSize(width: 500, height: 700)
    static let cornerRadius: CGFloat = 12
    static let borderWidth: CGFloat = 1
}
