import Foundation

/// 窗口-任务映射匹配器（内存缓存 + 数据库回查）
@MainActor
final class WindowTaskMatcher {
    static let shared = WindowTaskMatcher()

    /// 内存缓存：bundleId → [WindowTaskRecord]
    private var cache: [String: [WindowTaskRecord]] = [:]
    private var cacheLoadedAt: Date?

    /// 缓存有效期（秒）
    private let cacheTTL: TimeInterval = 300 // 5 分钟

    private init() {}

    // MARK: - 查询

    /// 查找当前窗口对应的任务映射，优先走缓存
    func match(bundleId: String, windowTitle: String?) -> WindowTaskRecord? {
        reloadCacheIfNeeded()

        guard let candidates = cache[bundleId], !candidates.isEmpty else {
            return nil
        }

        // 优先匹配 titlePattern
        if let title = windowTitle {
            let titleLower = title.lowercased()
            if let hit = candidates.first(where: { titleLower.contains($0.titlePattern.lowercased()) }) {
                return hit
            }
        }

        // 退而求其次：bundleId 唯一映射
        return candidates.first
    }

    /// 当前窗口是否有映射
    func hasMapping(bundleId: String, windowTitle: String?) -> Bool {
        match(bundleId: bundleId, windowTitle: windowTitle) != nil
    }

    // MARK: - 缓存管理

    /// 强制刷新缓存（新增/修改映射后调用）
    func invalidateCache() {
        cache.removeAll()
        cacheLoadedAt = nil
    }

    private func reloadCacheIfNeeded() {
        if let loadedAt = cacheLoadedAt,
           Date().timeIntervalSince(loadedAt) < cacheTTL {
            return
        }
        reloadCache()
    }

    private func reloadCache() {
        let records = PersistenceManager.shared.allWindowTasks()
        cache.removeAll()
        for record in records {
            cache[record.bundleId, default: []].append(record)
        }
        cacheLoadedAt = Date()
    }

    // MARK: - 生成上下文摘要

    /// 为 ContextAdvisor 生成窗口记忆注入文本
    func contextSummary(bundleId: String, windowTitle: String?) -> String? {
        guard let record = match(bundleId: bundleId, windowTitle: windowTitle) else {
            return nil
        }

        var lines: [String] = []
        lines.append("【主人确认】\(record.bundleId) + \"\(record.titlePattern)\" = \(record.taskDescription)")

        if let step = record.currentStep {
            lines.append("  当前步骤：\(step)")
        }
        if let category = record.category {
            lines.append("  活动类别：\(category)")
        }
        if let habit = record.habitDescription {
            lines.append("  习惯描述：\(habit)")
        }

        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.unitsStyle = .short
        let ago = formatter.localizedString(for: record.lastConfirmed, relativeTo: Date())
        lines.append("  确认时间：\(ago)")

        return lines.joined(separator: "\n")
    }
}
