import SwiftUI

/// 完整全息面板 (~500x700) — ⌘⇧S 切换
struct FullOverlayView: View {
    @ObservedObject var agentManager: AgentManager
    var onClose: (() -> Void)?

    var body: some View {
        ZStack {
            // Panel content
            VStack(spacing: 0) {
                // Title bar
                titleBar
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 8)

                Divider()
                    .background(HolographicTheme.primaryBlue.opacity(0.3))

                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 16) {
                        // Player header
                        PlayerHeaderView(player: agentManager.player, compact: false)
                            .padding(.horizontal, 16)
                            .padding(.top, 12)

                        Divider()
                            .background(HolographicTheme.primaryBlue.opacity(0.2))
                            .padding(.horizontal, 16)

                        // Activity feed (系统日志)
                        ActivityFeedView(activityFeed: agentManager.activityFeed)
                            .padding(.horizontal, 16)

                        Divider()
                            .background(HolographicTheme.primaryBlue.opacity(0.2))
                            .padding(.horizontal, 16)

                        // Quest list
                        QuestListView(
                            quests: agentManager.activeQuests,
                            onComplete: { questId in
                                _ = agentManager.questEngine?.completeQuest(questId)
                            }
                        )
                        .padding(.horizontal, 16)

                        // Active buffs
                        if !agentManager.player.activeBuffs.isEmpty {
                            Divider()
                                .background(HolographicTheme.primaryBlue.opacity(0.2))
                                .padding(.horizontal, 16)

                            buffSection
                                .padding(.horizontal, 16)
                        }

                        // Status info
                        Divider()
                            .background(HolographicTheme.primaryBlue.opacity(0.2))
                            .padding(.horizontal, 16)

                        statusSection
                            .padding(.horizontal, 16)
                            .padding(.bottom, 16)
                    }
                }
            }

            // Scanline overlay
            ScanlineOverlay()
                .allowsHitTesting(false)
        }
        .frame(width: HolographicTheme.fullPanelSize.width,
               height: HolographicTheme.fullPanelSize.height)
        .holographicPanel()
    }

    // MARK: - Title Bar

    private var titleBar: some View {
        HStack {
            HStack(spacing: 6) {
                Circle()
                    .fill(HolographicTheme.primaryBlue)
                    .frame(width: 8, height: 8)
                    .pulse()

                Text("SOLO LEVELING SYSTEM")
                    .font(HolographicTheme.titleFont)
                    .glowText()
            }

            Spacer()

            // Close button
            Button(action: { onClose?() }) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(HolographicTheme.textSecondary)
                    .frame(width: 20, height: 20)
                    .background(Circle().fill(Color.white.opacity(0.05)))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Buff Section

    private var buffSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("「 活跃效果 」")
                .font(HolographicTheme.titleFont)
                .glowText(color: HolographicTheme.accentPurple)

            ForEach(agentManager.player.activeBuffs) { buff in
                HStack(spacing: 8) {
                    Circle()
                        .fill(buff.isDebuff ? HolographicTheme.dangerRed : HolographicTheme.accentPurple)
                        .frame(width: 8, height: 8)
                        .shadow(color: buff.isDebuff ? HolographicTheme.dangerRed : HolographicTheme.accentPurple, radius: 4)

                    Text(buff.name)
                        .font(HolographicTheme.bodyFont)
                        .foregroundColor(buff.isDebuff ? HolographicTheme.dangerRed : HolographicTheme.textPrimary)

                    Spacer()

                    if let expiresAt = buff.expiresAt {
                        let remaining = expiresAt.timeIntervalSince(Date())
                        if remaining > 0 {
                            Text("\(Int(remaining / 60))m")
                                .font(HolographicTheme.captionFont)
                                .foregroundColor(HolographicTheme.textSecondary)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Status Section

    private var statusSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("「 系统状态 」")
                .font(HolographicTheme.titleFont)
                .glowText(color: HolographicTheme.accentPurple)

            HStack(spacing: 16) {
                statusItem(label: "捕捉", value: "\(agentManager.captureCount)", icon: "camera.fill")
                statusItem(label: "模式", value: "本地",
                          icon: "desktopcomputer",
                          color: HolographicTheme.expGreen)
                statusItem(label: "设备", value: String(agentManager.deviceId.suffix(8)), icon: "desktopcomputer")
            }
        }
    }

    private func statusItem(label: String, value: String, icon: String, color: Color = HolographicTheme.textPrimary) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9))
                .foregroundColor(HolographicTheme.textSecondary)
            VStack(alignment: .leading, spacing: 0) {
                Text(value)
                    .font(HolographicTheme.captionFont)
                    .foregroundColor(color)
                Text(label)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundColor(HolographicTheme.textSecondary)
            }
        }
    }
}
