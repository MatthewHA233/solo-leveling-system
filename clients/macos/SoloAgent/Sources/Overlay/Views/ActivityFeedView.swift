import SwiftUI

/// 系统日志 — 全息风格实时活动信息流
struct ActivityFeedView: View {
    @ObservedObject var activityFeed: ActivityFeed

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Section header
            Text("「 系统日志 」")
                .font(HolographicTheme.titleFont)
                .glowText(color: HolographicTheme.primaryBlue)

            // Scrolling feed
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(activityFeed.items) { item in
                            feedRow(item)
                                .id(item.id)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .frame(height: 180)
                .onChange(of: activityFeed.items.count) {
                    if let lastId = activityFeed.items.last?.id {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(lastId, anchor: .bottom)
                        }
                    }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.black.opacity(0.3))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(HolographicTheme.primaryBlue.opacity(0.15), lineWidth: 0.5)
            )
        }
    }

    // MARK: - Feed Row

    private func feedRow(_ item: ActivityFeedItem) -> some View {
        HStack(spacing: 6) {
            // Timestamp
            Text(Self.timeFormatter.string(from: item.timestamp))
                .font(.system(size: 9, weight: .regular, design: .monospaced))
                .foregroundColor(HolographicTheme.textSecondary.opacity(0.7))

            // Type indicator dot
            Circle()
                .fill(colorForItem(item))
                .frame(width: 4, height: 4)
                .shadow(color: colorForItem(item).opacity(0.8), radius: 3)

            // Icon
            Image(systemName: item.icon)
                .font(.system(size: 9))
                .foregroundColor(colorForItem(item))
                .frame(width: 14)

            // Title
            Text(item.title)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundColor(HolographicTheme.textPrimary)
                .lineLimit(1)

            Spacer(minLength: 2)

            // EXP badge
            if item.expAmount > 0 {
                Text("+\(item.expAmount)")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundColor(HolographicTheme.expGreen)
                    .shadow(color: HolographicTheme.expGreen.opacity(0.6), radius: 2)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
    }

    // MARK: - Color Mapping

    private func colorForItem(_ item: ActivityFeedItem) -> Color {
        switch item.type {
        case .capture:  return HolographicTheme.primaryBlue
        case .exp:      return HolographicTheme.expGreen
        case .quest:    return HolographicTheme.accentPurple
        case .levelUp:  return HolographicTheme.warningOrange
        case .buff:     return HolographicTheme.accentPurple
        case .system:   return HolographicTheme.textSecondary
        case .ai:       return Color(red: 0.0, green: 0.85, blue: 0.85)  // cyan
        }
    }
}
