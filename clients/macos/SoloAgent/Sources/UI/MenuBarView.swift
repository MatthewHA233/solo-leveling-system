import SwiftUI

/// 菜单栏弹出视图
struct MenuBarView: View {
    @EnvironmentObject var agent: AgentManager
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Image(systemName: "bolt.fill")
                    .foregroundColor(.purple)
                    .font(.title2)
                Text("Solo Agent")
                    .font(.headline)
                Spacer()
                StatusBadge(isConnected: agent.isConnected)
            }
            
            Divider()
            
            // 状态信息
            VStack(alignment: .leading, spacing: 6) {
                StatusRow(icon: "camera.fill", label: "捕捉状态",
                         value: agent.isCapturing ? (agent.isPaused ? "隐私模式" : "运行中") : "已停止",
                         color: agent.isCapturing && !agent.isPaused ? .green : .orange)
                
                StatusRow(icon: "server.rack", label: "服务器",
                         value: agent.isConnected ? "已连接" : "离线",
                         color: agent.isConnected ? .green : .red)
                
                StatusRow(icon: "number", label: "截图数量",
                         value: "\(agent.captureCount)")
                
                if let lastCapture = agent.lastCaptureTime {
                    StatusRow(icon: "clock", label: "最后捕捉",
                             value: lastCapture.formatted(.relative(presentation: .named)))
                }
                
                StatusRow(icon: "desktopcomputer", label: "设备 ID",
                         value: agent.deviceId)
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
                Button("设置...") {
                    NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
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
        .frame(width: 280)
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
