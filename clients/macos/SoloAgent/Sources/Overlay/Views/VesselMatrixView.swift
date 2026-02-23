import SwiftUI

/// 左栏 — 玩家等级、经验、属性、Buff
struct VesselMatrixView: View {
    let player: Player
    let buffs: [ActiveBuff]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Section header
            Text("THE VESSEL")
                .font(NeonBrutalismTheme.sectionHeaderFont)
                .foregroundColor(NeonBrutalismTheme.textSecondary)
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 8)

            NeonDivider(.horizontal)

            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 14) {
                    // Player level + title (参照旧版 PlayerHeaderView expanded)
                    playerSection

                    // EXP bar
                    expSection

                    NeonDivider(.horizontal)
                        .padding(.horizontal, 14)

                    // Stats
                    statsSection

                    // Buffs
                    if !buffs.isEmpty {
                        NeonDivider(.horizontal)
                            .padding(.horizontal, 14)
                        buffSection
                    }
                }
                .padding(.vertical, 12)
            }
        }
        .frame(width: NeonBrutalismTheme.leftColumnWidth)
    }

    // MARK: - Player

    private var playerSection: some View {
        HStack(alignment: .top, spacing: 8) {
            // Level (大号发光数字)
            VStack(spacing: 2) {
                Text("Lv.")
                    .font(NeonBrutalismTheme.captionFont)
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                Text("\(player.level)")
                    .font(NeonBrutalismTheme.levelFont)
                    .brutalGlow()
            }
            .frame(width: 60)

            VStack(alignment: .leading, spacing: 4) {
                // Title
                Text(player.title)
                    .font(NeonBrutalismTheme.titleFont)
                    .foregroundColor(NeonBrutalismTheme.shadowPurple)
                    .shadow(color: NeonBrutalismTheme.shadowPurple.opacity(0.6), radius: 6)

                // Name
                Text(player.name)
                    .font(NeonBrutalismTheme.bodyFont)
                    .foregroundColor(NeonBrutalismTheme.textSecondary)

                // Quests completed
                Text("完成: \(player.totalQuestsCompleted)")
                    .font(NeonBrutalismTheme.captionFont)
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
    }

    // MARK: - EXP

    private var expSection: some View {
        VStack(spacing: 3) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.white.opacity(0.08))
                        .frame(height: 10)

                    RoundedRectangle(cornerRadius: 4)
                        .fill(NeonBrutalismTheme.expBarGradient)
                        .frame(width: max(0, geo.size.width * player.expProgress), height: 10)
                        .shadow(color: NeonBrutalismTheme.expGreen.opacity(0.6), radius: 6)
                }
            }
            .frame(height: 10)

            HStack {
                Text("EXP")
                    .font(NeonBrutalismTheme.captionFont)
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                Spacer()
                Text("\(player.exp) / \(player.expToNext)")
                    .font(NeonBrutalismTheme.captionFont)
                    .foregroundColor(NeonBrutalismTheme.expGreen)
                    .shadow(color: NeonBrutalismTheme.expGreen.opacity(0.4), radius: 3)
            }
        }
        .padding(.horizontal, 14)
    }

    // MARK: - Stats

    private var statsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("STATS")
                .font(NeonBrutalismTheme.sectionHeaderFont)
                .foregroundColor(NeonBrutalismTheme.textSecondary)

            statRow("专注", value: player.stats.focus)
            statRow("效率", value: player.stats.productivity)
            statRow("毅力", value: player.stats.consistency)
            statRow("创造", value: player.stats.creativity)
            statRow("健康", value: player.stats.wellness)
        }
        .padding(.horizontal, 14)
    }

    private func statRow(_ label: String, value: Int) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(NeonBrutalismTheme.captionFont)
                .foregroundColor(NeonBrutalismTheme.textSecondary)
                .frame(width: 28, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.white.opacity(0.06))
                    RoundedRectangle(cornerRadius: 2)
                        .fill(NeonBrutalismTheme.electricBlue.opacity(0.6))
                        .frame(width: max(0, geo.size.width * CGFloat(value) / 100.0))
                        .shadow(color: NeonBrutalismTheme.electricBlue.opacity(0.3), radius: 3)
                }
            }
            .frame(height: 4)

            Text("\(value)")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textPrimary)
                .frame(width: 22, alignment: .trailing)
        }
    }

    // MARK: - Buffs

    private var buffSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("BUFFS")
                .font(NeonBrutalismTheme.sectionHeaderFont)
                .foregroundColor(NeonBrutalismTheme.textSecondary)

            ForEach(buffs) { buff in
                HStack(spacing: 6) {
                    Circle()
                        .fill(buff.isDebuff ? NeonBrutalismTheme.dangerRed : NeonBrutalismTheme.shadowPurple)
                        .frame(width: 8, height: 8)
                        .shadow(color: (buff.isDebuff ? NeonBrutalismTheme.dangerRed : NeonBrutalismTheme.shadowPurple).opacity(0.7), radius: 4)

                    Text(buff.name)
                        .font(NeonBrutalismTheme.captionFont)
                        .foregroundColor(buff.isDebuff ? NeonBrutalismTheme.dangerRed : NeonBrutalismTheme.textPrimary)
                        .lineLimit(1)

                    Spacer(minLength: 2)

                    if let expiresAt = buff.expiresAt {
                        let remaining = expiresAt.timeIntervalSince(Date())
                        if remaining > 0 {
                            Text("\(Int(remaining / 60))m")
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundColor(NeonBrutalismTheme.textSecondary)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 14)
    }
}
