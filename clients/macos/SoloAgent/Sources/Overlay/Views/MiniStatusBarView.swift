import SwiftUI

/// 屏幕边缘常驻迷你状态条 (~200x36)
struct MiniStatusBarView: View {
    @ObservedObject var agentManager: AgentManager

    var body: some View {
        HStack(spacing: 8) {
            // Level badge
            Text("Lv.\(agentManager.player.level)")
                .font(HolographicTheme.miniLevelFont)
                .glowText()

            // Exp bar
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.white.opacity(0.1))
                        .frame(height: 6)

                    RoundedRectangle(cornerRadius: 3)
                        .fill(HolographicTheme.expBarGradient)
                        .frame(
                            width: max(0, geo.size.width * agentManager.player.expProgress),
                            height: 6
                        )
                        .shadow(color: HolographicTheme.expGreen.opacity(0.6), radius: 4)
                }
                .frame(height: 6)
                .frame(maxHeight: .infinity, alignment: .center)
            }

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
                            .fill(buff.isDebuff ? HolographicTheme.dangerRed : HolographicTheme.accentPurple)
                            .frame(width: 6, height: 6)
                            .shadow(color: buff.isDebuff ? HolographicTheme.dangerRed : HolographicTheme.accentPurple, radius: 3)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(width: HolographicTheme.miniBarSize.width, height: HolographicTheme.miniBarSize.height)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 18)
                    .fill(HolographicTheme.panelBackground.opacity(0.85))
                RoundedRectangle(cornerRadius: 18)
                    .fill(.ultraThinMaterial.opacity(0.15))
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(HolographicTheme.borderGradient, lineWidth: 0.5)
        )
        .shadow(color: HolographicTheme.primaryBlue.opacity(0.2), radius: 12)
        .overlay(ScanlineOverlay().clipShape(RoundedRectangle(cornerRadius: 18)))
    }

    private var latestActivityColor: Color {
        switch agentManager.activityFeed.latestColorKey {
        case "blue":      return HolographicTheme.primaryBlue
        case "green":     return HolographicTheme.expGreen
        case "purple":    return HolographicTheme.accentPurple
        case "gold":      return HolographicTheme.warningOrange
        case "secondary": return HolographicTheme.textSecondary
        default:          return HolographicTheme.textSecondary
        }
    }
}
