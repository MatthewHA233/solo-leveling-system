// ══════════════════════════════════════════════
// Perception — 自研电脑活动采集
// ActivityWatch 风格：watcher 只上报当前状态，DB heartbeat 合并成 span。
// 浏览器先按 自研感知层的低侵入路线处理：读取前台窗口标题/进程，不依赖扩展。
// ══════════════════════════════════════════════

use std::collections::HashSet;
use std::ffi::c_void;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration as StdDuration, SystemTime};

use chrono::Local;
use image::{DynamicImage, ImageOutputFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{sleep, Duration};
use windows_sys::Win32::Foundation::{HWND, RECT};

use crate::db::{Database, PerceptionHeartbeat};

#[derive(Debug, Clone, Serialize)]
struct WindowSnapshot {
    app: String,
    title: String,
    pid: u32,
    exe_path: Option<String>,
    is_browser: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotSettings {
    pub enabled: bool,
    pub interval_seconds: u64,
    pub capture_target: String,
    pub format: String,
    pub quality: u8,
    pub resolution_percent: u8,
    pub save_dir: String,
    pub retention_mode: String,
    pub max_size_mb: u64,
    pub retention_days: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotStorageInfo {
    pub path: String,
    pub size_bytes: u64,
    pub file_count: u64,
}

/// 追踪设置 — 控制感知层灵敏度
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingSettings {
    /// 标记为离开（afk）所需的连续无操作分钟数
    pub afk_after_minutes: u32,
    /// 标记为空闲（idle）所需的连续无操作秒数（小于 afk_after_minutes 对应的秒数）
    pub idle_after_seconds: u32,
    /// 最短活动持续时间（秒）= 心跳脉冲时间，短于此值的同状态片段会被合并
    pub min_activity_seconds: u32,
}

impl Default for TrackingSettings {
    fn default() -> Self {
        Self {
            afk_after_minutes: 3,
            idle_after_seconds: 60,
            min_activity_seconds: 5,
        }
    }
}

/// 窗口黑名单条目 — 当前台窗口匹配时，不切换录制目标，也不截图
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBlacklistEntry {
    pub app: String,
    /// None = 整个 app 全忽略；Some = 精确匹配该 title
    pub title: Option<String>,
    pub created_at: String,
}

impl Default for ScreenshotSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_seconds: 60,
            capture_target: "active_window".to_string(),
            format: "jpg".to_string(),
            quality: 50,
            resolution_percent: 100,
            save_dir: default_screenshot_dir().to_string_lossy().into_owned(),
            retention_mode: "days".to_string(),
            max_size_mb: 2048,
            retention_days: 7,
        }
    }
}

