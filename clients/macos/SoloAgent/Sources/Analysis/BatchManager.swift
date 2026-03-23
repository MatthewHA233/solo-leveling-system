import Foundation

/// 批次管理器 — 管理截屏到视频批次的聚合、合成与 AI 分析
@MainActor
final class BatchManager {
    var config: AgentConfig
    private let persistence: PersistenceManager
    private let videoService = VideoProcessingService()
    private let aiClient: AIClient
    var contextAdvisor: ContextAdvisor?

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

    /// 统一批次处理入口 — 检测所有间隔，按 session 切段分别处理
    ///
    /// 算法：
    ///   1. 取所有未处理截图，按 > 5min 间隔切成多个 segment
    ///   2. 对于「历史段」（最后一帧距现在 > gapThreshold）：立即处理（无论多短，过短打 skipped 标记）
    ///   3. 对于「当前段」（最后一帧距现在 ≤ gapThreshold）：仅当时长足够才处理
    ///
    /// 此设计替代了旧版 processCurrentSession（无间隔检测）+
    /// processOrphanedScreenshots（只在启动且满足时间条件时才运行）的组合逻辑。
    func checkAndProcessBatches() async {
        guard !isProcessing else {
            AIClient.debugLog("[BatchManager] 已有处理中的批次，跳过")
            return
        }
        isProcessing = true
        defer { isProcessing = false }

        let all = persistence.unprocessedScreenshots()
        guard !all.isEmpty else { return }

        let gapThreshold = 5 * 60   // 相邻截图 > 5min → 不同 session
        let now = Int(Date().timeIntervalSince1970)
        let minFramesForSkip = max(3, config.videoFrameStride)
        let minFramesForBatch = max(5, config.videoFrameStride * 3)

        // 1. 按间隔切分所有未处理截图
        var segments: [[ScreenshotRecord]] = []
        var cur: [ScreenshotRecord] = [all[0]]
        for i in 1..<all.count {
            if all[i].capturedAt - all[i - 1].capturedAt > gapThreshold {
                segments.append(cur)
                cur = [all[i]]
            } else {
                cur.append(all[i])
            }
        }
        segments.append(cur)

        if segments.count > 1 {
            AIClient.debugLog("[BatchManager] 未处理截图切分为 \(segments.count) 段（含跨 session 断层）")
        }

        // 2. 依次处理每段
        for (idx, shots) in segments.enumerated() {
            let startTs     = shots.first!.capturedAt
            let endTs       = shots.last!.capturedAt
            let durationSec = endTs - startTs
            let isLastSeg   = (idx == segments.count - 1)
            let ageOfLastShot = now - endTs  // 最后一帧距现在多久

            // 当前段（最近 gapThreshold 内仍有新截图）→ 只有时长足够才处理
            if isLastSeg && ageOfLastShot <= gapThreshold {
                guard shots.count >= minFramesForBatch,
                      durationSec >= Int(config.batchMinDuration) else {
                    AIClient.debugLog("[BatchManager] 当前 session 尚未积累足够（\(shots.count) 张, \(durationSec)s），等下次")
                    continue
                }
            }

            // 过短的段（历史段）→ 打 skipped 标记，清出 unprocessed 队列
            guard shots.count >= minFramesForSkip,
                  durationSec >= Int(config.batchMinDuration) else {
                AIClient.debugLog("[BatchManager] 段 \(idx + 1) 过短 (\(shots.count) 张, \(durationSec)s)，标记跳过")
                let skipId = "orphan_skip_\(UUID().uuidString.prefix(8))"
                persistence.saveBatch(BatchRecord(
                    id: skipId, startTs: startTs, endTs: endTs,
                    status: "skipped", screenshotCount: shots.count
                ))
                persistence.markScreenshotsAsBatched(shots, batchId: skipId)
                continue
            }

            let srcLabel = isLastSeg && ageOfLastShot <= gapThreshold ? "当前session" : "历史遗留"
            AIClient.debugLog("[BatchManager] 处理段 \(idx + 1)/\(segments.count) [\(srcLabel)]: \(shots.count) 张, \(durationSec / 60)min")

            let batch = PendingBatch(screenshots: shots, startTs: startTs, endTs: endTs)
            do {
                try await processBatch(batch)
            } catch {
                AIClient.debugLog("[BatchManager] 段 \(idx + 1) 处理失败: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Orphaned Session Recovery

    /// 启动时调用 — 现在直接复用 checkAndProcessBatches 的统一逻辑
    /// （旧实现因「now - lastTs > gapThreshold」守卫，快速重启时会漏掉遗留截图）
    func processOrphanedScreenshots(gapThreshold: Int = 5 * 60) async {
        AIClient.debugLog("[BatchManager] 启动时检查遗留截图...")
        await checkAndProcessBatches()
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

        // 2. 构建上下文提示
        let contextHint = contextAdvisor?.buildContextHint(
            startTs: batch.startTs, endTs: batch.endTs, config: config
        ) ?? ""

        // 3. 直接用缓存转录 → Phase 2 流式生成
        await onProgress?(batchId, "正在重新生成卡片...")
        let existingCards = persistence.allActivityCardsToday()
        let cards = await streamGenerateCards(batchId: batchId, transcription: transcription, existingCards: existingCards, contextHint: contextHint)

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

        // 5. 构建上下文提示
        let contextHint = contextAdvisor?.buildContextHint(
            startTs: batch.startTs, endTs: batch.endTs, config: config
        ) ?? ""

        // 6. Phase 1: 流式视频转录（包含帧→时间映射表，fps 感知）
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
                frameTimeMapping: frameMapping,
                contextHint: contextHint
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

        // 7. 秒数 → 时间戳映射（视频秒 × fps = 帧索引）
        let transcription = mapSecondsToTimestamps(rawTranscription, frameTimestamps: frameTimestamps, fps: fps)

        // 缓存转录结果
        if let jsonData = try? JSONSerialization.data(withJSONObject: transcription, options: []),
           let jsonStr = String(data: jsonData, encoding: .utf8) {
            persistence.updateBatchTranscription(batchId, transcriptionJson: jsonStr)
        }

        // 8. Phase 2: 流式生成活动卡片
        await onProgress?(batchId, "正在生成活动卡片...")
        let existingCards = persistence.allActivityCardsToday()
        let cards = await streamGenerateCards(batchId: batchId, transcription: transcription, existingCards: existingCards, contextHint: contextHint)

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

        // 保存帧时间戳序列（前端精确时间映射用，与发给 AI 的映射表数据一致）
        persistence.updateBatchFrameTimestamps(batchId, timestamps: frameTimestamps)

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

        // 5. 构建上下文提示
        let contextHint = contextAdvisor?.buildContextHint(
            startTs: pending.startTs, endTs: pending.endTs, config: config
        ) ?? ""
        if !contextHint.isEmpty {
            AIClient.debugLog("[BatchManager] contextHint: \(contextHint.prefix(200))")
        }

        // 6. Phase 1: 流式视频转录（包含帧→时间映射表提高精度）
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
                frameTimeMapping: frameMapping,
                contextHint: contextHint
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

        // 8. Phase 2: 流式生成活动卡片
        await onProgress?(batchId, "正在生成活动卡片...")
        let existingCards = persistence.allActivityCardsToday()
        let cards = await streamGenerateCards(batchId: batchId, transcription: transcription, existingCards: existingCards, contextHint: contextHint)

        // 9. 保存活动卡片
        if !cards.isEmpty {
            persistence.saveActivityCards(cards)
            AIClient.debugLog("[BatchManager] 保存了 \(cards.count) 张活动卡片")
        }

        // 10. 标记批次完成
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
        frameTimeMapping: String,
        contextHint: String = ""
    ) async throws -> [[String: Any]]? {
        // 保存 Phase 1 prompt（与 AIClient 内部构建的 prompt 相同）
        let p1Prompt = PromptTemplates.videoTranscriptionPrompt(
            videoDurationSeconds: videoDurationSeconds,
            frameTimeMapping: frameTimeMapping,
            contextHint: contextHint
        )
        persistence.updateBatchDebugLogs(batchId, phase1Prompt: p1Prompt)

        let stream = aiClient.streamTranscribeVideo(
            videoData: videoData,
            videoDurationSeconds: videoDurationSeconds,
            frameTimeMapping: frameTimeMapping,
            contextHint: contextHint
        )

        var fullText = ""
        do {
            for try await token in stream {
                fullText += token
                await onStreamingToken?(batchId, token)
            }

            AIClient.debugLog("[BatchManager] 流式视频转录完成, 总长度: \(fullText.count)")
            AIClient.debugLog("[RESPONSE Phase1] fullText=\(fullText)")
            persistence.updateBatchDebugLogs(batchId, phase1Response: fullText)
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
            persistence.updateBatchDebugLogs(batchId, phase1Response: "流式失败: \(error)")
            await onStreamingComplete?(batchId, "")

            // Fallback 到非流式
            return await aiClient.transcribeVideo(
                videoData: videoData,
                videoDurationSeconds: videoDurationSeconds,
                frameTimeMapping: frameTimeMapping,
                contextHint: contextHint
            )
        }
    }

    // MARK: - Streaming Card Generation

    /// 消费 AsyncThrowingStream，累积文本，逐 token 回调；失败时 fallback 到非流式
    private func streamGenerateCards(
        batchId: String,
        transcription: [[String: Any]],
        existingCards: [ActivityCardRecord],
        contextHint: String = ""
    ) async -> [ActivityCardRecord] {
        // 保存 Phase 2 prompt（与 AIClient 内部构建的 prompt 相同）
        let transcriptionJson = (try? JSONSerialization.data(withJSONObject: transcription, options: .prettyPrinted))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        var existingJson = "[]"
        if !existingCards.isEmpty {
            let cardDicts: [[String: Any]] = existingCards.map { c in [
                "title": c.title, "category": c.category,
                "startTime": c.startTime, "endTime": c.endTime, "summary": c.summary
            ]}
            existingJson = (try? JSONSerialization.data(withJSONObject: cardDicts, options: .prettyPrinted))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        }
        let p2Prompt = PromptTemplates.activityCardPrompt(
            transcription: transcriptionJson,
            existingCards: existingJson,
            mainQuest: config.mainQuest ?? "",
            motivations: config.motivations ?? [],
            contextHint: contextHint
        )
        persistence.updateBatchDebugLogs(batchId, phase2Prompt: p2Prompt)

        let stream = aiClient.streamGenerateActivityCards(
            transcription: transcription,
            existingCards: existingCards,
            contextHint: contextHint
        )

        var fullText = ""
        do {
            for try await token in stream {
                fullText += token
                await onStreamingToken?(batchId, token)
            }

            AIClient.debugLog("[BatchManager] 流式完成, 总长度: \(fullText.count)")
            AIClient.debugLog("[RESPONSE Phase2] fullText=\(fullText)")
            persistence.updateBatchDebugLogs(batchId, phase2Response: fullText)
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
            persistence.updateBatchDebugLogs(batchId, phase2Response: "流式失败: \(error)")
            await onStreamingComplete?(batchId, "")

            // Fallback 到非流式
            guard let cardDicts = await aiClient.generateActivityCards(
                transcription: transcription,
                existingCards: existingCards,
                contextHint: contextHint
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
