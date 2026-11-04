// ══════════════════════════════════════════════
// 系统 · 今日动机云的星星：这个月自嗨开发的动机（和洪流域的旧动机锚点无关，单独一张表）
//   来源两种：你自己敲一句（origin = user，直接收下）；系统提议（origin = ai，先是 proposed，你答「是」才 kept）
//   感知内核每 10 秒只做一件粗判断：此刻在推进云里的哪一颗 / 这一局的用意 / 都不在（候选见 sense_candidates）
//   落盘的只有：动机本身（sense_motives）、你的回答（sense_answers）、今天各候选被判中的累计秒数（sense_tally）
// ══════════════════════════════════════════════

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;

const MOTIVE_MAX_CHARS: usize = 30;

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    /// m:<动机 id> / p:<局 id>
    pub key: String,
    /// 给人看、也给模型看的一句话
    pub text: String,
    /// 已经收下（kept）；false = 系统提议、你还没答
    pub kept: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct SenseMotive {
    pub id: String,
    pub text: String,
    /// proposed / kept
    pub status: String,
    /// user / ai
    pub origin: String,
    pub created_at: String,
}

pub(crate) fn init_motive_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS sense_motives (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'proposed',
            origin TEXT NOT NULL DEFAULT 'ai',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sense_answers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            key TEXT NOT NULL,
            text TEXT NOT NULL,
            answer TEXT NOT NULL,
            at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sense_answers_day ON sense_answers(date, key);
        CREATE TABLE IF NOT EXISTS sense_tally (
            date TEXT NOT NULL,
            key TEXT NOT NULL,
            seconds INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, key)
        );
    "#).map_err(|e| format!("创建动机表失败: {}", e))
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 模型偶尔带引号、句号、「用户……」开头；统一去掉，截到上限
fn clean_text(text: &str) -> String {
    let t = text.trim().trim_matches(|c| matches!(c, '「' | '」' | '"' | '“' | '”' | '。' | ' '));
    let t = t.strip_prefix("用户").unwrap_or(t).trim();
    t.chars().take(MOTIVE_MAX_CHARS).collect()
}

fn list_where(conn: &Connection, status_sql: &str) -> Result<Vec<SenseMotive>, String> {
    let sql = format!("SELECT id, text, status, origin, created_at FROM sense_motives WHERE {status_sql} ORDER BY created_at");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(SenseMotive { id: r.get(0)?, text: r.get(1)?, status: r.get(2)?, origin: r.get(3)?, created_at: r.get(4)? }))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

impl Database {
    /// 这一刻的候选：云里的动机（含系统提议、还没答的）+ 这一局的用意
    pub async fn sense_candidates(&self, protocol: Option<(&str, &str)>) -> Vec<Candidate> {
        let conn = self.conn.lock().await;
        let mut out: Vec<Candidate> = list_where(&conn, "status IN ('kept', 'proposed')")
            .unwrap_or_default()
            .into_iter()
            .map(|m| Candidate { key: format!("m:{}", m.id), text: m.text, kept: m.status == "kept" })
            .collect();
        if let Some((session_id, intent)) = protocol {
            if !intent.trim().is_empty() {
                out.push(Candidate { key: format!("p:{session_id}"), text: format!("这一局的用意：{intent}"), kept: true });
            }
        }
        out
    }

    /// 云里收下的动机（今日动机云画的就是这些）
    pub async fn sense_motives(&self) -> Result<Vec<SenseMotive>, String> {
        let conn = self.conn.lock().await;
        list_where(&conn, "status = 'kept'")
    }

    /// 加一颗动机。你自己敲的直接收下（之前拿掉过的也拉回来）；
    /// 系统提议的先是 proposed，被拿掉过的同一句不再提。返回 None = 这句没加进来
    pub async fn sense_motive_add(&self, text: &str, by_user: bool) -> Result<Option<SenseMotive>, String> {
        let text = clean_text(text);
        if text.is_empty() {
            return Err("动机不能是空的".into());
        }
        let conn = self.conn.lock().await;
        let existing: Option<(String, String)> = conn
            .query_row("SELECT id, status FROM sense_motives WHERE text = ?1", params![text], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        let status = if by_user { "kept" } else { "proposed" };
        let id = match existing {
            Some((_, s)) if !by_user && s != "proposed" => return Ok(None),
            Some((id, _)) => {
                conn.execute("UPDATE sense_motives SET status = ?2, updated_at = ?3 WHERE id = ?1", params![id, status, now_str()])
                    .map_err(|e| e.to_string())?;
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO sense_motives (id, text, status, origin, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![id, text, status, if by_user { "user" } else { "ai" }, now_str()],
                )
                .map_err(|e| e.to_string())?;
                id
            }
        };
        let row = conn
            .query_row("SELECT id, text, status, origin, created_at FROM sense_motives WHERE id = ?1", params![id], |r| {
                Ok(SenseMotive { id: r.get(0)?, text: r.get(1)?, status: r.get(2)?, origin: r.get(3)?, created_at: r.get(4)? })
            })
            .map_err(|e| e.to_string())?;
        Ok(Some(row))
    }

    /// 把一颗动机拿出云（不删，系统以后也不会再提同一句）
    pub async fn sense_motive_drop(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute("UPDATE sense_motives SET status = 'dropped', updated_at = ?2 WHERE id = ?1", params![id, now_str()])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 你对「要把……收作一颗动机吗？」的回答：yes 收下 / no 不收 / chat 只记下来，协商在聊天里继续
    pub async fn sense_answer(&self, key: &str, text: &str, answer: &str) -> Result<(), String> {
        if !matches!(answer, "yes" | "no" | "chat") {
            return Err("回答只能是 yes / no / chat".into());
        }
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO sense_answers (date, key, text, answer, at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![today(), key, text, answer, now_str()],
        )
        .map_err(|e| e.to_string())?;
        let status = match answer {
            "yes" => Some("kept"),
            "no" => Some("dropped"),
            _ => None,
        };
        if let (Some(id), Some(s)) = (key.strip_prefix("m:"), status) {
            conn.execute(
                "UPDATE sense_motives SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'proposed'",
                params![id, s, now_str()],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 今天某个候选被有把握地判中了 seconds 秒（给今日动机云看推进了多久）
    pub async fn sense_tally_add(&self, key: &str, seconds: i64) {
        let conn = self.conn.lock().await;
        let result = conn.execute(
            "INSERT INTO sense_tally (date, key, seconds) VALUES (?1, ?2, ?3)
             ON CONFLICT(date, key) DO UPDATE SET seconds = seconds + ?3",
            params![today(), key, seconds],
        );
        if let Err(e) = result {
            log::warn!("[Sense] 记今日累计失败: {e}");
        }
    }

    /// 某天各候选的累计秒数
    pub async fn sense_tally(&self, date: &str) -> Result<Vec<(String, i64)>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare("SELECT key, seconds FROM sense_tally WHERE date = ?1 ORDER BY seconds DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![date], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_model_output() {
        assert_eq!(clean_text("「把协议志做成独自升级系统」。"), "把协议志做成独自升级系统");
        assert_eq!(clean_text("用户打磨桌面端界面"), "打磨桌面端界面");
    }
}
