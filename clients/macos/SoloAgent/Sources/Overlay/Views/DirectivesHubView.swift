import SwiftUI
import AppKit

/// 中栏 — 任务 Tab + 时间线 Tab
struct DirectivesHubView: View {
    @ObservedObject var agentManager: AgentManager
    let quests: [Quest]
    var onCompleteQuest: ((String) -> Void)?

    enum Tab: String, CaseIterable {
        case directives = "任务"
        case timeline = "时间线"
    }

    @State private var selectedTab: Tab = .directives

    // Timeline state
    @State private var selectedDate: Date = Date()
    @State private var cards: [ActivityCardRecord] = []
    @State private var expandedCardId: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar
            tabBar

            NeonDivider(.horizontal)

            // Content
            switch selectedTab {
            case .directives:
                directivesContent
            case .timeline:
                timelineContent
            }
        }
        .task(id: selectedTab) {
            guard selectedTab == .timeline else { return }
            loadCards()
            // 30s auto refresh
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { break }
                loadCards()
            }
        }
    }

    // MARK: - Tab Bar

    private var tabBar: some View {
        HStack(spacing: 0) {
            Text("THE DIRECTIVES")
                .font(NeonBrutalismTheme.sectionHeaderFont)
                .foregroundColor(NeonBrutalismTheme.textSecondary)
                .padding(.leading, 16)

            Spacer()

            ForEach(Tab.allCases, id: \.self) { tab in
                Button(action: { selectedTab = tab }) {
                    Text(tab.rawValue)
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundColor(selectedTab == tab ? NeonBrutalismTheme.electricBlue : NeonBrutalismTheme.textSecondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(
                            selectedTab == tab
                                ? NeonBrutalismTheme.electricBlue.opacity(0.1)
                                : Color.clear
                        )
                        .clipShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.trailing, 8)
        }
        .padding(.vertical, 8)
    }

    // MARK: - Directives (任务)

    private var directivesContent: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 8) {
                // Active quests header
                HStack {
                    Text("\(activeQuests.count) ACTIVE")
                        .font(NeonBrutalismTheme.captionFont)
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)

                if activeQuests.isEmpty {
                    VStack(spacing: 8) {
                        Text("NO ACTIVE DIRECTIVES")
                            .font(NeonBrutalismTheme.bodyFont)
                            .foregroundColor(NeonBrutalismTheme.textSecondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    ForEach(activeQuests) { quest in
                        questCard(quest)
                            .padding(.horizontal, 16)
                    }
                }

                // Recent completed
                let completed = recentCompleted
                if !completed.isEmpty {
                    NeonDivider(.horizontal)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)

                    Text("COMPLETED")
                        .font(NeonBrutalismTheme.captionFont)
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                        .padding(.horizontal, 16)
                        .padding(.top, 4)

                    ForEach(completed) { quest in
                        completedQuestRow(quest)
                            .padding(.horizontal, 16)
                    }
                }
            }
            .padding(.bottom, 16)
        }
    }

    private func questCard(_ quest: Quest) -> some View {
        HStack(spacing: 10) {
            // Difficulty badge
            Text(quest.difficulty.rawValue)
                .font(.system(size: 11, weight: .heavy, design: .monospaced))
                .foregroundColor(.white)
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(NeonBrutalismTheme.difficultyColor(quest.difficulty))
                )
                .shadow(color: NeonBrutalismTheme.difficultyColor(quest.difficulty).opacity(0.5), radius: 4)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if quest.type == .daily {
                        BrutalBadge(text: "DAILY", color: NeonBrutalismTheme.electricBlue)
                    }
                    Text(quest.title)
                        .font(NeonBrutalismTheme.bodyFont)
                        .foregroundColor(NeonBrutalismTheme.textPrimary)
                        .lineLimit(1)
                }

                HStack(spacing: 8) {
                    Text("+\(quest.expReward) EXP")
                        .font(NeonBrutalismTheme.captionFont)
                        .foregroundColor(NeonBrutalismTheme.expGreen)

                    if let deadline = quest.deadline {
                        let remaining = deadline.timeIntervalSince(Date())
                        if remaining > 0 {
                            Text(formatCountdown(remaining))
                                .font(NeonBrutalismTheme.captionFont)
                                .foregroundColor(remaining < 3600 ? NeonBrutalismTheme.dangerRed : NeonBrutalismTheme.textSecondary)
                        }
                    }
                }
            }

            Spacer()

            Button(action: { onCompleteQuest?(quest.id) }) {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(NeonBrutalismTheme.expGreen)
                    .frame(width: 28, height: 28)
                    .background(NeonBrutalismTheme.expGreen.opacity(0.12))
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .stroke(NeonBrutalismTheme.expGreen.opacity(0.4), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.white.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(NeonBrutalismTheme.electricBlue.opacity(0.1), lineWidth: 0.5)
        )
    }

    private func completedQuestRow(_ quest: Quest) -> some View {
        HStack {
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(NeonBrutalismTheme.expGreen.opacity(0.5))
                .font(.system(size: 10))
            Text(quest.title)
                .font(NeonBrutalismTheme.captionFont)
                .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.6))
                .strikethrough()
            Spacer()
            Text("+\(quest.expReward)")
                .font(NeonBrutalismTheme.captionFont)
                .foregroundColor(NeonBrutalismTheme.expGreen.opacity(0.4))
        }
        .padding(.vertical, 2)
    }

    private var activeQuests: [Quest] {
        quests.filter { $0.status == .active }
    }

    private var recentCompleted: [Quest] {
        quests.filter { $0.status == .completed }.suffix(3).reversed()
    }

    private func formatCountdown(_ seconds: TimeInterval) -> String {
        let h = Int(seconds) / 3600
        let m = (Int(seconds) % 3600) / 60
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }

    // MARK: - Timeline

    private var timelineContent: some View {
        VStack(spacing: 0) {
            // Date navigation
            dateNavigationBar

            NeonDivider(.horizontal)

            if cards.isEmpty {
                timelineEmptyState
            } else {
                timelineCardList
            }

            NeonDivider(.horizontal)

            timelineBottomBar
        }
    }

    private var dateNavigationBar: some View {
        HStack {
            Button(action: { navigateDay(-1) }) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(NeonBrutalismTheme.electricBlue)
            }
            .buttonStyle(.plain)

            Spacer()

            Text(dateDisplayString)
                .font(NeonBrutalismTheme.titleFont)
                .foregroundColor(NeonBrutalismTheme.textPrimary)

            Spacer()

            Button(action: { navigateDay(1) }) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Calendar.current.isDateInToday(selectedDate) ? NeonBrutalismTheme.textSecondary.opacity(0.3) : NeonBrutalismTheme.electricBlue)
            }
            .buttonStyle(.plain)
            .disabled(Calendar.current.isDateInToday(selectedDate))

            if !Calendar.current.isDateInToday(selectedDate) {
                Button("TODAY") {
                    selectedDate = Date()
                }
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.electricBlue)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(NeonBrutalismTheme.electricBlue.opacity(0.1))
                .clipShape(Rectangle())
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
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
            loadCards()
        }
    }

    private var timelineEmptyState: some View {
        VStack {
            Spacer()
            VStack(spacing: 10) {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 36))
                    .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.4))
                Text("NO ACTIVITY CARDS")
                    .font(NeonBrutalismTheme.bodyFont)
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                Text("截图将自动捕获并按批次合成视频，由 AI 分析生成活动卡片")
                    .font(NeonBrutalismTheme.captionFont)
                    .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
            }
            Spacer()
        }
    }

    private var timelineCardList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(cards, id: \.startTs) { card in
                        timelineCardRow(card)
                            .id(card.startTs)
                    }
                }
                .padding(.vertical, 8)
            }
            .onAppear {
                if let last = cards.last {
                    proxy.scrollTo(last.startTs, anchor: .bottom)
                }
            }
        }
    }

    private func timelineCardRow(_ card: ActivityCardRecord) -> some View {
        let isExpanded = expandedCardId == "\(card.startTs)"
        let categoryColor = CategoryBadge.color(for: card.category)
        let durationMin = max(1, (card.endTs - card.startTs) / 60)

        return HStack(alignment: .top, spacing: 0) {
            // Time column
            VStack(alignment: .trailing, spacing: 2) {
                Text(card.startTime)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textPrimary)
                Text(card.endTime)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                Text("\(durationMin)m")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundColor(categoryColor)
            }
            .frame(width: 56, alignment: .trailing)
            .padding(.trailing, 10)
            .padding(.top, 4)

            // Timeline vertical line
            VStack(spacing: 0) {
                Rectangle()
                    .fill(categoryColor)
                    .frame(width: 6, height: 6)
                    .padding(.top, 8)
                Rectangle()
                    .fill(categoryColor.opacity(0.3))
                    .frame(width: 2)
            }
            .padding(.trailing, 10)

            // Card content
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    CategoryBadge(category: card.category)
                    if let app = card.appSitePrimary, !app.isEmpty {
                        Text(app)
                            .font(NeonBrutalismTheme.captionFont)
                            .foregroundColor(NeonBrutalismTheme.textSecondary)
                            .lineLimit(1)
                    }
                    Spacer()
                }

                Text(card.title)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textPrimary)
                    .lineLimit(isExpanded ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)

                Text(card.summary)
                    .font(NeonBrutalismTheme.captionFont)
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                    .lineLimit(isExpanded ? nil : 3)
                    .fixedSize(horizontal: false, vertical: true)

                if let alignment = card.goalAlignment, !alignment.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: goalAlignmentIcon(alignment))
                            .font(.system(size: 9))
                            .foregroundColor(goalAlignmentColor(alignment))
                        Text(alignment)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(goalAlignmentColor(alignment))
                            .lineLimit(isExpanded ? nil : 1)
                    }
                }

                if isExpanded {
                    timelineExpandedContent(card)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(categoryColor.opacity(0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(categoryColor.opacity(0.2), lineWidth: 1)
            )
            .padding(.trailing, 16)
            .padding(.bottom, 8)
        }
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.easeInOut(duration: 0.2)) {
                expandedCardId = isExpanded ? nil : "\(card.startTs)"
            }
        }
        .pointingHand()
    }

    @ViewBuilder
    private func timelineExpandedContent(_ card: ActivityCardRecord) -> some View {
        NeonDivider(.horizontal)
            .padding(.vertical, 4)

        if !card.detailedSummary.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Label("详细时间线", systemImage: "clock.arrow.circlepath")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textPrimary)
                Text(card.detailedSummary)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        if let distractionsJson = card.distractionsJson,
           let data = distractionsJson.data(using: .utf8),
           let distractions = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
           !distractions.isEmpty {
            NeonDivider(.horizontal)
                .padding(.vertical, 4)
            VStack(alignment: .leading, spacing: 4) {
                Label("干扰记录", systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.dangerRed)
                ForEach(distractions.indices, id: \.self) { idx in
                    let d = distractions[idx]
                    Text("• \(d["description"] as? String ?? "")")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                }
            }
        }
    }

    private var timelineBottomBar: some View {
        HStack {
            Text("\(cards.count) cards")
                .font(NeonBrutalismTheme.captionFont)
                .foregroundColor(NeonBrutalismTheme.textSecondary)

            Spacer()

            let totalMinutes = cards.reduce(0) { $0 + max(0, $1.endTs - $1.startTs) } / 60
            Text("\(totalMinutes)m recorded")
                .font(NeonBrutalismTheme.captionFont)
                .foregroundColor(NeonBrutalismTheme.textSecondary)

            Button(action: { loadCards() }) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10))
                    .foregroundColor(NeonBrutalismTheme.electricBlue)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }

    // MARK: - Goal Alignment Helpers

    private func goalAlignmentColor(_ alignment: String) -> Color {
        let lower = alignment.lowercased()
        if lower.contains("直接") || lower.contains("推进") {
            return NeonBrutalismTheme.expGreen
        } else if lower.contains("间接") || lower.contains("相关") {
            return NeonBrutalismTheme.electricBlue
        } else if lower.contains("偏离") || lower.contains("无关") {
            return NeonBrutalismTheme.dangerRed
        } else {
            return NeonBrutalismTheme.textSecondary
        }
    }

    private func goalAlignmentIcon(_ alignment: String) -> String {
        let lower = alignment.lowercased()
        if lower.contains("直接") || lower.contains("推进") {
            return "arrow.up.right.circle.fill"
        } else if lower.contains("间接") || lower.contains("相关") {
            return "arrow.turn.right.up"
        } else if lower.contains("偏离") || lower.contains("无关") {
            return "exclamationmark.triangle.fill"
        } else {
            return "minus.circle"
        }
    }

    // MARK: - Data

    private func loadCards() {
        cards = agentManager.persistence.activityCards(for: selectedDate)
    }
}

// MARK: - CategoryBadge (Neon Brutalism)

struct CategoryBadge: View {
    let category: String

    var body: some View {
        Text(displayName)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Self.color(for: category).opacity(0.15))
            .foregroundColor(Self.color(for: category))
            .clipShape(Rectangle())
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
        case "idle": return NeonBrutalismTheme.textSecondary
        default: return NeonBrutalismTheme.textSecondary
        }
    }
}
