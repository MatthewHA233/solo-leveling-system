import SwiftUI
import AppKit

/// 任务面板 — 仅保留任务列表（时间线已由昼夜表替代）
struct DirectivesHubView: View {
    @ObservedObject var agentManager: AgentManager
    let quests: [Quest]
    var onCompleteQuest: ((String) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            // Fixed header
            HStack {
                Text("THE DIRECTIVES")
                    .font(NeonBrutalismTheme.sectionHeaderFont)
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                    .padding(.leading, 16)
                Spacer()
                Text("\(activeQuests.count) ACTIVE")
                    .font(NeonBrutalismTheme.captionFont)
                    .foregroundColor(NeonBrutalismTheme.electricBlue)
                    .padding(.trailing, 16)
            }
            .padding(.vertical, 8)

            NeonDivider(.horizontal)

            // Directives content
            directivesContent
        }
    }

    // MARK: - Directives (任务)

    private var directivesContent: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 8) {
                if activeQuests.isEmpty {
                    VStack(spacing: 8) {
                        Text("NO ACTIVE DIRECTIVES")
                            .font(NeonBrutalismTheme.bodyFont)
                            .foregroundColor(NeonBrutalismTheme.textSecondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    ForEach(activeQuests) { quest in
                        questCard(quest)
                            .padding(.horizontal, 16)
                    }
                }

                // Recent completed
                let completed = recentCompleted
                if !completed.isEmpty {
                    NeonDivider(.horizontal)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)

                    Text("COMPLETED")
                        .font(NeonBrutalismTheme.captionFont)
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                        .padding(.horizontal, 16)
                        .padding(.top, 4)

                    ForEach(completed) { quest in
                        completedQuestRow(quest)
                            .padding(.horizontal, 16)
                    }
                }
            }
            .padding(.vertical, 8)
        }
    }

    private func questCard(_ quest: Quest) -> some View {
        HStack(spacing: 10) {
            // Difficulty badge
            Text(quest.difficulty.rawValue)
                .font(.system(size: 11, weight: .heavy, design: .monospaced))
                .foregroundColor(.white)
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(NeonBrutalismTheme.difficultyColor(quest.difficulty))
                )
                .shadow(color: NeonBrutalismTheme.difficultyColor(quest.difficulty).opacity(0.5), radius: 4)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if quest.type == .daily {
                        BrutalBadge(text: "DAILY", color: NeonBrutalismTheme.electricBlue)
                    }
                    Text(quest.title)
                        .font(NeonBrutalismTheme.bodyFont)
                        .foregroundColor(NeonBrutalismTheme.textPrimary)
                        .lineLimit(1)
                }

                HStack(spacing: 8) {
                    Text("+\(quest.expReward) EXP")
                        .font(NeonBrutalismTheme.captionFont)
                        .foregroundColor(NeonBrutalismTheme.expGreen)

                    if let deadline = quest.deadline {
                        let remaining = deadline.timeIntervalSince(Date())
                        if remaining > 0 {
                            Text(formatCountdown(remaining))
                                .font(NeonBrutalismTheme.captionFont)
                                .foregroundColor(remaining < 3600 ? NeonBrutalismTheme.dangerRed : NeonBrutalismTheme.textSecondary)
                        }
                    }
                }
            }

            Spacer()

            Button(action: { onCompleteQuest?(quest.id) }) {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(NeonBrutalismTheme.expGreen)
                    .frame(width: 28, height: 28)
                    .background(NeonBrutalismTheme.expGreen.opacity(0.12))
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .stroke(NeonBrutalismTheme.expGreen.opacity(0.4), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.white.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(NeonBrutalismTheme.electricBlue.opacity(0.1), lineWidth: 0.5)
        )
    }

    private func completedQuestRow(_ quest: Quest) -> some View {
        HStack {
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(NeonBrutalismTheme.expGreen.opacity(0.5))
                .font(.system(size: 10))
            Text(quest.title)
                .font(NeonBrutalismTheme.captionFont)
                .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.6))
                .strikethrough()
            Spacer()
            Text("+\(quest.expReward)")
                .font(NeonBrutalismTheme.captionFont)
                .foregroundColor(NeonBrutalismTheme.expGreen.opacity(0.4))
        }
        .padding(.vertical, 2)
    }

    private var activeQuests: [Quest] {
        quests.filter { $0.status == .active }
    }

    private var recentCompleted: [Quest] {
        quests.filter { $0.status == .completed }.suffix(3).reversed()
    }

    private func formatCountdown(_ seconds: TimeInterval) -> String {
        let h = Int(seconds) / 3600
        let m = (Int(seconds) % 3600) / 60
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }
}

// MARK: - CategoryBadge (Neon Brutalism)

struct CategoryBadge: View {
    let category: String

    var body: some View {
        Text(displayName)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Self.color(for: category).opacity(0.15))
            .foregroundColor(Self.color(for: category))
            .clipShape(Rectangle())
    }

    private var displayName: String {
        switch category {
        case "coding": return "编程"
        case "writing": return "写作"
        case "learning": return "学习"
        case "browsing": return "浏览"
        case "media": return "媒体"
        case "social": return "社交"
        case "gaming": return "游戏"
        case "work": return "工作"
        case "communication": return "沟通"
        case "design": return "设计"
        case "reading": return "阅读"
        case "research": return "调研"
        case "meeting": return "会议"
        case "idle": return "空闲"
        default: return category
        }
    }

    static func color(for category: String) -> Color {
        switch category {
        case "coding": return .blue
        case "writing": return .purple
        case "learning": return .green
        case "browsing": return .orange
        case "media": return .pink
        case "social": return .cyan
        case "gaming": return .red
        case "work": return .indigo
        case "communication": return .teal
        case "design": return .mint
        case "reading": return .brown
        case "research": return .yellow
        case "meeting": return .gray
        case "idle": return NeonBrutalismTheme.textSecondary
        default: return NeonBrutalismTheme.textSecondary
        }
    }
}
