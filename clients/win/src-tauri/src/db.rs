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
use chrono::{Duration, NaiveDateTime, Utc};

// ── 数据类型 ──

// ── 活动记录（自定义标签 + 5min 块）──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityCategory {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub sort_order: i32,
    pub created_at: String,
    pub last_used_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityTag {
    pub id: i64,
    pub category_id: i64,
    pub full_path: String,   // "工作,毕业论文,DPO章节"（含一级 category 名）
    pub leaf_name: String,   // "DPO章节"
    pub depth: i32,          // 1..4（含 category 层）
    pub created_at: String,
    pub last_used_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityBlock {
    pub date: String,        // 'YYYY-MM-DD'
    pub minute: i32,         // 0/5/10/.../1435
    pub tag_id: i64,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityPalette {
    pub categories: Vec<ActivityCategory>,
    pub tags: Vec<ActivityTag>,
}

#[derive(Debug, Deserialize)]
pub struct AddCategoryRequest {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Deserialize)]
pub struct AddTagRequest {
    pub category_id: i64,
    pub full_path: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCategoryRequest {
    pub id: i64,
    pub name: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RenamePathRequest {
    pub category_id: i64,
    /// 完整旧路径（含分类首段），如 "工作,毕业论文" 表示重命名 "毕业论文" 这一段
    pub full_old_path: String,
    /// 新的末段名（不含逗号）
    pub new_segment: String,
}

#[derive(Debug, Deserialize)]
pub struct PaintBlocksRequest {
    pub date: String,
    pub minutes: Vec<i32>,
    pub tag_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct EraseBlocksRequest {
    pub date: String,
    pub minutes: Vec<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PerceptionHeartbeat {
    pub bucket_id: String,
    pub bucket_kind: String,
    pub event_type: String,
    pub source: String,
    pub observed_at: String,
    pub data: serde_json::Value,
    pub pulsetime_seconds: i64,
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
    pub audio_path: Option<String>,   // 语音气泡的 WAV 文件路径（相对于音频根目录）
    pub duration_ms: Option<i64>,     // 录音时长（毫秒）
    pub usage_json: Option<String>,   // 该 AI 回复绑定的 ModelCallLog 快照（JSON 序列化）
}

#[derive(Debug, Deserialize)]
pub struct CreateChatMessageRequest {
    pub role: String,
    pub content: Option<String>,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
    pub timestamp: String,
    pub audio_path: Option<String>,
    pub duration_ms: Option<i64>,
    pub usage_json: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppendChatMessagesRequest {
    pub messages: Vec<CreateChatMessageRequest>,
}

#[derive(Debug, Serialize)]
pub struct MessageSnippet {
    pub role: String,
    pub excerpt: String,    // 关键词上下文片段（前后约 N 个字符），原文中关键词不做高亮处理（前端做）
    pub timestamp: String,  // 用于前端切会话后定位气泡
}

#[derive(Debug, Serialize)]
pub struct SessionSearchHit {
    pub session: ChatSession,
    pub snippets: Vec<MessageSnippet>,
}

/// 在原文中找到关键词位置，返回关键词前后 ctx 字符的片段（截断时加 ...）
/// 大小写不敏感匹配，但返回原文片段（保留原始大小写）
fn build_excerpt(content: &str, query: &str, ctx: usize) -> String {
    if query.is_empty() || content.is_empty() {
        return content.chars().take(ctx * 2).collect();
    }
    let lower_content = content.to_lowercase();
    let lower_query = query.to_lowercase();
    let byte_idx = match lower_content.find(&lower_query) {
        Some(i) => i,
        None => return content.chars().take(ctx * 2).collect(),
    };
    // 转字节索引为字符索引（按字符数计算上下文窗口，避免切到 UTF-8 中段）
    let char_idx_of_match = content[..byte_idx].chars().count();
    let total_chars: Vec<char> = content.chars().collect();
    let start = char_idx_of_match.saturating_sub(ctx);
    let end = (char_idx_of_match + query.chars().count() + ctx).min(total_chars.len());
    let mut excerpt = String::new();
    if start > 0 { excerpt.push_str("..."); }
    excerpt.extend(total_chars[start..end].iter());
    if end < total_chars.len() { excerpt.push_str("..."); }
    excerpt
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
    pub oid: i64,
    pub title: String,
    pub author_name: String,
    pub cover: String,    // 封面 URL
    pub start_at: String, // "2026-04-06 13:30:00" 本地时间
    pub end_at: String,
    pub duration: i32,    // 总时长（秒）
    pub progress: i32,    // 已看（秒）
    pub view_at: i64,     // 观看时间戳（unix 秒）
    pub event_id: Option<String>, // 已入档时关联的事件 ID
    pub downloaded: bool, // bili_video_assets 中存在 download_status='done' 即为 true
    pub file_size_bytes: Option<i64>, // 已下载时 = 资产合并后文件大小（多份 done 取最大）；未下载 = null
    pub transcribed: bool, // bili_video_assets 中存在 visual_transcript 或 audio_transcript 非空
}

#[derive(Debug, Serialize, Clone)]
pub struct BiliDayCount {
    pub day: String,        // "YYYY-MM-DD"
    pub watched: i64,       // 当日观看条目数
    pub downloaded: i64,    // 其中已下载（assets done）的条目数
    pub transcribed: i64,   // 其中已转录（visual 或 audio 转录非空）的条目数
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

// ── B 站视频资产（下载/逐字稿/AI 总结/笔记） ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BiliVideoAsset {
    pub id: String,
    pub bvid: String,
    pub download_status: String,           // queued | downloading | done | error
    pub download_path: Option<String>,
    pub quality_request: Option<String>,   // auto / 1080p / ...
    pub quality_id: Option<i64>,           // 实际 qn (80/112/...)
    pub video_codecs: Option<String>,
    pub audio_codecs: Option<String>,
    pub file_size: Option<i64>,
    pub error_message: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    // 未来扩展字段
    pub transcript: Option<String>,
    pub ai_summary: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// 画面（视觉）转录文本
    pub visual_transcript: Option<String>,
    /// 音频转录文本
    pub audio_transcript: Option<String>,
    pub visual_transcribed_at: Option<String>,
    pub audio_transcribed_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BiliTranscriptCache {
    pub visual: Option<String>,
    pub audio: Option<String>,
    pub combined: Option<String>,
    pub visual_at: Option<String>,
    pub audio_at: Option<String>,
    pub combined_at: Option<String>,
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

        // Migration: 弃用旧 chronos 表（活动记录改为新的 activity_categories/tags/blocks）
        let _ = conn.execute_batch(r#"
            DROP TABLE IF EXISTS chronos_events;
            DROP TABLE IF EXISTS chronos_activities;
            DROP TABLE IF EXISTS chronos_steps;
        "#);

        // Migration: 旧 bili_history 表的 event_id 列引用 chronos_events，
        // FK ON 时报 "no such table" → 重建该表去掉 FK
        let bili_exists: bool = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='bili_history'",
            [], |row| row.get::<_, i64>(0),
        ).unwrap_or(0) > 0;
        if bili_exists {
            let create_sql: Option<String> = conn.query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='bili_history'",
                [], |row| row.get(0),
            ).ok();
            let needs_fix = create_sql
                .as_deref()
                .map(|s| s.contains("chronos_events"))
                .unwrap_or(false);
            if needs_fix {
                conn.execute_batch(r#"
                    PRAGMA foreign_keys = OFF;
                    CREATE TABLE bili_history_new (
                        bvid TEXT PRIMARY KEY,
                        oid INTEGER NOT NULL DEFAULT 0,
                        title TEXT NOT NULL DEFAULT '',
                        author_name TEXT NOT NULL DEFAULT '',
                        cover TEXT NOT NULL DEFAULT '',
                        duration INTEGER NOT NULL DEFAULT 0,
                        progress INTEGER NOT NULL DEFAULT 0,
                        view_at INTEGER NOT NULL DEFAULT 0,
                        event_id TEXT
                    );
                    INSERT INTO bili_history_new (bvid, oid, title, author_name, cover, duration, progress, view_at, event_id)
                        SELECT bvid, oid, title, author_name, cover, duration, progress, view_at, event_id
                        FROM bili_history;
                    DROP TABLE bili_history;
                    ALTER TABLE bili_history_new RENAME TO bili_history;
                    CREATE INDEX IF NOT EXISTS idx_bili_view_at ON bili_history(view_at DESC);
                    PRAGMA foreign_keys = ON;
                "#).map_err(|e| format!("迁移 bili_history 去 FK 失败: {}", e))?;
                log::info!("[Database] 迁移: bili_history 去掉 chronos_events 的 FK");
            }
        }

        Ok(())
    }

    /// 创建表结构
    fn init_tables(&self) -> Result<(), String> {
        let conn = self.conn.blocking_lock();
        conn.execute_batch(r#"
            -- 活动记录：分类（一级，用户可加，颜色定义在这）
            CREATE TABLE IF NOT EXISTS activity_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                color TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                last_used_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );

            -- 活动记录：完整路径标签（只有叶子节点有 id；中间层从 path 切片得出）
            -- full_path 形如 "工作,毕业论文,DPO章节"，首段必须等于 categories.name
            CREATE TABLE IF NOT EXISTS activity_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER NOT NULL REFERENCES activity_categories(id) ON DELETE CASCADE,
                full_path TEXT NOT NULL,
                leaf_name TEXT NOT NULL,
                depth INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                last_used_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                UNIQUE (category_id, full_path)
            );
            CREATE INDEX IF NOT EXISTS idx_activity_tags_category ON activity_tags(category_id);

            -- 活动记录：5min 时间块（稀疏存储，未填的不存）
            CREATE TABLE IF NOT EXISTS activity_blocks (
                date TEXT NOT NULL,
                minute INTEGER NOT NULL,
                tag_id INTEGER NOT NULL REFERENCES activity_tags(id) ON DELETE CASCADE,
                note TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                PRIMARY KEY (date, minute)
            );
            CREATE INDEX IF NOT EXISTS idx_activity_blocks_tag ON activity_blocks(tag_id);

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
        "#).map_err(|e| format!("创建表失败: {}", e))?;

        // 渐进式迁移：audio_path / duration_ms / usage_json（旧数据库无此列时自动追加）
        let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN audio_path TEXT");
        let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN duration_ms INTEGER");
        let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN usage_json TEXT");

        // 渐进式迁移：bili_video_assets 转录字段（旧数据库无此列时自动追加）
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN visual_transcript TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN audio_transcript TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN visual_transcribed_at TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN audio_transcribed_at TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN combined_transcript TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN combined_transcribed_at TEXT");

        conn.execute_batch(r#"
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
                event_id TEXT  -- 旧版字段，保留兼容；新模型用 activity_blocks 关联
            );
            CREATE INDEX IF NOT EXISTS idx_bili_view_at ON bili_history(view_at DESC);

            -- 目标表（动机 = 目标上的标签聚合）
            CREATE TABLE IF NOT EXISTS goals (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                tags TEXT NOT NULL DEFAULT '[]',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

            CREATE TABLE IF NOT EXISTS presence_spans (
                id TEXT PRIMARY KEY,
                start_time TEXT NOT NULL,
                end_time TEXT,
                state TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_presence_start ON presence_spans(start_time);

            -- 自研感知层：ActivityWatch 风格 bucket + heartbeat event
            CREATE TABLE IF NOT EXISTS perception_buckets (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                event_type TEXT NOT NULL,
                source TEXT NOT NULL,
                hostname TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS perception_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bucket_id TEXT NOT NULL REFERENCES perception_buckets(id) ON DELETE CASCADE,
                start_at TEXT NOT NULL,
                end_at TEXT NOT NULL,
                data_json TEXT NOT NULL,
                data_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_perception_bucket_time
                ON perception_events(bucket_id, start_at, end_at);
            CREATE INDEX IF NOT EXISTS idx_perception_time
                ON perception_events(start_at, end_at);
            CREATE INDEX IF NOT EXISTS idx_perception_hash
                ON perception_events(bucket_id, data_hash, end_at);

            CREATE TABLE IF NOT EXISTS app_catalog (
                app_key TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                exe_path TEXT,
                color TEXT NOT NULL,
                icon_png BLOB,
                first_seen TEXT NOT NULL,
                last_seen TEXT NOT NULL
            );

            -- B 站视频资产：下载记录 + 后续逐字稿/AI总结/笔记
            -- bvid 软引用 bili_history.bvid（不强制 FK，允许下载非历史中的视频）
            CREATE TABLE IF NOT EXISTS bili_video_assets (
                id TEXT PRIMARY KEY,
                bvid TEXT NOT NULL,
                download_status TEXT NOT NULL DEFAULT 'queued',
                download_path TEXT,
                quality_request TEXT,
                quality_id INTEGER,
                video_codecs TEXT,
                audio_codecs TEXT,
                file_size INTEGER,
                error_message TEXT,
                started_at TEXT,
                completed_at TEXT,
                transcript TEXT,
                ai_summary TEXT,
                notes TEXT,
                visual_transcript TEXT,
                audio_transcript TEXT,
                visual_transcribed_at TEXT,
                audio_transcribed_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_bili_assets_bvid ON bili_video_assets(bvid);
            CREATE INDEX IF NOT EXISTS idx_bili_assets_status ON bili_video_assets(download_status);
            CREATE INDEX IF NOT EXISTS idx_bili_assets_created ON bili_video_assets(created_at DESC);

            -- 模型库（id + 通用元信息）
            CREATE TABLE IF NOT EXISTS model_registry (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,           -- 'text' | 'omni' | 'realtime'
                provider TEXT NOT NULL DEFAULT 'dashscope',
                display_name TEXT,
                modalities TEXT,                  -- JSON 数组：['text','image','video','audio_in','audio_out']
                context_window INTEGER,
                notes TEXT,
                deprecated INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- 模型分档定价（同一 model_id 多行 = 多个输入 token 区间）
            CREATE TABLE IF NOT EXISTS model_pricing (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model_id TEXT NOT NULL,
                tier_min_tokens INTEGER NOT NULL DEFAULT 0,
                tier_max_tokens INTEGER,          -- NULL = 无上限
                price_input_text REAL,
                price_input_image REAL,
                price_input_video REAL,
                price_input_audio REAL,
                price_output_text REAL,
                price_output_text_thinking REAL,
                price_output_audio REAL,
                FOREIGN KEY (model_id) REFERENCES model_registry(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_pricing_model ON model_pricing(model_id, tier_min_tokens);

            -- 功能 → 模型绑定
            CREATE TABLE IF NOT EXISTS feature_bindings (
                feature TEXT PRIMARY KEY,         -- 'bili_visual_transcribe' / 'fairy_chat' / ...
                model_id TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- 百炼 API Key 库（本地保存，调用日志按 id 归属）
            CREATE TABLE IF NOT EXISTS model_api_keys (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                api_key TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_model_api_keys_active ON model_api_keys(is_active);

            -- 调用日志（每次模型调用一行）
            CREATE TABLE IF NOT EXISTS model_call_log (
                id TEXT PRIMARY KEY,
                api_key_id TEXT,
                feature TEXT NOT NULL,
                model_id TEXT NOT NULL,
                started_at TEXT NOT NULL,
                duration_ms INTEGER,
                prompt_text_tokens INTEGER NOT NULL DEFAULT 0,
                prompt_image_tokens INTEGER NOT NULL DEFAULT 0,
                prompt_video_tokens INTEGER NOT NULL DEFAULT 0,
                prompt_audio_tokens INTEGER NOT NULL DEFAULT 0,
                completion_text_tokens INTEGER NOT NULL DEFAULT 0,
                completion_audio_tokens INTEGER NOT NULL DEFAULT 0,
                cost_cny REAL,
                free_quota_tokens INTEGER NOT NULL DEFAULT 0,
                free_quota_saved_cny REAL NOT NULL DEFAULT 0,
                success INTEGER NOT NULL DEFAULT 1,
                error_message TEXT,
                metadata TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_call_started ON model_call_log(started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_call_feature ON model_call_log(feature, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_call_model ON model_call_log(model_id, started_at DESC);

            CREATE TABLE IF NOT EXISTS model_free_quota (
                model_id TEXT PRIMARY KEY,
                has_free_quota INTEGER NOT NULL DEFAULT 0,
                not_supported INTEGER NOT NULL DEFAULT 0,
                used_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                remaining_tokens INTEGER NOT NULL DEFAULT 0,
                used_percent TEXT,
                expire_date TEXT,
                raw_quota TEXT,
                scanned_at TEXT NOT NULL,
                error_message TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_model_free_quota_remaining
                ON model_free_quota(remaining_tokens DESC, scanned_at DESC);
        "#).map_err(|e| format!("创建表失败: {}", e))?;

        // 渐进式迁移：旧库里 model_call_log 已存在时补 api_key_id
        let _ = conn.execute_batch("ALTER TABLE model_call_log ADD COLUMN api_key_id TEXT");
        let _ = conn.execute_batch("ALTER TABLE model_call_log ADD COLUMN free_quota_tokens INTEGER NOT NULL DEFAULT 0");
        let _ = conn.execute_batch("ALTER TABLE model_call_log ADD COLUMN free_quota_saved_cny REAL NOT NULL DEFAULT 0");
        let _ = conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_call_api_key ON model_call_log(api_key_id, started_at DESC)");

        // 首次启动写入百炼模型库与默认绑定种子（已存在则跳过，幂等）
        seed_model_registry(&conn)?;
        seed_feature_bindings(&conn)?;

        log::info!("[Database] 表初始化完成");
        Ok(())
    }

    // ── Activity Records (Categories / Tags / Blocks) ──

    /// 查询整个标签库（categories + tags），用于右栏渲染
    pub async fn get_activity_palette(&self) -> Result<ActivityPalette, String> {
        let conn = self.conn.lock().await;

        let mut cat_stmt = conn.prepare(
            "SELECT id, name, color, sort_order, created_at, last_used_at
             FROM activity_categories
             ORDER BY sort_order ASC, last_used_at DESC"
        ).map_err(|e| e.to_string())?;
        let categories: Vec<ActivityCategory> = cat_stmt.query_map([], |row| {
            Ok(ActivityCategory {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
                last_used_at: row.get(5)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .collect();

        let mut tag_stmt = conn.prepare(
            "SELECT id, category_id, full_path, leaf_name, depth, created_at, last_used_at
             FROM activity_tags
             ORDER BY full_path ASC"
        ).map_err(|e| e.to_string())?;
        let tags: Vec<ActivityTag> = tag_stmt.query_map([], |row| {
            Ok(ActivityTag {
                id: row.get(0)?,
                category_id: row.get(1)?,
                full_path: row.get(2)?,
                leaf_name: row.get(3)?,
                depth: row.get(4)?,
                created_at: row.get(5)?,
                last_used_at: row.get(6)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .collect();

        Ok(ActivityPalette { categories, tags })
    }

    pub async fn add_activity_category(&self, req: AddCategoryRequest) -> Result<ActivityCategory, String> {
        let name = req.name.trim().to_string();
        if name.is_empty() {
            return Err("分类名不能为空".into());
        }
        if name.contains(',') {
            return Err("分类名不能包含逗号".into());
        }
        let conn = self.conn.lock().await;
        let now = local_now_string();
        conn.execute(
            "INSERT INTO activity_categories (name, color, sort_order, created_at, last_used_at)
             VALUES (?, ?, COALESCE((SELECT MAX(sort_order)+1 FROM activity_categories), 0), ?, ?)",
            params![&name, &req.color, &now, &now],
        ).map_err(|e| format!("添加分类失败: {}", e))?;
        let id = conn.last_insert_rowid();
        Ok(ActivityCategory {
            id,
            name,
            color: req.color,
            sort_order: 0,
            created_at: now.clone(),
            last_used_at: now,
        })
    }

    pub async fn delete_activity_category(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM activity_categories WHERE id = ?", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 更新分类名 / 颜色（任一为 None 则跳过）。改名时会级联更新所有 tag 的 full_path 首段。
    pub async fn update_activity_category(&self, req: UpdateCategoryRequest) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let old_name: String = conn.query_row(
            "SELECT name FROM activity_categories WHERE id = ?",
            params![req.id],
            |row| row.get(0),
        ).map_err(|_| "分类不存在".to_string())?;

        if let Some(color) = req.color.as_deref() {
            conn.execute(
                "UPDATE activity_categories SET color = ? WHERE id = ?",
                params![color, req.id],
            ).map_err(|e| e.to_string())?;
        }

        if let Some(new_name) = req.name.as_deref() {
            let new_name = new_name.trim();
            if new_name.is_empty() {
                return Err("分类名不能为空".into());
            }
            if new_name.contains(',') {
                return Err("分类名不能包含逗号".into());
            }
            if new_name == old_name {
                return Ok(());
            }
            conn.execute(
                "UPDATE activity_categories SET name = ? WHERE id = ?",
                params![new_name, req.id],
            ).map_err(|e| format!("更新分类名失败: {}", e))?;

            // 级联更新 tag.full_path 与 leaf_name
            let old_prefix = old_name.clone();
            let old_prefix_with_comma = format!("{},", old_prefix);
            let new_prefix = new_name.to_string();
            let new_prefix_with_comma = format!("{},", new_prefix);

            // 1) 顶层叶子（full_path 恰等于旧 category 名）
            conn.execute(
                "UPDATE activity_tags
                 SET full_path = ?, leaf_name = ?
                 WHERE category_id = ? AND full_path = ?",
                params![&new_prefix, &new_prefix, req.id, &old_prefix],
            ).map_err(|e| e.to_string())?;

            // 2) 子层标签
            conn.execute(
                "UPDATE activity_tags
                 SET full_path = ? || SUBSTR(full_path, ?)
                 WHERE category_id = ? AND full_path LIKE ? || '%'",
                params![
                    &new_prefix_with_comma,
                    (old_prefix_with_comma.chars().count() as i64) + 1,
                    req.id,
                    &old_prefix_with_comma,
                ],
            ).map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    pub async fn add_activity_tag(&self, req: AddTagRequest) -> Result<ActivityTag, String> {
        let path = req.full_path.trim().to_string();
        if path.is_empty() {
            return Err("标签路径不能为空".into());
        }
        let segments: Vec<&str> = path.split(',').map(|s| s.trim()).collect();
        if segments.iter().any(|s| s.is_empty()) {
            return Err("标签路径段不能为空".into());
        }
        if segments.len() > 4 {
            return Err("标签路径最多 4 层（含分类）".into());
        }
        let leaf = segments.last().unwrap_or(&"").to_string();
        let depth = segments.len() as i32;
        let conn = self.conn.lock().await;

        // 校验首段必须等于 category 名
        let cat_name: String = conn.query_row(
            "SELECT name FROM activity_categories WHERE id = ?",
            params![req.category_id],
            |row| row.get(0),
        ).map_err(|_| "分类不存在".to_string())?;
        if segments.first().map(|s| s.to_string()).as_deref() != Some(cat_name.as_str()) {
            return Err(format!("路径首段必须等于分类名 \"{}\"", cat_name));
        }

        let normalized = segments.join(",");
        let now = local_now_string();
        conn.execute(
            "INSERT INTO activity_tags (category_id, full_path, leaf_name, depth, created_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![req.category_id, &normalized, &leaf, depth, &now, &now],
        ).map_err(|e| format!("添加标签失败: {}", e))?;
        let id = conn.last_insert_rowid();
        Ok(ActivityTag {
            id,
            category_id: req.category_id,
            full_path: normalized,
            leaf_name: leaf,
            depth,
            created_at: now.clone(),
            last_used_at: now,
        })
    }

    pub async fn delete_activity_tag(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM activity_tags WHERE id = ?", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 重命名标签路径中的某一段（叶子或中间节点）：
    /// full_old_path = "工作,毕业论文"，new_segment = "毕业论文-2024"
    /// → 把所有以 "工作,毕业论文" 开头的 tag 的对应段都换掉
    pub async fn rename_activity_path(&self, req: RenamePathRequest) -> Result<(), String> {
        let new_seg = req.new_segment.trim();
        if new_seg.is_empty() {
            return Err("段名不能为空".into());
        }
        if new_seg.contains(',') {
            return Err("段名不能包含逗号".into());
        }
        let segments: Vec<&str> = req.full_old_path.split(',').map(|s| s.trim()).collect();
        if segments.iter().any(|s| s.is_empty()) {
            return Err("路径段不能为空".into());
        }

        let conn = self.conn.lock().await;

        // 校验分类存在
        let cat_name: String = conn.query_row(
            "SELECT name FROM activity_categories WHERE id = ?",
            params![req.category_id],
            |row| row.get(0),
        ).map_err(|_| "分类不存在".to_string())?;
        if segments.first().map(|s| *s) != Some(cat_name.as_str()) {
            return Err("路径首段必须等于分类名".into());
        }

        // 构造新前缀（替换最后一段）
        let mut new_segments: Vec<String> = segments.iter().map(|s| s.to_string()).collect();
        let depth = new_segments.len();
        new_segments[depth - 1] = new_seg.to_string();
        let new_prefix = new_segments.join(",");
        if new_prefix == req.full_old_path {
            return Ok(());
        }

        let old_prefix = req.full_old_path.clone();
        let old_prefix_with_comma = format!("{},", old_prefix);
        let new_prefix_with_comma = format!("{},", new_prefix);

        // 1) 该段恰为叶子：full_path 完全等于 old_prefix
        conn.execute(
            "UPDATE activity_tags
             SET full_path = ?, leaf_name = ?
             WHERE category_id = ? AND full_path = ?",
            params![&new_prefix, new_seg, req.category_id, &old_prefix],
        ).map_err(|e| e.to_string())?;

        // 2) 该段为中间节点：full_path 以 old_prefix+',' 开头
        conn.execute(
            "UPDATE activity_tags
             SET full_path = ? || SUBSTR(full_path, ?)
             WHERE category_id = ? AND full_path LIKE ? || '%'",
            params![
                &new_prefix_with_comma,
                (old_prefix_with_comma.chars().count() as i64) + 1,
                req.category_id,
                &old_prefix_with_comma,
            ],
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub async fn paint_activity_blocks(&self, req: PaintBlocksRequest) -> Result<i64, String> {
        if req.minutes.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().await;
        let now = local_now_string();

        // 校验 tag 存在 + 拿 category_id 用于刷新 last_used_at
        let category_id: i64 = conn.query_row(
            "SELECT category_id FROM activity_tags WHERE id = ?",
            params![req.tag_id],
            |row| row.get(0),
        ).map_err(|_| "标签不存在".to_string())?;

        let mut affected = 0i64;
        for minute in &req.minutes {
            if *minute < 0 || *minute >= 1440 || minute % 5 != 0 {
                continue;
            }
            conn.execute(
                "INSERT INTO activity_blocks (date, minute, tag_id, created_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(date, minute) DO UPDATE SET
                     tag_id = excluded.tag_id,
                     created_at = excluded.created_at",
                params![&req.date, minute, req.tag_id, &now],
            ).map_err(|e| e.to_string())?;
            affected += 1;
        }

        conn.execute(
            "UPDATE activity_tags SET last_used_at = ? WHERE id = ?",
            params![&now, req.tag_id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE activity_categories SET last_used_at = ? WHERE id = ?",
            params![&now, category_id],
        ).map_err(|e| e.to_string())?;
        Ok(affected)
    }

    pub async fn erase_activity_blocks(&self, req: EraseBlocksRequest) -> Result<i64, String> {
        if req.minutes.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().await;
        let placeholders = req.minutes.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM activity_blocks WHERE date = ? AND minute IN ({})",
            placeholders
        );
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(req.date.clone())];
        for m in &req.minutes {
            params_vec.push(Box::new(*m));
        }
        let affected = conn.execute(
            &sql,
            rusqlite::params_from_iter(params_vec.iter().map(|b| b.as_ref())),
        ).map_err(|e| e.to_string())?;
        Ok(affected as i64)
    }

    pub async fn get_activity_blocks_by_date(&self, date: &str) -> Result<Vec<ActivityBlock>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT date, minute, tag_id, note, created_at
             FROM activity_blocks
             WHERE date = ?
             ORDER BY minute ASC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![date], |row| {
            Ok(ActivityBlock {
                date: row.get(0)?,
                minute: row.get(1)?,
                tag_id: row.get(2)?,
                note: row.get(3)?,
                created_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
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

    /// 全文搜索会话：按 title / summary / 任意一条 chat_messages.content LIKE 匹配
    /// 每个匹配会话附带最多 3 条命中片段（用于前端高亮显示 + 跳转锚点）
    pub async fn search_chat_sessions(&self, query: &str, limit: i64) -> Result<Vec<SessionSearchHit>, String> {
        let conn = self.conn.lock().await;
        // 转义 LIKE 元字符（%, _, \）以避免误匹配
        let escaped = query.replace('\\', r"\\").replace('%', r"\%").replace('_', r"\_");
        let pattern = format!("%{}%", escaped);

        // 先取匹配的 sessions（按更新时间倒序）
        let mut stmt = conn.prepare(
            "SELECT s.id, s.title, s.summary, s.created_at, s.updated_at
             FROM chat_sessions s
             WHERE s.title LIKE ?1 ESCAPE '\\'
                OR s.summary LIKE ?1 ESCAPE '\\'
                OR EXISTS (
                    SELECT 1 FROM chat_messages m
                    WHERE m.session_id = s.id AND m.content LIKE ?1 ESCAPE '\\'
                )
             ORDER BY s.updated_at DESC
             LIMIT ?2"
        ).map_err(|e| e.to_string())?;

        let sessions: Vec<ChatSession> = stmt.query_map(params![&pattern, limit], |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        // 每个 session 取所有命中 message 片段（防御性上限 200，正常会话很难触达）
        let mut snippet_stmt = conn.prepare(
            "SELECT role, content, timestamp
             FROM chat_messages
             WHERE session_id = ?1 AND content LIKE ?2 ESCAPE '\\'
             ORDER BY timestamp DESC
             LIMIT 200"
        ).map_err(|e| e.to_string())?;

        let mut out = Vec::with_capacity(sessions.len());
        for s in sessions {
            let snippets: Vec<MessageSnippet> = snippet_stmt
                .query_map(params![&s.id, &pattern], |row| {
                    let role: String = row.get(0)?;
                    let content: Option<String> = row.get(1)?;
                    let timestamp: String = row.get(2)?;
                    Ok(MessageSnippet {
                        role,
                        excerpt: build_excerpt(content.as_deref().unwrap_or(""), query, 60),
                        timestamp,
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            out.push(SessionSearchHit { session: s, snippets });
        }

        Ok(out)
    }

    /// 获取会话的所有消息
    pub async fn get_chat_messages(&self, session_id: &str) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, tool_calls, tool_call_id, name, timestamp, audio_path, duration_ms, usage_json FROM chat_messages WHERE session_id = ? ORDER BY timestamp"
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
                audio_path: row.get(8)?,
                duration_ms: row.get(9)?,
                usage_json: row.get(10)?,
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
                "INSERT INTO chat_messages (id, session_id, role, content, tool_calls, tool_call_id, name, timestamp, audio_path, duration_ms, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![&id, session_id, &msg.role, &msg.content, &msg.tool_calls, &msg.tool_call_id, &msg.name, &msg.timestamp, &msg.audio_path, &msg.duration_ms, &msg.usage_json],
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

    /// 清理所有"空白会话"——没有任何 chat_messages 关联的 chat_session。
    /// `except_id` 用于排除当前正在使用的会话，避免误删。返回被删的 session id 列表。
    pub async fn delete_empty_chat_sessions(&self, except_id: Option<&str>) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().await;

        // 先查出待删 ids（用于回传给前端做 UI 同步）
        let (sql_select, ids): (&str, Vec<String>) = match except_id {
            Some(eid) => {
                let mut stmt = conn.prepare(
                    "SELECT s.id FROM chat_sessions s
                     LEFT JOIN chat_messages m ON m.session_id = s.id
                     WHERE m.id IS NULL AND s.id != ?"
                ).map_err(|e| e.to_string())?;
                let rows = stmt.query_map(params![eid], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                ("with_except", rows.filter_map(|r| r.ok()).collect())
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT s.id FROM chat_sessions s
                     LEFT JOIN chat_messages m ON m.session_id = s.id
                     WHERE m.id IS NULL"
                ).map_err(|e| e.to_string())?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                ("no_except", rows.filter_map(|r| r.ok()).collect())
            }
        };
        let _ = sql_select;

        if ids.is_empty() {
            return Ok(Vec::new());
        }

        // 批量删（chat_messages CASCADE 由 FK 处理；空会话本来也没消息）
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let del_sql = format!("DELETE FROM chat_sessions WHERE id IN ({})", placeholders);
        conn.execute(&del_sql, rusqlite::params_from_iter(ids.iter()))
            .map_err(|e| e.to_string())?;

        log::info!("[Database] 清理空白会话 {} 条", ids.len());
        Ok(ids)
    }

    /// 删除会话（含其所有消息）
    pub async fn delete_chat_session(&self, session_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM chat_messages WHERE session_id = ?",
            params![session_id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM chat_sessions WHERE id = ?",
            params![session_id],
        ).map_err(|e| e.to_string())?;
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

    /// 模糊搜索 B站历史：title / author_name 前缀任意位置匹配，bvid 整段精确匹配（大小写不敏感）
    /// 按 view_at 倒序，limit 兜底。q 为空 → 返回空。
    pub async fn search_bili_history(
        &self, q: &str, limit: i64,
    ) -> Result<Vec<BiliHistoryRow>, String> {
        let q_trim = q.trim();
        if q_trim.is_empty() {
            return Ok(Vec::new())
        }
        let conn = self.conn.lock().await;
        let like = format!("%{}%", q_trim.replace('%', "\\%").replace('_', "\\_"));
        let sql = r#"
            SELECT bvid, oid, title, author_name, cover, duration, progress, view_at, event_id
            FROM bili_history
            WHERE title       LIKE ?1 ESCAPE '\'
               OR author_name LIKE ?1 ESCAPE '\'
               OR bvid = ?2
            ORDER BY view_at DESC
            LIMIT ?3
        "#;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(
            params![like, q_trim, limit],
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
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 查询某天的 B站观看 spans（用于昼夜表轨道）
    /// date 格式: "2026-04-06"
    /// 跨天的 span（如 23:30 → 次日 00:30）只要与该天有交集就会返回
    pub async fn get_bili_spans_for_date(&self, date: &str) -> Result<Vec<BiliSpan>, String> {
        let conn = self.conn.lock().await;
        // 弃用 progress/duration 反推：每条固定占 2 分钟（120s），
        // 起点若叠到上一条的 view_at（结束时刻），就贴合上一条的结束。
        // SQLite 3.25+ 支持窗口函数 LAG。
        let sql = r#"
            WITH ordered AS (
                SELECT
                    bvid, oid, title, author_name, cover, duration, progress, view_at, event_id,
                    view_at - 120 AS naive_start,
                    LAG(view_at) OVER (ORDER BY view_at ASC) AS prev_end
                FROM bili_history
            ),
            spans AS (
                SELECT
                    bvid, oid, title, author_name, cover, duration, progress, view_at, event_id,
                    CASE
                        WHEN prev_end IS NOT NULL AND naive_start < prev_end THEN prev_end
                        ELSE naive_start
                    END AS start_unix
                FROM ordered
            )
            SELECT
                s.bvid, s.oid, s.title, s.author_name, s.cover, s.duration, s.progress,
                datetime(s.start_unix, 'unixepoch', 'localtime') AS start_dt,
                datetime(s.view_at,    'unixepoch', 'localtime') AS end_dt,
                s.view_at, s.event_id,
                (SELECT MAX(a.file_size) FROM bili_video_assets a
                  WHERE a.bvid = s.bvid AND a.download_status = 'done') AS file_size_bytes,
                EXISTS (SELECT 1 FROM bili_video_assets a
                  WHERE a.bvid = s.bvid
                    AND (a.visual_transcript IS NOT NULL OR a.audio_transcript IS NOT NULL OR a.combined_transcript IS NOT NULL)
                ) AS transcribed
            FROM spans s
            WHERE date(s.view_at,    'unixepoch', 'localtime') = ?1
               OR date(s.start_unix, 'unixepoch', 'localtime') = ?1
            ORDER BY s.view_at ASC
        "#;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![date], |row| {
            let file_size_bytes: Option<i64> = row.get(11)?;
            let transcribed: bool = row.get(12)?;
            Ok(BiliSpan {
                bvid:        row.get(0)?,
                oid:         row.get(1)?,
                title:       row.get(2)?,
                author_name: row.get(3)?,
                cover:       row.get(4)?,
                duration:    row.get(5)?,
                progress:    row.get(6)?,
                start_at:    row.get(7)?,
                end_at:      row.get(8)?,
                view_at:     row.get(9)?,
                event_id:    row.get(10)?,
                downloaded:  file_size_bytes.is_some(),
                file_size_bytes,
                transcribed,
            })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 在 [from, to] 范围内，返回所有"有数据"的日期（用于昼夜表前后日按钮）
    /// 数据 = activity_blocks OR bili_history OR presence_spans OR perception_events 任意一项有记录
    pub async fn get_data_days(
        &self, from: &str, to: &str,
    ) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().await;
        let sql = r#"
            SELECT day FROM (
                SELECT DISTINCT date AS day
                FROM activity_blocks
                WHERE date BETWEEN ?1 AND ?2
                UNION
                SELECT DISTINCT date(view_at, 'unixepoch', 'localtime') AS day
                FROM bili_history
                WHERE date(view_at, 'unixepoch', 'localtime') BETWEEN ?1 AND ?2
                UNION
                SELECT DISTINCT substr(start_time, 1, 10) AS day
                FROM presence_spans
                WHERE substr(start_time, 1, 10) BETWEEN ?1 AND ?2
                UNION
                SELECT DISTINCT substr(start_at, 1, 10) AS day
                FROM perception_events
                WHERE substr(start_at, 1, 10) BETWEEN ?1 AND ?2
            )
            ORDER BY day ASC
        "#;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![from, to], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 按日聚合 B 站观看数 + 已下载数（用于日历角标）
    /// from_date / to_date 格式 "YYYY-MM-DD"，闭区间
    pub async fn get_bili_day_counts(
        &self, from_date: &str, to_date: &str,
    ) -> Result<Vec<BiliDayCount>, String> {
        let conn = self.conn.lock().await;
        let sql = r#"
            WITH bili_in_range AS (
                SELECT
                    bvid,
                    date(view_at, 'unixepoch', 'localtime') AS day
                FROM bili_history
                WHERE date(view_at, 'unixepoch', 'localtime') BETWEEN ?1 AND ?2
            )
            SELECT
                day,
                COUNT(*) AS watched,
                SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM bili_video_assets a
                    WHERE a.bvid = bili_in_range.bvid AND a.download_status = 'done'
                ) THEN 1 ELSE 0 END) AS downloaded,
                SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM bili_video_assets a
                    WHERE a.bvid = bili_in_range.bvid
                      AND (a.visual_transcript IS NOT NULL OR a.audio_transcript IS NOT NULL OR a.combined_transcript IS NOT NULL)
                ) THEN 1 ELSE 0 END) AS transcribed
            FROM bili_in_range
            GROUP BY day
            ORDER BY day ASC
        "#;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![from_date, to_date], |row| {
            Ok(BiliDayCount {
                day:        row.get(0)?,
                watched:    row.get(1)?,
                downloaded: row.get(2)?,
                transcribed: row.get(3)?,
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

    // ── Goals ──

    pub async fn get_goals(&self, status: Option<&str>) -> Result<Vec<Goal>, String> {
        let conn = self.conn.lock().await;
        if let Some(s) = status {
            let mut stmt = conn.prepare(
                "SELECT id, title, status, tags, created_at, completed_at FROM goals WHERE status = ? ORDER BY created_at DESC"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([s], |row| Goal::from_row(row))
                .map_err(|e| e.to_string())?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, title, status, tags, created_at, completed_at FROM goals ORDER BY created_at DESC"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| Goal::from_row(row))
                .map_err(|e| e.to_string())?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        }
    }

    pub async fn create_goal(&self, goal: &Goal) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO goals (id, title, status, tags, created_at) VALUES (?, ?, ?, ?, ?)",
            params![goal.id, goal.title, goal.status, goal.tags, goal.created_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn update_goal(&self, id: &str, title: Option<&str>, status: Option<&str>, tags: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().await;
        if let Some(t) = title {
            conn.execute("UPDATE goals SET title = ? WHERE id = ?", params![t, id]).map_err(|e| e.to_string())?;
        }
        if let Some(s) = status {
            let completed_at = if s == "completed" { Some(chrono::Utc::now().to_rfc3339()) } else { None };
            conn.execute("UPDATE goals SET status = ?, completed_at = ? WHERE id = ?", params![s, completed_at, id]).map_err(|e| e.to_string())?;
        }
        if let Some(t) = tags {
            conn.execute("UPDATE goals SET tags = ? WHERE id = ?", params![t, id]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn delete_goal(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM goals WHERE id = ?", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Presence Spans ──

    pub async fn get_presence_spans_by_date(&self, date: &str) -> Result<Vec<PresenceSpan>, String> {
        let conn = self.conn.lock().await;
        let date_prefix = format!("{}%", date);
        let mut stmt = conn.prepare(
            "SELECT id, start_time, end_time, state FROM presence_spans WHERE start_time LIKE ? ORDER BY start_time"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&date_prefix], |row| PresenceSpan::from_row(row))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub async fn upsert_presence_span(&self, span: &PresenceSpan) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR REPLACE INTO presence_spans (id, start_time, end_time, state) VALUES (?, ?, ?, ?)",
            params![span.id, span.start_time, span.end_time, span.state],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn close_presence_span(&self, id: &str, end_time: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE presence_spans SET end_time = ? WHERE id = ? AND end_time IS NULL",
            params![end_time, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Perception Events ──

    pub async fn record_perception_heartbeat(&self, heartbeat: PerceptionHeartbeat) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let data_json = serde_json::to_string(&heartbeat.data)
            .map_err(|e| format!("序列化感知事件失败: {}", e))?;
        let data_hash = stable_hash_hex(&data_json);
        let now = &heartbeat.observed_at;

        conn.execute(
            r#"INSERT INTO perception_buckets
               (id, kind, event_type, source, hostname, created_at, updated_at)
               VALUES (?, ?, ?, ?, '', ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   kind=excluded.kind,
                   event_type=excluded.event_type,
                   source=excluded.source,
                   updated_at=excluded.updated_at"#,
            params![
                &heartbeat.bucket_id,
                &heartbeat.bucket_kind,
                &heartbeat.event_type,
                &heartbeat.source,
                now,
                now,
            ],
        ).map_err(|e| e.to_string())?;

        if heartbeat.bucket_kind == "window" {
            if let Some(app) = heartbeat.data.get("app").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                let exe_path = heartbeat.data.get("exe_path").and_then(|v| v.as_str());
                let color = color_for_app(app);
                conn.execute(
                    r#"INSERT INTO app_catalog
                       (app_key, display_name, exe_path, color, first_seen, last_seen)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(app_key) DO UPDATE SET
                           display_name=excluded.display_name,
                           exe_path=COALESCE(excluded.exe_path, app_catalog.exe_path),
                           color=app_catalog.color,
                           last_seen=excluded.last_seen"#,
                    params![app, app, exe_path, &color, now, now],
                ).map_err(|e| e.to_string())?;
            }
        }

        let last = conn.query_row(
            r#"SELECT id, end_at, data_json, data_hash
               FROM perception_events
               WHERE bucket_id = ?
               ORDER BY end_at DESC, id DESC
               LIMIT 1"#,
            params![&heartbeat.bucket_id],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            )),
        ).ok();

        if let Some((id, last_end, last_json, last_hash)) = last {
            let same_data = last_hash == data_hash && last_json == data_json;
            if same_data && within_pulsetime(&last_end, now, heartbeat.pulsetime_seconds) {
                conn.execute(
                    "UPDATE perception_events SET end_at = ?, updated_at = datetime('now') WHERE id = ?",
                    params![now, id],
                ).map_err(|e| e.to_string())?;
                return Ok(());
            }
        }

        conn.execute(
            r#"INSERT INTO perception_events
               (bucket_id, start_at, end_at, data_json, data_hash)
               VALUES (?, ?, ?, ?, ?)"#,
            params![&heartbeat.bucket_id, now, now, data_json, data_hash],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn get_perception_spans_for_date(&self, date: &str) -> Result<Vec<crate::manictime::MtSpan>, String> {
        let day_start = format!("{} 00:00:00", date);
        let day_end = format!("{} 00:00:00", next_day_str(date)?);
        let conn = self.conn.lock().await;

        // 一次性把 app → 主色 拉成内存 map（来自 app_catalog，已被图标主色覆盖）
        let app_colors: std::collections::HashMap<String, String> = {
            let mut stmt = conn.prepare("SELECT app_key, color FROM app_catalog")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let mut stmt = conn.prepare(
            r#"SELECT e.id, b.kind, e.start_at, e.end_at, e.data_json
               FROM perception_events e
               JOIN perception_buckets b ON b.id = e.bucket_id
               WHERE e.start_at < ?1
                 AND e.end_at >= ?2
               ORDER BY e.start_at ASC, e.id ASC"#,
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![&day_end, &day_start], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        }).map_err(|e| e.to_string())?;

        let mut spans = Vec::new();
        for row in rows.filter_map(|r| r.ok()) {
            let (id, kind, start_at, end_at, data_json) = row;
            let data: serde_json::Value = serde_json::from_str(&data_json).unwrap_or(serde_json::Value::Null);
            let clipped_start = clip_dt(&start_at, &day_start, &day_end);
            let clipped_end = ensure_visible_end(&clip_dt(&end_at, &day_start, &day_end), &clipped_start);

            match kind.as_str() {
                "window" => {
                    let app = data.get("app").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                    let title = data.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    // 优先用 app_catalog 里写入的主色（=图标主色），找不到才退回 hash
                    let color = app_colors.get(&app).cloned().unwrap_or_else(|| color_for_app(&app));
                    spans.push(crate::manictime::MtSpan {
                        id,
                        track: "apps".to_string(),
                        start_at: clipped_start,
                        end_at: clipped_end,
                        title: if title.is_empty() { app.clone() } else { title },
                        group_name: Some(app.clone()),
                        color: Some(color),
                    });
                }
                "status" => {
                    let status = data.get("status").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                    spans.push(crate::manictime::MtSpan {
                        id,
                        track: "status".to_string(),
                        start_at: clipped_start,
                        end_at: clipped_end,
                        title: status.clone(),
                        group_name: Some(status.clone()),
                        color: Some(color_for_status(&status)),
                    });
                }
                "tag" => {
                    let title = data.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let group = data.get("group_name").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let color = data.get("color").and_then(|v| v.as_str()).map(|s| s.to_string());
                    spans.push(crate::manictime::MtSpan {
                        id,
                        track: "tags".to_string(),
                        start_at: clipped_start,
                        end_at: clipped_end,
                        title,
                        group_name: group,
                        color,
                    });
                }
                _ => {}
            }
        }

        spans.sort_by(|a, b| a.start_at.cmp(&b.start_at).then_with(|| a.track.cmp(&b.track)));
        Ok(spans)
    }

    pub async fn get_perception_app_icon_png(&self, app_name: &str) -> Result<Option<Vec<u8>>, String> {
        let conn = self.conn.lock().await;
        match conn.query_row(
            "SELECT icon_png FROM app_catalog WHERE app_key = ? LIMIT 1",
            params![app_name],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        ) {
            Ok(bytes) => Ok(bytes),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 仅取 app_key 列表（用于 icon_cache 启动时回填）
    pub async fn list_app_keys_with_icon(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT app_key FROM app_catalog WHERE icon_png IS NOT NULL"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 拉出 app_catalog 里所有有图标的条目（启动时刷主色用）
    pub async fn list_app_catalog_icons(&self) -> Result<Vec<(String, Vec<u8>)>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT app_key, icon_png FROM app_catalog WHERE icon_png IS NOT NULL"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 仅更新某个 app 的颜色字段
    pub async fn set_app_catalog_color(&self, app_name: &str, color: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE app_catalog SET color = ? WHERE app_key = ?",
            params![color, app_name],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn update_perception_app_icon(
        &self,
        app_name: &str,
        exe_path: Option<&str>,
        icon_bmp: &[u8],
        dominant_color: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        // 优先用图标主色；提取失败时回退到稳定 hash 调色板
        let color = dominant_color
            .map(|s| s.to_string())
            .unwrap_or_else(|| color_for_app(app_name));
        // 拿到图标 = 第一次"权威定色"，覆盖之前心跳写入的临时 hash 色
        conn.execute(
            r#"INSERT INTO app_catalog
               (app_key, display_name, exe_path, color, icon_png, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(app_key) DO UPDATE SET
                   display_name=excluded.display_name,
                   exe_path=COALESCE(excluded.exe_path, app_catalog.exe_path),
                   color=excluded.color,
                   icon_png=excluded.icon_png,
                   last_seen=excluded.last_seen"#,
            params![app_name, app_name, exe_path, &color, icon_bmp, &now, &now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── B 站视频资产 ──

    /// 创建一条新的下载记录（status=queued），返回 asset id
    pub async fn create_bili_asset(
        &self, bvid: &str, quality_request: Option<&str>,
    ) -> Result<String, String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;

        // 继承同 bvid 最近一条非空转录（visual / audio 各自独立取最近）
        // 避免"重新下载"插入新行后查询取到空 transcript 行，让用户误以为转录消失
        let inherit_visual: (Option<String>, Option<String>) = conn
            .query_row(
                r#"SELECT visual_transcript, visual_transcribed_at
                   FROM bili_video_assets
                   WHERE bvid = ? AND visual_transcript IS NOT NULL
                   ORDER BY updated_at DESC LIMIT 1"#,
                params![bvid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or((None, None));
        let inherit_audio: (Option<String>, Option<String>) = conn
            .query_row(
                r#"SELECT audio_transcript, audio_transcribed_at
                   FROM bili_video_assets
                   WHERE bvid = ? AND audio_transcript IS NOT NULL
                   ORDER BY updated_at DESC LIMIT 1"#,
                params![bvid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or((None, None));

        conn.execute(
            r#"INSERT INTO bili_video_assets
               (id, bvid, download_status, quality_request, created_at, updated_at,
                visual_transcript, visual_transcribed_at,
                audio_transcript, audio_transcribed_at)
               VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)"#,
            params![
                &id, bvid, quality_request, &now, &now,
                inherit_visual.0, inherit_visual.1,
                inherit_audio.0, inherit_audio.1,
            ],
        ).map_err(|e| e.to_string())?;
        Ok(id)
    }

    /// 更新下载状态（含可选 started_at；message 进度等不存）
    pub async fn update_bili_asset_status(
        &self, id: &str, status: &str, mark_started: bool,
    ) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        if mark_started {
            conn.execute(
                r#"UPDATE bili_video_assets
                   SET download_status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
                   WHERE id = ?"#,
                params![status, &now, &now, id],
            ).map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE bili_video_assets SET download_status = ?, updated_at = ? WHERE id = ?",
                params![status, &now, id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 下载完成：写入路径、清晰度、编解码、文件大小
    pub async fn complete_bili_asset(
        &self,
        id: &str,
        download_path: &str,
        quality_id: Option<i64>,
        video_codecs: Option<&str>,
        audio_codecs: Option<&str>,
        file_size: Option<i64>,
    ) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        conn.execute(
            r#"UPDATE bili_video_assets
               SET download_status='done', download_path=?, quality_id=?,
                   video_codecs=?, audio_codecs=?, file_size=?,
                   completed_at=?, updated_at=?,
                   error_message=NULL
               WHERE id=?"#,
            params![
                download_path, quality_id, video_codecs, audio_codecs, file_size,
                &now, &now, id,
            ],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 下载失败：写入错误信息
    pub async fn fail_bili_asset(&self, id: &str, message: &str) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        conn.execute(
            r#"UPDATE bili_video_assets
               SET download_status='error', error_message=?, completed_at=?, updated_at=?
               WHERE id=?"#,
            params![message, &now, &now, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 查询某个 bvid 的全部资产记录（按 created_at 倒序）
    pub async fn get_bili_assets_by_bvid(&self, bvid: &str) -> Result<Vec<BiliVideoAsset>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            r#"SELECT id, bvid, download_status, download_path, quality_request, quality_id,
                      video_codecs, audio_codecs, file_size, error_message,
                      started_at, completed_at, transcript, ai_summary, notes,
                      created_at, updated_at,
                      visual_transcript, audio_transcript,
                      visual_transcribed_at, audio_transcribed_at
               FROM bili_video_assets WHERE bvid = ? ORDER BY created_at DESC"#,
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([bvid], BiliVideoAsset::from_row)
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 查询最近的资产记录（用于下载列表面板，未来用）
    pub async fn get_recent_bili_assets(&self, limit: i64) -> Result<Vec<BiliVideoAsset>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            r#"SELECT id, bvid, download_status, download_path, quality_request, quality_id,
                      video_codecs, audio_codecs, file_size, error_message,
                      started_at, completed_at, transcript, ai_summary, notes,
                      created_at, updated_at,
                      visual_transcript, audio_transcript,
                      visual_transcribed_at, audio_transcribed_at
               FROM bili_video_assets ORDER BY created_at DESC LIMIT ?"#,
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([limit], BiliVideoAsset::from_row)
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

fn local_now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn stable_hash_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

fn within_pulsetime(last_end: &str, observed_at: &str, pulsetime_seconds: i64) -> bool {
    let Some(last) = parse_local_dt(last_end) else { return false };
    let Some(now) = parse_local_dt(observed_at) else { return false };
    if now < last {
        return false;
    }
    now.signed_duration_since(last).num_seconds() <= pulsetime_seconds
}

fn parse_local_dt(value: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").ok()
}

fn format_local_dt(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn next_day_str(date: &str) -> Result<String, String> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|e| format!("日期格式错误: {}", e))?;
    Ok((d + Duration::days(1)).format("%Y-%m-%d").to_string())
}

fn clip_dt(value: &str, min_value: &str, max_value: &str) -> String {
    if value < min_value {
        min_value.to_string()
    } else if value > max_value {
        max_value.to_string()
    } else {
        value.to_string()
    }
}

fn ensure_visible_end(end_at: &str, start_at: &str) -> String {
    if end_at > start_at {
        return end_at.to_string();
    }

    parse_local_dt(start_at)
        .map(|dt| format_local_dt(dt + Duration::seconds(1)))
        .unwrap_or_else(|| end_at.to_string())
}

fn color_for_status(status: &str) -> String {
    match status {
        "active" => "#20D6A3".to_string(),
        "idle" => "#F0B429".to_string(),
        "afk" => "#7D879C".to_string(),
        "locked" => "#D64545".to_string(),
        _ => "#8B9DC3".to_string(),
    }
}

fn color_for_app(app: &str) -> String {
    const PALETTE: [&str; 24] = [
        "#22C55E", "#38BDF8", "#F97316", "#E879F9", "#FACC15", "#14B8A6",
        "#FB7185", "#A78BFA", "#84CC16", "#60A5FA", "#F472B6", "#2DD4BF",
        "#C084FC", "#F59E0B", "#10B981", "#06B6D4", "#EF4444", "#8B5CF6",
        "#D946EF", "#65A30D", "#0EA5E9", "#F43F5E", "#A3E635", "#FBBF24",
    ];
    let hash = stable_hash_hex(&app.to_lowercase());
    let idx = u64::from_str_radix(&hash[..8], 16).unwrap_or(0) as usize % PALETTE.len();
    PALETTE[idx].to_string()
}

impl BiliVideoAsset {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(BiliVideoAsset {
            id:               row.get(0)?,
            bvid:             row.get(1)?,
            download_status:  row.get(2)?,
            download_path:    row.get(3)?,
            quality_request:  row.get(4)?,
            quality_id:       row.get(5)?,
            video_codecs:     row.get(6)?,
            audio_codecs:     row.get(7)?,
            file_size:        row.get(8)?,
            error_message:    row.get(9)?,
            started_at:       row.get(10)?,
            completed_at:     row.get(11)?,
            transcript:       row.get(12)?,
            ai_summary:       row.get(13)?,
            notes:            row.get(14)?,
            created_at:       row.get(15)?,
            updated_at:       row.get(16)?,
            visual_transcript:    row.get(17).ok(),
            audio_transcript:     row.get(18).ok(),
            visual_transcribed_at: row.get(19).ok(),
            audio_transcribed_at:  row.get(20).ok(),
        })
    }
}

impl Database {
    /// 按 download_path 读取转录缓存（visual + audio + combined）
    pub async fn get_bili_transcripts_by_path(
        &self, download_path: &str,
    ) -> Result<BiliTranscriptCache, String> {
        let conn = self.conn.lock().await;
        type Row = (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);
        let row: Option<Row> = conn
            .query_row(
                r#"SELECT visual_transcript, audio_transcript, combined_transcript,
                          visual_transcribed_at, audio_transcribed_at, combined_transcribed_at
                   FROM bili_video_assets
                   WHERE download_path = ? AND download_status = 'done'
                   ORDER BY updated_at DESC LIMIT 1"#,
                params![download_path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("查询转录缓存失败: {}", other)),
            })?;
        Ok(match row {
            Some((v, a, c, va, aa, ca)) => BiliTranscriptCache {
                visual: v, audio: a, combined: c,
                visual_at: va, audio_at: aa, combined_at: ca,
            },
            None => BiliTranscriptCache {
                visual: None, audio: None, combined: None,
                visual_at: None, audio_at: None, combined_at: None,
            },
        })
    }

    /// 按 download_path 写入指定 kind 的转录文本（"visual" / "audio" / "combined"）
    pub async fn update_bili_transcript_by_path(
        &self, download_path: &str, kind: &str, text: &str,
    ) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        let sql = match kind {
            "visual" => r#"UPDATE bili_video_assets
                          SET visual_transcript = ?, visual_transcribed_at = ?, updated_at = ?
                          WHERE download_path = ? AND download_status = 'done'"#,
            "audio"  => r#"UPDATE bili_video_assets
                          SET audio_transcript = ?, audio_transcribed_at = ?, updated_at = ?
                          WHERE download_path = ? AND download_status = 'done'"#,
            "combined" => r#"UPDATE bili_video_assets
                          SET combined_transcript = ?, combined_transcribed_at = ?, updated_at = ?
                          WHERE download_path = ? AND download_status = 'done'"#,
            other => return Err(format!("未知 kind: {}", other)),
        };
        let n = conn.execute(sql, params![text, &now, &now, download_path])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("未找到对应资产记录: {}", download_path));
        }
        Ok(())
    }
}

// ── PresenceSpan ──

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PresenceSpan {
    pub id: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub state: String,  // "present" | "absent"
}

impl PresenceSpan {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(PresenceSpan {
            id:         row.get(0)?,
            start_time: row.get(1)?,
            end_time:   row.get(2)?,
            state:      row.get(3)?,
        })
    }
}

// ── Goal ──

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Goal {
    pub id: String,
    pub title: String,
    pub status: String,         // "active" | "completed" | "abandoned"
    pub tags: String,           // JSON array，如 ["健康","成长"]
    pub created_at: String,
    pub completed_at: Option<String>,
}

impl Goal {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Goal {
            id:           row.get(0)?,
            title:        row.get(1)?,
            status:       row.get(2)?,
            tags:         row.get(3)?,
            created_at:   row.get(4)?,
            completed_at: row.get(5)?,
        })
    }
}

// ══════════════════════════════════════════════
// 模型审计：registry / pricing / bindings / call_log
// ══════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelDef {
    pub id: String,
    pub category: String,                 // 'text' | 'omni' | 'realtime'
    pub provider: String,
    pub display_name: Option<String>,
    pub modalities: Option<String>,       // JSON
    pub context_window: Option<i64>,
    pub notes: Option<String>,
    pub deprecated: bool,
    pub updated_at: String,
    pub pricing: Vec<ModelPricingTier>,   // 按 tier_min_tokens 升序
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelPricingTier {
    pub tier_min_tokens: i64,
    pub tier_max_tokens: Option<i64>,
    pub price_input_text: Option<f64>,
    pub price_input_image: Option<f64>,
    pub price_input_video: Option<f64>,
    pub price_input_audio: Option<f64>,
    pub price_output_text: Option<f64>,
    pub price_output_text_thinking: Option<f64>,
    pub price_output_audio: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FeatureBinding {
    pub feature: String,
    pub model_id: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelApiKey {
    pub id: String,
    pub label: String,
    pub api_key: String,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpsertModelApiKeyRequest {
    pub id: Option<String>,
    pub label: String,
    pub api_key: String,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelCallLog {
    pub id: String,
    pub api_key_id: Option<String>,
    pub feature: String,
    pub model_id: String,
    pub started_at: String,
    pub duration_ms: Option<i64>,
    pub prompt_text_tokens: i64,
    pub prompt_image_tokens: i64,
    pub prompt_video_tokens: i64,
    pub prompt_audio_tokens: i64,
    pub completion_text_tokens: i64,
    pub completion_audio_tokens: i64,
    pub cost_cny: Option<f64>,
    pub free_quota_tokens: i64,
    pub free_quota_saved_cny: f64,
    pub success: bool,
    pub error_message: Option<String>,
    pub metadata: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelFreeQuota {
    pub model_id: String,
    pub has_free_quota: bool,
    pub not_supported: bool,
    pub used_tokens: i64,
    pub total_tokens: i64,
    pub remaining_tokens: i64,
    pub used_percent: Option<String>,
    pub expire_date: Option<String>,
    pub raw_quota: Option<String>,
    pub scanned_at: String,
    pub error_message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LogModelCallRequest {
    pub api_key_id: Option<String>,
    pub feature: String,
    pub model_id: String,
    pub started_at: String,
    pub duration_ms: Option<i64>,
    pub prompt_text_tokens: i64,
    pub prompt_image_tokens: i64,
    pub prompt_video_tokens: i64,
    pub prompt_audio_tokens: i64,
    pub completion_text_tokens: i64,
    pub completion_audio_tokens: i64,
    pub success: bool,
    pub error_message: Option<String>,
    pub metadata: Option<String>,
}

/// 时间序列聚合点（用量页折线用）
#[derive(Debug, Serialize, Clone)]
pub struct CallLogBucket {
    pub bucket: String,                   // ISO8601（按粒度截断后的桶起点）
    pub call_count: i64,
    pub prompt_tokens_total: i64,
    pub completion_tokens_total: i64,
    pub cost_cny_total: f64,
}

/// 同步官方模型种子（插入新模型，更新已有官方模型的模态/价格）。
/// 数据来源：用户人工核对的 cn-beijing 百炼价目（2026-04）。
fn seed_model_registry(conn: &rusqlite::Connection) -> Result<(), String> {
    use rusqlite::params;

    type Tier = (i64, Option<i64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>);
    type Seed = (&'static [&'static str], &'static str, &'static str, &'static [&'static str], i64, &'static [Tier]);

    // (ids, category, display_name, modalities, context_window, tiers)
    // ids 第一项为主 id（display_name 取它），其余为同价表别名（每个独立成行）
    // tier 字段顺序：(min, max, in_text, in_image, in_video, in_audio, out_text, out_audio)
    let seeds: Vec<Seed> = vec![
        // ── Qwen3.6 文本 ──
        (&["qwen3.6-max-preview"], "text", "Qwen3.6 Max Preview", &["text"], 262_144, &[
            (0,        Some(131_072), Some(9.0),  None, None, None, Some(54.0), None),
            (131_072,  Some(262_144), Some(15.0), None, None, None, Some(90.0), None),
        ]),
        (&["qwen3.6-plus", "qwen3.6-plus-2026-04-02"], "text", "Qwen3.6 Plus", &["text","image","video"], 1_048_576, &[
            (0,        Some(262_144),   Some(2.0), Some(2.0), Some(2.0), None, Some(12.0), None),
            (262_144,  Some(1_048_576), Some(8.0), Some(8.0), Some(8.0), None, Some(48.0), None),
        ]),
        (&["qwen3.6-flash", "qwen3.6-flash-2026-04-16"], "text", "Qwen3.6 Flash", &["text","image","video"], 1_048_576, &[
            (0,        Some(262_144),   Some(1.2), Some(1.2), Some(1.2), None, Some(7.2),  None),
            (262_144,  Some(1_048_576), Some(4.8), Some(4.8), Some(4.8), None, Some(28.8), None),
        ]),
        (&["qwen3.6-35b-a3b"], "text", "Qwen3.6 35B A3B", &["text","image","video"], 262_144, &[
            (0, Some(262_144), Some(1.8), Some(1.8), Some(1.8), None, Some(10.8), None),
        ]),
        (&["qwen3.6-27b"], "text", "Qwen3.6 27B", &["text"], 262_144, &[
            (0, Some(262_144), Some(3.0), None, None, None, Some(18.0), None),
        ]),

        // ── Qwen3.5 文本 ──
        (&["qwen3.5-plus", "qwen3.5-plus-2026-04-20", "qwen3.5-plus-2026-02-15"], "text", "Qwen3.5 Plus", &["text","image","video"], 1_048_576, &[
            (0,        Some(131_072),   Some(0.8), Some(0.8), Some(0.8), None, Some(4.8),  None),
            (131_072,  Some(262_144),   Some(2.0), Some(2.0), Some(2.0), None, Some(12.0), None),
            (262_144,  Some(1_048_576), Some(4.0), Some(4.0), Some(4.0), None, Some(24.0), None),
        ]),
        (&["qwen3.5-flash", "qwen3.5-flash-2026-02-23"], "text", "Qwen3.5 Flash", &["text","image","video"], 1_048_576, &[
            (0,        Some(131_072),   Some(0.2), Some(0.2), Some(0.2), None, Some(2.0),  None),
            (131_072,  Some(262_144),   Some(0.8), Some(0.8), Some(0.8), None, Some(8.0),  None),
            (262_144,  Some(1_048_576), Some(1.2), Some(1.2), Some(1.2), None, Some(12.0), None),
        ]),
        (&["qwen3.5-397b-a17b"], "text", "Qwen3.5 397B A17B", &["text","image","video"], 262_144, &[
            (0,       Some(131_072), Some(1.2), Some(1.2), Some(1.2), None, Some(7.2),  None),
            (131_072, Some(262_144), Some(3.0), Some(3.0), Some(3.0), None, Some(18.0), None),
        ]),
        (&["qwen3.5-122b-a10b"], "text", "Qwen3.5 122B A10B", &["text","image","video"], 262_144, &[
            (0,       Some(131_072), Some(0.8), Some(0.8), Some(0.8), None, Some(6.4),  None),
            (131_072, Some(262_144), Some(2.0), Some(2.0), Some(2.0), None, Some(16.0), None),
        ]),
        (&["qwen3.5-27b"], "text", "Qwen3.5 27B", &["text","image","video"], 262_144, &[
            (0,       Some(131_072), Some(0.6), Some(0.6), Some(0.6), None, Some(4.8),  None),
            (131_072, Some(262_144), Some(1.8), Some(1.8), Some(1.8), None, Some(14.4), None),
        ]),
        (&["qwen3.5-35b-a3b"], "text", "Qwen3.5 35B A3B", &["text","image","video"], 262_144, &[
            (0,       Some(131_072), Some(0.4), Some(0.4), Some(0.4), None, Some(3.2),  None),
            (131_072, Some(262_144), Some(1.6), Some(1.6), Some(1.6), None, Some(12.8), None),
        ]),

        // ── Qwen3.5 Omni HTTP ──
        (&["qwen3.5-omni-plus", "qwen3.5-omni-plus-2026-03-15"], "omni", "Qwen3.5 Omni Plus", &["text","image","video","audio_in","audio_out"], 0, &[
            (0, None, Some(7.0),  Some(7.0),  Some(7.0),  Some(53.0), Some(40.0),  Some(213.0)),
        ]),
        (&["qwen3.5-omni-flash", "qwen3.5-omni-flash-2026-03-15"], "omni", "Qwen3.5 Omni Flash", &["text","image","video","audio_in","audio_out"], 0, &[
            (0, None, Some(2.2),  Some(2.2),  Some(2.2),  Some(18.0), Some(13.3),  Some(72.0)),
        ]),

        // ── Qwen3.5 Omni Realtime（WS）──
        (&["qwen3.5-omni-plus-realtime", "qwen3.5-omni-plus-realtime-2026-03-15"], "realtime", "Qwen3.5 Omni Plus Realtime", &["text","image","audio_in","audio_out"], 0, &[
            (0, None, Some(10.0), Some(10.0), None, Some(80.0), Some(60.0), Some(300.0)),
        ]),
        (&["qwen3.5-omni-flash-realtime", "qwen3.5-omni-flash-realtime-2026-03-15"], "realtime", "Qwen3.5 Omni Flash Realtime", &["text","image","audio_in","audio_out"], 0, &[
            (0, None, Some(3.3),  Some(3.3),  None, Some(27.0), Some(20.0), Some(107.0)),
        ]),
    ];

    let now = chrono::Utc::now().to_rfc3339();
    let mut written = 0usize;
    for (ids, category, display_name, modalities, ctx, tiers) in &seeds {
        let modalities_json = serde_json::to_string(modalities).unwrap_or_else(|_| "[]".to_string());
        let ctx_opt: Option<i64> = if *ctx > 0 { Some(*ctx) } else { None };

        let main_id = ids[0];
        for id in *ids {
            // 主 id 用基础名；别名 id 在末尾附上日期段（YYYY-MM-DD）
            let row_display_name = if *id == main_id {
                display_name.to_string()
            } else if let Some(rest) = id.strip_prefix(main_id).and_then(|s| s.strip_prefix('-')) {
                format!("{} {}", display_name, rest)
            } else {
                display_name.to_string()
            };

            conn.execute(
                "INSERT INTO model_registry
                 (id, category, provider, display_name, modalities, context_window, notes, deprecated, updated_at)
                 VALUES (?, ?, 'dashscope', ?, ?, ?, NULL, 0, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   category=excluded.category,
                   provider=excluded.provider,
                   display_name=excluded.display_name,
                   modalities=excluded.modalities,
                   context_window=excluded.context_window,
                   updated_at=excluded.updated_at",
                params![id, category, row_display_name, modalities_json, ctx_opt, &now],
            ).map_err(|e| e.to_string())?;

            conn.execute("DELETE FROM model_pricing WHERE model_id = ?", params![id])
                .map_err(|e| e.to_string())?;
            for (min, max, in_text, in_image, in_video, in_audio, out_text, out_audio) in *tiers {
                conn.execute(
                    "INSERT INTO model_pricing
                     (model_id, tier_min_tokens, tier_max_tokens,
                      price_input_text, price_input_image, price_input_video, price_input_audio,
                      price_output_text, price_output_text_thinking, price_output_audio)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![id, min, max, in_text, in_image, in_video, in_audio, out_text, out_text, out_audio],
                ).map_err(|e| e.to_string())?;
            }
            written += 1;
        }
    }

    log::info!("[Database] model_registry 种子写入 {} 个模型", written);
    Ok(())
}

fn seed_feature_bindings(conn: &rusqlite::Connection) -> Result<(), String> {
    use rusqlite::params;

    let now = chrono::Utc::now().to_rfc3339();
    let existing = |feature: &str| -> Option<String> {
        conn.query_row(
            "SELECT model_id FROM feature_bindings WHERE feature = ? LIMIT 1",
            params![feature],
            |r| r.get::<_, String>(0),
        ).ok()
    };
    let bili_omni_default = existing("bili_omni_transcribe")
        .or_else(|| existing("bili_combined_transcribe"))
        .unwrap_or_else(|| "qwen3.5-omni-plus".to_string());
    let bili_visual_default = existing("bili_visual_transcribe")
        .unwrap_or_else(|| "qwen3.5-flash".to_string());
    let bili_audio_default = existing("bili_audio_transcribe")
        .unwrap_or_else(|| "qwen3.5-omni-flash".to_string());

    let seeds: Vec<(&str, String)> = vec![
        ("fairy_chat", "qwen3.6-flash".to_string()),
        ("fairy_omni_chat", "qwen3.5-omni-flash-realtime".to_string()),
        ("session_title", "qwen3.5-flash".to_string()),
        ("bili_omni_transcribe", bili_omni_default),
        ("bili_visual_transcribe", bili_visual_default),
        ("bili_audio_transcribe", bili_audio_default),
    ];

    for (feature, model_id) in &seeds {
        conn.execute(
            "INSERT OR IGNORE INTO feature_bindings (feature, model_id, updated_at) VALUES (?, ?, ?)",
            params![feature, model_id, &now],
        ).map_err(|e| e.to_string())?;
    }

    log::info!("[Database] feature_bindings 种子写入 {} 条", seeds.len());
    Ok(())
}

impl Database {
    // ── model_registry ──

    pub async fn list_models(&self) -> Result<Vec<ModelDef>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, category, provider, display_name, modalities,
                    context_window, notes, deprecated, updated_at
             FROM model_registry
             ORDER BY category DESC, id DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |r| {
            Ok(ModelDef {
                id:             r.get(0)?,
                category:       r.get(1)?,
                provider:       r.get(2)?,
                display_name:   r.get(3)?,
                modalities:     r.get(4)?,
                context_window: r.get(5)?,
                notes:          r.get(6)?,
                deprecated:     r.get::<_, i64>(7)? != 0,
                updated_at:     r.get(8)?,
                pricing:        Vec::new(),
            })
        }).map_err(|e| e.to_string())?;

        let mut defs: Vec<ModelDef> = rows.filter_map(|r| r.ok()).collect();

        // 第二次查询拉所有 pricing，按 model_id 分组写回
        let mut pstmt = conn.prepare(
            "SELECT model_id, tier_min_tokens, tier_max_tokens,
                    price_input_text, price_input_image, price_input_video, price_input_audio,
                    price_output_text, price_output_text_thinking, price_output_audio
             FROM model_pricing
             ORDER BY model_id, tier_min_tokens"
        ).map_err(|e| e.to_string())?;

        let prices = pstmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, ModelPricingTier {
                tier_min_tokens: r.get(1)?,
                tier_max_tokens: r.get(2)?,
                price_input_text: r.get(3)?,
                price_input_image: r.get(4)?,
                price_input_video: r.get(5)?,
                price_input_audio: r.get(6)?,
                price_output_text: r.get(7)?,
                price_output_text_thinking: r.get(8)?,
                price_output_audio: r.get(9)?,
            }))
        }).map_err(|e| e.to_string())?;

        for row in prices.flatten() {
            if let Some(def) = defs.iter_mut().find(|d| d.id == row.0) {
                def.pricing.push(row.1);
            }
        }

        Ok(defs)
    }

    pub async fn upsert_model(&self, def: ModelDef) -> Result<(), String> {
        use rusqlite::params;
        let mut conn = self.conn.lock().await;
        let now = chrono::Utc::now().to_rfc3339();
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT INTO model_registry
             (id, category, provider, display_name, modalities, context_window, notes, deprecated, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               category=excluded.category, provider=excluded.provider, display_name=excluded.display_name,
               modalities=excluded.modalities, context_window=excluded.context_window,
               notes=excluded.notes, deprecated=excluded.deprecated, updated_at=excluded.updated_at",
            params![
                &def.id, &def.category, &def.provider, &def.display_name,
                &def.modalities, &def.context_window, &def.notes,
                if def.deprecated { 1 } else { 0 }, &now,
            ],
        ).map_err(|e| e.to_string())?;

        // 价格分档全替换：先删后插
        tx.execute("DELETE FROM model_pricing WHERE model_id = ?", params![&def.id])
            .map_err(|e| e.to_string())?;
        for t in &def.pricing {
            tx.execute(
                "INSERT INTO model_pricing
                 (model_id, tier_min_tokens, tier_max_tokens,
                  price_input_text, price_input_image, price_input_video, price_input_audio,
                  price_output_text, price_output_text_thinking, price_output_audio)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    &def.id, t.tier_min_tokens, t.tier_max_tokens,
                    t.price_input_text, t.price_input_image, t.price_input_video, t.price_input_audio,
                    t.price_output_text, t.price_output_text_thinking, t.price_output_audio,
                ],
            ).map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn delete_model(&self, model_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM model_registry WHERE id = ?", rusqlite::params![model_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── feature_bindings ──

    pub async fn list_feature_bindings(&self) -> Result<Vec<FeatureBinding>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT feature, model_id, updated_at FROM feature_bindings ORDER BY feature"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(FeatureBinding {
            feature: r.get(0)?, model_id: r.get(1)?, updated_at: r.get(2)?,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub async fn set_feature_binding(&self, feature: &str, model_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO feature_bindings (feature, model_id, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(feature) DO UPDATE SET model_id=excluded.model_id, updated_at=excluded.updated_at",
            rusqlite::params![feature, model_id, &now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn get_feature_model(&self, feature: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let result: Result<String, _> = conn.query_row(
            "SELECT model_id FROM feature_bindings WHERE feature = ?",
            rusqlite::params![feature],
            |r| r.get(0),
        );
        Ok(result.ok())
    }

    // ── model_api_keys ──

    pub async fn list_model_api_keys(&self) -> Result<Vec<ModelApiKey>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, label, api_key, is_active, created_at, updated_at
             FROM model_api_keys
             ORDER BY is_active DESC, updated_at DESC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(ModelApiKey {
            id: r.get(0)?,
            label: r.get(1)?,
            api_key: r.get(2)?,
            is_active: r.get::<_, i64>(3)? != 0,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub async fn get_active_model_api_key(&self) -> Result<Option<ModelApiKey>, String> {
        let conn = self.conn.lock().await;
        let result = conn.query_row(
            "SELECT id, label, api_key, is_active, created_at, updated_at
             FROM model_api_keys
             WHERE is_active = 1
             ORDER BY updated_at DESC
             LIMIT 1",
            [],
            |r| Ok(ModelApiKey {
                id: r.get(0)?,
                label: r.get(1)?,
                api_key: r.get(2)?,
                is_active: r.get::<_, i64>(3)? != 0,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        );
        Ok(result.ok())
    }

    pub async fn upsert_model_api_key(&self, req: UpsertModelApiKeyRequest) -> Result<ModelApiKey, String> {
        use rusqlite::params;

        let mut conn = self.conn.lock().await;
        let id = req.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let label = if req.label.trim().is_empty() {
            "百炼 API Key".to_string()
        } else {
            req.label.trim().to_string()
        };
        let api_key = req.api_key.trim().to_string();
        if api_key.is_empty() {
            return Err("API Key 不能为空".to_string());
        }

        let now = Utc::now().to_rfc3339();
        let should_activate = req.is_active || {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM model_api_keys WHERE is_active = 1", [], |r| r.get(0))
                .unwrap_or(0);
            count == 0
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if should_activate {
            tx.execute("UPDATE model_api_keys SET is_active = 0", [])
                .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO model_api_keys (id, label, api_key, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               label=excluded.label,
               api_key=excluded.api_key,
               is_active=excluded.is_active,
               updated_at=excluded.updated_at",
            params![&id, &label, &api_key, if should_activate { 1 } else { 0 }, &now, &now],
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        Ok(ModelApiKey {
            id,
            label,
            api_key,
            is_active: should_activate,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub async fn set_active_model_api_key(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM model_api_keys WHERE id = ?",
            rusqlite::params![id],
            |r| r.get(0),
        ).unwrap_or(0);
        if exists == 0 {
            return Err("API Key 不存在".to_string());
        }
        conn.execute(
            "UPDATE model_api_keys SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END,
                    updated_at = CASE WHEN id = ? THEN ? ELSE updated_at END",
            rusqlite::params![id, id, Utc::now().to_rfc3339()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn delete_model_api_key(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let was_active: bool = conn.query_row(
            "SELECT is_active FROM model_api_keys WHERE id = ?",
            rusqlite::params![id],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        ).unwrap_or(false);

        conn.execute("DELETE FROM model_call_log WHERE api_key_id = ?", rusqlite::params![id])
            .map_err(|e| e.to_string())?;

        conn.execute("DELETE FROM model_api_keys WHERE id = ?", rusqlite::params![id])
            .map_err(|e| e.to_string())?;

        if was_active {
            let next_id: Option<String> = conn.query_row(
                "SELECT id FROM model_api_keys ORDER BY updated_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            ).ok();
            if let Some(next_id) = next_id {
                conn.execute(
                    "UPDATE model_api_keys SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END",
                    rusqlite::params![next_id],
                ).map_err(|e| e.to_string())?;
            }
        }

        Ok(())
    }

    pub async fn list_model_free_quotas(&self) -> Result<Vec<ModelFreeQuota>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT model_id, has_free_quota, not_supported, used_tokens, total_tokens,
                    remaining_tokens, used_percent, expire_date, raw_quota, scanned_at, error_message
             FROM model_free_quota
             ORDER BY remaining_tokens DESC, model_id"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(ModelFreeQuota {
            model_id: r.get(0)?,
            has_free_quota: r.get::<_, i64>(1)? != 0,
            not_supported: r.get::<_, i64>(2)? != 0,
            used_tokens: r.get(3)?,
            total_tokens: r.get(4)?,
            remaining_tokens: r.get(5)?,
            used_percent: r.get(6)?,
            expire_date: r.get(7)?,
            raw_quota: r.get(8)?,
            scanned_at: r.get(9)?,
            error_message: r.get(10)?,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub async fn upsert_model_free_quotas(&self, rows: &[ModelFreeQuota]) -> Result<(), String> {
        use rusqlite::params;

        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for q in rows {
            tx.execute(
                "INSERT INTO model_free_quota
                 (model_id, has_free_quota, not_supported, used_tokens, total_tokens,
                  remaining_tokens, used_percent, expire_date, raw_quota, scanned_at, error_message)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(model_id) DO UPDATE SET
                   has_free_quota=excluded.has_free_quota,
                   not_supported=excluded.not_supported,
                   used_tokens=excluded.used_tokens,
                   total_tokens=excluded.total_tokens,
                   remaining_tokens=excluded.remaining_tokens,
                   used_percent=excluded.used_percent,
                   expire_date=excluded.expire_date,
                   raw_quota=excluded.raw_quota,
                   scanned_at=excluded.scanned_at,
                   error_message=excluded.error_message",
                params![
                    &q.model_id,
                    if q.has_free_quota { 1 } else { 0 },
                    if q.not_supported { 1 } else { 0 },
                    q.used_tokens,
                    q.total_tokens,
                    q.remaining_tokens,
                    &q.used_percent,
                    &q.expire_date,
                    &q.raw_quota,
                    &q.scanned_at,
                    &q.error_message,
                ],
            ).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── model_call_log ──

    /// 按当前价目折算成本（0 token 各模态返回 0）。
    /// 区间命中：用 prompt token 总和（含所有模态）匹配 tier_min/tier_max。
    /// 输出：completion_audio_tokens > 0 → 整段输出按 audio 价（文本不计费）；否则按 text 价。
    fn compute_cost(req: &LogModelCallRequest, tiers: &[ModelPricingTier]) -> Option<f64> {
        let prompt_total = req.prompt_text_tokens + req.prompt_image_tokens
            + req.prompt_video_tokens + req.prompt_audio_tokens;
        let tier = tiers.iter().find(|t| {
            prompt_total >= t.tier_min_tokens
                && t.tier_max_tokens.map_or(true, |m| prompt_total < m)
        })?;

        let price = |tok: i64, p: Option<f64>| -> f64 {
            if tok <= 0 { 0.0 } else { (tok as f64) * p.unwrap_or(0.0) / 1_000_000.0 }
        };

        let mut total = 0.0;
        total += price(req.prompt_text_tokens,  tier.price_input_text);
        total += price(req.prompt_image_tokens, tier.price_input_image.or(tier.price_input_text));
        total += price(req.prompt_video_tokens, tier.price_input_video.or(tier.price_input_text));
        total += price(req.prompt_audio_tokens, tier.price_input_audio);

        if req.completion_audio_tokens > 0 {
            // 按"文本+音频"输出口径：仅按音频计费
            total += price(req.completion_audio_tokens, tier.price_output_audio);
        } else {
            total += price(req.completion_text_tokens, tier.price_output_text);
        }
        Some(total)
    }

    fn billable_token_count(req: &LogModelCallRequest, tiers: &[ModelPricingTier]) -> i64 {
        let prompt_total = req.prompt_text_tokens + req.prompt_image_tokens
            + req.prompt_video_tokens + req.prompt_audio_tokens;
        let tier = match tiers.iter().find(|t| {
            prompt_total >= t.tier_min_tokens
                && t.tier_max_tokens.map_or(true, |m| prompt_total < m)
        }) {
            Some(tier) => tier,
            None => return 0,
        };

        let count = |tok: i64, p: Option<f64>| -> i64 {
            if tok > 0 && p.unwrap_or(0.0) > 0.0 { tok } else { 0 }
        };

        let mut total = 0;
        total += count(req.prompt_text_tokens, tier.price_input_text);
        total += count(req.prompt_image_tokens, tier.price_input_image.or(tier.price_input_text));
        total += count(req.prompt_video_tokens, tier.price_input_video.or(tier.price_input_text));
        total += count(req.prompt_audio_tokens, tier.price_input_audio);

        if req.completion_audio_tokens > 0 {
            total += count(req.completion_audio_tokens, tier.price_output_audio);
        } else {
            total += count(req.completion_text_tokens, tier.price_output_text);
        }
        total
    }

    pub async fn log_model_call(&self, req: LogModelCallRequest) -> Result<String, String> {
        use rusqlite::params;

        // 取该 model 的当前定价表（独立 query，scope 内 release）
        let tiers: Vec<ModelPricingTier> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT tier_min_tokens, tier_max_tokens,
                        price_input_text, price_input_image, price_input_video, price_input_audio,
                        price_output_text, price_output_text_thinking, price_output_audio
                 FROM model_pricing
                 WHERE model_id = ?
                 ORDER BY tier_min_tokens"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![&req.model_id], |r| Ok(ModelPricingTier {
                tier_min_tokens: r.get(0)?,
                tier_max_tokens: r.get(1)?,
                price_input_text: r.get(2)?,
                price_input_image: r.get(3)?,
                price_input_video: r.get(4)?,
                price_input_audio: r.get(5)?,
                price_output_text: r.get(6)?,
                price_output_text_thinking: r.get(7)?,
                price_output_audio: r.get(8)?,
            })).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let gross_cost = Self::compute_cost(&req, &tiers);
        let billable_tokens = if req.success {
            Self::billable_token_count(&req, &tiers)
        } else {
            0
        };
        let id = Uuid::new_v4().to_string();

        let conn = self.conn.lock().await;
        let free_quota_tokens = if billable_tokens > 0 {
            conn.query_row(
                "SELECT remaining_tokens
                 FROM model_free_quota
                 WHERE model_id = ?
                   AND has_free_quota = 1
                   AND not_supported = 0
                   AND total_tokens > 0
                   AND error_message IS NULL",
                params![&req.model_id],
                |r| r.get::<_, i64>(0),
            ).unwrap_or(0).clamp(0, billable_tokens)
        } else {
            0
        };
        let free_quota_saved_cny = match (gross_cost, billable_tokens) {
            (Some(cost), tokens) if tokens > 0 && free_quota_tokens > 0 => {
                cost * (free_quota_tokens as f64) / (tokens as f64)
            }
            _ => 0.0,
        };
        let cost = gross_cost.map(|cost| (cost - free_quota_saved_cny).max(0.0));

        conn.execute(
            "INSERT INTO model_call_log
             (id, api_key_id, feature, model_id, started_at, duration_ms,
              prompt_text_tokens, prompt_image_tokens, prompt_video_tokens, prompt_audio_tokens,
              completion_text_tokens, completion_audio_tokens,
              cost_cny, free_quota_tokens, free_quota_saved_cny, success, error_message, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                &id, &req.api_key_id, &req.feature, &req.model_id, &req.started_at, &req.duration_ms,
                &req.prompt_text_tokens, &req.prompt_image_tokens, &req.prompt_video_tokens, &req.prompt_audio_tokens,
                &req.completion_text_tokens, &req.completion_audio_tokens,
                &cost, &free_quota_tokens, &free_quota_saved_cny, if req.success { 1 } else { 0 }, &req.error_message, &req.metadata,
            ],
        ).map_err(|e| e.to_string())?;
        if free_quota_tokens > 0 {
            conn.execute(
                "UPDATE model_free_quota
                 SET used_tokens = MIN(total_tokens, used_tokens + ?),
                     remaining_tokens = MAX(0, total_tokens - MIN(total_tokens, used_tokens + ?))
                 WHERE model_id = ?
                   AND has_free_quota = 1
                   AND not_supported = 0
                   AND total_tokens > 0
                   AND error_message IS NULL",
                params![free_quota_tokens, free_quota_tokens, &req.model_id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(id)
    }

    /// 查询调用列表（按时间倒序）。time_from / time_to 为 ISO8601；feature/model_id 可选过滤。
    pub async fn get_model_call_log(&self, id: &str) -> Result<Option<ModelCallLog>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, api_key_id, feature, model_id, started_at, duration_ms,
                    prompt_text_tokens, prompt_image_tokens, prompt_video_tokens, prompt_audio_tokens,
                    completion_text_tokens, completion_audio_tokens,
                    cost_cny, free_quota_tokens, free_quota_saved_cny, success, error_message, metadata
             FROM model_call_log WHERE id = ? LIMIT 1"
        ).map_err(|e| e.to_string())?;
        match stmt.query_row(rusqlite::params![id], |r| Ok(ModelCallLog {
            id: r.get(0)?,
            api_key_id: r.get(1)?,
            feature: r.get(2)?,
            model_id: r.get(3)?,
            started_at: r.get(4)?,
            duration_ms: r.get(5)?,
            prompt_text_tokens: r.get(6)?,
            prompt_image_tokens: r.get(7)?,
            prompt_video_tokens: r.get(8)?,
            prompt_audio_tokens: r.get(9)?,
            completion_text_tokens: r.get(10)?,
            completion_audio_tokens: r.get(11)?,
            cost_cny: r.get(12)?,
            free_quota_tokens: r.get(13)?,
            free_quota_saved_cny: r.get(14)?,
            success: r.get::<_, i64>(15)? != 0,
            error_message: r.get(16)?,
            metadata: r.get(17)?,
        })) {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub async fn query_call_log(
        &self,
        time_from: Option<String>,
        time_to: Option<String>,
        feature: Option<String>,
        model_id: Option<String>,
        api_key_id: Option<String>,
        limit: Option<i64>,
    ) -> Result<Vec<ModelCallLog>, String> {
        let conn = self.conn.lock().await;
        let mut sql = String::from(
            "SELECT id, api_key_id, feature, model_id, started_at, duration_ms,
                    prompt_text_tokens, prompt_image_tokens, prompt_video_tokens, prompt_audio_tokens,
                    completion_text_tokens, completion_audio_tokens,
                    cost_cny, free_quota_tokens, free_quota_saved_cny, success, error_message, metadata
             FROM model_call_log WHERE 1=1"
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(t) = time_from { sql.push_str(" AND started_at >= ?"); args.push(Box::new(t)); }
        if let Some(t) = time_to   { sql.push_str(" AND started_at <  ?"); args.push(Box::new(t)); }
        if let Some(f) = feature   { sql.push_str(" AND feature = ?");     args.push(Box::new(f)); }
        if let Some(m) = model_id  { sql.push_str(" AND model_id = ?");    args.push(Box::new(m)); }
        if let Some(k) = api_key_id { sql.push_str(" AND api_key_id = ?");  args.push(Box::new(k)); }
        sql.push_str(" ORDER BY started_at DESC");
        if let Some(l) = limit     { sql.push_str(&format!(" LIMIT {}", l.max(1))); }

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(arg_refs.as_slice(), |r| Ok(ModelCallLog {
            id: r.get(0)?, api_key_id: r.get(1)?, feature: r.get(2)?, model_id: r.get(3)?,
            started_at: r.get(4)?, duration_ms: r.get(5)?,
            prompt_text_tokens: r.get(6)?, prompt_image_tokens: r.get(7)?,
            prompt_video_tokens: r.get(8)?, prompt_audio_tokens: r.get(9)?,
            completion_text_tokens: r.get(10)?, completion_audio_tokens: r.get(11)?,
            cost_cny: r.get(12)?,
            free_quota_tokens: r.get(13)?,
            free_quota_saved_cny: r.get(14)?,
            success: r.get::<_, i64>(15)? != 0,
            error_message: r.get(16)?, metadata: r.get(17)?,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 时间序列聚合（按桶切分），用于折线图。
    /// granularity: "minute" / "hour" / "day"
    pub async fn aggregate_call_log(
        &self,
        time_from: String,
        time_to: String,
        granularity: String,
        feature: Option<String>,
        model_id: Option<String>,
        api_key_id: Option<String>,
    ) -> Result<Vec<CallLogBucket>, String> {
        let bucket_expr = match granularity.as_str() {
            "minute" => "substr(started_at, 1, 16) || ':00'",
            "hour"   => "substr(started_at, 1, 13) || ':00:00'",
            _        => "substr(started_at, 1, 10)",
        };

        let conn = self.conn.lock().await;
        let mut sql = format!(
            "SELECT {bucket} AS bucket,
                    COUNT(*) AS call_count,
                    COALESCE(SUM(prompt_text_tokens + prompt_image_tokens + prompt_video_tokens + prompt_audio_tokens), 0) AS p_total,
                    COALESCE(SUM(completion_text_tokens + completion_audio_tokens), 0) AS c_total,
                    COALESCE(SUM(cost_cny), 0) AS cost_total
             FROM model_call_log
             WHERE started_at >= ? AND started_at < ?",
            bucket = bucket_expr,
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(time_from), Box::new(time_to),
        ];
        if let Some(f) = feature  { sql.push_str(" AND feature = ?");  args.push(Box::new(f)); }
        if let Some(m) = model_id { sql.push_str(" AND model_id = ?"); args.push(Box::new(m)); }
        if let Some(k) = api_key_id { sql.push_str(" AND api_key_id = ?"); args.push(Box::new(k)); }
        sql.push_str(" GROUP BY bucket ORDER BY bucket ASC");

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(arg_refs.as_slice(), |r| Ok(CallLogBucket {
            bucket: r.get(0)?,
            call_count: r.get(1)?,
            prompt_tokens_total: r.get(2)?,
            completion_tokens_total: r.get(3)?,
            cost_cny_total: r.get(4)?,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}
