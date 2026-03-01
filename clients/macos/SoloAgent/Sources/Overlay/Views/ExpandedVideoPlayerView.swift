import SwiftUI
import AVKit

/// 展开的视频播放器 — 替换昼夜表显示在中心区域
struct ExpandedVideoPlayerView: View {
    let player: AVPlayer
    let batchId: String
    var onCollapse: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                HStack(spacing: 4) {
                    Image(systemName: "film")
                        .font(.system(size: 11))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                    Text("延时影像")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                }

                Spacer()

                Button(action: onCollapse) {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.down.right.and.arrow.up.left")
                            .font(.system(size: 10))
                        Text("收起")
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                    }
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(NeonBrutalismTheme.electricBlue.opacity(0.06))
                            .overlay(
                                RoundedRectangle(cornerRadius: 4)
                                    .strokeBorder(NeonBrutalismTheme.electricBlue.opacity(0.15), lineWidth: 0.5)
                            )
                    )
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    if hovering { NSCursor.pointingHand.push() }
                    else { NSCursor.pop() }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            NeonDivider(.horizontal)

            // Video player — full center, interactive
            InlineVideoPlayer(player: player, controlsStyle: .inline)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)

            NeonDivider(.horizontal)

            // Bottom info bar
            HStack {
                Text("批次")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textSecondary)
                Text(batchId)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.textPrimary)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
        }
        .background(NeonBrutalismTheme.background)
    }
}
