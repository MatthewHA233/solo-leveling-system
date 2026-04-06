// ══════════════════════════════════════════════
// Local Database — SQLite 存储
// 支持自定义存储路径 + 数据迁移
// ══════════════════════════════════════════════

use rusqlite::{Connection, params};
use std::sync::Arc;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;
use chrono::Utc;

// ── 数据类型 ──

#[derive(Debug, Serialize, Deserialize)]
pub struct ChronosActivity {
    pub id: String,
    pub date: String,
    pub title: String,
    pub category: String,
    pub start_minute: i32,
    pub end_minute: i32,
    pub goal_alignment: Option<String>,
    pub events: Vec<ChronosEvent>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChronosEvent {
    pub id: String,
    pub activity_id: String,
    pub minute: i32,
    pub label: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateActivityRequest {
    pub date: String,
    pub title: String,
    pub category: String,
    pub start_minute: i32,
    pub end_minute: i32,
    pub goal_alignment: Option<String>,
    pub events: Vec<CreateEventRequest>,
}

#[derive(Debug, Deserialize)]
pub struct CreateEventRequest {
    pub minute: i32,
    pub label: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateActivityRequest {
    pub title: String,
    pub category: String,
    pub start_minute: i32,
    pub end_minute: i32,
    pub goal_alignment: Option<String>,
    pub events: Vec<CreateEventRequest>,
}

#[derive(Debug, Deserialize)]
pub struct MergeActivitiesRequest {
    pub survivor_id: String,
    pub absorbed_ids: Vec<String>,
    pub new_start: i32,
    pub new_end: i32,
}

// ── Chat Session Types ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: Option<String>,
    pub tool_calls: Option<String>,    // JSON string
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateChatMessageRequest {
    pub role: String,
    pub content: Option<String>,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Deserialize)]
pub struct AppendChatMessagesRequest {
    pub messages: Vec<CreateChatMessageRequest>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateChatSessionRequest {
    pub title: Option<String>,
    pub summary: Option<String>,
}

// ── Bilibili 历史类型 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BiliHistoryRow {
    pub bvid: String,
    pub oid: i64,
    pub title: String,
    pub author_name: String,
    pub cover: String,
    pub duration: i32,
    pub progress: i32,
    pub view_at: i64,
    pub event_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BiliSpan {
    pub bvid: String,
    pub title: String,
    pub author_name: String,
    pub cover: String,    // 封面 URL
    pub start_at: String, // "2026-04-06 13:30:00" 本地时间
    pub end_at: String,
    pub duration: i32,    // 总时长（秒）
    pub progress: i32,    // 已看（秒）
}

#[derive(Debug, Deserialize)]
pub struct UpsertBiliItem {
    pub bvid: String,
    pub oid: i64,
    pub title: String,
    pub author_name: String,
    pub cover: String,
    pub duration: i32,
    pub progress: i32,
    pub view_at: i64,
}

// ── 数据库管理 ──

pub struct Database {
    conn: Arc<Mutex<Connection>>,
    db_path: PathBuf,
}

impl Database {
    /// 默认数据目录
    pub fn default_data_dir() -> PathBuf {
        dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("solo-agent")
    }

    /// 初始化数据库（指定路径）
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        // 确保目录存在
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("无法创建数据目录: {}", e))?;

        let db_path = data_dir.join("solo.db");
        log::info!("[Database] 数据库路径: {:?}", db_path);

        let conn = Connection::open(&db_path)
            .map_err(|e| format!("无法打开数据库: {}", e))?;

        // 启用外键约束
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path,
        };

        db.run_migrations()?;
        db.init_tables()?;
        Ok(db)
    }

    /// 获取当前数据库路径
    pub fn get_db_path(&self) -> &PathBuf {
        &self.db_path
    }

    /// 获取数据库文件大小
    pub fn get_db_size(&self) -> Result<u64, String> {
        let metadata = std::fs::metadata(&self.db_path)
            .map_err(|e| format!("无法获取文件信息: {}", e))?;
        Ok(metadata.len())
    }

