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

/// 管理全息悬浮窗的创建和生命周期
@MainActor
final class OverlayWindowController {

    private var miniBarPanel: HolographicPanel?
    private var fullPanel: HolographicPanel?
    private var notificationPanel: HolographicPanel?

    // MARK: - Mini Status Bar

    func showMiniBar<Content: View>(content: Content) {
        if miniBarPanel == nil {
            let screen = NSScreen.main ?? NSScreen.screens.first!
            let barSize = HolographicTheme.miniBarSize
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

    // MARK: - Full Overlay

    func showFullPanel<Content: View>(content: Content) {
        if fullPanel == nil {
            let screen = NSScreen.main ?? NSScreen.screens.first!
            let panelSize = HolographicTheme.fullPanelSize
            let x = screen.visibleFrame.maxX - panelSize.width - 20
            let y = screen.visibleFrame.midY - panelSize.height / 2

            let panel = HolographicPanel(contentRect: NSRect(
                x: x, y: y, width: panelSize.width, height: panelSize.height
            ))
            panel.contentView = NSHostingView(rootView: content)
            fullPanel = panel
        } else {
            fullPanel?.contentView = NSHostingView(rootView: content)
        }

        fullPanel?.orderFrontRegardless()
    }

    func hideFullPanel() {
        fullPanel?.orderOut(nil)
    }

    var isFullPanelVisible: Bool {
        fullPanel?.isVisible ?? false
    }

    func toggleFullPanel<Content: View>(content: @autoclosure () -> Content) {
        if isFullPanelVisible {
            hideFullPanel()
        } else {
            showFullPanel(content: content())
        }
    }

    // MARK: - Notification Window

    func showNotification<Content: View>(content: Content) {
        let screen = NSScreen.main ?? NSScreen.screens.first!
        let width: CGFloat = 320
        let height: CGFloat = 80
        let x = screen.visibleFrame.maxX - width - 16
        let y = screen.visibleFrame.maxY - height - 16

        let panel = HolographicPanel(contentRect: NSRect(
            x: x, y: y, width: width, height: height
        ))
        panel.contentView = NSHostingView(rootView: content)
        panel.orderFrontRegardless()

        notificationPanel = panel
    }

    func hideNotification() {
        notificationPanel?.orderOut(nil)
        notificationPanel = nil
    }

    // MARK: - Cleanup

    func closeAll() {
        miniBarPanel?.orderOut(nil)
        miniBarPanel = nil
        fullPanel?.orderOut(nil)
        fullPanel = nil
        notificationPanel?.orderOut(nil)
        notificationPanel = nil
    }
}
