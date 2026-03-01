import SwiftUI
import AVKit

/// 内嵌视频播放器 — 用 NSViewRepresentable 包装 AVPlayerView 避免 SwiftUI VideoPlayer 元数据崩溃
struct InlineVideoPlayer: NSViewRepresentable {
    let player: AVPlayer
    var controlsStyle: AVPlayerViewControlsStyle = .inline

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = controlsStyle
        view.showsFullScreenToggleButton = false
        return view
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        if nsView.player !== player {
            nsView.player = player
        }
        if nsView.controlsStyle != controlsStyle {
            nsView.controlsStyle = controlsStyle
        }
    }
}

/// 批次详情面板 — 显示单个 batch 的完整时间线、活动卡片和视频
struct BatchDetailView: View {
    let batchId: String
    let selectedDate: Date
    let player: AVPlayer?
    var onVideoTap: () -> Void
    var onSeekToTime: (String) -> Void
    @EnvironmentObject var agent: AgentManager
    var onClose: () -> Void

    @State private var isRegenerating = false

    private var batch: BatchRecord? {
        agent.persistence.batchRecord(for: batchId)
    }

    private var timeRange: String {
        guard let b = batch else { return "--:-- \u{2013} --:--" }
        let cal = Calendar.current
        let start = Date(timeIntervalSince1970: Double(b.startTs))
        let end = Date(timeIntervalSince1970: Double(b.endTs))
        let sh = cal.component(.hour, from: start)
        let sm = cal.component(.minute, from: start)
        let eh = cal.component(.hour, from: end)
        let em = cal.component(.minute, from: end)
        return String(format: "%02d:%02d \u{2013} %02d:%02d", sh, sm, eh, em)
    }

