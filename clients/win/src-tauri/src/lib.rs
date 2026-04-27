// ══════════════════════════════════════════════
// Solo Agent — Tauri 后端入口
// ══════════════════════════════════════════════

use tauri::Emitter;

mod db;
mod api;
mod fish_tts;
mod manictime;
mod qwen_asr;
mod qwen_omni;
mod bili_download;
#[cfg(windows)]
mod hotkey;

use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use fish_tts::{FishTTSConfig, FishTTSConnection};
use db::Database;
use api::BiliState;
use bili_download::BiliDownloadState;
use tauri::Manager;
use base64::Engine as _;

// ── 全局状态 ──

struct AppState {
    fish_tts: Arc<Mutex<Option<FishTTSConnection>>>,
    omni: qwen_omni::OmniState,
    db: Arc<RwLock<Option<Arc<Database>>>>,
    db_path: Arc<RwLock<String>>,
}

// ── Tauri 命令 ──

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn fish_tts_connect(
    api_key: String,
    reference_id: String,
    sample_rate: u32,
    proxy_port: u16,
    model: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let config = FishTTSConfig {
        api_key,
        reference_id,
        sample_rate,
        proxy_port,
        model,
    };

    let conn = FishTTSConnection::start(config, app_handle)?;

    let mut guard = state.fish_tts.lock().await;
    *guard = Some(conn);

    log::info!("[FishTTS] 连接已建立");
    Ok(())
}

#[tauri::command]
async fn fish_tts_send_text(
    text: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.fish_tts.lock().await;
    if let Some(conn) = guard.as_ref() {
        conn.send_text(text).await
    } else {
        Err("Fish TTS 未连接".to_string())
    }
}

#[tauri::command]
async fn fish_tts_flush(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.fish_tts.lock().await;
    if let Some(conn) = guard.as_ref() {
        conn.flush().await
    } else {
        Err("Fish TTS 未连接".to_string())
    }
}

#[tauri::command]
async fn fish_tts_stop(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut guard = state.fish_tts.lock().await;
    if let Some(conn) = guard.take() {
        conn.stop().await
    } else {
        Ok(())
    }
}

// ── B站命令 ──

