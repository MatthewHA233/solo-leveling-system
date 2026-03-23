import AppKit
import SwiftUI

// MARK: - DraggableHostingView

/// NSHostingView 子类 — 禁用 isMovableByWindowBackground 的事件拦截，手动实现拖拽
/// 这样 SwiftUI 的 onTapGesture 才能正常接收点击事件
private class DraggableHostingView<Content: View>: NSHostingView<Content> {
    override var mouseDownCanMoveWindow: Bool { false }

    private var dragStartMousePos: NSPoint = .zero
    private var dragStartWindowOrigin: NSPoint = .zero

    override func mouseDown(with event: NSEvent) {
        dragStartMousePos = NSEvent.mouseLocation
        dragStartWindowOrigin = window?.frame.origin ?? .zero
        super.mouseDown(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window = self.window else {
            super.mouseDragged(with: event)
            return
        }
        let current = NSEvent.mouseLocation
        let newOrigin = NSPoint(
            x: dragStartWindowOrigin.x + current.x - dragStartMousePos.x,
            y: dragStartWindowOrigin.y + current.y - dragStartMousePos.y
        )
        window.setFrameOrigin(newOrigin)
        super.mouseDragged(with: event)
    }
}

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
    private var consciousnessPanel: HolographicPanel?

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
            // 不用 isMovableByWindowBackground（会拦截 SwiftUI tap 事件）
            // 改用 DraggableHostingView 手动实现拖拽
            panel.contentView = DraggableHostingView(rootView: content)
            miniBarPanel = panel
        } else {
            miniBarPanel?.contentView = DraggableHostingView(rootView: content)
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

    // MARK: - Consciousness View

    func showConsciousness<Content: View>(content: Content) {
        if consciousnessPanel == nil {
            let screen = NSScreen.main ?? NSScreen.screens.first!
            let width: CGFloat = 380
            let height: CGFloat = 500  // 额外空间给主动询问气泡
            let x = screen.visibleFrame.midX - width / 2
            let y = screen.visibleFrame.midY - height / 2 + 40  // 稍上移，fairy 居中

            let panel = HolographicPanel(contentRect: NSRect(
                x: x, y: y, width: width, height: height
            ))
            panel.ignoresMouseEvents = true // 必须穿透鼠标事件
            panel.contentView = NSHostingView(rootView: content)
            consciousnessPanel = panel
        } else {
            consciousnessPanel?.contentView = NSHostingView(rootView: content)
        }

        consciousnessPanel?.orderFrontRegardless()
    }

    func hideConsciousness() {
        consciousnessPanel?.orderOut(nil)
        consciousnessPanel = nil
    }

    // MARK: - Cleanup

    func closeAll() {
        miniBarPanel?.orderOut(nil)
        miniBarPanel = nil
        notificationPanel?.orderOut(nil)
        notificationPanel = nil
        consciousnessPanel?.orderOut(nil)
        consciousnessPanel = nil
    }
}
