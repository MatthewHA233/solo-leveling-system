import SwiftUI

// MARK: - Data Models

/// 活动内的一个微步骤（焊点）
struct ChronosStep: Identifiable {
    let id = UUID()
    let minute: Int     // 一天中的第几分钟 (0-1439)
    let label: String   // 序号 ("1", "2", ...)
    let title: String   // 细目标题 ("完成 Toast 修复")

    init(minute: Int, label: String, title: String = "") {
        self.minute = minute
        self.label = label
        self.title = title
    }
}

/// 昼夜表上的一条活动轨迹
struct ChronosActivity: Identifiable {
    let id = UUID()
    let title: String
    let category: String
    let startMinute: Int   // 0...1439
    let endMinute: Int     // 0...1440
    let goalAlignment: String?
    let steps: [ChronosStep]

    init(title: String, category: String, startMinute: Int, endMinute: Int,
         goalAlignment: String? = nil, steps: [ChronosStep] = []) {
        self.title = title
        self.category = category
        self.startMinute = startMinute
        self.endMinute = endMinute
        self.goalAlignment = goalAlignment
        self.steps = steps
    }
}

// MARK: - Shared Types

/// 单元格坐标 — 供 UnifiedSystemView / ChronosCellDetailView 共用
struct CellKey: Hashable {
    let col: Int
    let row: Int
}

private struct TraceLayout {
    let activity: ChronosActivity
    let trackIndex: Int // 0, 1, 2 (最多三路并行)
}

// MARK: - DayNightChartView

/// 昼夜表 — 电路走线风格, 分钟级精度
struct DayNightChartView: View {
    @EnvironmentObject var agent: AgentManager
    @State private var activities: [ChronosActivity] = []
    @State private var selectedDate: Date = Date()

    @State private var hoveredActivity: ChronosActivity?
    @Binding var selectedCell: CellKey?

    // ── Grid 尺寸 ──
    private let cols = 24
    private let rows = 12
    private let cellW: CGFloat = 80
    private let cellH: CGFloat = 50     // 10px/min × 5min
    private let colGap: CGFloat = 2
    private let rowGap: CGFloat = 18    // HH:MM 标签区域
    private let hPad: CGFloat = 4       // 无左侧刻度，仅极小边距
    private let topPad: CGFloat = 28
    private let bottomPad: CGFloat = 8
    private let minuteH: CGFloat = 10   // 每分钟像素高

    // ── Trace 参数 ──
    private let traceW: CGFloat = 3.0
    private let traceBaseX: CGFloat = 10  // 第一路走线 x 偏移
    private let trackSp: CGFloat = 10     // 并行走线间距

    // ── 计算属性 ──
    private var colStride: CGFloat { cellW + colGap }
    private var rowStride: CGFloat { cellH + rowGap }
    private var gridH: CGFloat { CGFloat(rows) * rowStride - rowGap }
    private var totalW: CGFloat { hPad + CGFloat(cols) * colStride + 16 }
    private var totalH: CGFloat { topPad + gridH + bottomPad }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView([.horizontal, .vertical], showsIndicators: true) {
                canvas
                    .frame(width: totalW, height: totalH)
            }

