// ══════════════════════════════════════════════
// 网络设置（齿轮页「网络代理」）：所有需要走代理的请求共用这一个端口（Anthropic、Fish TTS …）
//   GET /api/network/settings   当前设置
//   PUT /api/network/settings   改端口 { proxy_port }
//   存本地库一行；没设过 = 7890（Clash 默认端口）
// ══════════════════════════════════════════════

use axum::{extract::State, response::Json, routing::get, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::api::{ApiResponse, ApiState};
use crate::db::Database;

pub const DEFAULT_PROXY_PORT: u16 = 7890;

#[derive(Debug, Clone, Serialize)]
pub struct NetworkSettings {
    pub proxy_port: u16,
    /// 没保存过 = None（用的是默认端口）
    pub updated_at: Option<String>,
}

/// 代理地址：只走本机代理软件（Clash 之类）
pub fn proxy_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub(crate) fn init_network_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS network_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            proxy_port INTEGER NOT NULL DEFAULT 7890,
            updated_at TEXT NOT NULL
        );
    "#).map_err(|e| format!("创建网络设置表失败: {}", e))
}

fn clamp_port(p: i64) -> u16 {
    if (1..=65535).contains(&p) { p as u16 } else { DEFAULT_PROXY_PORT }
}

impl Database {
    pub async fn network_settings(&self) -> Result<NetworkSettings, String> {
        let conn = self.conn.lock().await;
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT proxy_port, updated_at FROM network_settings WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(match row {
            Some((port, updated)) => NetworkSettings { proxy_port: clamp_port(port), updated_at: Some(updated) },
            None => NetworkSettings { proxy_port: DEFAULT_PROXY_PORT, updated_at: None },
        })
    }

    pub async fn network_settings_update(&self, proxy_port: i64) -> Result<NetworkSettings, String> {
        if !(1..=65535).contains(&proxy_port) {
            return Err("端口要在 1~65535 之间".to_string());
        }
        let conn = self.conn.lock().await;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO network_settings (id, proxy_port, updated_at) VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET proxy_port = excluded.proxy_port, updated_at = excluded.updated_at",
            params![proxy_port, &now],
        )
        .map_err(|e| e.to_string())?;
        Ok(NetworkSettings { proxy_port: proxy_port as u16, updated_at: Some(now) })
    }
}

pub fn routes() -> Router<ApiState> {
    Router::new().route("/api/network/settings", get(get_settings).put(put_settings))
}

#[derive(Deserialize)]
struct PutBody {
    proxy_port: i64,
}

fn reply<T: Serialize>(r: Result<T, String>) -> Json<ApiResponse<T>> {
    match r {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

async fn get_settings(State(state): State<ApiState>) -> Json<ApiResponse<NetworkSettings>> {
    reply(state.db.network_settings().await)
}

async fn put_settings(State(state): State<ApiState>, Json(body): Json<PutBody>) -> Json<ApiResponse<NetworkSettings>> {
    reply(state.db.network_settings_update(body.proxy_port).await)
}
