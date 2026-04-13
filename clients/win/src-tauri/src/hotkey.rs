// ══════════════════════════════════════════════
// hotkey.rs — Windows 全局键盘钩子
// 监听 Right Alt 按下/抬起，emit Tauri 事件
// 不拦截按键（透明钩子），仅旁路通知前端
// ══════════════════════════════════════════════

use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_RMENU;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW,
    KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
    WM_SYSKEYDOWN, WM_SYSKEYUP,
};

// 全局存储 AppHandle（hook 回调是 C 函数指针，无法捕获状态）
static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        if kb.vkCode == VK_RMENU as u32 {
            if let Some(app) = APP.get() {
                match wparam as u32 {
                    WM_SYSKEYDOWN => { let _ = app.emit("ralt-keydown", ()); }
                    WM_SYSKEYUP   => { let _ = app.emit("ralt-keyup", ()); }
                    _ => {}
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// 启动全局右 Alt 热键监听（在独立线程中运行消息泵）
pub fn install(app: AppHandle) {
    if APP.set(app).is_err() {
        log::warn!("[Hotkey] AppHandle 已设置，跳过重复安装");
        return;
    }

    std::thread::Builder::new()
        .name("hotkey-pump".into())
        .spawn(|| unsafe {
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0);
            if hook == std::ptr::null_mut() {
                log::error!("[Hotkey] SetWindowsHookExW 失败");
                return;
            }
            log::info!("[Hotkey] 全局右 Alt 钩子已安装");

            // 消息泵：让 Windows 把键盘事件派发给 hook_proc
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) != 0 {}
        })
        .expect("hotkey thread spawn failed");
}
