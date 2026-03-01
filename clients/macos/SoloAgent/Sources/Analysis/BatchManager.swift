import Foundation

/// 批次管理器 — 管理截屏到视频批次的聚合、合成与 AI 分析
@MainActor
final class BatchManager {
    var config: AgentConfig
    private let persistence: PersistenceManager
    private let videoService = VideoProcessingService()
    private let aiClient: AIClient

    private var isProcessing = false

    /// 进度回调：(batchId, 阶段描述)
    var onProgress: (@MainActor (String, String) -> Void)?

    /// 流式 token 回调：(batchId, token)
    var onStreamingToken: (@MainActor (String, String) -> Void)?

    /// 流式完成回调：(batchId, fullText)
    var onStreamingComplete: (@MainActor (String, String) -> Void)?

    init(config: AgentConfig, persistence: PersistenceManager, aiClient: AIClient) {
        self.config = config
        self.persistence = persistence
        self.aiClient = aiClient
    }

    // MARK: - Main Entry

    /// 将当前所有未处理截图作为一个批次处理
    func processCurrentSession() async {
        guard !isProcessing else {
            AIClient.debugLog("[BatchManager] 已有处理中的批次，跳过")
            return
        }
        isProcessing = true
        defer { isProcessing = false }

        let unprocessed = persistence.unprocessedScreenshots()
        let minFrames = max(5, config.videoFrameStride * 3)
        guard unprocessed.count >= minFrames else {
            AIClient.debugLog("[BatchManager] 截图不足 (\(unprocessed.count)/\(minFrames))，跳过")
            return
        }

        let startTs = unprocessed.first!.capturedAt
        let endTs = unprocessed.last!.capturedAt
        let durationSec = endTs - startTs

        guard durationSec >= Int(config.batchMinDuration) else {
            AIClient.debugLog("[BatchManager] 时长不足 (\(durationSec)s < \(Int(config.batchMinDuration))s)，跳过")
            return
        }

        let batch = PendingBatch(screenshots: unprocessed, startTs: startTs, endTs: endTs)
        AIClient.debugLog("[BatchManager] 处理批次: \(unprocessed.count) 截图, \(durationSec)s")

        do {
            try await processBatch(batch)
        } catch {
            AIClient.debugLog("[BatchManager] 批次处理失败: \(error.localizedDescription)")
        }
    }

    /// 定期安全网 — 兼容旧的定时调用入口
    func checkAndProcessBatches() async {
        await processCurrentSession()
    }

    private struct PendingBatch {
        let screenshots: [ScreenshotRecord]
        let startTs: Int
        let endTs: Int
    }

    // MARK: - Regenerate Cards (Phase 2 only)

    /// 只重新生成卡片：用缓存的转录结果，跳过视频转录（Phase 1）
    func regenerateCards(_ batchId: String) async {
        guard let batch = persistence.batchRecord(for: batchId) else {
            AIClient.debugLog("[BatchManager] regenerateCards: 找不到批次 \(batchId)")
            return
        }

        // 检查是否有缓存的转录结果
        guard let jsonStr = batch.transcriptionJson,
              let jsonData = jsonStr.data(using: .utf8),
              let transcription = try? JSONSerialization.jsonObject(with: jsonData) as? [[String: Any]],
              !transcription.isEmpty else {
            AIClient.debugLog("[BatchManager] 无缓存转录，fallback 到完整重分析")
            await reanalyzeBatch(batchId)
            return
        }

        AIClient.debugLog("[BatchManager] 重新生成卡片（跳过视频转录）\(batchId)")

        // 1. 删除旧卡片
        persistence.deleteActivityCards(forBatch: batchId)
        persistence.updateBatchStatus(batchId, status: "processing", errorMessage: nil)

        // 2. 直接用缓存转录 → Phase 2 流式生成
        await onProgress?(batchId, "正在重新生成卡片...")
        let existingCards = persistence.allActivityCardsToday()
        let cards = await streamGenerateCards(batchId: batchId, transcription: transcription, existingCards: existingCards)

        if !cards.isEmpty {
            persistence.saveActivityCards(cards)
            AIClient.debugLog("[BatchManager] 卡片重新生成完成: \(cards.count) 张")
        }

        persistence.updateBatchStatus(batchId, status: "completed")
        await onProgress?(batchId, "完成，共 \(cards.count) 张卡片")
    }

