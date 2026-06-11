// ══════════════════════════════════════════════
// 专注锁后端
// · hosts 文件修改 → 把屏蔽域名重定向到 127.0.0.1
// · 本地 HTTP 服务器（端口 80）→ 返回品牌拦截页
// · 前台窗口监控（仅 Windows）→ 命中规则后最小化窗口
// ══════════════════════════════════════════════

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

// ── 拦截页 HTML ──────────────────────────────

const BLOCK_PAGE: &str = r#"<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>专注锁 — 已屏蔽</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#050505;color:#00E5FF;
      font-family:'Exo 2','Microsoft YaHei',sans-serif;
      display:flex;align-items:center;justify-content:center;min-height:100vh}
    .wrap{text-align:center;padding:56px 80px;
      background:rgba(2,8,24,0.82);
      border:1px solid rgba(0,229,255,0.35);
      clip-path:polygon(12px 0,calc(100% - 12px) 0,100% 12px,100% calc(100% - 12px),
        calc(100% - 12px) 100%,12px 100%,0 calc(100% - 12px),0 12px);
      box-shadow:0 0 40px rgba(0,229,255,0.07)}
    .icon{font-size:44px;margin-bottom:18px}
    h1{font-size:24px;font-weight:700;letter-spacing:.14em;
      text-shadow:0 0 18px rgba(0,229,255,0.55);margin-bottom:10px}
    .rule{width:56px;height:1px;background:rgba(0,229,255,0.3);margin:14px auto}
    p{color:rgba(0,229,255,0.55);font-size:13.5px;line-height:1.9}
    .host{margin-top:12px;font-size:11.5px;color:rgba(0,229,255,0.3);
      font-family:monospace;letter-spacing:.06em}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="icon">🔒</div>
    <h1>FOCUS LOCK ACTIVE</h1>
    <div class="rule"></div>
    <p>此网站已被 <strong>Solevup 专注锁</strong>屏蔽</p>
    <p>专注当下，完成任务</p>
    <p class="host" id="h"></p>
  </div>
  <script>document.getElementById('h').textContent=location.hostname</script>
</body>
</html>"#;

// ── 状态 ─────────────────────────────────────

#[derive(Clone)]
pub struct GroupData {
    pub websites: Vec<String>,
    pub exceptions: Vec<String>,
    pub apps: Vec<String>,
}

// ── 扩展共享状态（跨 focus_lock.rs ↔ api.rs ↔ NM host） ──
//
// 浏览器网站屏蔽改由 Chrome 扩展执行：桌面端是唯一规则源，把所有活跃组的
// 网站/例外聚合成快照，nm_host 轮询 HTTP 端点取走推给扩展。扩展心跳也回写这里。

#[derive(Clone, Default, serde::Serialize)]
pub struct FocusRulesSnapshot {
    pub revision: u64,
    pub websites: Vec<String>,
    pub exceptions: Vec<String>,
}

pub struct SharedFocusState {
    pub snapshot: FocusRulesSnapshot,
    /// 扩展最近一次心跳时间（Unix ms），0 = 从未上线
    pub last_ext_heartbeat_ms: i64,
}

static SHARED: std::sync::OnceLock<Arc<std::sync::Mutex<SharedFocusState>>> =
    std::sync::OnceLock::new();

pub fn shared() -> &'static Arc<std::sync::Mutex<SharedFocusState>> {
    SHARED.get_or_init(|| {
        Arc::new(std::sync::Mutex::new(SharedFocusState {
            snapshot: FocusRulesSnapshot::default(),
            last_ext_heartbeat_ms: 0,
        }))
    })
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把当前所有活跃组的网站/例外聚合进共享快照并 bump revision。
/// 在持有 active_groups 锁的调用点之后调用（传入已读出的组集合避免重复锁）。
fn publish_rules_snapshot(groups: &HashMap<String, GroupData>) {
    let mut websites: Vec<String> = Vec::new();
    let mut exceptions: Vec<String> = Vec::new();
    for g in groups.values() {
        websites.extend(g.websites.iter().cloned());
        exceptions.extend(g.exceptions.iter().cloned());
    }
    websites.sort();
    websites.dedup();
    exceptions.sort();
    exceptions.dedup();

    let mut shared = shared().lock().unwrap();
    shared.snapshot.revision = shared.snapshot.revision.wrapping_add(1);
    shared.snapshot.websites = websites;
    shared.snapshot.exceptions = exceptions;
}

