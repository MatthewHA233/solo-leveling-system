import Foundation

/// 窗口信息模型
struct WindowInfo: Codable, Equatable {
    /// 应用名称
    var appName: String?

    /// Bundle ID (macOS)
    var bundleId: String?

    /// 窗口标题
    var windowTitle: String?

    /// 进程 ID
    var processId: Int?

    /// 空窗口信息
    static let empty = WindowInfo()

    /// 友好描述
    var description: String {
        let app = appName ?? "未知"
        let title = windowTitle ?? ""
        return title.isEmpty ? app : "\(app) — \(title)"
    }

    enum CodingKeys: String, CodingKey {
        case appName = "app_name"
        case bundleId = "bundle_id"
        case windowTitle = "window_title"
        case processId = "process_id"
    }
}

/// Agent 上报数据
struct AgentReport: Codable {
    let deviceId: String
    let timestamp: Date
    let snapshot: Snapshot

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case timestamp
        case snapshot
    }
}

/// 快照数据
struct Snapshot: Codable {
    /// 截图数据 (JPEG)
    var screenshotData: Data?

    /// 当前活动窗口
    var activeWindow: WindowInfo

    /// 空闲秒数
    var idleSeconds: TimeInterval

    /// 屏幕是否锁定
    var isScreenLocked: Bool

    /// 电池电量 (macOS 笔记本)
    var batteryLevel: Int?

    /// 网络类型
    var networkType: String?

    enum CodingKeys: String, CodingKey {
        case screenshotData = "screenshot_b64"
        case activeWindow = "active_window"
        case idleSeconds = "idle_seconds"
        case isScreenLocked = "is_screen_locked"
        case batteryLevel = "battery_level"
        case networkType = "network_type"
    }
}

/// 服务器推送通知
struct ServerNotification: Codable {
    let type: String           // "notification", "quest", "buff", etc.
    let title: String
    let body: String
    let actions: [String]?
    let questId: String?
    let priority: String?      // "low", "normal", "high", "urgent"
}

/// 服务器响应
struct ServerResponse: Codable {
    let success: Bool
    let message: String?
    let data: [String: AnyCodableValue]?
}

/// 通用 Codable Value (处理服务器返回的任意 JSON)
enum AnyCodableValue: Codable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let v = try? container.decode(String.self) { self = .string(v) }
        else if let v = try? container.decode(Int.self) { self = .int(v) }
        else if let v = try? container.decode(Double.self) { self = .double(v) }
        else if let v = try? container.decode(Bool.self) { self = .bool(v) }
        else { self = .null }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .int(let v): try container.encode(v)
        case .double(let v): try container.encode(v)
        case .bool(let v): try container.encode(v)
        case .null: try container.encodeNil()
        }
    }
}