            NeonDivider(.horizontal)
            legendBar
        }
        .background(NeonBrutalismTheme.background)
        .onAppear { loadActivities() }
        .onChange(of: selectedDate) { _, _ in loadActivities() }
        .onChange(of: agent.activityCardsUpdated) { _, _ in loadActivities() }
    }

    // MARK: - Data Loading

    private func loadActivities() {
        let cards = agent.persistence.activityCards(for: selectedDate)
        activities = ChronosActivityConverter.convertAll(cards)
    }

    // MARK: - Canvas

    private var canvas: some View {
        let layouts = computeLayouts()

        return Canvas { ctx, _ in
            drawGrid(ctx: &ctx)
            drawTimeLabels(ctx: &ctx)
            drawCellFills(ctx: &ctx, layouts: layouts)

            // Glow
            ctx.drawLayer { glow in
                glow.addFilter(.blur(radius: 5))
                glow.opacity = 0.3
                drawTraceSegments(ctx: &glow, layouts: layouts, glow: true)
            }

            drawTraceSegments(ctx: &ctx, layouts: layouts, glow: false)
            drawStepNodes(ctx: &ctx, layouts: layouts)
            drawTitles(ctx: &ctx, layouts: layouts)
            drawNowTick(ctx: &ctx)
            drawSelectedCellHighlight(ctx: &ctx)
        }
        .onContinuousHover { phase in
            switch phase {
            case .active(let loc):
                let c = Int((loc.x - hPad) / colStride)
                let rBlock = Int((loc.y - topPad) / rowStride)
                if c >= 0, c < cols, rBlock >= 0, rBlock < rows {
                    let localY = loc.y - topPad - CGFloat(rBlock) * rowStride
                    let extraMin = min(Int(localY / minuteH), 4)
                    let m = c * 60 + rBlock * 5 + extraMin
                    hoveredActivity = activities.first { m >= $0.startMinute && m < $0.endMinute }
                } else { hoveredActivity = nil }
            case .ended:
                hoveredActivity = nil
            }
        }
        .onTapGesture { location in
            let c = Int((location.x - hPad) / colStride)
            let r = Int((location.y - topPad) / rowStride)
            guard c >= 0, c < cols, r >= 0, r < rows else { return }
            let tapped = CellKey(col: c, row: r)
            if selectedCell == tapped {
                selectedCell = nil
            } else {
                selectedCell = tapped
            }
        }
    }

    // MARK: - Draw: Grid

    private func drawGrid(ctx: inout GraphicsContext) {
        for c in 0..<cols {
            let isNight = c < 6 || c >= 22
            let borderA = isNight ? 0.05 : 0.09

            for r in 0..<rows {
                let cx = hPad + CGFloat(c) * colStride
                let cy = topPad + CGFloat(r) * rowStride

                ctx.stroke(Path(CGRect(x: cx, y: cy, width: cellW, height: cellH)),
                           with: .color(NeonBrutalismTheme.electricBlue.opacity(borderA)),
                           lineWidth: 0.5)
            }
        }

        // 6 小时大分隔线
        for c in Swift.stride(from: 6, through: 18, by: 6) {
            let x = hPad + CGFloat(c) * colStride - colGap / 2
            var p = Path()
            p.move(to: .init(x: x, y: topPad))
            p.addLine(to: .init(x: x, y: topPad + gridH))
            ctx.stroke(p, with: .color(NeonBrutalismTheme.electricBlue.opacity(0.12)), lineWidth: 0.5)
        }
    }

    // MARK: - Draw: Time Labels (每列间隙 HH:MM，无左侧刻度)

    private func drawTimeLabels(ctx: inout GraphicsContext) {
        // 小时标签 (顶部，每列居中)
        for c in 0..<cols {
            let x = hPad + CGFloat(c) * colStride + cellW / 2
            let major = c % 6 == 0
            let t = Text(String(format: "%02d:00", c))
                .font(.system(size: major ? 12 : 10, weight: major ? .bold : .medium, design: .monospaced))
                .foregroundColor(major ? NeonBrutalismTheme.textPrimary : NeonBrutalismTheme.textSecondary)
            ctx.draw(ctx.resolve(t), at: .init(x: x, y: topPad - 10), anchor: .center)
        }

        // 每列每个间隙都显示 HH:MM
        for c in 0..<cols {
            let colX = hPad + CGFloat(c) * colStride + cellW / 2

            for r in 0..<(rows - 1) {
                let boundary = (r + 1) * 5
                let gapY = topPad + CGFloat(r) * rowStride + cellH + rowGap / 2
                let isMajor = boundary % 10 == 0

                let label = Text(String(format: "%02d:%02d", c, boundary))
                    .font(.system(size: isMajor ? 10 : 9,
                                  weight: isMajor ? .bold : .regular,
                                  design: .monospaced))
                    .foregroundColor(isMajor
                        ? NeonBrutalismTheme.textSecondary
                        : NeonBrutalismTheme.textSecondary.opacity(0.5))
                ctx.draw(ctx.resolve(label), at: .init(x: colX, y: gapY), anchor: .center)
            }
        }
    }

    // MARK: - Draw: Cell Fills (默认就亮)

    private func drawCellFills(ctx: inout GraphicsContext, layouts: [TraceLayout]) {
        for layout in layouts {
            let a = layout.activity
            let color = categoryColor(a.category)
            let hovered = hoveredActivity?.id == a.id
            let opacity = hovered ? 0.25 : 0.15

            var m = a.startMinute
            while m < a.endMinute {
                let col = m / 60
                let row = (m % 60) / 5
                guard col < cols, row < rows else { break }
                let cellStart = col * 60 + row * 5

                let cx = hPad + CGFloat(col) * colStride
                let cy = topPad + CGFloat(row) * rowStride

                // 部分填充 — 只填活动实际覆盖的分钟范围
                let localStart = max(a.startMinute, cellStart) - cellStart
                let localEnd = min(a.endMinute, cellStart + 5) - cellStart
                let fillY = cy + CGFloat(localStart) * minuteH
                let fillH = CGFloat(localEnd - localStart) * minuteH

                ctx.fill(Path(CGRect(x: cx, y: fillY, width: cellW, height: fillH)),
                         with: .color(color.opacity(opacity)))

                m = cellStart + 5
            }
        }
    }

    // MARK: - Draw: Trace Segments (独立竖线，不跨列)

    private func drawTraceSegments(ctx: inout GraphicsContext, layouts: [TraceLayout], glow: Bool) {
        for layout in layouts {
            let a = layout.activity
            let color = categoryColor(a.category)
            let hovered = hoveredActivity?.id == a.id
            let trackX = traceBaseX + CGFloat(layout.trackIndex) * trackSp

            var m = a.startMinute
            while m < a.endMinute {
                let col = m / 60
                let row = (m % 60) / 5
                guard col < cols, row < rows else { break }
                let cellStart = col * 60 + row * 5
                let cellEnd = cellStart + 5

                let localStart = max(a.startMinute, cellStart) - cellStart // 0-4
                let localEnd = min(a.endMinute, cellEnd) - cellStart       // 1-5

                let cx = hPad + CGFloat(col) * colStride
                let cy = topPad + CGFloat(row) * rowStride
                let x = cx + trackX
                let y0 = cy + CGFloat(localStart) * minuteH
                let y1 = cy + CGFloat(localEnd) * minuteH

                // 竖线
                var seg = Path()
                seg.move(to: .init(x: x, y: y0))
                seg.addLine(to: .init(x: x, y: y1))

                let lw = glow ? traceW + 2 : (hovered ? traceW + 0.5 : traceW)
                let op = glow ? 1.0 : (hovered ? 1.0 : 0.75)
                ctx.stroke(seg, with: .color(color.opacity(op)),
                           style: StrokeStyle(lineWidth: lw, lineCap: .round))

                if !glow {
                    // 起点端子 (方形焊盘)
                    if cellStart <= a.startMinute && a.startMinute < cellEnd {
                        ctx.fill(Path(CGRect(x: x - 3, y: y0 - 1.5, width: 6, height: 3)),
                                 with: .color(color))
                    }
                    // 终点端子 (圆点)
                    if cellStart < a.endMinute && a.endMinute <= cellEnd {
                        ctx.fill(Path(ellipseIn: CGRect(x: x - 3, y: y1 - 3, width: 6, height: 6)),
                                 with: .color(color))
                    }

                    // 间隙连接线 (同列下一格，细虚线)
                    if a.endMinute > cellEnd && row < rows - 1 {
                        let nextCy = topPad + CGFloat(row + 1) * rowStride
                        var conn = Path()
                        conn.move(to: .init(x: x, y: y1))
                        conn.addLine(to: .init(x: x, y: nextCy))
                        ctx.stroke(conn, with: .color(color.opacity(0.25)),
                                   style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [2, 3]))
                    }
                }

                m = cellEnd
            }
        }
    }

    // MARK: - Draw: Step Nodes (焊点)

    private func drawStepNodes(ctx: inout GraphicsContext, layouts: [TraceLayout]) {
        for layout in layouts {
            let color = categoryColor(layout.activity.category)
            let trackX = traceBaseX + CGFloat(layout.trackIndex) * trackSp

            for step in layout.activity.steps {
                let col = step.minute / 60
                let row = (step.minute % 60) / 5
                guard col < cols, row < rows else { continue }
                let cellStart = col * 60 + row * 5
                let localMin = step.minute - cellStart

                let cx = hPad + CGFloat(col) * colStride
                let cy = topPad + CGFloat(row) * rowStride
                let x = cx + trackX
                let y = cy + CGFloat(localMin) * minuteH

                // 背景挖空
                ctx.fill(Path(ellipseIn: CGRect(x: x - 5, y: y - 5, width: 10, height: 10)),
                         with: .color(NeonBrutalismTheme.background))
                // 外环
                ctx.stroke(Path(ellipseIn: CGRect(x: x - 4.5, y: y - 4.5, width: 9, height: 9)),
                           with: .color(color), lineWidth: 1.5)
                // 内点
                ctx.fill(Path(ellipseIn: CGRect(x: x - 2, y: y - 2, width: 4, height: 4)),
                         with: .color(color))
                // 序号 + 细目标题 (右侧)
                let labelText = step.title.isEmpty
                    ? step.label
                    : "\(step.label) \(step.title)"
                let label = Text(labelText)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(color)
                ctx.draw(ctx.resolve(label), at: .init(x: x + 9, y: y), anchor: .leading)
            }
        }
    }

    // MARK: - Draw: Titles (合并单元格居中 — 跨列跨行)

    private func drawTitles(ctx: inout GraphicsContext, layouts: [TraceLayout]) {
        for layout in layouts {
            let a = layout.activity
            let color = categoryColor(a.category)

            let startCol = a.startMinute / 60
            let endCol = min((a.endMinute - 1) / 60, cols - 1)
            let firstRow = (a.startMinute % 60) / 5
            let lastRow = ((a.endMinute - 1) % 60) / 5

            // 活动视觉区域的包围盒
            let x1 = hPad + CGFloat(startCol) * colStride
            let x2 = hPad + CGFloat(endCol) * colStride + cellW
            let y1 = topPad + CGFloat(firstRow) * rowStride
            let y2: CGFloat
            if startCol == endCol {
                y2 = topPad + CGFloat(lastRow) * rowStride + cellH
            } else {
                y2 = topPad + CGFloat(rows - 1) * rowStride + cellH
            }

            let cx = (x1 + x2) / 2
            let cy = (y1 + y2) / 2

            // 标题 — 居中于整个活动区域
            let title = Text(a.title)
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundColor(color)
            ctx.draw(ctx.resolve(title), at: .init(x: cx, y: cy - 8), anchor: .center)

            // 时间范围 — 标题下方
            let time = Text("\(Self.fmt(a.startMinute)) \u{2013} \(Self.fmt(a.endMinute))")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(color.opacity(0.5))
            ctx.draw(ctx.resolve(time), at: .init(x: cx, y: cy + 8), anchor: .center)
        }
    }

    // MARK: - Draw: Current Time (短横线刻度)

    private func drawNowTick(ctx: inout GraphicsContext) {
        let cal = Calendar.current
        let h = cal.component(.hour, from: Date())
        let m = cal.component(.minute, from: Date())
        guard h < cols else { return }

        let row = m / 5
        let localMin = m % 5
        guard row < rows else { return }

        let cx = hPad + CGFloat(h) * colStride
        let cy = topPad + CGFloat(row) * rowStride
        let y = cy + CGFloat(localMin) * minuteH

        // 横线刻度
        var tick = Path()
        tick.move(to: .init(x: cx, y: y))
        tick.addLine(to: .init(x: cx + cellW, y: y))
        ctx.stroke(tick, with: .color(NeonBrutalismTheme.electricBlue.opacity(0.6)), lineWidth: 1)

        // 左侧小圆点
        ctx.fill(Path(ellipseIn: CGRect(x: cx - 2, y: y - 2, width: 4, height: 4)),
                 with: .color(NeonBrutalismTheme.electricBlue))
    }

    // MARK: - Draw: Selected Cell Highlight

    private func drawSelectedCellHighlight(ctx: inout GraphicsContext) {
        guard let sel = selectedCell else { return }
        guard sel.col >= 0, sel.col < cols, sel.row >= 0, sel.row < rows else { return }

        let cx = hPad + CGFloat(sel.col) * colStride
        let cy = topPad + CGFloat(sel.row) * rowStride
        let rect = CGRect(x: cx, y: cy, width: cellW, height: cellH)

        ctx.stroke(Path(rect),
                   with: .color(NeonBrutalismTheme.electricBlue.opacity(0.9)),
                   lineWidth: 2)
        ctx.fill(Path(rect),
                 with: .color(NeonBrutalismTheme.electricBlue.opacity(0.08)))
    }

    // MARK: - Layout: Track Assignment

    private func computeLayouts() -> [TraceLayout] {
        let sorted = activities.sorted { $0.startMinute < $1.startMinute }
        var result: [TraceLayout] = []
        var ends: [Int] = []

        for a in sorted {
            var t = -1
            for i in ends.indices where a.startMinute >= ends[i] {
                t = i; ends[i] = a.endMinute; break
            }
            if t == -1 { t = ends.count; ends.append(a.endMinute) }
            result.append(TraceLayout(activity: a, trackIndex: min(t, 2))) // 最多 3 路
        }
        return result
    }

    // MARK: - Category Styling

    private func categoryColor(_ cat: String) -> Color {
        switch cat {
        case "coding":        return NeonBrutalismTheme.electricBlue
        case "writing":       return NeonBrutalismTheme.shadowPurple
        case "learning":      return NeonBrutalismTheme.expGreen
        case "browsing":      return .orange
        case "design":        return .mint
        case "research":      return .yellow
        case "communication": return .teal
        case "reading":       return Color(red: 0.6, green: 0.4, blue: 0.2)
        case "meeting":       return .gray
        case "media":         return .pink
        case "social":        return .cyan
        case "idle":          return NeonBrutalismTheme.textSecondary
        default:              return NeonBrutalismTheme.textSecondary
        }
    }

    private func categoryLabel(_ cat: String) -> String {
        switch cat {
        case "coding": return "编程"; case "writing": return "写作"
        case "learning": return "学习"; case "browsing": return "浏览"
        case "design": return "设计"; case "research": return "调研"
        case "communication": return "沟通"; case "reading": return "阅读"
        case "meeting": return "会议"; case "media": return "媒体"
        case "social": return "社交"; case "idle": return "空闲"
        default: return cat
        }
    }

    // MARK: - Legend

    private var usedCategories: [String] {
        Array(Set(activities.map(\.category))).sorted()
    }

    private var totalMinutes: Int {
        activities.reduce(0) { $0 + ($1.endMinute - $1.startMinute) }
    }

    var legendBar: some View {
        HStack(spacing: 12) {
            ForEach(usedCategories, id: \.self) { cat in
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(categoryColor(cat))
                        .frame(width: 14, height: 3)
                        .shadow(color: categoryColor(cat).opacity(0.6), radius: 3)
                    Text(categoryLabel(cat))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                }
            }
            Spacer()
            Text("\(activities.count) traces \u{00B7} \(totalMinutes)m")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textSecondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: - Helpers

    static func fmt(_ m: Int) -> String {
        String(format: "%02d:%02d", m / 60, m % 60)
    }

    static func dateString(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy.MM.dd EEEE"
        f.locale = Locale(identifier: "zh_CN")
        return f.string(from: date)
    }

}

// MARK: - Preview

#Preview("昼夜表 — 电路走线") {
    DayNightChartView(selectedCell: .constant(nil))
        .environmentObject(AgentManager.shared)
        .frame(width: 1200, height: 850)
}