pub async fn run_window_watcher(db: Arc<Database>) {
    log::info!("[Perception] window watcher started");
    // 已抓过图标的 app 启动时从 DB 回填，避免重启后重新提取
    let mut icon_cache: HashSet<String> = match db.list_app_keys_with_icon().await {
        Ok(keys) => {
            log::info!("[Perception] icon_cache 回填 {} 个 app", keys.len());
            keys.into_iter().collect()
        }
        Err(e) => {
            log::warn!("[Perception] icon_cache 回填失败: {}", e);
            HashSet::new()
        }
    };
    let mut last_good: Option<WindowSnapshot> = None;
    let blacklist_file = blacklist_path();
    let mut blacklist_cache = load_window_blacklist();
    let mut blacklist_mtime = file_mtime(&blacklist_file);
    loop {
        // 仅当 blacklist JSON 文件 mtime 变化时才重读
        let cur_mtime = file_mtime(&blacklist_file);
        if cur_mtime != blacklist_mtime {
            blacklist_cache = load_window_blacklist();
            blacklist_mtime = cur_mtime;
        }

        let current = current_window_snapshot();
        let blacklisted = current
            .as_ref()
            .map(|s| matches_blacklist(s, &blacklist_cache))
            .unwrap_or(false);
        // last_good 也要按当前黑名单复检：用户可能刚把上一个 last_good 也加入黑名单，
        // 此时 last_good 已经"过期"，不能再用它顶替
        if last_good
            .as_ref()
            .map(|s| matches_blacklist(s, &blacklist_cache))
            .unwrap_or(false)
        {
            last_good = None;
        }
        // 命中黑名单 → 用上次"非黑"快照继续上报，让前一个 span 自然延长
        let effective = if blacklisted {
            last_good.clone()
        } else {
            current.clone()
        };

        match effective {
            Some(snapshot) => {
                let heartbeat = PerceptionHeartbeat {
                    bucket_id: "sls-watcher-window_windows".to_string(),
                    bucket_kind: "window".to_string(),
                    event_type: "currentwindow".to_string(),
                    source: product_storage_name(),
                    observed_at: now_local_string(),
                    data: json!({
                        "app": snapshot.app,
                        "title": snapshot.title,
                        "pid": snapshot.pid,
                        "exe_path": snapshot.exe_path,
                        "is_browser": snapshot.is_browser,
                    }),
                    pulsetime_seconds: 5,
                };

                if let Err(err) = db.record_perception_heartbeat(heartbeat).await {
                    log::warn!("[Perception] window heartbeat failed: {}", err);
                }

                if !blacklisted {
                    if icon_cache.insert(snapshot.app.clone()) {
                        if let Some(exe_path) = snapshot.exe_path.as_deref() {
                            match extract_app_icon_bmp(exe_path) {
                                Some(bytes) => {
                                    let dominant = dominant_color_from_bmp(&bytes);
                                    if let Err(err) = db
                                        .update_perception_app_icon(
                                            &snapshot.app,
                                            Some(exe_path),
                                            &bytes,
                                            dominant.as_deref(),
                                        )
                                        .await
                                    {
                                        log::warn!("[Perception] app icon save failed: {}", err);
                                    }
                                }
                                None => {
                                    log::debug!("[Perception] no icon extracted for {}", exe_path)
                                }
                            }
                        }
                    }
                    last_good = Some(snapshot);
                }
            }
            None => {
                log::debug!("[Perception] no foreground window");
            }
        }

        sleep(Duration::from_secs(2)).await;
    }
}

pub async fn run_screenshot_watcher() {
    log::info!("[Perception] screenshot watcher started");
    loop {
        let settings = load_screenshot_settings();
        let interval = settings.interval_seconds.clamp(5, 3600);
        if settings.enabled {
            let idle_seconds = seconds_since_last_input().unwrap_or(0.0);
            if idle_seconds < 300.0 {
                // 当前前台窗口在黑名单 → 临时改为全屏截图（不再裁到该窗口的活动区域）
                let blacklist = load_window_blacklist();
                let blacklisted = current_window_snapshot()
                    .map(|s| matches_blacklist(&s, &blacklist))
                    .unwrap_or(false);
                let mut capture_settings = settings.clone();
                if blacklisted && capture_settings.capture_target == "active_window" {
                    capture_settings.capture_target = "all_screens".to_string();
                    log::debug!("[Perception] foreground blacklisted, fallback to full screen");
                }
                let capture_result = tokio::task::spawn_blocking(move || {
                    let path = capture_screenshot_now(&capture_settings)?;
                    enforce_retention(&capture_settings)?;
                    Ok::<PathBuf, String>(path)
                })
                .await;
                match capture_result {
                    Ok(Ok(path)) => log::debug!("[Perception] screenshot captured: {:?}", path),
                    Ok(Err(err)) => log::warn!("[Perception] screenshot failed: {}", err),
                    Err(err) => log::warn!("[Perception] screenshot task failed: {}", err),
                }
            }
        }
        sleep(Duration::from_secs(interval)).await;
    }
}

pub fn find_screenshot_near(date: &str, time_str: &str) -> Option<PathBuf> {
    let settings = load_screenshot_settings();
    let dir = PathBuf::from(settings.save_dir).join(date);
    if !dir.exists() {
        return None;
    }

    let target = parse_time_secs(time_str)?;
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "bmp") {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if let Some(file_secs) = parse_screenshot_filename_secs(name) {
            let diff = file_secs.abs_diff(target);
            if diff <= 300 && best.as_ref().map_or(true, |(d, _)| diff < *d) {
                best = Some((diff, path));
            }
        }
    }
    best.map(|(_, path)| path)
}

