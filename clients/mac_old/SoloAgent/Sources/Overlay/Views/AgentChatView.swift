import SwiftUI

/// 对话气泡区 — 渲染 ShadowAgent 消息流
struct AgentChatView: View {
    let messages: [AgentMessage]
    let isProcessing: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(messages) { msg in
                        AgentMessageRow(message: msg)
                            .id(msg.id)
                    }
                    if isProcessing {
                        TypingIndicator()
                    }
                }
                .padding(8)
            }
            .onChange(of: messages.count) {
                if let last = messages.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }
}

// MARK: - Message Row

private struct AgentMessageRow: View {
    let message: AgentMessage

    var body: some View {
        switch message.role {
        case .user:
            if message.voiceFile != nil {
                VoiceBubble(message: message)
            } else {
                userBubble
            }
        case .agent:
            agentBubble
        case .system:
            systemBubble
        }
    }

    // MARK: User Bubble — 右对齐, electricBlue 背景

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 40)
            Text(message.content)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(NeonBrutalismTheme.electricBlue.opacity(0.85))
                )
        }
    }

    // MARK: Agent Bubble — 左对齐, 深色背景 + 左侧彩色竖条

    private var agentBubble: some View {
        HStack(alignment: .top, spacing: 6) {
            // 左侧彩色竖条
            RoundedRectangle(cornerRadius: 1)
                .fill(NeonBrutalismTheme.electricBlue)
                .frame(width: 3)
                .padding(.vertical, 2)

            VStack(alignment: .leading, spacing: 3) {
                if let icon = message.icon {
                    HStack(spacing: 4) {
                        Image(systemName: icon)
                            .font(.system(size: 9))
                            .foregroundColor(NeonBrutalismTheme.electricBlue)
                        Text("暗影智能体")
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundColor(NeonBrutalismTheme.electricBlue.opacity(0.7))
                    }
                }

                MarkdownText(message.content)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.white.opacity(0.04))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(NeonBrutalismTheme.electricBlue.opacity(0.12), lineWidth: 0.5)
                    )
            )

            Spacer(minLength: 20)
        }
    }

    // MARK: System Bubble — 居中, 小字

    private var systemBubble: some View {
        HStack {
            Spacer()
            HStack(spacing: 4) {
                if let icon = message.icon {
                    Image(systemName: icon)
                        .font(.system(size: 8))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                }
                Text(message.content)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Typing Indicator (三个脉冲圆点)

private struct TypingIndicator: View {
    @State private var phase: Int = 0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { idx in
                Circle()
                    .fill(NeonBrutalismTheme.electricBlue)
                    .frame(width: 5, height: 5)
                    .opacity(phase == idx ? 1.0 : 0.3)
                    .scaleEffect(phase == idx ? 1.3 : 1.0)
            }
        }
        .padding(.leading, 12)
        .padding(.vertical, 4)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.4).repeatForever(autoreverses: false)) {
                // 使用 Timer 驱动循环
            }
            startAnimation()
        }
    }

    private func startAnimation() {
        Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { _ in
            withAnimation(.easeInOut(duration: 0.25)) {
                phase = (phase + 1) % 3
            }
        }
    }
}

// MARK: - Voice Bubble (可点击播放的语音气泡)

private struct VoiceBubble: View {
    let message: AgentMessage
    @StateObject private var player = VoiceBubblePlayer()

    private var duration: Double {
        message.voiceDuration ?? 0
    }

    private var barCount: Int {
        max(8, min(28, Int(duration * 6)))
    }

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            Button(action: { togglePlay() }) {
                HStack(spacing: 6) {
                    // 播放/停止图标
                    Image(systemName: player.isPlaying ? "stop.fill" : "play.fill")
                        .font(.system(size: 10))
                        .foregroundColor(.white)
                        .frame(width: 14)

                    // 波形条
                    HStack(spacing: 1.5) {
                        ForEach(0..<barCount, id: \.self) { i in
                            WaveformBar(
                                index: i,
                                total: barCount,
                                isPlaying: player.isPlaying,
                                progress: player.progress
                            )
                        }
                    }
                    .frame(height: 16)

                    // 时长
                    Text(formatDuration(duration))
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundColor(.white.opacity(0.7))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(NeonBrutalismTheme.electricBlue.opacity(0.85))
                )
            }
            .buttonStyle(.plain)
            .pointingHand()
        }
    }

    private func togglePlay() {
        if player.isPlaying {
            player.stop()
        } else if let file = message.voiceFile {
            player.play(file: file)
        }
    }

    private func formatDuration(_ seconds: Double) -> String {
        let s = Int(seconds)
        return s < 60 ? "\(s)\u{2033}" : "\(s / 60):\(String(format: "%02d", s % 60))"
    }
}

