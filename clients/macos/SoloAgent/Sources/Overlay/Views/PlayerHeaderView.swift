import SwiftUI

/// 玩家状态组件 — 等级、称号、经验条
struct PlayerHeaderView: View {
    let player: Player
    var compact: Bool = false

    var body: some View {
        if compact {
            compactLayout
        } else {
            expandedLayout
        }
    }

    // MARK: - Compact (for mini bar)

    private var compactLayout: some View {
        HStack(spacing: 6) {
            // Level badge
            Text("Lv.\(player.level)")
                .font(HolographicTheme.miniLevelFont)
                .glowText()

            // Exp bar
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.white.opacity(0.1))
                        .frame(height: 6)

                    RoundedRectangle(cornerRadius: 3)
                        .fill(HolographicTheme.expBarGradient)
                        .frame(width: geo.size.width * player.expProgress, height: 6)
                        .shadow(color: HolographicTheme.expGreen.opacity(0.6), radius: 4)
                }
            }
            .frame(height: 6)
        }
    }

    // MARK: - Expanded (for full panel)

    private var expandedLayout: some View {
        VStack(spacing: 8) {
            HStack(alignment: .top) {
                // Level (large glowing)
                VStack(spacing: 2) {
                    Text("Lv.")
                        .font(HolographicTheme.captionFont)
                        .foregroundColor(HolographicTheme.textSecondary)
                    Text("\(player.level)")
                        .font(HolographicTheme.levelFont)
                        .glowText()
                }
                .frame(width: 70)

                VStack(alignment: .leading, spacing: 4) {
                    // Title
                    Text(player.title)
                        .font(HolographicTheme.titleFont)
                        .foregroundColor(HolographicTheme.accentPurple)
                        .shadow(color: HolographicTheme.accentPurple.opacity(0.5), radius: 6)

                    // Name
                    Text(player.name)
                        .font(HolographicTheme.bodyFont)
                        .foregroundColor(HolographicTheme.textSecondary)

                    // Quests completed
                    Text("完成任务: \(player.totalQuestsCompleted)")
                        .font(HolographicTheme.captionFont)
                        .foregroundColor(HolographicTheme.textSecondary)
                }

                Spacer()
            }

            // Exp bar
            VStack(spacing: 2) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.white.opacity(0.08))
                            .frame(height: 10)

                        RoundedRectangle(cornerRadius: 4)
                            .fill(HolographicTheme.expBarGradient)
                            .frame(width: max(0, geo.size.width * player.expProgress), height: 10)
                            .shadow(color: HolographicTheme.expGreen.opacity(0.6), radius: 6)
                    }
                }
                .frame(height: 10)

                HStack {
                    Text("EXP")
                        .font(HolographicTheme.captionFont)
                        .foregroundColor(HolographicTheme.textSecondary)
                    Spacer()
                    Text("\(player.exp) / \(player.expToNext)")
                        .font(HolographicTheme.captionFont)
                        .foregroundColor(HolographicTheme.expGreen)
                }
            }

            // Stats bar (mini)
            HStack(spacing: 12) {
                statPill("专注", value: player.stats.focus)
                statPill("效率", value: player.stats.productivity)
                statPill("毅力", value: player.stats.consistency)
                statPill("创造", value: player.stats.creativity)
                statPill("健康", value: player.stats.wellness)
            }
            .padding(.top, 4)
        }
    }

    private func statPill(_ label: String, value: Int) -> some View {
        VStack(spacing: 1) {
            Text("\(value)")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundColor(HolographicTheme.textPrimary)
            Text(label)
                .font(.system(size: 8, design: .monospaced))
                .foregroundColor(HolographicTheme.textSecondary)
        }
    }
}