pub async fn run_status_watcher(db: Arc<Database>) {
    log::info!("[Perception] status watcher started");
    let tracking_file = tracking_path();
    let mut tracking_cache = load_tracking_settings();
    let mut tracking_mtime = file_mtime(&tracking_file);
    loop {
        // 仅当 tracking-settings JSON mtime 变化时才重读
        let cur_mtime = file_mtime(&tracking_file);
        if cur_mtime != tracking_mtime {
            tracking_cache = load_tracking_settings();
            tracking_mtime = cur_mtime;
        }
        let afk_secs = tracking_cache.afk_after_minutes as f64 * 60.0;
        let idle_secs = tracking_cache.idle_after_seconds as f64;
        let pulsetime = tracking_cache.min_activity_seconds.max(1) as i64 * 3;

        let idle_seconds = seconds_since_last_input().unwrap_or(0.0);
        let status = if idle_seconds >= afk_secs {
            "afk"
        } else if idle_seconds >= idle_secs {
            "idle"
        } else {
            "active"
        };

        let heartbeat = PerceptionHeartbeat {
            bucket_id: "sls-watcher-status_windows".to_string(),
            bucket_kind: "status".to_string(),
            event_type: "afkstatus".to_string(),
            source: product_storage_name(),
            observed_at: now_local_string(),
            data: json!({ "status": status }),
            pulsetime_seconds: pulsetime,
        };

        if let Err(err) = db.record_perception_heartbeat(heartbeat).await {
            log::warn!("[Perception] status heartbeat failed: {}", err);
        }

        sleep(Duration::from_secs(5)).await;
    }
}

fn now_local_string() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn current_window_snapshot() -> Option<WindowSnapshot> {
    let hwnd = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
    if hwnd.is_null() {
        return None;
    }

    let title = window_title(hwnd).unwrap_or_default();
    let pid = window_pid(hwnd)?;
    let exe_path = process_path(pid);
    let app = exe_path
        .as_deref()
        .and_then(|p| Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    Some(WindowSnapshot {
        is_browser: is_browser_app(&app),
        app,
        title,
        pid,
        exe_path,
    })
}

fn window_title(hwnd: HWND) -> Option<String> {
    let len = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextLengthW(hwnd) };
    let mut buf = vec![0u16; len.max(0) as usize + 1];
    let copied = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW(
            hwnd,
            buf.as_mut_ptr(),
            buf.len() as i32,
        )
    };
    if copied < 0 {
        return None;
    }
    Some(
        String::from_utf16_lossy(&buf[..copied as usize])
            .trim()
            .to_string(),
    )
}

fn window_pid(hwnd: HWND) -> Option<u32> {
    let mut pid = 0u32;
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, &mut pid);
    }
    if pid == 0 {
        None
    } else {
        Some(pid)
    }
}

fn process_path(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }

    let mut size = 32768u32;
    let mut buf = vec![0u16; size as usize];
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) };
    unsafe {
        CloseHandle(handle);
    }

    if ok == 0 || size == 0 {
        return None;
    }

    Some(String::from_utf16_lossy(&buf[..size as usize]))
}

fn seconds_since_last_input() -> Option<f64> {
    use std::mem::size_of;
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };

    let ok = unsafe { GetLastInputInfo(&mut info) };
    if ok == 0 {
        return None;
    }

    let tick_count = unsafe { GetTickCount64() };
    let tick_lower = (tick_count & 0xffff_ffff) as u32;
    let diff_ms = if tick_lower >= info.dwTime {
        tick_lower - info.dwTime
    } else {
        (u32::MAX - info.dwTime) + tick_lower + 1
    };

    Some(diff_ms as f64 / 1000.0)
}

fn is_browser_app(app: &str) -> bool {
    let app = app.to_ascii_lowercase();
    matches!(
        app.as_str(),
        "chrome.exe"
            | "msedge.exe"
            | "firefox.exe"
            | "brave.exe"
            | "vivaldi.exe"
            | "opera.exe"
            | "arc.exe"
    )
}

pub fn load_screenshot_settings() -> ScreenshotSettings {
    let default = ScreenshotSettings::default();
    let path = settings_path();
    let settings = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<ScreenshotSettings>(&raw).ok())
        .unwrap_or(default);
    sanitize_screenshot_settings(settings)
}

pub fn save_screenshot_settings(
    settings: ScreenshotSettings,
) -> Result<ScreenshotSettings, String> {
    let settings = sanitize_screenshot_settings(settings);
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建截图设置目录失败: {}", e))?;
    }
    fs::create_dir_all(&settings.save_dir).map_err(|e| format!("创建截图目录失败: {}", e))?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("写入截图设置失败: {}", e))?;
    Ok(settings)
}

