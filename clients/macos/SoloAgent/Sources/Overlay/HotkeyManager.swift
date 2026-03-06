import AppKit

/// 全局快捷键管理 — ⌘⇧S 切换全息覆盖层 + 右Cmd长按语音
@MainActor
final class HotkeyManager {
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var flagsGlobalMonitor: Any?
    private var flagsLocalMonitor: Any?
    var onToggle: (() -> Void)?

    // MARK: - Voice Hotkey (右 Command 长按)
    var onVoiceStart: (() -> Void)?
    var onVoiceStop: (() -> Void)?

    private var rightCmdPressTime: Date?
    private var voiceTimer: Timer?
    private var voiceActivated = false

    func register() {
        // Global monitor (when app is not focused)
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleKeyEvent(event)
        }

        // Local monitor (when app is focused)
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if self?.handleKeyEvent(event) == true {
                return nil // Consume event
            }
            return event
        }

        // 右 Command 长按检测 — flagsChanged 事件
        flagsGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
        }

        flagsLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
            return event
        }
    }

    func unregister() {
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
            self.localMonitor = nil
        }
        if let flagsGlobalMonitor {
            NSEvent.removeMonitor(flagsGlobalMonitor)
            self.flagsGlobalMonitor = nil
        }
        if let flagsLocalMonitor {
            NSEvent.removeMonitor(flagsLocalMonitor)
            self.flagsLocalMonitor = nil
        }
        voiceTimer?.invalidate()
        voiceTimer = nil
    }

    @discardableResult
    private func handleKeyEvent(_ event: NSEvent) -> Bool {
        // ⌘⇧S = Command + Shift + S
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == [.command, .shift] && event.charactersIgnoringModifiers == "s" {
            Task { @MainActor in
                self.onToggle?()
            }
            return true
        }
        return false
    }

    // MARK: - Right Command Detection

    private func handleFlagsChanged(_ event: NSEvent) {
        // keyCode 54 = 右 Command
        let isRightCmd = event.keyCode == 54

        if isRightCmd && event.modifierFlags.contains(.command) {
            // 右 Cmd 按下
            if rightCmdPressTime == nil {
                rightCmdPressTime = Date()
                voiceTimer?.invalidate()
                voiceTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: false) { [weak self] _ in
                    Task { @MainActor [weak self] in
                        guard let self, self.rightCmdPressTime != nil else { return }
                        self.voiceActivated = true
                        self.onVoiceStart?()
                    }
                }
            }
        } else if isRightCmd || (!event.modifierFlags.contains(.command) && rightCmdPressTime != nil) {
            // 右 Cmd 松开
            voiceTimer?.invalidate()
            voiceTimer = nil
            rightCmdPressTime = nil

            if voiceActivated {
                voiceActivated = false
                Task { @MainActor in
                    self.onVoiceStop?()
                }
            }
        }
    }

    deinit {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let flagsGlobalMonitor { NSEvent.removeMonitor(flagsGlobalMonitor) }
        if let flagsLocalMonitor { NSEvent.removeMonitor(flagsLocalMonitor) }
        voiceTimer?.invalidate()
    }
}