#[tauri::command]
async fn open_bili_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("bili-login") {
        // 窗口已存在（后台隐藏中），显示并聚焦让用户登录
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    } else {
        // 极少数情况（窗口被关掉了），重新创建并显示
        tauri::WebviewWindowBuilder::new(
            &app,
            "bili-login",
            tauri::WebviewUrl::External(
                "https://www.bilibili.com".parse().map_err(|e: url::ParseError| e.to_string())?
            ),
        )
        .title("B站 — 登录后可关闭此窗口")
        .inner_size(1200.0, 800.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct BiliSyncResult {
    upserted: usize,
    cursor_max: i64,
    cursor_view_at: i64,
    items: Vec<BiliSyncItem>,
}

#[derive(serde::Serialize)]
struct BiliSyncItem {
    bvid: String,
    cover: String,
    view_at: i64,
    title: String,
    author_name: String,
    progress: i64,   // -1 = 看完哨兵 / 0 = 点开 / 正数 = 已看秒数
    duration: i64,   // 视频总时长（秒）
}

#[derive(serde::Serialize)]
struct BiliNavInfo {
    is_login: bool,
    uname: Option<String>,
    mid: Option<i64>,
}

#[tauri::command]
async fn bili_get_nav(
    app: tauri::AppHandle,
    bili: tauri::State<'_, Arc<BiliState>>,
) -> Result<BiliNavInfo, String> {
    // 窗口不存在 → 返回错误，让前端保留之前的判定（不要把"窗口被关"误判为"已登出"）
    let win = app.get_webview_window("bili-login")
        .ok_or_else(|| "BILI_WIN_NOT_OPEN".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = bili.pending_nav.lock().await;
        if guard.is_some() {
            // 已有 nav 请求在飞 → 不要覆盖（覆盖会让旧请求拿到 Err"请求已取消"）
            return Err("BILI_NAV_BUSY".to_string());
        }
        *guard = Some(tx);
    }

    let js = r#"(async()=>{
try{
  const r=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'});
  const d=await r.json();
  await fetch('http://localhost:3000/api/bilibili/nav_result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ok:d})});
}catch(e){
  await fetch('http://localhost:3000/api/bilibili/nav_result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:e.message||String(e)})});
}
})();"#;

    if let Err(e) = win.eval(js) {
        // eval 失败时清掉占位，避免后续请求一直拿到 BUSY
        bili.pending_nav.lock().await.take();
        return Err(e.to_string());
    }

    let raw = match tokio::time::timeout(std::time::Duration::from_secs(8), rx).await {
        Ok(Ok(result)) => result?,
        Ok(Err(_)) => {
            bili.pending_nav.lock().await.take();
            return Err("BILI_NAV_BUSY".to_string());
        }
        Err(_) => {
            bili.pending_nav.lock().await.take();
            return Err("请求超时".to_string());
        }
    };

    let data = raw.get("data");
    let is_login = data.and_then(|d| d.get("isLogin")).and_then(|v| v.as_bool()).unwrap_or(false);
    let uname    = data.and_then(|d| d.get("uname")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let mid      = data.and_then(|d| d.get("mid")).and_then(|v| v.as_i64());

    Ok(BiliNavInfo { is_login, uname, mid })
}

#[tauri::command]
async fn fetch_bili_history(
    app: tauri::AppHandle,
    bili: tauri::State<'_, Arc<BiliState>>,
    ps: Option<u32>,
    cursor_max: Option<i64>,
    cursor_view_at: Option<i64>,
) -> Result<BiliSyncResult, String> {
    let win = app.get_webview_window("bili-login")
        .ok_or_else(|| "BILI_WIN_CLOSED".to_string())?;

    let ps  = ps.unwrap_or(20).min(50);
    let max = cursor_max.unwrap_or(0);
    let vat = cursor_view_at.unwrap_or(0);

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = bili.pending.lock().await;
        if guard.is_some() {
            // 已有 history 请求在飞 → 拒绝新请求（覆盖会让旧请求拿到 Err"请求已取消"）
            return Err("BILI_HISTORY_BUSY".to_string());
        }
        *guard = Some(tx);
    }

    let js = format!(
        r#"(async()=>{{
try{{
  const r=await fetch('https://api.bilibili.com/x/web-interface/history/cursor?max={max}&view_at={vat}&ps={ps}&business=archive',{{credentials:'include'}});
  const d=await r.json();
  await fetch('http://localhost:3000/api/bilibili/result',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{ok:d}})}});
}}catch(e){{
  await fetch('http://localhost:3000/api/bilibili/result',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{error:e.message||String(e)}})}});
}}
}})();"#
    );

    if let Err(e) = win.eval(&js) {
        bili.pending.lock().await.take();
        return Err(e.to_string());
    }

    let raw = match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
        Ok(Ok(result)) => result?,
        Ok(Err(_)) => {
            bili.pending.lock().await.take();
            return Err("BILI_HISTORY_BUSY".to_string());
        }
        Err(_) => {
            bili.pending.lock().await.take();
            return Err("请求超时".to_string());
        }
    };

    // 提取 cursor（供前端加载更早历史时使用）
    let cursor_max_out  = raw.get("data").and_then(|d| d.get("cursor")).and_then(|c| c.get("max")).and_then(|v| v.as_i64()).unwrap_or(0);
    let cursor_vat_out  = raw.get("data").and_then(|d| d.get("cursor")).and_then(|c| c.get("view_at")).and_then(|v| v.as_i64()).unwrap_or(0);
    let list_arr        = raw.get("data").and_then(|d| d.get("list")).and_then(|l| l.as_array());
    let upserted        = list_arr.map(|a| a.len()).unwrap_or(0);

    // 把这一页里的 bvid + 封面 + view_at + 标题 + UP主 + 进度 + 时长 抽出来回传给前端（深度扫描瀑布卡片）
    let items: Vec<BiliSyncItem> = list_arr
        .map(|a| {
            a.iter().filter_map(|it| {
                let history = it.get("history");
                let bvid = history.and_then(|h| h.get("bvid")).and_then(|v| v.as_str()).map(|s| s.to_string())?;
                let cover = it.get("cover").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let view_at = it.get("view_at").and_then(|v| v.as_i64()).unwrap_or(0);
                let title = it.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let author_name = it.get("author_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let progress = it.get("progress").and_then(|v| v.as_i64()).unwrap_or(0);
                let duration = it.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
                Some(BiliSyncItem { bvid, cover, view_at, title, author_name, progress, duration })
            }).collect()
        })
        .unwrap_or_default();

    Ok(BiliSyncResult { upserted, cursor_max: cursor_max_out, cursor_view_at: cursor_vat_out, items })
}

