import Foundation

/// 主动询问引擎 — 检测四种询问触发条件，通知 ShadowAgent 发起对话
@MainActor
final class ProactiveInquiryEngine {
    private let persistence: PersistenceManager
    private let matcher: WindowTaskMatcher

    /// 询问回调 — 由 ShadowAgent 设置，引擎触发时通过此回调发起对话
    var onInquiry: ((InquiryTrigger) -> Void)?

    /// 上次刷新检查时间
    private var lastRefreshCheck: Date = Date()

    /// 上次 idle 询问时间（避免重复询问）
    private var lastIdleInquiry: Date?

    /// idle 询问阈值（秒）
    private let idleThreshold: TimeInterval = 300 // 5 分钟

    /// 定时刷新间隔（秒）
    private let refreshInterval: TimeInterval = 3 * 3600 // 3 小时

    /// 最近一次询问过的 bundleId（防止切回同一个 app 重复问）
    private var recentlyAskedBundleIds: Set<String> = []

    init(persistence: PersistenceManager, matcher: WindowTaskMatcher = .shared) {
        self.persistence = persistence
        self.matcher = matcher
    }

    // MARK: - Trigger 1: 新窗口无映射

    /// 窗口切换时调用 — 检查新窗口是否有映射
    func handleWindowSwitch(from oldInfo: WindowInfo, to newInfo: WindowInfo) {
        guard let bundleId = newInfo.bundleId else { return }

        // 跳过系统应用和自身
        let ignoredBundles = ["com.apple.finder", "com.apple.loginwindow",
                              "com.apple.SecurityAgent", "com.apple.dock"]
        if ignoredBundles.contains(bundleId) { return }

        // 检查是否有映射
        if matcher.hasMapping(bundleId: bundleId, windowTitle: newInfo.windowTitle) {
            return
        }

        // 防止短时间内对同一个 app 重复询问
        if recentlyAskedBundleIds.contains(bundleId) {
            return
        }
        recentlyAskedBundleIds.insert(bundleId)

        // 30 分钟后允许再次询问
        Task {
            try? await Task.sleep(for: .seconds(1800))
            recentlyAskedBundleIds.remove(bundleId)
        }

        let appName = newInfo.appName ?? bundleId
        onInquiry?(.newWindowUnmapped(appName: appName, bundleId: bundleId, windowTitle: newInfo.windowTitle))
    }

    // MARK: - Trigger 3: 定时刷新

    /// 定时检查（每分钟由 gameTickLoop 驱动）
    func periodicCheck() {
        let now = Date()

        // 每 3 小时检查过期映射
        if now.timeIntervalSince(lastRefreshCheck) >= refreshInterval {
            lastRefreshCheck = now
            let stale = persistence.staleWindowTasks(olderThan: 3)
            for record in stale {
                onInquiry?(.staleMapping(record: record))
            }
        }
    }

    // MARK: - Trigger 4: 长时间不操作

    /// idle 状态变化时调用
    func handleIdleChange(idleSeconds: TimeInterval, isScreenLocked: Bool) {
        // 锁屏不询问
        if isScreenLocked { return }

        if idleSeconds >= idleThreshold {
            // 避免重复询问（至少间隔 30 分钟）
            if let last = lastIdleInquiry, Date().timeIntervalSince(last) < 1800 {
                return
            }
            lastIdleInquiry = Date()
            onInquiry?(.prolongedIdle(idleSeconds: idleSeconds))
        }
    }

    // MARK: - 用户回来时

    /// 用户从 idle 恢复时，结束 away 记录
    func handleUserReturned() {
        persistence.endCurrentAwayRecord()
    }
}

// MARK: - Inquiry Trigger

enum InquiryTrigger {
    /// 新窗口无映射
    case newWindowUnmapped(appName: String, bundleId: String, windowTitle: String?)
    /// 过期映射需要刷新
    case staleMapping(record: WindowTaskRecord)
    /// 长时间不操作
    case prolongedIdle(idleSeconds: TimeInterval)

    /// fairy 气泡显示的简短文字
    var spokenText: String {
        switch self {
        case .newWindowUnmapped(let appName, _, _):
            return "在 \(appName) 做什么呢？"
        case .staleMapping(let record):
            return "还在\(record.taskDescription)吗？"
        case .prolongedIdle(let idleSeconds):
            let minutes = Int(idleSeconds / 60)
            return "已经 \(minutes) 分钟没动了，去哪了？"
        }
    }

    /// 生成发给 AI 的系统提示文本
    var systemPrompt: String {
        switch self {
        case .newWindowUnmapped(let appName, _, let windowTitle):
            let titlePart = windowTitle.map { "，窗口标题「\($0)」" } ?? ""
            return "主人刚切换到 \(appName)\(titlePart)，但这个窗口还没有对应的任务映射。请简短地问主人在做什么，并用 set_window_task 工具记录答案。"
        case .staleMapping(let record):
            return "窗口映射「\(record.bundleId) / \(record.titlePattern) → \(record.taskDescription)」已超过 3 小时未确认。请简短确认主人是否仍在做同样的事，如果变了就用 set_window_task 更新。"
        case .prolongedIdle(let idleSeconds):
            let minutes = Int(idleSeconds / 60)
            return "主人已经 \(minutes) 分钟没有操作电脑了。请简短问主人在做什么（比如吃饭、看手机），并用 record_away 工具记录。"
        }
    }
}
