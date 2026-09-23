//! 音量合成器显示名修正（仅 Windows）
//!
//! 问题：WebView2 的声音由子进程 msedgewebview2.exe 发出，而 WebView2 从不给自己的
//! 音频会话设显示名，Windows 只好回落到该进程的文件描述「Microsoft Edge WebView2」。
//! 微软侧长期未修（WebView2Feedback #2236 / tauri #11113）；给宿主进程设
//! AppUserModelID 也无效——它命名的是宿主进程，而会话属于子进程。
//!
//! 做法：用 Core Audio 枚举所有活动输出设备上的音频会话，凡是属于本进程或其子孙进程的，
//! 把显示名和图标改成 Solevup。音频会话只在播放时才存在，所以低频轮询，而不是启动时设一次。

use std::collections::HashMap;
use std::time::Duration;

use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};

/// 轮询间隔：会话随播放才出现，3 秒内改名足够及时，开销可忽略
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// 沿父进程链最多向上找几层（宿主 → WebView2 browser → 音频 utility，实际约 2 层）
const MAX_ANCESTOR_DEPTH: usize = 8;

/// 启动后台改名线程。`display_name` 用 productName（Solevup），图标取自身 exe。
pub fn spawn(display_name: String) {
    let spawned = std::thread::Builder::new()
        .name("audio-session-name".into())
        .spawn(move || run(display_name));
    if let Err(e) = spawned {
        log::warn!("[AudioSessionName] 启动线程失败: {e}");
    }
}

fn run(display_name: String) {
    // COM 必须在本线程初始化；MTA 下无需消息泵
    if let Err(e) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
        log::warn!("[AudioSessionName] CoInitializeEx 失败，放弃改名: {e}");
        return;
    }

    let name = HSTRING::from(display_name.as_str());
    let icon = std::env::current_exe()
        .ok()
        .map(|exe| HSTRING::from(format!("{},0", exe.display())));
    let own_pid = std::process::id();
    let mut last_err: Option<String> = None;

    loop {
        match rename_owned_sessions(own_pid, &display_name, &name, icon.as_ref()) {
            Ok(renamed) => {
                if renamed > 0 {
                    log::info!("[AudioSessionName] 已把 {renamed} 个音频会话改名为「{display_name}」");
                }
                last_err = None;
            }
            Err(e) => {
                // 同一个错误只记一次，避免每 3 秒刷屏
                let msg = e.to_string();
                if last_err.as_deref() != Some(msg.as_str()) {
                    log::warn!("[AudioSessionName] 改名失败（相同错误不再重复记录）: {msg}");
                    last_err = Some(msg);
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 扫一遍所有活动输出设备，把属于本进程树、且名字还不对的会话改名。返回本次改名的会话数。
fn rename_owned_sessions(
    own_pid: u32,
    display_name: &str,
    name: &HSTRING,
    icon: Option<&HSTRING>,
) -> windows::core::Result<usize> {
    let parents = snapshot_parent_map();
    let mut renamed = 0;

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;

        for d in 0..devices.GetCount()? {
            // 单个设备出错（比如刚被拔掉）不影响其它设备
            let Ok(device) = devices.Item(d) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
            let Ok(count) = sessions.GetCount() else { continue };

            for s in 0..count {
                let Ok(control) = sessions.GetSession(s) else { continue };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
                let Ok(pid) = control2.GetProcessId() else { continue };
                if !is_self_or_descendant(pid, own_pid, &parents) {
                    continue;
                }
                if current_display_name(&control2).as_deref() == Some(display_name) {
                    continue; // 已经改过，别反复触发混音器的名称变更通知
                }
                if control2.SetDisplayName(PCWSTR(name.as_ptr()), std::ptr::null()).is_ok() {
                    renamed += 1;
                }
                if let Some(icon) = icon {
                    // 图标在混音器已打开时不会刷新，重开混音器才生效（Windows 行为）
                    let _ = control2.SetIconPath(PCWSTR(icon.as_ptr()), std::ptr::null());
                }
            }
        }
    }

    Ok(renamed)
}

/// 读会话当前显示名（COM 分配的字符串要 CoTaskMemFree）
unsafe fn current_display_name(control: &IAudioSessionControl2) -> Option<String> {
    let ptr = control.GetDisplayName().ok()?;
    if ptr.is_null() {
        return None;
    }
    let text = ptr.to_string().ok();
    CoTaskMemFree(Some(ptr.0 as *const _));
    text
}

/// pid 是否为 own_pid 本身或其子孙（沿父进程链向上找）
fn is_self_or_descendant(pid: u32, own_pid: u32, parents: &HashMap<u32, u32>) -> bool {
    let mut current = pid;
    for _ in 0..=MAX_ANCESTOR_DEPTH {
        if current == own_pid {
            return true;
        }
        match parents.get(&current) {
            Some(&parent) if parent != 0 && parent != current => current = parent,
            _ => return false,
        }
    }
    false
}

/// 全系统进程快照：pid → 父 pid
fn snapshot_parent_map() -> HashMap<u32, u32> {
    let mut parents = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return parents;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    parents
}
