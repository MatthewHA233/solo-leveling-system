import SwiftUI

/// Solo Leveling System — macOS Agent
/// 本地游戏引擎 + 全息悬浮 UI + 屏幕感知
@main
struct SoloAgentApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var agentManager = AgentManager.shared

    var body: some Scene {
        // 菜单栏常驻 — 精简为图标 + 最小菜单
        MenuBarExtra {
            MenuBarView()
                .environmentObject(agentManager)
        } label: {
            Image(systemName: agentManager.isCapturing ? "bolt.fill" : "bolt.slash")
            Text(agentManager.statusText)
        }
        .menuBarExtraStyle(.window)

        // 设置窗口
        Window("设置", id: "settings") {
            SettingsView()
                .environmentObject(agentManager)
        }
        .defaultSize(width: 480, height: 400)
        .defaultPosition(.center)

        // 全域网监控窗口（标准 macOS 窗口）
        Window("全域网监控", id: "omniscience") {
            UnifiedSystemView()
                .environmentObject(agentManager)
        }
        .defaultSize(width: 1600, height: 1000)
        .defaultPosition(.center)
    }
}

/// App Delegate — 处理应用生命周期
class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // 调试：确认 AppDelegate 被调用
        let dbg = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/solo-agent/appdelegate-debug.log")
        try? "AppDelegate START \(Date())\n".data(using: .utf8)?.write(to: dbg)

        // 隐藏 Dock 图标（纯菜单栏应用）
        NSApp.setActivationPolicy(.accessory)

        // 初始化核心服务
        Task {
            await AgentManager.shared.initialize()

            // 启动全息悬浮覆盖层
            OverlayManager.shared.setup(agentManager: AgentManager.shared)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // 清理：停止覆盖层、停止捕捉、关闭连接
        OverlayManager.shared.shutdown()
        Task {
            await AgentManager.shared.shutdown()
        }
    }
}
