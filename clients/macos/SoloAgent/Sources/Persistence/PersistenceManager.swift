import Foundation
import SwiftData

/// 本地数据持久化管理器 — 使用 SwiftData
@MainActor
final class PersistenceManager {
    static let shared = PersistenceManager()
    
    /// SwiftData 容器
    let container: ModelContainer
    
    /// 主上下文
    var context: ModelContext {
        container.mainContext
    }
    
    private init() {
        let schema = Schema([
            ActivityRecord.self,
            PendingReport.self,
            DailyStats.self,
            AppUsageRecord.self,
            PlayerRecord.self,
            QuestRecord.self,
            BuffRecord.self,
            ScreenshotRecord.self,
            BatchRecord.self,
            ActivityCardRecord.self,
        ])
        
        let config = ModelConfiguration(
            "SoloAgent",
            schema: schema,
            url: Self.databaseURL,
            allowsSave: true
        )
        
        do {
            container = try ModelContainer(for: schema, configurations: [config])
            Logger.info("💾 SwiftData 初始化完成: \(Self.databaseURL.path)")
        } catch {
            // 如果数据库损坏，删除重建
            Logger.error("💾 SwiftData 初始化失败，尝试重建: \(error)")
            try? FileManager.default.removeItem(at: Self.databaseURL)
            
            do {
                container = try ModelContainer(for: schema, configurations: [config])
                Logger.info("💾 SwiftData 重建完成")
            } catch {
                fatalError("💾 SwiftData 无法初始化: \(error)")
            }
        }
    }
    
    // MARK: - Database Path
    