    private var screenshotCount: Int {
        batch?.screenshotCount ?? 0
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 12) {
                // 1. Header + 关闭按钮
                HStack {
                    Image(systemName: "film.stack")
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                    Text("批次详情")
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

                // 2. 时间范围 + 截图数
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.system(size: 11))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                    Text(timeRange)
                        .font(.system(size: 16, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textPrimary)
                    Spacer()
                    Text("\(screenshotCount) 截图")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                }

                // 3. 内嵌视频播放器
                videoPlayerSection()

                // 4. 重新生成 AI 摘要按钮
                regenerateButton()

                NeonDivider(.horizontal)

                // 5. AI 摘要区（按 batch.status 分支显示）
                aiSummarySection()

                Spacer()
            }
            .padding(16)
        }
        .background(NeonBrutalismTheme.background)
        .onChange(of: agent.activityCardsUpdated) { _ in
            // 当 batch status 不再是 processing 时，确保 spinner 停止
            if isRegenerating, let s = batch?.status, s != "processing" {
                isRegenerating = false
            }
        }
    }

    // MARK: - Video Player Section

    @ViewBuilder
    private func videoPlayerSection() -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: "film")
                    .font(.system(size: 11))
                    .foregroundColor(NeonBrutalismTheme.electricBlue)
                Text("延时影像")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.electricBlue)
            }

            if let avPlayer = player {
                ZStack {
                    InlineVideoPlayer(player: avPlayer, controlsStyle: .none)
                        .frame(height: 160)
                        .allowsHitTesting(false)

                    // Transparent tap layer + expand icon
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.black.opacity(0.001))
                        .overlay(alignment: .center) {
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                                .font(.system(size: 20, weight: .medium))
                                .foregroundColor(.white.opacity(0.7))
                                .padding(8)
                                .background(Circle().fill(Color.black.opacity(0.4)))
                        }
                }
                .frame(height: 160)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(NeonBrutalismTheme.electricBlue.opacity(0.2), lineWidth: 0.5)
                )
                .contentShape(Rectangle())
                .onTapGesture { onVideoTap() }
                .onHover { hovering in
                    if hovering { NSCursor.pointingHand.push() }
                    else { NSCursor.pop() }
                }

                // 视频信息行
                if let path = batch?.videoPath {
                    videoInfoRow(path: path)
                }
            } else if let path = batch?.videoPath, !FileManager.default.fileExists(atPath: path) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 11))
                        .foregroundColor(.orange)
                    Text("视频文件缺失")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                }
            } else {
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(NeonBrutalismTheme.textSecondary.opacity(0.2),
                                  style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .frame(height: 80)
                    .overlay(
                        Text("等待批次视频生成...")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.4))
                    )
            }
        }
    }

    @ViewBuilder
    private func videoInfoRow(path: String) -> some View {
        let url = URL(fileURLWithPath: path)
        HStack(spacing: 8) {
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
            Spacer()
            Button(action: {
                NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: "")
            }) {
                HStack(spacing: 3) {
                    Image(systemName: "folder")
                        .font(.system(size: 9))
                    Text("在 Finder 中打开")
                        .font(.system(size: 9, design: .monospaced))
                }
                .foregroundColor(NeonBrutalismTheme.electricBlue)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Regenerate Button

    @ViewBuilder
    private func regenerateButton() -> some View {
        Button(action: {
            guard !isRegenerating else { return }
            isRegenerating = true
            Task {
                await agent.reanalyzeBatch(batchId)
                isRegenerating = false
            }
        }) {
            HStack(spacing: 6) {
                if isRegenerating {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11))
                }
                Text("重新生成 AI 摘要")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
            }
            .foregroundColor(isRegenerating ? NeonBrutalismTheme.textSecondary : NeonBrutalismTheme.electricBlue)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(NeonBrutalismTheme.electricBlue.opacity(isRegenerating ? 0.03 : 0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .strokeBorder(NeonBrutalismTheme.electricBlue.opacity(0.2), lineWidth: 0.5)
                    )
            )
        }
        .buttonStyle(.plain)
        .disabled(isRegenerating)
    }

    // MARK: - AI Summary Section

    @ViewBuilder
    private func aiSummarySection() -> some View {
        // 依赖 activityCardsUpdated 确保 batch.status 变化时视图刷新
        let _ = agent.activityCardsUpdated
        let status = batch?.status ?? "pending"
        let cards = lookupCardsForBatch()

        if agent.isStreaming[batchId] == true, let text = agent.streamingText[batchId], !text.isEmpty {
            // 最高优先级：流式输出中 — 打字机效果
            streamingTextView(text: text)
        } else if isRegenerating {
            // 用户主动触发的重新生成 — 只由 @State 控制，不受视图重建影响
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text(agent.batchProgress[batchId] ?? "AI 分析中...")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
            }
            .padding(.vertical, 8)
        } else if status == "processing" {
            // 后台批次处理中（非用户触发）
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text(agent.batchProgress[batchId] ?? "AI 分析中...")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
            }
            .padding(.vertical, 8)
        } else if status == "failed" {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundColor(.red)
                    Text("AI 分析失败")
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundColor(.red)
                }
                if let errorMsg = batch?.errorMessage, !errorMsg.isEmpty {
                    Text(errorMsg)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                        .lineLimit(3)
                }
            }
            .padding(.vertical, 4)
        } else if !cards.isEmpty {
            ForEach(Array(cards.enumerated()), id: \.offset) { idx, card in
                cellCardSection(card: card)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .animation(.easeOut(duration: 0.4).delay(Double(idx) * 0.1), value: cards.count)
            }
        } else {
            Text("无 AI 摘要")
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textSecondary)
                .padding(.vertical, 8)
        }
    }

    // MARK: - Streaming Text View (打字机效果)

    @ViewBuilder
    private func streamingTextView(text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // 顶部状态栏
            HStack(spacing: 8) {
                // 脉冲指示灯
                Circle()
                    .fill(NeonBrutalismTheme.electricBlue)
                    .frame(width: 6, height: 6)
                    .modifier(PulseModifier())

                Text("AI 生成中")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.electricBlue)

                Spacer()

                Text("\(text.count) 字符")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
            }

            // 滚动文本区 + 闪烁光标
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: true) {
                    HStack(alignment: .bottom, spacing: 0) {
                        Text(text)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(NeonBrutalismTheme.textPrimary.opacity(0.85))
                            .textSelection(.enabled)

                        BlinkingCursor()

                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .id("streamEnd")
                }
                .frame(maxHeight: 200)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.black.opacity(0.3))
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .strokeBorder(NeonBrutalismTheme.electricBlue.opacity(0.15), lineWidth: 0.5)
                        )
                )
                .onChange(of: text.count) { _ in
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo("streamEnd", anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Blinking Cursor

    private struct BlinkingCursor: View {
        @State private var visible = true

        var body: some View {
            Rectangle()
                .fill(NeonBrutalismTheme.electricBlue)
                .frame(width: 7, height: 13)
                .opacity(visible ? 1 : 0)
                .onAppear {
                    withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                        visible = false
                    }
                }
        }
    }

    // MARK: - Pulse Modifier

    private struct PulseModifier: ViewModifier {
        @State private var scale: CGFloat = 1.0

        func body(content: Content) -> some View {
            content
                .scaleEffect(scale)
                .opacity(scale == 1.0 ? 1.0 : 0.5)
                .onAppear {
                    withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                        scale = 1.5
                    }
                }
        }
    }

    // MARK: - Data

    private func lookupCardsForBatch() -> [ActivityCardRecord] {
        agent.persistence.activityCards(for: selectedDate).filter { card in
            card.batchId == batchId
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
                    TimelineEntryRow(
                        entry: entry,
                        isLast: idx == timelineEntries.count - 1,
                        categoryColor: categoryColor(card.category),
                        onTap: { onSeekToTime(entry.time) }
                    )
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

    // MARK: - Timeline Entry Row (可点击)

    private struct TimelineEntryRow: View {
        let entry: TimelineEntry
        let isLast: Bool
        let categoryColor: Color
        var onTap: () -> Void

        @State private var isHovered = false

        var body: some View {
            Button(action: onTap) {
                HStack(alignment: .top, spacing: 8) {
                    Text(entry.time)
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                        .underline(isHovered, color: NeonBrutalismTheme.electricBlue.opacity(0.5))
                        .frame(width: 38, alignment: .trailing)

                    VStack(spacing: 0) {
                        Circle()
                            .fill(categoryColor)
                            .frame(width: 6, height: 6)
                        if !isLast {
                            Rectangle()
                                .fill(categoryColor.opacity(0.3))
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
                .padding(.vertical, 2)
                .padding(.horizontal, 4)
                .background(
                    RoundedRectangle(cornerRadius: 3)
                        .fill(isHovered ? NeonBrutalismTheme.electricBlue.opacity(0.06) : Color.clear)
                )
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                isHovered = hovering
                if hovering { NSCursor.pointingHand.push() }
                else { NSCursor.pop() }
            }
        }
    }

    // MARK: - Timeline Parsing (无 5 分钟过滤)

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
}
