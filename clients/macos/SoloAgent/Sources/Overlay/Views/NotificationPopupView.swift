import SwiftUI

/// 浮动通知 toast — 右上角弹出 — Neon Brutalism
struct NotificationPopupView: View {
    let title: String
    let message: String

    var body: some View {
        HStack(spacing: 10) {
            // Icon
            Image(systemName: "bell.badge.fill")
                .font(.system(size: 14))
                .foregroundColor(NeonBrutalismTheme.electricBlue)
                .shadow(color: NeonBrutalismTheme.electricBlue.opacity(0.6), radius: 4)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(NeonBrutalismTheme.titleFont)
                    .foregroundColor(NeonBrutalismTheme.textPrimary)
                    .lineLimit(1)

                if !message.isEmpty {
                    Text(message)
                        .font(NeonBrutalismTheme.captionFont)
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                        .lineLimit(2)
                }
            }

            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(width: 320)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(NeonBrutalismTheme.background.opacity(0.95))
                RoundedRectangle(cornerRadius: 10)
                    .fill(.ultraThinMaterial.opacity(0.15))
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(NeonBrutalismTheme.borderGradient, lineWidth: 0.5)
        )
        .shadow(color: NeonBrutalismTheme.electricBlue.opacity(0.25), radius: 16)
        .overlay(NeonScanlineOverlay().clipShape(RoundedRectangle(cornerRadius: 10)))
    }
}

#Preview("通知弹窗") {
    VStack(spacing: 8) {
        NotificationPopupView(title: "+25 EXP", message: "专注编程 30 分钟，效率极高")
        NotificationPopupView(title: "新任务", message: "完成 SoloAgent 昼夜表设计")
    }
    .padding(20)
    .background(Color.black)
}
