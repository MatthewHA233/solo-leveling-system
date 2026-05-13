// ══════════════════════════════════════════════
// Windows 图形偏好（HKCU\SOFTWARE\Microsoft\DirectX\UserGpuPreferences）
//
// Windows 10/11 图形设置中"高性能"实际就是写一条 HKCU 下的 REG_SZ：
//   <exe 完整路径> = "GpuPreference=2;"   (1=节能, 2=高性能, 0=系统默认)
//
// HKCU 不需要管理员权限。Tauri 应用在 setup 阶段就能配好两条：
//   1) solo-agent.exe 自身
//   2) msedgewebview2.exe（WebView2 子进程，渲染实际跑这里——这条才是关键）
//
// msedgewebview2.exe 路径带版本号，我们从 EdgeUpdate Clients 注册表动态查最新版本。
// ══════════════════════════════════════════════

use serde::Serialize;

#[allow(unused_imports)]
use std::path::PathBuf;

const REG_KEY: &str = r"SOFTWARE\Microsoft\DirectX\UserGpuPreferences";
const HIGH_PERF_VALUE: &str = "GpuPreference=2;";

#[derive(Debug, Serialize, Clone)]
pub struct GpuPrefStatus {
    /// solo-agent.exe 的完整路径
    pub self_exe_path: String,
    /// solo-agent.exe 是否已写入"高性能"偏好
    pub self_exe_pref_set: bool,
    /// 检测到的 msedgewebview2.exe 完整路径（None 表示找不到，可能 WebView2 Runtime 未安装）
    pub webview2_path: Option<String>,
    /// msedgewebview2.exe 是否已写入"高性能"偏好
    pub webview2_pref_set: bool,
    /// 检测到的 Edge WebView 版本号
    pub edge_version: Option<String>,
}

#[cfg(windows)]
pub fn read_status() -> GpuPrefStatus {
    use winreg::enums::*;
    use winreg::RegKey;

    let self_exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let webview2 = find_webview2_path();
    let webview2_path = webview2.as_ref().map(|(p, _)| p.to_string_lossy().to_string());
    let edge_version = webview2.as_ref().map(|(_, v)| v.clone());

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.open_subkey(REG_KEY).ok();

    let self_exe_pref_set = key
        .as_ref()
        .and_then(|k| k.get_value::<String, _>(&self_exe).ok())
        .map(|v| v.contains("GpuPreference=2"))
        .unwrap_or(false);

    let webview2_pref_set = match (&key, &webview2_path) {
        (Some(k), Some(p)) => k
            .get_value::<String, _>(p)
            .map(|v| v.contains("GpuPreference=2"))
            .unwrap_or(false),
        _ => false,
    };

    GpuPrefStatus {
        self_exe_path: self_exe,
        self_exe_pref_set,
        webview2_path,
        webview2_pref_set,
        edge_version,
    }
}

#[cfg(not(windows))]
pub fn read_status() -> GpuPrefStatus {
    GpuPrefStatus {
        self_exe_path: String::new(),
        self_exe_pref_set: false,
        webview2_path: None,
        webview2_pref_set: false,
        edge_version: None,
    }
}

#[cfg(windows)]
pub fn apply(enable: bool) -> Result<GpuPrefStatus, String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(REG_KEY)
        .map_err(|e| format!("打开注册表失败: {}", e))?;

    let self_exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("读取自身路径失败: {}", e))?;

    let webview2 = find_webview2_path();

    if enable {
        key.set_value(&self_exe, &HIGH_PERF_VALUE.to_string())
            .map_err(|e| format!("写自身路径偏好失败: {}", e))?;
        if let Some((p, _)) = &webview2 {
            let p_str = p.to_string_lossy().to_string();
            key.set_value(&p_str, &HIGH_PERF_VALUE.to_string())
                .map_err(|e| format!("写 webview2 偏好失败: {}", e))?;
        }
        log::info!(
            "[GpuPref] 已为 solo-agent.exe{} 设置高性能偏好",
            if webview2.is_some() { " 与 msedgewebview2.exe" } else { "" }
        );
    } else {
        let _ = key.delete_value(&self_exe);
        if let Some((p, _)) = &webview2 {
            let _ = key.delete_value(&p.to_string_lossy().to_string());
        }
        log::info!("[GpuPref] 已清除自定义图形偏好");
    }

    Ok(read_status())
}

#[cfg(not(windows))]
pub fn apply(_enable: bool) -> Result<GpuPrefStatus, String> {
    Ok(read_status())
}

/// 在 HKLM 注册表里查找 EdgeWebView 当前安装版本号，拼出 msedgewebview2.exe 路径
#[cfg(windows)]
fn find_webview2_path() -> Option<(PathBuf, String)> {
    use winreg::enums::*;
    use winreg::RegKey;

    // EdgeWebView Runtime 应用的固定 GUID
    const WEBVIEW2_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    let candidates: [(isize, String); 3] = [
        (
            HKEY_LOCAL_MACHINE as isize,
            format!(r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{}", WEBVIEW2_GUID),
        ),
        (
            HKEY_LOCAL_MACHINE as isize,
            format!(r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{}", WEBVIEW2_GUID),
        ),
        (
            HKEY_CURRENT_USER as isize,
            format!(r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{}", WEBVIEW2_GUID),
        ),
    ];

    for (root, sub) in &candidates {
        let root_key = RegKey::predef(*root as winreg::HKEY);
        if let Ok(k) = root_key.open_subkey(sub) {
            if let Ok(version) = k.get_value::<String, _>("pv") {
                // 32-bit 安装路径（默认）
                let p = PathBuf::from(format!(
                    r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\{}\msedgewebview2.exe",
                    version
                ));
                if p.exists() {
                    return Some((p, version));
                }
                // 64-bit 备用路径
                let p64 = PathBuf::from(format!(
                    r"C:\Program Files\Microsoft\EdgeWebView\Application\{}\msedgewebview2.exe",
                    version
                ));
                if p64.exists() {
                    return Some((p64, version));
                }
            }
        }
    }
    None
}
