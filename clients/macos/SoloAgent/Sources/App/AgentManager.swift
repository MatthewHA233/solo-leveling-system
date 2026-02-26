import Foundation
import Combine

/// Agent 核心管理器 — 协调所有子系统
@MainActor
final class AgentManager: ObservableObject {
    static let shared = AgentManager()

    // MARK: - Published State
    @Published var isCapturing: Bool = false
    @Published var isPaused: Bool = false        // 隐私模式
    @Published var statusText: String = "就绪"
    @Published var lastCaptureTime: Date? = nil
    @Published var captureCount: Int = 0
    @Published var deviceId: String = ""

    // MARK: - Game Engine Published State
    @Published var player: Player = Player()
    @Published var activeQuests: [Quest] = []
    @Published var activeBuffs: [ActiveBuff] = []
    @Published var activityCardsUpdated: Date = Date(timeIntervalSince1970: 0)

    // MARK: - Sub-systems
    private(set) var config: AgentConfig
    let screenCapture: ScreenCaptureService
    let windowMonitor: WindowMonitorService
    let notificationService: NotificationService
    let captureStrategy: CaptureStrategy
    let persistence: PersistenceManager

    // MARK: - Game Engine
    let gameEventBus: GameEventBus
    let activityFeed = ActivityFeed()
    var playerManager: PlayerManager?
    var questEngine: QuestEngine?
    var expEngine: ExpEngine?
    let ruleClassifier = RuleClassifier()

    // MARK: - AI Client & Batch Processing
    private var aiClient: AIClient?
    private var batchManager: BatchManager?

    // MARK: - Internal
    private var captureTask: Task<Void, Never>?
    private var cleanupTask: Task<Void, Never>?
    private var gameTickTask: Task<Void, Never>?
    private var batchProcessingTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()

    private init() {
        // 调试：确认 AgentManager 被初始化
        let dbg = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/solo-agent/manager-init-debug.log")
        try? "AgentManager INIT \(Date())\n".data(using: .utf8)?.write(to: dbg)

        self.config = AgentConfig.load()
        self.screenCapture = ScreenCaptureService()
        self.windowMonitor = WindowMonitorService()
        self.notificationService = NotificationService()
        self.captureStrategy = CaptureStrategy()
        self.captureStrategy.activeInterval = config.screenshotInterval
        self.persistence = PersistenceManager.shared
        self.deviceId = config.deviceId
        self.gameEventBus = GameEventBus()

        // 从本地数据库恢复今日计数
        self.captureCount = persistence.todayActivityCount()

        // 初始化 AI Client (Gemini)
        if config.aiEnabled, let key = config.geminiApiKey, !key.isEmpty {
            let client = AIClient(config: config)
            self.aiClient = client
            self.batchManager = BatchManager(config: config, persistence: persistence, aiClient: client)
            Logger.info("🤖 AI 分析已启用 (Gemini: \(config.geminiModel))")
        }

        // 初始化游戏引擎
        initGameEngine()
    }

    // MARK: - Game Engine Init

    private func initGameEngine() {
        // Load player from persistence or create new
        let savedPlayer = persistence.loadPlayer() ?? Player()
        self.player = savedPlayer

        let pm = PlayerManager(player: savedPlayer, eventBus: gameEventBus)
        self.playerManager = pm

        let qe = QuestEngine(playerManager: pm, eventBus: gameEventBus, persistence: persistence)
        self.questEngine = qe
        self.activeQuests = qe.activeQuests

        let ee = ExpEngine(playerManager: pm, eventBus: gameEventBus)
        self.expEngine = ee

        // Load active buffs
        let buffs = persistence.loadActiveBuffs()
        for buff in buffs {
            pm.applyBuff(buff)
        }
        self.activeBuffs = pm.player.activeBuffs

        // Sync game state to published properties
        gameEventBus.on(.expGained) { [weak self] _ in
            self?.syncGameState()
        }
        gameEventBus.on(.levelUp) { [weak self] _ in
            self?.syncGameState()
            // Save player on level up
            if let p = self?.playerManager?.player {
                self?.persistence.savePlayer(p)
            }
        }
        gameEventBus.on(.questCompleted) { [weak self] _ in
            self?.syncGameState()
        }
        gameEventBus.on(.questFailed) { [weak self] _ in
            self?.syncGameState()
        }
        gameEventBus.on(.buffActivated) { [weak self] _ in
            self?.syncGameState()
        }
        gameEventBus.on(.buffExpired) { [weak self] _ in
            self?.syncGameState()
        }

        // MARK: Activity Feed — 监听事件推送信息流
        subscribeActivityFeed()
    }