#[derive(serde::Serialize)]
pub struct FocusExtStatus {
    /// 扩展是否在线（最近 12 秒内有心跳）
    pub connected: bool,
    pub last_heartbeat_ms: i64,
}

/// 面板挂载时的能力检测结果
#[derive(serde::Serialize)]
pub struct FocusLockCapability {
    pub hosts_writable: bool,
}

/// focus_lock_start 的结构化结果：部分能力失败不再静默吞掉
#[derive(serde::Serialize)]
pub struct FocusLockStartResult {
    pub hosts_ok: bool,
    pub hosts_error: Option<String>,
    pub block_page_ok: bool,
    pub block_page_error: Option<String>,
}

#[derive(Clone, Debug)]
struct FocusWindowInfo {
    pub app: String,
    pub title: String,
    pub pid: u32,
    pub exe_path: Option<String>,
}

pub struct FocusLockState {
    pub active_groups: Arc<Mutex<HashMap<String, GroupData>>>,
    server_shutdown_tx: Arc<std::sync::Mutex<Option<broadcast::Sender<()>>>>,
    watcher_abort: Arc<std::sync::Mutex<Option<tokio::task::AbortHandle>>>,
}

impl FocusLockState {
    pub fn new() -> Self {
        cleanup_all_hosts_entries();
        Self {
            active_groups: Arc::new(Mutex::new(HashMap::new())),
            server_shutdown_tx: Arc::new(std::sync::Mutex::new(None)),
            watcher_abort: Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

// ── Hosts 文件 ────────────────────────────────

fn hosts_path() -> PathBuf {
    #[cfg(windows)]
    return PathBuf::from(r"C:\Windows\System32\drivers\etc\hosts");
    #[cfg(not(windows))]
    return PathBuf::from("/etc/hosts");
}

const MARKER_PREFIX: &str = "solevup-block";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn tagged_entry(domain: &str) -> String {
    format!("127.0.0.1 {domain} # {MARKER_PREFIX}:{domain}")
}

#[cfg(windows)]
fn hidden_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn flush_dns_cache() {
    let _ = hidden_command("ipconfig").args(["/flushdns"]).output();
}

#[cfg(not(windows))]
fn flush_dns_cache() {}

fn add_hosts_entries(domains: &[String]) -> Result<(), String> {
    let path = hosts_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 hosts 失败（可能需要管理员权限）: {e}"))?;
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    for d in domains {
        let tag = format!("{MARKER_PREFIX}:{d}");
        if !lines.iter().any(|l| l.contains(&tag)) {
            lines.push(tagged_entry(d));
        }
        // 同时屏蔽 www 子域
        if !d.starts_with("www.") {
            let www = format!("www.{d}");
            let www_tag = format!("{MARKER_PREFIX}:{www}");
            if !lines.iter().any(|l| l.contains(&www_tag)) {
                lines.push(tagged_entry(&www));
            }
        }
    }

    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(&path, out)
        .map_err(|e| format!("写入 hosts 失败（可能需要管理员权限）: {e}"))?;

    flush_dns_cache();

    Ok(())
}

fn remove_hosts_entries(domains: &[String]) -> Result<(), String> {
    let path = hosts_path();
    let content = std::fs::read_to_string(&path).map_err(|e| format!("读取 hosts 失败: {e}"))?;

    let filtered: Vec<&str> = content
        .lines()
        .filter(|line| {
            !domains.iter().any(|d| {
                line.contains(&format!("{MARKER_PREFIX}:{d}"))
                    || line.contains(&format!("{MARKER_PREFIX}:www.{d}"))
            })
        })
        .collect();

    let mut out = filtered.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(&path, out).map_err(|e| format!("写入 hosts 失败: {e}"))?;

    flush_dns_cache();

    Ok(())
}

/// 清除所有 Solevup 留下的 hosts 条目（应用退出时兜底清理）
pub fn cleanup_all_hosts_entries() {
    let path = hosts_path();
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let filtered: Vec<&str> = content
        .lines()
        .filter(|l| !l.contains(MARKER_PREFIX))
        .collect();
    let mut out = filtered.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    let _ = std::fs::write(&path, out);
    flush_dns_cache();
}

// ── 本地 HTTP 拦截页服务器 ─────────────────────

async fn start_block_server() -> Result<broadcast::Sender<()>, String> {
    use axum::{response::Html, routing::any, Router};

    let app = Router::new().fallback(any(|| async { Html(BLOCK_PAGE) }));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:80")
        .await
        .map_err(|e| format!("绑定端口 80 失败（需要管理员权限才能提供拦截页）: {e}"))?;

    let (tx, mut rx) = broadcast::channel::<()>(1);

    tokio::spawn(async move {
        tokio::select! {
            _ = axum::serve(listener, app) => {}
            _ = rx.recv() => {}
        }
    });

    log::info!("[FocusLock] 拦截页服务器已启动 → http://127.0.0.1:80");
    Ok(tx)
}

// ── 前台窗口监控 ──────────────────────────────

/// 同一应用两次通知之间的最小间隔，防止用户反复点开时刷屏
const NOTIFY_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(10);

fn spawn_window_watcher(
    app_handle: tauri::AppHandle,
    active_groups: Arc<Mutex<HashMap<String, GroupData>>>,
) -> tokio::task::AbortHandle {
    tokio::spawn(async move {
        let mut last_notified: HashMap<String, std::time::Instant> = HashMap::new();

        loop {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            let blocked_apps: Vec<String> = {
                let groups = active_groups.lock().await;
                groups
                    .values()
                    .flat_map(|g| g.apps.iter().cloned())
                    .map(|a| a.to_lowercase())
                    .collect()
            };

            if blocked_apps.is_empty() {
                continue;
            }

            let Some(info) = minimize_matching_foreground_window(&blocked_apps) else {
                continue;
            };

            let now = std::time::Instant::now();
            let should_notify = match last_notified.get(&info.app) {
                Some(t) => now.duration_since(*t) >= NOTIFY_COOLDOWN,
                None => true,
            };
            if should_notify {
                last_notified.insert(info.app.clone(), now);
                notify_blocked(&app_handle, &info);
            }
        }
    })
    .abort_handle()
}

fn notify_blocked(app_handle: &tauri::AppHandle, info: &FocusWindowInfo) {
    use tauri_plugin_notification::NotificationExt;

    let body = if info.title.is_empty() {
        format!("「{}」已被专注锁最小化", info.app)
    } else {
        format!("「{}」已被专注锁最小化\n{}", info.app, info.title)
    };
    if let Err(e) = app_handle
        .notification()
        .builder()
        .title("专注锁 · 已拦截")
        .body(body)
        .show()
    {
        log::warn!("[FocusLock] 发送拦截通知失败: {e}");
    }
}

#[cfg(windows)]
fn current_foreground_window() -> Option<(windows_sys::Win32::Foundation::HWND, FocusWindowInfo)> {
    use std::path::Path;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let hwnd = unsafe { GetForegroundWindow() };
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
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "unknown".to_string());

    Some((
        hwnd,
        FocusWindowInfo {
            app,
            title,
            pid,
            exe_path,
        },
    ))
}

#[cfg(not(windows))]
fn current_foreground_window() -> Option<((), FocusWindowInfo)> {
    None
}

#[cfg(windows)]
fn window_title(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};

    let len = unsafe { GetWindowTextLengthW(hwnd) };
    let mut buf = vec![0u16; len.max(0) as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if copied < 0 {
        return None;
    }
    Some(
        String::from_utf16_lossy(&buf[..copied as usize])
            .trim()
            .to_string(),
    )
}

#[cfg(windows)]
fn window_pid(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<u32> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
    }
    if pid == 0 {
        None
    } else {
        Some(pid)
    }
}

#[cfg(windows)]
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

#[cfg(windows)]
fn minimize_matching_foreground_window(blocked_apps: &[String]) -> Option<FocusWindowInfo> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_MINIMIZE};

    let (hwnd, info) = current_foreground_window()?;

    // 豁免自身进程：规则误伤自己会导致主窗口被反复压下去，连停止按钮都点不到
    if info.pid == std::process::id() {
        return None;
    }

    if !focus_window_matches_rules(&info, blocked_apps) {
        return None;
    }

    unsafe {
        ShowWindow(hwnd, SW_MINIMIZE);
    }
    log::info!(
        "[FocusLock] 已最小化命中窗口 app={} pid={} title={}",
        info.app,
        info.pid,
        info.title
    );
    Some(info)
}