    /// 一键重新整理今日所有卡片：聚合、合并、去重
    func reorganizeTodayCards() async {
        let allCards = persistence.allActivityCardsToday()
        guard !allCards.isEmpty else {
            AIClient.debugLog("[BatchManager] 今日无卡片可整理")
            return
        }

        AIClient.debugLog("[BatchManager] 开始重新整理今日 \(allCards.count) 张卡片")

        // 构建所有卡片的完整信息
        let cardDicts: [[String: Any]] = allCards.map { card in
            [
                "batchId": card.batchId,
                "title": card.title,
                "startTime": card.startTime,
                "endTime": card.endTime,
                "startTs": card.startTs,
                "endTs": card.endTs,
                "category": card.category,
                "summary": card.summary,
                "detailedSummary": card.detailedSummary,
            ]
        }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: cardDicts, options: .prettyPrinted),
              let cardsJson = String(data: jsonData, encoding: .utf8) else { return }

        // 用 plus 模型重新整理
        let prompt = PromptTemplates.reorganizeCardsPrompt(existingCards: cardsJson, mainQuest: config.mainQuest ?? "", motivations: config.motivations ?? [])

        let dummyBatchId = "reorganize_\(UUID().uuidString.prefix(8))"
        await onProgress?(dummyBatchId, "正在整理今日活动...")