    /// 注册活动信息流事件监听
    private func subscribeActivityFeed() {
        // 经验获得
        gameEventBus.on(.expGained) { [weak self] event in
            guard let self else { return }
            let amount = event.data["amount"] as? Int ?? 0
            let source = event.data["source"] as? String ?? ""
            self.activityFeed.push(ActivityFeedItem(
                type: .exp,
                icon: "arrow.up.circle.fill",
                title: "经验 +\(amount)",
                subtitle: "来源: \(source)",
                expAmount: amount
            ))
        }

        // 任务触发
        gameEventBus.on(.questTriggered) { [weak self] event in
            guard let self else { return }
            let title = event.data["quest_title"] as? String ?? "新任务"
            let difficulty = event.data["difficulty"] as? String ?? ""
            let exp = event.data["exp_reward"] as? Int ?? 0
            self.activityFeed.push(ActivityFeedItem(
                type: .quest,
                icon: "exclamationmark.triangle.fill",
                title: "任务: \(title) | \(difficulty)级",
                subtitle: "奖励 \(exp) EXP",
                expAmount: exp
            ))
        }

        // 任务完成
        gameEventBus.on(.questCompleted) { [weak self] event in
            guard let self else { return }
            let title = event.data["quest_title"] as? String ?? "任务"
            let exp = event.data["exp_earned"] as? Int ?? 0
            self.activityFeed.push(ActivityFeedItem(
                type: .quest,
                icon: "checkmark.seal.fill",
                title: "完成: \(title)",
                subtitle: "获得 \(exp) EXP",
                expAmount: exp
            ))
        }

        // 任务失败
        gameEventBus.on(.questFailed) { [weak self] event in
            guard let self else { return }
            let title = event.data["quest_title"] as? String ?? "任务"
            let reason = event.data["reason"] as? String ?? "失败"
            self.activityFeed.push(ActivityFeedItem(
                type: .quest,
                icon: "xmark.seal.fill",
                title: "失败: \(title)",
                subtitle: reason == "expired" ? "已过期" : "任务失败"
            ))
        }

        // 等级提升
        gameEventBus.on(.levelUp) { [weak self] event in
            guard let self else { return }
            let level = event.data["new_level"] as? Int ?? 0
            let title = event.data["title"] as? String ?? ""
            self.activityFeed.push(ActivityFeedItem(
                type: .levelUp,
                icon: "star.fill",
                title: "等级提升！Lv.\(level)",
                subtitle: title
            ))
        }

        // Buff 激活
        gameEventBus.on(.buffActivated) { [weak self] event in
            guard let self else { return }
            let name = event.data["buff_name"] as? String ?? "Buff"
            self.activityFeed.push(ActivityFeedItem(
                type: .buff,
                icon: "bolt.fill",
                title: "效果激活: \(name)"
            ))
        }

        // Debuff 激活
        gameEventBus.on(.debuffActivated) { [weak self] event in
            guard let self else { return }
            let name = event.data["buff_name"] as? String ?? "Debuff"
            self.activityFeed.push(ActivityFeedItem(
                type: .buff,
                icon: "exclamationmark.octagon.fill",
                title: "负面效果: \(name)"
            ))
        }

        // 系统通知
        gameEventBus.on(.notificationPush) { [weak self] event in
            guard let self else { return }
            let title = event.data["title"] as? String ?? ""
            guard !title.isEmpty else { return }
            self.activityFeed.push(ActivityFeedItem(
                type: .system,
                icon: "bell.fill",
                title: title
            ))
        }
    }

    private func syncGameState() {
        guard let pm = playerManager, let qe = questEngine else { return }
        player = pm.player
        activeQuests = qe.activeQuests
        activeBuffs = pm.player.activeBuffs
    }

    // MARK: - Lifecycle