pub fn screenshot_storage_info() -> Result<ScreenshotStorageInfo, String> {
    let settings = load_screenshot_settings();
    let root = PathBuf::from(&settings.save_dir);
    fs::create_dir_all(&root).map_err(|e| format!("创建截图目录失败: {}", e))?;
    let files = collect_screenshot_files(&root)?;
    let size_bytes = files.iter().map(|f| f.size).sum();
    Ok(ScreenshotStorageInfo {
        path: root.to_string_lossy().into_owned(),
        size_bytes,
        file_count: files.len() as u64,
    })
}

pub fn open_screenshot_folder() -> Result<(), String> {
    let settings = load_screenshot_settings();
    fs::create_dir_all(&settings.save_dir).map_err(|e| format!("创建截图目录失败: {}", e))?;
    Command::new("explorer")
        .arg(&settings.save_dir)
        .spawn()
        .map_err(|e| format!("打开截图目录失败: {}", e))?;
    Ok(())
}

pub fn clear_screenshot_data() -> Result<ScreenshotStorageInfo, String> {
    let settings = load_screenshot_settings();
    let root = PathBuf::from(&settings.save_dir);
    fs::create_dir_all(&root).map_err(|e| format!("创建截图目录失败: {}", e))?;
    let root = root
        .canonicalize()
        .map_err(|e| format!("解析截图目录失败: {}", e))?;
    if root.components().count() < 3 {
        return Err("截图目录过于宽泛，拒绝清空".to_string());
    }

    for entry in fs::read_dir(&root).map_err(|e| format!("读取截图目录失败: {}", e))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| format!("删除目录失败: {}", e))?;
        } else {
            fs::remove_file(&path).map_err(|e| format!("删除文件失败: {}", e))?;
        }
    }

    screenshot_storage_info()
}

fn capture_screenshot_now(settings: &ScreenshotSettings) -> Result<PathBuf, String> {
    let now = Local::now();
    let date = now.format("%Y-%m-%d").to_string();
    let ext = file_extension_for_format(&settings.format);
    let filename = format!("{}.{}", now.format("%Y-%m-%d_%H-%M-%S"), ext);
    let dir = PathBuf::from(&settings.save_dir).join(&date);
    fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {}", e))?;
    let path = dir.join(filename);

    let (x, y, width, height) =
        capture_rect(settings).ok_or_else(|| "截图区域尺寸无效".to_string())?;
    let pixels = capture_region_bgra(x, y, width, height)?;
    let image = bgra_to_rgba(width, height, &pixels)?;
    let image = resize_for_settings(image, settings.resolution_percent);
    let bytes = encode_screenshot_image(image, &settings.format, settings.quality)?;
    fs::write(&path, bytes).map_err(|e| format!("写入截图失败: {}", e))?;
    Ok(path)
}

fn enforce_retention(settings: &ScreenshotSettings) -> Result<(), String> {
    let root = PathBuf::from(&settings.save_dir);
    if !root.exists() {
        return Ok(());
    }

    let mut files = collect_screenshot_files(&root)?;
    if settings.retention_mode == "size" {
        let limit = settings.max_size_mb.saturating_mul(1024 * 1024);
        let mut total: u64 = files.iter().map(|f| f.size).sum();
        files.sort_by_key(|f| f.modified);
        for file in files {
            if total <= limit {
                break;
            }
            if fs::remove_file(&file.path).is_ok() {
                total = total.saturating_sub(file.size);
            }
        }
    } else {
        let days = settings.retention_days.max(1);
        let cutoff = SystemTime::now()
            .checked_sub(StdDuration::from_secs(days.saturating_mul(86_400)))
            .unwrap_or(SystemTime::UNIX_EPOCH);
        for file in files {
            if file.modified < cutoff {
                let _ = fs::remove_file(file.path);
            }
        }
    }

    Ok(())
}

