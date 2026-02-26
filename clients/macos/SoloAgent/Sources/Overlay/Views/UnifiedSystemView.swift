import SwiftUI

/// 全域网监控 — 标准 macOS 窗口
/// 布局: 上方标题栏 + 中间(左昼夜表 / 右日志或详情) + 下方(VesselMatrix + Directives)
struct UnifiedSystemView: View {
    @EnvironmentObject var agentManager: AgentManager
    @State private var selectedCell: CellKey?
    @State private var selectedDate: Date = Date()

    var body: some View {
        VStack(spacing: 0) {
            // Title bar + legend
            titleBar
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

            NeonDivider(.horizontal)

            // Main content: chart + right column
            HStack(spacing: 0) {
                // Left: DayNightChart (主区域)
                DayNightChartView(selectedCell: $selectedCell)
                    .environmentObject(agentManager)

                NeonDivider(.vertical)

                // Right column (280px): CellDetail or OmniscienceLog
                rightColumn
                    .frame(width: 280)
            }

            NeonDivider(.horizontal)

            // Bottom row: VesselMatrix + Directives
            HStack(spacing: 0) {
                VesselMatrixView(
                    player: agentManager.player,
                    buffs: agentManager.player.activeBuffs
                )
                .frame(width: 220)

                NeonDivider(.vertical)

                DirectivesHubView(
                    agentManager: agentManager,
                    quests: agentManager.activeQuests,
                    onCompleteQuest: { questId in
                        _ = agentManager.questEngine?.completeQuest(questId)
                    }
                )
            }
            .frame(height: 180)
        }
        .background(NeonBrutalismTheme.background)
        .overlay(NeonScanlineOverlay().allowsHitTesting(false))
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

            Text("\u{00B7}")
                .foregroundColor(NeonBrutalismTheme.textSecondary)

            Text(DayNightChartView.dateString(selectedDate))
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textSecondary)

            Spacer()
        }
    }

    // MARK: - Right Column

    @ViewBuilder
    private var rightColumn: some View {
        if let cell = selectedCell {
            ChronosCellDetailView(
                col: cell.col,
                row: cell.row,
                selectedDate: selectedDate,
                onClose: { selectedCell = nil }
            )
            .environmentObject(agentManager)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        } else {
            OmniscienceLogView(
                activityFeed: agentManager.activityFeed,
                isCapturing: agentManager.isCapturing
            )
            .transition(.opacity)
        }
    }
}
