import Foundation
import AVFoundation

/// 语音交互主服务 — 录音 → Qwen3 Omni → Fish TTS 播放
@MainActor
final class VoiceService: ObservableObject {
    @Published var isRecording: Bool = false
    @Published var isPlaying: Bool = false
    @Published var isThinking: Bool = false
    /// 实时音量 (0~1)，供意识体 UI 做音频响应
    @Published var audioLevel: Float = 0

    /// 主动询问文本（非 nil 时 fairy 激活并显示气泡）
    @Published var inquiryText: String? = nil
    /// 主动询问上下文（注入到下次语音处理的 system prompt）
    var pendingInquiryContext: String? = nil
    /// 自动消失计时器
    private var inquiryDismissTask: Task<Void, Never>?

    private var audioEngine: AVAudioEngine?
    /// 原始录音缓冲 — 收集麦克风原生格式的 PCM buffer
    private var rawBuffers: [AVAudioPCMBuffer] = []
    private var inputFormat: AVAudioFormat?
    private let targetSampleRate: Double = 16000

    private var playbackEngine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var fishClient: FishTTSClient?

    // 静音检测：收到音频后若沉默 1.5s 则自动判定播放结束
    private var hasPlayedAudio: Bool = false
    private var silentSince: Date? = nil

    private var currentProcessTask: Task<Void, Never>?

    // MARK: - Recording

    /// 开始录音 — 收集麦克风原生格式，停止时统一转换
    func startRecording() {
        guard !isRecording else { return }

        // 如果有主动询问气泡，用户开始录音意味着正在回应，收起气泡
        if inquiryText != nil {
            inquiryDismissTask?.cancel()
            inquiryDismissTask = nil
            inquiryText = nil
            // pendingInquiryContext 保留，在 processVoice 中注入
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let nativeFormat = inputNode.outputFormat(forBus: 0)

        AIClient.debugLog("[Voice] 麦克风原生格式: \(nativeFormat.sampleRate)Hz, \(nativeFormat.channelCount)ch, \(nativeFormat.commonFormat.rawValue)")

        rawBuffers.removeAll()
        inputFormat = nativeFormat

        // 用麦克风原生格式安装 tap，不做实时转换
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: nativeFormat) { [weak self] buffer, _ in
            // 拷贝 buffer（tap 的 buffer 会被复用）
            guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return }
            copy.frameLength = buffer.frameLength
            let src = buffer.floatChannelData!
            let dst = copy.floatChannelData!
            for ch in 0..<Int(buffer.format.channelCount) {
                memcpy(dst[ch], src[ch], Int(buffer.frameLength) * MemoryLayout<Float>.size)
            }
            // 计算 RMS 音量
            let frames = Int(buffer.frameLength)
            var sum: Float = 0
            let ch0 = src[0]
            for i in 0..<frames { sum += ch0[i] * ch0[i] }
            let rms = sqrt(sum / max(Float(frames), 1))
            Task { @MainActor [weak self] in
                self?.audioLevel = min(rms * 3, 1) // 放大到 0~1 范围
                self?.rawBuffers.append(copy)
            }
        }

