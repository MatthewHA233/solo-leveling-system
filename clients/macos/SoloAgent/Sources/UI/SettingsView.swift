import SwiftUI

/// 设置窗口
struct SettingsView: View {
    @EnvironmentObject var agent: AgentManager
    
    @State private var serverURL: String = ""
    @State private var deviceName: String = ""
    @State private var captureInterval: Double = 30
    @State private var captureQuality: Double = 0.6
    @State private var maxWidth: Double = 1280
    @State private var excludedApps: String = ""
    @State private var showSaved: Bool = false
    
    var body: some View {
        TabView {
            // 通用设置
            generalTab
                .tabItem {
                    Label("通用", systemImage: "gear")
                }
            
            // 捕捉设置
            captureTab
                .tabItem {
                    Label("捕捉", systemImage: "camera")
                }
            
            // 隐私设置
            privacyTab
                .tabItem {
                    Label("隐私", systemImage: "lock.shield")
                }
            
            // 关于
            aboutTab
                .tabItem {
                    Label("关于", systemImage: "info.circle")
                }
        }
        .padding(20)
        .frame(width: 450, height: 350)
        .onAppear {
            loadConfig()
        }
    }
    
    // MARK: - Tabs
    
    private var generalTab: some View {
        Form {
            Section("服务器") {
                TextField("服务器地址", text: $serverURL)
                    .textFieldStyle(.roundedBorder)
                Text("当前: \(agent.isConnected ? "已连接 ✅" : "未连接 ❌")")
                    .font(.caption)
                    .foregroundColor(agent.isConnected ? .green : .red)
            }
            
            Section("设备") {
                TextField("设备名称", text: $deviceName)
                    .textFieldStyle(.roundedBorder)
                Text("设备 ID: \(agent.deviceId)")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            HStack {
                Spacer()
                if showSaved {
                    Text("已保存 ✓")
                        .foregroundColor(.green)
                        .font(.caption)
                }
                Button("保存") {
                    saveConfig()
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
    
    private var captureTab: some View {
        Form {
            Section("截图设置") {
                HStack {
                    Text("活跃间隔:")
                    Slider(value: $captureInterval, in: 10...120, step: 5) {
                        Text("")
                    }
                    Text("\(Int(captureInterval))秒")
                        .frame(width: 50)
                }
                
                HStack {
                    Text("JPEG 质量:")
                    Slider(value: $captureQuality, in: 0.3...1.0, step: 0.1) {
                        Text("")
                    }
                    Text("\(Int(captureQuality * 100))%")
                        .frame(width: 50)
                }
                
                HStack {
                    Text("最大宽度:")
                    Slider(value: $maxWidth, in: 640...2560, step: 160) {
                        Text("")
                    }
                    Text("\(Int(maxWidth))px")
                        .frame(width: 60)
                }
            }
            
            Section("预估数据量") {
                let perShot = Int(maxWidth * captureQuality * 0.05) // 粗略估算 KB
                let perDay = perShot * (86400 / Int(captureInterval)) / 1024 // MB
                Text("约 \(perShot)KB/张，\(perDay)MB/天")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
    
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
    
    // MARK: - Config
    
    private func loadConfig() {
        let config = agent.config
        serverURL = config.serverURL
        deviceName = config.deviceName
        captureQuality = config.captureJpegQuality
        maxWidth = Double(config.captureMaxWidth)
        excludedApps = config.excludedApps.joined(separator: "\n")
    }
    
    private func saveConfig() {
        var config = agent.config
        config.serverURL = serverURL
        config.deviceName = deviceName
        config.captureJpegQuality = captureQuality
        config.captureMaxWidth = Int(maxWidth)
        config.excludedApps = excludedApps
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        config.save()
        
        showSaved = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            showSaved = false
        }
    }
}
