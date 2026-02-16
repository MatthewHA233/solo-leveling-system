import Foundation
import UserNotifications

/// 系统通知服务 — 显示来自服务器的推送
class NotificationService: NSObject {
    
    private let center = UNUserNotificationCenter.current()
    
    // MARK: - Permission
    
    /// 请求通知权限
    func requestPermission() async {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            if granted {
                Logger.info("🔔 通知权限已获取")
            } else {
                Logger.warning("⚠️ 通知权限被拒绝")
            }
            
            // 设置 delegate
            center.delegate = self
        } catch {
            Logger.error("通知权限请求失败: \(error)")
        }
    }
    
    // MARK: - Show Notification
    
    /// 显示一条系统通知
    func show(_ notification: ServerNotification) {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = soundForPriority(notification.priority)
        
        // 添加操作按钮
        if let actions = notification.actions, !actions.isEmpty {
            let categoryId = "QUEST_\(notification.questId ?? "default")"
            let notificationActions = actions.enumerated().map { index, title in
                UNNotificationAction(
                    identifier: "action_\(index)",
                    title: title,
                    options: index == 0 ? [.foreground] : []
                )
            }
            let category = UNNotificationCategory(
                identifier: categoryId,
                actions: notificationActions,
                intentIdentifiers: [],
                options: []
            )
            center.setNotificationCategories([category])
            content.categoryIdentifier = categoryId
        }
        
        // 创建触发器 (立即)
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        
        center.add(request) { error in
            if let error = error {
                Logger.error("通知发送失败: \(error)")
            }
        }
    }
    
    /// 显示简单通知 (本地触发)
    func showSimple(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        
        center.add(request)
    }
    
    // MARK: - Helpers
    
    private func soundForPriority(_ priority: String?) -> UNNotificationSound {
        switch priority {
        case "urgent": return .defaultCritical
        case "high": return .default
        default: return .default
        }
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationService: UNUserNotificationCenterDelegate {
    /// 前台时也显示通知
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .sound]
    }
    
    /// 用户点击通知
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let actionId = response.actionIdentifier
        Logger.info("👆 通知操作: \(actionId)")
        
        // TODO: 处理用户对任务通知的响应 (接受/拒绝)
    }
}