// ── 数据库命令 ──

#[tauri::command]
async fn get_db_info(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DbInfo, String> {
    let path = state.db_path.read().await.clone();

    let size = {
        let db_guard = state.db.read().await;
        if let Some(db) = db_guard.as_ref() {
            db.get_db_size().unwrap_or(0)
        } else {
            0
        }
    };

    Ok(DbInfo { path, size })
}

#[derive(serde::Serialize)]
struct DbInfo {
    path: String,
    size: u64,
}

#[tauri::command]
async fn open_url_in_browser(url: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn migrate_database(
    new_path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    log::info!("[Database] 收到迁移请求: {}", new_path);

    // 获取旧数据库
    let old_db = {
        let db_guard = state.db.read().await;
        db_guard.as_ref()
            .ok_or("数据库未初始化")?
            .clone()
    };

    let new_data_dir = std::path::PathBuf::from(&new_path);

    // 执行迁移
    let new_db = Database::migrate_to(new_data_dir, &old_db)?;
    let new_db_path = new_db.get_db_path().to_string_lossy().to_string();

    // 更新状态
    {
        let mut db_guard = state.db.write().await;
        *db_guard = Some(Arc::new(new_db));
    }

    {
        let mut path_guard = state.db_path.write().await;
        *path_guard = new_db_path.clone();
    }

    log::info!("[Database] 迁移完成: {}", new_db_path);
    Ok(new_db_path)
}

// ── B 站视频资产 ──

#[tauri::command]
async fn get_bili_assets_by_bvid(
    bvid: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::BiliVideoAsset>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.get_bili_assets_by_bvid(&bvid).await
}

#[tauri::command]
async fn get_recent_bili_assets(
    limit: Option<i64>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::BiliVideoAsset>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.get_recent_bili_assets(limit.unwrap_or(50)).await
}

// ── Qwen Omni Realtime 命令 ──

#[tauri::command]
async fn omni_connect(
    api_key: String,
    model: String,
    voice: String,
    system_prompt: String,
    tools: Option<serde_json::Value>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // 关闭旧连接
    {
        let mut guard = state.omni.lock().await;
        if let Some(old) = guard.take() {
            old.stop();
        }
    }

    let tools_val = tools.unwrap_or_else(|| serde_json::json!([]));
    let session = qwen_omni::connect(api_key, model, voice, system_prompt, tools_val, app_handle).await?;

    let mut guard = state.omni.lock().await;
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
async fn omni_send_audio(
    pcm_base64: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(&pcm_base64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let guard = state.omni.lock().await;
    if let Some(session) = guard.as_ref() {
        session.send_audio(&pcm);
        Ok(())
    } else {
        Err("Omni 未连接".to_string())
    }
}

#[tauri::command]
async fn omni_commit(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.omni.lock().await;
    if let Some(session) = guard.as_ref() {
        session.commit();
        Ok(())
    } else {
        Err("Omni 未连接".to_string())
    }
}

#[tauri::command]
async fn omni_send_text(
    text: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.omni.lock().await;
    if let Some(session) = guard.as_ref() {
        session.send_text(&text);
        Ok(())
    } else {
        Err("Omni 未连接".to_string())
    }
}

#[tauri::command]
async fn omni_stop(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut guard = state.omni.lock().await;
    if let Some(session) = guard.take() {
        session.stop();
    }
    Ok(())
}

#[tauri::command]
async fn omni_tool_result(
    call_id: String,
    output: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.omni.lock().await;
    if let Some(session) = guard.as_ref() {
        session.send_tool_result(&call_id, &output);
        Ok(())
    } else {
        Err("Omni 未连接".to_string())
    }
}

// ── Fairy 子窗口 ──

/// 获取系统光标物理像素坐标（仅内部使用）
#[cfg(windows)]
fn cursor_pos_phys() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut pt) } != 0 { Some((pt.x, pt.y)) } else { None }
}

/// JS 创建完 fairy-window 后调用此命令，启动 Rust 侧光标监控
/// （JS 创建保证 Tauri IPC bridge 正常注入，Rust 监控保证点击穿透精准）
#[tauri::command]
async fn setup_fairy(app: tauri::AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("fairy-window")
        .ok_or_else(|| "fairy-window not found".to_string())?;

    log::info!("[Fairy] setup_fairy 已调用，启动光标监控");

    #[cfg(windows)]
    {
        let win_clone = win.clone();
        let _ = win_clone.set_ignore_cursor_events(true);
        tauri::async_runtime::spawn(async move {
            let mut prev_ignore = true;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;

                let Some((cx, cy)) = cursor_pos_phys() else { continue };
                let (outer, sf) = match (win_clone.outer_position(), win_clone.scale_factor()) {
                    (Ok(p), Ok(s)) => (p, s),
                    _ => break, // 窗口已关闭
                };

                // 窗口 280×280 logical，fairy-core 400×400 缩放 0.7 = 280px
                // 圆心 = (140, 140) logical px from window origin，r = 140
                let fairy_cx = outer.x as f64 + 140.0 * sf;
                let fairy_cy = outer.y as f64 + 140.0 * sf;
                let fairy_r  = 140.0 * sf;

                let dx = cx as f64 - fairy_cx;
                let dy = cy as f64 - fairy_cy;
                let should_ignore = dx * dx + dy * dy > fairy_r * fairy_r;

                if should_ignore != prev_ignore {
                    prev_ignore = should_ignore;
                    let _ = win_clone.set_ignore_cursor_events(should_ignore);
                }
            }
            log::info!("[Fairy] 光标监控退出");
        });
    }

    Ok(())
}

