import Foundation
import Combine

/// Agent 核心管理器 — 协调所有子系统
@MainActor
final class AgentManager: ObservableObject {
    static let shared = AgentManager()
    
    // MARK: - Published State
    @Published var isCapturing: Bool = false
    @Published var isConnected: Bool = false
    @Published var isPaused: Bool = false        // 隐私模式
    @Published var statusText: String = "就绪"
    @Published var lastCaptureTime: Date? = nil
    @Published var captureCount: Int = 0
    @Published var deviceId: String = ""
    @Published var pendingReportCount: Int = 0   // 待上报数量
    
    // MARK: - Sub-systems
    let config: AgentConfig
    let screenCapture: ScreenCaptureService
    let windowMonitor: WindowMonitorService
    let networkClient: NetworkClient
    let notificationService: NotificationService
    let captureStrategy: CaptureStrategy
    let persistence: PersistenceManager
    
    // MARK: - Internal
    private var captureTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?
    private var cleanupTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    
    private init() {
        self.config = AgentConfig.load()
        self.screenCapture = ScreenCaptureService()
        self.windowMonitor = WindowMonitorService()
        self.networkClient = NetworkClient(config: config)
        self.notificationService = NotificationService()
        self.captureStrategy = CaptureStrategy()
        self.persistence = PersistenceManager.shared
        self.deviceId = config.deviceId
        
        // 从本地数据库恢复今日计数
        self.captureCount = persistence.todayActivityCount()
    }
    
    // MARK: - Lifecycle
    
    func initialize() async {
        Logger.info("🚀 Solo Agent 启动中...")
        
        // 1. 请求屏幕捕捉权限
        let hasPermission = await screenCapture.requestPermission()
        guard hasPermission else {
            Logger.error("❌ 屏幕捕捉权限被拒绝")
            statusText = "需要屏幕权限"
            return
        }
        
        // 2. 初始化窗口监控
        windowMonitor.startMonitoring()
        
        // 3. 监听窗口切换 → 记录到数据库
        windowMonitor.onWindowSwitch = { [weak self] oldInfo, newInfo in
            guard let self = self else { return }
            Task { @MainActor in
                if let bundleId = newInfo.bundleId, let appName = newInfo.appName {
                    self.persistence.recordAppActivation(bundleId: bundleId, appName: appName)
                }
            }
        }
        
        // 4. 连接服务器
        await connectToServer()
        
        // 5. 请求通知权限
        await notificationService.requestPermission()
        
        // 6. 开始捕捉循环
        startCapturing()
        
        // 7. 启动后台同步 (发送离线缓存)
        startSyncLoop()
        
        // 8. 启动定时清理
        startCleanupLoop()
        
        // 9. 日志数据库状态
        let counts = persistence.recordCounts()
        Logger.info("📊 数据库: \(counts.activities) 活动, \(counts.pending) 待发, \(counts.dailyStats) 日统计, \(counts.appUsage) 应用记录")
        Logger.info("💾 数据库大小: \(persistence.databaseSize)")
        
        Logger.info("✅ Solo Agent 已就绪")
        statusText = "运行中"
    }
    
    func shutdown() async {
        Logger.info("🛑 Solo Agent 关闭中...")
        stopCapturing()
        heartbeatTask?.cancel()
        syncTask?.cancel()
        cleanupTask?.cancel()
        await networkClient.disconnect()
        windowMonitor.stopMonitoring()
        Logger.info("👋 Solo Agent 已关闭")
    }
    
    // MARK: - Capture Control
    
    func startCapturing() {
        guard !isCapturing else { return }
        isCapturing = true
        statusText = "运行中"
        
        captureTask = Task {
            await captureLoop()
        }
        
        // 启动心跳
        heartbeatTask = Task {
            await heartbeatLoop()
        }
        
        Logger.info("▶️ 开始捕捉")
    }
    
    func stopCapturing() {
        captureTask?.cancel()
        captureTask = nil
        isCapturing = false
        statusText = "已暂停"
        Logger.info("⏸ 停止捕捉")
    }
    
    func togglePause() {
        isPaused.toggle()
        statusText = isPaused ? "隐私模式" : "运行中"
        Logger.info(isPaused ? "🔒 进入隐私模式" : "🔓 退出隐私模式")
    }
    
    // MARK: - Core Loop
    
    /// 主捕捉循环 — 根据策略动态调整间隔
    private func captureLoop() async {
        while !Task.isCancelled {
            // 隐私模式下跳过
            if isPaused {
                try? await Task.sleep(for: .seconds(5))
                continue
            }
            
            // 获取当前活动状态
            let activityState = windowMonitor.currentActivityState
            let interval = captureStrategy.getInterval(for: activityState)
            
            // 锁屏不截图
            if activityState == .screenLocked {
                // 但仍记录锁屏状态
                persistence.saveActivityRecord(
                    windowInfo: .empty,
                    idleSeconds: windowMonitor.idleSeconds,
                    isScreenLocked: true,
                    activityState: "locked"
                )
                try? await Task.sleep(for: .seconds(60))
                continue
            }
            
            // 执行捕捉 + 上报
            await performCapture()
            
            // 等待下一次捕捉
            try? await Task.sleep(for: .seconds(interval))
        }
    }
    
