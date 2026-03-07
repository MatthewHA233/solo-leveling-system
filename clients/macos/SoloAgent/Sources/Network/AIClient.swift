import Foundation

/// AI API 客户端 — 支持 Gemini / OpenAI 兼容协议（双协议）
@MainActor
final class AIClient {
    private let config: AgentConfig
    private let session: URLSession

    init(config: AgentConfig) {
        self.config = config
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = 300
        sessionConfig.timeoutIntervalForResource = 600
        self.session = URLSession(configuration: sessionConfig)
    }

    // MARK: - Current Provider Helpers

    private var isOpenAI: Bool { config.aiProvider == "openai" }

    private var activeApiKey: String? {
        isOpenAI ? config.openaiApiKey : config.geminiApiKey
    }

    // MARK: - Phase 1: Video Transcription

    /// 分析视频，生成逐段活动转录（AI 直接使用帧→时间映射表输出真实时间）
    func transcribeVideo(
        videoData: Data,
        videoDurationSeconds: Int,
        frameTimeMapping: String = "",
        contextHint: String = ""
    ) async -> [[String: Any]]? {
        guard let apiKey = activeApiKey, !apiKey.isEmpty else {
            Self.debugLog("未配置 \(config.aiProvider) API Key，跳过视频转录")
            return nil
        }

        let prompt = PromptTemplates.videoTranscriptionPrompt(
            videoDurationSeconds: videoDurationSeconds,
            frameTimeMapping: frameTimeMapping,
            contextHint: contextHint
        )

        Self.debugLog("[\(config.aiProvider)] 开始视频转录, 视频大小: \(videoData.count / 1024)KB, 视频时长: \(videoDurationSeconds)s")

        let responseText: String?
        if isOpenAI {
            responseText = await callOpenAIVideoAPI(
                videoData: videoData,
                textPrompt: prompt,
                apiKey: apiKey
            )
        } else {
            responseText = await callGeminiAPI(
                videoData: videoData,
                textPrompt: prompt,
                apiKey: apiKey
            )
        }

        guard let text = responseText else {
            Self.debugLog("视频转录 API 调用失败")
            return nil
        }

        guard let jsonArray = parseJSONArray(text) else {
            Self.debugLog("视频转录 JSON 解析失败: \(text.prefix(500))")
            return nil
        }

        Self.debugLog("视频转录成功: \(jsonArray.count) 段")
        return jsonArray
    }

    // MARK: - Phase 2: Activity Card Generation

