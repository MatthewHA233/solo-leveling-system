import Foundation
import SwiftData

// MARK: - 活动记录

/// 每次屏幕捕捉对应的活动记录
@Model
final class ActivityRecord {
    /// 记录时间
    var timestamp: Date
    
    /// 应用名称
    var appName: String?
    
    /// Bundle ID
    var bundleId: String?
    
    /// 窗口标题
    var windowTitle: String?
    
    /// 用户空闲秒数
    var idleSeconds: Double
    
    /// 屏幕是否锁定
    var isScreenLocked: Bool
    
    /// 是否已上报服务器
    var isSynced: Bool
    
    /// 截图文件路径 (相对路径, 存在本地)
    var screenshotPath: String?
    
    /// 截图大小 (bytes)
    var screenshotSize: Int
    
    /// 活动状态 ("active", "idle", "deepIdle", "locked")
    var activityState: String
    
    init(
        timestamp: Date = Date(),
        appName: String? = nil,
        bundleId: String? = nil,
        windowTitle: String? = nil,
        idleSeconds: Double = 0,
        isScreenLocked: Bool = false,
        isSynced: Bool = false,
        screenshotPath: String? = nil,
        screenshotSize: Int = 0,
        activityState: String = "active"
    ) {
        self.timestamp = timestamp
        self.appName = appName
        self.bundleId = bundleId
        self.windowTitle = windowTitle
        self.idleSeconds = idleSeconds
        self.isScreenLocked = isScreenLocked
        self.isSynced = isSynced
        self.screenshotPath = screenshotPath
        self.screenshotSize = screenshotSize
        self.activityState = activityState
    }
}

// MARK: - 待发送队列

/// 离线时缓存的待上报数据 (替代 JSON 文件缓存)
@Model
final class PendingReport {
    /// 创建时间
    var timestamp: Date
    
    /// 设备 ID
    var deviceId: String
    
    /// 报告 JSON 数据 (序列化后的 AgentReport)
    var reportData: Data
    
    /// 重试次数
    var retryCount: Int
    
    /// 最后尝试时间
    var lastAttempt: Date?
    
    /// 错误信息 (最后一次)
    var lastError: String?
    
    init(
        timestamp: Date = Date(),
        deviceId: String,
        reportData: Data,
        retryCount: Int = 0,
        lastAttempt: Date? = nil,
        lastError: String? = nil
    ) {
        self.timestamp = timestamp
        self.deviceId = deviceId
        self.reportData = reportData
        self.retryCount = retryCount
        self.lastAttempt = lastAttempt
        self.lastError = lastError
    }
}

// MARK: - 每日统计

/// 每日汇总统计
@Model
final class DailyStats {
    /// 日期 (当天 00:00:00)
    @Attribute(.unique) var date: Date
    
    /// 总捕捉次数
    var captureCount: Int
    
    /// 活跃时间 (秒)
    var activeSeconds: Double
    
    /// 空闲时间 (秒)
    var idleSeconds: Double
    
    /// 锁屏时间 (秒)
    var lockedSeconds: Double
    
    /// 窗口切换次数
    var windowSwitchCount: Int
    
    /// 使用的应用数量
    var uniqueAppCount: Int
    
    /// 最常用应用 (bundleId)
    var topAppBundleId: String?
    
    /// 最常用应用使用时间 (秒)
    var topAppSeconds: Double
    
    /// 上传的截图数量
    var syncedCount: Int
    
    /// 截图总大小 (bytes)
    var totalScreenshotBytes: Int
    
    init(
        date: Date,
        captureCount: Int = 0,
        activeSeconds: Double = 0,
        idleSeconds: Double = 0,
        lockedSeconds: Double = 0,
        windowSwitchCount: Int = 0,
        uniqueAppCount: Int = 0,
        topAppBundleId: String? = nil,
        topAppSeconds: Double = 0,
        syncedCount: Int = 0,
        totalScreenshotBytes: Int = 0
    ) {
        self.date = date
        self.captureCount = captureCount
        self.activeSeconds = activeSeconds
        self.idleSeconds = idleSeconds
        self.lockedSeconds = lockedSeconds
        self.windowSwitchCount = windowSwitchCount
        self.uniqueAppCount = uniqueAppCount
        self.topAppBundleId = topAppBundleId
        self.topAppSeconds = topAppSeconds
        self.syncedCount = syncedCount
        self.totalScreenshotBytes = totalScreenshotBytes
    }
}

// MARK: - 应用使用记录

/// 应用使用时长追踪 (每日每个应用一条)
@Model
final class AppUsageRecord {
    /// 日期 (当天 00:00:00)
    var date: Date
    
    /// 应用名称
    var appName: String
    
    /// Bundle ID
    var bundleId: String
    
    /// 前台使用时间 (秒)
    var foregroundSeconds: Double
    
    /// 窗口活跃次数 (切到前台的次数)
    var activationCount: Int
    
    /// 最后使用时间
    var lastUsed: Date?
    
    init(
        date: Date,
        appName: String,
        bundleId: String,
        foregroundSeconds: Double = 0,
        activationCount: Int = 0,
        lastUsed: Date? = nil
    ) {
        self.date = date
        self.appName = appName
        self.bundleId = bundleId
        self.foregroundSeconds = foregroundSeconds
        self.activationCount = activationCount
        self.lastUsed = lastUsed
    }
}
