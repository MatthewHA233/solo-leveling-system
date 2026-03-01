import SwiftUI
import AppKit
import AVFoundation

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
    @State private var selectedBatchId: String?
    @State private var selectedDate: Date = Date()
    @State private var isChartExpanded: Bool = false
    @State private var sidebarTab: SidebarTab = .status
    @State private var isVideoExpanded: Bool = false
    @State private var batchPlayer: AVPlayer?

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

                // Center: DayNightChart or Expanded Video
                if isVideoExpanded, let player = batchPlayer {
                    ExpandedVideoPlayerView(
                        player: player,
                        batchId: selectedBatchId ?? "",
                        onCollapse: {
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                isVideoExpanded = false
                            }
                        }
                    )
                    .transition(.scale(scale: 0.3, anchor: .trailing).combined(with: .opacity))
                } else {
                    DayNightChartView(
                        selectedBatchId: $selectedBatchId,
                        selectedDate: $selectedDate,
                        isExpanded: $isChartExpanded
                    )
                    .environmentObject(agentManager)
                    .transition(.opacity)
                }

                NeonDivider(.vertical)

                // Right column
                rightColumn
                    .frame(width: 280)
            }
        }
        .background(
            ZStack {
                VisualEffectBackground(material: NSVisualEffectView.Material.hudWindow, blendingMode: NSVisualEffectView.BlendingMode.behindWindow, state: NSVisualEffectView.State.active)
                NeonBrutalismTheme.background.opacity(0.85)
            }
        )
        .overlay(NoiseOverlay().allowsHitTesting(false))
        .overlay(NeonScanlineOverlay().allowsHitTesting(false))
        .animation(.easeInOut(duration: 0.3), value: isChartExpanded)
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: isVideoExpanded)
        .onChange(of: selectedBatchId) { _ in
            setupBatchPlayer()
        }
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

            // 日期导航
            HStack(spacing: 6) {
                Button(action: {
                    selectedDate = Calendar.current.date(byAdding: .day, value: -1, to: selectedDate) ?? selectedDate
                }) {
                    Text("\u{25C0}")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                        .frame(width: 22, height: 18)
                        .background(NeonBrutalismTheme.electricBlue.opacity(0.08))
                        .cornerRadius(3)
                }
                .buttonStyle(.plain)

                Text(DayNightChartView.dateString(selectedDate))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)

                Button(action: {
                    let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: selectedDate) ?? selectedDate
                    if tomorrow <= Date() { selectedDate = tomorrow }
                }) {
                    Text("\u{25B6}")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundColor(
                            Calendar.current.isDateInToday(selectedDate)
                                ? NeonBrutalismTheme.textSecondary.opacity(0.3)
                                : NeonBrutalismTheme.electricBlue
                        )
                        .frame(width: 22, height: 18)
                        .background(NeonBrutalismTheme.electricBlue.opacity(0.08))
                        .cornerRadius(3)
                }
                .buttonStyle(.plain)
                .disabled(Calendar.current.isDateInToday(selectedDate))

                Button(action: { selectedDate = Date() }) {
                    Text("今")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundColor(
                            Calendar.current.isDateInToday(selectedDate)
                                ? NeonBrutalismTheme.textSecondary.opacity(0.3)
                                : NeonBrutalismTheme.electricBlue
                        )
                        .frame(width: 22, height: 18)
                        .background(NeonBrutalismTheme.electricBlue.opacity(0.08))
                        .cornerRadius(3)
                }
                .buttonStyle(.plain)
                .disabled(Calendar.current.isDateInToday(selectedDate))
            }

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
                    .buttonStyle(NeonMagneticButtonStyle())
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
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    // MARK: - Right Column

    @ViewBuilder
    private var rightColumn: some View {
        if let batchId = selectedBatchId {
            BatchDetailView(
                batchId: batchId,
                selectedDate: selectedDate,
                player: batchPlayer,
                onVideoTap: {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        isVideoExpanded.toggle()
                    }
                },
                onSeekToTime: { timeStr in
                    seekPlayerToTime(timeStr)
                },
                onClose: {
                    isVideoExpanded = false
                    selectedBatchId = nil
                }
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

    // MARK: - Batch Player

    private func setupBatchPlayer() {
        isVideoExpanded = false
        guard let batchId = selectedBatchId,
              let batch = agentManager.persistence.batchRecord(for: batchId),
              let path = batch.videoPath,
              FileManager.default.fileExists(atPath: path) else {
            batchPlayer = nil
            return
        }
        batchPlayer = AVPlayer(url: URL(fileURLWithPath: path))
    }

    private func seekPlayerToTime(_ timeStr: String) {
        guard let batchId = selectedBatchId,
              let batch = agentManager.persistence.batchRecord(for: batchId),
              let player = batchPlayer else { return }

        // Parse "HH:mm" → Unix timestamp for selectedDate
        let parts = timeStr.split(separator: ":")
        guard parts.count == 2,
              let hour = Int(parts[0]),
              let minute = Int(parts[1]) else { return }

        let cal = Calendar.current
        var comps = cal.dateComponents([.year, .month, .day], from: selectedDate)
        comps.hour = hour
        comps.minute = minute
        comps.second = 0
        guard let targetDate = cal.date(from: comps) else { return }
        let targetTs = targetDate.timeIntervalSince1970

        let batchStart = Double(batch.startTs)
        let batchEnd = Double(batch.endTs)
        guard batchEnd > batchStart else { return }

        let ratio = max(0, min(1, (targetTs - batchStart) / (batchEnd - batchStart)))

        // Get video duration and seek
        let duration = player.currentItem?.duration ?? .zero
        guard duration.isNumeric, duration.seconds > 0 else { return }

        let seekSeconds = ratio * duration.seconds
        let seekTime = CMTime(seconds: seekSeconds, preferredTimescale: 600)
        player.seek(to: seekTime, toleranceBefore: .zero, toleranceAfter: .zero)
        player.play()

        // Auto-expand if not already
        if !isVideoExpanded {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                isVideoExpanded = true
            }
        }
    }
}