#[cfg(not(windows))]
fn minimize_matching_foreground_window(_blocked_apps: &[String]) -> Option<FocusWindowInfo> {
    None
}

// ── 扩展掉线阶梯惩罚 ──────────────────────────
//
// 自分发扩展无法在 Chrome UI 内禁止卸载（那需要 forcelist + 上架 CWS）。
// 退而求其次走 Cold Turkey 同款桌面侧执行循环：扩展被移除/禁用时心跳中断，
// 桌面端阶梯惩罚浏览器，让“删扩展逃避专注”不划算。

/// 受惩罚的浏览器进程名（与我们注册 NM host 的浏览器一致）
const BROWSER_PROCESSES: &[&str] = &["chrome.exe", "msedge.exe"];
/// 心跳中断超过此时长才判定“真掉线”开始压制。nm_host 主动保活扩展 SW 后心跳很稳，
/// 10s 足以区分“真被移除/禁用”，不会把正常停留误判成掉线。
const DETECT_GRACE_MS: i64 = 10_000;
/// 压制期间的轮询间隔：足够密，浏览器一被拉到前台就立刻被弹回最小化
const PUNISH_TICK: std::time::Duration = std::time::Duration::from_millis(300);
/// 空闲（未掉线）时的轮询间隔，省开销
const IDLE_TICK: std::time::Duration = std::time::Duration::from_millis(1500);
const ENFORCE_NOTIFY_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(12);

