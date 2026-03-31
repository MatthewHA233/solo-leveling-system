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
    pub steps: Vec<ChronosStep>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChronosStep {
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
    pub steps: Vec<CreateStepRequest>,
}

#[derive(Debug, Deserialize)]
pub struct CreateStepRequest {
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
    pub steps: Vec<CreateStepRequest>,
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

            -- 步骤表
            CREATE TABLE IF NOT EXISTS chronos_steps (
                id TEXT PRIMARY KEY,
                activity_id TEXT NOT NULL REFERENCES chronos_activities(id) ON DELETE CASCADE,
                minute INTEGER NOT NULL,
                label TEXT NOT NULL,
                title TEXT NOT NULL
            );

            -- 索引
            CREATE INDEX IF NOT EXISTS idx_activities_date ON chronos_activities(date);
            CREATE INDEX IF NOT EXISTS idx_steps_activity ON chronos_steps(activity_id);
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
                steps: vec![],
            })
        }).map_err(|e| e.to_string())?;

        let mut activities: Vec<ChronosActivity> = rows.filter_map(|r| r.ok()).collect();

        // 加载每个活动的步骤
        for activity in &mut activities {
            activity.steps = Self::get_steps_by_activity_inner(&conn, &activity.id)?;
        }

        Ok(activities)
    }

    /// 创建活动
    pub async fn create_activity(&self, req: CreateActivityRequest) -> Result<String, String> {
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

        // 插入步骤
        for step in req.steps {
            Self::create_step_inner(&conn, &id, step)?;
        }

        log::info!("[Database] 创建活动: {}", id);
        Ok(id)
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

        // 删除旧步骤，重新插入
        conn.execute(
            "DELETE FROM chronos_steps WHERE activity_id = ?",
            [id],
        ).map_err(|e| e.to_string())?;

        for step in req.steps {
            Self::create_step_inner(&conn, id, step)?;
        }

        log::info!("[Database] 更新活动: {}", id);
        Ok(())
    }

    // ── Chronos Steps ──

    fn get_steps_by_activity_inner(conn: &Connection, activity_id: &str) -> Result<Vec<ChronosStep>, String> {
        let mut stmt = conn.prepare(r#"
            SELECT id, activity_id, minute, label, title
            FROM chronos_steps
            WHERE activity_id = ?
            ORDER BY minute
        "#).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([activity_id], |row| {
            Ok(ChronosStep {
                id: row.get(0)?,
                activity_id: row.get(1)?,
                minute: row.get(2)?,
                label: row.get(3)?,
                title: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    fn create_step_inner(conn: &Connection, activity_id: &str, req: CreateStepRequest) -> Result<(), String> {
        let id = Uuid::new_v4().to_string();

        conn.execute(r#"
            INSERT INTO chronos_steps (id, activity_id, minute, label, title)
            VALUES (?, ?, ?, ?, ?)
        "#, params![
            &id,
            activity_id,
            req.minute,
            &req.label,
            &req.title,
        ]).map_err(|e| e.to_string())?;

        Ok(())
    }
}