fn sanitize_screenshot_settings(mut settings: ScreenshotSettings) -> ScreenshotSettings {
    settings.interval_seconds = settings.interval_seconds.clamp(5, 3600);
    settings.capture_target = match settings.capture_target.to_ascii_lowercase().as_str() {
        "all_screens" => "all_screens".to_string(),
        _ => "active_window".to_string(),
    };
    settings.format = match settings.format.to_ascii_lowercase().as_str() {
        "png" => "png".to_string(),
        "webp" => "webp".to_string(),
        _ => "jpg".to_string(),
    };
    settings.quality = settings.quality.clamp(1, 100);
    settings.resolution_percent = settings.resolution_percent.clamp(10, 100);
    if settings.save_dir.trim().is_empty() {
        settings.save_dir = default_screenshot_dir().to_string_lossy().into_owned();
    }
    settings.retention_mode = match settings.retention_mode.to_ascii_lowercase().as_str() {
        "size" => "size".to_string(),
        _ => "days".to_string(),
    };
    settings.max_size_mb = settings.max_size_mb.clamp(10, 1_048_576);
    settings.retention_days = settings.retention_days.clamp(1, 3650);
    settings
}

fn product_storage_name() -> String {
    let product = option_env!("SLS_PRODUCT_NAME")
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(env!("CARGO_PKG_DESCRIPTION"));
    let compact: String = product
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if compact.is_empty() {
        "Application".to_string()
    } else {
        compact
    }
}

fn settings_root() -> PathBuf {
    if let Ok(path) = std::env::var("SLS_PERCEPTION_DIR") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }

    dirs::config_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(product_storage_name())
}

fn settings_path() -> PathBuf {
    settings_root().join("screenshot-settings.json")
}

fn file_mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).ok().and_then(|m| m.modified().ok())
}

fn blacklist_path() -> PathBuf {
    settings_root().join("window-blacklist.json")
}

fn tracking_path() -> PathBuf {
    settings_root().join("tracking-settings.json")
}

pub fn load_tracking_settings() -> TrackingSettings {
    let path = tracking_path();
    let s = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<TrackingSettings>(&raw).ok())
        .unwrap_or_default();
    sanitize_tracking_settings(s)
}

pub fn save_tracking_settings(settings: TrackingSettings) -> Result<TrackingSettings, String> {
    let settings = sanitize_tracking_settings(settings);
    let path = tracking_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建追踪设置目录失败: {}", e))?;
    }
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("写入追踪设置失败: {}", e))?;
    Ok(settings)
}

fn sanitize_tracking_settings(mut s: TrackingSettings) -> TrackingSettings {
    s.afk_after_minutes = s.afk_after_minutes.clamp(1, 500);
    s.idle_after_seconds = s.idle_after_seconds.clamp(5, s.afk_after_minutes * 60);
    s.min_activity_seconds = s.min_activity_seconds.clamp(1, 300);
    s
}

pub fn load_window_blacklist() -> Vec<WindowBlacklistEntry> {
    let path = blacklist_path();
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<WindowBlacklistEntry>>(&raw).ok())
        .unwrap_or_default()
}

fn save_window_blacklist(list: &[WindowBlacklistEntry]) -> Result<(), String> {
    let path = blacklist_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建黑名单目录失败: {}", e))?;
    }
    let raw = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("写入黑名单失败: {}", e))
}

pub fn add_window_blacklist(
    app: String,
    title: Option<String>,
) -> Result<Vec<WindowBlacklistEntry>, String> {
    let app = app.trim().to_string();
    if app.is_empty() {
        return Err("应用名不能为空".into());
    }
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let mut list = load_window_blacklist();
    let dup = list
        .iter()
        .any(|e| e.app.eq_ignore_ascii_case(&app) && e.title == title);
    if !dup {
        list.push(WindowBlacklistEntry {
            app,
            title,
            created_at: now_local_string(),
        });
        save_window_blacklist(&list)?;
    }
    Ok(list)
}

pub fn remove_window_blacklist(
    app: String,
    title: Option<String>,
) -> Result<Vec<WindowBlacklistEntry>, String> {
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let mut list = load_window_blacklist();
    list.retain(|e| !(e.app.eq_ignore_ascii_case(&app) && e.title == title));
    save_window_blacklist(&list)?;
    Ok(list)
}

fn matches_blacklist(snapshot: &WindowSnapshot, list: &[WindowBlacklistEntry]) -> bool {
    list.iter().any(|e| {
        if !e.app.eq_ignore_ascii_case(&snapshot.app) {
            return false;
        }
        match &e.title {
            Some(t) => *t == snapshot.title,
            None => true,
        }
    })
}

fn default_screenshot_dir() -> PathBuf {
    if let Ok(path) = std::env::var("SLS_SCREENSHOT_DIR") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }

    let folder = format!("{}Screenshots", product_storage_name());
    let d_drive = Path::new("D:\\");
    if d_drive.exists() {
        d_drive.join(folder)
    } else {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(product_storage_name())
            .join("Screenshots")
    }
}

