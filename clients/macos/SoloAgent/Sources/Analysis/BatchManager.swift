import Foundation

/// 批次管理器 — 管理截屏到视频批次的聚合、合成与 AI 分析
@MainActor
final class BatchManager {
    var config: AgentConfig
    private let persistence: PersistenceManager
    private let videoService = VideoProcessingService()
    private let aiClient: AIClient

    private var isProcessing = false

    init(config: AgentConfig, persistence: PersistenceManager, aiClient: AIClient) {
        self.config = config
        self.persistence = persistence
        self.aiClient = aiClient
    }

    // MARK: - Main Entry (每 60 秒调用)

    func checkAndProcessBatches() async {
        guard !isProcessing else {
            AIClient.debugLog("[BatchManager] 已有处理中的批次，跳过")
            return
        }
        isProcessing = true
        defer { isProcessing = false }

        // 1. 获取未分配批次的截图
        let unprocessed = persistence.unprocessedScreenshots()
        guard unprocessed.count >= 5 else {
            AIClient.debugLog("[BatchManager] 未处理截图不足 (\(unprocessed.count))，等待更多")
            return
        }

        // 2. 分割为批次
        let batches = createBatches(from: unprocessed)
        AIClient.debugLog("[BatchManager] 创建了 \(batches.count) 个批次")

        // 3. 处理每个批次
        for batch in batches {
            do {
                try await processBatch(batch)
            } catch {
                AIClient.debugLog("[BatchManager] 批次处理失败: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Batch Creation

    private struct PendingBatch {
        let screenshots: [ScreenshotRecord]
        let startTs: Int
        let endTs: Int
    }

    private func createBatches(from screenshots: [ScreenshotRecord]) -> [PendingBatch] {
        guard !screenshots.isEmpty else { return [] }

        var batches: [PendingBatch] = []
        var currentBatch: [ScreenshotRecord] = []
        var batchStartTs: Int = screenshots[0].capturedAt

        for (index, shot) in screenshots.enumerated() {
            if currentBatch.isEmpty {
                currentBatch.append(shot)
                batchStartTs = shot.capturedAt
                continue
            }

            let lastTs = currentBatch.last!.capturedAt
            let gap = shot.capturedAt - lastTs
            let batchDuration = shot.capturedAt - batchStartTs

            // 间隔超过阈值 → 断开新批次
            if Double(gap) > config.batchMaxGap {
                if let batch = finalizeBatch(currentBatch, startTs: batchStartTs) {
                    batches.append(batch)
                }
                currentBatch = [shot]
                batchStartTs = shot.capturedAt
                continue
            }

            // 达到目标时长 → 完成当前批次
            if Double(batchDuration) >= config.batchTargetDuration {
                currentBatch.append(shot)
                if let batch = finalizeBatch(currentBatch, startTs: batchStartTs) {
                    batches.append(batch)
                }
                currentBatch = []
                continue
            }

            currentBatch.append(shot)
        }

        // 处理剩余截图
        // 如果最后一个截图距现在超过目标时长，才处理（否则等待更多截图）
        if !currentBatch.isEmpty {
            let lastTs = currentBatch.last!.capturedAt
            let now = Int(Date().timeIntervalSince1970)
            let sinceLastShot = now - lastTs

            if Double(sinceLastShot) > config.batchMaxGap ||
               Double(lastTs - batchStartTs) >= config.batchTargetDuration {
                if let batch = finalizeBatch(currentBatch, startTs: batchStartTs) {
                    batches.append(batch)
                }
            }
        }

        return batches
    }

    private func finalizeBatch(_ screenshots: [ScreenshotRecord], startTs: Int) -> PendingBatch? {
        guard !screenshots.isEmpty else { return nil }
        let endTs = screenshots.last!.capturedAt
        let duration = Double(endTs - startTs)

        // 低于最小有效时长 → 跳过
        // 最小时长不能超过目标时长的一半，否则短批次永远无法处理
        let effectiveMinDuration = min(config.batchMinDuration, config.batchTargetDuration * 0.5)
        if duration < effectiveMinDuration {
            AIClient.debugLog("[BatchManager] 批次时长不足 (\(Int(duration))s < \(Int(effectiveMinDuration))s)，跳过")
            return nil
        }

        return PendingBatch(screenshots: screenshots, startTs: startTs, endTs: endTs)
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

        // 3. 合成视频
        let screenshotPairs: [(path: String, timestamp: Int)] = pending.screenshots.map {
            (path: $0.filePath, timestamp: $0.capturedAt)
        }

        let videoURL: URL
        do {
            videoURL = try await videoService.generateVideo(
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

        persistence.updateBatchStatus(batchId, status: "processing", videoPath: videoURL.path)

        // 4. 读取视频数据
        guard let videoData = try? Data(contentsOf: videoURL) else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "无法读取视频文件")
            return
        }

        let videoSizeMB = String(format: "%.1f", Double(videoData.count) / 1_048_576.0)
        AIClient.debugLog("[BatchManager] 视频大小: \(videoSizeMB)MB")

        // 5. Phase 1: 视频转录
        guard let transcription = await aiClient.transcribeVideo(
            videoData: videoData,
            startTimestamp: pending.startTs,
            endTimestamp: pending.endTs,
            screenshotCount: pending.screenshots.count
        ) else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "视频转录失败")
            return
        }

        // 6. Phase 2: 生成活动卡片
        let existingCards = persistence.allActivityCardsToday()
        guard let cardDicts = await aiClient.generateActivityCards(
            transcription: transcription,
            existingCards: existingCards
        ) else {
            persistence.updateBatchStatus(batchId, status: "failed", errorMessage: "活动卡片生成失败")
            return
        }

        // 7. 解析并保存活动卡片
        let cards = parseActivityCards(cardDicts, batchId: batchId)
        if !cards.isEmpty {
            persistence.saveActivityCards(cards)
            AIClient.debugLog("[BatchManager] 保存了 \(cards.count) 张活动卡片")
        }

        // 8. 标记批次完成
        persistence.updateBatchStatus(batchId, status: "completed")
        AIClient.debugLog("[BatchManager] 批次 \(batchId) 处理完成")
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
                appSiteSecondary: appSecondary
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
