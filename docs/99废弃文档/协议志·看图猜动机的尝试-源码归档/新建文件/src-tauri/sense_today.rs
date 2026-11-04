// ══════════════════════════════════════════════
// 系统 · 今日 —— 动机云的「今天」这一层
//   理想 = daily_motives：这一天早上点亮（立约）了哪些动机
//   真实 = 感知内核每 10 秒的临时判断里、有把握判中某颗动机的累计秒数（sense_tally 的 m: 键，动机见 sense_motives.rs）
//   只是给动机云看的估计，不是记录，不进昼夜表
// ══════════════════════════════════════════════

use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db::Database;

#[derive(Debug, Serialize)]
pub struct MotiveTime {
    pub anchor_id: String,
    pub seconds: i64,
}

#[derive(Debug, Serialize)]
pub struct TodayView {
    pub date: String,
    /// 这一天立约的动机（动机 id）
    pub declared: Vec<String>,
    pub motives: Vec<MotiveTime>,
    /// 这一天所有有把握的判断累计秒数（含这一局的用意）
    pub judged_seconds: i64,
}

pub(crate) fn init_today_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS daily_motives (
            date TEXT NOT NULL,
            anchor_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (date, anchor_id)
        );
    "#).map_err(|e| format!("创建今日动机表失败: {}", e))
}

fn parse_day(date: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "日期格式应为 YYYY-MM-DD".to_string())
}

fn declared_for(conn: &Connection, date: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT anchor_id FROM daily_motives WHERE date = ?1 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![date], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

impl Database {
    pub async fn sense_today(&self, date: &str) -> Result<TodayView, String> {
        parse_day(date)?;
        let tally = self.sense_tally(date).await?;
        let judged_seconds = tally.iter().map(|(_, s)| *s).sum();
        let motives = tally
            .into_iter()
            .filter_map(|(key, seconds)| key.strip_prefix("m:").map(|id| MotiveTime { anchor_id: id.to_string(), seconds }))
            .collect();
        let conn = self.conn.lock().await;
        Ok(TodayView { date: date.to_string(), declared: declared_for(&conn, date)?, motives, judged_seconds })
    }

    /// 立约 / 取消：某天点亮或熄掉一个动机，返回这一天立约的全部动机
    pub async fn sense_declare(&self, date: &str, anchor_id: &str, declared: bool) -> Result<Vec<String>, String> {
        parse_day(date)?;
        let conn = self.conn.lock().await;
        if declared {
            conn.execute(
                "INSERT OR IGNORE INTO daily_motives (date, anchor_id, created_at) VALUES (?1, ?2, datetime('now','localtime'))",
                params![date, anchor_id],
            )
        } else {
            conn.execute("DELETE FROM daily_motives WHERE date = ?1 AND anchor_id = ?2", params![date, anchor_id])
        }
        .map_err(|e| e.to_string())?;
        declared_for(&conn, date)
    }
}
