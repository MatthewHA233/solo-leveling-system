import SwiftUI
import AppKit

// MARK: - TimelineView

/// 时间线主界面 — 类似 Dayflow 的截图浏览
struct TimelineView: View {
    @EnvironmentObject var agent: AgentManager

    enum Filter: String, CaseIterable {
        case today = "今天"
        case last24h = "最近24小时"
    }

    @State private var filter: Filter = .today
    @State private var entries: [ActivityRecord] = []
    @State private var selectedScreenshot: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            // 顶栏
            HStack {
                Text("活动时间线")
                    .font(.title2)
                    .fontWeight(.bold)
                Spacer()
                Picker("筛选", selection: $filter) {
                    ForEach(Filter.allCases, id: \.self) { f in
                        Text(f.rawValue).tag(f)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 220)
            }
            .padding()

            Divider()

            // 内容区
            if entries.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 48))
                        .foregroundColor(.secondary)
                    Text("暂无截图记录")
                        .foregroundColor(.secondary)
                    Text("截图将在捕获后自动出现")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        ForEach(groupedByHour, id: \.hour) { group in
                            Section {
                                ForEach(group.records, id: \.timestamp) { record in
                                    TimelineEntryView(record: record) {
                                        selectedScreenshot = record.screenshotPath
                                    }
                                    Divider().padding(.leading, 16)
                                }
                            } header: {
                                HourHeaderView(hour: group.hour, count: group.records.count)
                            }
                        }
                    }
                    .padding(.horizontal)
                }
            }

            Divider()

            // 底栏
            HStack {
                Text("\(entries.count) 条记录")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Text("存储: \(ScreenshotStorageManager.shared.totalDiskUsage())")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
        .frame(minWidth: 700, minHeight: 500)
        .onAppear { loadEntries() }
        .onChange(of: filter) { loadEntries() }
        .sheet(item: $selectedScreenshot) { path in
            FullScreenshotView(relativePath: path)
        }
    }

    // MARK: - Data

    private var groupedByHour: [HourGroup] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: entries) { record in
            calendar.component(.hour, from: record.timestamp)
        }
        return grouped.map { HourGroup(hour: $0.key, records: $0.value) }
            .sorted { $0.hour > $1.hour }
    }

    private func loadEntries() {
        switch filter {
        case .today:
            entries = agent.persistence.todayActivitiesWithScreenshots()
        case .last24h:
            entries = agent.persistence.last24hActivitiesWithScreenshots()
        }
    }
}

// MARK: - HourGroup

private struct HourGroup {
    let hour: Int
    let records: [ActivityRecord]
}

// MARK: - HourHeaderView

/// 小时分组的 sticky header
struct HourHeaderView: View {
    let hour: Int
    let count: Int

    var body: some View {
        HStack {
            Text(String(format: "%02d:00", hour))
                .font(.headline)
                .fontWeight(.semibold)
            Text("(\(count) captures)")
                .font(.caption)
                .foregroundColor(.secondary)
            Spacer()
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 4)
        .background(.background)
    }
}

// MARK: - TimelineEntryView

/// 每条活动记录卡片
struct TimelineEntryView: View {
    let record: ActivityRecord
    let onTapThumbnail: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // 左侧缩略图
            if let path = record.screenshotPath {
                LocalImage(
                    url: ScreenshotStorageManager.shared.thumbnailURL(for: path),
                    fallbackURL: ScreenshotStorageManager.shared.fullURL(for: path)
                )
                .frame(width: 200, height: 125)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .shadow(radius: 2)
                .onTapGesture { onTapThumbnail() }
                .cursor(.pointingHand)
            }

            // 右侧元数据
            VStack(alignment: .leading, spacing: 4) {
                Text(record.timestamp.formatted(date: .omitted, time: .standard))
                    .font(.subheadline)
                    .fontWeight(.medium)

                if let appName = record.appName {
                    HStack(spacing: 4) {
                        Image(systemName: "app.fill")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        Text(appName)
                            .font(.caption)
                    }
                }

                if let title = record.windowTitle, !title.isEmpty {
                    Text(title)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }

                ActivityStateBadge(state: record.activityState)
            }

            Spacer()
        }
        .padding(.vertical, 6)
    }
}

// MARK: - ActivityStateBadge

/// 彩色活动状态标签
struct ActivityStateBadge: View {
    let state: String

    private var config: (text: String, color: Color) {
        switch state {
        case "active":
            return ("活跃", .green)
        case "idle":
            return ("空闲", .orange)
        case "deepIdle":
            return ("深度空闲", .red)
        case "locked":
            return ("锁屏", .gray)
        default:
            return (state, .secondary)
        }
    }

    var body: some View {
        Text(config.text)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(config.color.opacity(0.15))
            .foregroundColor(config.color)
            .clipShape(Capsule())
    }
}

// MARK: - FullScreenshotView

/// Sheet 弹窗查看原图
struct FullScreenshotView: View {
    let relativePath: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(relativePath)
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Button("关闭") { dismiss() }
                    .buttonStyle(.bordered)
            }
            .padding()

            Divider()

            ScrollView([.horizontal, .vertical]) {
                LocalImage(
                    url: ScreenshotStorageManager.shared.fullURL(for: relativePath),
                    fallbackURL: nil
                )
                .padding()
            }
        }
        .frame(minWidth: 800, minHeight: 600)
    }
}

// MARK: - LocalImage

/// 本地文件 URL 图片加载辅助组件
struct LocalImage: View {
    let url: URL
    let fallbackURL: URL?

    var body: some View {
        if let nsImage = NSImage(contentsOf: url) {
            Image(nsImage: nsImage)
                .resizable()
                .aspectRatio(contentMode: .fit)
        } else if let fallback = fallbackURL, let nsImage = NSImage(contentsOf: fallback) {
            Image(nsImage: nsImage)
                .resizable()
                .aspectRatio(contentMode: .fit)
        } else {
            Rectangle()
                .fill(Color.gray.opacity(0.2))
                .overlay {
                    Image(systemName: "photo")
                        .foregroundColor(.secondary)
                }
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
