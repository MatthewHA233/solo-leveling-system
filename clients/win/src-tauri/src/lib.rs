// ══════════════════════════════════════════════
// Solo Agent — Tauri 后端入口
// ══════════════════════════════════════════════

mod db;
mod api;
mod fish_tts;
mod manictime;

use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use fish_tts::{FishTTSConfig, FishTTSConnection};
use db::Database;
use api::BiliState;
use tauri::Manager;

// ── 全局状态 ──

struct AppState {
    fish_tts: Arc<Mutex<Option<FishTTSConnection>>>,
    db: Arc<RwLock<Option<Arc<Database>>>>,
    db_path: Arc<RwLock<String>>,
}

// ── Tauri 命令 ──

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

    win.eval(&js).map_err(|e| e.to_string())?;

    let raw = match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
        Ok(Ok(result)) => result?,
        Ok(Err(_)) => return Err("请求已取消".to_string()),
        Err(_) => return Err("请求超时".to_string()),
    };

    // 提取 cursor（供前端加载更早历史时使用）
    let cursor_max_out  = raw.get("data").and_then(|d| d.get("cursor")).and_then(|c| c.get("max")).and_then(|v| v.as_i64()).unwrap_or(0);
    let cursor_vat_out  = raw.get("data").and_then(|d| d.get("cursor")).and_then(|c| c.get("view_at")).and_then(|v| v.as_i64()).unwrap_or(0);
    let upserted        = raw.get("data").and_then(|d| d.get("list")).and_then(|l| l.as_array()).map(|a| a.len()).unwrap_or(0);

    Ok(BiliSyncResult { upserted, cursor_max: cursor_max_out, cursor_view_at: cursor_vat_out })
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
        db: Arc::new(RwLock::new(db.clone())),
        db_path: Arc::new(RwLock::new(db_path)),
    });

    let bili_state = Arc::new(BiliState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(bili_state.clone())
        .setup(move |app| {
            // 启动 HTTP 服务器（在 Tauri runtime 内）
            if let Some(db_clone) = db {
                let bili_clone = bili_state.clone();
                tauri::async_runtime::spawn(async move {
                    api::start_server(db_clone, bili_clone, 3000).await;
                });
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
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

            log::info!("[App] Solo Agent 启动完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_url_in_browser,
            fish_tts_connect,
            fish_tts_send_text,
            fish_tts_flush,
            fish_tts_stop,
            get_db_info,
            migrate_database,
            open_bili_login,
            fetch_bili_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}