    /// 执行一次捕捉并上报
    private func performCapture() async {
        do {
            // 1. 检查隐私排除
            let windowInfo = windowMonitor.currentWindowInfo
            if ImageProcessor.containsSensitiveContent(
                windowTitle: windowInfo.windowTitle,
                bundleId: windowInfo.bundleId,
                config: config
            ) {
                // 记录活动但不截图
                persistence.saveActivityRecord(
                    windowInfo: windowInfo,
                    idleSeconds: windowMonitor.idleSeconds,
                    isScreenLocked: false,
                    activityState: activityStateString(windowMonitor.currentActivityState)
                )
                Logger.debug("🔒 跳过截图 (隐私保护): \(windowInfo.description)")
                return
            }
            
            // 2. 截屏
            guard let screenshot = await screenCapture.captureScreen() else {
                Logger.warning("截屏返回空")
                return
            }
            
            // 3. 压缩截图
            let compressed = ImageProcessor.compress(
                screenshot,
                maxWidth: config.captureMaxWidth,
                jpegQuality: config.captureJpegQuality
            )
            
            let screenshotSize = compressed?.count ?? 0

            // 4. 保存截图到本地
            var screenshotRelativePath: String? = nil
            if let compressed = compressed {
                screenshotRelativePath = ScreenshotStorageManager.shared.saveScreenshot(
                    imageData: compressed, appName: windowInfo.appName
                )
            }

            // 5. 构建上报数据
            let report = AgentReport(
                deviceId: config.deviceId,
                timestamp: Date(),
                snapshot: Snapshot(
                    screenshotData: compressed,
                    activeWindow: windowInfo,
                    idleSeconds: windowMonitor.idleSeconds,
                    isScreenLocked: windowMonitor.isScreenLocked
                )
            )
            
            // 6. 上报服务器
            let success = await networkClient.sendReport(report)

            // 7. 保存活动记录到本地数据库
            let stateStr = activityStateString(windowMonitor.currentActivityState)
            persistence.saveActivityRecord(
                windowInfo: windowInfo,
                idleSeconds: windowMonitor.idleSeconds,
                isScreenLocked: windowMonitor.isScreenLocked,
                screenshotPath: screenshotRelativePath,
                screenshotSize: screenshotSize,
                activityState: stateStr,
                isSynced: success
            )

            if success {
                captureCount += 1
                lastCaptureTime = Date()
            } else {
                // 8. 上报失败 → 存入离线队列
                if let reportData = try? JSONEncoder().encode(report) {
                    persistence.cachePendingReport(deviceId: config.deviceId, reportData: reportData)
                    pendingReportCount = persistence.fetchPendingReports(limit: 1000).count
                }
            }
            
        } catch {
            Logger.error("捕捉失败: \(error.localizedDescription)")
        }
    }
    
    /// 心跳循环 — 维持与服务器的连接
    private func heartbeatLoop() async {
        while !Task.isCancelled {
            let connected = await networkClient.sendHeartbeat(deviceId: config.deviceId)
            isConnected = connected
            try? await Task.sleep(for: .seconds(30))
        }
    }
    
    // MARK: - Sync Loop (离线数据重传)
    
    /// 后台同步循环 — 定期重传离线缓存
    private func startSyncLoop() {
        syncTask = Task {
            while !Task.isCancelled {
                // 每 2 分钟尝试一次
                try? await Task.sleep(for: .seconds(120))
                
                guard isConnected else { continue }
                
                let pending = persistence.fetchPendingReports(limit: 20)
                guard !pending.isEmpty else { continue }
                
                Logger.info("📤 同步 \(pending.count) 条离线数据...")
                
                for report in pending {
                    do {
                        let decoder = JSONDecoder()
                        decoder.dateDecodingStrategy = .iso8601
                        let agentReport = try decoder.decode(AgentReport.self, from: report.reportData)
                        
                        let success = await networkClient.sendReport(agentReport)
                        if success {
                            persistence.removePendingReport(report)
                        } else {
                            persistence.markRetryFailed(report, error: "上报失败")
                        }
                    } catch {
                        persistence.markRetryFailed(report, error: error.localizedDescription)
                    }
                }
                
                pendingReportCount = persistence.fetchPendingReports(limit: 1000).count
            }
        }
    }
    
    // MARK: - Cleanup Loop
    
    /// 定期清理旧数据
    private func startCleanupLoop() {
        cleanupTask = Task {
            while !Task.isCancelled {
                // 每 6 小时清理一次
                try? await Task.sleep(for: .seconds(6 * 3600))
                
                persistence.cleanupOldRecords(olderThan: 7)
                persistence.cleanupFailedReports(maxRetries: 10)
                ScreenshotStorageManager.shared.cleanupOldScreenshots(olderThanHours: 48)

                Logger.info("🧹 定期清理完成, 数据库大小: \(persistence.databaseSize), 截图占用: \(ScreenshotStorageManager.shared.totalDiskUsage())")
            }
        }
    }
    
    // MARK: - Server Connection
    
    private func connectToServer() async {
        do {
            try await networkClient.connect()
            isConnected = true
            
            // 监听服务器推送
            networkClient.onNotification = { [weak self] notification in
                Task { @MainActor in
                    self?.notificationService.show(notification)
                }
            }
            
            Logger.info("🔗 已连接服务器: \(config.serverURL)")
        } catch {
            Logger.warning("⚠️ 无法连接服务器: \(error.localizedDescription)")
            isConnected = false
            // 离线模式 — 本地数据库会缓存所有数据
        }
    }
    
    // MARK: - Helpers
    
    private func activityStateString(_ state: CaptureStrategy.ActivityState) -> String {
        switch state {
        case .active: return "active"
        case .idle: return "idle"
        case .deepIdle: return "deepIdle"
        case .screenLocked: return "locked"
        case .windowSwitched: return "active"
        }
    }
}
