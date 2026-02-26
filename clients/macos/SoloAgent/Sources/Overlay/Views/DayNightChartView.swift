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
    @State private var hoveredGridCell: CellKey?
    @Binding var selectedCell: CellKey?
    @Binding var isExpanded: Bool

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

    // ── 可见列范围 ──
    private var visibleStart: Int {
        if isExpanded { return 0 }
        let h = Calendar.current.component(.hour, from: Date())
        return max(0, h - 2)
    }
    private var visibleEnd: Int {
        if isExpanded { return cols }
        let h = Calendar.current.component(.hour, from: Date())
        return min(cols, h + 7)   // 右6列 = h+7 (exclusive)
    }
    private var visibleCount: Int { visibleEnd - visibleStart }

    // ── 计算属性 ──
    private var colStride: CGFloat { cellW + colGap }
    private var rowStride: CGFloat { cellH + rowGap }
    private var gridH: CGFloat { CGFloat(rows) * rowStride - rowGap }
    private var totalW: CGFloat { hPad + CGFloat(visibleCount) * colStride + 16 }
    private var totalH: CGFloat { topPad + gridH + bottomPad }

    /// 将实际列号转换为画布 x 坐标
    private func colX(_ col: Int) -> CGFloat {
        hPad + CGFloat(col - visibleStart) * colStride
    }

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
                let c = Int((loc.x - hPad) / colStride) + visibleStart
                let rBlock = Int((loc.y - topPad) / rowStride)
                if c >= visibleStart, c < visibleEnd, rBlock >= 0, rBlock < rows {
                    hoveredGridCell = CellKey(col: c, row: rBlock)
                    let localY = loc.y - topPad - CGFloat(rBlock) * rowStride
                    let extraMin = min(Int(localY / minuteH), 4)
                    let m = c * 60 + rBlock * 5 + extraMin
                    hoveredActivity = activities.first { m >= $0.startMinute && m < $0.endMinute }
                } else {
                    hoveredGridCell = nil
                    hoveredActivity = nil
                }
            case .ended:
                hoveredGridCell = nil
                hoveredActivity = nil
            }
        }
        .onTapGesture { location in
            let c = Int((location.x - hPad) / colStride) + visibleStart
            let r = Int((location.y - topPad) / rowStride)
            guard c >= visibleStart, c < visibleEnd, r >= 0, r < rows else { return }
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
        for c in visibleStart..<visibleEnd {
            let isNight = c < 6 || c >= 22
            let borderA = isNight ? 0.05 : 0.09

            for r in 0..<rows {
                let cx = colX(c)
                let cy = topPad + CGFloat(r) * rowStride

                ctx.stroke(Path(CGRect(x: cx, y: cy, width: cellW, height: cellH)),
                           with: .color(NeonBrutalismTheme.electricBlue.opacity(borderA)),
                           lineWidth: 0.5)
            }
        }

        // 6 小时大分隔线
        for c in Swift.stride(from: 6, through: 18, by: 6) {
            guard c >= visibleStart && c < visibleEnd else { continue }
            let x = colX(c) - colGap / 2
            var p = Path()
            p.move(to: .init(x: x, y: topPad))
            p.addLine(to: .init(x: x, y: topPad + gridH))
            ctx.stroke(p, with: .color(NeonBrutalismTheme.electricBlue.opacity(0.12)), lineWidth: 0.5)
        }
    }

    // MARK: - Draw: Time Labels (每列间隙 HH:MM，无左侧刻度)

    private func drawTimeLabels(ctx: inout GraphicsContext) {
        // 小时标签 (顶部，每列居中)
        for c in visibleStart..<visibleEnd {
            let x = colX(c) + cellW / 2
            let major = c % 6 == 0
            let t = Text(String(format: "%02d:00", c))
                .font(.system(size: major ? 12 : 10, weight: major ? .bold : .medium, design: .monospaced))
                .foregroundColor(major ? NeonBrutalismTheme.textPrimary : NeonBrutalismTheme.textSecondary)
            ctx.draw(ctx.resolve(t), at: .init(x: x, y: topPad - 10), anchor: .center)
        }

        // 每列每个间隙都显示 HH:MM
        for c in visibleStart..<visibleEnd {
            let cx = colX(c) + cellW / 2

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
                ctx.draw(ctx.resolve(label), at: .init(x: cx, y: gapY), anchor: .center)
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

                // 跳过不可见列
                if col >= visibleStart && col < visibleEnd {
                    let cx = colX(col)
                    let cy = topPad + CGFloat(row) * rowStride

                    let localStart = max(a.startMinute, cellStart) - cellStart
                    let localEnd = min(a.endMinute, cellStart + 5) - cellStart
                    let fillY = cy + CGFloat(localStart) * minuteH
                    let fillH = CGFloat(localEnd - localStart) * minuteH

                    ctx.fill(Path(CGRect(x: cx, y: fillY, width: cellW, height: fillH)),
                             with: .color(color.opacity(opacity)))
                }

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

                if col >= visibleStart && col < visibleEnd {
                    let localStart = max(a.startMinute, cellStart) - cellStart
                    let localEnd = min(a.endMinute, cellEnd) - cellStart

                    let cx = colX(col)
                    let cy = topPad + CGFloat(row) * rowStride
                    let x = cx + trackX
                    let y0 = cy + CGFloat(localStart) * minuteH
                    let y1 = cy + CGFloat(localEnd) * minuteH

                    var seg = Path()
                    seg.move(to: .init(x: x, y: y0))
                    seg.addLine(to: .init(x: x, y: y1))

                    let lw = glow ? traceW + 2 : (hovered ? traceW + 0.5 : traceW)
                    let op = glow ? 1.0 : (hovered ? 1.0 : 0.75)
                    ctx.stroke(seg, with: .color(color.opacity(op)),
                               style: StrokeStyle(lineWidth: lw, lineCap: .round))

                    if !glow {
                        if cellStart <= a.startMinute && a.startMinute < cellEnd {
                            ctx.fill(Path(CGRect(x: x - 3, y: y0 - 1.5, width: 6, height: 3)),
                                     with: .color(color))
                        }
                        if cellStart < a.endMinute && a.endMinute <= cellEnd {
                            ctx.fill(Path(ellipseIn: CGRect(x: x - 3, y: y1 - 3, width: 6, height: 6)),
                                     with: .color(color))
                        }
                        if a.endMinute > cellEnd && row < rows - 1 {
                            let nextCy = topPad + CGFloat(row + 1) * rowStride
                            var conn = Path()
                            conn.move(to: .init(x: x, y: y1))
                            conn.addLine(to: .init(x: x, y: nextCy))
                            ctx.stroke(conn, with: .color(color.opacity(0.25)),
                                       style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [2, 3]))
                        }
                    }
                }

                m = cellEnd
            }
        }
    }

    // MARK: - Draw: Step Nodes (焊点 — 悬浮单元格时灯光亮起 + 描述闪出)

    private func drawStepNodes(ctx: inout GraphicsContext, layouts: [TraceLayout]) {
        for layout in layouts {
            let color = categoryColor(layout.activity.category)
            let trackX = traceBaseX + CGFloat(layout.trackIndex) * trackSp

            for step in layout.activity.steps {
                let col = step.minute / 60
                let row = (step.minute % 60) / 5
                guard col >= visibleStart, col < visibleEnd, row < rows else { continue }
                let cellStart = col * 60 + row * 5
                let localMin = step.minute - cellStart

                let cx = colX(col)
                let cy = topPad + CGFloat(row) * rowStride
                let x = cx + trackX
                let y = cy + CGFloat(localMin) * minuteH

                let lit = hoveredGridCell?.col == col && hoveredGridCell?.row == row

                if lit {
                    // 灯光光晕 — 外圈辉光
                    ctx.drawLayer { glow in
                        glow.addFilter(.blur(radius: 8))
                        glow.fill(Path(ellipseIn: CGRect(x: x - 8, y: y - 8, width: 16, height: 16)),
                                  with: .color(color.opacity(0.6)))
                    }
                }

                // 背景挖空
                let nodeR: CGFloat = lit ? 6 : 5
                ctx.fill(Path(ellipseIn: CGRect(x: x - nodeR, y: y - nodeR, width: nodeR * 2, height: nodeR * 2)),
                         with: .color(NeonBrutalismTheme.background))
                // 外环
                let ringR: CGFloat = lit ? 5.5 : 4.5
                ctx.stroke(Path(ellipseIn: CGRect(x: x - ringR, y: y - ringR, width: ringR * 2, height: ringR * 2)),
                           with: .color(color.opacity(lit ? 1.0 : 0.6)), lineWidth: lit ? 2 : 1.5)
                // 内点
                let dotR: CGFloat = lit ? 2.5 : 2
                ctx.fill(Path(ellipseIn: CGRect(x: x - dotR, y: y - dotR, width: dotR * 2, height: dotR * 2)),
                         with: .color(color))

                // 序号（始终显示）
                let numLabel = Text(step.label)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(color.opacity(lit ? 1.0 : 0.5))
                ctx.draw(ctx.resolve(numLabel), at: .init(x: x + 9, y: y), anchor: .leading)

                // 描述文字（仅悬浮时闪出）
                if lit && !step.title.isEmpty {
                    let titleLabel = Text(step.title)
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundColor(color)
                    let numWidth: CGFloat = 16  // 序号占位
                    ctx.draw(ctx.resolve(titleLabel), at: .init(x: x + 9 + numWidth, y: y), anchor: .leading)
                }
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

            // 活动至少部分在可见范围内
            guard endCol >= visibleStart && startCol < visibleEnd else { continue }

            let clampedStart = max(startCol, visibleStart)
            let clampedEnd = min(endCol, visibleEnd - 1)
            let firstRow = (a.startMinute % 60) / 5
            let lastRow = ((a.endMinute - 1) % 60) / 5

            let x1 = colX(clampedStart)
            let x2 = colX(clampedEnd) + cellW
            let y1 = topPad + CGFloat(firstRow) * rowStride
            let y2: CGFloat
            if startCol == endCol {
                y2 = topPad + CGFloat(lastRow) * rowStride + cellH
            } else {
                y2 = topPad + CGFloat(rows - 1) * rowStride + cellH
            }

            let cx = (x1 + x2) / 2
            let cy = (y1 + y2) / 2

            let title = Text(a.title)
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundColor(color)
            ctx.draw(ctx.resolve(title), at: .init(x: cx, y: cy - 8), anchor: .center)

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
        guard h >= visibleStart, h < visibleEnd else { return }

        let row = m / 5
        let localMin = m % 5
        guard row < rows else { return }

        let cx = colX(h)
        let cy = topPad + CGFloat(row) * rowStride
        let y = cy + CGFloat(localMin) * minuteH

        var tick = Path()
        tick.move(to: .init(x: cx, y: y))
        tick.addLine(to: .init(x: cx + cellW, y: y))
        ctx.stroke(tick, with: .color(NeonBrutalismTheme.electricBlue.opacity(0.6)), lineWidth: 1)

        ctx.fill(Path(ellipseIn: CGRect(x: cx - 2, y: y - 2, width: 4, height: 4)),
                 with: .color(NeonBrutalismTheme.electricBlue))
    }

    // MARK: - Draw: Selected Cell Highlight

    private func drawSelectedCellHighlight(ctx: inout GraphicsContext) {
        guard let sel = selectedCell else { return }
        guard sel.col >= visibleStart, sel.col < visibleEnd, sel.row >= 0, sel.row < rows else { return }

        let cx = colX(sel.col)
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
    DayNightChartView(selectedCell: .constant(nil), isExpanded: .constant(false))
        .environmentObject(AgentManager.shared)
        .frame(width: 1200, height: 850)
}