/// 常驻惩罚监控：随 app 启动，内部判断是否处于“应惩罚”状态，空闲时近乎零开销
pub fn spawn_enforcement_watcher(app_handle: tauri::AppHandle) {
    // 用 Tauri 的 async runtime spawn：本函数在 setup() 同步上下文里调用，
    // 直接 tokio::spawn 会因主线程没有 reactor 而 panic
    tauri::async_runtime::spawn(async move {
        let mut last_notify: Option<std::time::Instant> = None;
        loop {
            // has_web: 当前有激活的网站屏蔽组
            // ever: 本会话扩展曾连上过（否则用户根本没装扩展，不该惩罚，走 hosts 兜底）
            // gap_ms: 距上次心跳的时长
            let (has_web, ever, gap_ms) = {
                let s = shared().lock().unwrap();
                (
                    !s.snapshot.websites.is_empty(),
                    s.last_ext_heartbeat_ms > 0,
                    now_ms() - s.last_ext_heartbeat_ms,
                )
            };

            let punishing = has_web && ever && gap_ms >= DETECT_GRACE_MS;
            if !punishing {
                last_notify = None;
                tokio::time::sleep(IDLE_TICK).await;
                continue;
            }

            // 掉线压制：浏览器一被拉到前台就立刻弹回最小化，让它没法用（不关进程）
            minimize_browser_foreground();
            if last_notify.map_or(true, |t| t.elapsed() >= ENFORCE_NOTIFY_COOLDOWN) {
                log::warn!("[FocusLock] 扩展掉线 {}s，持续最小化浏览器", gap_ms / 1000);
                notify_enforcement(&app_handle);
                last_notify = Some(std::time::Instant::now());
            }
            tokio::time::sleep(PUNISH_TICK).await;
        }
    });
}

fn notify_enforcement(app_handle: &tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app_handle
        .notification()
        .builder()
        .title("专注锁 · 浏览器已锁定")
        .body("检测到专注锁扩展被移除或禁用，浏览器将被持续最小化。请重新启用扩展以恢复。")
        .show();
}

#[cfg(windows)]
fn minimize_browser_foreground() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_MINIMIZE};
    let Some((hwnd, info)) = current_foreground_window() else {
        return;
    };
    let app = info.app.to_lowercase();
    if BROWSER_PROCESSES.iter().any(|b| app == *b) {
        unsafe {
            ShowWindow(hwnd, SW_MINIMIZE);
        }
    }
}

#[cfg(not(windows))]
fn minimize_browser_foreground() {}

