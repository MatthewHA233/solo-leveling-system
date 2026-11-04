// ══════════════════════════════════════════════
// 协议志 · 开局：还没有任何协议时，AI 先问两份清单（最近最不如意的事 / 一直想做却没做成的事，各 1~10 条），
//   照一遍（系统的回应）→ 以终为始（愿望金字塔）→ 未来年表 → 之后才长出每周的大石头和每天的协议
//   一次开局存一份 JSON 文档（结构由前端定，见 components/protocol/genesis/genesis-model.ts），后端只管存取
//   新表，不碰其他数据
// ══════════════════════════════════════════════

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;

/// 文档最大字节数（两份清单 + 回应 + 金字塔 + 年表，几 KB 足够；防止误传大东西）
const MAX_DOC_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct Genesis {
    pub id: String,
    pub doc: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn init_genesis_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS protocol_genesis (
            id TEXT PRIMARY KEY,
            doc TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    "#).map_err(|e| format!("创建开局表失败: {}", e))
}

fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn row_to_genesis(id: String, doc: String, created_at: String, updated_at: String) -> Result<Genesis, String> {
    let doc = serde_json::from_str(&doc).map_err(|e| format!("开局文档损坏: {e}"))?;
    Ok(Genesis { id, doc, created_at, updated_at })
}

impl Database {
    /// 最近一次开局（还没开过 = None）
    pub async fn genesis_latest(&self) -> Result<Option<Genesis>, String> {
        let conn = self.conn.lock().await;
        let row: Option<(String, String, String, String)> = conn
            .query_row(
                "SELECT id, doc, created_at, updated_at FROM protocol_genesis ORDER BY created_at DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        row.map(|(id, doc, c, u)| row_to_genesis(id, doc, c, u)).transpose()
    }

    /// 存开局文档：给了 id 就覆盖那一份，没给就新开一份
    pub async fn genesis_save(&self, id: Option<&str>, doc: &serde_json::Value) -> Result<Genesis, String> {
        if !doc.is_object() {
            return Err("开局文档必须是一个 JSON 对象".into());
        }
        let text = doc.to_string();
        if text.len() > MAX_DOC_BYTES {
            return Err("开局文档太大了".into());
        }
        let conn = self.conn.lock().await;
        let now = now_str();
        let id = match id {
            Some(id) => {
                let n = conn
                    .execute("UPDATE protocol_genesis SET doc = ?2, updated_at = ?3 WHERE id = ?1", params![id, text, now])
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("找不到这次开局".into());
                }
                id.to_string()
            }
            None => {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO protocol_genesis (id, doc, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                    params![id, text, now],
                )
                .map_err(|e| e.to_string())?;
                id
            }
        };
        let (doc, created_at, updated_at): (String, String, String) = conn
            .query_row("SELECT doc, created_at, updated_at FROM protocol_genesis WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(|e| e.to_string())?;
        row_to_genesis(id, doc, created_at, updated_at)
    }
}
