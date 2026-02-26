import SwiftUI

/// 屏幕边缘常驻迷你状态条 (~200x36) — Neon Brutalism
struct MiniStatusBarView: View {
    @ObservedObject var agentManager: AgentManager

    var body: some View {
        HStack(spacing: 8) {
            // Level badge
            Text("Lv.\(agentManager.player.level)")
                .font(NeonBrutalismTheme.miniLevelFont)
                .brutalGlow()

            // Exp bar -> 动机进度条 (Mock)
            MotivationBarView(
                title: "系统同步率",
                level: agentManager.player.level,
                progress: agentManager.player.expProgress,
                coreColor: NeonBrutalismTheme.expGreen
            )
            .frame(width: 100, height: 20)
            .padding(.leading, 8)

            // Latest activity icon
            if let icon = agentManager.activityFeed.latestIcon {
                Image(systemName: icon)
                    .font(.system(size: 10))
                    .foregroundColor(latestActivityColor)
                    .shadow(color: latestActivityColor.opacity(0.6), radius: 3)
            }

            // Active buff icons
            if !agentManager.player.activeBuffs.isEmpty {
                HStack(spacing: 2) {
                    ForEach(agentManager.player.activeBuffs.prefix(3)) { buff in
                        Circle()
                            .fill(buff.isDebuff ? NeonBrutalismTheme.dangerRed : NeonBrutalismTheme.shadowPurple)
                            .frame(width: 6, height: 6)
                            .shadow(color: buff.isDebuff ? NeonBrutalismTheme.dangerRed : NeonBrutalismTheme.shadowPurple, radius: 3)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(width: NeonBrutalismTheme.miniBarSize.width, height: NeonBrutalismTheme.miniBarSize.height)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 18)
                    .fill(NeonBrutalismTheme.background.opacity(0.9))
                RoundedRectangle(cornerRadius: 18)
                    .fill(.ultraThinMaterial.opacity(0.12))
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(NeonBrutalismTheme.borderGradient, lineWidth: 0.5)
        )
        .shadow(color: NeonBrutalismTheme.electricBlue.opacity(0.25), radius: 12)
        .overlay(NeonScanlineOverlay().clipShape(RoundedRectangle(cornerRadius: 18)))
    }

    private var latestActivityColor: Color {
        switch agentManager.activityFeed.latestColorKey {
        case "blue":      return NeonBrutalismTheme.electricBlue
        case "green":     return NeonBrutalismTheme.expGreen
        case "purple":    return NeonBrutalismTheme.shadowPurple
        case "gold":      return NeonBrutalismTheme.warningOrange
        case "secondary": return NeonBrutalismTheme.textSecondary
        default:          return NeonBrutalismTheme.textSecondary
        }
    }
}
