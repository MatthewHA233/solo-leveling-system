import SwiftUI
import AVKit
import Combine

/// 视频字幕条目 — 映射到视频时间轴
private struct VideoSubtitle {
    let videoStartSec: Double
    let videoEndSec: Double
    let text: String
}

/// 展开的视频播放器 — 替换昼夜表显示在中心区域，支持字幕叠加和片段循环
struct ExpandedVideoPlayerView: View {
    let player: AVPlayer
    let batchId: String
    let selectedDate: Date
    let loopStartTime: String?   // "HH:mm" — nil = 不循环
    let loopEndTime: String?     // "HH:mm"
    var onCollapse: () -> Void
    var onStopLoop: () -> Void

    @EnvironmentObject var agent: AgentManager
    @State private var currentSubtitle: String = ""
    @State private var currentMappedTime: String = ""
    @State private var subtitles: [VideoSubtitle] = []
    @State private var isPlayerEnded: Bool = false
    @State private var cachedBatch: BatchRecord? = nil
    /// 从 transcriptionJson 解析的分段时间控制点：(视频秒, 真实Unix时间戳)
    @State private var timeMapping: [(videoSec: Double, realTs: Double)] = []

    private static let timeFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private var isLooping: Bool { loopStartTime != nil && loopEndTime != nil }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                HStack(spacing: 4) {
                    Image(systemName: "film")
                        .font(.system(size: 11))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                    Text("延时影像")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                }

                Spacer()

