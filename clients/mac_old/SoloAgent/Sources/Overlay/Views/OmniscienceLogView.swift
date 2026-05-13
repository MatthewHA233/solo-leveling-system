import SwiftUI
import AppKit/// 右栏 — 系统日志实时流
struct OmniscienceLogView: View {
    @ObservedObject var activityFeed: ActivityFeed
    var isCapturing: Bool = false

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 6) {
                Text("系统日志")
                    .font(NeonBrutalismTheme.sectionHeaderFont)
                    .foregroundColor(NeonBrutalismTheme.textSecondary)

                Spacer()

                // REC indicator
                if isCapturing {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(NeonBrutalismTheme.dangerRed)
                            .frame(width: 6, height: 6)
                            .neonPulse()
                        Text("录制中")
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                            .foregroundColor(NeonBrutalismTheme.dangerRed)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            NeonDivider(.horizontal)

            // Log stream
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(activityFeed.items) { item in
                            logRow(item)
                                .id(item.id)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .onChange(of: activityFeed.items.count) {
                    if let lastId = activityFeed.items.last?.id {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(lastId, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Log Row

    private func logRow(_ item: ActivityFeedItem) -> some View {
        LogRowView(item: item, colorForItem: colorForItem(item))
    }

    // MARK: - Color Mapping

    private func colorForItem(_ item: ActivityFeedItem) -> Color {
        switch item.type {
        case .capture:  return NeonBrutalismTheme.electricBlue
        case .exp:      return NeonBrutalismTheme.expGreen
        case .quest:    return NeonBrutalismTheme.shadowPurple
        case .levelUp:  return NeonBrutalismTheme.warningOrange
        case .buff:     return NeonBrutalismTheme.shadowPurple
        case .system:   return NeonBrutalismTheme.textSecondary
        case .ai:       return Color(red: 0.0, green: 0.85, blue: 0.85)
        }
    }
}

/// 独立的 Log Row 视图，以管理自身的 Hover 状态
struct LogRowView: View {
    let item: ActivityFeedItem
    let colorForItem: Color
    
    @State private var isHovered = false
    
    // 提取时间格式化到独立的静态实例避免冲突
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()
    
    var body: some View {
        HStack(spacing: 4) {
            // Timestamp
            Text(Self.timeFormatter.string(from: item.timestamp))
                .font(.system(size: 9, weight: .regular, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.6))

            // Type dot
            Circle()
                .fill(colorForItem)
                .frame(width: 4, height: 4)
                .shadow(color: colorForItem.opacity(0.8), radius: 3)

            // Icon
            Image(systemName: item.icon)
                .font(.system(size: 8))
                .foregroundColor(colorForItem)
                .frame(width: 12)

            // Title
            Text(item.title)
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textPrimary)
                .lineLimit(1)

            Spacer(minLength: 2)

            // EXP badge
            if item.expAmount > 0 {
                Text("+\(item.expAmount)")
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.expGreen)
                    .shadow(color: NeonBrutalismTheme.expGreen.opacity(0.5), radius: 2)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color.white.opacity(isHovered ? 0.05 : 0))
        )
        // 微交互：轻微上移 (位移)，增加反馈
        .offset(y: isHovered ? -1 : 0)
        .animation(.spring(response: 0.3, dampingFraction: 0.6), value: isHovered)
        .onHover { hovering in
            isHovered = hovering
        }
    }
}

private struct OmniscienceLogPreviewWrapper: View {
    var body: some View {
        let feed = ActivityFeed()
        let _ = {
            feed.push(ActivityFeedItem(type: .capture, icon: "camera.fill", title: "Cursor | coding", expAmount: 0))
            feed.push(ActivityFeedItem(type: .exp, icon: "star.fill", title: "专注编程", expAmount: 4))
            feed.push(ActivityFeedItem(type: .quest, icon: "flag.fill", title: "新任务：昼夜表设计"))
            feed.push(ActivityFeedItem(type: .ai, icon: "brain", title: "AI 分析完成", expAmount: 10))
            feed.push(ActivityFeedItem(type: .system, icon: "gear", title: "系统同步完成"))
        }()

        OmniscienceLogView(activityFeed: feed, isCapturing: true)
            .background(
                ZStack {
                    VisualEffectBackground(material: NSVisualEffectView.Material.sidebar, blendingMode: NSVisualEffectView.BlendingMode.behindWindow, state: NSVisualEffectView.State.active)
                    NeonBrutalismTheme.background.opacity(0.85)
                }
            )
    }
}

#Preview("右栏 - 系统日志") {
    OmniscienceLogPreviewWrapper()
}
