import SwiftUI

/// 高层协调器 — 管理迷你条/全屏覆盖/通知弹窗的显隐
@MainActor
final class OverlayManager: ObservableObject {
    static let shared = OverlayManager()

    @Published var isFullOverlayVisible = false
    @Published var isMiniBarVisible = true

    let windowController = OverlayWindowController()
    let hotkeyManager = HotkeyManager()

    private var notificationQueue: [(id: UUID, title: String, body: String)] = []

    private init() {}

    // MARK: - Setup

    func setup(agentManager: AgentManager) {
        // Register hotkey
        hotkeyManager.onToggle = { [weak self] in
            self?.toggleFullOverlay(agentManager: agentManager)
        }
        hotkeyManager.register()

        // Show mini bar
        if agentManager.config.overlayEnabled {
            showMiniBar(agentManager: agentManager)
        }

        // Listen for game events that should trigger notifications
        agentManager.gameEventBus.on(.levelUp) { [weak self] event in
            let level = event.data["new_level"] as? Int ?? 0
            let msg = SystemMessages.getMessage(category: "level_up")
            self?.pushNotification(title: "Lv.\(level)", body: msg)
        }

        agentManager.gameEventBus.on(.questTriggered) { [weak self] event in
            let title = event.data["quest_title"] as? String ?? "新任务"
            let type = event.data["quest_type"] as? String ?? "side"
            let msg = SystemMessages.getMessage(category: "quest_trigger", subcategory: type)
            self?.pushNotification(title: title, body: msg)
        }

        agentManager.gameEventBus.on(.questCompleted) { [weak self] event in
            let exp = event.data["exp_earned"] as? Int ?? 0
            let msg = SystemMessages.getMessage(category: "quest_complete")
            self?.pushNotification(title: "+\(exp) EXP", body: msg)
        }

        agentManager.gameEventBus.on(.questFailed) { [weak self] event in
            let msg = SystemMessages.getMessage(category: "quest_fail")
            self?.pushNotification(title: "任务失败", body: msg)
        }

        agentManager.gameEventBus.on(.notificationPush) { [weak self] event in
            let title = event.data["title"] as? String ?? ""
            let body = event.data["message"] as? String ?? event.data["body"] as? String ?? ""
            if !title.isEmpty {
                self?.pushNotification(title: title, body: body)
            }
        }

        Logger.info("🎮 OverlayManager 已初始化")
    }

    // MARK: - Mini Bar

    func showMiniBar(agentManager: AgentManager) {
        let view = MiniStatusBarView(agentManager: agentManager)
        windowController.showMiniBar(content: view)
        isMiniBarVisible = true
    }

    func hideMiniBar() {
        windowController.hideMiniBar()
        isMiniBarVisible = false
    }

    // MARK: - Full Overlay

    func toggleFullOverlay(agentManager: AgentManager) {
        if isFullOverlayVisible {
            hideFullOverlay()
        } else {
            showFullOverlay(agentManager: agentManager)
        }
    }

    func showFullOverlay(agentManager: AgentManager) {
        let view = UnifiedSystemView(agentManager: agentManager) { [weak self] in
            self?.hideFullOverlay()
        }
        windowController.showFullPanel(content: view)
        isFullOverlayVisible = true
    }

    func hideFullOverlay() {
        windowController.hideFullPanel()
        isFullOverlayVisible = false
    }

    // MARK: - Notifications

    func pushNotification(title: String, body: String) {
        let id = UUID()
        notificationQueue.append((id: id, title: title, body: body))

        // Keep max 3 stacked
        if notificationQueue.count > 3 {
            notificationQueue.removeFirst()
        }

        updateNotificationDisplay()
        // Auto-dismiss is handled by SwiftUI .task in NotificationStackView
    }

    private func dismissNotification(id: UUID) {
        notificationQueue.removeAll { $0.id == id }
        if notificationQueue.isEmpty {
            windowController.hideNotification()
        } else {
            updateNotificationDisplay()
        }
    }

    private func updateNotificationDisplay() {
        let items = notificationQueue
        let view = NotificationStackView(items: items) { [weak self] id in
            self?.dismissNotification(id: id)
        }
        windowController.showNotification(content: view)
    }

    // MARK: - Cleanup

    func shutdown() {
        hotkeyManager.unregister()
        windowController.closeAll()
    }
}

// MARK: - Notification Stack Helper View

private struct NotificationStackView: View {
    let items: [(id: UUID, title: String, body: String)]
    let onDismiss: (UUID) -> Void

    var body: some View {
        VStack(spacing: 4) {
            ForEach(items, id: \.id) { item in
                NotificationPopupView(title: item.title, message: item.body)
                    .onTapGesture { onDismiss(item.id) }
                    .pointingHand()
                    .task(id: item.id) {
                        try? await Task.sleep(for: .seconds(5))
                        onDismiss(item.id)
                    }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
    }
}