fn focus_window_matches_rules(info: &FocusWindowInfo, rules: &[String]) -> bool {
    let app = info.app.to_lowercase();
    let title = info.title.to_lowercase();
    let path = info
        .exe_path
        .as_deref()
        .unwrap_or_default()
        .replace('/', "\\")
        .to_lowercase();

    rules.iter().any(|raw| {
        let rule = raw.trim().replace('/', "\\").to_lowercase();
        if rule.is_empty() {
            return false;
        }
        if let Some((rule_app, rule_title)) = parse_window_rule(&rule) {
            return app == rule_app && title == rule_title;
        }
        if let Some(keyword) = rule.strip_prefix("title:") {
            return !keyword.trim().is_empty() && title.contains(keyword.trim());
        }
        if rule.ends_with(".exe") && !rule.contains('\\') {
            return app == rule;
        }
        path == rule || path.contains(&rule)
    })
}

fn parse_window_rule(rule: &str) -> Option<(String, String)> {
    let mut parts = rule.splitn(3, '|');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("window"), Some(app), Some(title))
            if !app.trim().is_empty() && !title.trim().is_empty() =>
        {
            Some((app.trim().to_lowercase(), title.trim().to_lowercase()))
        }
        _ => None,
    }
}

// ── Tauri 命令 ────────────────────────────────

/// 检测专注锁依赖的系统能力（目前只有 hosts 可写性）。
/// 用追加模式打开但不写入：成功即说明有写权限，文件内容不动。
#[tauri::command]
pub fn focus_lock_check_capability() -> FocusLockCapability {
    let hosts_writable = std::fs::OpenOptions::new()
        .append(true)
        .open(hosts_path())
        .is_ok();
    FocusLockCapability { hosts_writable }
}

#[tauri::command]
pub async fn focus_lock_start(
    group_id: String,
    websites: Vec<String>,
    exceptions: Vec<String>,
    apps: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<FocusLockState>>,
) -> Result<FocusLockStartResult, String> {
    // 1. 修改 hosts：失败不中止流程（应用屏蔽仍可生效），但要把错误带回前端
    let mut hosts_ok = true;
    let mut hosts_error = None;
    if !websites.is_empty() {
        if let Err(e) = add_hosts_entries(&websites) {
            log::warn!("[FocusLock] hosts 写入失败: {e}");
            hosts_ok = false;
            hosts_error = Some(e);
        }
    }

    // 2. 启动拦截页服务器（幂等，只在首次成功绑定时创建；只在有网站规则时需要）
    // 先在 sync guard 内检查是否需要启动，guard 释放后再 await，避免跨 await 持有 MutexGuard
    let mut block_page_ok = true;
    let mut block_page_error = None;
    if !websites.is_empty() {
        let needs_server = state.server_shutdown_tx.lock().unwrap().is_none();
        if needs_server {
            match start_block_server().await {
                Ok(tx) => {
                    let mut guard = state.server_shutdown_tx.lock().unwrap();
                    if guard.is_none() {
                        *guard = Some(tx);
                    }
                }
                Err(e) => {
                    // 端口 80 绑定失败：域名仍被重定向，只是看不到自定义拦截页
                    log::warn!("[FocusLock] 拦截页服务器未能启动: {e}");
                    block_page_ok = false;
                    block_page_error = Some(e);
                }
            }
        }
    }

    // 3. 记录活跃组 + 首次激活时启动前台窗口监控 + 发布规则快照给扩展
    let is_first = {
        let mut groups = state.active_groups.lock().await;
        let first = groups.is_empty();
        groups.insert(group_id, GroupData { websites, exceptions, apps });
        publish_rules_snapshot(&groups);
        first
    };

    if is_first {
        let groups_ref = state.active_groups.clone();
        let handle = spawn_window_watcher(app_handle, groups_ref);
        *state.watcher_abort.lock().unwrap() = Some(handle);
    }

    Ok(FocusLockStartResult {
        hosts_ok,
        hosts_error,
        block_page_ok,
        block_page_error,
    })
}

