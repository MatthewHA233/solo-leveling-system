// ══════════════════════════════════════════════
// hotkey.rs — Windows 全局键盘钩子
// 监听 Right Alt 按下/抬起，emit Tauri 事件
//
// 设计要点：
//   WH_KEYBOARD_LL 钩子回调必须在 ~300ms 内返回，否则 Windows 会
//   自动移除钩子。因此回调只写 channel，由独立线程负责 emit。
// ══════════════════════════════════════════════

use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use tauri::{AppHandle, Emitter};

use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_RMENU;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW,
    KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
    WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

// ── 全局状态 ──

static APP: OnceLock<AppHandle> = OnceLock::new();

// 事件通道发送端（只在钩子线程写，不 block）
static TX: OnceLock<std::sync::Mutex<std::sync::mpsc::SyncSender<bool>>> = OnceLock::new();

// 防重复：上一次状态
static LAST_DOWN: AtomicBool = AtomicBool::new(false);

// ── 钩子回调（必须极快返回）──

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        if kb.vkCode == VK_RMENU as u32 {
            let is_down = matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let is_up   = matches!(wparam as u32, WM_KEYUP   | WM_SYSKEYUP);

            // 防抖：只在状态变化时发送
            if is_down && !LAST_DOWN.swap(true, Ordering::Relaxed) {
                if let Some(lock) = TX.get() {
                    if let Ok(tx) = lock.lock() {
                        let _ = tx.try_send(true);
                    }
                }
            } else if is_up && LAST_DOWN.swap(false, Ordering::Relaxed) {
                if let Some(lock) = TX.get() {
                    if let Ok(tx) = lock.lock() {
                        let _ = tx.try_send(false);
                    }
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// 启动全局右 Alt 热键监听
pub fn install(app: AppHandle) {
    if APP.set(app.clone()).is_err() {
        log::warn!("[Hotkey] 已安装，跳过");
        return;
    }

    // 同步 channel：容量 4，钩子不阻塞
    let (tx, rx) = std::sync::mpsc::sync_channel::<bool>(4);
    TX.set(std::sync::Mutex::new(tx)).ok();

    // 派发线程：把 channel 消息转成 Tauri 事件
    let app_emit = app.clone();
    std::thread::Builder::new()
        .name("hotkey-emit".into())
        .spawn(move || {
            while let Ok(is_down) = rx.recv() {
                if is_down {
                    log::debug!("[Hotkey] ralt-keydown");
                    let _ = app_emit.emit("ralt-keydown", ());
                } else {
                    log::debug!("[Hotkey] ralt-keyup");
                    let _ = app_emit.emit("ralt-keyup", ());
                }
            }
        })
        .expect("hotkey emit thread spawn failed");

    // 钩子线程：安装 WH_KEYBOARD_LL + 消息泵
    std::thread::Builder::new()
        .name("hotkey-pump".into())
        .spawn(|| unsafe {
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0);
            if hook.is_null() {
                log::error!("[Hotkey] SetWindowsHookExW 失败");
                return;
            }
            log::info!("[Hotkey] 全局右 Alt 钩子已安装");

            let mut msg: MSG = std::mem::zeroed();
            // GetMessageW 返回 0 表示 WM_QUIT，-1 表示错误，都退出
            loop {
                let ret = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
                if ret == 0 || ret == -1 {
                    log::warn!("[Hotkey] 消息泵退出 ret={}", ret);
                    break;
                }
            }
            log::error!("[Hotkey] 消息泵意外退出，钩子已失效");
        })
        .expect("hotkey pump thread spawn failed");
}
