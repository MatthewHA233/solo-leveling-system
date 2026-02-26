import SwiftUI

/// 单元格详情面板 — 从 DayNightChartView 提取
/// 显示选中 5 分钟时间格的逐分钟时间线 + 视频预览
struct ChronosCellDetailView: View {
    let col: Int
    let row: Int
    let selectedDate: Date
    @EnvironmentObject var agent: AgentManager
    var onClose: () -> Void

    private var startMin: Int { col * 60 + row * 5 }
    private var endMin: Int { startMin + 5 }
    private var timeRange: String {
        "\(Self.fmt(startMin)) \u{2013} \(Self.fmt(endMin))"
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 12) {
                // Header
                HStack {
                    Image(systemName: "square.grid.3x3.topleft.filled")
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                    Text("CELL DETAIL")
                        .font(.system(size: 12, weight: .black, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(NeonBrutalismTheme.textSecondary)
                    }
                    .buttonStyle(.plain)
                }

                NeonDivider(.horizontal)

                // Time range
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.system(size: 11))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                    Text(timeRange)
                        .font(.system(size: 16, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textPrimary)
                }

                let cards = lookupCardsForCell()

                if cards.isEmpty {
                    Text("暂无活动数据")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                        .padding(.vertical, 8)
                } else {
                    ForEach(Array(cards.enumerated()), id: \.offset) { _, card in
                        cellCardSection(card: card)
                    }

                    NeonDivider(.horizontal)

                    videoPreviewSection(cards: cards)
                }

                Spacer()
            }
            .padding(16)
        }
        .background(NeonBrutalismTheme.background)
    }

    // MARK: - Data

    private func lookupCardsForCell() -> [ActivityCardRecord] {
        agent.persistence.activityCards(for: selectedDate).filter { card in
            let cal = Calendar.current
            let startDate = Date(timeIntervalSince1970: Double(card.startTs))
            let endDate = Date(timeIntervalSince1970: Double(card.endTs))
            let sc = cal.dateComponents([.hour, .minute], from: startDate)
            let ec = cal.dateComponents([.hour, .minute], from: endDate)
            guard let sh = sc.hour, let sm = sc.minute,
                  let eh = ec.hour, let em = ec.minute else { return false }
            let cardStart = sh * 60 + sm
            var cardEnd = eh * 60 + em
            if cardEnd <= cardStart { cardEnd = 1440 }
            return cardStart < endMin && cardEnd > startMin
        }
    }

    // MARK: - Cell Card Section

    @ViewBuilder
    private func cellCardSection(card: ActivityCardRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(categoryColor(card.category))
                    .frame(width: 3, height: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(card.title)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textPrimary)
                    Text("\(categoryLabel(card.category)) \u{00B7} \(card.startTime) \u{2013} \(card.endTime)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                }
            }

            if let alignment = card.goalAlignment, !alignment.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "target")
                        .font(.system(size: 9))
                        .foregroundColor(goalAlignmentColor(alignment))
                    Text(alignment)
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundColor(goalAlignmentColor(alignment))
                        .lineLimit(2)
                }
            }

            NeonDivider(.horizontal)

            let timelineEntries = parseTimelineEntries(from: card.detailedSummary)

            if timelineEntries.isEmpty {
                Text(card.summary)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                    .lineLimit(4)
            } else {
                ForEach(Array(timelineEntries.enumerated()), id: \.offset) { idx, entry in
                    HStack(alignment: .top, spacing: 8) {
                        Text(entry.time)
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .foregroundColor(NeonBrutalismTheme.electricBlue)
                            .frame(width: 38, alignment: .trailing)

                        VStack(spacing: 0) {
                            Circle()
                                .fill(categoryColor(card.category))
                                .frame(width: 6, height: 6)
                            if idx < timelineEntries.count - 1 {
                                Rectangle()
                                    .fill(categoryColor(card.category).opacity(0.3))
                                    .frame(width: 1)
                                    .frame(maxHeight: .infinity)
                            }
                        }
                        .frame(width: 6)

                        Text(entry.content)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(NeonBrutalismTheme.textPrimary)
                            .lineLimit(3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(minHeight: 20)
                }
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(NeonBrutalismTheme.electricBlue.opacity(0.04))
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(categoryColor(card.category).opacity(0.15), lineWidth: 0.5)
                )
        )
    }

    // MARK: - Video Preview

    @ViewBuilder
    private func videoPreviewSection(cards: [ActivityCardRecord]) -> some View {
        let batchIds = Array(Set(cards.map(\.batchId)))
        let videoPaths: [String] = batchIds.compactMap { batchId in
            agent.persistence.batchRecord(for: batchId)?.videoPath
        }

        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: "film")
                    .font(.system(size: 11))
                    .foregroundColor(NeonBrutalismTheme.electricBlue)
                Text("TIMELAPSE")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.electricBlue)
            }

            if videoPaths.isEmpty {
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(NeonBrutalismTheme.textSecondary.opacity(0.2),
                                  style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .frame(height: 80)
                    .overlay(
                        Text("等待批次视频生成...")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.4))
                    )
            } else {
                ForEach(Array(videoPaths.enumerated()), id: \.offset) { _, path in
                    videoThumbnail(path: path)
                }
            }
        }
    }

    @ViewBuilder
    private func videoThumbnail(path: String) -> some View {
        let url = URL(fileURLWithPath: path)
        let exists = FileManager.default.fileExists(atPath: path)

        if exists {
            Button(action: { NSWorkspace.shared.open(url) }) {
                HStack(spacing: 8) {
                    Image(systemName: "play.circle.fill")
                        .font(.system(size: 24))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(url.lastPathComponent)
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundColor(NeonBrutalismTheme.textPrimary)
                            .lineLimit(1)
                        if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
                           let size = attrs[.size] as? Int {
                            Text(String(format: "%.1f MB", Double(size) / 1_048_576.0))
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundColor(NeonBrutalismTheme.textSecondary)
                        }
                    }
                    Spacer()
                    Image(systemName: "arrow.up.right.square")
                        .font(.system(size: 11))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                }
                .padding(8)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(NeonBrutalismTheme.electricBlue.opacity(0.06))
                )
            }
            .buttonStyle(.plain)
        } else {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 11))
                    .foregroundColor(.orange)
                Text("视频文件缺失")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
            }
        }
    }

    // MARK: - Timeline Parsing

    private struct TimelineEntry {
        let time: String
        let content: String
    }

    private func parseTimelineEntries(from detailedSummary: String) -> [TimelineEntry] {
        guard !detailedSummary.isEmpty else { return [] }

        let pattern = #"\[(\d{1,2}):(\d{2})\]\s*(.+?)(?=\[\d{1,2}:\d{2}\]|$)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else {
            return []
        }

        let nsString = detailedSummary as NSString
        let matches = regex.matches(in: detailedSummary, range: NSRange(location: 0, length: nsString.length))

        var entries: [TimelineEntry] = []
        for match in matches {
            guard match.numberOfRanges >= 4 else { continue }
            let hourStr = nsString.substring(with: match.range(at: 1))
            let minStr  = nsString.substring(with: match.range(at: 2))
            let content = nsString.substring(with: match.range(at: 3))
                .trimmingCharacters(in: .whitespacesAndNewlines)

            guard let h = Int(hourStr), let m = Int(minStr) else { continue }
            let minute = h * 60 + m

            guard minute >= startMin && minute < endMin else { continue }
            guard !content.isEmpty else { continue }

            entries.append(TimelineEntry(
                time: String(format: "%02d:%02d", h, m),
                content: content
            ))
        }

        return entries
    }

    // MARK: - Styling Helpers

    private func categoryColor(_ cat: String) -> Color {
        switch cat {
        case "coding":        return NeonBrutalismTheme.electricBlue
        case "writing":       return NeonBrutalismTheme.shadowPurple
        case "learning":      return NeonBrutalismTheme.expGreen
        case "browsing":      return .orange
        case "design":        return .mint
        case "research":      return .yellow
        case "communication": return .teal
        case "reading":       return Color(red: 0.6, green: 0.4, blue: 0.2)
        case "meeting":       return .gray
        case "media":         return .pink
        case "social":        return .cyan
        case "idle":          return NeonBrutalismTheme.textSecondary
        default:              return NeonBrutalismTheme.textSecondary
        }
    }

    private func categoryLabel(_ cat: String) -> String {
        switch cat {
        case "coding": return "编程"; case "writing": return "写作"
        case "learning": return "学习"; case "browsing": return "浏览"
        case "design": return "设计"; case "research": return "调研"
        case "communication": return "沟通"; case "reading": return "阅读"
        case "meeting": return "会议"; case "media": return "媒体"
        case "social": return "社交"; case "idle": return "空闲"
        default: return cat
        }
    }

    private func goalAlignmentColor(_ alignment: String) -> Color {
        if alignment.hasPrefix("直接推进") { return NeonBrutalismTheme.expGreen }
        if alignment.hasPrefix("间接相关") { return .orange }
        if alignment.hasPrefix("偏离主线") { return .red }
        return NeonBrutalismTheme.textSecondary
    }

    private static func fmt(_ m: Int) -> String {
        String(format: "%02d:%02d", m / 60, m % 60)
    }
}