#[tauri::command]
pub async fn focus_lock_stop(
    group_id: String,
    state: tauri::State<'_, Arc<FocusLockState>>,
) -> Result<(), String> {
    // 引用计数：仍被其他活跃组屏蔽的域名不能从 hosts 里移除，
    // 否则停掉 A 组会悄悄解除 B 组对同一域名的屏蔽
    let websites_to_remove = {
        let mut groups = state.active_groups.lock().await;
        let removed = groups.remove(&group_id).map(|g| {
            let still_used: std::collections::HashSet<String> = groups
                .values()
                .flat_map(|other| other.websites.iter())
                .map(|d| d.to_lowercase())
                .collect();
            // remove_hosts_entries 会连带删 www. 变体，所以裸域和 www. 域互相算引用
            g.websites
                .into_iter()
                .filter(|d| {
                    let dl = d.to_lowercase();
                    let www = format!("www.{dl}");
                    let bare = dl.strip_prefix("www.").map(|s| s.to_string());
                    !still_used.contains(&dl)
                        && !still_used.contains(&www)
                        && !bare.is_some_and(|b| still_used.contains(&b))
                })
                .collect::<Vec<_>>()
        });
        // 重新发布快照：扩展据此撤掉本组的网站/例外规则
        publish_rules_snapshot(&groups);
        removed
    };

    if let Some(ref domains) = websites_to_remove {
        if !domains.is_empty() {
            if let Err(e) = remove_hosts_entries(domains) {
                log::warn!("[FocusLock] hosts 清理失败: {e}");
            }
        }
    }

    // 所有组停了 → 关闭服务器 + 前台窗口监控
    let all_done = state.active_groups.lock().await.is_empty();
    if all_done {
        if let Some(tx) = state.server_shutdown_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        if let Some(handle) = state.watcher_abort.lock().unwrap().take() {
            handle.abort();
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn focus_lock_get_active(
    state: tauri::State<'_, Arc<FocusLockState>>,
) -> Result<Vec<String>, String> {
    Ok(state.active_groups.lock().await.keys().cloned().collect())
}

/// 扩展是否在线：最近 12 秒内有心跳即视为连接正常（nm_host 每 3 秒一次心跳）
#[tauri::command]
pub fn focus_lock_ext_status() -> FocusExtStatus {
    let last = shared().lock().unwrap().last_ext_heartbeat_ms;
    FocusExtStatus {
        connected: last > 0 && now_ms() - last < 12_000,
        last_heartbeat_ms: last,
    }
}

// ── Native Messaging host 注册 ────────────────
//
// Chrome 通过注册表项 HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\<name>
// 找到 host manifest（JSON），manifest 里 path 指向 nm_host 可执行文件、
// allowed_origins 限定只有我们的扩展能拉起它。应用每次启动时幂等重写。

const NM_HOST_NAME: &str = "com.solevup.focus_lock";
const EXT_ID: &str = "knbkioiabiimidnneneoefmkgdpiphof";

/// 在应用启动时调用：写 NM host manifest + 注册表项。失败只 warn（扩展功能降级）。
pub fn register_native_host() {
    let exe_dir = match std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        Some(d) => d,
        None => {
            log::warn!("[FocusLock] 无法定位可执行目录，跳过 NM host 注册");
            return;
        }
    };

    let host_exe = exe_dir.join(if cfg!(windows) { "nm_host.exe" } else { "nm_host" });
    let manifest_path = exe_dir.join("com.solevup.focus_lock.json");

    let manifest = serde_json::json!({
        "name": NM_HOST_NAME,
        "description": "Solevup 专注锁 Native Messaging host",
        "path": host_exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXT_ID}/")],
    });

    if let Err(e) = std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap_or_default()) {
        log::warn!("[FocusLock] 写 NM host manifest 失败: {e}");
        return;
    }

    #[cfg(windows)]
    register_native_host_registry(&manifest_path);

    log::info!("[FocusLock] NM host 已注册: {}", manifest_path.to_string_lossy());
}

#[cfg(windows)]
fn register_native_host_registry(manifest_path: &std::path::Path) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // Chrome 与 Edge 用各自的 NativeMessagingHosts 根，两边都写一份
    for vendor in ["Google\\Chrome", "Microsoft\\Edge"] {
        let key_path = format!("SOFTWARE\\{vendor}\\NativeMessagingHosts\\{NM_HOST_NAME}");
        match hkcu.create_subkey(&key_path) {
            Ok((key, _)) => {
                if let Err(e) = key.set_value("", &manifest_path.to_string_lossy().to_string()) {
                    log::warn!("[FocusLock] 写注册表 {key_path} 失败: {e}");
                }
            }
            Err(e) => log::warn!("[FocusLock] 创建注册表项 {key_path} 失败: {e}"),
        }
    }
}
