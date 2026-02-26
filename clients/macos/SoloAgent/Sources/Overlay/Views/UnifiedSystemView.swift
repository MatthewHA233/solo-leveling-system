import SwiftUI

/// 全域网监控 — 标准 macOS 窗口
/// 收起: 左侧栏(VesselMatrix+Directives) + 昼夜表(当前附近列) + 右栏(日志/详情)
/// 展开: 左侧栏隐藏, 昼夜表铺满24列 + 右栏
struct UnifiedSystemView: View {
    enum SidebarTab: String, CaseIterable {
        case status, directives, settings
        var icon: String {
            switch self {
            case .status: return "gamecontroller"
            case .directives: return "list.bullet.clipboard"
            case .settings: return "gearshape"
            }
        }
    }

    @EnvironmentObject var agentManager: AgentManager
    @State private var selectedCell: CellKey?
    @State private var selectedDate: Date = Date()
    @State private var isChartExpanded: Bool = false
    @State private var sidebarTab: SidebarTab = .status

    var body: some View {
        VStack(spacing: 0) {
            // Title bar
            titleBar
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

            NeonDivider(.horizontal)

            // Main area
            HStack(spacing: 0) {
                // Left sidebar — only when collapsed
                if !isChartExpanded {
                    leftSidebar
                        .frame(width: 220)
                        .transition(.move(edge: .leading).combined(with: .opacity))

                    // Sidebar collapse handle
                    sidebarHandle(expand: true)
                } else {
                    // Sidebar expand handle (narrow strip)
                    sidebarHandle(expand: false)
                }

                // Center: DayNightChart
                DayNightChartView(
                    selectedCell: $selectedCell,
                    isExpanded: $isChartExpanded
                )
                .environmentObject(agentManager)

                NeonDivider(.vertical)

                // Right column
                rightColumn
                    .frame(width: 280)
            }
        }
        .background(NeonBrutalismTheme.background)
        .overlay(NeonScanlineOverlay().allowsHitTesting(false))
        .animation(.easeInOut(duration: 0.3), value: isChartExpanded)
    }

    // MARK: - Title Bar

    private var titleBar: some View {
        HStack {
            HStack(spacing: 6) {
                Circle()
                    .fill(NeonBrutalismTheme.electricBlue)
                    .frame(width: 8, height: 8)
                    .neonPulse()

                Text("暗影君主系统")
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

    // MARK: - Left Sidebar

    private var leftSidebar: some View {
        VStack(spacing: 0) {
            // Tab bar
            HStack(spacing: 0) {
                ForEach(SidebarTab.allCases, id: \.self) { tab in
                    Button(action: { sidebarTab = tab }) {
                        Image(systemName: tab.icon)
                            .font(.system(size: 11))
                            .foregroundColor(
                                sidebarTab == tab
                                    ? NeonBrutalismTheme.electricBlue
                                    : NeonBrutalismTheme.textSecondary
                            )
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 7)
                            .background(
                                sidebarTab == tab
                                    ? NeonBrutalismTheme.electricBlue.opacity(0.08)
                                    : Color.clear
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .overlay(alignment: .bottom) {
                NeonDivider(.horizontal)
            }

            // Tab content
            switch sidebarTab {
            case .status:
                VesselMatrixView(
                    player: agentManager.player,
                    buffs: agentManager.player.activeBuffs
                )

            case .directives:
                DirectivesHubView(
                    agentManager: agentManager,
                    quests: agentManager.activeQuests,
                    onCompleteQuest: { questId in
                        _ = agentManager.questEngine?.completeQuest(questId)
                    }
                )

            case .settings:
                SidebarSettingsView()
                    .environmentObject(agentManager)
            }
        }
    }

    // MARK: - Sidebar Handle

    private func sidebarHandle(expand: Bool) -> some View {
        Button(action: { isChartExpanded.toggle() }) {
            VStack(spacing: 6) {
                Spacer()
                Image(systemName: expand ? "chevron.compact.left" : "chevron.compact.right")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(NeonBrutalismTheme.electricBlue.opacity(0.5))
                if !expand {
                    Text("状态")
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.electricBlue.opacity(0.3))
                        .rotationEffect(.degrees(-90))
                        .fixedSize()
                }
                Spacer()
            }
            .frame(width: expand ? 16 : 24)
            .contentShape(Rectangle())
            .background(
                NeonBrutalismTheme.electricBlue.opacity(0.03)
            )
            .overlay(
                Rectangle()
                    .fill(NeonBrutalismTheme.electricBlue.opacity(0.08))
                    .frame(width: 1),
                alignment: expand ? .trailing : .leading
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                NSCursor.resizeLeftRight.push()
            } else {
                NSCursor.pop()
            }
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
