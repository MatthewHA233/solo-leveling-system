// ══════════════════════════════════════════════
// Perception — macOS 自研电脑活动采集
// 沿用 Windows 端 ActivityWatch 风格 heartbeat：watcher 只上报当前状态，
// DB 负责把连续 heartbeat 合并成昼夜表 span。
// ══════════════════════════════════════════════

use std::collections::HashSet;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration as StdDuration, SystemTime, UNIX_EPOCH};

use chrono::Local;
use image::{DynamicImage, ImageOutputFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{sleep, Duration};

use crate::db::{Database, PerceptionHeartbeat};

#[derive(Debug, Clone, Serialize)]
struct WindowSnapshot {
    app: String,
    title: String,
    pid: u32,
    bundle_id: Option<String>,
    app_path: Option<String>,
    rect: Option<(i32, i32, i32, i32)>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingSettings {
    pub afk_after_minutes: u32,
    pub idle_after_seconds: u32,
    pub min_activity_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBlacklistEntry {
    pub app: String,
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

impl Default for TrackingSettings {
    fn default() -> Self {
        Self {
            afk_after_minutes: 3,
            idle_after_seconds: 60,
            min_activity_seconds: 5,
        }
    }
}

pub async fn run_window_watcher(db: Arc<Database>) {
    log::info!("[Perception/macOS] window watcher started");
    let mut icon_cache: HashSet<String> = match db.list_app_keys_with_icon().await {
        Ok(keys) => keys.into_iter().collect(),
        Err(e) => {
            log::warn!("[Perception/macOS] icon_cache 回填失败: {}", e);
            HashSet::new()
        }
    };
    let mut last_good: Option<WindowSnapshot> = None;
    let mut last_error: Option<String> = None;
    let mut missed_samples = 0u32;
    let blacklist_file = blacklist_path();
    let mut blacklist_cache = load_window_blacklist();
    let mut blacklist_mtime = file_mtime(&blacklist_file);

    loop {
        let cur_mtime = file_mtime(&blacklist_file);
        if cur_mtime != blacklist_mtime {
            blacklist_cache = load_window_blacklist();
            blacklist_mtime = cur_mtime;
        }

        let current = match current_window_snapshot() {
            Ok(snapshot) => {
                last_error = None;
                missed_samples = 0;
                snapshot
            }
            Err(err) => {
                if last_error.as_deref() != Some(err.as_str()) {
                    log::warn!("[Perception/macOS] 读取前台窗口失败: {}", err);
                    last_error = Some(err);
                }
                missed_samples = missed_samples.saturating_add(1);
                if missed_samples <= 3 {
                    last_good.clone()
                } else {
                    None
                }
            }
        };

        let blacklisted = current
            .as_ref()
            .map(|s| matches_blacklist(s, &blacklist_cache))
            .unwrap_or(false);
        if last_good
            .as_ref()
            .map(|s| matches_blacklist(s, &blacklist_cache))
            .unwrap_or(false)
        {
            last_good = None;
        }
        let effective = if blacklisted {
            last_good.clone()
        } else {
            current.clone()
        };

        if let Some(snapshot) = effective {
            let heartbeat = PerceptionHeartbeat {
                bucket_id: "sls-watcher-window_macos".to_string(),
                bucket_kind: "window".to_string(),
                event_type: "currentwindow".to_string(),
                source: product_storage_name(),
                observed_at: now_local_string(),
                data: json!({
                    "app": snapshot.app,
                    "title": snapshot.title,
                    "pid": snapshot.pid,
                    "bundle_id": snapshot.bundle_id,
                    "app_path": snapshot.app_path,
                    "is_browser": snapshot.is_browser,
                    "platform": "macos",
                }),
                pulsetime_seconds: 20,
            };

            if let Err(err) = db.record_perception_heartbeat(heartbeat).await {
                log::warn!("[Perception/macOS] window heartbeat failed: {}", err);
            }

            if !blacklisted {
                if icon_cache.insert(snapshot.app.clone()) {
                    if let Some(app_path) = snapshot.app_path.as_deref() {
                        match extract_app_icon_bmp(app_path) {
                            Some(bytes) => {
                                let dominant = dominant_color_from_bmp(&bytes);
                                if let Err(err) = db
                                    .update_perception_app_icon(
                                        &snapshot.app,
                                        Some(app_path),
                                        &bytes,
                                        dominant.as_deref(),
                                    )
                                    .await
                                {
                                    log::warn!("[Perception/macOS] app icon save failed: {}", err);
                                }
                            }
                            None => {
                                log::debug!("[Perception/macOS] no icon extracted for {}", app_path)
                            }
                        }
                    }
                }
                last_good = Some(snapshot);
            }
        }

        sleep(Duration::from_secs(2)).await;
    }
}

pub async fn run_status_watcher(db: Arc<Database>) {
    log::info!("[Perception/macOS] status watcher started");
    let tracking_file = tracking_path();
    let mut tracking_cache = load_tracking_settings();
    let mut tracking_mtime = file_mtime(&tracking_file);
    loop {
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
            bucket_id: "sls-watcher-status_macos".to_string(),
            bucket_kind: "status".to_string(),
            event_type: "afkstatus".to_string(),
            source: product_storage_name(),
            observed_at: now_local_string(),
            data: json!({ "status": status, "platform": "macos" }),
            pulsetime_seconds: pulsetime,
        };

        if let Err(err) = db.record_perception_heartbeat(heartbeat).await {
            log::warn!("[Perception/macOS] status heartbeat failed: {}", err);
        }

        sleep(Duration::from_secs(5)).await;
    }
}

pub async fn run_screenshot_watcher() {
    log::info!("[Perception/macOS] screenshot watcher started");
    loop {
        let settings = load_screenshot_settings();
        let interval = settings.interval_seconds.clamp(5, 3600);
        if settings.enabled {
            let idle_seconds = seconds_since_last_input().unwrap_or(0.0);
            if idle_seconds < 300.0 {
                let blacklist = load_window_blacklist();
                let blacklisted = current_window_snapshot()
                    .ok()
                    .flatten()
                    .map(|s| matches_blacklist(&s, &blacklist))
                    .unwrap_or(false);
                let mut capture_settings = settings.clone();
                if blacklisted && capture_settings.capture_target == "active_window" {
                    capture_settings.capture_target = "all_screens".to_string();
                    log::debug!(
                        "[Perception/macOS] foreground blacklisted, fallback to full screen"
                    );
                }
                let capture_result = tokio::task::spawn_blocking(move || {
                    let path = capture_screenshot_now(&capture_settings)?;
                    enforce_retention(&capture_settings)?;
                    Ok::<PathBuf, String>(path)
                })
                .await;
                match capture_result {
                    Ok(Ok(path)) => {
                        log::debug!("[Perception/macOS] screenshot captured: {:?}", path)
                    }
                    Ok(Err(err)) => log::warn!("[Perception/macOS] screenshot failed: {}", err),
                    Err(err) => log::warn!("[Perception/macOS] screenshot task failed: {}", err),
                }
            }
        }
        sleep(Duration::from_secs(interval)).await;
    }
}

pub async fn refresh_app_colors_from_icons(db: Arc<Database>) {
    let entries = match db.list_app_catalog_icons().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[Perception/macOS] list app icons 失败: {}", e);
            return;
        }
    };
    let mut updated = 0usize;
    for (app, bmp) in &entries {
        if let Some(color) = dominant_color_from_bmp(bmp) {
            if let Err(err) = db.set_app_catalog_color(app, &color).await {
                log::warn!("[Perception/macOS] 刷新 {} 主色失败: {}", app, err);
            } else {
                updated += 1;
            }
        }
    }
    log::info!(
        "[Perception/macOS] 主色刷新：扫 {} / 更新 {}",
        entries.len(),
        updated
    );
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

fn current_window_snapshot() -> Result<Option<WindowSnapshot>, String> {
    let script = [
        r#"set delim to "|||""#,
        r#"tell application "System Events""#,
        r#"set frontApp to first application process whose frontmost is true"#,
        r#"set appName to name of frontApp"#,
        r#"set pidValue to unix id of frontApp"#,
        r#"set appPath to """#,
        r#"try"#,
        r#"set appPath to POSIX path of (file of frontApp as alias)"#,
        r#"end try"#,
        r#"set bundleId to """#,
        r#"try"#,
        r#"set bundleId to bundle identifier of frontApp"#,
        r#"end try"#,
        r#"set winTitle to """#,
        r#"set rectText to """#,
        r#"try"#,
        r#"set frontWin to front window of frontApp"#,
        r#"set winTitle to name of frontWin"#,
        r#"set p to position of frontWin"#,
        r#"set s to size of frontWin"#,
        r#"set rectText to (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)"#,
        r#"end try"#,
        r#"return appName & delim & pidValue & delim & appPath & delim & bundleId & delim & winTitle & delim & rectText"#,
        r#"end tell"#,
    ];
    let out = run_osascript(&script)?;
    let parts: Vec<&str> = out.trim_end().split("|||").collect();
    if parts.len() < 6 {
        return Err(format!("osascript 返回字段不足: {}", out));
    }
    let app = parts[0].trim().to_string();
    if app.is_empty() {
        return Ok(None);
    }
    let pid = parts[1].trim().parse::<u32>().unwrap_or(0);
    let app_path = non_empty(parts[2]);
    let bundle_id = non_empty(parts[3]);
    let title = parts[4].trim().to_string();
    let rect = parse_rect(parts[5]);

    Ok(Some(WindowSnapshot {
        is_browser: is_browser_app(&app, bundle_id.as_deref()),
        app,
        title,
        pid,
        bundle_id,
        app_path,
        rect,
    }))
}

fn run_osascript(lines: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("osascript");
    for line in lines {
        cmd.arg("-e").arg(line);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("启动 osascript 失败: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "osascript 执行失败；可能缺少“辅助功能”权限".to_string()
        } else {
            stderr
        })
    }
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_rect(raw: &str) -> Option<(i32, i32, i32, i32)> {
    let nums: Vec<i32> = raw
        .split(',')
        .filter_map(|x| x.trim().parse::<i32>().ok())
        .collect();
    if nums.len() == 4 && nums[2] > 0 && nums[3] > 0 {
        Some((nums[0], nums[1], nums[2], nums[3]))
    } else {
        None
    }
}

fn is_browser_app(app: &str, bundle_id: Option<&str>) -> bool {
    let app = app.to_ascii_lowercase();
    let bundle_id = bundle_id.unwrap_or("").to_ascii_lowercase();
    matches!(
        app.as_str(),
        "safari"
            | "google chrome"
            | "chromium"
            | "microsoft edge"
            | "firefox"
            | "arc"
            | "brave browser"
            | "vivaldi"
            | "opera"
    ) || bundle_id.contains("com.apple.safari")
        || bundle_id.contains("com.google.chrome")
        || bundle_id.contains("com.microsoft.edgemac")
        || bundle_id.contains("org.mozilla.firefox")
        || bundle_id.contains("company.thebrowser.browser")
}

fn seconds_since_last_input() -> Option<f64> {
    let output = Command::new("ioreg")
        .args(["-c", "IOHIDSystem", "-r", "-d", "1"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if !line.contains("HIDIdleTime") {
            continue;
        }
        let digits: String = line.chars().filter(|c| c.is_ascii_digit()).collect();
        let nanos = digits.parse::<u64>().ok()?;
        return Some(nanos as f64 / 1_000_000_000.0);
    }
    None
}

fn capture_screenshot_now(settings: &ScreenshotSettings) -> Result<PathBuf, String> {
    let now = Local::now();
    let date = now.format("%Y-%m-%d").to_string();
    let stem = now.format("%Y-%m-%d_%H-%M-%S").to_string();
    let ext = file_extension_for_format(&settings.format);
    let dir = PathBuf::from(&settings.save_dir).join(&date);
    fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {}", e))?;
    let raw_path = dir.join(format!("{}.raw.png", stem));
    let final_path = dir.join(format!("{}.{}", stem, ext));

    let mut cmd = Command::new("screencapture");
    cmd.args(["-x", "-t", "png"]);
    if settings.capture_target == "active_window" {
        if let Some((x, y, w, h)) = active_window_rect() {
            cmd.arg("-R").arg(format!("{},{},{},{}", x, y, w, h));
        }
    }
    cmd.arg(&raw_path);
    let output = cmd
        .output()
        .map_err(|e| format!("启动 screencapture 失败: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_file(&raw_path);
        return Err(if stderr.is_empty() {
            "screencapture 失败；可能缺少“屏幕录制”权限".to_string()
        } else {
            stderr
        });
    }

    let image = image::open(&raw_path)
        .map_err(|e| format!("读取截图失败: {}", e))?
        .to_rgba8();
    let image = resize_for_settings(image, settings.resolution_percent);
    let bytes = encode_screenshot_image(image, &settings.format, settings.quality)?;
    fs::write(&final_path, bytes).map_err(|e| format!("写入截图失败: {}", e))?;
    let _ = fs::remove_file(raw_path);
    Ok(final_path)
}

fn active_window_rect() -> Option<(i32, i32, i32, i32)> {
    current_window_snapshot()
        .ok()
        .flatten()
        .and_then(|s| s.rect)
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
    Command::new("open")
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

fn extract_app_icon_bmp(app_path: &str) -> Option<Vec<u8>> {
    let app_path = Path::new(app_path);
    let plist = app_path.join("Contents").join("Info.plist");
    let resources = app_path.join("Contents").join("Resources");
    let icon_name = plist_value(&plist, "CFBundleIconFile")
        .or_else(|| plist_value(&plist, "CFBundleIconName"))?;
    let icon_file = if icon_name.ends_with(".icns") {
        icon_name
    } else {
        format!("{}.icns", icon_name)
    };
    let icon_path = resources.join(icon_file);
    if !icon_path.exists() {
        return None;
    }

    let tmp_png = std::env::temp_dir().join(format!(
        "sls-icon-{}-{}.png",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis()
    ));
    let output = Command::new("sips")
        .args(["-s", "format", "png"])
        .arg(&icon_path)
        .arg("--out")
        .arg(&tmp_png)
        .output()
        .ok()?;
    if !output.status.success() {
        let _ = fs::remove_file(&tmp_png);
        return None;
    }

    let img = image::open(&tmp_png).ok()?.to_rgba8();
    let _ = fs::remove_file(&tmp_png);
    let icon = image::imageops::resize(&img, 64, 64, image::imageops::FilterType::Triangle);
    let mut bgra = Vec::with_capacity((icon.width() * icon.height() * 4) as usize);
    for px in icon.as_raw().chunks_exact(4) {
        bgra.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
    }
    bmp_bytes(icon.width() as i32, icon.height() as i32, &bgra).ok()
}

fn plist_value(plist: &Path, key: &str) -> Option<String> {
    let output = Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg(format!("Print:{}", key))
        .arg(plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    non_empty(&String::from_utf8_lossy(&output.stdout))
}

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

    let (r, g, b) = pass(18, 60, 740)
        .or_else(|| pass(8, 50, 760))
        .or_else(|| pass(0, 40, 780))?;
    Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
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
            .unwrap_or(UNIX_EPOCH);
        for file in files {
            if file.modified < cutoff {
                let _ = fs::remove_file(file.path);
            }
        }
    }

    Ok(())
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
                modified: metadata.modified().unwrap_or(UNIX_EPOCH),
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

fn now_local_string() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
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

fn blacklist_path() -> PathBuf {
    settings_root().join("window-blacklist.json")
}

fn tracking_path() -> PathBuf {
    settings_root().join("tracking-settings.json")
}

fn default_screenshot_dir() -> PathBuf {
    if let Ok(path) = std::env::var("SLS_SCREENSHOT_DIR") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }

    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(product_storage_name())
        .join("Screenshots")
}

fn file_mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).ok().and_then(|m| m.modified().ok())
}

fn file_extension_for_format(format: &str) -> &'static str {
    match format {
        "png" => "png",
        "webp" => "webp",
        _ => "jpg",
    }
}

fn parse_time_secs(time: &str) -> Option<u64> {
    let mut parts = time.split(':');
    let h = parts.next()?.parse::<u64>().ok()?;
    let m = parts.next()?.parse::<u64>().ok()?;
    let s = parts
        .next()
        .and_then(|x| x.parse::<u64>().ok())
        .unwrap_or(0);
    if h < 24 && m < 60 && s < 60 {
        Some(h * 3600 + m * 60 + s)
    } else {
        None
    }
}

fn parse_screenshot_filename_secs(name: &str) -> Option<u64> {
    let stem = name.split('.').next()?;
    let time_part = stem.rsplit_once('_')?.1;
    let nums: Vec<u64> = time_part
        .split('-')
        .filter_map(|x| x.parse::<u64>().ok())
        .collect();
    if nums.len() == 3 && nums[0] < 24 && nums[1] < 60 && nums[2] < 60 {
        Some(nums[0] * 3600 + nums[1] * 60 + nums[2])
    } else {
        None
    }
}