fn file_extension_for_format(format: &str) -> &'static str {
    match format {
        "png" => "png",
        "webp" => "webp",
        _ => "jpg",
    }
}

fn capture_rect(settings: &ScreenshotSettings) -> Option<(i32, i32, i32, i32)> {
    if settings.capture_target == "active_window" {
        if let Some(rect) = active_window_rect() {
            return Some(rect);
        }
    }
    virtual_screen_rect()
}

fn active_window_rect() -> Option<(i32, i32, i32, i32)> {
    let hwnd = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
    if hwnd.is_null() {
        return None;
    }

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect) };
    if ok == 0 {
        return None;
    }

    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        None
    } else {
        Some((rect.left, rect.top, width, height))
    }
}

fn virtual_screen_rect() -> Option<(i32, i32, i32, i32)> {
    let x = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
            windows_sys::Win32::UI::WindowsAndMessaging::SM_XVIRTUALSCREEN,
        )
    };
    let y = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
            windows_sys::Win32::UI::WindowsAndMessaging::SM_YVIRTUALSCREEN,
        )
    };
    let width = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
            windows_sys::Win32::UI::WindowsAndMessaging::SM_CXVIRTUALSCREEN,
        )
    };
    let height = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
            windows_sys::Win32::UI::WindowsAndMessaging::SM_CYVIRTUALSCREEN,
        )
    };
    if width <= 0 || height <= 0 {
        None
    } else {
        Some((x, y, width, height))
    }
}

fn bgra_to_rgba(width: i32, height: i32, pixels: &[u8]) -> Result<RgbaImage, String> {
    if width <= 0 || height <= 0 {
        return Err("截图尺寸无效".to_string());
    }
    let expected = (width as usize) * (height as usize) * 4;
    if pixels.len() != expected {
        return Err("截图像素数据长度不匹配".to_string());
    }

    let mut rgba = Vec::with_capacity(pixels.len());
    for px in pixels.chunks_exact(4) {
        rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }

    RgbaImage::from_raw(width as u32, height as u32, rgba)
        .ok_or_else(|| "构建截图图像失败".to_string())
}

fn resize_for_settings(image: RgbaImage, resolution_percent: u8) -> RgbaImage {
    if resolution_percent >= 100 {
        return image;
    }
    let width = ((image.width() as u64 * resolution_percent as u64) / 100).max(1) as u32;
    let height = ((image.height() as u64 * resolution_percent as u64) / 100).max(1) as u32;
    image::imageops::resize(&image, width, height, image::imageops::FilterType::Triangle)
}

fn encode_screenshot_image(image: RgbaImage, format: &str, quality: u8) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    match format {
        "png" => DynamicImage::ImageRgba8(image)
            .write_to(&mut cursor, ImageOutputFormat::Png)
            .map_err(|e| format!("编码 PNG 失败: {}", e))?,
        "webp" => DynamicImage::ImageRgba8(image)
            .write_to(&mut cursor, ImageOutputFormat::WebP)
            .map_err(|e| format!("编码 WebP 失败: {}", e))?,
        _ => {
            let rgb = DynamicImage::ImageRgba8(image).to_rgb8();
            DynamicImage::ImageRgb8(rgb)
                .write_to(&mut cursor, ImageOutputFormat::Jpeg(quality))
                .map_err(|e| format!("编码 JPG 失败: {}", e))?;
        }
    }
    Ok(cursor.into_inner())
}

#[derive(Debug)]
struct StoredScreenshotFile {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

fn collect_screenshot_files(root: &Path) -> Result<Vec<StoredScreenshotFile>, String> {
    let mut files = Vec::new();
    collect_screenshot_files_inner(root, &mut files)?;
    Ok(files)
}

fn collect_screenshot_files_inner(
    dir: &Path,
    files: &mut Vec<StoredScreenshotFile>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(dir).map_err(|e| format!("读取截图目录失败: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if metadata.is_dir() {
            collect_screenshot_files_inner(&path, files)?;
        } else if is_supported_screenshot_path(&path) {
            files.push(StoredScreenshotFile {
                path,
                size: metadata.len(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            });
        }
    }
    Ok(())
}

fn is_supported_screenshot_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "bmp"
            )
        })
        .unwrap_or(false)
}

