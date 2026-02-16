import Foundation

/// Agent 配置
struct AgentConfig: Codable {
    /// 设备唯一标识
    var deviceId: String
    
    /// 设备友好名称
    var deviceName: String
    
    /// 服务器地址
    var serverURL: String
    
    /// API 密钥 (未来用)
    var apiKey: String?
    
    /// WebSocket 地址 (自动生成)
    var wsURL: String {
        serverURL
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
        + "/ws/agent/\(deviceId)"
    }
    
    // MARK: - Capture Settings
    
    /// 截图最大宽度 (px)
    var captureMaxWidth: Int = 1280
    
    /// JPEG 压缩质量 (0.0 - 1.0)
    var captureJpegQuality: Double = 0.6
    
    /// 本地缓存截图数量上限
    var localCacheLimit: Int = 100
    
    /// 本地缓存过期时间 (秒)
    var localCacheTTL: TimeInterval = 3600
    
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
            deviceName: Host.current().localizedName ?? "Mac",
            serverURL: "http://36.151.148.51:8888"
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
