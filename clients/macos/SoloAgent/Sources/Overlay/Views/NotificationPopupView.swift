import SwiftUI

/// 浮动通知 toast — 右上角弹出
struct NotificationPopupView: View {
    let title: String
    let message: String

    var body: some View {
        HStack(spacing: 10) {
            // Icon
            Image(systemName: "bell.badge.fill")
                .font(.system(size: 14))
                .foregroundColor(HolographicTheme.primaryBlue)
                .shadow(color: HolographicTheme.primaryBlue.opacity(0.6), radius: 4)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(HolographicTheme.titleFont)
                    .foregroundColor(HolographicTheme.textPrimary)
                    .lineLimit(1)

                if !message.isEmpty {
                    Text(message)
                        .font(HolographicTheme.captionFont)
                        .foregroundColor(HolographicTheme.textSecondary)
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
                    .fill(HolographicTheme.panelBackground.opacity(0.9))
                RoundedRectangle(cornerRadius: 10)
                    .fill(.ultraThinMaterial.opacity(0.2))
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(HolographicTheme.borderGradient, lineWidth: 0.5)
        )
        .shadow(color: HolographicTheme.primaryBlue.opacity(0.25), radius: 16)
        .overlay(ScanlineOverlay().clipShape(RoundedRectangle(cornerRadius: 10)))
    }
}