/// 启动时调用一次：把 app_catalog 里所有已存图标重新跑主色算法，写回 color 列
pub async fn refresh_app_colors_from_icons(db: Arc<Database>) {
    let entries = match db.list_app_catalog_icons().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[Perception] list app icons 失败: {}", e);
            return;
        }
    };
    let mut updated = 0usize;
    for (app, bmp) in &entries {
        if let Some(color) = dominant_color_from_bmp(bmp) {
            if let Err(err) = db.set_app_catalog_color(app, &color).await {
                log::warn!("[Perception] 刷新 {} 主色失败: {}", app, err);
            } else {
                updated += 1;
            }
        }
    }
    log::info!(
        "[Perception] 主色刷新：扫 {} / 更新 {}",
        entries.len(),
        updated
    );
}

/// 从 BMP 字节里抽取主色（量化 + 频次直方图，丢掉过暗/过亮/低饱和像素）
fn dominant_color_from_bmp(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 54 || &bytes[0..2] != b"BM" {
        return None;
    }
    let pixel_offset = u32::from_le_bytes(bytes[10..14].try_into().ok()?) as usize;
    let width = i32::from_le_bytes(bytes[18..22].try_into().ok()?).unsigned_abs() as usize;
    let height = i32::from_le_bytes(bytes[22..26].try_into().ok()?).unsigned_abs() as usize;
    let bit_count = u16::from_le_bytes(bytes[28..30].try_into().ok()?);
    if bit_count != 32 || width == 0 || height == 0 {
        return None;
    }
    let need = pixel_offset + width * height * 4;
    if bytes.len() < need {
        return None;
    }
    let pixels = &bytes[pixel_offset..pixel_offset + width * height * 4];

    // 双轮策略：
    // 第一轮要求一定饱和度（避免选到灰、黑、白）；如果像素几乎全灰则放宽到允许灰色
    let pass = |sat_min: i32, lum_min: u32, lum_max: u32| -> Option<(u8, u8, u8)> {
        let mut counts = std::collections::HashMap::<u16, u32>::new();
        let mut sums = std::collections::HashMap::<u16, (u64, u64, u64)>::new();
        for px in pixels.chunks_exact(4) {
            let b = px[0];
            let g = px[1];
            let r = px[2];
            let a = px[3];
            if a < 128 {
                continue;
            }
            let sum = r as u32 + g as u32 + b as u32;
            if sum < lum_min || sum > lum_max {
                continue;
            }
            let mx = r.max(g).max(b) as i32;
            let mn = r.min(g).min(b) as i32;
            if mx - mn < sat_min {
                continue;
            }
            let key = ((r >> 4) as u16) << 8 | ((g >> 4) as u16) << 4 | (b >> 4) as u16;
            *counts.entry(key).or_insert(0) += 1;
            let entry = sums.entry(key).or_insert((0, 0, 0));
            entry.0 += r as u64;
            entry.1 += g as u64;
            entry.2 += b as u64;
        }
        let (best_key, best_count) = counts.into_iter().max_by_key(|(_, c)| *c)?;
        if best_count < 2 {
            return None;
        }
        let (rs, gs, bs) = sums.get(&best_key)?;
        let n = best_count as u64;
        Some(((*rs / n) as u8, (*gs / n) as u8, (*bs / n) as u8))
    };

    // 1) 优先饱和度 ≥ 18，亮度 [60, 740]
    // 2) 退化：饱和度放宽到 ≥ 8
    // 3) 兜底：完全不限饱和度，去掉过暗/过亮，挑最频繁的桶
    let (r, g, b) = pass(18, 60, 740)
        .or_else(|| pass(8, 50, 760))
        .or_else(|| pass(0, 40, 780))?;
    Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
}

