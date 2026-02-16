import Foundation
import AppKit
import CoreGraphics

/// 窗口和应用监控服务
class WindowMonitorService {
    
    // MARK: - Current State
    
    /// 当前前台窗口信息
    private(set) var currentWindowInfo: WindowInfo = .empty
    
    /// 用户空闲秒数
    private(set) var idleSeconds: TimeInterval = 0
    
    /// 屏幕是否锁定
    private(set) var isScreenLocked: Bool = false
    
    /// 当前活动状态
    var currentActivityState: CaptureStrategy.ActivityState {
        let strategy = CaptureStrategy()
        return strategy.inferState(
            idleSeconds: idleSeconds,
            isScreenLocked: isScreenLocked,
            windowJustSwitched: recentWindowSwitch
        )
    }
    
    /// 窗口切换回调
    var onWindowSwitch: ((WindowInfo, WindowInfo) -> Void)?
    
    // MARK: - Internal
    
    private var pollingTimer: Timer?
    private var previousBundleId: String?
    private var recentWindowSwitch: Bool = false
    private var windowSwitchResetTask: Task<Void, Never>?
    
    // MARK: - Monitoring
    
    /// 开始监控
    func startMonitoring() {
        Logger.info("👁️ 开始窗口监控")
        
        // 监听前台应用切换
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(activeAppDidChange(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        
        // 监听屏幕锁定/解锁
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(screenLocked),
            name: NSNotification.Name("com.apple.screenIsLocked"),
            object: nil
        )
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(screenUnlocked),
            name: NSNotification.Name("com.apple.screenIsUnlocked"),
            object: nil
        )
        
        // 定时轮询空闲状态和窗口标题
        pollingTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.pollState()
        }
        
        // 初始状态
        pollState()
    }
    
    /// 停止监控
    func stopMonitoring() {
        pollingTimer?.invalidate()
        pollingTimer = nil
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        DistributedNotificationCenter.default().removeObserver(self)
        Logger.info("👁️ 停止窗口监控")
    }
    
    // MARK: - Polling
    
    private func pollState() {
        // 更新空闲时间
        idleSeconds = getSystemIdleTime()
        
        // 更新窗口信息
        let newInfo = getFrontmostWindowInfo()
        if newInfo.bundleId != currentWindowInfo.bundleId || newInfo.windowTitle != currentWindowInfo.windowTitle {
            let old = currentWindowInfo
            currentWindowInfo = newInfo
            
            if old.bundleId != nil && old.bundleId != newInfo.bundleId {
                Logger.debug("🔄 窗口切换: \(old.appName ?? "?") → \(newInfo.appName ?? "?")")
            }
        }
    }
    
    // MARK: - System APIs
    
    /// 获取前台应用和窗口信息
    private func getFrontmostWindowInfo() -> WindowInfo {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return .empty
        }
        
        // 获取窗口标题 (通过 Accessibility API)
        let windowTitle = getWindowTitle(for: app)
        
        return WindowInfo(
            appName: app.localizedName,
            bundleId: app.bundleIdentifier,
            windowTitle: windowTitle,
            processId: Int(app.processIdentifier)
        )
    }
    
    /// 通过 Accessibility API 获取窗口标题
    private func getWindowTitle(for app: NSRunningApplication) -> String? {
        let pid = app.processIdentifier
        let appRef = AXUIElementCreateApplication(pid)
        
        var windowValue: AnyObject?
        let result = AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute as CFString, &windowValue)
        
        guard result == .success, let window = windowValue else { return nil }
        
        var titleValue: AnyObject?
        let titleResult = AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &titleValue)
        
        guard titleResult == .success, let title = titleValue as? String else { return nil }
        return title
    }
    
    /// 获取系统空闲时间 (自上次键盘/鼠标输入)
    private func getSystemIdleTime() -> TimeInterval {
        var iter: io_iterator_t = 0
        defer { IOObjectRelease(iter) }
        
        guard IOServiceGetMatchingServices(kIOMainPortDefault,
                                           IOServiceMatching("IOHIDSystem"),
                                           &iter) == KERN_SUCCESS else {
            return 0
        }
        
        let entry = IOIteratorNext(iter)
        defer { IOObjectRelease(entry) }
        guard entry != 0 else { return 0 }
        
        var idleTimeRef: Unmanaged<CFTypeRef>?
        guard IORegistryEntryCreateCFProperty(entry, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0) != nil else {
            return 0
        }
        
        if let ref = IORegistryEntryCreateCFProperty(entry, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0) {
            let idleTime = ref.takeRetainedValue() as! NSNumber
            return idleTime.doubleValue / 1_000_000_000  // 纳秒 → 秒
        }
        
        return 0
    }
    
    // MARK: - Notification Handlers
    
    @objc private func activeAppDidChange(_ notification: Notification) {
        let oldInfo = currentWindowInfo
        pollState()
        
        // 标记窗口切换
        recentWindowSwitch = true
        windowSwitchResetTask?.cancel()
        windowSwitchResetTask = Task {
            try? await Task.sleep(for: .seconds(5))
            self.recentWindowSwitch = false
        }
        
        onWindowSwitch?(oldInfo, currentWindowInfo)
    }
    
    @objc private func screenLocked() {
        isScreenLocked = true
        Logger.debug("🔒 屏幕已锁定")
    }
    
    @objc private func screenUnlocked() {
        isScreenLocked = false
        Logger.debug("🔓 屏幕已解锁")
    }
}