// MARK: - Waveform Bar

private struct WaveformBar: View {
    let index: Int
    let total: Int
    let isPlaying: Bool
    let progress: Double

    /// 伪波形高度（基于位置的固定 pattern）
    private var heightRatio: CGFloat {
        let x = Double(index) / Double(max(total - 1, 1))
        // 中间高两端低的弧形 + 伪随机扰动
        let base = sin(x * .pi)
        let noise = sin(Double(index) * 2.7 + 1.3) * 0.3
        return CGFloat(max(0.2, min(1.0, base * 0.7 + 0.3 + noise)))
    }

    private var isPast: Bool {
        guard total > 0 else { return false }
        return Double(index) / Double(total) < progress
    }

    var body: some View {
        RoundedRectangle(cornerRadius: 0.5)
            .fill(isPlaying && isPast ? Color.white : Color.white.opacity(0.45))
            .frame(width: 2, height: 16 * heightRatio)
    }
}

// MARK: - Voice Bubble Player

@MainActor
private class VoiceBubblePlayer: ObservableObject {
    @Published var isPlaying = false
    @Published var progress: Double = 0

    private var audioPlayer: AVAudioPlayer?
    private var timer: Timer?

    func play(file: String) {
        stop()
        let url = VoiceFileStore.url(for: file)
        guard FileManager.default.fileExists(atPath: url.path) else { return }

        do {
            let player = try AVAudioPlayer(contentsOf: url)
            player.prepareToPlay()
            player.play()
            audioPlayer = player
            isPlaying = true
            progress = 0

            timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, let p = self.audioPlayer else { return }
                    if p.isPlaying {
                        self.progress = p.duration > 0 ? p.currentTime / p.duration : 0
                    } else {
                        self.stop()
                    }
                }
            }
        } catch {
            AIClient.debugLog("[VoicePlayer] 播放失败: \(error.localizedDescription)")
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        audioPlayer?.stop()
        audioPlayer = nil
        isPlaying = false
        progress = 0
    }
}

import AVFoundation

// MARK: - Markdown Text Renderer

private struct MarkdownText: View {
    let raw: String

    init(_ text: String) {
        self.raw = text
    }

    var body: some View {
        if let attributed = try? AttributedString(
            markdown: raw,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textPrimary)
        } else {
            // Fallback: 按行解析代码块等
            markdownFallback
        }
    }

    /// 手动解析代码块的 fallback
    private var markdownFallback: some View {
        let lines = raw.components(separatedBy: "\n")
        var views: [(id: Int, isCode: Bool, text: String)] = []
        var inCodeBlock = false
        var codeBuffer: [String] = []
        var idx = 0

        for line in lines {
            if line.hasPrefix("```") {
                if inCodeBlock {
                    // 结束代码块
                    views.append((id: idx, isCode: true, text: codeBuffer.joined(separator: "\n")))
                    idx += 1
                    codeBuffer = []
                }
                inCodeBlock.toggle()
            } else if inCodeBlock {
                codeBuffer.append(line)
            } else {
                views.append((id: idx, isCode: false, text: line))
                idx += 1
            }
        }
        // 未关闭的代码块
        if !codeBuffer.isEmpty {
            views.append((id: idx, isCode: true, text: codeBuffer.joined(separator: "\n")))
        }

        return VStack(alignment: .leading, spacing: 2) {
            ForEach(views, id: \.id) { item in
                if item.isCode {
                    Text(item.text)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.expGreen)
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.black.opacity(0.3))
                        .cornerRadius(4)
                } else {
                    Text(item.text)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textPrimary)
                }
            }
        }
    }
}