fn extract_app_icon_bmp(exe_path: &str) -> Option<Vec<u8>> {
    use windows_sys::Win32::UI::Shell::ExtractIconExW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, DrawIconEx, GetSystemMetrics, DI_NORMAL, HICON, SM_CXICON, SM_CYICON,
    };

    let mut wide = to_wide(exe_path);
    let mut large: HICON = std::ptr::null_mut();
    let mut small: HICON = std::ptr::null_mut();
    let count = unsafe { ExtractIconExW(wide.as_mut_ptr(), 0, &mut large, &mut small, 1) };
    if count == 0 {
        return None;
    }

    let icon = if !large.is_null() { large } else { small };
    if icon.is_null() {
        return None;
    }

    let width = unsafe { GetSystemMetrics(SM_CXICON) }.max(32);
    let height = unsafe { GetSystemMetrics(SM_CYICON) }.max(32);
    let result = render_to_bgra(width, height, |hdc| unsafe {
        DrawIconEx(
            hdc,
            0,
            0,
            icon,
            width,
            height,
            0,
            std::ptr::null_mut(),
            DI_NORMAL,
        ) != 0
    })
    .ok()
    .and_then(|pixels| bmp_bytes(width, height, &pixels).ok());

    unsafe {
        if !large.is_null() {
            DestroyIcon(large);
        }
        if !small.is_null() && small != large {
            DestroyIcon(small);
        }
    }
    result
}

fn capture_region_bgra(x: i32, y: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
    render_to_bgra(width, height, |hdc| {
        use windows_sys::Win32::Graphics::Gdi::{BitBlt, GetDC, ReleaseDC, CAPTUREBLT, SRCCOPY};

        let screen = unsafe { GetDC(std::ptr::null_mut()) };
        if screen.is_null() {
            return false;
        }
        let ok =
            unsafe { BitBlt(hdc, 0, 0, width, height, screen, x, y, SRCCOPY | CAPTUREBLT) != 0 };
        unsafe {
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        ok
    })
}

fn render_to_bgra<F>(width: i32, height: i32, draw: F) -> Result<Vec<u8>, String>
where
    F: FnOnce(windows_sys::Win32::Graphics::Gdi::HDC) -> bool,
{
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
        BI_RGB, DIB_RGB_COLORS,
    };

    let hdc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
    if hdc.is_null() {
        return Err("CreateCompatibleDC failed".to_string());
    }

    let mut bits: *mut c_void = std::ptr::null_mut();
    let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
    bmi.bmiHeader.biSize =
        std::mem::size_of::<windows_sys::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width;
    bmi.bmiHeader.biHeight = -height;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    let bitmap = unsafe {
        CreateDIBSection(
            hdc,
            &bmi,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        )
    };
    if bitmap.is_null() || bits.is_null() {
        unsafe {
            DeleteDC(hdc);
        }
        return Err("CreateDIBSection failed".to_string());
    }

    let old = unsafe { SelectObject(hdc, bitmap) };
    let ok = draw(hdc);
    let size = (width as usize) * (height as usize) * 4;
    let pixels = if ok {
        unsafe { std::slice::from_raw_parts(bits as *const u8, size).to_vec() }
    } else {
        Vec::new()
    };

    unsafe {
        SelectObject(hdc, old);
        DeleteObject(bitmap);
        DeleteDC(hdc);
    }

    if ok {
        Ok(pixels)
    } else {
        Err("绘制 DIB 失败".to_string())
    }
}

fn bmp_bytes(width: i32, height: i32, pixels: &[u8]) -> Result<Vec<u8>, String> {
    if width <= 0 || height <= 0 {
        return Err("BMP 尺寸无效".to_string());
    }
    let expected = (width as usize) * (height as usize) * 4;
    if pixels.len() != expected {
        return Err("BMP 像素数据长度不匹配".to_string());
    }

    let pixel_offset = 14u32 + 40u32;
    let file_size = pixel_offset + pixels.len() as u32;
    let mut out = Vec::with_capacity(file_size as usize);

    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&pixel_offset.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&(-height).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(pixels.len() as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(pixels);
    Ok(out)
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn parse_time_secs(t: &str) -> Option<u64> {
    let p: Vec<&str> = t.split(':').collect();
    let h = p.first()?.parse::<u64>().ok()?;
    let m = p.get(1)?.parse::<u64>().ok()?;
    let s = p.get(2).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    Some(h * 3600 + m * 60 + s)
}

fn parse_screenshot_filename_secs(name: &str) -> Option<u64> {
    let stem = Path::new(name).file_stem()?.to_str()?;
    let (_, time_part) = stem.split_once('_')?;
    let t: Vec<&str> = time_part.split('-').collect();
    if t.len() < 3 {
        return None;
    }
    let h = t[0].parse::<u64>().ok()?;
    let m = t[1].parse::<u64>().ok()?;
    let s = t[2].parse::<u64>().ok()?;
    if h < 24 && m < 60 && s < 60 {
        Some(h * 3600 + m * 60 + s)
    } else {
        None
    }
}
