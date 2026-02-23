import SwiftUI

/// 统一三栏浮动面板 (1100x700) — 替代 FullOverlayView
struct UnifiedSystemView: View {
    @ObservedObject var agentManager: AgentManager
    var onClose: (() -> Void)?

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                // Title bar
                titleBar
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)

                NeonDivider(.horizontal)

                // Three columns
                HStack(spacing: 0) {
                    // Left: Player status
                    VesselMatrixView(
                        player: agentManager.player,
                        buffs: agentManager.player.activeBuffs
                    )

                    NeonDivider(.vertical)

                    // Center: Directives + Timeline
                    DirectivesHubView(
                        agentManager: agentManager,
                        quests: agentManager.activeQuests,
                        onCompleteQuest: { questId in
                            _ = agentManager.questEngine?.completeQuest(questId)
                        }
                    )

                    NeonDivider(.vertical)

                    // Right: System log
                    OmniscienceLogView(
                        activityFeed: agentManager.activityFeed,
                        isCapturing: agentManager.isCapturing
                    )
                }
            }

            // CRT scanline overlay
            NeonScanlineOverlay()
                .allowsHitTesting(false)
        }
        .frame(
            width: panelWidth,
            height: panelHeight
        )
        .brutalPanel()
    }

    // MARK: - Safe Panel Size

    private var panelWidth: CGFloat {
        let screen = NSScreen.main ?? NSScreen.screens.first
        let maxW = (screen?.visibleFrame.width ?? 1200) - 40
        return min(NeonBrutalismTheme.fullPanelSize.width, maxW)
    }

    private var panelHeight: CGFloat {
        let screen = NSScreen.main ?? NSScreen.screens.first
        let maxH = (screen?.visibleFrame.height ?? 800) - 40
        return min(NeonBrutalismTheme.fullPanelSize.height, maxH)
    }

    // MARK: - Title Bar

    private var titleBar: some View {
        HStack {
            HStack(spacing: 6) {
                Circle()
                    .fill(NeonBrutalismTheme.electricBlue)
                    .frame(width: 8, height: 8)
                    .neonPulse()

                Text("SHADOW MONARCH SYSTEM")
                    .font(NeonBrutalismTheme.titleFont)
                    .brutalGlow()
            }

            Spacer()

            // Close button
            Button(action: { onClose?() }) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                    .frame(width: 22, height: 22)
                    .background(Color.white.opacity(0.04))
                    .clipShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}
