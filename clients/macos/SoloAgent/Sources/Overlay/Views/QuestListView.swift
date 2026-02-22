import SwiftUI

/// 任务列表面板 — 难度徽章、标题、奖励、倒计时、完成按钮
struct QuestListView: View {
    let quests: [Quest]
    var onComplete: ((String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Section header
            HStack {
                Text("「 任务列表 」")
                    .font(HolographicTheme.titleFont)
                    .glowText()
                Spacer()
                Text("\(activeQuests.count) 进行中")
                    .font(HolographicTheme.captionFont)
                    .foregroundColor(HolographicTheme.textSecondary)
            }
            .padding(.bottom, 4)

            if activeQuests.isEmpty {
                Text("暂无活跃任务")
                    .font(HolographicTheme.bodyFont)
                    .foregroundColor(HolographicTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
            } else {
                ForEach(activeQuests) { quest in
                    QuestRowView(quest: quest, onComplete: onComplete)
                }
            }

            // Show recent completed
            let completed = recentCompleted
            if !completed.isEmpty {
                Divider()
                    .background(HolographicTheme.primaryBlue.opacity(0.3))
                Text("最近完成")
                    .font(HolographicTheme.captionFont)
                    .foregroundColor(HolographicTheme.textSecondary)
                    .padding(.top, 2)

                ForEach(completed) { quest in
                    completedRow(quest)
                }
            }
        }
    }

    private var activeQuests: [Quest] {
        quests.filter { $0.status == .active }
    }

    private var recentCompleted: [Quest] {
        quests.filter { $0.status == .completed }.suffix(3).reversed()
    }

    private func completedRow(_ quest: Quest) -> some View {
        HStack {
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(HolographicTheme.expGreen.opacity(0.6))
                .font(.system(size: 10))
            Text(quest.title)
                .font(HolographicTheme.captionFont)
                .foregroundColor(HolographicTheme.textSecondary.opacity(0.6))
                .strikethrough()
            Spacer()
            Text("+\(quest.expReward)")
                .font(HolographicTheme.captionFont)
                .foregroundColor(HolographicTheme.expGreen.opacity(0.5))
        }
        .padding(.vertical, 1)
    }
}

// MARK: - Quest Row

struct QuestRowView: View {
    let quest: Quest
    var onComplete: ((String) -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            // Difficulty badge
            Text(quest.difficulty.rawValue)
                .font(.system(size: 11, weight: .heavy, design: .monospaced))
                .foregroundColor(.white)
                .frame(width: 22, height: 22)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(HolographicTheme.difficultyColor(quest.difficulty))
                )
                .shadow(color: HolographicTheme.difficultyColor(quest.difficulty).opacity(0.5), radius: 4)

            // Quest info
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if quest.type == .daily {
                        Text("每日")
                            .font(.system(size: 8, weight: .medium, design: .monospaced))
                            .foregroundColor(HolographicTheme.primaryBlue)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(HolographicTheme.primaryBlue.opacity(0.15))
                            .clipShape(RoundedRectangle(cornerRadius: 2))
                    }
                    Text(quest.title)
                        .font(HolographicTheme.bodyFont)
                        .foregroundColor(HolographicTheme.textPrimary)
                        .lineLimit(1)
                }

                HStack(spacing: 8) {
                    // Reward
                    Text("+\(quest.expReward) EXP")
                        .font(HolographicTheme.captionFont)
                        .foregroundColor(HolographicTheme.expGreen)

                    // Countdown
                    if let deadline = quest.deadline {
                        let remaining = deadline.timeIntervalSince(Date())
                        if remaining > 0 {
                            Text(formatCountdown(remaining))
                                .font(HolographicTheme.captionFont)
                                .foregroundColor(remaining < 3600 ? HolographicTheme.dangerRed : HolographicTheme.textSecondary)
                        }
                    }
                }
            }

            Spacer()

            // Complete button
            Button(action: {
                onComplete?(quest.id)
            }) {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(HolographicTheme.expGreen)
                    .frame(width: 28, height: 28)
                    .background(
                        Circle()
                            .fill(HolographicTheme.expGreen.opacity(0.15))
                    )
                    .overlay(
                        Circle()
                            .stroke(HolographicTheme.expGreen.opacity(0.4), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.white.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(HolographicTheme.primaryBlue.opacity(0.1), lineWidth: 0.5)
        )
    }

    private func formatCountdown(_ seconds: TimeInterval) -> String {
        let h = Int(seconds) / 3600
        let m = (Int(seconds) % 3600) / 60
        if h > 0 { return "剩余 \(h)h \(m)m" }
        return "剩余 \(m)m"
    }
}