        do {
            try engine.start()
            audioEngine = engine
            isRecording = true
            AIClient.debugLog("[Voice] 录音开始")
        } catch {
            AIClient.debugLog("[Voice] 录音启动失败: \(error.localizedDescription)")
        }
    }

    /// 停止录音，返回 WAV data (16kHz mono 16-bit)
    func stopRecording() -> Data? {
        guard isRecording, let engine = audioEngine else { return nil }

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        audioEngine = nil
        isRecording = false

        let buffers = rawBuffers
        let srcFormat = inputFormat
        rawBuffers.removeAll()
        inputFormat = nil

        guard !buffers.isEmpty, let srcFormat else {
            AIClient.debugLog("[Voice] 录音为空")
            return nil
        }

        // 统计原始帧数
        let totalFrames = buffers.reduce(0) { $0 + Int($1.frameLength) }
        let durationSec = Double(totalFrames) / srcFormat.sampleRate
        AIClient.debugLog("[Voice] 录音停止, 原始帧数: \(totalFrames), 时长: \(String(format: "%.1f", durationSec))s")

        // 合并所有 buffer 到一个大 buffer
        guard let mergedBuffer = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: AVAudioFrameCount(totalFrames)) else {
            AIClient.debugLog("[Voice] 无法创建合并缓冲")
            return nil
        }
        var offset: AVAudioFrameCount = 0
        for buf in buffers {
            let frames = buf.frameLength
            for ch in 0..<Int(srcFormat.channelCount) {
                memcpy(
                    mergedBuffer.floatChannelData![ch].advanced(by: Int(offset)),
                    buf.floatChannelData![ch],
                    Int(frames) * MemoryLayout<Float>.size
                )
            }
            offset += frames
        }
        mergedBuffer.frameLength = offset

        // 转换到 16kHz mono Float32
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: false
        ) else {
            AIClient.debugLog("[Voice] 无法创建目标格式")
            return nil
        }

        guard let converter = AVAudioConverter(from: srcFormat, to: targetFormat) else {
            AIClient.debugLog("[Voice] 无法创建转换器 \(srcFormat) → \(targetFormat)")
            return nil
        }

        let targetFrameCount = AVAudioFrameCount(Double(totalFrames) * targetSampleRate / srcFormat.sampleRate)
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: targetFrameCount) else {
            AIClient.debugLog("[Voice] 无法创建输出缓冲")
            return nil
        }

        var inputConsumed = false
        var convError: NSError?
        converter.convert(to: outputBuffer, error: &convError) { _, outStatus in
            if inputConsumed {
                outStatus.pointee = .endOfStream
                return nil
            }
            inputConsumed = true
            outStatus.pointee = .haveData
            return mergedBuffer
        }

        if let convError {
            AIClient.debugLog("[Voice] 转换错误: \(convError.localizedDescription)")
            return nil
        }

        // 读取转换后的 Float32 samples
        guard let channelData = outputBuffer.floatChannelData?[0] else {
            AIClient.debugLog("[Voice] 输出缓冲无数据")
            return nil
        }
        let sampleCount = Int(outputBuffer.frameLength)
        let samples = Array(UnsafeBufferPointer(start: channelData, count: sampleCount))

        // 检查音频电平
        let maxLevel = samples.map { abs($0) }.max() ?? 0
        let rms = sqrt(samples.map { $0 * $0 }.reduce(0, +) / Float(max(sampleCount, 1)))
        AIClient.debugLog("[Voice] 转换完成: \(sampleCount) 帧, 峰值: \(String(format: "%.4f", maxLevel)), RMS: \(String(format: "%.4f", rms))")

        if maxLevel < 0.001 {
            AIClient.debugLog("[Voice] 警告: 音频电平极低，可能没有收到声音")
        }

        let wavData = samplesToWAV(samples, sampleRate: Int(targetSampleRate))
        AIClient.debugLog("[Voice] WAV: \(wavData.count / 1024)KB")
        return wavData
    }

    // MARK: - Proactive Inquiry (主动询问 fairy 交互)

    /// 显示主动询问 — fairy 激活 + 文字气泡 + 自动 20s 后消失
    func showInquiry(_ text: String, context: String) {
        inquiryText = text
        pendingInquiryContext = context
        AIClient.debugLog("[Voice] 主动询问: \(text.prefix(30))")

        // 20s 后自动消失
        inquiryDismissTask?.cancel()
        inquiryDismissTask = Task {
            try? await Task.sleep(for: .seconds(20))
            dismissInquiry()
        }
    }

    /// 清除主动询问状态
    func dismissInquiry() {
        inquiryDismissTask?.cancel()
        inquiryDismissTask = nil
        inquiryText = nil
        pendingInquiryContext = nil
    }

    // MARK: - Full Pipeline

    /// 完整流程: 录音数据 → Qwen3 Omni → 对话 UI + Fish TTS
    func processVoice(wavData: Data, agent: ShadowAgent, manager: AgentManager) async {
        isThinking = true
        defer { isThinking = false }
        
        let config = manager.config

        // 1. 构建 system prompt（与文字聊天相同的上下文）
        let systemPrompt = buildVoiceSystemPrompt(config: config, manager: manager)

        // 2. 从 AgentMemory 提取近期对话历史（user/assistant 文本轮次）
        let historyMessages = buildVoiceHistory(agent: agent)

        // 3. Base64 编码音频
        let audioBase64 = wavData.base64EncodedString()

        // 4. 创建 AI Client 并发送流式请求（注入对话历史）
        let aiClient = AIClient(config: config)
        let stream = aiClient.streamOmniAudio(
            systemPrompt: systemPrompt,
            historyMessages: historyMessages,
            audioBase64: audioBase64,
            audioFormat: "wav"
        )

        // 记录语音输入到 AgentMemory
        agent.memory.appendUser("（语音输入）")

        // 4. 追加 agent 消息占位（流式填充）
        let msgIndex = agent.messages.count
        agent.messages.append(AgentMessage(role: .agent, content: "", icon: "waveform", isStreaming: true))

        // 5. 准备 Fish TTS（如果有 API Key）
        var ttsClient: FishTTSClient?
        var textBuffer = ""
        let hasFishKey = config.fishApiKey != nil && !config.fishApiKey!.isEmpty

        if hasFishKey {
            let client = FishTTSClient()
            ttsClient = client
            self.fishClient = client

            // 启动播放引擎
            setupPlaybackEngine()
            client.onAudioChunk = { [weak self] chunk in
                self?.playAudioChunk(chunk)
            }
            client.onFinish = { [weak self] in
                Task { @MainActor in
                    self?.isPlaying = false
                    AIClient.debugLog("[Voice] TTS 播放完成")
                }
            }

            do {
                try await client.connect(
                    apiKey: config.fishApiKey!,
                    referenceId: config.fishReferenceId,
                    format: "pcm",
                    apiBase: config.fishApiBase,
                    proxyPort: config.fishProxyPort
                )
                isPlaying = true
            } catch {
                AIClient.debugLog("[Voice] Fish TTS 连接失败: \(error.localizedDescription)")
                ttsClient = nil
            }
        }

        // 6. 消费流式 tokens
        var fullText = ""
        do {
            for try await token in stream {
                fullText += token
                textBuffer += token

                // 更新 UI
                if msgIndex < agent.messages.count {
                    agent.messages[msgIndex].content = fullText
                }

                // 在标点/换行处分段送入 TTS
                if let client = ttsClient, shouldFlushTTS(textBuffer) {
                    AIClient.debugLog("[Voice] → TTS sendText: \"\(textBuffer.prefix(20))...\"")
                    client.sendText(textBuffer)
                    textBuffer = ""
                }
            }
        } catch {
            AIClient.debugLog("[Voice] 流式接收错误: \(error.localizedDescription)")
        }

        // 7. 发送剩余文本并 flush
        if let client = ttsClient {
            if !textBuffer.isEmpty {
                AIClient.debugLog("[Voice] → TTS sendText (剩余): \"\(textBuffer.prefix(20))\"")
                client.sendText(textBuffer)
            }
            AIClient.debugLog("[Voice] → TTS flush, 全文: \"\(fullText.prefix(30))\"")
            client.flush()
        }

        // 8. 标记流式完成 + 写入 AgentMemory
        if msgIndex < agent.messages.count {
            agent.messages[msgIndex].content = fullText.isEmpty ? "（无法识别语音）" : fullText
            agent.messages[msgIndex].isStreaming = false
        }
        if !fullText.isEmpty {
            agent.memory.appendAssistant(text: fullText, toolCalls: nil)
            agent.memory.save()
        }
        ChatHistoryStore.save(agent.messages)

        AIClient.debugLog("[Voice] 全流程完成, 回复长度: \(fullText.count)")
    }

    // MARK: - Playback

    /// 停止播放
    func stopPlayback() {
        fishClient?.stop()
        fishClient = nil
        playerNode?.stop()
        playbackEngine?.mainMixerNode.removeTap(onBus: 0)
        playbackEngine?.stop()
        playbackEngine = nil
        playerNode = nil
        isPlaying = false
        isThinking = false
        audioLevel = 0
        hasPlayedAudio = false
        silentSince = nil
    }

    private func setupPlaybackEngine() {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)

        // Fish TTS PCM: 24kHz, Float32, mono（AVAudioEngine 原生格式）
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 24000,
            channels: 1,
            interleaved: false
        ) else {
            AIClient.debugLog("[Voice] 播放格式创建失败")
            return
        }

        engine.connect(player, to: engine.mainMixerNode, format: format)

        // 监控播放音量 + 静音检测
        let mixerFormat = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: mixerFormat) { [weak self] buffer, _ in
            guard let ch0 = buffer.floatChannelData?[0] else { return }
            let frames = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<frames { sum += ch0[i] * ch0[i] }
            let rms = sqrt(sum / max(Float(frames), 1))
            Task { @MainActor [weak self] in
                guard let self = self else { return }
                self.audioLevel = min(rms * 3, 1)
                // 静音检测：收到音频后，沉默超过 1.5s 认为播放结束
                guard self.isPlaying && self.hasPlayedAudio else { return }
                if rms < 0.005 {
                    if let start = self.silentSince {
                        if Date().timeIntervalSince(start) > 1.5 {
                            AIClient.debugLog("[Voice] 静音 1.5s，自动判定播放结束")
                            self.stopPlayback()
                        }
                    } else {
                        self.silentSince = Date()
                    }
                } else {
                    self.silentSince = nil
                }
            }
        }

        do {
            try engine.start()
            player.play()
            playbackEngine = engine
            playerNode = player
            AIClient.debugLog("[Voice] 播放引擎启动成功 24kHz Float32 mono")
        } catch {
            AIClient.debugLog("[Voice] 播放引擎启动失败: \(error.localizedDescription)")
        }
    }

    private func playAudioChunk(_ data: Data) {
        guard let player = playerNode else {
            AIClient.debugLog("[Voice] playAudioChunk: playerNode 为 nil")
            return
        }

        // Fish TTS 返回 int16 PCM，转换为 Float32
        let sampleCount = data.count / 2
        guard sampleCount > 0 else { return }

        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 24000,
            channels: 1,
            interleaved: false
        ), let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(sampleCount)
        ) else { return }

        buffer.frameLength = AVAudioFrameCount(sampleCount)

        // int16 → float32 转换（-32768..32767 → -1.0..1.0）
        data.withUnsafeBytes { raw in
            guard let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self),
                  let dst = buffer.floatChannelData?[0] else { return }
            for i in 0..<sampleCount {
                dst[i] = Float(src[i]) / 32768.0
            }
        }

        AIClient.debugLog("[Voice] 播放音频块: \(sampleCount) 帧 (\(data.count) bytes)")
        hasPlayedAudio = true
        silentSince = nil // 收到新音频，重置静音计时
        player.scheduleBuffer(buffer)
    }

    // MARK: - Helpers

    /// 是否应该 flush 文本到 TTS（在标点/换行处分段）
    private func shouldFlushTTS(_ text: String) -> Bool {
        let punctuation: Set<Character> = ["。", "！", "？", "；", "，", ".", "!", "?", ";", "\n"]
        guard let last = text.last else { return false }
        return punctuation.contains(last) && text.count >= 2
    }

    /// 构建语音交互的 system prompt（与文字聊天共享上下文）
    private func buildVoiceSystemPrompt(config: AgentConfig, manager: AgentManager) -> String {
        // 注入 contextAdvisor 上下文（近 30 分钟活动、规则、主线等）
        let now = Int(Date().timeIntervalSince1970)
        let contextHint = manager.contextAdvisor.buildContextHint(
            startTs: now - 1800, endTs: now, config: config
        )

        let player = manager.player

        var prompt = """
        你是「暗影智能体」，独自升级系统的 AI 语音助手。用户正在通过语音与你对话。

        规则：
        - 用简短自然的中文回答，像面对面交流一样
        - 回答控制在 3-5 句以内
        - 不要输出 Markdown 格式符号（如 ** # - 等）
        - 直接回答问题，不要复述用户说的话

        用户当前等级：Lv.\(player.level) \(player.title)，经验 \(player.exp)/\(player.expToNext)
        """

        if let quest = config.mainQuest, !quest.isEmpty {
            prompt += "\n用户主线目标：\(quest)"
        }

        if !contextHint.isEmpty {
            prompt += "\n\n## 当前上下文\n\(contextHint)"
        }

        // 如果有主动询问上下文，注入到 prompt
        if let inquiryCtx = pendingInquiryContext {
            prompt += "\n\n## 主动询问背景\n\(inquiryCtx)\n用户刚刚通过语音回应了你的主动询问。请根据他的回答，用 set_window_task 或 record_away 工具记录信息，然后简短确认。"
            // 消费后清除
            pendingInquiryContext = nil
        }

        // 今日卡片摘要
        let todayCards = manager.persistence.allActivityCardsToday()
        if !todayCards.isEmpty {
            let summary = todayCards.suffix(5).map { "\($0.startTime)-\($0.endTime) \($0.title)" }.joined(separator: "；")
            prompt += "\n\n今日活动（最近 \(todayCards.count) 张卡片）：\(summary)"
        }

        return prompt
    }

    /// 从 AgentMemory 提取近期对话历史（仅 user/assistant 文本，跳过 tool 消息）
    private func buildVoiceHistory(agent: ShadowAgent) -> [[String: Any]] {
        return agent.memory.messages
            .filter { msg in
                (msg.role == "user" || msg.role == "assistant") && msg.toolCalls == nil
            }
            .suffix(10)
            .compactMap { msg -> [String: Any]? in
                guard let content = msg.content, !content.isEmpty else { return nil }
                return ["role": msg.role, "content": content] as [String: Any]
            }
    }

    /// Float32 samples → WAV Data (PCM 16-bit, mono)
    private func samplesToWAV(_ samples: [Float], sampleRate: Int) -> Data {
        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate = UInt32(sampleRate) * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign = numChannels * (bitsPerSample / 8)
        let dataSize = UInt32(samples.count * 2) // 16-bit = 2 bytes
        let fileSize = 36 + dataSize

        var data = Data()
        data.reserveCapacity(44 + samples.count * 2)

        // RIFF header
        data.append(contentsOf: "RIFF".utf8)
        data.append(contentsOf: withUnsafeBytes(of: fileSize.littleEndian) { Array($0) })
        data.append(contentsOf: "WAVE".utf8)

        // fmt chunk
        data.append(contentsOf: "fmt ".utf8)
        data.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })
        data.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) }) // PCM
        data.append(contentsOf: withUnsafeBytes(of: numChannels.littleEndian) { Array($0) })
        data.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Array($0) })
        data.append(contentsOf: withUnsafeBytes(of: byteRate.littleEndian) { Array($0) })
        data.append(contentsOf: withUnsafeBytes(of: blockAlign.littleEndian) { Array($0) })
        data.append(contentsOf: withUnsafeBytes(of: bitsPerSample.littleEndian) { Array($0) })

        // data chunk
        data.append(contentsOf: "data".utf8)
        data.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })

        // Convert Float32 → Int16
        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            let int16 = Int16(clamped * Float(Int16.max))
            data.append(contentsOf: withUnsafeBytes(of: int16.littleEndian) { Array($0) })
        }

        return data
    }
}