// ── 音频文件持久化 ──

/// 返回音频根目录（{data_local}/solo-agent/audio/）
fn audio_root() -> std::path::PathBuf {
    Database::default_data_dir().join("audio")
}

/// 保存一条语音消息 WAV 到磁盘（接收原始字节，无需 base64）
/// 返回相对路径 "{session_id}/{filename}"，供 DB 存储
#[tauri::command]
async fn save_audio_file(
    session_id: String,
    wav_bytes: Vec<u8>,
    timestamp: String,
) -> Result<String, String> {
    let safe_ts = timestamp.replace([':', '.'], "-");
    let filename = format!("{}.wav", safe_ts);

    let dir = audio_root().join(&session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let file_path = dir.join(&filename);
    std::fs::write(&file_path, &wav_bytes).map_err(|e| format!("写入失败: {}", e))?;

    Ok(format!("{}/{}", session_id, filename))
}

/// 返回音频根目录的绝对路径（前端用于拼接 asset:// URL）
#[tauri::command]
fn get_audio_dir() -> String {
    audio_root().to_string_lossy().into_owned()
}

// ── 文件操作命令（供 AI 工具调用） ──

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    // 如父目录不存在则创建
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("写入失败: {}", e))
}

// ── 入口 ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化数据库
    let app_data_dir = Database::default_data_dir();
    let db = match Database::new(app_data_dir.clone()) {
        Ok(d) => Some(Arc::new(d)),
        Err(e) => {
            log::error!("[App] 数据库初始化失败: {}", e);
            None
        }
    };

    let db_path = db.as_ref()
        .map(|d| d.get_db_path().to_string_lossy().to_string())
        .unwrap_or_default();

    let state = Arc::new(AppState {
        fish_tts: Arc::new(Mutex::new(None)),
        omni: Arc::new(Mutex::new(None)),
        db: Arc::new(RwLock::new(db.clone())),
        db_path: Arc::new(RwLock::new(db_path)),
    });

    let bili_state = Arc::new(BiliState::new());
    let bili_dl_state = Arc::new(BiliDownloadState::new());

    // 把 DB 注入到下载状态（用于写资产表）
    if let Some(db_for_dl) = db.clone() {
        let dl = bili_dl_state.clone();
        tauri::async_runtime::block_on(async move {
            dl.set_db(db_for_dl).await;
        });
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例运行时，聚焦主窗口
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(bili_state.clone())
        .manage(bili_dl_state.clone())
        .setup(move |app| {
            // 启动 HTTP 服务器（在 Tauri runtime 内）
            if let Some(db_clone) = db {
                let bili_clone = bili_state.clone();
                let bili_dl_clone = bili_dl_state.clone();
                tauri::async_runtime::spawn(async move {
                    api::start_server(db_clone, bili_clone, bili_dl_clone, 3000).await;
                });
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Debug)
                        .build(),
                )?;
            }
            // 启动时在后台静默创建 bilibili WebView（隐藏窗口）
            // WebView2 会复用之前的登录 session（cookies 持久化在用户 profile 目录）
            let bili_win = tauri::WebviewWindowBuilder::new(
                app,
                "bili-login",
                tauri::WebviewUrl::External(
                    "https://www.bilibili.com".parse().expect("valid url")
                ),
            )
            .title("B站 — 登录后可关闭此窗口")
            .inner_size(1200.0, 800.0)
            .visible(false)   // 后台隐藏，不打扰用户
            .build();

            match bili_win {
                Ok(_) => log::info!("[Bili] 后台 WebView 已创建"),
                Err(e) => log::warn!("[Bili] 后台 WebView 创建失败: {}", e),
            }

            // 全局右 Alt 热键（push-to-talk，无论哪个窗口聚焦都生效）
            #[cfg(windows)]
            hotkey::install(app.handle().clone());

            // 系统托盘
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::TrayIconBuilder;

            let show_item = MenuItemBuilder::new("显示主窗口").id("tray_show").build(app)?;
            let quit_item = MenuItemBuilder::new("退出").id("tray_quit").build(app)?;
            let menu = MenuBuilder::new(app).item(&show_item).item(&quit_item).build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("SOLO LEVELING SYSTEM")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray_show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "tray_quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            log::info!("[App] Solo Agent 启动完成");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("main-close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            exit_app,
            open_url_in_browser,
            fish_tts_connect,
            fish_tts_send_text,
            fish_tts_flush,
            fish_tts_stop,
            omni_connect,
            omni_send_audio,
            omni_send_text,
            omni_commit,
            omni_stop,
            omni_tool_result,
            get_db_info,
            migrate_database,
            open_bili_login,
            fetch_bili_history,
            bili_get_nav,
            bili_download::enqueue_bili_download,
            bili_download::probe_bili_qualities,
            get_bili_assets_by_bvid,
            get_recent_bili_assets,
            qwen_asr::qwen_asr_transcribe,
            read_file,
            write_file,
            save_audio_file,
            get_audio_dir,
            setup_fairy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}