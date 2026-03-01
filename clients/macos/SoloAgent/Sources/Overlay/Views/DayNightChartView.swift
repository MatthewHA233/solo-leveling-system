import SwiftUI
import AppKit

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
/// 始终使用展开坐标系: col=小时(0-23), row=5分钟块(0-11)
struct CellKey: Hashable {
    let col: Int
    let row: Int
}

private struct TraceLayout {
    let activity: ChronosActivity
    let trackIndex: Int // 0, 1, 2 (最多三路并行)
}

/// 批次缩略图单元
struct BatchThumbnail {
    let batchId: String
    let startMinute: Int    // 分钟刻度 (0-1439)
    let endMinute: Int      // 分钟刻度 (1-1440)
    let image: NSImage
    let videoPath: String?
}

/// 批次在某一行内的裁剪段
private struct BatchRowSegment {
    let col: Int, row: Int
    let startMinute: Int, endMinute: Int  // 绝对分钟
    let cellStart: Int                     // 所在行的起始分钟
}

// MARK: - DayNightChartView

/// 昼夜表 — 电路走线风格, 分钟级精度, 截屏缩略图背景
/// 展开: 24列×12行 (1列=1小时, 12行×5分=60分)
/// 收缩: 48列×6行 (1列=30分, 6行×5分=30分), 放大2×, 显示近2小时(4列)
struct DayNightChartView: View {
    @EnvironmentObject var agent: AgentManager
    @State private var activities: [ChronosActivity] = []

    @State private var hoveredActivity: ChronosActivity?
    @State private var hoveredGridCell: CellKey?
    @Binding var selectedBatchId: String?
    @Binding var selectedDate: Date
    @Binding var isExpanded: Bool

    // ── 批次缩略图 ──
    @State private var batchThumbnails: [BatchThumbnail] = []

    // ── 核心: 每列代表的分钟数 ──
    /// 展开=60(1小时/列, 12行), 收缩=30(半小时/列, 6行)
    private var minutesPerCol: Int { isExpanded ? 60 : 30 }

    // ── Grid 尺寸 ──
    private var cols: Int { 1440 / minutesPerCol }     // 24 or 48
    private var rows: Int { minutesPerCol / 5 }        // 12 or 6
    private var cellW: CGFloat { isExpanded ? 80 : 160 }
    private var cellH: CGFloat { isExpanded ? 50 : 100 }
    private var colGap: CGFloat { isExpanded ? 2 : 4 }
    private let rowGap: CGFloat = 10    // HH:MM 标签区域
    private let hPad: CGFloat = 4
    private let topPad: CGFloat = 28
    private let bottomPad: CGFloat = 8
    private var minuteH: CGFloat { isExpanded ? 10 : 20 }

    // ── Trace 参数 ──
    private let traceW: CGFloat = 3.0
    private var traceBaseX: CGFloat { isExpanded ? 10 : 20 }
    private var trackSp: CGFloat { isExpanded ? 10 : 18 }

