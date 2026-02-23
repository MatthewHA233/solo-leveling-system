import SwiftUI

/// 右栏 — 系统日志实时流
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
                Text("SYSTEM.LOG")
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
                        Text("REC")
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
        .frame(width: NeonBrutalismTheme.rightColumnWidth)
    }

    // MARK: - Log Row

    private func logRow(_ item: ActivityFeedItem) -> some View {
        HStack(spacing: 4) {
            // Timestamp
            Text(Self.timeFormatter.string(from: item.timestamp))
                .font(.system(size: 9, weight: .regular, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.6))

            // Type dot
            Circle()
                .fill(colorForItem(item))
                .frame(width: 4, height: 4)
                .shadow(color: colorForItem(item).opacity(0.8), radius: 3)

            // Icon
            Image(systemName: item.icon)
                .font(.system(size: 8))
                .foregroundColor(colorForItem(item))
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
        .padding(.vertical, 2)
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
