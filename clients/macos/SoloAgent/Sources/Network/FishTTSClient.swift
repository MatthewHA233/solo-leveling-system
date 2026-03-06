import Foundation

/// Fish Audio WebSocket TTS 客户端 — 实时文本转语音
/// 控制消息用 msgpack 二进制编码，音频返回裸 PCM
@MainActor
final class FishTTSClient {
    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var isConnected = false

    var onAudioChunk: ((Data) -> Void)?
    var onFinish: (() -> Void)?

    // MARK: - Connect

    func connect(apiKey: String, referenceId: String, format: String = "pcm",
                 apiBase: String = "wss://api.fish.audio/v1/tts/live",
                 proxyPort: Int = 7890) async throws {

        guard let url = URL(string: apiBase) else { throw FishTTSError.invalidURL }

        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = 60

        if proxyPort > 0 {
            sessionConfig.connectionProxyDictionary = [
                "HTTPEnable": true,
                "HTTPProxy": "127.0.0.1",
                "HTTPPort": proxyPort,
                "HTTPSEnable": true,
                "HTTPSProxy": "127.0.0.1",
                "HTTPSPort": proxyPort,
            ]
            AIClient.debugLog("[FishTTS] 使用代理 127.0.0.1:\(proxyPort)")
        }

        let session = URLSession(configuration: sessionConfig)
        self.session = session

        var request = URLRequest(url: url)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        let ws = session.webSocketTask(with: request)
        self.webSocketTask = ws
        ws.resume()

        // 发送 start event（msgpack 编码）
        let startPayload: [String: Any] = [
            "event": "start",
            "request": [
                "text": "",
                "reference_id": referenceId,
                "format": format,
                "sample_rate": 24000,
                "latency": "normal",
            ] as [String: Any],
        ]
        let startData = encodeMsgpack(startPayload)
        try await ws.send(.data(startData))

        isConnected = true
        AIClient.debugLog("[FishTTS] WebSocket 已连接, referenceId=\(referenceId)")

        Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    // MARK: - Send

    func sendText(_ text: String) {
        guard isConnected, let ws = webSocketTask else { return }
        let payload: [String: Any] = ["event": "text", "text": text]
        let data = encodeMsgpack(payload)
        ws.send(.data(data)) { error in
            if let error {
                AIClient.debugLog("[FishTTS] sendText 错误: \(error.localizedDescription)")
            }
        }
    }

    func flush() {
        guard isConnected, let ws = webSocketTask else { return }
        let payload: [String: Any] = ["event": "flush"]
        let data = encodeMsgpack(payload)
        ws.send(.data(data)) { error in
            if let error {
                AIClient.debugLog("[FishTTS] flush 错误: \(error.localizedDescription)")
            }
        }
        AIClient.debugLog("[FishTTS] flush 已发送")
    }

    func stop() {
        guard isConnected, let ws = webSocketTask else { return }
        let payload: [String: Any] = ["event": "stop"]
        let data = encodeMsgpack(payload)
        ws.send(.data(data)) { _ in }
        isConnected = false
        ws.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        AIClient.debugLog("[FishTTS] 已断开")
    }

    // MARK: - Receive Loop

    private func receiveLoop() async {
        guard let ws = webSocketTask else {
            AIClient.debugLog("[FishTTS] receiveLoop: webSocketTask 为 nil")
            onFinish?()
            return
        }
        AIClient.debugLog("[FishTTS] receiveLoop 启动")
        var receivedFinish = false

        while isConnected {
            do {
                let message = try await ws.receive()
                switch message {
                case .data(let raw):
                    let (event, audioData) = decodeMsgpackMessage(raw)
                    if let event {
                        AIClient.debugLog("[FishTTS] 收到 event: \(event)")
                        if event == "audio", let audioData {
                            AIClient.debugLog("[FishTTS] 收到音频帧: \(audioData.count) bytes")
                            onAudioChunk?(audioData)
                        } else if event == "finish" {
                            receivedFinish = true
                            onFinish?()
                        }
                    } else {
                        // 裸 PCM（兼容旧协议）
                        AIClient.debugLog("[FishTTS] 收到裸音频帧: \(raw.count) bytes")
                        onAudioChunk?(raw)
                    }
                case .string(let text):
                    AIClient.debugLog("[FishTTS] 收到文本帧: \(text.prefix(100))")
                @unknown default:
                    break
                }
            } catch {
                if isConnected {
                    AIClient.debugLog("[FishTTS] 接收错误: \(error.localizedDescription)")
                }
                break
            }
        }

        // 兜底：连接断开但没有收到 finish 事件时也触发回调
        if !receivedFinish {
            AIClient.debugLog("[FishTTS] receiveLoop 退出（未收到 finish，触发兜底回调）")
            onFinish?()
        }
        AIClient.debugLog("[FishTTS] receiveLoop 退出")
    }

    // MARK: - Msgpack Encoder（最小实现，支持 str/int/map）

    private func encodeMsgpack(_ value: Any) -> Data {
        var out = Data()
        appendMsgpack(value, to: &out)
        return out
    }

    private func appendMsgpack(_ value: Any, to out: inout Data) {
        switch value {
        case let str as String:
            let bytes = Array(str.utf8)
            let n = bytes.count
            if n <= 31 {
                out.append(UInt8(0xa0 | n))
            } else if n <= 255 {
                out.append(0xd9)
                out.append(UInt8(n))
            } else {
                out.append(0xda)
                out.append(UInt8((n >> 8) & 0xff))
                out.append(UInt8(n & 0xff))
            }
            out.append(contentsOf: bytes)

        case let i as Int:
            if i >= 0 && i <= 127 {
                out.append(UInt8(i))
            } else if i <= 0xff {
                out.append(0xcc)
                out.append(UInt8(i))
            } else if i <= 0xffff {
                out.append(0xcd)
                out.append(UInt8((i >> 8) & 0xff))
                out.append(UInt8(i & 0xff))
            } else {
                out.append(0xce)
                out.append(UInt8((i >> 24) & 0xff))
                out.append(UInt8((i >> 16) & 0xff))
                out.append(UInt8((i >> 8) & 0xff))
                out.append(UInt8(i & 0xff))
            }

        case let dict as [String: Any]:
            let count = dict.count
            if count <= 15 {
                out.append(UInt8(0x80 | count))
            } else {
                out.append(0xde)
                out.append(UInt8((count >> 8) & 0xff))
                out.append(UInt8(count & 0xff))
            }
            for (k, v) in dict {
                appendMsgpack(k, to: &out)
                appendMsgpack(v, to: &out)
            }

        default:
            out.append(0xc0) // nil
        }
    }

    // MARK: - Msgpack Decoder（解析顶层 event 字段 + audio 二进制字段）

    /// 返回 (event名称, audio二进制数据)
    private func decodeMsgpackMessage(_ data: Data) -> (event: String?, audio: Data?) {
        guard data.count > 1 else { return (nil, nil) }
        var idx = data.startIndex

        // fixmap 或 map16
        let firstByte = data[idx]
        var mapCount: Int
        if firstByte & 0xf0 == 0x80 {
            mapCount = Int(firstByte & 0x0f)
            idx = data.index(after: idx)
        } else if firstByte == 0xde {
            guard data.index(idx, offsetBy: 3) <= data.endIndex else { return (nil, nil) }
            mapCount = Int(data[data.index(idx, offsetBy: 1)]) << 8 | Int(data[data.index(idx, offsetBy: 2)])
            idx = data.index(idx, offsetBy: 3)
        } else {
            return (nil, nil)
        }

        var event: String?
        var audio: Data?

        for _ in 0..<mapCount {
            guard let key = readMsgpackStr(data, idx: &idx) else { break }
            if key == "event" {
                event = readMsgpackStr(data, idx: &idx)
            } else if key == "audio" {
                audio = readMsgpackBin(data, idx: &idx)
            } else {
                skipMsgpackValue(data, idx: &idx)
            }
        }

        return (event, audio)
    }

    private func readMsgpackStr(_ data: Data, idx: inout Data.Index) -> String? {
        guard idx < data.endIndex else { return nil }
        let byte = data[idx]
        idx = data.index(after: idx)

        var len: Int
        if byte & 0xe0 == 0xa0 {
            len = Int(byte & 0x1f)
        } else if byte == 0xd9 {
            guard idx < data.endIndex else { return nil }
            len = Int(data[idx])
            idx = data.index(after: idx)
        } else if byte == 0xda {
            guard data.index(idx, offsetBy: 2) <= data.endIndex else { return nil }
            len = Int(data[idx]) << 8 | Int(data[data.index(after: idx)])
            idx = data.index(idx, offsetBy: 2)
        } else {
            return nil
        }

        guard data.index(idx, offsetBy: len) <= data.endIndex else { return nil }
        let strData = data[idx..<data.index(idx, offsetBy: len)]
        idx = data.index(idx, offsetBy: len)
        return String(bytes: strData, encoding: .utf8)
    }

    /// 读取 msgpack bin 类型（0xc4/0xc5/0xc6）
    private func readMsgpackBin(_ data: Data, idx: inout Data.Index) -> Data? {
        guard idx < data.endIndex else { return nil }
        let byte = data[idx]
        idx = data.index(after: idx)

        var len: Int
        if byte == 0xc4 {
            guard idx < data.endIndex else { return nil }
            len = Int(data[idx])
            idx = data.index(after: idx)
        } else if byte == 0xc5 {
            guard data.index(idx, offsetBy: 2) <= data.endIndex else { return nil }
            len = Int(data[idx]) << 8 | Int(data[data.index(after: idx)])
            idx = data.index(idx, offsetBy: 2)
        } else if byte == 0xc6 {
            guard data.index(idx, offsetBy: 4) <= data.endIndex else { return nil }
            len = Int(data[idx]) << 24 | Int(data[data.index(idx, offsetBy: 1)]) << 16 |
                  Int(data[data.index(idx, offsetBy: 2)]) << 8 | Int(data[data.index(idx, offsetBy: 3)])
            idx = data.index(idx, offsetBy: 4)
        } else {
            // 非 bin 类型，跳过
            idx = data.index(before: idx)
            skipMsgpackValue(data, idx: &idx)
            return nil
        }

        guard data.index(idx, offsetBy: len) <= data.endIndex else { return nil }
        let result = Data(data[idx..<data.index(idx, offsetBy: len)])
        idx = data.index(idx, offsetBy: len)
        return result
    }

    /// 跳过一个 msgpack 值（用于跳过未知字段）
    private func skipMsgpackValue(_ data: Data, idx: inout Data.Index) {
        guard idx < data.endIndex else { return }
        let byte = data[idx]
        idx = data.index(after: idx)

        if byte & 0xe0 == 0xa0 {
            // fixstr
            let len = Int(byte & 0x1f)
            guard data.index(idx, offsetBy: len) <= data.endIndex else { return }
            idx = data.index(idx, offsetBy: len)
        } else if byte == 0xd9 {
            guard idx < data.endIndex else { return }
            let len = Int(data[idx]); idx = data.index(after: idx)
            guard data.index(idx, offsetBy: len) <= data.endIndex else { return }
            idx = data.index(idx, offsetBy: len)
        } else if byte == 0xda {
            guard data.index(idx, offsetBy: 2) <= data.endIndex else { return }
            let len = Int(data[idx]) << 8 | Int(data[data.index(after: idx)])
            idx = data.index(idx, offsetBy: 2)
            guard data.index(idx, offsetBy: len) <= data.endIndex else { return }
            idx = data.index(idx, offsetBy: len)
        } else if byte == 0xc4 {
            guard idx < data.endIndex else { return }
            let len = Int(data[idx]); idx = data.index(after: idx)
            guard data.index(idx, offsetBy: len) <= data.endIndex else { return }
            idx = data.index(idx, offsetBy: len)
        } else if byte == 0xc5 {
            guard data.index(idx, offsetBy: 2) <= data.endIndex else { return }
            let len = Int(data[idx]) << 8 | Int(data[data.index(after: idx)])
            idx = data.index(idx, offsetBy: 2)
            guard data.index(idx, offsetBy: len) <= data.endIndex else { return }
            idx = data.index(idx, offsetBy: len)
        } else if byte == 0xc6 {
            guard data.index(idx, offsetBy: 4) <= data.endIndex else { return }
            let len = Int(data[idx]) << 24 | Int(data[data.index(idx, offsetBy: 1)]) << 16 |
                      Int(data[data.index(idx, offsetBy: 2)]) << 8 | Int(data[data.index(idx, offsetBy: 3)])
            idx = data.index(idx, offsetBy: 4)
            guard data.index(idx, offsetBy: len) <= data.endIndex else { return }
            idx = data.index(idx, offsetBy: len)
        }
        // fixint/nil/bool 等固定大小类型不需要额外跳过字节
    }

    deinit {
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
    }
}

// MARK: - Errors

enum FishTTSError: Error, LocalizedError {
    case invalidURL
    case serializationFailed
    case connectionFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "无效的 Fish TTS URL"
        case .serializationFailed: return "序列化失败"
        case .connectionFailed(let msg): return "连接失败: \(msg)"
        }
    }
}
