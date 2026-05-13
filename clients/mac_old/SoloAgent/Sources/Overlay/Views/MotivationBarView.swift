import SwiftUI
import AppKit/// 动机进度条 (Motivation Progress Bar)
/// 符合“生命之火”的电影感设计：分层能量槽、流动辉光和物理质感弹簧动画。
struct MotivationBarView: View {
    let title: String
    let level: Int
    let progress: CGFloat // 0.0 to 1.0
    let coreColor: Color
    
    // 控制动画状态
    @State private var animatedProgress: CGFloat = 0.0
    @State private var glowPulse: Bool = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Header: 标题和等级
            HStack(alignment: .bottom) {
                Text(title)
                    .font(NeonBrutalismTheme.captionFont)
                    .foregroundColor(NeonBrutalismTheme.textPrimary)
                    .shadow(color: coreColor.opacity(0.5), radius: 3)
                
                Spacer()
                
                Text("Lv.\(level)")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundColor(coreColor)
                    .shadow(color: coreColor.opacity(0.8), radius: 4)
            }
            
            // 能量槽本身
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    // 底层：暗影轨道
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.white.opacity(0.05))
                        .shadow(color: .black.opacity(0.5), radius: 2, x: 0, y: 1)
                    
                    // 中层：彩色能量核心
                    RoundedRectangle(cornerRadius: 4)
                        .fill(
                            LinearGradient(
                                colors: [
                                    coreColor.opacity(0.6),
                                    coreColor
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: max(0, geo.size.width * animatedProgress))
                        // 脉冲发光效果
                        .shadow(color: coreColor.opacity(glowPulse ? 0.8 : 0.4), radius: glowPulse ? 8 : 4)
                    
                    // 顶层：流动的高亮辉光 (附加在末端)
                    if animatedProgress > 0.05 {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.white.opacity(0.8))
                            .frame(width: 4)
                            .offset(x: max(0, geo.size.width * animatedProgress) - 4)
                            .blur(radius: 1)
                            .blendMode(.plusLighter)
                    }
                }
            }
            .frame(height: 8)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(
                // 玻璃态微弱边框
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color.white.opacity(0.1), lineWidth: 0.5)
            )
        }
        .onAppear {
            // 初始入场弹簧动画
            withAnimation(.spring(response: 0.5, dampingFraction: 0.6)) {
                self.animatedProgress = progress
            }
            
            // 启动外发光的周期呼吸效果 (TimelineView 也可，这里使用重复的 withAnimation 更轻量)
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                self.glowPulse.toggle()
            }
        }
        .onChange(of: progress) { newValue in
            // 当经验增加时，瞬间扩张的弹簧感
            if newValue >= 1.0 && animatedProgress < 1.0 {
                triggerGlowBurst()
            }
            withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) {
                self.animatedProgress = newValue
            }
        }
        .onChange(of: level) { newLevel in
            triggerGlowBurst()
        }
    }
    
    private func triggerGlowBurst() {
        let burstLayer = NSWindow() // This triggers the UI if run as raw effect, but let's use a simple State in SwiftUI
        // We will trigger a bright flash then fade
        withAnimation(.easeInOut(duration: 0.1)) {
            self.glowPulse = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            withAnimation(.easeOut(duration: 0.8)) {
                self.glowPulse = false
            }
            // 重新启动正常的心跳
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                    self.glowPulse.toggle()
                }
            }
        }
    }
}

#Preview("MotivationBar") {
    VStack(spacing: 16) {
        MotivationBarView(title: "系统权限解锁", level: 7, progress: 0.72, coreColor: NeonBrutalismTheme.expGreen)
        MotivationBarView(title: "UI 框架重构", level: 3, progress: 0.45, coreColor: NeonBrutalismTheme.electricBlue)
        MotivationBarView(title: "商业化探索", level: 1, progress: 0.15, coreColor: NeonBrutalismTheme.shadowPurple)
        MotivationBarView(title: "即将完成", level: 9, progress: 1.0, coreColor: NeonBrutalismTheme.dangerRed)
    }
    .padding(20)
    .frame(width: 220)
    .background(
        ZStack {
            VisualEffectBackground(material: NSVisualEffectView.Material.hudWindow, blendingMode: NSVisualEffectView.BlendingMode.behindWindow, state: NSVisualEffectView.State.active)
            NeonBrutalismTheme.background.opacity(0.85)
        }
    )
}