                if isLooping {
                    Button(action: onStopLoop) {
                        HStack(spacing: 4) {
                            Image(systemName: "repeat.1")
                                .font(.system(size: 10))
                            Text("停止循环")
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                        }
                        .foregroundColor(.orange)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 4)
                                .fill(Color.orange.opacity(0.1))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 4)
                                        .strokeBorder(Color.orange.opacity(0.3), lineWidth: 0.5)
                                )
                        )
                    }
                    .buttonStyle(.plain)
                }

                Button(action: onCollapse) {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.down.right.and.arrow.up.left")
                            .font(.system(size: 10))
                        Text("收起")
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                    }
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(NeonBrutalismTheme.electricBlue.opacity(0.06))
                            .overlay(
                                RoundedRectangle(cornerRadius: 4)
                                    .strokeBorder(NeonBrutalismTheme.electricBlue.opacity(0.15), lineWidth: 0.5)
                            )
                    )
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    if hovering { NSCursor.pointingHand.push() }
                    else { NSCursor.pop() }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            NeonDivider(.horizontal)

            // Video player with subtitle overlay
            ZStack(alignment: .bottom) {
                InlineVideoPlayer(player: player, controlsStyle: .inline)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.black)

                // 右上角：映射真实时间
                if !currentMappedTime.isEmpty {
                    VStack {
                        HStack {
                            Spacer()
                            Text(currentMappedTime)
                                .font(.system(size: 12, weight: .bold, design: .monospaced))
                                .foregroundColor(.white)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(
                                    RoundedRectangle(cornerRadius: 4)
                                        .fill(Color.black.opacity(0.65))
                                )
                                .padding(.top, 8)
                                .padding(.trailing, 8)
                        }
                        Spacer()
                    }
                    .allowsHitTesting(false)
                }

                // 字幕叠加
                if !currentSubtitle.isEmpty {
                    Text(currentSubtitle)
                        .font(.system(size: 14, weight: .semibold, design: .monospaced))
                        .foregroundColor(.white)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(
                            RoundedRectangle(cornerRadius: 4)
                                .fill(Color.black.opacity(0.75))
                        )
                        .padding(.bottom, 48)
                        .allowsHitTesting(false)
                }
            }

            NeonDivider(.horizontal)

            // Bottom info bar
            HStack {
                Text("批次")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                Text(batchId)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textPrimary)
                    .lineLimit(1)
                Spacer()
                if isLooping {
                    HStack(spacing: 4) {
                        Image(systemName: "repeat.1")
                            .font(.system(size: 9))
                            .foregroundColor(.orange)
                        Text("循环 \(loopStartTime ?? "") \u{2192} \(loopEndTime ?? "")")
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundColor(.orange)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
        }
        .background(NeonBrutalismTheme.background)
        .onAppear {
            cachedBatch = agent.persistence.batchRecord(for: batchId)
            buildTimeMapping()
            computeSubtitles()
        }
        .onReceive(Timer.publish(every: 0.3, on: .main, in: .common).autoconnect()) { _ in
            updatePlayback()
        }
        // 视频播放结束时自动回到开头（顺序模式）或循环段起点（循环模式）
        .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime)) { notification in
            guard let item = notification.object as? AVPlayerItem,
                  item === player.currentItem else { return }
            if let range = currentLoopRange() {
                player.seek(to: CMTime(seconds: range.start, preferredTimescale: 600),
                            toleranceBefore: .zero, toleranceAfter: .zero)
            } else {
                player.seek(to: .zero)
            }
            player.play()
        }
    }

    // MARK: - Playback Update (0.3s 周期)

    private func updatePlayback() {
        let seconds = player.currentTime().seconds
        guard seconds.isFinite else { return }

        // 懒加载字幕（视频 duration 可能首次不可用）
        if subtitles.isEmpty { computeSubtitles() }

        // 获取视频总时长
        let videoDuration = player.currentItem?.duration.seconds ?? 0

        // 更新右上角映射时间（分段线性插值，基于 transcriptionJson 的实际帧时间戳）
        if videoDuration > 0 {
            if let mapped = interpolateMappedTime(videoSec: seconds) {
                if currentMappedTime != mapped { currentMappedTime = mapped }
            } else if let batch = cachedBatch {
                // fallback：线性插值（transcriptionJson 未就绪时）
                let batchDuration = Double(batch.endTs - batch.startTs)
                if batchDuration > 0 {
                    let ratio = max(0, min(1, seconds / videoDuration))
                    let realTs = Double(batch.startTs) + ratio * batchDuration
                    let mapped = Self.timeFmt.string(from: Date(timeIntervalSince1970: realTs))
                    if currentMappedTime != mapped { currentMappedTime = mapped }
                }
            }
        }

        // 更新字幕 — 视频暂停在末尾时清除字幕
        let isAtEnd = videoDuration > 0 && seconds >= videoDuration - 0.1
        let isPlaying = player.rate > 0

        if !isAtEnd && isPlaying,
           let entry = subtitles.first(where: { seconds >= $0.videoStartSec && seconds < $0.videoEndSec }) {
            if currentSubtitle != entry.text { currentSubtitle = entry.text }
        } else if isAtEnd || !isPlaying {
            if !currentSubtitle.isEmpty { currentSubtitle = "" }
        }

        // 循环播放：到达循环段终点时跳回起点
        if let range = currentLoopRange() {
            if seconds >= range.end - 0.15 || seconds < range.start - 0.5 {
                player.seek(to: CMTime(seconds: range.start, preferredTimescale: 600),
                            toleranceBefore: .zero, toleranceAfter: .zero)
                player.play()
            }
        }
    }

    // MARK: - Time Mapping (分段线性插值)

    /// 从 BatchRecord.frameTimestampsJson 解析帧时间戳数组（与发给 AI 的映射表完全一致）
    private func buildTimeMapping() {
        guard let jsonStr = cachedBatch?.frameTimestampsJson,
              let data = jsonStr.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [Int] else {
            return
        }
        // timeMapping[i].realTs = 视频第 i 秒对应的 Unix 时间戳（与 AI 看到的映射表完全一致）
        timeMapping = arr.enumerated().map { (videoSec: Double($0.offset), realTs: Double($0.element)) }
    }

    /// 给定视频播放秒数，直接查表返回真实时间；无数据时返回 nil
    private func interpolateMappedTime(videoSec: Double) -> String? {
        guard !timeMapping.isEmpty else { return nil }
        let idx = max(0, min(timeMapping.count - 1, Int(videoSec)))
        return Self.timeFmt.string(from: Date(timeIntervalSince1970: timeMapping[idx].realTs))
    }

    // MARK: - Subtitle Computation

    private func computeSubtitles() {
        guard let batch = agent.persistence.batchRecord(for: batchId),
              let duration = player.currentItem?.duration,
              duration.isNumeric, duration.seconds > 0 else { return }

        let batchStart = Double(batch.startTs)
        let batchEnd = Double(batch.endTs)
        let batchDuration = batchEnd - batchStart
        guard batchDuration > 0 else { return }

        let videoDuration = duration.seconds
        let cal = Calendar.current
        let cards = agent.persistence.activityCards(for: selectedDate).filter { $0.batchId == batchId }

        var allEntries: [(realTs: Double, text: String)] = []
        for card in cards {
            let parsed = Self.parseTimeline(card.detailedSummary)
            for (time, content) in parsed {
                let parts = time.split(separator: ":")
                guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { continue }
                var comps = cal.dateComponents([.year, .month, .day], from: selectedDate)
                comps.hour = h; comps.minute = m; comps.second = 0
                guard let date = cal.date(from: comps) else { continue }
                allEntries.append((realTs: date.timeIntervalSince1970, text: "\(time) \(content)"))
            }
        }

        allEntries.sort { $0.realTs < $1.realTs }
        var subs: [VideoSubtitle] = []
        for i in allEntries.indices {
            let startTs = allEntries[i].realTs
            let endTs = i + 1 < allEntries.count ? allEntries[i + 1].realTs : batchEnd
            let startR = max(0, min(1, (startTs - batchStart) / batchDuration))
            let endR = max(0, min(1, (endTs - batchStart) / batchDuration))
            subs.append(VideoSubtitle(
                videoStartSec: startR * videoDuration,
                videoEndSec: endR * videoDuration,
                text: allEntries[i].text
            ))
        }
        subtitles = subs
    }

    // MARK: - Loop Range

    private func currentLoopRange() -> (start: Double, end: Double)? {
        guard let startStr = loopStartTime, let endStr = loopEndTime,
              let batch = agent.persistence.batchRecord(for: batchId),
              let duration = player.currentItem?.duration,
              duration.isNumeric, duration.seconds > 0 else { return nil }

        let batchStart = Double(batch.startTs)
        let batchEnd = Double(batch.endTs)
        let batchDuration = batchEnd - batchStart
        guard batchDuration > 0 else { return nil }

        let cal = Calendar.current
        func parseTime(_ s: String) -> Double? {
            let parts = s.split(separator: ":")
            guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
            var comps = cal.dateComponents([.year, .month, .day], from: selectedDate)
            comps.hour = h; comps.minute = m; comps.second = 0
            return cal.date(from: comps)?.timeIntervalSince1970
        }

        guard let startTs = parseTime(startStr), let endTs = parseTime(endStr) else { return nil }
        let videoDuration = duration.seconds
        let startR = max(0, min(1, (startTs - batchStart) / batchDuration))
        let endR = max(0, min(1, (endTs - batchStart) / batchDuration))
        return (start: startR * videoDuration, end: endR * videoDuration)
    }

    // MARK: - Timeline Parsing

    static func parseTimeline(_ text: String) -> [(time: String, content: String)] {
        guard !text.isEmpty else { return [] }
        let pattern = #"\[(\d{1,2}):(\d{2})\]\s*(.+?)(?=\[\d{1,2}:\d{2}\]|$)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else { return [] }
        let ns = text as NSString
        let matches = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
        var results: [(String, String)] = []
        for m in matches {
            guard m.numberOfRanges >= 4 else { continue }
            let h = ns.substring(with: m.range(at: 1))
            let min = ns.substring(with: m.range(at: 2))
            let content = ns.substring(with: m.range(at: 3)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let hh = Int(h), let mm = Int(min), !content.isEmpty else { continue }
            results.append((String(format: "%02d:%02d", hh, mm), content))
        }
        return results
    }
}