    func initialize() async {
        // 最早的调试点
        let earlyDebug = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/solo-agent/init-debug.log")
        try? "INIT START \(Date())\n".data(using: .utf8)?.write(to: earlyDebug)

        Logger.info("🚀 Solo Agent 启动中...")

        // 1. 请求屏幕捕捉权限
        let hasPermission = await screenCapture.requestPermission()
        try? "PERMISSION: \(hasPermission)\n".data(using: .utf8)?.write(to: earlyDebug)
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

        // 4. 请求通知权限
        await notificationService.requestPermission()

        // 5. 生成每日任务
        questEngine?.generateDailyQuests()
        syncGameState()

        // 6. 启动系统消息
        gameEventBus.emit(.systemStart)

        // 7. 开始捕捉循环
        startCapturing()

        // 8. 启动定时清理
        startCleanupLoop()

        // 9. 启动游戏引擎 tick
        startGameTickLoop()

        // 10. 启动批次处理循环
        startBatchProcessingLoop()

        // 11. 日志数据库状态
        let counts = persistence.recordCounts()
        Logger.info("📊 数据库: \(counts.activities) 活动, \(counts.dailyStats) 日统计, \(counts.appUsage) 应用记录")
        Logger.info("💾 数据库大小: \(persistence.databaseSize)")
        Logger.info("🎮 玩家: Lv.\(player.level) \(player.title) | EXP: \(player.exp)/\(player.expToNext)")
        if batchManager != nil {
            Logger.info("🤖 AI 分析: 已启用 (Gemini \(config.geminiModel), 视频批次模式)")
            AIClient.debugLog("✅ batchManager 已初始化, 模型: \(config.geminiModel)")
        } else {
            Logger.info("🤖 AI 分析: 未启用 (纯规则引擎模式)")
            AIClient.debugLog("❌ batchManager 为 nil, aiEnabled=\(config.aiEnabled), hasKey=\(config.geminiApiKey != nil)")
        }

        // 直接写文件调试
        let debugPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/solo-agent/agent-debug.log")
        let debugMsg = "[INIT] batchManager=\(batchManager != nil), aiEnabled=\(config.aiEnabled), hasKey=\(config.geminiApiKey != nil), model=\(config.geminiModel)\n"
        if let data = debugMsg.data(using: .utf8) {
            try? data.write(to: debugPath)
        }

        Logger.info("✅ Solo Agent 已就绪")
        statusText = "运行中"
    }