    /// 迁移数据库到新路径
    pub fn migrate_to(new_data_dir: PathBuf, old_db: &Self) -> Result<Self, String> {
        log::info!("[Database] 开始迁移: {:?} -> {:?}", old_db.db_path, new_data_dir);

        // 确保新目录存在
        std::fs::create_dir_all(&new_data_dir)
            .map_err(|e| format!("无法创建目标目录: {}", e))?;

        let new_db_path = new_data_dir.join("solo.db");

        // 如果目标已存在，先删除
        if new_db_path.exists() {
            std::fs::remove_file(&new_db_path)
                .map_err(|e| format!("无法删除目标文件: {}", e))?;
        }

        // 关闭旧连接（通过丢弃 old_db）
        // 注意：调用方需要确保 old_db 不再被使用

        // 复制数据库文件
        std::fs::copy(&old_db.db_path, &new_db_path)
            .map_err(|e| format!("复制数据库失败: {}", e))?;

        // 打开新数据库
        let conn = Connection::open(&new_db_path)
            .map_err(|e| format!("无法打开新数据库: {}", e))?;

        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;

        let new_db = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: new_db_path,
        };

        log::info!("[Database] 迁移完成");
        Ok(new_db)
    }

    /// 迁移旧版数据结构（幂等，安全重复运行）
    fn run_migrations(&self) -> Result<(), String> {
        let conn = self.conn.blocking_lock();

        // Migration 1: chronos_steps → chronos_events
        let steps_exists: bool = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chronos_steps'",
            [], |row| row.get::<_, i64>(0),
        ).unwrap_or(0) > 0;
        if steps_exists {
            conn.execute_batch("ALTER TABLE chronos_steps RENAME TO chronos_events;")
                .map_err(|e| format!("迁移 chronos_steps: {}", e))?;
            log::info!("[Database] 迁移: chronos_steps → chronos_events");
        }

        // Migration 2: bili_history 添加 event_id 列
        let event_id_exists = {
            let mut stmt = conn.prepare("PRAGMA table_info(bili_history)")
                .map_err(|e| e.to_string())?;
            let cols: Vec<String> = stmt.query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            cols.iter().any(|col| col == "event_id")
        };
        if !event_id_exists {
            // bili_history 表存在才需要加列
            let bili_exists: bool = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='bili_history'",
                [], |row| row.get::<_, i64>(0),
            ).unwrap_or(0) > 0;
            if bili_exists {
                conn.execute_batch(
                    "ALTER TABLE bili_history ADD COLUMN event_id TEXT REFERENCES chronos_events(id) ON DELETE SET NULL;"
                ).map_err(|e| format!("迁移 event_id: {}", e))?;
                log::info!("[Database] 迁移: bili_history.event_id 列已添加");
            }
        }

        Ok(())
    }

    /// 创建表结构
    fn init_tables(&self) -> Result<(), String> {
        let conn = self.conn.blocking_lock();
        conn.execute_batch(r#"
            -- 活动表
            CREATE TABLE IF NOT EXISTS chronos_activities (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                title TEXT NOT NULL,
                category TEXT NOT NULL,
                start_minute INTEGER NOT NULL,
                end_minute INTEGER NOT NULL,
                goal_alignment TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- 事件表（活动的子集）
            CREATE TABLE IF NOT EXISTS chronos_events (
                id TEXT PRIMARY KEY,
                activity_id TEXT NOT NULL REFERENCES chronos_activities(id) ON DELETE CASCADE,
                minute INTEGER NOT NULL,
                label TEXT NOT NULL,
                title TEXT NOT NULL
            );

            -- 索引
            CREATE INDEX IF NOT EXISTS idx_activities_date ON chronos_activities(date);
            CREATE INDEX IF NOT EXISTS idx_events_activity ON chronos_events(activity_id);

            -- 对话会话表
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '新会话',
                summary TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- 对话消息表
            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT,
                tool_calls TEXT,
                tool_call_id TEXT,
                name TEXT,
                timestamp TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
            CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at);

            -- B站历史表
            CREATE TABLE IF NOT EXISTS bili_history (
                bvid TEXT PRIMARY KEY,
                oid INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL DEFAULT '',
                author_name TEXT NOT NULL DEFAULT '',
                cover TEXT NOT NULL DEFAULT '',
                duration INTEGER NOT NULL DEFAULT 0,
                progress INTEGER NOT NULL DEFAULT 0,
                view_at INTEGER NOT NULL DEFAULT 0,
                event_id TEXT REFERENCES chronos_events(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bili_view_at ON bili_history(view_at DESC);
        "#).map_err(|e| format!("创建表失败: {}", e))?;

        log::info!("[Database] 表初始化完成");
        Ok(())
    }

    // ── Chronos Activities ──

    /// 查询某天的所有活动
    pub async fn get_activities_by_date(&self, date: &str) -> Result<Vec<ChronosActivity>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(r#"
            SELECT id, date, title, category, start_minute, end_minute, goal_alignment
            FROM chronos_activities
            WHERE date = ?
            ORDER BY start_minute
        "#).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([date], |row| {
            Ok(ChronosActivity {
                id: row.get(0)?,
                date: row.get(1)?,
                title: row.get(2)?,
                category: row.get(3)?,
                start_minute: row.get(4)?,
                end_minute: row.get(5)?,
                goal_alignment: row.get(6)?,
                events: vec![],
            })
        }).map_err(|e| e.to_string())?;

        let mut activities: Vec<ChronosActivity> = rows.filter_map(|r| r.ok()).collect();

        // 加载每个活动的事件
        for activity in &mut activities {
            activity.events = Self::get_events_by_activity_inner(&conn, &activity.id)?;
        }

        Ok(activities)
    }

    /// 创建活动，返回 (activity_id, event_ids)
    pub async fn create_activity(&self, req: CreateActivityRequest) -> Result<(String, Vec<String>), String> {
        let id = Uuid::new_v4().to_string();
        let conn = self.conn.lock().await;

        conn.execute(r#"
            INSERT INTO chronos_activities (id, date, title, category, start_minute, end_minute, goal_alignment)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        "#, params![
            &id,
            &req.date,
            &req.title,
            &req.category,
            req.start_minute,
            req.end_minute,
            &req.goal_alignment,
        ]).map_err(|e| e.to_string())?;

        // 插入事件
        let mut event_ids = Vec::new();
        for event in req.events {
            let eid = Self::create_event_inner(&conn, &id, event)?;
            event_ids.push(eid);
        }

        log::info!("[Database] 创建活动: {}", id);
        Ok((id, event_ids))
    }

    /// 删除活动
    pub async fn delete_activity(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM chronos_activities WHERE id = ?",
            [id],
        ).map_err(|e| e.to_string())?;

        log::info!("[Database] 删除活动: {}", id);
        Ok(())
    }

    /// 更新活动
    pub async fn update_activity(&self, id: &str, req: UpdateActivityRequest) -> Result<(), String> {
        let conn = self.conn.lock().await;

        // 更新活动主体
        conn.execute(r#"
            UPDATE chronos_activities
            SET title = ?, category = ?, start_minute = ?, end_minute = ?, goal_alignment = ?
            WHERE id = ?
        "#, params![
            &req.title,
            &req.category,
            req.start_minute,
            req.end_minute,
            &req.goal_alignment,
            id,
        ]).map_err(|e| e.to_string())?;

        // 删除旧事件，重新插入
        conn.execute(
            "DELETE FROM chronos_events WHERE activity_id = ?",
            [id],
        ).map_err(|e| e.to_string())?;

        for event in req.events {
            Self::create_event_inner(&conn, id, event)?;
        }

        log::info!("[Database] 更新活动: {}", id);
        Ok(())
    }

    // ── Chronos Events ──

    fn get_events_by_activity_inner(conn: &Connection, activity_id: &str) -> Result<Vec<ChronosEvent>, String> {
        let mut stmt = conn.prepare(r#"
            SELECT id, activity_id, minute, label, title
            FROM chronos_events
            WHERE activity_id = ?
            ORDER BY minute
        "#).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([activity_id], |row| {
            Ok(ChronosEvent {
                id: row.get(0)?,
                activity_id: row.get(1)?,
                minute: row.get(2)?,
                label: row.get(3)?,
                title: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 创建事件，返回 event_id
    fn create_event_inner(conn: &Connection, activity_id: &str, req: CreateEventRequest) -> Result<String, String> {
        let id = Uuid::new_v4().to_string();

        conn.execute(r#"
            INSERT INTO chronos_events (id, activity_id, minute, label, title)
            VALUES (?, ?, ?, ?, ?)
        "#, params![
            &id,
            activity_id,
            req.minute,
            &req.label,
            &req.title,
        ]).map_err(|e| e.to_string())?;

        Ok(id)
    }

    /// 合并多个活动到 survivor（移动事件，不删除，bvid 链接保留）
    pub async fn merge_activities(&self, req: MergeActivitiesRequest) -> Result<(), String> {
        if req.absorbed_ids.is_empty() { return Ok(()); }
        let conn = self.conn.lock().await;

        // 将被吸收活动的所有事件移到 survivor
        let placeholders = req.absorbed_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let move_sql = format!(
            "UPDATE chronos_events SET activity_id = ? WHERE activity_id IN ({})",
            placeholders
        );
        let mut move_params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(req.survivor_id.clone())];
        for id in &req.absorbed_ids {
            move_params.push(Box::new(id.clone()));
        }
        conn.execute(&move_sql, rusqlite::params_from_iter(
            std::iter::once(&req.survivor_id as &dyn rusqlite::ToSql)
                .chain(req.absorbed_ids.iter().map(|id| id as &dyn rusqlite::ToSql))
        )).map_err(|e| e.to_string())?;

        // 更新 survivor 的时间范围
        conn.execute(
            "UPDATE chronos_activities SET start_minute = ?, end_minute = ? WHERE id = ?",
            params![req.new_start, req.new_end, &req.survivor_id],
        ).map_err(|e| e.to_string())?;

        // 删除被吸收的活动（事件已移走，CASCADE 不触发）
        let del_sql = format!(
            "DELETE FROM chronos_activities WHERE id IN ({})",
            placeholders
        );
        conn.execute(&del_sql, rusqlite::params_from_iter(req.absorbed_ids.iter()))
            .map_err(|e| e.to_string())?;

        // 重新按 minute 排序编号事件 label
        let mut stmt = conn.prepare(
            "SELECT id FROM chronos_events WHERE activity_id = ? ORDER BY minute"
        ).map_err(|e| e.to_string())?;
        let event_ids: Vec<String> = stmt.query_map([&req.survivor_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        for (i, eid) in event_ids.iter().enumerate() {
            conn.execute(
                "UPDATE chronos_events SET label = ? WHERE id = ?",
                params![format!("{}", i + 1), eid],
            ).map_err(|e| e.to_string())?;
        }

        log::info!("[Database] 合并活动: {} ← {:?}", req.survivor_id, req.absorbed_ids);
        Ok(())
    }

    // ── Chat Sessions ──

    /// 创建新会话
    pub async fn create_chat_session(&self) -> Result<ChatSession, String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;

        conn.execute(
            "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, '新会话', ?, ?)",
            params![&id, &now, &now],
        ).map_err(|e| e.to_string())?;

        log::info!("[Database] 创建会话: {}", id);
        Ok(ChatSession { id, title: "新会话".to_string(), summary: None, created_at: now.clone(), updated_at: now })
    }

    /// 获取最近会话列表
    pub async fn get_recent_chat_sessions(&self, limit: i64) -> Result<Vec<ChatSession>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, title, summary, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC LIMIT ?"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([limit], |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 获取会话的所有消息
    pub async fn get_chat_messages(&self, session_id: &str) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, tool_calls, tool_call_id, name, timestamp FROM chat_messages WHERE session_id = ? ORDER BY timestamp"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([session_id], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                tool_calls: row.get(4)?,
                tool_call_id: row.get(5)?,
                name: row.get(6)?,
                timestamp: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 追加消息到会话
    pub async fn append_chat_messages(&self, session_id: &str, req: AppendChatMessagesRequest) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;

        for msg in req.messages {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO chat_messages (id, session_id, role, content, tool_calls, tool_call_id, name, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![&id, session_id, &msg.role, &msg.content, &msg.tool_calls, &msg.tool_call_id, &msg.name, &msg.timestamp],
            ).map_err(|e| e.to_string())?;
        }

        conn.execute(
            "UPDATE chat_sessions SET updated_at = ? WHERE id = ?",
            params![&now, session_id],
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// 更新会话标题或摘要
    pub async fn update_chat_session(&self, session_id: &str, req: UpdateChatSessionRequest) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;

        if let Some(ref title) = req.title {
            conn.execute(
                "UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?",
                params![title, &now, session_id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(ref summary) = req.summary {
            conn.execute(
                "UPDATE chat_sessions SET summary = ?, updated_at = ? WHERE id = ?",
                params![summary, &now, session_id],
            ).map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    // ── Bilibili 历史 ──

    /// 批量 UPSERT B站历史（同 bvid 保留最新进度/时间）
    pub async fn upsert_bili_history(&self, items: &[UpsertBiliItem]) -> Result<usize, String> {
        let conn = self.conn.lock().await;
        let mut count = 0usize;
        for item in items {
            let affected = conn.execute(r#"
                INSERT INTO bili_history (bvid, oid, title, author_name, cover, duration, progress, view_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(bvid) DO UPDATE SET
                    title      = excluded.title,
                    cover      = excluded.cover,
                    duration   = excluded.duration,
                    progress   = MAX(excluded.progress, progress),
                    view_at    = MAX(excluded.view_at, view_at)
            "#, params![
                &item.bvid, item.oid, &item.title, &item.author_name,
                &item.cover, item.duration, item.progress, item.view_at,
            ]).map_err(|e| e.to_string())?;
            count += affected;
        }
        Ok(count)
    }

    /// 分页查询 B站历史（按 view_at 倒序），支持只看未关联事件的
    pub async fn get_bili_history(
        &self, page: i64, page_size: i64, unlinked_only: bool,
    ) -> Result<(Vec<BiliHistoryRow>, i64), String> {
        let conn = self.conn.lock().await;
        let where_clause = if unlinked_only { "WHERE event_id IS NULL" } else { "" };

        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM bili_history {}", where_clause),
            [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        let sql = format!(r#"
            SELECT bvid, oid, title, author_name, cover, duration, progress, view_at, event_id
            FROM bili_history {}
            ORDER BY view_at DESC
            LIMIT ? OFFSET ?
        "#, where_clause);

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(
            params![page_size, page * page_size],
            |row| Ok(BiliHistoryRow {
                bvid:        row.get(0)?,
                oid:         row.get(1)?,
                title:       row.get(2)?,
                author_name: row.get(3)?,
                cover:       row.get(4)?,
                duration:    row.get(5)?,
                progress:    row.get(6)?,
                view_at:     row.get(7)?,
                event_id:    row.get(8)?,
            }),
        ).map_err(|e| e.to_string())?;

        Ok((rows.filter_map(|r| r.ok()).collect(), total))
    }

    /// 查询某天的 B站观看 spans（用于昼夜表轨道）
    /// date 格式: "2026-04-06"
    pub async fn get_bili_spans_for_date(&self, date: &str) -> Result<Vec<BiliSpan>, String> {
        let conn = self.conn.lock().await;
        let sql = r#"
            SELECT
                bvid, title, author_name, cover, duration, progress,
                datetime(
                    view_at - CASE
                        WHEN progress > 0 THEN MIN(progress, 3600)
                        ELSE MIN(duration, 3600)
                    END,
                    'unixepoch', 'localtime'
                ) AS start_dt,
                datetime(view_at, 'unixepoch', 'localtime') AS end_dt
            FROM bili_history
            WHERE date(view_at, 'unixepoch', 'localtime') = ?
            ORDER BY view_at ASC
        "#;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![date], |row| {
            Ok(BiliSpan {
                bvid:        row.get(0)?,
                title:       row.get(1)?,
                author_name: row.get(2)?,
                cover:       row.get(3)?,
                duration:    row.get(4)?,
                progress:    row.get(5)?,
                start_at:    row.get(6)?,
                end_at:      row.get(7)?,
            })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 将一批 bvid 关联到指定事件 ID
    pub async fn link_bili_to_event(&self, bvids: &[String], event_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        for bvid in bvids {
            conn.execute(
                "UPDATE bili_history SET event_id = ? WHERE bvid = ?",
                params![event_id, bvid],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

}