    // ── 可见列范围（展开/收缩都渲染全天，收缩靠 ScrollView 滚动） ──
    private var visibleStart: Int { 0 }
    private var visibleEnd: Int { cols }
    private var visibleCount: Int { cols }

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
            ScrollViewReader { proxy in
                ScrollView([.horizontal, .vertical], showsIndicators: true) {
                    ZStack(alignment: .topLeading) {
                        canvas
                            .frame(width: totalW, height: totalH)

                        // 锚点行：真实布局参与 ScrollView，供 ScrollViewReader 定位
                        HStack(spacing: 0) {
                            ForEach(0..<cols, id: \.self) { col in
                                Color.clear
                                    .frame(width: colStride, height: 1)
                                    .id("col_\(col)")
                            }
                        }
                    }
                }
                .onAppear {
                    // 延迟确保 loadActivities 完成后再滚动
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        scrollToTarget(proxy: proxy)
                    }
                }
                .onChange(of: isExpanded) { _, _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        scrollToTarget(proxy: proxy)
                    }
                }
                .onChange(of: selectedDate) { _, _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        scrollToTarget(proxy: proxy)
                    }
                }
            }

            NeonDivider(.horizontal)
            legendBar
        }
        .background(NeonBrutalismTheme.background)
        .onAppear { loadActivities() }
        .onChange(of: selectedDate) { _, _ in loadActivities() }
        .onChange(of: agent.activityCardsUpdated) { _, _ in loadActivities() }
    }

    // MARK: - Scroll Helpers

    /// 今天 → 滚动到当前时间；历史日期 → 滚动到最早数据位置
    private func scrollToTarget(proxy: ScrollViewProxy) {
        let targetCol: Int
        if Calendar.current.isDateInToday(selectedDate) {
            let h = Calendar.current.component(.hour, from: Date())
            targetCol = max(0, h * (cols / 24) - 1)
        } else {
            let earliestActivity = activities.min(by: { $0.startMinute < $1.startMinute })?.startMinute
            let earliestBatch = batchThumbnails.min(by: { $0.startMinute < $1.startMinute })?.startMinute
            let candidates = [earliestActivity, earliestBatch].compactMap { $0 }
            if let earliest = candidates.min() {
                targetCol = max(0, earliest / minutesPerCol - 1)
            } else {
                targetCol = 0
            }
        }
        withAnimation(.easeOut(duration: 0.3)) {
            proxy.scrollTo("col_\(targetCol)", anchor: .leading)
        }
    }

    // MARK: - Data Loading

    private func loadActivities() {
        let cards = agent.persistence.activityCards(for: selectedDate)
        activities = ChronosActivityConverter.convertAll(cards)
        loadBatchThumbnails()
    }

    /// 加载当日批次 → 每个 batch 取中间帧截图构建 BatchThumbnail
    private func loadBatchThumbnails() {
        let batches = agent.persistence.batchesForDate(selectedDate)
        guard !batches.isEmpty else {
            batchThumbnails = []
            return
        }

        let cal = Calendar.current
        let storage = ScreenshotStorageManager.shared
        let persistence = agent.persistence

        DispatchQueue.global(qos: .utility).async {
            var thumbnails: [BatchThumbnail] = []
            for batch in batches {
                let startDate = Date(timeIntervalSince1970: Double(batch.startTs))
                let endDate = Date(timeIntervalSince1970: Double(batch.endTs))
                let sh = cal.component(.hour, from: startDate)
                let sm = cal.component(.minute, from: startDate)
                let eh = cal.component(.hour, from: endDate)
                let em = cal.component(.minute, from: endDate)
                let startMin = sh * 60 + sm
                var endMin = eh * 60 + em
                if endMin <= startMin { endMin = startMin + 1 }

                // 取该 batch 的截图，选中间帧
                let screenshots = persistence.screenshotsForBatch(batch.id)
                guard !screenshots.isEmpty else { continue }
                let midIdx = screenshots.count / 2
                let midRecord = screenshots[midIdx]

                if let img = NSImage(contentsOf: storage.thumbnailURL(for: midRecord.filePath)) {
                    thumbnails.append(BatchThumbnail(
                        batchId: batch.id,
                        startMinute: startMin,
                        endMinute: endMin,
                        image: img,
                        videoPath: batch.videoPath
                    ))
                }
            }
            DispatchQueue.main.async {
                batchThumbnails = thumbnails
            }
        }
    }

    // MARK: - Canvas

    private var canvas: some View {
        let layouts = computeLayouts()

        return Canvas { ctx, _ in
            drawGrid(ctx: &ctx)
            drawBatchThumbnails(ctx: &ctx)
            drawTimeLabels(ctx: &ctx)
            drawCellFills(ctx: &ctx, layouts: layouts)

            ctx.drawLayer { glow in
                glow.addFilter(.blur(radius: 5))
                glow.opacity = 0.3
                drawTraceSegments(ctx: &glow, layouts: layouts, glow: true)
            }

            drawTraceSegments(ctx: &ctx, layouts: layouts, glow: false)
            drawStepNodes(ctx: &ctx, layouts: layouts)
            drawTitles(ctx: &ctx, layouts: layouts)
            drawNowTick(ctx: &ctx)
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
                    let m = c * minutesPerCol + rBlock * 5 + extraMin
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
            guard c >= visibleStart, c < visibleEnd, r >= 0, r < rows else {
                selectedBatchId = nil
                return
            }
            // 由 tap 位置算出精确 minute-of-day
            let localY = location.y - topPad - CGFloat(r) * rowStride
            let extraMin = min(Int(localY / minuteH), 4)
            let minute = c * minutesPerCol + r * 5 + extraMin
            // 遍历 batchThumbnails 找命中的 batch
            if let hit = batchThumbnails.first(where: { minute >= $0.startMinute && minute < $0.endMinute }) {
                selectedBatchId = (selectedBatchId == hit.batchId) ? nil : hit.batchId
            } else {
                selectedBatchId = nil
            }
        }
    }

    // MARK: - Draw: Grid

    private func drawGrid(ctx: inout GraphicsContext) {
        for c in visibleStart..<visibleEnd {
            let hourOfCol = c * minutesPerCol / 60
            let isNight = hourOfCol < 6 || hourOfCol >= 22
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
        for hour in Swift.stride(from: 6, through: 18, by: 6) {
            let c = hour * 60 / minutesPerCol
            guard c >= visibleStart && c < visibleEnd else { continue }
            let x = colX(c) - colGap / 2
            var p = Path()
            p.move(to: .init(x: x, y: topPad))
            p.addLine(to: .init(x: x, y: topPad + gridH))
            ctx.stroke(p, with: .color(NeonBrutalismTheme.electricBlue.opacity(0.12)), lineWidth: 0.5)
        }
    }

    // MARK: - Draw: Batch Thumbnails (按精确分钟刻度绘制)

    /// 计算 batch 在每一行内的裁剪段
    private func batchRowSegments(startMinute: Int, endMinute: Int) -> [BatchRowSegment] {
        let mpc = minutesPerCol
        var segments: [BatchRowSegment] = []
        var m = startMinute
        while m < endMinute {
            let col = m / mpc
            let row = (m % mpc) / 5
            guard col < cols, row < rows else { break }
            let cellStart = col * mpc + row * 5
            let cellEnd = cellStart + 5
            let segStart = max(startMinute, cellStart)
            let segEnd = min(endMinute, cellEnd)
            if col >= visibleStart && col < visibleEnd {
                segments.append(BatchRowSegment(
                    col: col, row: row,
                    startMinute: segStart, endMinute: segEnd,
                    cellStart: cellStart
                ))
            }
            m = cellEnd
        }
        return segments
    }

    private func drawBatchThumbnails(ctx: inout GraphicsContext) {
        for thumb in batchThumbnails {
            let segments = batchRowSegments(startMinute: thumb.startMinute, endMinute: thumb.endMinute)
            let resolved = ctx.resolve(Image(nsImage: thumb.image))
            let isSelected = selectedBatchId == thumb.batchId

            for seg in segments {
                let localStart = CGFloat(seg.startMinute - seg.cellStart)
                let localEnd = CGFloat(seg.endMinute - seg.cellStart)
                let cx = colX(seg.col)
                let yStart = topPad + CGFloat(seg.row) * rowStride + localStart * minuteH
                let yEnd = topPad + CGFloat(seg.row) * rowStride + localEnd * minuteH
                let rect = CGRect(x: cx, y: yStart, width: cellW, height: yEnd - yStart)

                ctx.draw(resolved, in: rect)
                ctx.fill(Path(rect), with: .color(Color.black.opacity(0.35)))

                if isSelected {
                    ctx.stroke(Path(rect),
                               with: .color(NeonBrutalismTheme.electricBlue.opacity(0.9)),
                               lineWidth: 2)
                    ctx.fill(Path(rect),
                             with: .color(NeonBrutalismTheme.electricBlue.opacity(0.08)))
                }
            }
        }
    }

    // MARK: - Draw: Time Labels

    private func drawTimeLabels(ctx: inout GraphicsContext) {
        for c in visibleStart..<visibleEnd {
            let x = colX(c) + cellW / 2
            let colStartMin = c * minutesPerCol
            let major = colStartMin % 360 == 0
            let t = Text(String(format: "%02d:%02d", colStartMin / 60, colStartMin % 60))
                .font(.system(size: major ? 12 : 10, weight: major ? .bold : .medium, design: .monospaced))
                .foregroundColor(major ? NeonBrutalismTheme.textPrimary : NeonBrutalismTheme.textSecondary)
            ctx.draw(ctx.resolve(t), at: .init(x: x, y: topPad - 10), anchor: .center)
        }

        for c in visibleStart..<visibleEnd {
            let cx = colX(c) + cellW / 2
            let colStartMin = c * minutesPerCol

            for r in 0..<(rows - 1) {
                let boundaryMin = colStartMin + (r + 1) * 5
                let gapY = topPad + CGFloat(r) * rowStride + cellH + rowGap / 2
                let isMajor = boundaryMin % 10 == 0

                let label = Text(String(format: "%02d:%02d", boundaryMin / 60, boundaryMin % 60))
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

    // MARK: - Draw: Cell Fills

    private func drawCellFills(ctx: inout GraphicsContext, layouts: [TraceLayout]) {
        let mpc = minutesPerCol
        for layout in layouts {
            let a = layout.activity
            let color = categoryColor(a.category)
            let hovered = hoveredActivity?.id == a.id
            let opacity = hovered ? 0.25 : 0.15

            var m = a.startMinute
            while m < a.endMinute {
                let col = m / mpc
                let row = (m % mpc) / 5
                guard col < cols, row < rows else { break }
                let cellStart = col * mpc + row * 5

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

    // MARK: - Draw: Trace Segments

    private func drawTraceSegments(ctx: inout GraphicsContext, layouts: [TraceLayout], glow: Bool) {
        let mpc = minutesPerCol
        for layout in layouts {
            let a = layout.activity
            let color = categoryColor(a.category)
            let hovered = hoveredActivity?.id == a.id
            let trackX = traceBaseX + CGFloat(layout.trackIndex) * trackSp

            var m = a.startMinute
            while m < a.endMinute {
                let col = m / mpc
                let row = (m % mpc) / 5
                guard col < cols, row < rows else { break }
                let cellStart = col * mpc + row * 5
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

    // MARK: - Draw: Step Nodes (焊点)

    private func drawStepNodes(ctx: inout GraphicsContext, layouts: [TraceLayout]) {
        let mpc = minutesPerCol
        for layout in layouts {
            let color = categoryColor(layout.activity.category)
            let trackX = traceBaseX + CGFloat(layout.trackIndex) * trackSp

            for step in layout.activity.steps {
                let col = step.minute / mpc
                let row = (step.minute % mpc) / 5
                guard col >= visibleStart, col < visibleEnd, row < rows else { continue }
                let cellStart = col * mpc + row * 5
                let localMin = step.minute - cellStart

                let cx = colX(col)
                let cy = topPad + CGFloat(row) * rowStride
                let x = cx + trackX
                let y = cy + CGFloat(localMin) * minuteH

                let lit = hoveredGridCell?.col == col && hoveredGridCell?.row == row

                if lit {
                    ctx.drawLayer { glow in
                        glow.addFilter(.blur(radius: 8))
                        glow.fill(Path(ellipseIn: CGRect(x: x - 8, y: y - 8, width: 16, height: 16)),
                                  with: .color(color.opacity(0.6)))
                    }
                }

                let nodeR: CGFloat = lit ? 6 : 5
                ctx.fill(Path(ellipseIn: CGRect(x: x - nodeR, y: y - nodeR, width: nodeR * 2, height: nodeR * 2)),
                         with: .color(NeonBrutalismTheme.background))
                let ringR: CGFloat = lit ? 5.5 : 4.5
                ctx.stroke(Path(ellipseIn: CGRect(x: x - ringR, y: y - ringR, width: ringR * 2, height: ringR * 2)),
                           with: .color(color.opacity(lit ? 1.0 : 0.6)), lineWidth: lit ? 2 : 1.5)
                let dotR: CGFloat = lit ? 2.5 : 2
                ctx.fill(Path(ellipseIn: CGRect(x: x - dotR, y: y - dotR, width: dotR * 2, height: dotR * 2)),
                         with: .color(color))

                let numLabel = Text(step.label)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(color.opacity(lit ? 1.0 : 0.5))
                ctx.draw(ctx.resolve(numLabel), at: .init(x: x + 9, y: y), anchor: .leading)

                if lit && !step.title.isEmpty {
                    let titleLabel = Text(step.title)
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundColor(color)
                    let numWidth: CGFloat = 16
                    ctx.draw(ctx.resolve(titleLabel), at: .init(x: x + 9 + numWidth, y: y), anchor: .leading)
                }
            }
        }
    }

    // MARK: - Draw: Titles

    private func drawTitles(ctx: inout GraphicsContext, layouts: [TraceLayout]) {
        let mpc = minutesPerCol
        for layout in layouts {
            let a = layout.activity
            let color = categoryColor(a.category)

            let startCol = a.startMinute / mpc
            let endCol = min((a.endMinute - 1) / mpc, cols - 1)

            guard endCol >= visibleStart && startCol < visibleEnd else { continue }

            let clampedStart = max(startCol, visibleStart)
            let clampedEnd = min(endCol, visibleEnd - 1)
            let firstRow = (a.startMinute % mpc) / 5
            let lastRow = ((a.endMinute - 1) % mpc) / 5

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

    // MARK: - Draw: Current Time (扫描线指针)

    private func drawNowTick(ctx: inout GraphicsContext) {
        guard Calendar.current.isDateInToday(selectedDate) else { return }
        let cal = Calendar.current
        let h = cal.component(.hour, from: Date())
        let m = cal.component(.minute, from: Date())
        let nowMinute = h * 60 + m

        let col = nowMinute / minutesPerCol
        guard col >= visibleStart, col < visibleEnd else { return }

        let row = (nowMinute % minutesPerCol) / 5
        let localMin = nowMinute % 5
        guard row < rows else { return }

        let cx = colX(col)
        let cy = topPad + CGFloat(row) * rowStride
        let y = cy + CGFloat(localMin) * minuteH
        let blue = NeonBrutalismTheme.electricBlue

        // ① 扫描线光晕 — 宽柔光带
        ctx.drawLayer { glow in
            glow.addFilter(.blur(radius: 6))
            var band = Path()
            band.move(to: .init(x: cx, y: y))
            band.addLine(to: .init(x: cx + cellW, y: y))
            glow.stroke(band, with: .color(blue.opacity(0.5)),
                        style: StrokeStyle(lineWidth: 8))
        }

        // ② 主横线 — 实心亮线
        var mainLine = Path()
        mainLine.move(to: .init(x: cx, y: y))
        mainLine.addLine(to: .init(x: cx + cellW, y: y))
        ctx.stroke(mainLine, with: .color(blue),
                   style: StrokeStyle(lineWidth: 2, lineCap: .round))

        // ③ 左侧三角箭头
        let arrowW: CGFloat = 6
        let arrowH: CGFloat = 8
        var arrow = Path()
        arrow.move(to: .init(x: cx - arrowW, y: y - arrowH / 2))
        arrow.addLine(to: .init(x: cx, y: y))
        arrow.addLine(to: .init(x: cx - arrowW, y: y + arrowH / 2))
        arrow.closeSubpath()
        ctx.fill(arrow, with: .color(blue))

        // ④ 左侧时间标签 (箭头外侧)
        let timeText = Text(String(format: "%02d:%02d", h, m))
            .font(.system(size: 9, weight: .black, design: .monospaced))
            .foregroundColor(.black)
        let resolved = ctx.resolve(timeText)
        let labelW: CGFloat = 38
        let labelH: CGFloat = 14
        let labelX = cx - arrowW - labelW - 2
        let labelY = y - labelH / 2

        let labelRect = CGRect(x: labelX, y: labelY, width: labelW, height: labelH)
        ctx.fill(Path(roundedRect: labelRect, cornerRadius: 3), with: .color(blue))
        ctx.draw(resolved, at: .init(x: labelX + labelW / 2, y: y), anchor: .center)
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
            result.append(TraceLayout(activity: a, trackIndex: min(t, 2)))
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
    DayNightChartView(selectedBatchId: .constant(nil),
                      selectedDate: .constant(Date()),
                      isExpanded: .constant(false))
        .environmentObject(AgentManager.shared)
        .frame(width: 1200, height: 850)
}