    func shutdown() async {
        Logger.info("🛑 Solo Agent 关闭中...")

        // Save game state
        if let pm = playerManager {
            persistence.savePlayer(pm.player)
        }

        gameEventBus.emit(.systemStop)

        stopCapturing()
        cleanupTask?.cancel()
        gameTickTask?.cancel()
        batchProcessingTask?.cancel()
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

    /// 执行一次捕捉 — 保存截图用于批次视频分析
    private func performCapture() async {
        do {
            // 1. 检查隐私排除
            let windowInfo = windowMonitor.currentWindowInfo
            if ImageProcessor.containsSensitiveContent(
                windowTitle: windowInfo.windowTitle,
                bundleId: windowInfo.bundleId,
                config: config
            ) {
                persistence.saveActivityRecord(
                    windowInfo: windowInfo,
                    idleSeconds: windowMonitor.idleSeconds,
                    isScreenLocked: false,
                    activityState: activityStateString(windowMonitor.currentActivityState)
                )
                Logger.debug("🔒 跳过截图 (隐私保护): \(windowInfo.description)")
                return
            }

            // 2. 规则引擎实时分类 (不等 AI 结果)
            let classification = ruleClassifier.classify(
                appName: windowInfo.appName,
                windowTitle: windowInfo.windowTitle
            )
            let focusScore = ruleClassifier.focusScore(for: classification.category)

            let appDisplayName = windowInfo.appName ?? "Unknown"
            gameEventBus.emit(.contextAnalyzed, data: [
                "category": classification.category.rawValue,
                "focus_score": focusScore,
                "confidence": classification.confidence,
                "detail": classification.detail,
                "app_name": appDisplayName,
                "window_title": windowInfo.windowTitle ?? "",
            ])

            let categoryIcon = ActivityFeed.iconForCategory(classification.category.rawValue)
            activityFeed.push(ActivityFeedItem(
                type: .capture,
                icon: categoryIcon,
                title: "\(appDisplayName) | \(classification.category.rawValue)",
                subtitle: "专注度 \(String(format: "%.1f", focusScore))"
            ))

            // 3. 截屏
            guard let screenshot = await screenCapture.captureScreen() else {
                Logger.warning("截屏返回空")
                return
            }

            // 4. 压缩截图
            let compressed = ImageProcessor.compress(
                screenshot,
                maxWidth: config.captureMaxWidth,
                jpegQuality: config.captureJpegQuality
            )

            let screenshotSize = compressed?.count ?? 0

            // 5. 保存截图到本地
            var screenshotRelativePath: String? = nil
            if let compressed = compressed {
                screenshotRelativePath = ScreenshotStorageManager.shared.saveScreenshot(
                    imageData: compressed, appName: windowInfo.appName
                )
            }

            // 6. 记录截图用于批次分析
            if let path = screenshotRelativePath {
                persistence.saveScreenshotRecord(
                    filePath: path,
                    fileSize: screenshotSize,
                    capturedAt: Int(Date().timeIntervalSince1970)
                )
            }

            // 7. 保存活动记录到本地数据库
            let stateStr = activityStateString(windowMonitor.currentActivityState)
            persistence.saveActivityRecord(
                windowInfo: windowInfo,
                idleSeconds: windowMonitor.idleSeconds,
                isScreenLocked: windowMonitor.isScreenLocked,
                screenshotPath: screenshotRelativePath,
                screenshotSize: screenshotSize,
                activityState: stateStr,
                isSynced: false
            )

            captureCount += 1
            lastCaptureTime = Date()

        } catch {
            Logger.error("捕捉失败: \(error.localizedDescription)")
        }
    }

    // MARK: - Batch Processing Loop

    /// 批次处理循环 — 每 60 秒检查并处理截屏批次
    private func startBatchProcessingLoop() {
        guard batchManager != nil else {
            Logger.info("📦 批次处理: 未启用 (无 AI 客户端)")
            return
        }

        batchProcessingTask = Task {
            // 初始延迟 30 秒，等待足够截图积累
            try? await Task.sleep(for: .seconds(30))

            while !Task.isCancelled {
                await batchManager?.checkAndProcessBatches()

                // 批次处理完成后，驱动游戏引擎
                await processBatchActivityCards()

                try? await Task.sleep(for: .seconds(60))
            }
        }

        Logger.info("📦 批次处理循环已启动 (每 60 秒检查)")
    }

    /// 处理新生成的活动卡片 — 驱动游戏引擎
    private func processBatchActivityCards() {
        let todayCards = persistence.allActivityCardsToday()
        for card in todayCards {
            // 根据 category 计算 EXP
            let category = card.category
            let durationMin = max(1, (card.endTs - card.startTs) / 60)

            // Emit contextAnalyzed 事件驱动 ExpEngine
            gameEventBus.emit(.contextAnalyzed, data: [
                "category": category,
                "focus_score": categoryFocusScore(category),
                "confidence": 0.95,
                "detail": card.title,
                "app_name": card.appSitePrimary ?? "",
                "window_title": card.title,
                "source": "batch_ai",
                "duration_min": durationMin,
            ])
        }

        // 通知昼夜表等视图刷新
        activityCardsUpdated = Date()
    }

    /// 根据活动类别返回默认专注度分数
    private func categoryFocusScore(_ category: String) -> Double {
        switch category {
        case "coding", "writing", "design", "creative": return 0.85
        case "learning", "research", "reading": return 0.8
        case "work", "meeting": return 0.7
        case "communication": return 0.5
        case "browsing": return 0.4
        case "social", "media", "gaming": return 0.2
        default: return 0.3
        }
    }


    // MARK: - Game Tick Loop

    /// 游戏引擎定期检查 — 过期任务、buff 清理、状态持久化
    private func startGameTickLoop() {
        gameTickTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))

                // Check expired quests
                questEngine?.checkExpiredQuests()
                questEngine?.cleanupOldQuests()

                // Clean expired buffs
                playerManager?.cleanupExpiredBuffs()

                // Periodic save
                if let pm = playerManager {
                    persistence.savePlayer(pm.player)
                }

                syncGameState()
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


    // MARK: - Config Reload

    /// 重新加载配置并应用到运行时（设置保存后调用）
    func reloadConfig() {
        let newConfig = AgentConfig.load()

        // 更新自身 config
        self.config = newConfig

        // 更新截图间隔
        captureStrategy.activeInterval = newConfig.screenshotInterval

        // 更新批次管理器配置
        batchManager?.config = newConfig

        // 触发 UI 刷新
        objectWillChange.send()

        Logger.info("🔄 配置已重载: 截图间隔=\(newConfig.screenshotInterval)s, 批次时长=\(Int(newConfig.batchTargetDuration/60))min")
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
