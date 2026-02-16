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
    
    // MARK: - Sub-systems
    let config: AgentConfig
    let screenCapture: ScreenCaptureService
    let windowMonitor: WindowMonitorService
    let networkClient: NetworkClient
    let notificationService: NotificationService
    let captureStrategy: CaptureStrategy
    
    // MARK: - Internal
    private var captureTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    
    private init() {
        self.config = AgentConfig.load()
        self.screenCapture = ScreenCaptureService()
        self.windowMonitor = WindowMonitorService()
        self.networkClient = NetworkClient(config: config)
        self.notificationService = NotificationService()
        self.captureStrategy = CaptureStrategy()
        self.deviceId = config.deviceId
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
        
        // 3. 连接服务器
        await connectToServer()
        
        // 4. 请求通知权限
        await notificationService.requestPermission()
        
        // 5. 开始捕捉循环
        startCapturing()
        
        Logger.info("✅ Solo Agent 已就绪")
        statusText = "运行中"
    }
    
    func shutdown() async {
        Logger.info("🛑 Solo Agent 关闭中...")
        stopCapturing()
        heartbeatTask?.cancel()
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
            
            // 执行捕捉 + 上报
            await performCapture()
            
            // 等待下一次捕捉
            try? await Task.sleep(for: .seconds(interval))
        }
    }
    
    /// 执行一次捕捉并上报
    private func performCapture() async {
        do {
            // 1. 截屏
            guard let screenshot = await screenCapture.captureScreen() else {
                Logger.warning("截屏返回空")
                return
            }
            
            // 2. 获取窗口信息
            let windowInfo = windowMonitor.currentWindowInfo
            
            // 3. 压缩截图
            let compressed = ImageProcessor.compress(
                screenshot,
                maxWidth: config.captureMaxWidth,
                jpegQuality: config.captureJpegQuality
            )
            
            // 4. 构建上报数据
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
            
            // 5. 上报服务器
            let success = await networkClient.sendReport(report)
            
            if success {
                captureCount += 1
                lastCaptureTime = Date()
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
            // 离线模式 — 本地缓存截图
        }
    }
}