        let stream = aiClient.streamGenerateActivityCardsFromPrompt(prompt)
        var fullText = ""
        do {
            for try await token in stream {
                fullText += token
                await onStreamingToken?(dummyBatchId, token)
            }
            await onStreamingComplete?(dummyBatchId, fullText)

            guard let newCardDicts = parseJSONArrayFromStream(fullText) else {
                AIClient.debugLog("[BatchManager] 整理结果 JSON 解析失败")
                await onProgress?(dummyBatchId, "整理失败：JSON 解析错误")
                return
            }

            // 删除所有旧卡片
            for card in allCards {
                persistence.deleteActivityCards(forBatch: card.batchId)
            }

            // 保存整理后的卡片（用第一个 batchId 作为归属）
            let firstBatchId = allCards.first?.batchId ?? dummyBatchId
            let newCards = parseActivityCards(newCardDicts, batchId: firstBatchId)
            if !newCards.isEmpty {
                persistence.saveActivityCards(newCards)
                AIClient.debugLog("[BatchManager] 整理完成: \(allCards.count) → \(newCards.count) 张卡片")
            }
            await onProgress?(dummyBatchId, "整理完成，\(allCards.count) → \(newCards.count) 张卡片")
        } catch {
            AIClient.debugLog("[BatchManager] 整理失败: \(error)")
            await onProgress?(dummyBatchId, "整理失败: \(error.localizedDescription)")
        }
    }

    // MARK: - Re-analyze

    /// 重新分析已有批次：删除旧卡片 → 读视频 → 转录 → 生成卡片 → 保存
    func reanalyzeBatch(_ batchId: String) async {
        guard let batch = persistence.batchRecord(for: batchId),
              let videoPath = batch.videoPath else {
            AIClient.debugLog("[BatchManager] reanalyze: 找不到批次或无视频 \(batchId)")
            return
        }

        AIClient.debugLog("[BatchManager] 重新分析批次 \(batchId)")

        // 1. 删除旧卡片
        persistence.deleteActivityCards(forBatch: batchId)

        // 2. 标记 processing
        persistence.updateBatchStatus(batchId, status: "processing", errorMessage: nil)

        // 3. 读取视频文件
        await onProgress?(batchId, "正在读取视频...")
        let videoURL = URL(fileURLWithPath: videoPath)
        guard let videoData = try? Data(contentsOf: videoURL) else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "无法读取视频文件")
            return
        }

        // 4. 重建帧时间戳（从 batch 关联的截图中恢复）
        let screenshots = persistence.screenshotsForBatch(batchId)
        let frameTimestamps: [Int]
        if !screenshots.isEmpty {
            let stride = max(1, config.videoFrameStride)
            frameTimestamps = stride > 1
                ? screenshots.enumerated().compactMap { $0.offset.isMultiple(of: stride) ? $0.element.capturedAt : nil }
                : screenshots.map { $0.capturedAt }
        } else {
            // fallback: 均匀分布
            let count = max(1, (batch.endTs - batch.startTs))
            frameTimestamps = (0..<count).map { batch.startTs + $0 }
        }

        // 5. Phase 1: 流式视频转录（包含帧→时间映射表，fps 感知）
        await onProgress?(batchId, "正在转录视频...")
        let fps = config.videoFps
        let videoDurationSeconds = frameTimestamps.count / max(1, fps)
        let frameMapping = buildFrameTimeMapping(frameTimestamps, fps: fps)
        let rawTranscription: [[String: Any]]?
        do {
            rawTranscription = try await streamTranscribeVideo(
                batchId: batchId,
                videoData: videoData,
                videoDurationSeconds: videoDurationSeconds,
                frameTimeMapping: frameMapping
            )
        } catch {
            AIClient.debugLog("[BatchManager] 重分析流式转录失败: \(error)")
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "视频转录失败")
            return
        }
        guard let rawTranscription else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "视频转录结果解析失败")
            return
        }

        // 6. 秒数 → 时间戳映射（视频秒 × fps = 帧索引）
        let transcription = mapSecondsToTimestamps(rawTranscription, frameTimestamps: frameTimestamps, fps: fps)

        // 缓存转录结果
        if let jsonData = try? JSONSerialization.data(withJSONObject: transcription, options: []),
           let jsonStr = String(data: jsonData, encoding: .utf8) {
            persistence.updateBatchTranscription(batchId, transcriptionJson: jsonStr)
        }

        // 7. Phase 2: 流式生成活动卡片
        await onProgress?(batchId, "正在生成活动卡片...")
        let existingCards = persistence.allActivityCardsToday()
        let cards = await streamGenerateCards(batchId: batchId, transcription: transcription, existingCards: existingCards)

        if !cards.isEmpty {
            persistence.saveActivityCards(cards)
            AIClient.debugLog("[BatchManager] 重新分析完成: \(cards.count) 张卡片")
        }

        // 8. 标记完成
        persistence.updateBatchStatus(batchId, status: "completed")
        await onProgress?(batchId, "分析完成，共 \(cards.count) 张卡片")
    }

    // MARK: - Batch Processing

    private func processBatch(_ pending: PendingBatch) async throws {
        let batchId = "batch_\(UUID().uuidString.prefix(8))"
        let durationMin = (pending.endTs - pending.startTs) / 60

        AIClient.debugLog("[BatchManager] 处理批次 \(batchId): \(pending.screenshots.count) 截图, \(durationMin)min")

        // 1. 创建批次记录
        let batchRecord = BatchRecord(
            id: batchId,
            startTs: pending.startTs,
            endTs: pending.endTs,
            status: "processing",
            screenshotCount: pending.screenshots.count
        )
        persistence.saveBatch(batchRecord)

        // 2. 标记截图为已分配
        persistence.markScreenshotsAsBatched(pending.screenshots, batchId: batchId)

        // 3. 合成视频 + 获取帧→时间戳映射表
        await onProgress?(batchId, "正在合成视频...")
        let screenshotPairs: [(path: String, timestamp: Int)] = pending.screenshots.map {
            (path: $0.filePath, timestamp: $0.capturedAt)
        }

        let videoResult: VideoProcessingService.VideoResult
        do {
            videoResult = try await videoService.generateVideo(
                screenshots: screenshotPairs,
                fps: config.videoFps,
                maxHeight: config.videoMaxHeight,
                bitRate: config.videoBitRate,
                frameStride: config.videoFrameStride
            )
        } catch {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: error.localizedDescription)
            throw error
        }

        let frameTimestamps = videoResult.frameTimestamps

        // 校正 batch endTs 为视频实际覆盖的最后一帧时间戳（stride 采样可能导致末尾截断）
        if let lastFrameTs = frameTimestamps.last, lastFrameTs != pending.endTs {
            persistence.updateBatchEndTs(batchId, endTs: lastFrameTs)
        }
        persistence.updateBatchStatus(batchId, status: "processing", videoPath: videoResult.url.path)

        // 4. 读取视频数据
        guard let videoData = try? Data(contentsOf: videoResult.url) else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "无法读取视频文件")
            return
        }

        let videoSizeMB = String(format: "%.1f", Double(videoData.count) / 1_048_576.0)
        AIClient.debugLog("[BatchManager] 视频大小: \(videoSizeMB)MB, \(frameTimestamps.count) 帧")
        await onProgress?(batchId, "正在读取视频 (\(videoSizeMB) MB)...")

        // 5. Phase 1: 流式视频转录（包含帧→时间映射表提高精度）
        await onProgress?(batchId, "正在转录视频...")
        let fps = config.videoFps
        let videoDurationSeconds = frameTimestamps.count / max(1, fps)
        let frameMapping = buildFrameTimeMapping(frameTimestamps, fps: fps)
        let rawTranscription: [[String: Any]]?
        do {
            rawTranscription = try await streamTranscribeVideo(
                batchId: batchId,
                videoData: videoData,
                videoDurationSeconds: videoDurationSeconds,
                frameTimeMapping: frameMapping
            )
        } catch {
            AIClient.debugLog("[BatchManager] 流式视频转录失败: \(error)")
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "视频转录失败: \(error.localizedDescription)")
            return
        }
        guard let rawTranscription else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "视频转录结果解析失败")
            return
        }

        // 6. 将 AI 返回的视频秒数映射为真实 Unix 时间戳（秒数 × fps = 帧索引）
        let transcription = mapSecondsToTimestamps(rawTranscription, frameTimestamps: frameTimestamps, fps: fps)

        // 缓存转录结果（重新生成卡片时无需重新转录视频）
        if let jsonData = try? JSONSerialization.data(withJSONObject: transcription, options: []),
           let jsonStr = String(data: jsonData, encoding: .utf8) {
            persistence.updateBatchTranscription(batchId, transcriptionJson: jsonStr)
        }

        // 7. Phase 2: 流式生成活动卡片
        await onProgress?(batchId, "正在生成活动卡片...")
        let existingCards = persistence.allActivityCardsToday()
        let cards = await streamGenerateCards(batchId: batchId, transcription: transcription, existingCards: existingCards)

        // 8. 保存活动卡片
        if !cards.isEmpty {
            persistence.saveActivityCards(cards)
            AIClient.debugLog("[BatchManager] 保存了 \(cards.count) 张活动卡片")
        }

        // 9. 标记批次完成
        persistence.updateBatchStatus(batchId, status: "completed")
        await onProgress?(batchId, "分析完成，共 \(cards.count) 张卡片")
        AIClient.debugLog("[BatchManager] 批次 \(batchId) 处理完成")
    }

    // MARK: - Streaming Video Transcription

    /// 流式视频转录：逐 token 回调 UI，累积后解析 JSON；失败时 fallback 到非流式
    private func streamTranscribeVideo(
        batchId: String,
        videoData: Data,
        videoDurationSeconds: Int,
        frameTimeMapping: String
    ) async throws -> [[String: Any]]? {
        let stream = aiClient.streamTranscribeVideo(
            videoData: videoData,
            videoDurationSeconds: videoDurationSeconds,
            frameTimeMapping: frameTimeMapping
        )

        var fullText = ""
        do {
            for try await token in stream {
                fullText += token
                await onStreamingToken?(batchId, token)
            }

            AIClient.debugLog("[BatchManager] 流式视频转录完成, 总长度: \(fullText.count)")
            await onStreamingComplete?(batchId, fullText)

            // 解析 JSON
            guard let jsonArray = parseJSONArrayFromStream(fullText) else {
                AIClient.debugLog("[BatchManager] 流式转录 JSON 解析失败: \(fullText.prefix(500))")
                return nil
            }

            AIClient.debugLog("[BatchManager] 流式转录成功: \(jsonArray.count) 段")
            return jsonArray

        } catch {
            AIClient.debugLog("[BatchManager] 流式转录失败: \(error), fallback 到非流式")
            await onStreamingComplete?(batchId, "")

            // Fallback 到非流式
            return await aiClient.transcribeVideo(
                videoData: videoData,
                videoDurationSeconds: videoDurationSeconds,
                frameTimeMapping: frameTimeMapping
            )
        }
    }

    // MARK: - Streaming Card Generation

    /// 消费 AsyncThrowingStream，累积文本，逐 token 回调；失败时 fallback 到非流式
    private func streamGenerateCards(
        batchId: String,
        transcription: [[String: Any]],
        existingCards: [ActivityCardRecord]
    ) async -> [ActivityCardRecord] {
        let stream = aiClient.streamGenerateActivityCards(
            transcription: transcription,
            existingCards: existingCards
        )

        var fullText = ""
        do {
            for try await token in stream {
                fullText += token
                await onStreamingToken?(batchId, token)
            }

            AIClient.debugLog("[BatchManager] 流式完成, 总长度: \(fullText.count)")
            await onStreamingComplete?(batchId, fullText)

            // 解析 JSON
            guard let cardDicts = parseJSONArrayFromStream(fullText) else {
                AIClient.debugLog("[BatchManager] 流式 JSON 解析失败, 内容: \(fullText.prefix(500))")
                persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "活动卡片 JSON 解析失败")
                return []
            }

            return parseActivityCards(cardDicts, batchId: batchId)

        } catch {
            AIClient.debugLog("[BatchManager] 流式失败: \(error), fallback 到非流式")
            await onStreamingComplete?(batchId, "")

            // Fallback 到非流式
            guard let cardDicts = await aiClient.generateActivityCards(
                transcription: transcription,
                existingCards: existingCards
            ) else {
                persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "活动卡片生成失败（流式+非流式均失败）")
                return []
            }

            return parseActivityCards(cardDicts, batchId: batchId)
        }
    }

    /// 从流式累积文本中解析 JSON 数组
    private func parseJSONArrayFromStream(_ content: String) -> [[String: Any]]? {
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

        return nil
    }

    // MARK: - 帧→时间映射表（给 AI 用）

    /// 构建视频秒→真实时间映射字符串（fps 感知：视频第 N 秒 = 第 N*fps 帧）
    private func buildFrameTimeMapping(_ frameTimestamps: [Int], fps: Int = 1) -> String {
        guard !frameTimestamps.isEmpty else { return "" }
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        let videoDuration = frameTimestamps.count / max(1, fps)
        // 采样间隔：视频秒数少于 30 则每秒都映射，否则每 5 秒采样
        let step = videoDuration <= 30 ? 1 : 5
        var lines: [String] = []
        for sec in stride(from: 0, to: videoDuration, by: step) {
            let frameIdx = min(sec * fps, frameTimestamps.count - 1)
            let time = fmt.string(from: Date(timeIntervalSince1970: Double(frameTimestamps[frameIdx])))
            lines.append("第\(sec)秒 = \(time)")
        }
        // 确保最后一秒也包含
        let lastSec = videoDuration - 1
        if lastSec > 0 && lastSec % step != 0 {
            let frameIdx = min(lastSec * fps, frameTimestamps.count - 1)
            let time = fmt.string(from: Date(timeIntervalSince1970: Double(frameTimestamps[frameIdx])))
            lines.append("第\(lastSec)秒 = \(time)")
        }
        return lines.joined(separator: ", ")
    }

    // MARK: - 秒数 → 时间戳映射

    /// 将 AI 返回的视频秒数转换为真实 Unix 时间戳（fps 感知：视频第 N 秒 = 第 N*fps 帧）
    private func mapSecondsToTimestamps(
        _ transcription: [[String: Any]],
        frameTimestamps: [Int],
        fps: Int = 1
    ) -> [[String: Any]] {
        guard !frameTimestamps.isEmpty else { return transcription }

        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm"

        return transcription.map { segment -> [String: Any] in
            var mapped = segment
            if let startSec = segment["startSecond"] as? Int {
                let frameIdx = min(max(startSec * fps, 0), frameTimestamps.count - 1)
                let ts = frameTimestamps[frameIdx]
                mapped["startTs"] = ts
                mapped["startTime"] = fmt.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
            }
            if let endSec = segment["endSecond"] as? Int {
                let frameIdx = min(max(endSec * fps, 0), frameTimestamps.count - 1)
                let ts = frameTimestamps[frameIdx]
                mapped["endTs"] = ts
                mapped["endTime"] = fmt.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
            }
            return mapped
        }
    }

    // MARK: - Card Parsing

    private func parseActivityCards(_ dicts: [[String: Any]], batchId: String) -> [ActivityCardRecord] {
        dicts.compactMap { dict -> ActivityCardRecord? in
            guard let title = dict["title"] as? String,
                  let category = dict["category"] as? String,
                  let startTs = dict["startTs"] as? Int,
                  let endTs = dict["endTs"] as? Int else {
                return nil
            }

            // 始终从时间戳按本地时区计算，不用 AI 返回的时间字符串（AI 不知道用户时区）
            let startTime = formatTime(startTs)
            let endTime = formatTime(endTs)
            let summary = dict["summary"] as? String ?? ""
            let detailedSummary = dict["detailedSummary"] as? String ?? ""
            let subcategory = dict["subcategory"] as? String ?? ""

            var distractionsJson: String?
            if let distractions = dict["distractions"] as? [[String: Any]],
               let data = try? JSONSerialization.data(withJSONObject: distractions),
               let str = String(data: data, encoding: .utf8) {
                distractionsJson = str
            }

            var appPrimary: String?
            var appSecondary: String?
            if let appSites = dict["appSites"] as? [String: Any] {
                appPrimary = appSites["primary"] as? String
                appSecondary = appSites["secondary"] as? String
            }

            let goalAlignment = dict["goalAlignment"] as? String

            return ActivityCardRecord(
                batchId: batchId,
                startTime: startTime,
                endTime: endTime,
                startTs: startTs,
                endTs: endTs,
                category: category,
                subcategory: subcategory,
                title: title,
                summary: summary,
                detailedSummary: detailedSummary,
                distractionsJson: distractionsJson,
                appSitePrimary: appPrimary,
                appSiteSecondary: appSecondary,
                goalAlignment: goalAlignment
            )
        }
    }

    private func formatTime(_ ts: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ts))
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }
}
