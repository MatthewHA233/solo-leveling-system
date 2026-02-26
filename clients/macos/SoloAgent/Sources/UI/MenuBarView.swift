import SwiftUI

/// 菜单栏弹出视图 — 精简版（详细状态已迁移到全息悬浮 UI）
struct MenuBarView: View {
    @EnvironmentObject var agent: AgentManager
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Image(systemName: "bolt.fill")
                    .foregroundColor(.purple)
                    .font(.title2)
                Text("独自升级")
                    .font(.headline)
                Spacer()
                // Player level badge
                Text("等级 \(agent.player.level)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(.purple)
            }

            Divider()

            // 精简状态
            VStack(alignment: .leading, spacing: 6) {
                StatusRow(icon: "camera.fill", label: "捕捉状态",
                         value: agent.isCapturing ? (agent.isPaused ? "隐私模式" : "运行中") : "已停止",
                         color: agent.isCapturing && !agent.isPaused ? .green : .orange)

                StatusRow(icon: "number", label: "今日截图",
                         value: "\(agent.captureCount)")
            }

            Divider()

            // 控制按钮
            HStack(spacing: 8) {
                Button(action: {
                    if agent.isCapturing {
                        agent.stopCapturing()
                    } else {
                        agent.startCapturing()
                    }
                }) {
                    Label(
                        agent.isCapturing ? "停止" : "开始",
                        systemImage: agent.isCapturing ? "stop.fill" : "play.fill"
                    )
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(agent.isCapturing ? .red : .green)

                Button(action: {
                    agent.togglePause()
                }) {
                    Label(
                        agent.isPaused ? "恢复" : "隐私",
                        systemImage: agent.isPaused ? "eye" : "eye.slash"
                    )
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(!agent.isCapturing)
            }

            Divider()

            // 底部链接
            HStack {
                Button("全域网监控") {
                    openWindow(id: "omniscience")
                    NSApp.activate(ignoringOtherApps: true)
                }
                .buttonStyle(.link)

                Spacer()

                Button("退出") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.link)
                .foregroundColor(.secondary)
            }
        }
        .padding()
        .frame(width: 300)
    }
}

/// 状态行
struct StatusRow: View {
    let icon: String
    let label: String
    let value: String
    var color: Color = .primary

    var body: some View {
        HStack {
            Image(systemName: icon)
                .frame(width: 16)
                .foregroundColor(.secondary)
            Text(label)
                .foregroundColor(.secondary)
                .font(.caption)
            Spacer()
            Text(value)
                .font(.caption)
                .fontWeight(.medium)
                .foregroundColor(color)
        }
    }
}

/// 连接状态徽章
struct StatusBadge: View {
    let isConnected: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(isConnected ? Color.green : Color.red)
                .frame(width: 8, height: 8)
            Text(isConnected ? "在线" : "离线")
                .font(.caption2)
                .foregroundColor(.secondary)
        }
    }
}
