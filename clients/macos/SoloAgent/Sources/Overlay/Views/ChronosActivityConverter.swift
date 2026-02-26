import Foundation

/// 将 SwiftData 的 ActivityCardRecord 转换为 DayNightChart 的 ChronosActivity 模型
enum ChronosActivityConverter {

    // MARK: - Public API

    /// 批量转换
    static func convertAll(_ cards: [ActivityCardRecord]) -> [ChronosActivity] {
        cards.compactMap { convert($0) }
    }

    /// 单张卡片 → ChronosActivity
    static func convert(_ card: ActivityCardRecord) -> ChronosActivity? {
        let cal = Calendar.current

        let startDate = Date(timeIntervalSince1970: Double(card.startTs))
        let endDate   = Date(timeIntervalSince1970: Double(card.endTs))

        let startComps = cal.dateComponents([.hour, .minute], from: startDate)
        let endComps   = cal.dateComponents([.hour, .minute], from: endDate)

        guard let sh = startComps.hour, let sm = startComps.minute,
              let eh = endComps.hour, let em = endComps.minute else {
            return nil
        }

        let startMinute = sh * 60 + sm
        var endMinute   = eh * 60 + em

        // 跨日处理: cap at 1440
        if endMinute <= startMinute {
            endMinute = 1440
        }

        // 至少 1 分钟
        if endMinute <= startMinute {
            return nil
        }

        let steps = parseSteps(
            from: card.detailedSummary,
            startMinute: startMinute,
            endMinute: endMinute
        )

        return ChronosActivity(
            title: card.title,
            category: card.category,
            startMinute: startMinute,
            endMinute: endMinute,
            goalAlignment: card.goalAlignment,
            steps: steps
        )
    }

    // MARK: - Step Parsing

    /// 从 detailedSummary 解析时间线节点
    /// AI 格式: `[时:分] 具体操作 [应用] [对象]`
    static func parseSteps(
        from detailedSummary: String,
        startMinute: Int,
        endMinute: Int
    ) -> [ChronosStep] {
        guard !detailedSummary.isEmpty else { return [] }

        // 正则: [HH:MM] 内容
        let pattern = #"\[(\d{1,2}):(\d{2})\]\s*(.+?)(?=\[\d{1,2}:\d{2}\]|$)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else {
            return []
        }

        let nsString = detailedSummary as NSString
        let matches = regex.matches(
            in: detailedSummary,
            range: NSRange(location: 0, length: nsString.length)
        )

        var rawSteps: [(minute: Int, title: String)] = []

        for match in matches {
            guard match.numberOfRanges >= 4 else { continue }

            let hourStr  = nsString.substring(with: match.range(at: 1))
            let minStr   = nsString.substring(with: match.range(at: 2))
            let titleStr = nsString.substring(with: match.range(at: 3))
                .trimmingCharacters(in: .whitespacesAndNewlines)

            guard let h = Int(hourStr), let m = Int(minStr) else { continue }
            let minute = h * 60 + m

            // 只保留活动范围内的 step
            guard minute >= startMinute && minute < endMinute else { continue }
            guard !titleStr.isEmpty else { continue }

            rawSteps.append((minute: minute, title: titleStr))
        }

        // 最多保留 6 个 step（超出时均匀采样）
        let sampled = sampleSteps(rawSteps, maxCount: 6)

        return sampled.enumerated().map { idx, step in
            ChronosStep(
                minute: step.minute,
                label: "\(idx + 1)",
                title: step.title
            )
        }
    }

    // MARK: - Sampling

    /// 均匀采样，保留首尾
    private static func sampleSteps(
        _ steps: [(minute: Int, title: String)],
        maxCount: Int
    ) -> [(minute: Int, title: String)] {
        guard steps.count > maxCount else { return steps }

        var result: [(minute: Int, title: String)] = []
        let step = Double(steps.count - 1) / Double(maxCount - 1)

        for i in 0..<maxCount {
            let idx = min(Int(Double(i) * step + 0.5), steps.count - 1)
            result.append(steps[idx])
        }

        return result
    }
}
