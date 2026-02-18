import SwiftUI

/// Solo Leveling System — macOS Agent
/// 轻量级屏幕感知客户端，负责采集用户活动数据并上报服务器
@main
struct SoloAgentApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var agentManager = AgentManager.shared
    
    var body: some Scene {
        // 菜单栏常驻 — 不需要主窗口
        MenuBarExtra {
            MenuBarView()
                .environmentObject(agentManager)
        } label: {
            Image(systemName: agentManager.isCapturing ? "bolt.fill" : "bolt.slash")
            Text(agentManager.statusText)
        }
        .menuBarExtraStyle(.window)
        
        // 设置窗口
        Settings {
            SettingsView()
                .environmentObject(agentManager)
        }

        // 时间线窗口
        Window("活动时间线", id: "timeline") {
            TimelineView()
                .environmentObject(agentManager)
        }
        .defaultSize(width: 900, height: 700)
        .defaultPosition(.center)
    }
}

/// App Delegate — 处理应用生命周期
class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // 隐藏 Dock 图标（纯菜单栏应用）
        NSApp.setActivationPolicy(.accessory)
        
        // 初始化核心服务
        Task {
            await AgentManager.shared.initialize()
        }
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        // 清理：停止捕捉、关闭连接
        Task {
            await AgentManager.shared.shutdown()
        }
    }
}
