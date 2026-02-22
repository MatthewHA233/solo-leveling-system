import SwiftUI
import AppKit

// MARK: - TimelineView

/// 活动卡片时间线 — 垂直时间线 + 卡片列表
struct TimelineView: View {
    @EnvironmentObject var agent: AgentManager

    @State private var selectedDate: Date = Date()
    @State private var cards: [ActivityCardRecord] = []
    @State private var expandedCardId: String? = nil
    @State private var refreshTimer: Timer? = nil

    var body: some View {
        VStack(spacing: 0) {
            // 顶栏: 日期导航
            dateNavigationBar

            Divider()

            // 内容区
            if cards.isEmpty {
                emptyStateView
            } else {
                cardListView
            }

            Divider()

            // 底栏: 统计
            bottomBar
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .frame(minWidth: 520, minHeight: 500)
        .onAppear {
            loadCards()
            startAutoRefresh()
        }
        .onDisappear {
            refreshTimer?.invalidate()
        }
        .onChange(of: selectedDate) {
            loadCards()
        }
    }

    // MARK: - Auto Refresh

    private func startAutoRefresh() {
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
            Task { @MainActor in
                loadCards()
            }
        }
    }

    // MARK: - Date Navigation

    private var dateNavigationBar: some View {
        HStack {
            Button(action: { navigateDay(-1) }) {
                Image(systemName: "chevron.left")
                    .font(.title3)
            }
            .buttonStyle(.plain)

            Spacer()

            Text(dateDisplayString)
                .font(.title2)
                .fontWeight(.bold)

            Spacer()

            Button(action: { navigateDay(1) }) {
                Image(systemName: "chevron.right")
                    .font(.title3)
            }
            .buttonStyle(.plain)
            .disabled(Calendar.current.isDateInToday(selectedDate))

            if !Calendar.current.isDateInToday(selectedDate) {
                Button("今天") {
                    selectedDate = Date()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private var dateDisplayString: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")

        if Calendar.current.isDateInToday(selectedDate) {
            formatter.dateFormat = "M月d日 EEEE · 今天"
        } else if Calendar.current.isDateInYesterday(selectedDate) {
            formatter.dateFormat = "M月d日 EEEE · 昨天"
        } else {
            formatter.dateFormat = "M月d日 EEEE"
        }
        return formatter.string(from: selectedDate)
    }

    private func navigateDay(_ delta: Int) {
        if let newDate = Calendar.current.date(byAdding: .day, value: delta, to: selectedDate) {
            selectedDate = newDate
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack {
            Spacer()
            VStack(spacing: 12) {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 48))
                    .foregroundColor(.secondary)
                Text("暂无活动卡片")
                    .font(.title3)
                    .foregroundColor(.secondary)
                Text("截图将自动捕获并按批次合成视频，由 AI 分析生成活动卡片")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 350)
            }
            Spacer()
        }
    }

    // MARK: - Card List View

    private var cardListView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(cards, id: \.startTs) { card in
                        cardRow(card)
                            .id(card.startTs)
                    }
                }
                .padding(.vertical, 8)
            }
            .onAppear {
                // 滚动到最近的卡片
                if let last = cards.last {
                    proxy.scrollTo(last.startTs, anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Card Row

    private func cardRow(_ card: ActivityCardRecord) -> some View {
        let isExpanded = expandedCardId == "\(card.startTs)"
        let categoryColor = CategoryBadge.color(for: card.category)
        let durationMin = max(1, (card.endTs - card.startTs) / 60)

        return HStack(alignment: .top, spacing: 0) {
            // 左侧: 时间列
            VStack(alignment: .trailing, spacing: 2) {
                Text(card.startTime)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundColor(.primary)
                Text(card.endTime)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
                Text("\(durationMin)m")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(categoryColor)
            }
            .frame(width: 64, alignment: .trailing)
            .padding(.trailing, 12)
            .padding(.top, 4)

            // 中间: 时间线竖条
            VStack(spacing: 0) {
                Circle()
                    .fill(categoryColor)
                    .frame(width: 10, height: 10)
                    .padding(.top, 6)
                Rectangle()
                    .fill(categoryColor.opacity(0.3))
                    .frame(width: 2)
            }
            .padding(.trailing, 12)

            // 右侧: 卡片内容
            VStack(alignment: .leading, spacing: 6) {
                // Header
                HStack(spacing: 6) {
                    CategoryBadge(category: card.category)

                    if let app = card.appSitePrimary, !app.isEmpty {
                        Text(app)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }

                    Spacer()
                }

                // Title
                Text(card.title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(.primary)
                    .lineLimit(isExpanded ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)

                // Summary
                Text(card.summary)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(isExpanded ? nil : 3)
                    .fixedSize(horizontal: false, vertical: true)

                // Expanded content
                if isExpanded {
                    expandedContent(card)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(categoryColor.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(categoryColor.opacity(0.2), lineWidth: 1)
                    )
            )
            .padding(.trailing, 16)
            .padding(.bottom, 12)
        }
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.easeInOut(duration: 0.2)) {
                expandedCardId = isExpanded ? nil : "\(card.startTs)"
            }
        }
        .cursor(.pointingHand)
    }

    // MARK: - Expanded Content

    @ViewBuilder
    private func expandedContent(_ card: ActivityCardRecord) -> some View {
        Divider()
            .padding(.vertical, 4)

        if !card.detailedSummary.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Label("详细时间线", systemImage: "clock.arrow.circlepath")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(.primary)
                Text(card.detailedSummary)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        if let distractionsJson = card.distractionsJson,
           let data = distractionsJson.data(using: .utf8),
           let distractions = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
           !distractions.isEmpty {
            Divider()
                .padding(.vertical, 4)
            VStack(alignment: .leading, spacing: 4) {
                Label("干扰记录", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(.orange)
                ForEach(distractions.indices, id: \.self) { idx in
                    let d = distractions[idx]
                    Text("• \(d["description"] as? String ?? "")")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }
        }
    }

    // MARK: - Bottom Bar

    private var bottomBar: some View {
        HStack {
            Text("\(cards.count) 张活动卡片")
                .font(.caption)
                .foregroundColor(.secondary)

            Spacer()

            let totalMinutes = cards.reduce(0) { $0 + max(0, $1.endTs - $1.startTs) } / 60
            Text("总记录: \(totalMinutes) 分钟")
                .font(.caption)
                .foregroundColor(.secondary)

            // 刷新按钮
            Button(action: { loadCards() }) {
                Image(systemName: "arrow.clockwise")
                    .font(.caption)
            }
            .buttonStyle(.plain)
            .foregroundColor(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: - Data Loading

    private func loadCards() {
        cards = agent.persistence.activityCards(for: selectedDate)
    }
}

// MARK: - CategoryBadge

struct CategoryBadge: View {
    let category: String

    var body: some View {
        Text(displayName)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Self.color(for: category).opacity(0.15))
            .foregroundColor(Self.color(for: category))
            .clipShape(Capsule())
    }

    private var displayName: String {
        switch category {
        case "coding": return "编程"
        case "writing": return "写作"
        case "learning": return "学习"
        case "browsing": return "浏览"
        case "media": return "媒体"
        case "social": return "社交"
        case "gaming": return "游戏"
        case "work": return "工作"
        case "communication": return "沟通"
        case "design": return "设计"
        case "reading": return "阅读"
        case "research": return "调研"
        case "meeting": return "会议"
        case "idle": return "空闲"
        default: return category
        }
    }

    static func color(for category: String) -> Color {
        switch category {
        case "coding": return .blue
        case "writing": return .purple
        case "learning": return .green
        case "browsing": return .orange
        case "media": return .pink
        case "social": return .cyan
        case "gaming": return .red
        case "work": return .indigo
        case "communication": return .teal
        case "design": return .mint
        case "reading": return .brown
        case "research": return .yellow
        case "meeting": return .gray
        case "idle": return .secondary
        default: return .secondary
        }
    }
}

// MARK: - Cursor Modifier

private extension View {
    func cursor(_ cursor: NSCursor) -> some View {
        onHover { inside in
            if inside { cursor.push() }
            else { NSCursor.pop() }
        }
    }
}

// MARK: - String + Identifiable (for sheet)

extension String: @retroactive Identifiable {
    public var id: String { self }
}
