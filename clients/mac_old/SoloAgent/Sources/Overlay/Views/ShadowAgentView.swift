import SwiftUI

/// 暗影智能体面板 — 替代 OmniscienceLogView 作为右栏
struct ShadowAgentView: View {
    @ObservedObject var agent: ShadowAgent
    @ObservedObject var activityFeed: ActivityFeed
    @State private var logExpanded: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            // A. 对话区（占大部分空间）
            AgentChatView(messages: agent.messages, isProcessing: agent.isProcessing)
                .frame(maxHeight: .infinity)

            NeonDivider(.horizontal)

            // B. 系统日志折叠区
            SystemLogSection(activityFeed: activityFeed, isExpanded: $logExpanded)

            NeonDivider(.horizontal)

            // C. 输入栏
            ChatInputBar(
                onSend: { text in
                    Task { await agent.send(text) }
                },
                skills: agent.availableSkills
            )
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - System Log Section (折叠式)

private struct SystemLogSection: View {
    @ObservedObject var activityFeed: ActivityFeed
    @Binding var isExpanded: Bool

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    var body: some View {
        VStack(spacing: 0) {
            // Header (点击折叠/展开)
            Button(action: { withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() } }) {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                        .frame(width: 10)

                    Text("系统日志")
                        .font(NeonBrutalismTheme.sectionHeaderFont)
                        .foregroundColor(NeonBrutalismTheme.textSecondary)

                    Spacer()

                    Text("\(activityFeed.items.count)")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.6))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // 展开时显示日志
            if isExpanded {
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(activityFeed.items) { item in
                                LogRowView(item: item, colorForItem: colorForItem(item))
                                    .id(item.id)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .frame(maxHeight: 120)
                    .onChange(of: activityFeed.items.count) {
                        if let lastId = activityFeed.items.last?.id {
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            }
                        }
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
    }

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
