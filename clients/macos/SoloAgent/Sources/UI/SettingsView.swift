import SwiftUI

/// 设置窗口
struct SettingsView: View {
    @EnvironmentObject var agent: AgentManager
    
    @State private var deviceName: String = ""
    @State private var captureInterval: Double = 10
    @State private var batchDuration: Double = 15  // 分钟
    @State private var captureQuality: Double = 0.6
    @State private var maxWidth: Double = 1280
    @State private var excludedApps: String = ""
    @State private var showSaved: Bool = false
    
    var body: some View {
        VStack(spacing: 0) {
            TabView {
                generalTab
                    .tabItem { Label("通用", systemImage: "gear") }

                captureTab
                    .tabItem { Label("捕捉", systemImage: "camera") }

                privacyTab
                    .tabItem { Label("隐私", systemImage: "lock.shield") }

                dataTab
                    .tabItem { Label("数据", systemImage: "cylinder.split.1x2") }

                aboutTab
                    .tabItem { Label("关于", systemImage: "info.circle") }
            }
            .padding(20)

            Divider()

            // 全局保存栏
            HStack {
                if showSaved {
                    Label("已保存并生效", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundColor(.green)
                        .transition(.opacity)
                }

                Spacer()

                Button("保存") {
                    saveConfig()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut("s", modifiers: .command)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        }
        .onAppear {
            loadConfig()
        }
    }
    
    // MARK: - 通用
    
    private var generalTab: some View {
        Form {
            Section("AI 分析") {
                Text("模式: 本地 Gemini API 视频批次分析")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section("设备") {
                TextField("设备名称", text: $deviceName)
                    .textFieldStyle(.roundedBorder)
                Text("设备 ID: \(agent.deviceId)")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
    
    // MARK: - 捕捉
    
    private var captureTab: some View {
        Form {
            Section("截图频率") {
                HStack {
                    Text("截图间隔:")
                    Slider(value: $captureInterval, in: 0.1...60, step: captureIntervalStep)
                    Text(formatInterval(captureInterval))
                        .frame(width: 55, alignment: .trailing)
                        .font(.system(.body, design: .monospaced))
                }
                Text("活跃状态下的截图频率，越快截图越密集")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section("AI 分析批次") {
                HStack {
                    Text("批次时长:")
                    Slider(value: $batchDuration, in: 1...30, step: 1)
                    Text("\(Int(batchDuration)) 分钟")
                        .frame(width: 55, alignment: .trailing)
                        .font(.system(.body, design: .monospaced))
                }
                let framesPerBatch = Int(batchDuration * 60 / captureInterval)
                Text("每 \(Int(batchDuration)) 分钟合成一段视频发给 AI 分析，约 \(framesPerBatch) 帧")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section("图片质量") {
                HStack {
                    Text("JPEG 质量:")
                    Slider(value: $captureQuality, in: 0.3...1.0, step: 0.1)
                    Text("\(Int(captureQuality * 100))%")
                        .frame(width: 55, alignment: .trailing)
                }

                HStack {
                    Text("最大宽度:")
                    Slider(value: $maxWidth, in: 640...2560, step: 160)
                    Text("\(Int(maxWidth))px")
                        .frame(width: 55, alignment: .trailing)
                }
            }

            Section("预估数据量") {
                let perShot = Int(maxWidth * captureQuality * 0.05)
                let shotsPerDay = Int(86400 / captureInterval)
                let mbPerDay = perShot * shotsPerDay / 1024
                Text("约 \(perShot)KB/张 · \(shotsPerDay) 张/天 · \(mbPerDay)MB/天")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    /// 截图间隔滑块步进值（根据当前值动态调整）
    private var captureIntervalStep: Double {
        if captureInterval < 1 { return 0.1 }
        if captureInterval < 10 { return 0.5 }
        return 1
    }

    /// 格式化间隔显示
    private func formatInterval(_ value: Double) -> String {
        if value < 1 {
            return String(format: "%.1fs", value)
        }
        return String(format: "%.0fs", value)
    }
    
    // MARK: - 隐私
    
    private var privacyTab: some View {
        Form {
            Section("排除的应用 (每行一个 Bundle ID)") {
                TextEditor(text: $excludedApps)
                    .frame(height: 120)
                    .font(.system(.body, design: .monospaced))
            }
            
            Section("说明") {
                Text("排除列表中的应用在前台时不会截图。\n默认排除: 钥匙串、包含密码/银行/支付关键词的窗口。")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
    
    // MARK: - 数据
    
    private var dataTab: some View {
        let counts = agent.persistence.recordCounts()
        let stats = agent.persistence.todayStats()
        let topApps = agent.persistence.todayTopApps(limit: 5)
        
        return Form {
            Section("数据库") {
                HStack {
                    Text("存储大小")
                    Spacer()
                    Text(agent.persistence.databaseSize)
                        .foregroundColor(.secondary)
                }
                HStack {
                    Text("活动记录")
                    Spacer()
                    Text("\(counts.activities) 条")
                        .foregroundColor(.secondary)
                }
                HStack {
                    Text("待同步")
                    Spacer()
                    Text("\(counts.pending) 条")
                        .foregroundColor(counts.pending > 0 ? .orange : .secondary)
                }
                HStack {
                    Text("每日统计")
                    Spacer()
                    Text("\(counts.dailyStats) 天")
                        .foregroundColor(.secondary)
                }
                HStack {
                    Text("应用记录")
                    Spacer()
                    Text("\(counts.appUsage) 条")
                        .foregroundColor(.secondary)
                }
            }
            
            Section("今日概览") {
                HStack {
                    Text("📸 截图")
                    Spacer()
                    Text("\(stats.captureCount) 次")
                        .foregroundColor(.secondary)
                }
                HStack {
                    Text("⚡ 活跃时间")
                    Spacer()
                    Text(formatDuration(stats.activeSeconds))
                        .foregroundColor(.green)
                }
                HStack {
                    Text("😴 空闲时间")
                    Spacer()
                    Text(formatDuration(stats.idleSeconds))
                        .foregroundColor(.orange)
                }
                HStack {
                    Text("🔒 锁屏时间")
                    Spacer()
                    Text(formatDuration(stats.lockedSeconds))
                        .foregroundColor(.secondary)
                }
                HStack {
                    Text("🔄 窗口切换")
                    Spacer()
                    Text("\(stats.windowSwitchCount) 次")
                        .foregroundColor(.secondary)
                }
                HStack {
                    Text("📱 使用应用")
                    Spacer()
                    Text("\(stats.uniqueAppCount) 个")
                        .foregroundColor(.secondary)
                }
            }
            
            if !topApps.isEmpty {
                Section("今日 Top 应用") {
                    ForEach(Array(topApps.enumerated()), id: \.offset) { index, app in
                        HStack {
                            Text("\(index + 1).")
                                .foregroundColor(.secondary)
                                .frame(width: 20)
                            Text(app.appName)
                            Spacer()
                            Text(formatDuration(app.foregroundSeconds))
                                .foregroundColor(.purple)
                            Text("(\(app.activationCount)次)")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
            
            Section {
                HStack {
                    Button("清理旧数据") {
                        agent.persistence.cleanupOldRecords(olderThan: 7)
                        agent.persistence.cleanupFailedReports(maxRetries: 10)
                    }
                    .buttonStyle(.bordered)
                    
                    Spacer()
                    
                    Text("自动保留最近 7 天")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        }
    }
    
    // MARK: - 关于
    
    private var aboutTab: some View {
        VStack(spacing: 12) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 48))
                .foregroundColor(.purple)
            
            Text("Solo Agent")
                .font(.title)
                .fontWeight(.bold)
            
            Text("独自升级系统 — macOS 客户端")
                .foregroundColor(.secondary)
            
            Text("v0.1.0")
                .font(.caption)
                .foregroundColor(.secondary)
            
            Spacer()
            
            Text("「你已被选中为玩家。」")
                .font(.caption)
                .italic()
                .foregroundColor(.purple.opacity(0.7))
        }
        .padding()
    }
    
    // MARK: - Helpers
    
    private func loadConfig() {
        let config = agent.config
        deviceName = config.deviceName
        captureInterval = config.screenshotInterval
        batchDuration = config.batchTargetDuration / 60  // 秒→分钟
        captureQuality = config.captureJpegQuality
        maxWidth = Double(config.captureMaxWidth)
        excludedApps = config.excludedApps.joined(separator: "\n")
    }

    private func saveConfig() {
        // 从磁盘读最新配置，避免覆盖掉 UI 中没有的字段（如 API key）
        var config = AgentConfig.load()
        config.deviceName = deviceName
        config.screenshotInterval = captureInterval
        config.batchTargetDuration = batchDuration * 60  // 分钟→秒
        config.captureJpegQuality = captureQuality
        config.captureMaxWidth = Int(maxWidth)
        config.excludedApps = excludedApps
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        config.save()

        // 实时应用新配置
        agent.reloadConfig()

        withAnimation {
            showSaved = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            withAnimation {
                showSaved = false
            }
        }
    }
    
    private func formatDuration(_ seconds: Double) -> String {
        let total = Int(seconds)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        if minutes > 0 {
            return "\(minutes)m"
        }
        return "\(total)s"
    }
}
