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

        // 5. Phase 1: 视频转录
        await onProgress?(batchId, "正在转录视频...")
        guard let rawTranscription = await aiClient.transcribeVideo(
            videoData: videoData,
            videoDurationSeconds: frameTimestamps.count
        ) else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "视频转录失败")
            return
        }

        // 6. 秒数 → 时间戳映射
        let transcription = mapSecondsToTimestamps(rawTranscription, frameTimestamps: frameTimestamps)

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
                fps: 1,
                maxHeight: config.videoMaxHeight,
                bitRate: config.videoBitRate,
                frameStride: config.videoFrameStride
            )
        } catch {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: error.localizedDescription)
            throw error
        }

        let frameTimestamps = videoResult.frameTimestamps
        persistence.updateBatchStatus(batchId, status: "processing", videoPath: videoResult.url.path)

        // 4. 读取视频数据
        guard let videoData = try? Data(contentsOf: videoResult.url) else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "无法读取视频文件")
            return
        }

        let videoSizeMB = String(format: "%.1f", Double(videoData.count) / 1_048_576.0)
        AIClient.debugLog("[BatchManager] 视频大小: \(videoSizeMB)MB, \(frameTimestamps.count) 帧")
        await onProgress?(batchId, "正在读取视频 (\(videoSizeMB) MB)...")

        // 5. Phase 1: 视频转录（AI 返回视频秒数，非真实时间戳）
        await onProgress?(batchId, "正在转录视频...")
        guard let rawTranscription = await aiClient.transcribeVideo(
            videoData: videoData,
            videoDurationSeconds: frameTimestamps.count
        ) else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "视频转录失败")
            return
        }

        // 6. 将 AI 返回的秒数映射为真实 Unix 时间戳
        let transcription = mapSecondsToTimestamps(rawTranscription, frameTimestamps: frameTimestamps)

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

    // MARK: - 秒数 → 时间戳映射

    /// 将 AI 返回的视频秒数转换为真实 Unix 时间戳，字段名与 Phase 2 输出对齐
    private func mapSecondsToTimestamps(
        _ transcription: [[String: Any]],
        frameTimestamps: [Int]
    ) -> [[String: Any]] {
        guard !frameTimestamps.isEmpty else { return transcription }

        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm"

        return transcription.map { segment -> [String: Any] in
            var mapped = segment
            if let startSec = segment["startSecond"] as? Int {
                let idx = min(max(startSec, 0), frameTimestamps.count - 1)
                let ts = frameTimestamps[idx]
                mapped["startTs"] = ts
                mapped["startTime"] = fmt.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
            }
            if let endSec = segment["endSecond"] as? Int {
                let idx = min(max(endSec, 0), frameTimestamps.count - 1)
                let ts = frameTimestamps[idx]
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
