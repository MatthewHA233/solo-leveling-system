import Foundation

/// Agent 配置
struct AgentConfig: Codable {
    /// 设备唯一标识
    var deviceId: String
    
    /// 设备友好名称
    var deviceName: String
    
    // MARK: - Capture Settings
    
    /// 截图最大宽度 (px)
    var captureMaxWidth: Int = 1280
    
    /// JPEG 压缩质量 (0.0 - 1.0)
    var captureJpegQuality: Double = 0.6
    
    /// 本地缓存截图数量上限
    var localCacheLimit: Int = 100
    
    /// 本地缓存过期时间 (秒)
    var localCacheTTL: TimeInterval = 3600
    
    // MARK: - AI Provider Settings

    /// AI 提供商: "gemini" | "openai"
    var aiProvider: String = "openai"

    /// 是否启用 AI 分析
    var aiEnabled: Bool = true

    // MARK: - Gemini AI Settings (legacy)

    /// Gemini API Key
    var geminiApiKey: String?

    /// Gemini API 基地址
    var geminiApiBase: String = "https://generativelanguage.googleapis.com"

    /// Gemini 模型名
    var geminiModel: String = "gemini-2.0-flash"

    // MARK: - OpenAI Compatible Settings (千问)

    /// API Key（阿里百炼 / OpenAI 兼容）
    var openaiApiKey: String?

    /// API 基地址（默认阿里百炼）
    var openaiApiBase: String = "https://dashscope.aliyuncs.com/compatible-mode"

    /// Phase 1 转录模型（轻量快速）
    var openaiModel: String = "qwen-vl-max"

    /// Phase 2 卡片生成模型（理解力强）
    var openaiCardModel: String = "qwen-plus"

    // MARK: - Batch Analysis Settings

    /// 批次目标时长 (秒, 5分钟)
    var batchTargetDuration: TimeInterval = 300

    /// 批次最大间隔阈值 (秒, 超过则断开新批次)
    var batchMaxGap: TimeInterval = 120

    /// 批次最小有效时长 (秒, 低于则跳过)
    var batchMinDuration: TimeInterval = 150

    /// 截屏间隔 (秒)
    var screenshotInterval: TimeInterval = 2

    // MARK: - Video Settings

    /// 视频最大高度 (px)
    var videoMaxHeight: Int = 720

    /// 视频播放帧率 (fps)
    var videoFps: Int = 4

    /// 视频码率 (bps)
    var videoBitRate: Int = 500_000

    /// 视频帧采样步长 (每 N 帧取 1 帧)
    var videoFrameStride: Int = 1

    // MARK: - Voice Settings

    /// Fish Audio API Key
    var fishApiKey: String?

    /// Fish Audio 参考音色 ID (默认: 绝区零 Fairy)
    var fishReferenceId: String = "235851fae0da43309a9973fe7285a823"

    /// Fish Audio TTS WebSocket 地址
    var fishApiBase: String = "wss://api.fish.audio/v1/tts/live"

    /// Fish API 代理端口 (0 = 不使用代理)
    var fishProxyPort: Int = 7890

    /// 语音交互模型 (Qwen3 Omni)
    var voiceModel: String = "qwen3-omni-flash-2025-12-01"

    // MARK: - Overlay Settings

    /// 是否启用全息悬浮覆盖层
    var overlayEnabled: Bool = true

    /// 迷你状态条位置 ("right" / "left")
    var miniBarPosition: String = "right"

    // MARK: - 主线目标

    /// 当前主线项目/目标
    var mainQuest: String?

    /// 宽泛动机 (如 "自我提升", "赚钱", "探索AI")
    var motivations: [String]?

    // MARK: - Server / Sync Settings
    
    /// 服务器 API 地址
    var serverURL: String = "http://127.0.0.1:8000"
    
    /// 服务器 WebSocket 地址
    var wsURL: String = "ws://127.0.0.1:8000/ws"
    
    /// 服务器验证 API Key
    var apiKey: String?
    
    // MARK: - Privacy
    
    /// 排除的应用 (不截图)
    var excludedApps: [String] = [
        "com.apple.keychainaccess",    // 钥匙串
        "com.apple.systempreferences", // 系统偏好设置 (密码相关)
    ]
    
    /// 排除的窗口标题关键词
    var excludedTitleKeywords: [String] = [
        "密码", "password", "Password",
        "银行", "bank", "Bank",
        "支付", "payment", "Payment",
    ]
    
    // MARK: - Load / Save
    
    private static let configDir: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config")
            .appendingPathComponent("solo-agent")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    
    private static let configFile: URL = configDir.appendingPathComponent("config.json")
    
    /// 加载配置，不存在则创建默认
    static func load() -> AgentConfig {
        if let data = try? Data(contentsOf: configFile),
           let config = try? JSONDecoder().decode(AgentConfig.self, from: data) {
            return config
        }
        
        // 生成默认配置
        let defaultConfig = AgentConfig(
            deviceId: Self.generateDeviceId(),
            deviceName: Host.current().localizedName ?? "Mac"
        )
        defaultConfig.save()
        return defaultConfig
    }
    
    /// 保存配置到磁盘
    func save() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(self) {
            try? data.write(to: Self.configFile, options: .atomic)
            Logger.info("💾 配置已保存: \(Self.configFile.path)")
        }
    }
    
    /// 生成设备 ID (基于硬件 UUID)
    private static func generateDeviceId() -> String {
        // 尝试获取硬件 UUID
        if let uuid = getHardwareUUID() {
            return "mac-\(uuid.prefix(8).lowercased())"
        }
        // 回退: 随机 UUID
        return "mac-\(UUID().uuidString.prefix(8).lowercased())"
    }
    
    /// 获取 macOS 硬件 UUID
    private static func getHardwareUUID() -> String? {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice")
        )
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        
        let key = kIOPlatformUUIDKey as CFString
        guard let uuid = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? String else { return nil }
        return uuid
    }
}
