import Foundation

/// 网络客户端 — 处理与服务器的 HTTP + WebSocket 通信
class NetworkClient {
    private let config: AgentConfig
    private var webSocketTask: URLSessionWebSocketTask?
    private let session: URLSession
    private var isConnectedInternal: Bool = false
    
    /// 服务器推送通知回调
    var onNotification: ((ServerNotification) -> Void)?
    
    // MARK: - Init
    
    init(config: AgentConfig) {
        self.config = config
        
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = 30
        sessionConfig.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: sessionConfig)
    }
    
    // MARK: - HTTP API
    
    /// 上报感知数据
    func sendReport(_ report: AgentReport) async -> Bool {
        let url = URL(string: "\(config.serverURL)/api/v1/agent/report")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        if let apiKey = config.apiKey {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let body = try encoder.encode(report)
            request.httpBody = body
            
            let (_, response) = try await session.data(for: request)
            
            guard let httpResponse = response as? HTTPURLResponse else { return false }
            
            if httpResponse.statusCode == 200 {
                return true
            } else {
                Logger.warning("上报失败: HTTP \(httpResponse.statusCode)")
                // 缓存到本地
                await cacheReport(report)
                return false
            }
        } catch {
            Logger.error("上报网络错误: \(error.localizedDescription)")
            // 离线时缓存
            await cacheReport(report)
            return false
        }
    }
    
    /// 发送心跳
    func sendHeartbeat(deviceId: String) async -> Bool {
        let url = URL(string: "\(config.serverURL)/api/v1/agent/heartbeat")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body: [String: Any] = [
            "device_id": deviceId,
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "agent_version": "0.1.0",
            "platform": "macOS",
            "platform_version": ProcessInfo.processInfo.operatingSystemVersionString
        ]
        
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { return false }
            return httpResponse.statusCode == 200
        } catch {
            return false
        }
    }
    
    // MARK: - WebSocket
    
    /// 连接 WebSocket (接收服务器推送)
    func connect() async throws {
        guard let url = URL(string: config.wsURL) else {
            throw NetworkError.invalidURL
        }
        
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()
        isConnectedInternal = true
        
        Logger.info("🔌 WebSocket 连接中: \(config.wsURL)")
        
        // 开始接收消息
        Task {
            await receiveLoop()
        }
    }
    
    /// 断开连接
    func disconnect() async {
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        isConnectedInternal = false
        Logger.info("🔌 WebSocket 已断开")
    }
    
    /// WebSocket 消息接收循环
    private func receiveLoop() async {
        guard let ws = webSocketTask else { return }
        
        while isConnectedInternal {
            do {
                let message = try await ws.receive()
                
                switch message {
                case .string(let text):
                    handleServerMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        handleServerMessage(text)
                    }
                @unknown default:
                    break
                }
            } catch {
                Logger.warning("WebSocket 接收错误: \(error.localizedDescription)")
                isConnectedInternal = false
                
                // 自动重连
                try? await Task.sleep(for: .seconds(5))
                try? await reconnect()
            }
        }
    }
    
    /// 处理服务器消息
    private func handleServerMessage(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        
        do {
            let notification = try JSONDecoder().decode(ServerNotification.self, from: data)
            Logger.info("📨 收到服务器通知: \(notification.title)")
            onNotification?(notification)
        } catch {
            Logger.debug("无法解析服务器消息: \(text.prefix(100))")
        }
    }
    
    /// 自动重连
    private func reconnect() async throws {
        Logger.info("🔄 WebSocket 重连中...")
        try await connect()
    }
    
    // MARK: - Local Cache (离线模式)
    
    private let cacheDir: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config")
            .appendingPathComponent("solo-agent")
            .appendingPathComponent("cache")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    
    /// 缓存未发送的 report
    private func cacheReport(_ report: AgentReport) async {
        let filename = "report-\(Int(report.timestamp.timeIntervalSince1970)).json"
        let file = cacheDir.appendingPathComponent(filename)
        
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(report)
            try data.write(to: file, options: .atomic)
            Logger.debug("💾 报告已缓存: \(filename)")
        } catch {
            Logger.error("缓存失败: \(error)")
        }
    }
    
    /// 发送缓存的 reports (恢复网络后调用)
    func flushCache() async {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: cacheDir, includingPropertiesForKeys: nil) else { return }
        
        let reportFiles = files.filter { $0.lastPathComponent.hasPrefix("report-") }
        guard !reportFiles.isEmpty else { return }
        
        Logger.info("📤 发送 \(reportFiles.count) 个缓存报告...")
        
        for file in reportFiles {
            do {
                let data = try Data(contentsOf: file)
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                let report = try decoder.decode(AgentReport.self, from: data)
                
                let success = await sendReport(report)
                if success {
                    try? fm.removeItem(at: file)
                }
            } catch {
                Logger.error("发送缓存失败: \(error)")
            }
        }
    }
}

// MARK: - Errors

enum NetworkError: Error, LocalizedError {
    case invalidURL
    case serverError(Int)
    case noConnection
    
    var errorDescription: String? {
        switch self {
        case .invalidURL: return "无效的 URL"
        case .serverError(let code): return "服务器错误: \(code)"
        case .noConnection: return "无网络连接"
        }
    }
}