    private static let databaseURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config")
            .appendingPathComponent("solo-agent")
            .appendingPathComponent("data")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("solo-agent.store")
    }()
    
    // MARK: - Activity Records
    
    /// 保存一条活动记录
    func saveActivityRecord(
        windowInfo: WindowInfo,
        idleSeconds: Double,
        isScreenLocked: Bool,
        screenshotPath: String? = nil,
        screenshotSize: Int = 0,
        activityState: String,
        isSynced: Bool = false
    ) {
        let record = ActivityRecord(
            timestamp: Date(),
            appName: windowInfo.appName,
            bundleId: windowInfo.bundleId,
            windowTitle: windowInfo.windowTitle,
            idleSeconds: idleSeconds,
            isScreenLocked: isScreenLocked,
            isSynced: isSynced,
            screenshotPath: screenshotPath,
            screenshotSize: screenshotSize,
            activityState: activityState
        )
        
        context.insert(record)
        save()
        
        // 同时更新每日统计
        updateDailyStats(with: record)
        // 更新应用使用记录
        if let bundleId = windowInfo.bundleId, let appName = windowInfo.appName {
            updateAppUsage(bundleId: bundleId, appName: appName)
        }
    }
    
    /// 获取今日活动记录数量
    func todayActivityCount() -> Int {
        let startOfDay = Calendar.current.startOfDay(for: Date())
        let predicate = #Predicate<ActivityRecord> { record in
            record.timestamp >= startOfDay
        }
        let descriptor = FetchDescriptor<ActivityRecord>(predicate: predicate)
        return (try? context.fetchCount(descriptor)) ?? 0
    }
    
    /// 获取最近的活动记录
    func recentActivities(limit: Int = 50) -> [ActivityRecord] {
        var descriptor = FetchDescriptor<ActivityRecord>(
            sortBy: [SortDescriptor(\.timestamp, order: .reverse)]
        )
        descriptor.fetchLimit = limit
        return (try? context.fetch(descriptor)) ?? []
    }
    
    // MARK: - Timeline Queries

    /// 查询指定时间范围内有截图的活动记录
    func activitiesWithScreenshots(from startDate: Date, to endDate: Date) -> [ActivityRecord] {
        let predicate = #Predicate<ActivityRecord> { record in
            record.timestamp >= startDate &&
            record.timestamp <= endDate &&
            record.screenshotPath != nil
        }
        let descriptor = FetchDescriptor<ActivityRecord>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.timestamp, order: .reverse)]
        )
        return (try? context.fetch(descriptor)) ?? []
    }

    /// 查询今天有截图的活动记录
    func todayActivitiesWithScreenshots() -> [ActivityRecord] {
        let startOfDay = Calendar.current.startOfDay(for: Date())
        return activitiesWithScreenshots(from: startOfDay, to: Date())
    }

    /// 查询最近 24 小时有截图的活动记录
    func last24hActivitiesWithScreenshots() -> [ActivityRecord] {
        let cutoff = Date().addingTimeInterval(-24 * 3600)
        return activitiesWithScreenshots(from: cutoff, to: Date())
    }

    /// 清理过期活动记录 (默认保留 7 天)
    func cleanupOldRecords(olderThan days: Int = 7) {
        let cutoff = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        let predicate = #Predicate<ActivityRecord> { record in
            record.timestamp < cutoff
        }
        
        do {
            try context.delete(model: ActivityRecord.self, where: predicate)
            save()
            Logger.info("🧹 清理了 \(days) 天前的活动记录")
        } catch {
            Logger.error("清理活动记录失败: \(error)")
        }
    }
    
    // MARK: - Pending Reports (离线队列)
    
    /// 缓存一个待上报的 report
    func cachePendingReport(deviceId: String, reportData: Data) {
        let pending = PendingReport(
            deviceId: deviceId,
            reportData: reportData
        )
        context.insert(pending)
        save()
        Logger.debug("💾 报告已入库 (待上报)")
    }
    
    /// 获取所有待发送的 reports
    func fetchPendingReports(limit: Int = 50) -> [PendingReport] {
        var descriptor = FetchDescriptor<PendingReport>(
            sortBy: [SortDescriptor(\.timestamp)]
        )
        descriptor.fetchLimit = limit
        return (try? context.fetch(descriptor)) ?? []
    }
    
    /// 删除已成功发送的 report
    func removePendingReport(_ report: PendingReport) {
        context.delete(report)
        save()
    }
    
    /// 标记 report 重试失败
    func markRetryFailed(_ report: PendingReport, error: String) {
        report.retryCount += 1
        report.lastAttempt = Date()
        report.lastError = error
        save()
    }
    
    /// 清理超过最大重试次数的 reports
    func cleanupFailedReports(maxRetries: Int = 10) {
        let predicate = #Predicate<PendingReport> { report in
            report.retryCount >= maxRetries
        }
        
        do {
            try context.delete(model: PendingReport.self, where: predicate)
            save()
        } catch {
            Logger.error("清理失败报告失败: \(error)")
        }
    }
    
    // MARK: - Daily Stats
    
    /// 获取或创建今日统计
    func todayStats() -> DailyStats {
        let startOfDay = Calendar.current.startOfDay(for: Date())
        let predicate = #Predicate<DailyStats> { stats in
            stats.date == startOfDay
        }
        let descriptor = FetchDescriptor<DailyStats>(predicate: predicate)
        
        if let existing = try? context.fetch(descriptor).first {
            return existing
        }
        
        let stats = DailyStats(date: startOfDay)
        context.insert(stats)
        save()
        return stats
    }
    
    /// 更新每日统计
    private func updateDailyStats(with record: ActivityRecord) {
        let stats = todayStats()
        stats.captureCount += 1
        stats.totalScreenshotBytes += record.screenshotSize
        
        if record.isSynced {
            stats.syncedCount += 1
        }
        
        // 根据活动状态累计时间 (用捕捉间隔近似)
        let interval: Double = 30 // 近似值
        switch record.activityState {
        case "active":
            stats.activeSeconds += interval
        case "idle":
            stats.idleSeconds += interval
        case "deepIdle":
            stats.idleSeconds += interval
        case "locked":
            stats.lockedSeconds += interval
        default:
            break
        }
        
        save()
    }
    
    /// 获取最近 N 天的统计
    func recentDailyStats(days: Int = 7) -> [DailyStats] {
        let cutoff = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        let predicate = #Predicate<DailyStats> { stats in
            stats.date >= cutoff
        }
        let descriptor = FetchDescriptor<DailyStats>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.date, order: .reverse)]
        )
        return (try? context.fetch(descriptor)) ?? []
    }
    
    // MARK: - App Usage
    
    /// 更新应用使用记录
    private func updateAppUsage(bundleId: String, appName: String) {
        let startOfDay = Calendar.current.startOfDay(for: Date())
        let predicate = #Predicate<AppUsageRecord> { record in
            record.date == startOfDay && record.bundleId == bundleId
        }
        let descriptor = FetchDescriptor<AppUsageRecord>(predicate: predicate)
        
        if let existing = try? context.fetch(descriptor).first {
            existing.foregroundSeconds += 30 // 近似一个捕捉间隔
            existing.lastUsed = Date()
        } else {
            let record = AppUsageRecord(
                date: startOfDay,
                appName: appName,
                bundleId: bundleId,
                foregroundSeconds: 30,
                activationCount: 1,
                lastUsed: Date()
            )
            context.insert(record)
        }
        
        save()
        
        // 更新每日统计中的 top app
        updateTopApp()
    }
    
    /// 记录应用切换
    func recordAppActivation(bundleId: String, appName: String) {
        let startOfDay = Calendar.current.startOfDay(for: Date())
        let predicate = #Predicate<AppUsageRecord> { record in
            record.date == startOfDay && record.bundleId == bundleId
        }
        let descriptor = FetchDescriptor<AppUsageRecord>(predicate: predicate)
        
        if let existing = try? context.fetch(descriptor).first {
            existing.activationCount += 1
            existing.lastUsed = Date()
        } else {
            let record = AppUsageRecord(
                date: startOfDay,
                appName: appName,
                bundleId: bundleId,
                activationCount: 1,
                lastUsed: Date()
            )
            context.insert(record)
        }
        
        // 更新窗口切换计数
        let stats = todayStats()
        stats.windowSwitchCount += 1
        
        save()
    }
    
    /// 获取今日 Top 应用
    func todayTopApps(limit: Int = 10) -> [AppUsageRecord] {
        let startOfDay = Calendar.current.startOfDay(for: Date())
        let predicate = #Predicate<AppUsageRecord> { record in
            record.date == startOfDay
        }
        var descriptor = FetchDescriptor<AppUsageRecord>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.foregroundSeconds, order: .reverse)]
        )
        descriptor.fetchLimit = limit
        return (try? context.fetch(descriptor)) ?? []
    }
    
    /// 更新每日统计中的最常用应用
    private func updateTopApp() {
        let stats = todayStats()
        let topApps = todayTopApps(limit: 1)
        
        if let top = topApps.first {
            stats.topAppBundleId = top.bundleId
            stats.topAppSeconds = top.foregroundSeconds
        }
        
        let startOfDay = Calendar.current.startOfDay(for: Date())
        let predicate = #Predicate<AppUsageRecord> { record in
            record.date == startOfDay
        }
        let descriptor = FetchDescriptor<AppUsageRecord>(predicate: predicate)
        stats.uniqueAppCount = (try? context.fetchCount(descriptor)) ?? 0
        
        save()
    }
    
    // MARK: - Screenshot Records (批次分析)

    /// 查询指定日期的所有截图记录，按 capturedAt 升序
    func screenshotsForDate(_ date: Date) -> [ScreenshotRecord] {
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: date)
        let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay) ?? date
        let startTs = Int(startOfDay.timeIntervalSince1970)
        let endTs = Int(endOfDay.timeIntervalSince1970)

        let predicate = #Predicate<ScreenshotRecord> { record in
            record.capturedAt >= startTs && record.capturedAt < endTs
        }
        let descriptor = FetchDescriptor<ScreenshotRecord>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.capturedAt)]
        )
        return (try? context.fetch(descriptor)) ?? []
    }

    func saveScreenshotRecord(filePath: String, fileSize: Int, capturedAt: Int) {
        let record = ScreenshotRecord(
            capturedAt: capturedAt,
            filePath: filePath,
            fileSize: fileSize
        )
        context.insert(record)
        save()
    }

    func unprocessedScreenshots() -> [ScreenshotRecord] {
        let predicate = #Predicate<ScreenshotRecord> { record in
            record.batchId == nil
        }
        // 最新的截图优先处理，让用户尽快看到当前活动的分析结果
        var descriptor = FetchDescriptor<ScreenshotRecord>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.capturedAt, order: .reverse)]
        )
        // 限制每次处理量，避免一次加载太多
        descriptor.fetchLimit = 500
        let results = (try? context.fetch(descriptor)) ?? []
        // 返回时按时间正序，供 createBatches 正确分割
        return results.reversed()
    }

    func markScreenshotsAsBatched(_ records: [ScreenshotRecord], batchId: String) {
        for record in records {
            record.batchId = batchId
        }
        save()
    }

    // MARK: - Batch Records

    /// 查询指定日期的所有批次记录，按 startTs 升序
    func batchesForDate(_ date: Date) -> [BatchRecord] {
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: date)
        let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay) ?? date
        let startTs = Int(startOfDay.timeIntervalSince1970)
        let endTs = Int(endOfDay.timeIntervalSince1970)

        let predicate = #Predicate<BatchRecord> { record in
            record.startTs >= startTs && record.startTs < endTs
        }
        let descriptor = FetchDescriptor<BatchRecord>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.startTs)]
        )
        return (try? context.fetch(descriptor)) ?? []
    }

    func saveBatch(_ batch: BatchRecord) {
        context.insert(batch)
        save()
    }

    func updateBatchStatus(_ batchId: String, status: String, videoPath: String? = nil, errorMessage: String? = nil) {
        let predicate = #Predicate<BatchRecord> { record in
            record.id == batchId
        }
        let descriptor = FetchDescriptor<BatchRecord>(predicate: predicate)
        guard let batch = try? context.fetch(descriptor).first else { return }
        batch.status = status
        if let videoPath { batch.videoPath = videoPath }
        if let errorMessage { batch.errorMessage = errorMessage }
        save()
    }

    func pendingBatches() -> [BatchRecord] {
        let pendingStatus = "pending"
        let predicate = #Predicate<BatchRecord> { record in
            record.status == pendingStatus
        }
        let descriptor = FetchDescriptor<BatchRecord>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.startTs)]
        )
        return (try? context.fetch(descriptor)) ?? []
    }

    func screenshotsForBatch(_ batchId: String) -> [ScreenshotRecord] {
        let predicate = #Predicate<ScreenshotRecord> { record in
            record.batchId == batchId
        }
        let descriptor = FetchDescriptor<ScreenshotRecord>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.capturedAt)]
        )
        return (try? context.fetch(descriptor)) ?? []
    }

    func batchRecord(for batchId: String) -> BatchRecord? {
        let predicate = #Predicate<BatchRecord> { record in
            record.id == batchId
        }
        let descriptor = FetchDescriptor<BatchRecord>(predicate: predicate)
        return try? context.fetch(descriptor).first
    }

    // MARK: - Activity Card Records

    func saveActivityCards(_ cards: [ActivityCardRecord]) {
        for card in cards {
            context.insert(card)
        }
        save()
    }

    func activityCards(for date: Date) -> [ActivityCardRecord] {
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: date)
        let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay) ?? date
        let startTs = Int(startOfDay.timeIntervalSince1970)
        let endTs = Int(endOfDay.timeIntervalSince1970)

        let predicate = #Predicate<ActivityCardRecord> { card in
            card.startTs >= startTs && card.startTs < endTs
        }
        let descriptor = FetchDescriptor<ActivityCardRecord>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.startTs)]
        )
        return (try? context.fetch(descriptor)) ?? []
    }

    func allActivityCardsToday() -> [ActivityCardRecord] {
        activityCards(for: Date())
    }

    func deleteActivityCards(forBatch batchId: String) {
        let targetBatchId = batchId
        let predicate = #Predicate<ActivityCardRecord> { card in
            card.batchId == targetBatchId
        }
        let descriptor = FetchDescriptor<ActivityCardRecord>(predicate: predicate)
        guard let cards = try? context.fetch(descriptor) else { return }
        for card in cards {
            context.delete(card)
        }
        save()
    }

    // MARK: - Storage Info
    
    /// 数据库文件大小
    var databaseSize: String {
        let url = Self.databaseURL
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? Int else {
            return "未知"
        }
        
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(size))
    }
    
    /// 总记录数统计
    func recordCounts() -> (activities: Int, pending: Int, dailyStats: Int, appUsage: Int) {
        let activities = (try? context.fetchCount(FetchDescriptor<ActivityRecord>())) ?? 0
        let pending = (try? context.fetchCount(FetchDescriptor<PendingReport>())) ?? 0
        let daily = (try? context.fetchCount(FetchDescriptor<DailyStats>())) ?? 0
        let appUsage = (try? context.fetchCount(FetchDescriptor<AppUsageRecord>())) ?? 0
        return (activities, pending, daily, appUsage)
    }
    
    // MARK: - Player Persistence

    func savePlayer(_ player: Player) {
        let descriptor = FetchDescriptor<PlayerRecord>()
        if let existing = try? context.fetch(descriptor).first {
            existing.update(from: player)
        } else {
            let record = PlayerRecord()
            record.update(from: player)
            context.insert(record)
        }
        save()
    }

    func loadPlayer() -> Player? {
        let descriptor = FetchDescriptor<PlayerRecord>()
        guard let record = try? context.fetch(descriptor).first else { return nil }
        return record.toPlayer()
    }

    // MARK: - Quest Persistence

    func saveQuest(_ quest: Quest) {
        let questId = quest.id
        let predicate = #Predicate<QuestRecord> { record in
            record.questId == questId
        }
        let descriptor = FetchDescriptor<QuestRecord>(predicate: predicate)

        if let existing = try? context.fetch(descriptor).first {
            existing.update(from: quest)
        } else {
            let record = QuestRecord(
                questId: quest.id,
                type: quest.type.rawValue,
                title: quest.title,
                questDescription: quest.description,
                difficulty: quest.difficulty.rawValue,
                status: quest.status.rawValue,
                expReward: quest.expReward,
                source: quest.source,
                context: quest.context,
                deadline: quest.deadline,
                createdAt: quest.createdAt,
                completedAt: quest.completedAt
            )
            context.insert(record)
        }
        save()
    }

    func loadActiveQuests() -> [Quest] {
        let activeStatus = QuestStatus.active.rawValue
        let predicate = #Predicate<QuestRecord> { record in
            record.status == activeStatus
        }
        let descriptor = FetchDescriptor<QuestRecord>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        let records = (try? context.fetch(descriptor)) ?? []
        return records.map { $0.toQuest() }
    }

    // MARK: - Buff Persistence

    func saveBuff(_ buff: ActiveBuff) {
        let buffId = buff.id
        let predicate = #Predicate<BuffRecord> { record in
            record.buffId == buffId
        }
        let descriptor = FetchDescriptor<BuffRecord>(predicate: predicate)

        if let existing = try? context.fetch(descriptor).first {
            existing.update(from: buff)
        } else {
            let record = BuffRecord(buffId: buff.id, name: buff.name)
            record.update(from: buff)
            context.insert(record)
        }
        save()
    }

    func loadActiveBuffs() -> [ActiveBuff] {
        let descriptor = FetchDescriptor<BuffRecord>()
        let records = (try? context.fetch(descriptor)) ?? []
        return records.map { $0.toBuff() }.filter { !$0.isExpired }
    }

    // MARK: - Save

    private func save() {
        do {
            try context.save()
        } catch {
            Logger.error("💾 SwiftData 保存失败: \(error)")
        }
    }
}