    /// 基于转录生成活动卡片
    func generateActivityCards(
        transcription: [[String: Any]],
        existingCards: [ActivityCardRecord],
        contextHint: String = ""
    ) async -> [[String: Any]]? {
        guard let apiKey = activeApiKey, !apiKey.isEmpty else {
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
        // 传最近 5 张卡片的完整上下文（含 detailedSummary），让 plus 模型理解衔接
        let existingJson: String
        if existingCards.isEmpty {
            existingJson = ""
        } else {
            let recentCards = existingCards.suffix(5)
            let cardDicts = recentCards.map { card -> [String: Any] in
                [
                    "title": card.title,
                    "startTime": card.startTime,
                    "endTime": card.endTime,
                    "category": card.category,
                    "summary": card.summary,
                    "detailedSummary": String(card.detailedSummary.prefix(300)),
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
            motivations: config.motivations ?? [],
            contextHint: contextHint
        )

        Self.debugLog("开始生成活动卡片, 转录段数: \(transcription.count)")

        Self.debugLog("开始生成活动卡片 (模型: \(config.openaiCardModel)), 转录段数: \(transcription.count)")

        let responseText: String?
        if isOpenAI {
            responseText = await callOpenAITextAPI(textPrompt: prompt, apiKey: apiKey, model: config.openaiCardModel)
        } else {
            responseText = await callGeminiTextAPI(textPrompt: prompt, apiKey: apiKey)
        }

        guard let text = responseText else {
            Self.debugLog("活动卡片生成 API 调用失败")
            return nil
        }

        guard let jsonArray = parseJSONArray(text) else {
            Self.debugLog("活动卡片 JSON 解析失败: \(text.prefix(500))")
            return nil
        }

        Self.debugLog("活动卡片生成成功: \(jsonArray.count) 张")
        return jsonArray
    }

    // MARK: - Test Connection

    /// 测试当前 provider 连接是否正常
    func testConnection() async -> (success: Bool, message: String) {
        guard let apiKey = activeApiKey, !apiKey.isEmpty else {
            return (false, "未配置 API Key")
        }

        let testPrompt = "Reply with exactly: OK"
        let responseText: String?

        if isOpenAI {
            responseText = await callOpenAITextAPI(textPrompt: testPrompt, apiKey: apiKey)
        } else {
            responseText = await callGeminiTextAPI(textPrompt: testPrompt, apiKey: apiKey)
        }

        if let text = responseText {
            return (true, "连接成功: \(text.prefix(50))")
        } else {
            return (false, "连接失败，请检查 API Key 和 Base URL")
        }
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

    // MARK: - OpenAI API Call (with video)

    private func callOpenAIVideoAPI(
        videoData: Data,
        textPrompt: String,
        apiKey: String
    ) async -> String? {
        let base64Video = videoData.base64EncodedString()

        let payload: [String: Any] = [
            "model": config.openaiModel,
            "messages": [
                [
                    "role": "user",
                    "content": [
                        [
                            "type": "video_url",
                            "video_url": [
                                "url": "data:video/mp4;base64,\(base64Video)"
                            ] as [String: String]
                        ] as [String: Any],
                        [
                            "type": "text",
                            "text": textPrompt,
                        ] as [String: String],
                    ] as [[String: Any]]
                ] as [String: Any]
            ] as [[String: Any]],
            "temperature": 0.3,
            "max_tokens": 4096,
        ]

        return await sendOpenAIRequest(payload: payload, apiKey: apiKey)
    }

    // MARK: - OpenAI API Call (text only)

    private func callOpenAITextAPI(
        textPrompt: String,
        apiKey: String,
        model: String? = nil
    ) async -> String? {
        let payload: [String: Any] = [
            "model": model ?? config.openaiModel,
            "messages": [
                [
                    "role": "user",
                    "content": textPrompt,
                ] as [String: Any]
            ] as [[String: Any]],
            "temperature": 0.3,
            "max_tokens": 8192,
        ]

        return await sendOpenAIRequest(payload: payload, apiKey: apiKey)
    }

    // MARK: - Gemini HTTP Request

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

    // MARK: - OpenAI HTTP Request

    private func sendOpenAIRequest(payload: [String: Any], apiKey: String) async -> String? {
        let baseURL = config.openaiApiBase.hasSuffix("/")
            ? String(config.openaiApiBase.dropLast())
            : config.openaiApiBase
        let urlString = "\(baseURL)/v1/chat/completions"

        guard let url = URL(string: urlString) else {
            Logger.error("[AIClient] 无效的 OpenAI URL: \(urlString)")
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

        Self.debugLog("发送 OpenAI 请求: \(urlString), body: \(body.count / 1024)KB")

        do {
            let (data, response) = try await session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                Logger.error("[AIClient] 非 HTTP 响应")
                return nil
            }

            guard httpResponse.statusCode == 200 else {
                let responseBody = String(data: data, encoding: .utf8) ?? ""
                Self.debugLog("OpenAI API 返回 HTTP \(httpResponse.statusCode): \(responseBody.prefix(500))")
                return nil
            }

            Self.debugLog("HTTP 200, 响应大小: \(data.count) bytes")

            // OpenAI 响应格式: choices[0].message.content
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let choices = json["choices"] as? [[String: Any]],
                  let firstChoice = choices.first,
                  let message = firstChoice["message"] as? [String: Any],
                  let text = message["content"] as? String else {
                let raw = String(data: data, encoding: .utf8) ?? "<binary>"
                Self.debugLog("OpenAI 响应格式不符: \(raw.prefix(500))")
                return nil
            }

            Self.debugLog("OpenAI 原始响应: \(text.prefix(300))")
            return text

        } catch {
            Logger.error("[AIClient] 网络请求失败: \(error.localizedDescription)")
            Self.debugLog("网络错误: \(error)")
            return nil
        }
    }

    // MARK: - Phase 2 Streaming: Activity Card Generation

    enum AIStreamError: Error {
        case noApiKey
        case invalidURL
        case httpError(Int, String)
        case serializationFailed
    }

    /// 流式视频转录 — 返回 AsyncThrowingStream，逐 token yield
    func streamTranscribeVideo(
        videoData: Data,
        videoDurationSeconds: Int,
        frameTimeMapping: String = "",
        contextHint: String = ""
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task { @MainActor in
                guard let apiKey = activeApiKey, !apiKey.isEmpty else {
                    continuation.finish(throwing: AIStreamError.noApiKey)
                    return
                }

                let prompt = PromptTemplates.videoTranscriptionPrompt(
                    videoDurationSeconds: videoDurationSeconds,
                    frameTimeMapping: frameTimeMapping,
                    contextHint: contextHint
                )

                Self.debugLog("[Streaming] 开始流式视频转录, 视频大小: \(videoData.count / 1024)KB, 时长: \(videoDurationSeconds)s")

                if isOpenAI {
                    await streamOpenAIVideoAPI(videoData: videoData, prompt: prompt, apiKey: apiKey, continuation: continuation)
                } else {
                    // Gemini 暂不支持流式视频，fallback 到非流式
                    if let result = await callGeminiAPI(videoData: videoData, textPrompt: prompt, apiKey: apiKey) {
                        continuation.yield(result)
                    }
                    continuation.finish()
                }
            }
        }
    }

    /// OpenAI 流式视频请求 — stream: true, SSE 解析
    private func streamOpenAIVideoAPI(
        videoData: Data,
        prompt: String,
        apiKey: String,
        continuation: AsyncThrowingStream<String, Error>.Continuation
    ) async {
        let baseURL = config.openaiApiBase.hasSuffix("/")
            ? String(config.openaiApiBase.dropLast())
            : config.openaiApiBase
        let urlString = "\(baseURL)/v1/chat/completions"

        guard let url = URL(string: urlString) else {
            continuation.finish(throwing: AIStreamError.invalidURL)
            return
        }

        let base64Video = videoData.base64EncodedString()
        let payload: [String: Any] = [
            "model": config.openaiModel,
            "messages": [
                [
                    "role": "user",
                    "content": [
                        [
                            "type": "video_url",
                            "video_url": [
                                "url": "data:video/mp4;base64,\(base64Video)"
                            ] as [String: String]
                        ] as [String: Any],
                        [
                            "type": "text",
                            "text": prompt,
                        ] as [String: String],
                    ] as [[String: Any]]
                ] as [String: Any]
            ] as [[String: Any]],
            "temperature": 0.3,
            "max_tokens": 4096,
            "stream": true,
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("solo-leveling-system/2.0", forHTTPHeaderField: "User-Agent")

        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            continuation.finish(throwing: AIStreamError.serializationFailed)
            return
        }
        request.httpBody = body

        Self.debugLog("[Streaming] 发送 OpenAI 流式视频请求: \(urlString), body: \(body.count / 1024)KB")

        do {
            let (bytes, response) = try await session.bytes(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                continuation.finish(throwing: AIStreamError.httpError(0, "非 HTTP 响应"))
                return
            }
            guard httpResponse.statusCode == 200 else {
                var errorBody = ""
                for try await line in bytes.lines { errorBody += line; if errorBody.count > 500 { break } }
                Self.debugLog("[Streaming] OpenAI 视频转录 HTTP \(httpResponse.statusCode): \(errorBody.prefix(500))")
                continuation.finish(throwing: AIStreamError.httpError(httpResponse.statusCode, errorBody))
                return
            }

            for try await line in bytes.lines {
                guard line.hasPrefix("data: ") else { continue }
                let data = String(line.dropFirst(6))
                if data == "[DONE]" { break }

                guard let jsonData = data.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                      let choices = json["choices"] as? [[String: Any]],
                      let delta = choices.first?["delta"] as? [String: Any],
                      let content = delta["content"] as? String else {
                    continue
                }

                continuation.yield(content)
            }
            continuation.finish()
            Self.debugLog("[Streaming] OpenAI 流式视频转录完成")
        } catch {
            Self.debugLog("[Streaming] OpenAI 流式视频转录错误: \(error)")
            continuation.finish(throwing: error)
        }
    }

    /// 纯 prompt 流式请求（用 cardModel）— 用于卡片整理等场景
    func streamGenerateActivityCardsFromPrompt(_ prompt: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task { @MainActor in
                guard let apiKey = activeApiKey, !apiKey.isEmpty else {
                    continuation.finish(throwing: AIStreamError.noApiKey)
                    return
                }

                Self.debugLog("[Streaming] 纯 prompt 流式请求 (模型: \(config.openaiCardModel))")

                if isOpenAI {
                    await streamOpenAITextAPI(prompt: prompt, apiKey: apiKey, continuation: continuation, model: config.openaiCardModel)
                } else {
                    await streamGeminiTextAPI(prompt: prompt, apiKey: apiKey, continuation: continuation)
                }
            }
        }
    }

    /// 流式生成活动卡片 — 返回 AsyncThrowingStream，逐 token yield
    func streamGenerateActivityCards(
        transcription: [[String: Any]],
        existingCards: [ActivityCardRecord],
        contextHint: String = ""
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task { @MainActor in
                guard let apiKey = activeApiKey, !apiKey.isEmpty else {
                    continuation.finish(throwing: AIStreamError.noApiKey)
                    return
                }

                // 复用 prompt 构建逻辑
                let transcriptionJson: String
                if let data = try? JSONSerialization.data(withJSONObject: transcription, options: .prettyPrinted),
                   let str = String(data: data, encoding: .utf8) {
                    transcriptionJson = str
                } else {
                    continuation.finish(throwing: AIStreamError.serializationFailed)
                    return
                }

                let existingJson: String
                if existingCards.isEmpty {
                    existingJson = ""
                } else {
                    let recentCards = existingCards.suffix(5)
                    let cardDicts = recentCards.map { card -> [String: Any] in
                        [
                            "title": card.title,
                            "startTime": card.startTime,
                            "endTime": card.endTime,
                            "category": card.category,
                            "summary": card.summary,
                            "detailedSummary": String(card.detailedSummary.prefix(300)),
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
                    motivations: config.motivations ?? [],
                    contextHint: contextHint
                )

                Self.debugLog("[Streaming] 开始流式生成活动卡片, 转录段数: \(transcription.count)")

                if isOpenAI {
                    await streamOpenAITextAPI(prompt: prompt, apiKey: apiKey, continuation: continuation)
                } else {
                    await streamGeminiTextAPI(prompt: prompt, apiKey: apiKey, continuation: continuation)
                }
            }
        }
    }

    /// OpenAI 流式请求 — stream: true, SSE 解析
    private func streamOpenAITextAPI(
        prompt: String,
        apiKey: String,
        continuation: AsyncThrowingStream<String, Error>.Continuation,
        model: String? = nil
    ) async {
        let baseURL = config.openaiApiBase.hasSuffix("/")
            ? String(config.openaiApiBase.dropLast())
            : config.openaiApiBase
        let urlString = "\(baseURL)/v1/chat/completions"

        guard let url = URL(string: urlString) else {
            continuation.finish(throwing: AIStreamError.invalidURL)
            return
        }

        let payload: [String: Any] = [
            "model": model ?? config.openaiCardModel,
            "messages": [
                ["role": "user", "content": prompt] as [String: Any]
            ] as [[String: Any]],
            "temperature": 0.3,
            "max_tokens": 8192,
            "stream": true,
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("solo-leveling-system/2.0", forHTTPHeaderField: "User-Agent")

        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            continuation.finish(throwing: AIStreamError.serializationFailed)
            return
        }
        request.httpBody = body

        Self.debugLog("[Streaming] 发送 OpenAI 流式请求: \(urlString)")

        do {
            let (bytes, response) = try await session.bytes(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                continuation.finish(throwing: AIStreamError.httpError(0, "非 HTTP 响应"))
                return
            }
            guard httpResponse.statusCode == 200 else {
                var errorBody = ""
                for try await line in bytes.lines { errorBody += line; if errorBody.count > 500 { break } }
                Self.debugLog("[Streaming] OpenAI HTTP \(httpResponse.statusCode): \(errorBody.prefix(500))")
                continuation.finish(throwing: AIStreamError.httpError(httpResponse.statusCode, errorBody))
                return
            }

            for try await line in bytes.lines {
                guard line.hasPrefix("data: ") else { continue }
                let data = String(line.dropFirst(6))
                if data == "[DONE]" { break }

                guard let jsonData = data.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                      let choices = json["choices"] as? [[String: Any]],
                      let delta = choices.first?["delta"] as? [String: Any],
                      let content = delta["content"] as? String else {
                    continue
                }

                continuation.yield(content)
            }
            continuation.finish()
            Self.debugLog("[Streaming] OpenAI 流式完成")
        } catch {
            Self.debugLog("[Streaming] OpenAI 流式错误: \(error)")
            continuation.finish(throwing: error)
        }
    }

    /// Gemini 流式请求 — streamGenerateContent?alt=sse
    private func streamGeminiTextAPI(
        prompt: String,
        apiKey: String,
        continuation: AsyncThrowingStream<String, Error>.Continuation
    ) async {
        let baseURL = config.geminiApiBase.hasSuffix("/")
            ? String(config.geminiApiBase.dropLast())
            : config.geminiApiBase
        let urlString = "\(baseURL)/v1beta/models/\(config.geminiModel):streamGenerateContent?alt=sse"

        guard let url = URL(string: urlString) else {
            continuation.finish(throwing: AIStreamError.invalidURL)
            return
        }

        let payload: [String: Any] = [
            "contents": [
                [
                    "role": "user",
                    "parts": [
                        ["text": prompt] as [String: String]
                    ] as [[String: String]]
                ] as [String: Any]
            ] as [[String: Any]],
            "generationConfig": [
                "temperature": 0.3,
                "maxOutputTokens": 8192,
            ] as [String: Any],
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("solo-leveling-system/2.0", forHTTPHeaderField: "User-Agent")

        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            continuation.finish(throwing: AIStreamError.serializationFailed)
            return
        }
        request.httpBody = body

        Self.debugLog("[Streaming] 发送 Gemini 流式请求: \(urlString)")

        do {
            let (bytes, response) = try await session.bytes(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                continuation.finish(throwing: AIStreamError.httpError(0, "非 HTTP 响应"))
                return
            }
            guard httpResponse.statusCode == 200 else {
                var errorBody = ""
                for try await line in bytes.lines { errorBody += line; if errorBody.count > 500 { break } }
                Self.debugLog("[Streaming] Gemini HTTP \(httpResponse.statusCode): \(errorBody.prefix(500))")
                continuation.finish(throwing: AIStreamError.httpError(httpResponse.statusCode, errorBody))
                return
            }

            for try await line in bytes.lines {
                guard line.hasPrefix("data: ") else { continue }
                let data = String(line.dropFirst(6))

                guard let jsonData = data.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                      let candidates = json["candidates"] as? [[String: Any]],
                      let content = candidates.first?["content"] as? [String: Any],
                      let parts = content["parts"] as? [[String: Any]],
                      let text = parts.first?["text"] as? String else {
                    continue
                }

                continuation.yield(text)
            }
            continuation.finish()
            Self.debugLog("[Streaming] Gemini 流式完成")
        } catch {
            Self.debugLog("[Streaming] Gemini 流式错误: \(error)")
            continuation.finish(throwing: error)
        }
    }

    // MARK: - Qwen3 Omni Audio Streaming

    /// 流式发送音频到 Qwen3 Omni，返回逐 token 文本流
    /// - historyMessages: 可选的对话历史（user/assistant 文本轮次），注入 system 与 audio 之间
    func streamOmniAudio(
        systemPrompt: String,
        historyMessages: [[String: Any]] = [],
        audioBase64: String,
        audioFormat: String = "wav"
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task { @MainActor in
                guard let apiKey = activeApiKey, !apiKey.isEmpty else {
                    continuation.finish(throwing: AIStreamError.noApiKey)
                    return
                }

                let baseURL = config.openaiApiBase.hasSuffix("/")
                    ? String(config.openaiApiBase.dropLast())
                    : config.openaiApiBase
                let urlString = "\(baseURL)/v1/chat/completions"

                guard let url = URL(string: urlString) else {
                    continuation.finish(throwing: AIStreamError.invalidURL)
                    return
                }

                // 构建 messages: system + history + audio
                var msgs: [[String: Any]] = [
                    ["role": "system", "content": systemPrompt] as [String: Any],
                ]
                msgs.append(contentsOf: historyMessages)
                msgs.append([
                    "role": "user",
                    "content": [
                        [
                            "type": "input_audio",
                            "input_audio": [
                                "data": "data:;base64,\(audioBase64)",
                                "format": audioFormat,
                            ] as [String: String]
                        ] as [String: Any]
                    ] as [[String: Any]]
                ] as [String: Any])

                let payload: [String: Any] = [
                    "model": config.voiceModel,
                    "messages": msgs,
                    "modalities": ["text"],
                    "stream": true,
                    "stream_options": ["include_usage": true] as [String: Any],
                ]

                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("solo-leveling-system/2.0", forHTTPHeaderField: "User-Agent")

                guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
                    continuation.finish(throwing: AIStreamError.serializationFailed)
                    return
                }
                request.httpBody = body

                Self.debugLog("[Omni] 发送 Qwen3 Omni 音频流式请求, 音频大小: \(audioBase64.count / 1024)KB")

                do {
                    let (bytes, response) = try await session.bytes(for: request)

                    guard let httpResponse = response as? HTTPURLResponse else {
                        continuation.finish(throwing: AIStreamError.httpError(0, "非 HTTP 响应"))
                        return
                    }
                    guard httpResponse.statusCode == 200 else {
                        var errorBody = ""
                        for try await line in bytes.lines { errorBody += line; if errorBody.count > 500 { break } }
                        Self.debugLog("[Omni] HTTP \(httpResponse.statusCode): \(errorBody.prefix(500))")
                        continuation.finish(throwing: AIStreamError.httpError(httpResponse.statusCode, errorBody))
                        return
                    }

                    for try await line in bytes.lines {
                        guard line.hasPrefix("data: ") else { continue }
                        let data = String(line.dropFirst(6))
                        if data == "[DONE]" { break }

                        guard let jsonData = data.data(using: .utf8),
                              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                              let choices = json["choices"] as? [[String: Any]],
                              let delta = choices.first?["delta"] as? [String: Any],
                              let content = delta["content"] as? String else {
                            continue
                        }

                        continuation.yield(content)
                    }
                    continuation.finish()
                    Self.debugLog("[Omni] Qwen3 Omni 流式完成")
                } catch {
                    Self.debugLog("[Omni] Qwen3 Omni 流式错误: \(error)")
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Agent Turn Streaming (ReAct Loop)

    /// ReAct 循环的流式 chunk
    enum AgentTurnChunk {
        case textDelta(String)
        case toolCallDelta(index: Int, id: String?, name: String?, argsDelta: String?)
        case finishReason(String)  // "stop" | "tool_calls"
    }

    /// 流式发送完整 messages + tools，解析 SSE 增量（text + tool_calls）
    func streamAgentTurn(
        messages: [[String: Any]],
        tools: [[String: Any]]
    ) -> AsyncThrowingStream<AgentTurnChunk, Error> {
        AsyncThrowingStream { continuation in
            Task { @MainActor in
                guard let apiKey = activeApiKey, !apiKey.isEmpty else {
                    continuation.finish(throwing: AIStreamError.noApiKey)
                    return
                }

                let baseURL = config.openaiApiBase.hasSuffix("/")
                    ? String(config.openaiApiBase.dropLast())
                    : config.openaiApiBase
                let urlString = "\(baseURL)/v1/chat/completions"

                guard let url = URL(string: urlString) else {
                    continuation.finish(throwing: AIStreamError.invalidURL)
                    return
                }

                var payload: [String: Any] = [
                    "model": config.openaiCardModel,
                    "messages": messages,
                    "temperature": 0.3,
                    "max_tokens": 4096,
                    "stream": true,
                ]

                if !tools.isEmpty {
                    payload["tools"] = tools
                    payload["tool_choice"] = "auto"
                }

                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("solo-leveling-system/2.0", forHTTPHeaderField: "User-Agent")

                guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
                    continuation.finish(throwing: AIStreamError.serializationFailed)
                    return
                }
                request.httpBody = body

                Self.debugLog("[AgentLoop] 发送 streamAgentTurn 请求，messages=\(messages.count), tools=\(tools.count)")

                do {
                    let (bytes, response) = try await session.bytes(for: request)

                    guard let httpResponse = response as? HTTPURLResponse else {
                        continuation.finish(throwing: AIStreamError.httpError(0, "非 HTTP 响应"))
                        return
                    }
                    guard httpResponse.statusCode == 200 else {
                        var errorBody = ""
                        for try await line in bytes.lines {
                            errorBody += line
                            if errorBody.count > 500 { break }
                        }
                        Self.debugLog("[AgentLoop] HTTP \(httpResponse.statusCode): \(errorBody.prefix(300))")
                        continuation.finish(throwing: AIStreamError.httpError(httpResponse.statusCode, errorBody))
                        return
                    }

                    for try await line in bytes.lines {
                        guard line.hasPrefix("data: ") else { continue }
                        let data = String(line.dropFirst(6))
                        if data == "[DONE]" { break }

                        guard let jsonData = data.data(using: .utf8),
                              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                              let choices = json["choices"] as? [[String: Any]],
                              let choice = choices.first else {
                            continue
                        }

                        // finish_reason
                        if let finishReason = choice["finish_reason"] as? String, !finishReason.isEmpty {
                            continuation.yield(.finishReason(finishReason))
                        }

                        guard let delta = choice["delta"] as? [String: Any] else { continue }

                        // text delta
                        if let content = delta["content"] as? String {
                            continuation.yield(.textDelta(content))
                        }

                        // tool_calls delta
                        if let toolCallDeltas = delta["tool_calls"] as? [[String: Any]] {
                            for tc in toolCallDeltas {
                                let index = tc["index"] as? Int ?? 0
                                let id = tc["id"] as? String
                                let funcDict = tc["function"] as? [String: Any]
                                let name = funcDict?["name"] as? String
                                let argsDelta = funcDict?["arguments"] as? String
                                continuation.yield(.toolCallDelta(
                                    index: index,
                                    id: id,
                                    name: name,
                                    argsDelta: argsDelta
                                ))
                            }
                        }
                    }

                    continuation.finish()
                    Self.debugLog("[AgentLoop] streamAgentTurn 完成")
                } catch {
                    Self.debugLog("[AgentLoop] streamAgentTurn 错误: \(error)")
                    continuation.finish(throwing: error)
                }
            }
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
