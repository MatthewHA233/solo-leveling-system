import SwiftUI

/// Neon Brutalism 主题 — 深空黑 + 电光蓝 + 暗影紫
enum NeonBrutalismTheme {

    // MARK: - Colors

    /// 深空黑 #050505
    static let background = Color(red: 0.02, green: 0.02, blue: 0.02)

    /// 电光蓝 #00E5FF
    static let electricBlue = Color(red: 0.0, green: 0.898, blue: 1.0)

    /// 暗影紫 #7000FF
    static let shadowPurple = Color(red: 0.439, green: 0.0, blue: 1.0)

    /// 经验绿 #00FF88
    static let expGreen = Color(red: 0.0, green: 1.0, blue: 0.533)

    /// 警报红 #FF4444
    static let dangerRed = Color(red: 1.0, green: 0.267, blue: 0.267)

    /// 主文字 #E0F0FF
    static let textPrimary = Color(red: 0.878, green: 0.941, blue: 1.0)

    /// 次要文字 #5A6A7A
    static let textSecondary = Color(red: 0.353, green: 0.416, blue: 0.478)

    /// 警告橙（兼容旧引用）
    static let warningOrange = Color(red: 1.0, green: 0.6, blue: 0.2)

    // MARK: - Difficulty Colors

    static func difficultyColor(_ difficulty: QuestDifficulty) -> Color {
        switch difficulty {
        case .E: return textSecondary
        case .D: return expGreen
        case .C: return electricBlue
        case .B: return shadowPurple
        case .A: return warningOrange
        case .S: return dangerRed
        }
    }

    // MARK: - Gradients

    static let borderGradient = LinearGradient(
        colors: [electricBlue.opacity(0.4), shadowPurple.opacity(0.4), electricBlue.opacity(0.4)],
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
            background.opacity(0.95),
            Color(red: 0.03, green: 0.02, blue: 0.06).opacity(0.92),
        ],
        startPoint: .top,
        endPoint: .bottom
    )

    // MARK: - Fonts (SF Mono 全局)

    static let titleFont: Font = .system(size: 13, weight: .bold, design: .monospaced)
    static let bodyFont: Font = .system(size: 12, weight: .regular, design: .monospaced)
    static let captionFont: Font = .system(size: 10, weight: .regular, design: .monospaced)
    static let levelFont: Font = .system(size: 32, weight: .heavy, design: .monospaced)
    static let miniLevelFont: Font = .system(size: 11, weight: .bold, design: .monospaced)
    static let sectionHeaderFont: Font = .system(size: 11, weight: .heavy, design: .monospaced)

    // MARK: - Dimensions

    static let miniBarSize = CGSize(width: 200, height: 36)
    static let cornerRadius: CGFloat = 12
    static let borderWidth: CGFloat = 1
    static let dividerOpacity: Double = 0.15
}
