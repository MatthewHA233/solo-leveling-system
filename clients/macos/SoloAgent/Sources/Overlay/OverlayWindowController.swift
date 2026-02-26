import AppKit
import SwiftUI

// MARK: - HolographicPanel

/// 全息悬浮面板 — 透明、不抢焦点、排除截图捕获
class HolographicPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        isOpaque = false
        backgroundColor = .clear
        level = .floating
        hasShadow = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        sharingType = .none  // Exclude from screenshot capture
        isMovableByWindowBackground = false
        hidesOnDeactivate = false
    }
}

// MARK: - OverlayWindowController

/// 管理浮动面板（迷你条 + 通知）— 全域网监控已迁移到标准窗口
@MainActor
final class OverlayWindowController {

    private var miniBarPanel: HolographicPanel?
    private var notificationPanel: HolographicPanel?

    // MARK: - Mini Status Bar

    func showMiniBar<Content: View>(content: Content) {
        if miniBarPanel == nil {
            let screen = NSScreen.main ?? NSScreen.screens.first!
            let barSize = NeonBrutalismTheme.miniBarSize
            let x = screen.visibleFrame.maxX - barSize.width - 8
            let y = screen.visibleFrame.midY - barSize.height / 2

            let panel = HolographicPanel(contentRect: NSRect(
                x: x, y: y, width: barSize.width, height: barSize.height
            ))
            panel.isMovableByWindowBackground = true
            panel.contentView = NSHostingView(rootView: content)
            miniBarPanel = panel
        } else {
            miniBarPanel?.contentView = NSHostingView(rootView: content)
        }

        miniBarPanel?.orderFrontRegardless()
    }

    func hideMiniBar() {
        miniBarPanel?.orderOut(nil)
    }

    var isMiniBarVisible: Bool {
        miniBarPanel?.isVisible ?? false
    }

    // MARK: - Notification Window

    func showNotification<Content: View>(content: Content) {
        let hostingView = NSHostingView(rootView: content)

        if let panel = notificationPanel {
            // Reuse existing panel — just swap content
            panel.contentView = hostingView
            panel.orderFrontRegardless()
        } else {
            let screen = NSScreen.main ?? NSScreen.screens.first!
            let width: CGFloat = 320
            let height: CGFloat = 260   // room for up to 3 stacked
            let x = screen.visibleFrame.maxX - width - 16
            let y = screen.visibleFrame.maxY - height - 16

            let panel = HolographicPanel(contentRect: NSRect(
                x: x, y: y, width: width, height: height
            ))
            panel.contentView = hostingView
            panel.orderFrontRegardless()
            notificationPanel = panel
        }
    }

    func hideNotification() {
        notificationPanel?.orderOut(nil)
        notificationPanel = nil
    }

    // MARK: - Cleanup

    func closeAll() {
        miniBarPanel?.orderOut(nil)
        miniBarPanel = nil
        notificationPanel?.orderOut(nil)
        notificationPanel = nil
    }
}
