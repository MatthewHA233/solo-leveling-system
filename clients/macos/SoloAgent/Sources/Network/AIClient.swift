import Foundation

/// Gemini API 客户端 — 两阶段视频分析
@MainActor
final class AIClient {
    private let config: AgentConfig
    private let session: URLSession

    init(config: AgentConfig) {
        self.config = config
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = 120
        sessionConfig.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: sessionConfig)
    }

    // MARK: - Phase 1: Video Transcription

    /// 分析视频，生成逐段活动转录
    func transcribeVideo(
        videoData: Data,
        startTimestamp: Int,
        endTimestamp: Int,
        screenshotCount: Int
    ) async -> [[String: Any]]? {
        guard let apiKey = config.geminiApiKey, !apiKey.isEmpty else {
            Self.debugLog("未配置 Gemini API Key，跳过视频转录")
            return nil
        }

        let prompt = PromptTemplates.videoTranscriptionPrompt(
            startTimestamp: startTimestamp,
            endTimestamp: endTimestamp,
            screenshotCount: screenshotCount
        )

        Self.debugLog("开始视频转录, 视频大小: \(videoData.count / 1024)KB, 时间: \(startTimestamp)-\(endTimestamp)")

        guard let responseText = await callGeminiAPI(
            videoData: videoData,
            textPrompt: prompt,
            apiKey: apiKey
        ) else {
            Self.debugLog("视频转录 API 调用失败")
            return nil
        }

        guard let jsonArray = parseJSONArray(responseText) else {
            Self.debugLog("视频转录 JSON 解析失败: \(responseText.prefix(500))")
            return nil
        }

        Self.debugLog("视频转录成功: \(jsonArray.count) 段")
        return jsonArray
    }

    // MARK: - Phase 2: Activity Card Generation

    /// 基于转录生成活动卡片
    func generateActivityCards(
        transcription: [[String: Any]],
        existingCards: [ActivityCardRecord]
    ) async -> [[String: Any]]? {
        guard let apiKey = config.geminiApiKey, !apiKey.isEmpty else {
            return nil
        }

        // 格式化转录
        let transcriptionJson: String
        if let data = try? JSONSerialization.data(withJSONObject: transcription, options: .prettyPrinted),
           let str = String(data: data, encoding: .utf8) {
            transcriptionJson = str
        } else {
            return nil
        }

        // 格式化已有卡片
        let existingJson: String
        if existingCards.isEmpty {
            existingJson = ""
        } else {
            let cardDicts = existingCards.map { card -> [String: Any] in
                [
                    "title": card.title,
                    "startTime": card.startTime,
                    "endTime": card.endTime,
                    "category": card.category,
                    "summary": card.summary,
                ]
            }
            if let data = try? JSONSerialization.data(withJSONObject: cardDicts, options: .prettyPrinted),
               let str = String(data: data, encoding: .utf8) {
                existingJson = str
            } else {
                existingJson = ""
            }
        }

        let prompt = PromptTemplates.activityCardPrompt(
            transcription: transcriptionJson,
            existingCards: existingJson,
            mainQuest: config.mainQuest ?? "",
            motivations: config.motivations ?? []
        )

        Self.debugLog("开始生成活动卡片, 转录段数: \(transcription.count)")

        guard let responseText = await callGeminiTextAPI(
            textPrompt: prompt,
            apiKey: apiKey
        ) else {
            Self.debugLog("活动卡片生成 API 调用失败")
            return nil
        }

        guard let jsonArray = parseJSONArray(responseText) else {
            Self.debugLog("活动卡片 JSON 解析失败: \(responseText.prefix(500))")
            return nil
        }

        Self.debugLog("活动卡片生成成功: \(jsonArray.count) 张")
        return jsonArray
    }

    // MARK: - Gemini API Call (with video)

    private func callGeminiAPI(
        videoData: Data,
        textPrompt: String,
        apiKey: String
    ) async -> String? {
        let base64Video = videoData.base64EncodedString()

        let payload: [String: Any] = [
            "contents": [
                [
                    "role": "user",
                    "parts": [
                        [
                            "inline_data": [
                                "mime_type": "video/mp4",
                                "data": base64Video,
                            ] as [String: String]
                        ],
                        ["text": textPrompt],
                    ] as [[String: Any]]
                ] as [String: Any]
            ] as [[String: Any]],
            "generationConfig": [
                "temperature": 0.3,
                "maxOutputTokens": 4096,
            ] as [String: Any],
        ]

        return await sendGeminiRequest(payload: payload, apiKey: apiKey)
    }

    // MARK: - Gemini API Call (text only)

    private func callGeminiTextAPI(
        textPrompt: String,
        apiKey: String
    ) async -> String? {
        let payload: [String: Any] = [
            "contents": [
                [
                    "role": "user",
                    "parts": [
                        ["text": textPrompt] as [String: String]
                    ] as [[String: String]]
                ] as [String: Any]
            ] as [[String: Any]],
            "generationConfig": [
                "temperature": 0.3,
                "maxOutputTokens": 8192,
            ] as [String: Any],
        ]

        return await sendGeminiRequest(payload: payload, apiKey: apiKey)
    }

    // MARK: - HTTP Request

    private func sendGeminiRequest(payload: [String: Any], apiKey: String) async -> String? {
        let baseURL = config.geminiApiBase.hasSuffix("/")
            ? String(config.geminiApiBase.dropLast())
            : config.geminiApiBase
        let urlString = "\(baseURL)/v1beta/models/\(config.geminiModel):generateContent"

        guard let url = URL(string: urlString) else {
            Logger.error("[AIClient] 无效的 API URL: \(urlString)")
            return nil
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("solo-leveling-system/2.0", forHTTPHeaderField: "User-Agent")

        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            Logger.error("[AIClient] 序列化请求体失败")
            return nil
        }
        request.httpBody = body

        Self.debugLog("发送 Gemini 请求: \(urlString), body: \(body.count / 1024)KB")

        do {
            let (data, response) = try await session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                Logger.error("[AIClient] 非 HTTP 响应")
                return nil
            }

            guard httpResponse.statusCode == 200 else {
                let responseBody = String(data: data, encoding: .utf8) ?? ""
                Self.debugLog("API 返回 HTTP \(httpResponse.statusCode): \(responseBody.prefix(500))")
                return nil
            }

            Self.debugLog("HTTP 200, 响应大小: \(data.count) bytes")

            // Gemini 响应格式: candidates[0].content.parts[0].text
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let candidates = json["candidates"] as? [[String: Any]],
                  let firstCandidate = candidates.first,
                  let content = firstCandidate["content"] as? [String: Any],
                  let parts = content["parts"] as? [[String: Any]],
                  let firstPart = parts.first,
                  let text = firstPart["text"] as? String else {
                let raw = String(data: data, encoding: .utf8) ?? "<binary>"
                Self.debugLog("Gemini 响应格式不符: \(raw.prefix(500))")
                return nil
            }

            Self.debugLog("Gemini 原始响应: \(text.prefix(300))")
            return text

        } catch {
            Logger.error("[AIClient] 网络请求失败: \(error.localizedDescription)")
            Self.debugLog("网络错误: \(error)")
            return nil
        }
    }

    // MARK: - JSON Parsing

    private func parseJSONArray(_ content: String) -> [[String: Any]]? {
        // 尝试直接解析
        if let data = content.data(using: .utf8),
           let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            return array
        }

        // 尝试从 ```json ... ``` 代码块提取
        let pattern = "```(?:json)?\\s*\\n?(.*?)\\n?```"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .dotMatchesLineSeparators) else {
            return nil
        }
        let range = NSRange(content.startIndex..., in: content)
        if let match = regex.firstMatch(in: content, range: range),
           let jsonRange = Range(match.range(at: 1), in: content) {
            let jsonStr = String(content[jsonRange])
            if let data = jsonStr.data(using: .utf8),
               let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                return array
            }
        }

        Logger.warning("[AIClient] 无法解析 JSON 数组: \(content.prefix(200))")
        return nil
    }

    // MARK: - Debug Log

    private static let debugLogFile: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config").appendingPathComponent("solo-agent")
        return dir.appendingPathComponent("ai-debug.log")
    }()

    nonisolated static func debugLog(_ message: String) {
        let ts = ISO8601DateFormatter().string(from: Date())
        let line = "[\(ts)] [AIClient] \(message)\n"
        NSLog("[AIClient] %@", message)
        if let data = line.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: debugLogFile.path) {
                if let handle = try? FileHandle(forWritingTo: debugLogFile) {
                    handle.seekToEndOfFile()
                    handle.write(data)
                    handle.closeFile()
                }
            } else {
                try? data.write(to: debugLogFile)
            }
        }
    }
}
