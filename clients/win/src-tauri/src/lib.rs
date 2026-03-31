// ══════════════════════════════════════════════
// Solo Agent — Tauri 后端入口
// ══════════════════════════════════════════════

mod db;
mod api;
mod fish_tts;

use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use fish_tts::{FishTTSConfig, FishTTSConnection};
use db::Database;

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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|app| {
            // 启动 HTTP 服务器（在 Tauri runtime 内）
            if let Some(db_clone) = db {
                tauri::async_runtime::spawn(async move {
                    api::start_server(db_clone, 3000).await;
                });
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            log::info!("[App] Solo Agent 启动完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fish_tts_connect,
            fish_tts_send_text,
            fish_tts_flush,
            fish_tts_stop,
            get_db_info,
            migrate_database,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}