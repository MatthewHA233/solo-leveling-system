// ══════════════════════════════════════════════
// Local Database — SQLite 存储
// 支持自定义存储路径 + 数据迁移
// ══════════════════════════════════════════════

use rusqlite::{Connection, OptionalExtension, params};
use std::sync::Arc;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;
use chrono::{Duration, NaiveDateTime, Utc};

#[cfg(windows)]
const PERCEPTION_BUCKETS_TABLE: &str = "perception_buckets_windows";
#[cfg(windows)]
const PERCEPTION_EVENTS_TABLE: &str = "perception_events_windows";
#[cfg(windows)]
const APP_CATALOG_TABLE: &str = "app_catalog_windows";
#[cfg(windows)]
const PERCEPTION_PLATFORM: &str = "win";

#[cfg(target_os = "macos")]
const PERCEPTION_BUCKETS_TABLE: &str = "perception_buckets_macos";
#[cfg(target_os = "macos")]
const PERCEPTION_EVENTS_TABLE: &str = "perception_events_macos";
#[cfg(target_os = "macos")]
const APP_CATALOG_TABLE: &str = "app_catalog_macos";
#[cfg(target_os = "macos")]
const PERCEPTION_PLATFORM: &str = "mac";

#[cfg(all(not(windows), not(target_os = "macos")))]
const PERCEPTION_BUCKETS_TABLE: &str = "perception_buckets";
#[cfg(all(not(windows), not(target_os = "macos")))]
const PERCEPTION_EVENTS_TABLE: &str = "perception_events";
#[cfg(all(not(windows), not(target_os = "macos")))]
const APP_CATALOG_TABLE: &str = "app_catalog";
#[cfg(all(not(windows), not(target_os = "macos")))]
const PERCEPTION_PLATFORM: &str = "desktop";

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
pub struct PlanNode {
    pub id: i64,
    pub project_tag_id: i64,
    pub parent_id: Option<i64>,
    pub title: String,
    pub status: String,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlannedBlock {
    pub date: String,
    pub minute: i32,
    pub plan_node_id: i64,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncActivityCategory {
    pub sync_id: String,
    pub name: String,
    pub color: String,
    pub sort_order: i32,
    pub created_at: String,
    pub last_used_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncActivityTag {
    pub sync_id: String,
    pub category_sync_id: String,
    pub full_path: String,
    pub leaf_name: String,
    pub depth: i32,
    pub created_at: String,
    pub last_used_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncActivityBlock {
    pub sync_id: String,
    pub date: String,
    pub minute: i32,
    pub tag_sync_id: String,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncPlanNode {
    pub sync_id: String,
    pub project_tag_sync_id: String,
    pub parent_sync_id: Option<String>,
    pub title: String,
    pub status: String,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncPlannedBlock {
    pub sync_id: String,
    pub date: String,
    pub minute: i32,
    pub plan_node_sync_id: String,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncExport {
    pub device_id: String,
    pub exported_at: String,
    pub cursor: String,
    pub activity_categories: Vec<SyncActivityCategory>,
    pub activity_tags: Vec<SyncActivityTag>,
    pub activity_blocks: Vec<SyncActivityBlock>,
    pub plan_nodes: Vec<SyncPlanNode>,
    pub planned_blocks: Vec<SyncPlannedBlock>,
    #[serde(default)]
    pub model_api_keys: Vec<SyncModelApiKey>,
    #[serde(default)]
    pub model_call_log: Vec<SyncModelCallLog>,
    #[serde(default)]
    pub model_free_quota: Vec<SyncModelFreeQuota>,
    #[serde(default)]
    pub feature_bindings: Vec<SyncFeatureBinding>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncModelApiKey {
    pub id: String,
    pub label: String,
    /// AUDIT-036：tombstone 行（deleted_at IS NOT NULL）的 api_key 在 export
    /// 时会被强制清成空串，不把明文 key 复制到其他设备
    pub api_key: String,
    pub is_active: i32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncModelCallLog {
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
    pub success: i32,
    pub error_message: Option<String>,
    pub metadata: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncModelFreeQuota {
    pub model_id: String,
    pub has_free_quota: i32,
    pub not_supported: i32,
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
pub struct SyncFeatureBinding {
    pub feature: String,
    pub model_id: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LinkedDevice {
    pub device_id: String,
    pub alias: String,
    pub last_base: String,
    pub last_synced_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncImportResult {
    pub activity_categories: usize,
    pub activity_tags: usize,
    pub activity_blocks: usize,
    pub plan_nodes: usize,
    pub planned_blocks: usize,
    #[serde(default)]
    pub model_api_keys: usize,
    #[serde(default)]
    pub model_call_log: usize,
    #[serde(default)]
    pub model_free_quota: usize,
    #[serde(default)]
    pub feature_bindings: usize,
    pub skipped: usize,
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
    /// 要改的 tag id
    pub tag_id: i64,
    /// 新的完整路径，含首段分类名（如 "学习,英语,新概念3"）。
    /// 首段必须等于某个已有分类的 name；不级联到其它共享前缀的 tag。
    pub new_full_path: String,
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

#[derive(Debug, Deserialize)]
pub struct AddPlanNodeRequest {
    pub project_tag_id: i64,
    pub parent_id: Option<i64>,
    pub title: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePlanNodeRequest {
    pub id: i64,
    pub title: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PaintPlannedBlocksRequest {
    pub date: String,
    pub minutes: Vec<i32>,
    pub plan_node_id: i64,
}

#[cfg_attr(not(windows), allow(dead_code))]
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

#[derive(Debug, Serialize, Clone)]
pub struct PerceptionSpan {
    pub id: i64,
    pub track: String,
    pub start_at: String,
    pub end_at: String,
    pub title: String,
    pub group_name: Option<String>,
    pub color: Option<String>,
    pub platform: Option<String>,
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
    pub reasoning: Option<String>,    // 思考模型的推演过程（assistant 专用，回看用）
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
    pub reasoning: Option<String>,
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
    pub favorite: bool, // bili_video_assets 中存在 is_favorite=1（转录后自动收藏）
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
    /// 是否收藏（转录完成自动置 true；删除资产时随行消失）
    pub is_favorite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BiliTranscriptCache {
    pub visual: Option<String>,
    pub audio: Option<String>,
    pub combined: Option<String>,
    pub visual_at: Option<String>,
    pub audio_at: Option<String>,
    pub combined_at: Option<String>,
    pub history: Vec<BiliTranscriptRun>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BiliTranscriptRun {
    pub id: String,
    pub asset_id: String,
    pub bvid: String,
    pub download_path: String,
    pub kind: String,
    pub text: String,
    pub model_id: Option<String>,
    pub prompt_type: Option<String>,
    pub source: String,
    pub created_at: String,
}

// ── 数据库管理 ──

pub struct Database {
    conn: Arc<Mutex<Connection>>,
    db_path: PathBuf,
}

impl Database {
    /// 默认数据目录（新品牌 Solevup）
    pub fn default_data_dir() -> PathBuf {
        dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("solevup")
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

            -- Plan nodes: project-tag anchored task tree
            CREATE TABLE IF NOT EXISTS plan_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_tag_id INTEGER NOT NULL REFERENCES activity_tags(id) ON DELETE CASCADE,
                parent_id INTEGER REFERENCES plan_nodes(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE INDEX IF NOT EXISTS idx_plan_nodes_project ON plan_nodes(project_tag_id);
            CREATE INDEX IF NOT EXISTS idx_plan_nodes_parent ON plan_nodes(parent_id);

            -- Planned timeline blocks: same 5min sparse model, references concrete plan nodes
            CREATE TABLE IF NOT EXISTS planned_blocks (
                date TEXT NOT NULL,
                minute INTEGER NOT NULL,
                plan_node_id INTEGER NOT NULL REFERENCES plan_nodes(id) ON DELETE CASCADE,
                note TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                PRIMARY KEY (date, minute)
            );

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
        let planned_columns = {
            let mut stmt = conn.prepare("PRAGMA table_info(planned_blocks)")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect::<Vec<_>>()
        };
        if planned_columns.iter().any(|c| c == "tag_id")
            && !planned_columns.iter().any(|c| c == "plan_node_id") {
            conn.execute_batch(r#"
                PRAGMA foreign_keys = OFF;

                INSERT INTO plan_nodes (project_tag_id, parent_id, title, status, sort_order, created_at, updated_at)
                SELECT old.tag_id, NULL, COALESCE(t.leaf_name, '计划'), 'active', 0,
                       datetime('now','localtime'), datetime('now','localtime')
                FROM (SELECT DISTINCT tag_id FROM planned_blocks) old
                JOIN activity_tags t ON t.id = old.tag_id;

                CREATE TEMP TABLE planned_block_node_map AS
                SELECT project_tag_id AS tag_id, MAX(id) AS plan_node_id
                FROM plan_nodes
                GROUP BY project_tag_id;

                CREATE TABLE planned_blocks_new (
                    date TEXT NOT NULL,
                    minute INTEGER NOT NULL,
                    plan_node_id INTEGER NOT NULL REFERENCES plan_nodes(id) ON DELETE CASCADE,
                    note TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                    PRIMARY KEY (date, minute)
                );

                INSERT OR REPLACE INTO planned_blocks_new (date, minute, plan_node_id, note, created_at)
                SELECT b.date, b.minute, m.plan_node_id, b.note, b.created_at
                FROM planned_blocks b
                JOIN planned_block_node_map m ON m.tag_id = b.tag_id;

                DROP TABLE planned_blocks;
                ALTER TABLE planned_blocks_new RENAME TO planned_blocks;
                CREATE INDEX IF NOT EXISTS idx_planned_blocks_node ON planned_blocks(plan_node_id);
                DROP TABLE planned_block_node_map;

                PRAGMA foreign_keys = ON;
            "#).map_err(|e| format!("迁移 planned_blocks 到 plan_node_id 失败: {}", e))?;
        }

        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_planned_blocks_node ON planned_blocks(plan_node_id);")
            .map_err(|e| format!("创建 planned_blocks 索引失败: {}", e))?;

        // 已链接设备：用户认下的"长期同步"对端，启动时自动双向同步
        conn.execute_batch(r#"
            CREATE TABLE IF NOT EXISTS linked_devices (
                device_id TEXT PRIMARY KEY,
                alias TEXT NOT NULL,
                last_base TEXT NOT NULL,
                last_synced_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
        "#).map_err(|e| format!("创建 linked_devices 失败: {}", e))?;

        ensure_sync_metadata(&conn)?;

        let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN audio_path TEXT");
        let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN duration_ms INTEGER");
        let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN usage_json TEXT");
        let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN reasoning TEXT");
        let _ = conn.execute_batch("ALTER TABLE context_anchor_bindings ADD COLUMN source_card_id TEXT");
        let _ = conn.execute_batch("ALTER TABLE context_cards ADD COLUMN source_card_id TEXT");

        // 渐进式迁移：bili_video_assets 转录字段（旧数据库无此列时自动追加）
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN visual_transcript TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN audio_transcript TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN visual_transcribed_at TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN audio_transcribed_at TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN combined_transcript TEXT");
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN combined_transcribed_at TEXT");
        // 收藏属性：转录完成自动置 1；删除资产行时随行消失（DELETE 整行）
        let _ = conn.execute_batch("ALTER TABLE bili_video_assets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0");
        // 收藏真相统一在历史表（所有看过的视频都可收藏，不限是否下载）
        let _ = conn.execute_batch("ALTER TABLE bili_history ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0");

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
                event_id TEXT,  -- 旧版字段，保留兼容；新模型用 activity_blocks 关联
                is_favorite INTEGER NOT NULL DEFAULT 0
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

            -- 语境卡：用户主动产生的语境（v1 仅想法卡，kind 预留微信/知乎等来源）
            -- source_card_id：想法卡的来源语境卡 id（如 B 站卡 bvid）——
            -- 前端「语境·xxx」标签点击跳转靠它，不依赖语境卡上高亮绑定是否建成
            CREATE TABLE IF NOT EXISTS context_cards (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT 'thought',
                text TEXT NOT NULL DEFAULT '',
                source_label TEXT,
                source_card_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_context_cards_created ON context_cards(created_at DESC);

            -- 锚点关键词：跨卡共享实体（同名同类复用一个），归三类 motive/view/practice
            CREATE TABLE IF NOT EXISTS anchors (
                id TEXT PRIMARY KEY,
                keyword TEXT NOT NULL,
                category TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(keyword, category)
            );

            -- 语境绑定（桥梁）：卡内某文段位置 + 你贴上去的原话（不 AI 总结、不共享）
            -- source_card_id：同源想法卡 id——语境卡上的绑定若由某张想法卡派生，
            -- 删那张想法卡时这条绑定要一起级联（否则锚点被它引用着永远成不了孤儿）
            CREATE TABLE IF NOT EXISTS context_anchor_bindings (
                id TEXT PRIMARY KEY,
                card_id TEXT NOT NULL,
                start_pos INTEGER NOT NULL,
                end_pos INTEGER NOT NULL,
                selected_text TEXT NOT NULL,
                user_speech TEXT NOT NULL,
                source_card_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_bindings_card ON context_anchor_bindings(card_id);

            -- binding ↔ anchor 多对多：一段原话提多个关键词；一个关键词跨多卡
            CREATE TABLE IF NOT EXISTS binding_anchors (
                binding_id TEXT NOT NULL,
                anchor_id TEXT NOT NULL,
                PRIMARY KEY (binding_id, anchor_id)
            );

            -- 锚点句的语义向量（锚点域地图用：球的位置由 embedding 决定）
            -- vector 存 JSON 数组文本（锚点量级小，无需二进制压缩）
            CREATE TABLE IF NOT EXISTS anchor_embeddings (
                anchor_id TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                dims INTEGER NOT NULL,
                vector TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- 聚簇主题名缓存（key = 簇内锚点 id 排序拼接的 hash；成员不变不重复起名）
            CREATE TABLE IF NOT EXISTS anchor_cluster_names (
                member_hash TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS presence_spans (
                id TEXT PRIMARY KEY,
                start_time TEXT NOT NULL,
                end_time TEXT,
                state TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_presence_start ON presence_spans(start_time);

            -- 自研感知层旧表：只保留给历史 Windows 数据迁移，不再写入
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

            -- 自研感知层平台表：macOS / Windows 分开，避免 app/status/tag 等事件串库
            CREATE TABLE IF NOT EXISTS perception_buckets_windows (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                event_type TEXT NOT NULL,
                source TEXT NOT NULL,
                hostname TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS perception_events_windows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bucket_id TEXT NOT NULL REFERENCES perception_buckets_windows(id) ON DELETE CASCADE,
                start_at TEXT NOT NULL,
                end_at TEXT NOT NULL,
                data_json TEXT NOT NULL,
                data_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_perception_windows_bucket_time
                ON perception_events_windows(bucket_id, start_at, end_at);
            CREATE INDEX IF NOT EXISTS idx_perception_windows_time
                ON perception_events_windows(start_at, end_at);
            CREATE INDEX IF NOT EXISTS idx_perception_windows_hash
                ON perception_events_windows(bucket_id, data_hash, end_at);

            CREATE TABLE IF NOT EXISTS perception_buckets_macos (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                event_type TEXT NOT NULL,
                source TEXT NOT NULL,
                hostname TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS perception_events_macos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bucket_id TEXT NOT NULL REFERENCES perception_buckets_macos(id) ON DELETE CASCADE,
                start_at TEXT NOT NULL,
                end_at TEXT NOT NULL,
                data_json TEXT NOT NULL,
                data_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_perception_macos_bucket_time
                ON perception_events_macos(bucket_id, start_at, end_at);
            CREATE INDEX IF NOT EXISTS idx_perception_macos_time
                ON perception_events_macos(start_at, end_at);
            CREATE INDEX IF NOT EXISTS idx_perception_macos_hash
                ON perception_events_macos(bucket_id, data_hash, end_at);

            CREATE TABLE IF NOT EXISTS app_catalog_windows (
                app_key TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                exe_path TEXT,
                color TEXT NOT NULL,
                icon_png BLOB,
                first_seen TEXT NOT NULL,
                last_seen TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_catalog_macos (
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
                combined_transcript TEXT,
                combined_transcribed_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                is_favorite INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_bili_assets_bvid ON bili_video_assets(bvid);
            CREATE INDEX IF NOT EXISTS idx_bili_assets_status ON bili_video_assets(download_status);
            CREATE INDEX IF NOT EXISTS idx_bili_assets_created ON bili_video_assets(created_at DESC);

            -- B 站转录历史：每次转录都保留一个版本，latest 字段仍留在 bili_video_assets 便于旧 UI 快速读取
            CREATE TABLE IF NOT EXISTS bili_transcript_runs (
                id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL REFERENCES bili_video_assets(id) ON DELETE CASCADE,
                bvid TEXT NOT NULL,
                download_path TEXT NOT NULL,
                kind TEXT NOT NULL,
                text TEXT NOT NULL,
                model_id TEXT,
                prompt_type TEXT,
                source TEXT NOT NULL DEFAULT 'manual',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_bili_transcript_runs_asset_kind
                ON bili_transcript_runs(asset_id, kind, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_bili_transcript_runs_path
                ON bili_transcript_runs(download_path, created_at DESC);

            INSERT OR IGNORE INTO bili_transcript_runs (
                id, asset_id, bvid, download_path, kind, text, source, created_at
            )
            SELECT a.id || ':visual:' || COALESCE(a.visual_transcribed_at, a.updated_at, a.created_at),
                   a.id, a.bvid, a.download_path, 'visual', a.visual_transcript, 'legacy_latest',
                   COALESCE(a.visual_transcribed_at, a.updated_at, a.created_at)
            FROM bili_video_assets a
            WHERE a.download_path IS NOT NULL
              AND a.visual_transcript IS NOT NULL
              AND trim(a.visual_transcript) <> ''
              AND NOT EXISTS (
                  SELECT 1 FROM bili_transcript_runs r
                  WHERE r.asset_id = a.id AND r.kind = 'visual'
              );

            INSERT OR IGNORE INTO bili_transcript_runs (
                id, asset_id, bvid, download_path, kind, text, source, created_at
            )
            SELECT a.id || ':audio:' || COALESCE(a.audio_transcribed_at, a.updated_at, a.created_at),
                   a.id, a.bvid, a.download_path, 'audio', a.audio_transcript, 'legacy_latest',
                   COALESCE(a.audio_transcribed_at, a.updated_at, a.created_at)
            FROM bili_video_assets a
            WHERE a.download_path IS NOT NULL
              AND a.audio_transcript IS NOT NULL
              AND trim(a.audio_transcript) <> ''
              AND NOT EXISTS (
                  SELECT 1 FROM bili_transcript_runs r
                  WHERE r.asset_id = a.id AND r.kind = 'audio'
              );

            INSERT OR IGNORE INTO bili_transcript_runs (
                id, asset_id, bvid, download_path, kind, text, source, created_at
            )
            SELECT a.id || ':combined:' || COALESCE(a.combined_transcribed_at, a.updated_at, a.created_at),
                   a.id, a.bvid, a.download_path, 'combined', a.combined_transcript, 'legacy_latest',
                   COALESCE(a.combined_transcribed_at, a.updated_at, a.created_at)
            FROM bili_video_assets a
            WHERE a.download_path IS NOT NULL
              AND a.combined_transcript IS NOT NULL
              AND trim(a.combined_transcript) <> ''
              AND NOT EXISTS (
                  SELECT 1 FROM bili_transcript_runs r
                  WHERE r.asset_id = a.id AND r.kind = 'combined'
              );

            -- 模型库（id + 通用元信息）
            CREATE TABLE IF NOT EXISTS model_registry (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,           -- 'text' | 'omni' | 'realtime' | 'embedding'
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
            -- AUDIT-036：deleted_at 作为 tombstone，让删除可被同步传播；
            -- 软删时 api_key 字段会被清成空串（不泄露明文给对端）
            CREATE TABLE IF NOT EXISTS model_api_keys (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                api_key TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                deleted_at TEXT
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
        // AUDIT-036：旧库的 model_api_keys 补 deleted_at（tombstone）
        let _ = conn.execute_batch("ALTER TABLE model_api_keys ADD COLUMN deleted_at TEXT");
        migrate_legacy_perception_tables(&conn)?;

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
             WHERE deleted_at IS NULL
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
             WHERE deleted_at IS NULL
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
            "INSERT INTO activity_categories (sync_id, name, color, sort_order, created_at, last_used_at, updated_at)
             VALUES (?, ?, ?, COALESCE((SELECT MAX(sort_order)+1 FROM activity_categories WHERE deleted_at IS NULL), 0), ?, ?, ?)",
            params![Uuid::new_v4().to_string(), &name, &req.color, &now, &now, &now],
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
        let now = local_now_string();
        conn.execute("UPDATE activity_categories SET deleted_at = ?, updated_at = ? WHERE id = ?", params![&now, &now, id])
            .map_err(|e| e.to_string())?;
        conn.execute("UPDATE activity_tags SET deleted_at = ?, updated_at = ? WHERE category_id = ?", params![&now, &now, id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE activity_blocks
             SET deleted_at = ?, updated_at = ?
             WHERE tag_id IN (SELECT id FROM activity_tags WHERE category_id = ?)",
            params![&now, &now, id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE plan_nodes
             SET deleted_at = ?, updated_at = ?
             WHERE project_tag_id IN (SELECT id FROM activity_tags WHERE category_id = ?)",
            params![&now, &now, id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE planned_blocks
             SET deleted_at = ?, updated_at = ?
             WHERE plan_node_id IN (
                 SELECT pn.id FROM plan_nodes pn
                 JOIN activity_tags t ON t.id = pn.project_tag_id
                 WHERE t.category_id = ?
             )",
            params![&now, &now, id],
        ).map_err(|e| e.to_string())?;
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
            let now = local_now_string();
            conn.execute(
                "UPDATE activity_categories SET color = ?, updated_at = ? WHERE id = ?",
                params![color, &now, req.id],
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
                "UPDATE activity_categories SET name = ?, updated_at = ? WHERE id = ?",
                params![new_name, local_now_string(), req.id],
            ).map_err(|e| format!("更新分类名失败: {}", e))?;

            // 级联更新 tag.full_path 与 leaf_name
            let old_prefix = old_name.clone();
            let old_prefix_with_comma = format!("{},", old_prefix);
            let new_prefix = new_name.to_string();
            let new_prefix_with_comma = format!("{},", new_prefix);

            // 1) 顶层叶子（full_path 恰等于旧 category 名）
            conn.execute(
                "UPDATE activity_tags
                 SET full_path = ?, leaf_name = ?, updated_at = ?
                 WHERE category_id = ? AND full_path = ?",
                params![&new_prefix, &new_prefix, local_now_string(), req.id, &old_prefix],
            ).map_err(|e| e.to_string())?;

            // 2) 子层标签
            conn.execute(
                "UPDATE activity_tags
                 SET full_path = ? || SUBSTR(full_path, ?), updated_at = ?
                 WHERE category_id = ? AND full_path LIKE ? || '%'",
                params![
                    &new_prefix_with_comma,
                    (old_prefix_with_comma.chars().count() as i64) + 1,
                    local_now_string(),
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
            "INSERT INTO activity_tags (sync_id, category_id, full_path, leaf_name, depth, created_at, last_used_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![Uuid::new_v4().to_string(), req.category_id, &normalized, &leaf, depth, &now, &now, &now],
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
        let now = local_now_string();
        conn.execute("UPDATE activity_tags SET deleted_at = ?, updated_at = ? WHERE id = ?", params![&now, &now, id])
            .map_err(|e| e.to_string())?;
        conn.execute("UPDATE activity_blocks SET deleted_at = ?, updated_at = ? WHERE tag_id = ?", params![&now, &now, id])
            .map_err(|e| e.to_string())?;
        conn.execute("UPDATE plan_nodes SET deleted_at = ?, updated_at = ? WHERE project_tag_id = ?", params![&now, &now, id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE planned_blocks
             SET deleted_at = ?, updated_at = ?
             WHERE plan_node_id IN (SELECT id FROM plan_nodes WHERE project_tag_id = ?)",
            params![&now, &now, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 重命名标签路径中的某一段（叶子或中间节点）：
    /// full_old_path = "工作,毕业论文"，new_segment = "毕业论文-2024"
    /// → 把所有以 "工作,毕业论文" 开头的 tag 的对应段都换掉
    /// 改单个 tag 的完整路径（含首段分类名）。扁平模式下不级联：每个 tag 独立。
    /// 首段如果换成别的已有分类名，会顺带更新 category_id。
    pub async fn rename_activity_path(&self, req: RenamePathRequest) -> Result<(), String> {
        let new_full = req.new_full_path.trim().trim_matches(',').to_string();
        if new_full.is_empty() {
            return Err("路径不能为空".into());
        }
        let segments: Vec<&str> = new_full.split(',').map(|s| s.trim()).collect();
        if segments.iter().any(|s| s.is_empty()) {
            return Err("路径段不能为空".into());
        }
        if segments.len() < 2 {
            return Err("路径至少要 2 段（分类名 + 子段）".into());
        }

        let conn = self.conn.lock().await;

        // 查 tag 现状
        let old: (i64, String) = conn.query_row(
            "SELECT category_id, full_path FROM activity_tags WHERE id = ?",
            params![req.tag_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "标签不存在".to_string())?;
        let (_old_category_id, old_full_path) = old;
        if new_full == old_full_path {
            return Ok(());
        }

        // 首段必须是已存在分类
        let cat_name = segments[0];
        let new_category_id: i64 = conn.query_row(
            "SELECT id FROM activity_categories WHERE name = ?",
            params![cat_name],
            |row| row.get(0),
        ).map_err(|_| format!("找不到分类「{}」", cat_name))?;

        // 同分类下重名（排除自己）
        let dup: Option<i64> = conn.query_row(
            "SELECT id FROM activity_tags WHERE category_id = ? AND full_path = ? AND id != ?",
            params![new_category_id, &new_full, req.tag_id],
            |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if dup.is_some() {
            return Err(format!("已存在同名标签「{}」", new_full));
        }

        let new_leaf = segments.last().unwrap().to_string();
        let new_depth = segments.len() as i64;
        let now = local_now_string();

        conn.execute(
            "UPDATE activity_tags
             SET category_id = ?, full_path = ?, leaf_name = ?, depth = ?, updated_at = ?
             WHERE id = ?",
            params![new_category_id, &new_full, &new_leaf, new_depth, &now, req.tag_id],
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
                "INSERT INTO activity_blocks (sync_id, date, minute, tag_id, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, NULL)
                 ON CONFLICT(date, minute) DO UPDATE SET
                     tag_id = excluded.tag_id,
                     created_at = excluded.created_at,
                     updated_at = excluded.updated_at,
                     deleted_at = NULL",
                params![Uuid::new_v4().to_string(), &req.date, minute, req.tag_id, &now, &now],
            ).map_err(|e| e.to_string())?;
            affected += 1;
        }

        conn.execute(
            "UPDATE activity_tags SET last_used_at = ?, updated_at = ? WHERE id = ?",
            params![&now, &now, req.tag_id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE activity_categories SET last_used_at = ?, updated_at = ? WHERE id = ?",
            params![&now, &now, category_id],
        ).map_err(|e| e.to_string())?;
        Ok(affected)
    }

    pub async fn erase_activity_blocks(&self, req: EraseBlocksRequest) -> Result<i64, String> {
        if req.minutes.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().await;
        let now = local_now_string();
        let placeholders = req.minutes.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE activity_blocks SET deleted_at = ?, updated_at = ? WHERE date = ? AND minute IN ({})",
            placeholders
        );
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone()), Box::new(now), Box::new(req.date.clone())];
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
             WHERE date = ? AND deleted_at IS NULL
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

    // ── Planned Timeline Blocks ──
    pub async fn get_plan_nodes_by_project(&self, project_tag_id: i64) -> Result<Vec<PlanNode>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, project_tag_id, parent_id, title, status, sort_order, created_at, updated_at
             FROM plan_nodes
             WHERE project_tag_id = ? AND deleted_at IS NULL
             ORDER BY COALESCE(parent_id, 0), sort_order ASC, id ASC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![project_tag_id], |row| {
            Ok(PlanNode {
                id: row.get(0)?,
                project_tag_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                status: row.get(4)?,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub async fn add_plan_node(&self, req: AddPlanNodeRequest) -> Result<PlanNode, String> {
        let title = req.title.trim();
        if title.is_empty() {
            return Err("计划节点标题不能为空".to_string());
        }

        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id FROM activity_tags WHERE id = ?",
            params![req.project_tag_id],
            |row| row.get::<_, i64>(0),
        ).map_err(|_| "项目标签不存在".to_string())?;

        if let Some(parent_id) = req.parent_id {
            let parent_project: i64 = conn.query_row(
                "SELECT project_tag_id FROM plan_nodes WHERE id = ?",
                params![parent_id],
                |row| row.get(0),
            ).map_err(|_| "父计划节点不存在".to_string())?;
            if parent_project != req.project_tag_id {
                return Err("父计划节点不属于当前项目".to_string());
            }
        }

        let now = local_now_string();
        let sort_order: i32 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1
             FROM plan_nodes
             WHERE project_tag_id = ? AND parent_id IS ?",
            params![req.project_tag_id, req.parent_id],
            |row| row.get(0),
        ).unwrap_or(0);

        conn.execute(
            "INSERT INTO plan_nodes (sync_id, project_tag_id, parent_id, title, status, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
            params![Uuid::new_v4().to_string(), req.project_tag_id, req.parent_id, title, sort_order, &now, &now],
        ).map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        Ok(PlanNode {
            id,
            project_tag_id: req.project_tag_id,
            parent_id: req.parent_id,
            title: title.to_string(),
            status: "active".to_string(),
            sort_order,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub async fn update_plan_node(&self, req: UpdatePlanNodeRequest) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let now = local_now_string();
        if let Some(title) = req.title {
            let title = title.trim();
            if title.is_empty() {
                return Err("计划节点标题不能为空".to_string());
            }
            conn.execute(
                "UPDATE plan_nodes SET title = ?, updated_at = ? WHERE id = ?",
                params![title, &now, req.id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(status) = req.status {
            if !matches!(status.as_str(), "active" | "done" | "archived") {
                return Err("计划状态不合法".to_string());
            }
            conn.execute(
                "UPDATE plan_nodes SET status = ?, updated_at = ? WHERE id = ?",
                params![status, &now, req.id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn delete_plan_node(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let now = local_now_string();
        conn.execute(
            "WITH RECURSIVE subtree(id) AS (
                SELECT id FROM plan_nodes WHERE id = ?
                UNION ALL
                SELECT n.id FROM plan_nodes n JOIN subtree s ON n.parent_id = s.id
             )
             UPDATE plan_nodes
             SET deleted_at = ?, updated_at = ?
             WHERE id IN (SELECT id FROM subtree)",
            params![id, &now, &now],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "WITH RECURSIVE subtree(id) AS (
                SELECT id FROM plan_nodes WHERE id = ?
                UNION ALL
                SELECT n.id FROM plan_nodes n JOIN subtree s ON n.parent_id = s.id
             )
             UPDATE planned_blocks
             SET deleted_at = ?, updated_at = ?
             WHERE plan_node_id IN (SELECT id FROM subtree)",
            params![id, &now, &now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn paint_planned_blocks(&self, req: PaintPlannedBlocksRequest) -> Result<i64, String> {
        if req.minutes.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().await;
        let now = local_now_string();

        let project_tag_id: i64 = conn.query_row(
            "SELECT project_tag_id FROM plan_nodes WHERE id = ?",
            params![req.plan_node_id],
            |row| row.get(0),
        ).map_err(|_| "计划节点不存在".to_string())?;

        let category_id: i64 = conn.query_row(
            "SELECT category_id FROM activity_tags WHERE id = ?",
            params![project_tag_id],
            |row| row.get(0),
        ).map_err(|_| "项目标签不存在".to_string())?;

        let mut affected = 0i64;
        for minute in &req.minutes {
            if *minute < 0 || *minute >= 1440 || minute % 5 != 0 {
                continue;
            }
            conn.execute(
                "INSERT INTO planned_blocks (sync_id, date, minute, plan_node_id, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, NULL)
                 ON CONFLICT(date, minute) DO UPDATE SET
                     plan_node_id = excluded.plan_node_id,
                     created_at = excluded.created_at,
                     updated_at = excluded.updated_at,
                     deleted_at = NULL",
                params![Uuid::new_v4().to_string(), &req.date, minute, req.plan_node_id, &now, &now],
            ).map_err(|e| e.to_string())?;
            affected += 1;
        }

        conn.execute(
            "UPDATE activity_tags SET last_used_at = ?, updated_at = ? WHERE id = ?",
            params![&now, &now, project_tag_id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE activity_categories SET last_used_at = ?, updated_at = ? WHERE id = ?",
            params![&now, &now, category_id],
        ).map_err(|e| e.to_string())?;
        Ok(affected)
    }

    pub async fn erase_planned_blocks(&self, req: EraseBlocksRequest) -> Result<i64, String> {
        if req.minutes.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().await;
        let now = local_now_string();
        let placeholders = req.minutes.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE planned_blocks SET deleted_at = ?, updated_at = ? WHERE date = ? AND minute IN ({})",
            placeholders
        );
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone()), Box::new(now), Box::new(req.date.clone())];
        for m in &req.minutes {
            params_vec.push(Box::new(*m));
        }
        let affected = conn.execute(
            &sql,
            rusqlite::params_from_iter(params_vec.iter().map(|b| b.as_ref())),
        ).map_err(|e| e.to_string())?;
        Ok(affected as i64)
    }

    pub async fn get_planned_blocks_by_date(&self, date: &str) -> Result<Vec<PlannedBlock>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT date, minute, plan_node_id, note, created_at
             FROM planned_blocks
             WHERE date = ? AND deleted_at IS NULL
             ORDER BY minute ASC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![date], |row| {
            Ok(PlannedBlock {
                date: row.get(0)?,
                minute: row.get(1)?,
                plan_node_id: row.get(2)?,
                note: row.get(3)?,
                created_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ── LAN Sync: activity records + plan layer ──

    pub async fn sync_device_id(&self) -> Result<String, String> {
        let conn = self.conn.lock().await;
        get_or_create_device_id(&conn)
    }

    pub async fn sync_alias(&self) -> Result<String, String> {
        let conn = self.conn.lock().await;
        let existing: Option<String> = conn.query_row(
            "SELECT value FROM sync_meta WHERE key = 'device_alias'",
            [],
            |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if let Some(alias) = existing.filter(|s| !s.trim().is_empty()) {
            return Ok(alias);
        }
        let device_id = get_or_create_device_id(&conn)?;
        let alias = generate_alias(&device_id);
        conn.execute(
            "INSERT INTO sync_meta (key, value, updated_at) VALUES ('device_alias', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![&alias, local_now_string()],
        ).map_err(|e| e.to_string())?;
        Ok(alias)
    }

    pub async fn set_sync_alias(&self, alias: String) -> Result<String, String> {
        let alias = alias.trim().to_string();
        if alias.is_empty() {
            return Err("别名不能为空".to_string());
        }
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO sync_meta (key, value, updated_at) VALUES ('device_alias', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![&alias, local_now_string()],
        ).map_err(|e| e.to_string())?;
        Ok(alias)
    }

    pub async fn list_linked_devices(&self) -> Result<Vec<LinkedDevice>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT device_id, alias, last_base, last_synced_at, created_at
             FROM linked_devices
             ORDER BY COALESCE(last_synced_at, '') DESC, alias ASC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(LinkedDevice {
                device_id: row.get(0)?,
                alias: row.get(1)?,
                last_base: row.get(2)?,
                last_synced_at: row.get(3)?,
                created_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub async fn add_linked_device(&self, device_id: String, alias: String, last_base: String) -> Result<LinkedDevice, String> {
        let device_id = device_id.trim().to_string();
        if device_id.is_empty() {
            return Err("device_id 不能为空".to_string());
        }
        let alias = alias.trim().to_string();
        let last_base = last_base.trim().to_string();
        let conn = self.conn.lock().await;
        let now = local_now_string();
        conn.execute(
            "INSERT INTO linked_devices (device_id, alias, last_base, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(device_id) DO UPDATE SET
               alias=excluded.alias, last_base=excluded.last_base",
            params![&device_id, &alias, &last_base, &now],
        ).map_err(|e| e.to_string())?;
        let created_at: String = conn.query_row(
            "SELECT created_at FROM linked_devices WHERE device_id = ?",
            params![&device_id],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        let last_synced_at: Option<String> = conn.query_row(
            "SELECT last_synced_at FROM linked_devices WHERE device_id = ?",
            params![&device_id],
            |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?.flatten();
        Ok(LinkedDevice { device_id, alias, last_base, last_synced_at, created_at })
    }

    pub async fn remove_linked_device(&self, device_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM linked_devices WHERE device_id = ?", params![device_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn touch_link_synced(&self, device_id: &str, last_base: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE linked_devices SET last_synced_at = ?, last_base = ? WHERE device_id = ?",
            params![local_now_string(), last_base, device_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn export_sync(&self, since: Option<String>) -> Result<SyncExport, String> {
        let conn = self.conn.lock().await;
        let exported_at = local_now_string();
        let device_id = get_or_create_device_id(&conn)?;

        let changed = |updated_at: &str, deleted_at: Option<&str>| -> bool {
            match since.as_deref() {
                Some(cursor) => updated_at > cursor || deleted_at.is_some_and(|d| d > cursor),
                None => true,
            }
        };

        let mut stmt = conn.prepare(
            "SELECT sync_id, name, color, sort_order, created_at, last_used_at, updated_at, deleted_at
             FROM activity_categories"
        ).map_err(|e| e.to_string())?;
        let activity_categories = stmt.query_map([], |row| {
            Ok(SyncActivityCategory {
                sync_id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
                last_used_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted_at: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .filter(|r| changed(&r.updated_at, r.deleted_at.as_deref()))
          .collect::<Vec<_>>();

        let mut stmt = conn.prepare(
            "SELECT t.sync_id, c.sync_id, t.full_path, t.leaf_name, t.depth, t.created_at, t.last_used_at, t.updated_at, t.deleted_at
             FROM activity_tags t
             JOIN activity_categories c ON c.id = t.category_id"
        ).map_err(|e| e.to_string())?;
        let activity_tags = stmt.query_map([], |row| {
            Ok(SyncActivityTag {
                sync_id: row.get(0)?,
                category_sync_id: row.get(1)?,
                full_path: row.get(2)?,
                leaf_name: row.get(3)?,
                depth: row.get(4)?,
                created_at: row.get(5)?,
                last_used_at: row.get(6)?,
                updated_at: row.get(7)?,
                deleted_at: row.get(8)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .filter(|r| changed(&r.updated_at, r.deleted_at.as_deref()))
          .collect::<Vec<_>>();

        let mut stmt = conn.prepare(
            "SELECT b.sync_id, b.date, b.minute, t.sync_id, b.note, b.created_at, b.updated_at, b.deleted_at
             FROM activity_blocks b
             JOIN activity_tags t ON t.id = b.tag_id"
        ).map_err(|e| e.to_string())?;
        let activity_blocks = stmt.query_map([], |row| {
            Ok(SyncActivityBlock {
                sync_id: row.get(0)?,
                date: row.get(1)?,
                minute: row.get(2)?,
                tag_sync_id: row.get(3)?,
                note: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted_at: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .filter(|r| changed(&r.updated_at, r.deleted_at.as_deref()))
          .collect::<Vec<_>>();

        let mut stmt = conn.prepare(
            "SELECT n.sync_id, t.sync_id, p.sync_id, n.title, n.status, n.sort_order, n.created_at, n.updated_at, n.deleted_at
             FROM plan_nodes n
             JOIN activity_tags t ON t.id = n.project_tag_id
             LEFT JOIN plan_nodes p ON p.id = n.parent_id
             ORDER BY n.project_tag_id, COALESCE(n.parent_id, 0), n.sort_order, n.id"
        ).map_err(|e| e.to_string())?;
        let plan_nodes = stmt.query_map([], |row| {
            Ok(SyncPlanNode {
                sync_id: row.get(0)?,
                project_tag_sync_id: row.get(1)?,
                parent_sync_id: row.get(2)?,
                title: row.get(3)?,
                status: row.get(4)?,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                deleted_at: row.get(8)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .filter(|r| changed(&r.updated_at, r.deleted_at.as_deref()))
          .collect::<Vec<_>>();

        let mut stmt = conn.prepare(
            "SELECT b.sync_id, b.date, b.minute, n.sync_id, b.note, b.created_at, b.updated_at, b.deleted_at
             FROM planned_blocks b
             JOIN plan_nodes n ON n.id = b.plan_node_id"
        ).map_err(|e| e.to_string())?;
        let planned_blocks = stmt.query_map([], |row| {
            Ok(SyncPlannedBlock {
                sync_id: row.get(0)?,
                date: row.get(1)?,
                minute: row.get(2)?,
                plan_node_sync_id: row.get(3)?,
                note: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted_at: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .filter(|r| changed(&r.updated_at, r.deleted_at.as_deref()))
          .collect::<Vec<_>>();

        // ── 模型相关 4 张表 ──
        // AUDIT-036：export 含 deleted_at（让 tombstone 跨端同步），tombstone
        // 的 api_key 字段在 payload 层清成空串避免明文 key 复制到对端
        let mut stmt = conn.prepare(
            "SELECT id, label, api_key, is_active, created_at, updated_at, deleted_at FROM model_api_keys"
        ).map_err(|e| e.to_string())?;
        let model_api_keys = stmt.query_map([], |row| {
            let deleted_at: Option<String> = row.get(6)?;
            let api_key: String = row.get(2)?;
            Ok(SyncModelApiKey {
                id: row.get(0)?,
                label: row.get(1)?,
                api_key: if deleted_at.is_some() { String::new() } else { api_key },
                is_active: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                deleted_at,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .filter(|r| changed(&r.updated_at, None))
          .collect::<Vec<_>>();

        // call_log 是 append-only：用 started_at 当增量游标
        let mut stmt = conn.prepare(
            "SELECT id, api_key_id, feature, model_id, started_at, duration_ms,
                    prompt_text_tokens, prompt_image_tokens, prompt_video_tokens, prompt_audio_tokens,
                    completion_text_tokens, completion_audio_tokens,
                    cost_cny, free_quota_tokens, free_quota_saved_cny,
                    success, error_message, metadata
             FROM model_call_log l
             WHERE l.api_key_id IS NULL
                OR NOT EXISTS (
                    SELECT 1 FROM model_api_keys k
                    WHERE k.id = l.api_key_id AND k.deleted_at IS NOT NULL
                )"
        ).map_err(|e| e.to_string())?;
        let model_call_log = stmt.query_map([], |row| {
            Ok(SyncModelCallLog {
                id: row.get(0)?,
                api_key_id: row.get(1)?,
                feature: row.get(2)?,
                model_id: row.get(3)?,
                started_at: row.get(4)?,
                duration_ms: row.get(5)?,
                prompt_text_tokens: row.get(6)?,
                prompt_image_tokens: row.get(7)?,
                prompt_video_tokens: row.get(8)?,
                prompt_audio_tokens: row.get(9)?,
                completion_text_tokens: row.get(10)?,
                completion_audio_tokens: row.get(11)?,
                cost_cny: row.get(12)?,
                free_quota_tokens: row.get(13)?,
                free_quota_saved_cny: row.get(14)?,
                success: row.get(15)?,
                error_message: row.get(16)?,
                metadata: row.get(17)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .filter(|r| changed(&r.started_at, None))
          .collect::<Vec<_>>();

        let mut stmt = conn.prepare(
            "SELECT model_id, has_free_quota, not_supported, used_tokens, total_tokens,
                    remaining_tokens, used_percent, expire_date, raw_quota, scanned_at, error_message
             FROM model_free_quota"
        ).map_err(|e| e.to_string())?;
        let model_free_quota = stmt.query_map([], |row| {
            Ok(SyncModelFreeQuota {
                model_id: row.get(0)?,
                has_free_quota: row.get(1)?,
                not_supported: row.get(2)?,
                used_tokens: row.get(3)?,
                total_tokens: row.get(4)?,
                remaining_tokens: row.get(5)?,
                used_percent: row.get(6)?,
                expire_date: row.get(7)?,
                raw_quota: row.get(8)?,
                scanned_at: row.get(9)?,
                error_message: row.get(10)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .filter(|r| changed(&r.scanned_at, None))
          .collect::<Vec<_>>();

        let mut stmt = conn.prepare(
            "SELECT feature, model_id, updated_at FROM feature_bindings"
        ).map_err(|e| e.to_string())?;
        let feature_bindings = stmt.query_map([], |row| {
            Ok(SyncFeatureBinding {
                feature: row.get(0)?,
                model_id: row.get(1)?,
                updated_at: row.get(2)?,
            })
        }).map_err(|e| e.to_string())?
          .filter_map(|r| r.ok())
          .filter(|r| changed(&r.updated_at, None))
          .collect::<Vec<_>>();

        Ok(SyncExport {
            device_id,
            exported_at: exported_at.clone(),
            cursor: exported_at,
            activity_categories,
            activity_tags,
            activity_blocks,
            plan_nodes,
            planned_blocks,
            model_api_keys,
            model_call_log,
            model_free_quota,
            feature_bindings,
        })
    }

    pub async fn import_sync(&self, payload: SyncExport) -> Result<SyncImportResult, String> {
        let conn = self.conn.lock().await;
        let mut result = SyncImportResult {
            activity_categories: 0,
            activity_tags: 0,
            activity_blocks: 0,
            plan_nodes: 0,
            planned_blocks: 0,
            model_api_keys: 0,
            model_call_log: 0,
            model_free_quota: 0,
            feature_bindings: 0,
            skipped: 0,
        };

        for row in payload.activity_categories {
            if !should_apply_sync_row(&conn, "activity_categories", &row.sync_id, &row.updated_at)? {
                result.skipped += 1;
                continue;
            }
            let existing_by_name: Option<i64> = conn.query_row(
                "SELECT id FROM activity_categories WHERE name = ?",
                params![&row.name],
                |r| r.get(0),
            ).optional().map_err(|e| e.to_string())?;
            if let Some(id) = existing_by_name {
                if !should_apply_existing_id(&conn, "activity_categories", id, &row.updated_at)? {
                    result.skipped += 1;
                    continue;
                }
                // AUDIT-011: UPDATE 会把目标行 sync_id 改成 incoming.sync_id；
                // 若 desktop 已有旁系行（不同 name）占着 incoming.sync_id，会撞 UNIQUE(sync_id)
                // 整次 import_sync 失败。不能裸 DELETE 旁系（ON DELETE CASCADE 会静默吞
                // 它挂的 tags / blocks / plan_nodes / planned_blocks 等本地未同步子数据）。
                // 改为 cascade-aware merge：旁系子项迁/合并到 id（业务键匹配权威行）再删空旁系。
                merge_category_conflict(&conn, &row.sync_id, id)?;
                conn.execute(
                    "UPDATE activity_categories
                     SET sync_id=?, color=?, sort_order=?, created_at=?, last_used_at=?, updated_at=?, deleted_at=?
                     WHERE id=?",
                    params![&row.sync_id, &row.color, row.sort_order, &row.created_at, &row.last_used_at, &row.updated_at, &row.deleted_at, id],
                ).map_err(|e| e.to_string())?;
            } else {
                conn.execute(
                    "INSERT INTO activity_categories (sync_id, name, color, sort_order, created_at, last_used_at, updated_at, deleted_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(sync_id) DO UPDATE SET
                       name=excluded.name, color=excluded.color, sort_order=excluded.sort_order,
                       created_at=excluded.created_at, last_used_at=excluded.last_used_at,
                       updated_at=excluded.updated_at, deleted_at=excluded.deleted_at",
                    params![&row.sync_id, &row.name, &row.color, row.sort_order, &row.created_at, &row.last_used_at, &row.updated_at, &row.deleted_at],
                ).map_err(|e| e.to_string())?;
            }
            result.activity_categories += 1;
        }

        for row in payload.activity_tags {
            if !should_apply_sync_row(&conn, "activity_tags", &row.sync_id, &row.updated_at)? {
                result.skipped += 1;
                continue;
            }
            let Some(category_id) = lookup_id_by_sync(&conn, "activity_categories", &row.category_sync_id)? else {
                result.skipped += 1;
                continue;
            };
            let existing_by_path: Option<i64> = conn.query_row(
                "SELECT id FROM activity_tags WHERE category_id = ? AND full_path = ?",
                params![category_id, &row.full_path],
                |r| r.get(0),
            ).optional().map_err(|e| e.to_string())?;
            if let Some(id) = existing_by_path {
                if !should_apply_existing_id(&conn, "activity_tags", id, &row.updated_at)? {
                    result.skipped += 1;
                    continue;
                }
                // 同 categories：AUDIT-011 cascade-aware merge 旁系 sync_id 占用
                merge_tag_conflict(&conn, &row.sync_id, id)?;
                conn.execute(
                    "UPDATE activity_tags
                     SET sync_id=?, leaf_name=?, depth=?, created_at=?, last_used_at=?, updated_at=?, deleted_at=?
                     WHERE id=?",
                    params![&row.sync_id, &row.leaf_name, row.depth, &row.created_at, &row.last_used_at, &row.updated_at, &row.deleted_at, id],
                ).map_err(|e| e.to_string())?;
            } else {
                conn.execute(
                    "INSERT INTO activity_tags (sync_id, category_id, full_path, leaf_name, depth, created_at, last_used_at, updated_at, deleted_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(sync_id) DO UPDATE SET
                       category_id=excluded.category_id, full_path=excluded.full_path, leaf_name=excluded.leaf_name,
                       depth=excluded.depth, created_at=excluded.created_at, last_used_at=excluded.last_used_at,
                       updated_at=excluded.updated_at, deleted_at=excluded.deleted_at",
                    params![&row.sync_id, category_id, &row.full_path, &row.leaf_name, row.depth, &row.created_at, &row.last_used_at, &row.updated_at, &row.deleted_at],
                ).map_err(|e| e.to_string())?;
            }
            result.activity_tags += 1;
        }

        for row in payload.plan_nodes {
            if !should_apply_sync_row(&conn, "plan_nodes", &row.sync_id, &row.updated_at)? {
                result.skipped += 1;
                continue;
            }
            let Some(project_tag_id) = lookup_id_by_sync(&conn, "activity_tags", &row.project_tag_sync_id)? else {
                result.skipped += 1;
                continue;
            };
            let parent_id = match row.parent_sync_id.as_deref() {
                Some(sync_id) => lookup_id_by_sync(&conn, "plan_nodes", sync_id)?,
                None => None,
            };
            conn.execute(
                "INSERT INTO plan_nodes (sync_id, project_tag_id, parent_id, title, status, sort_order, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(sync_id) DO UPDATE SET
                   project_tag_id=excluded.project_tag_id, parent_id=excluded.parent_id,
                   title=excluded.title, status=excluded.status, sort_order=excluded.sort_order,
                   created_at=excluded.created_at, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at",
                params![&row.sync_id, project_tag_id, parent_id, &row.title, &row.status, row.sort_order, &row.created_at, &row.updated_at, &row.deleted_at],
            ).map_err(|e| e.to_string())?;
            result.plan_nodes += 1;
        }

        for row in payload.activity_blocks {
            if !should_apply_sync_row(&conn, "activity_blocks", &row.sync_id, &row.updated_at)? {
                result.skipped += 1;
                continue;
            }
            if !should_apply_slot_row(&conn, "activity_blocks", &row.date, row.minute, &row.sync_id, &row.updated_at)? {
                result.skipped += 1;
                continue;
            }
            let Some(tag_id) = lookup_id_by_sync(&conn, "activity_tags", &row.tag_sync_id)? else {
                result.skipped += 1;
                continue;
            };
            // 双键挑战：sync_id UNIQUE + PK(date, minute)。同 sync_id 跨槽位
            // 迁移（block 被对端改了时间）旧 INSERT 只 ON CONFLICT(date,minute)
            // 会撞 UNIQUE(sync_id) → 抛 SQLITE_CONSTRAINT_UNIQUE，
            // import_sync 当前传播错误 → 整次同步失败。
            // 先 DELETE 同 sync_id 但不在目标槽位的旧 row（AUDIT-009）
            conn.execute(
                "DELETE FROM activity_blocks WHERE sync_id = ? AND NOT (date = ? AND minute = ?)",
                params![&row.sync_id, &row.date, row.minute],
            ).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO activity_blocks (sync_id, date, minute, tag_id, note, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(date, minute) DO UPDATE SET
                   sync_id=excluded.sync_id, tag_id=excluded.tag_id, note=excluded.note,
                   created_at=excluded.created_at, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at",
                params![&row.sync_id, &row.date, row.minute, tag_id, &row.note, &row.created_at, &row.updated_at, &row.deleted_at],
            ).map_err(|e| e.to_string())?;
            result.activity_blocks += 1;
        }

        for row in payload.planned_blocks {
            if !should_apply_sync_row(&conn, "planned_blocks", &row.sync_id, &row.updated_at)? {
                result.skipped += 1;
                continue;
            }
            if !should_apply_slot_row(&conn, "planned_blocks", &row.date, row.minute, &row.sync_id, &row.updated_at)? {
                result.skipped += 1;
                continue;
            }
            let Some(plan_node_id) = lookup_id_by_sync(&conn, "plan_nodes", &row.plan_node_sync_id)? else {
                result.skipped += 1;
                continue;
            };
            // 同 activity_blocks 双键挑战，AUDIT-009 修复
            conn.execute(
                "DELETE FROM planned_blocks WHERE sync_id = ? AND NOT (date = ? AND minute = ?)",
                params![&row.sync_id, &row.date, row.minute],
            ).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO planned_blocks (sync_id, date, minute, plan_node_id, note, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(date, minute) DO UPDATE SET
                   sync_id=excluded.sync_id, plan_node_id=excluded.plan_node_id, note=excluded.note,
                   created_at=excluded.created_at, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at",
                params![&row.sync_id, &row.date, row.minute, plan_node_id, &row.note, &row.created_at, &row.updated_at, &row.deleted_at],
            ).map_err(|e| e.to_string())?;
            result.planned_blocks += 1;
        }

        // ── 模型 API Keys：LWW by updated_at，PK=id ──
        // AUDIT-036：
        // - 接受 deleted_at（tombstone）：本地保留行作为 tombstone，
        //   api_key 字段强制清空（即使对端发了明文也不存）
        // - active 全局唯一：当 import 一个活的 is_active=1 行后，事务内
        //   把其他所有 is_active=1 的行降为 0 + bump updated_at = row.updated_at
        //   让对端下一轮同步能拿到 inactive 状态
        for row in payload.model_api_keys {
            let local_updated: Option<String> = conn.query_row(
                "SELECT updated_at FROM model_api_keys WHERE id = ?",
                params![&row.id],
                |r| r.get(0),
            ).optional().map_err(|e| e.to_string())?;
            if local_updated.as_deref().map(|t| row.updated_at <= t.to_string()).unwrap_or(false) {
                result.skipped += 1;
                continue;
            }
            let is_tombstone = row.deleted_at.is_some();
            // tombstone 写入：清明文 api_key，保留 label + deleted_at
            let api_key_to_store: &str = if is_tombstone { "" } else { row.api_key.as_str() };
            let is_active_to_store: i32 = if is_tombstone { 0 } else { row.is_active };
            conn.execute(
                "INSERT INTO model_api_keys (id, label, api_key, is_active, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   label=excluded.label, api_key=excluded.api_key, is_active=excluded.is_active,
                   created_at=excluded.created_at, updated_at=excluded.updated_at,
                   deleted_at=excluded.deleted_at",
                params![&row.id, &row.label, api_key_to_store, is_active_to_store,
                        &row.created_at, &row.updated_at, &row.deleted_at],
            ).map_err(|e| e.to_string())?;
            // active 归一化：刚 import 的活 active 行存在时，其他 active 全 降级
            if !is_tombstone && row.is_active == 1 {
                conn.execute(
                    "UPDATE model_api_keys
                     SET is_active = 0, updated_at = ?
                     WHERE id != ? AND is_active = 1 AND deleted_at IS NULL",
                    params![&row.updated_at, &row.id],
                ).map_err(|e| e.to_string())?;
            }
            if is_tombstone {
                conn.execute("DELETE FROM model_call_log WHERE api_key_id = ?", params![&row.id])
                    .map_err(|e| e.to_string())?;
            }
            result.model_api_keys += 1;
        }

        // ── 模型调用日志：append-only，PK=id 撞了就跳过 ──
        for row in payload.model_call_log {
            if let Some(api_key_id) = row.api_key_id.as_deref() {
                let key_deleted: bool = conn.query_row(
                    "SELECT deleted_at IS NOT NULL FROM model_api_keys WHERE id = ?",
                    params![api_key_id],
                    |r| r.get::<_, i64>(0),
                ).optional().map_err(|e| e.to_string())?.unwrap_or(0) != 0;
                if key_deleted {
                    result.skipped += 1;
                    continue;
                }
            }
            let exists: bool = conn.query_row(
                "SELECT 1 FROM model_call_log WHERE id = ?",
                params![&row.id],
                |_| Ok(true),
            ).optional().map_err(|e| e.to_string())?.unwrap_or(false);
            if exists {
                result.skipped += 1;
                continue;
            }
            conn.execute(
                "INSERT INTO model_call_log (id, api_key_id, feature, model_id, started_at, duration_ms,
                    prompt_text_tokens, prompt_image_tokens, prompt_video_tokens, prompt_audio_tokens,
                    completion_text_tokens, completion_audio_tokens,
                    cost_cny, free_quota_tokens, free_quota_saved_cny,
                    success, error_message, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    &row.id, &row.api_key_id, &row.feature, &row.model_id, &row.started_at, row.duration_ms,
                    row.prompt_text_tokens, row.prompt_image_tokens, row.prompt_video_tokens, row.prompt_audio_tokens,
                    row.completion_text_tokens, row.completion_audio_tokens,
                    row.cost_cny, row.free_quota_tokens, row.free_quota_saved_cny,
                    row.success, &row.error_message, &row.metadata,
                ],
            ).map_err(|e| e.to_string())?;
            result.model_call_log += 1;
        }

        // ── 模型免费额度状态：LWW by scanned_at，PK=model_id ──
        for row in payload.model_free_quota {
            let local_scanned: Option<String> = conn.query_row(
                "SELECT scanned_at FROM model_free_quota WHERE model_id = ?",
                params![&row.model_id],
                |r| r.get(0),
            ).optional().map_err(|e| e.to_string())?;
            if local_scanned.as_deref().map(|t| row.scanned_at <= t.to_string()).unwrap_or(false) {
                result.skipped += 1;
                continue;
            }
            conn.execute(
                "INSERT INTO model_free_quota (model_id, has_free_quota, not_supported,
                    used_tokens, total_tokens, remaining_tokens, used_percent, expire_date, raw_quota,
                    scanned_at, error_message)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(model_id) DO UPDATE SET
                   has_free_quota=excluded.has_free_quota, not_supported=excluded.not_supported,
                   used_tokens=excluded.used_tokens, total_tokens=excluded.total_tokens,
                   remaining_tokens=excluded.remaining_tokens, used_percent=excluded.used_percent,
                   expire_date=excluded.expire_date, raw_quota=excluded.raw_quota,
                   scanned_at=excluded.scanned_at, error_message=excluded.error_message",
                params![
                    &row.model_id, row.has_free_quota, row.not_supported,
                    row.used_tokens, row.total_tokens, row.remaining_tokens,
                    &row.used_percent, &row.expire_date, &row.raw_quota,
                    &row.scanned_at, &row.error_message,
                ],
            ).map_err(|e| e.to_string())?;
            result.model_free_quota += 1;
        }

        // ── Feature ↔ 模型 绑定：LWW by updated_at，PK=feature ──
        for row in payload.feature_bindings {
            let local_updated: Option<String> = conn.query_row(
                "SELECT updated_at FROM feature_bindings WHERE feature = ?",
                params![&row.feature],
                |r| r.get(0),
            ).optional().map_err(|e| e.to_string())?;
            if local_updated.as_deref().map(|t| row.updated_at <= t.to_string()).unwrap_or(false) {
                result.skipped += 1;
                continue;
            }
            conn.execute(
                "INSERT INTO feature_bindings (feature, model_id, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(feature) DO UPDATE SET
                   model_id=excluded.model_id, updated_at=excluded.updated_at",
                params![&row.feature, &row.model_id, &row.updated_at],
            ).map_err(|e| e.to_string())?;
            result.feature_bindings += 1;
        }

        Ok(result)
    }

    #[allow(dead_code)]
    pub async fn paint_planned_blocks_legacy_tag(&self, req: PaintBlocksRequest) -> Result<i64, String> {
        if req.minutes.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().await;
        let now = local_now_string();

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
                "INSERT INTO planned_blocks (date, minute, tag_id, created_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(date, minute) DO UPDATE SET
                     tag_id = excluded.tag_id,
                     created_at = excluded.created_at",
                params![&req.date, minute, req.tag_id, &now],
            ).map_err(|e| e.to_string())?;
            affected += 1;
        }

        conn.execute(
            "UPDATE activity_tags SET last_used_at = ?, updated_at = ? WHERE id = ?",
            params![&now, &now, req.tag_id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE activity_categories SET last_used_at = ?, updated_at = ? WHERE id = ?",
            params![&now, &now, category_id],
        ).map_err(|e| e.to_string())?;
        Ok(affected)
    }

    #[allow(dead_code)]
    pub async fn erase_planned_blocks_legacy_tag(&self, req: EraseBlocksRequest) -> Result<i64, String> {
        if req.minutes.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().await;
        let placeholders = req.minutes.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM planned_blocks WHERE date = ? AND minute IN ({})",
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

    #[allow(dead_code)]
    pub async fn get_planned_blocks_by_date_legacy_tag(&self, date: &str) -> Result<Vec<ActivityBlock>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT date, minute, tag_id, note, created_at
             FROM planned_blocks
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
            "SELECT id, session_id, role, content, tool_calls, tool_call_id, name, timestamp, audio_path, duration_ms, usage_json, reasoning FROM chat_messages WHERE session_id = ? ORDER BY timestamp"
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
                reasoning: row.get(11)?,
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
                "INSERT INTO chat_messages (id, session_id, role, content, tool_calls, tool_call_id, name, timestamp, audio_path, duration_ms, usage_json, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![&id, session_id, &msg.role, &msg.content, &msg.tool_calls, &msg.tool_call_id, &msg.name, &msg.timestamp, &msg.audio_path, &msg.duration_ms, &msg.usage_json, &msg.reasoning],
            ).map_err(|e| e.to_string())?;
        }

        conn.execute(
            "UPDATE chat_sessions SET updated_at = ? WHERE id = ?",
            params![&now, session_id],
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// 更新会话标题或摘要。
    /// 不 bump updated_at：它的语义是"最后聊天活动"（persist_messages 负责），
    /// 改名/重新起标题不应把旧会话顶到列表最前。
    pub async fn update_chat_session(&self, session_id: &str, req: UpdateChatSessionRequest) -> Result<(), String> {
        let conn = self.conn.lock().await;

        if let Some(ref title) = req.title {
            conn.execute(
                "UPDATE chat_sessions SET title = ? WHERE id = ?",
                params![title, session_id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(ref summary) = req.summary {
            conn.execute(
                "UPDATE chat_sessions SET summary = ? WHERE id = ?",
                params![summary, session_id],
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
        &self, q: &str, limit: i64, offset: i64,
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
            LIMIT ?3 OFFSET ?4
        "#;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(
            params![like, q_trim, limit, offset],
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
                  WHERE a.bvid = s.bvid AND a.download_status = 'done'
                ) AS downloaded,
                EXISTS (SELECT 1 FROM bili_video_assets a
                  WHERE a.bvid = s.bvid
                    AND (a.visual_transcript IS NOT NULL OR a.audio_transcript IS NOT NULL OR a.combined_transcript IS NOT NULL)
                ) AS transcribed,
                COALESCE((SELECT h.is_favorite FROM bili_history h WHERE h.bvid = s.bvid), 0) AS favorite
            FROM spans s
            WHERE date(s.view_at,    'unixepoch', 'localtime') = ?1
               OR date(s.start_unix, 'unixepoch', 'localtime') = ?1
            ORDER BY s.view_at ASC
        "#;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![date], |row| {
            let file_size_bytes: Option<i64> = row.get(11)?;
            let downloaded: bool = row.get(12)?;
            let transcribed: bool = row.get(13)?;
            let favorite: bool = row.get(14)?;
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
                downloaded,
                file_size_bytes,
                transcribed,
                favorite,
            })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 在 [from, to] 范围内，返回所有"有数据"的日期（用于昼夜表前后日按钮）
    /// 数据 = activity_blocks OR bili_history OR presence_spans OR 当前平台 perception_events 任意一项有记录
    pub async fn get_data_days(
        &self, from: &str, to: &str,
    ) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().await;
        let sql = format!(r#"
            WITH RECURSIVE presence_days(day, end_day) AS (
                SELECT
                    date(start_time),
                    date(COALESCE(end_time, datetime('now', 'localtime')))
                FROM presence_spans
                WHERE date(start_time) <= ?2
                  AND date(COALESCE(end_time, datetime('now', 'localtime'))) >= ?1
                UNION ALL
                SELECT date(day, '+1 day'), end_day
                FROM presence_days
                WHERE day < end_day
            )
            SELECT day FROM (
                SELECT DISTINCT date AS day
                FROM activity_blocks
                WHERE date BETWEEN ?1 AND ?2
                UNION
                SELECT DISTINCT date AS day
                FROM planned_blocks
                WHERE date BETWEEN ?1 AND ?2
                UNION
                SELECT DISTINCT date(view_at, 'unixepoch', 'localtime') AS day
                FROM bili_history
                WHERE date(view_at, 'unixepoch', 'localtime') BETWEEN ?1 AND ?2
                UNION
                SELECT DISTINCT day
                FROM presence_days
                WHERE day BETWEEN ?1 AND ?2
                UNION
                SELECT DISTINCT substr(start_at, 1, 10) AS day
                FROM {events_table}
                WHERE substr(start_at, 1, 10) BETWEEN ?1 AND ?2
            )
            ORDER BY day ASC
        "#, events_table = PERCEPTION_EVENTS_TABLE);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
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

    // ── Context Cards（语境卡）──

    pub async fn add_context_card(&self, id: &str, text: &str, source_label: Option<&str>, source_card_id: Option<&str>, created_at: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO context_cards (id, kind, text, source_label, source_card_id, created_at, updated_at) VALUES (?, 'thought', ?, ?, ?, ?, ?)",
            params![id, text, source_label, source_card_id, created_at, created_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 删卡级联：该卡的绑定、绑定-锚点关联一并删；随之成为孤儿的锚点（无任何绑定引用）
    /// 连同其向量清掉，并清簇名缓存（成员集变了，下次重新起名）
    pub async fn delete_context_card(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        // 本卡的绑定 + 由本卡派生挂在其他卡上的同源绑定（如语境卡上的高亮）一起级联
        conn.execute(
            "DELETE FROM binding_anchors WHERE binding_id IN
             (SELECT id FROM context_anchor_bindings WHERE card_id = ? OR source_card_id = ?)",
            params![id, id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM context_anchor_bindings WHERE card_id = ? OR source_card_id = ?",
            params![id, id],
        ).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM context_cards WHERE id = ?", [id]).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM anchor_embeddings WHERE anchor_id IN
             (SELECT id FROM anchors WHERE id NOT IN (SELECT anchor_id FROM binding_anchors))",
            [],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM anchors WHERE id NOT IN (SELECT anchor_id FROM binding_anchors)",
            [],
        ).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM anchor_cluster_names", []).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 语境卡流：想法卡 + 已转录 B 站视频卡，合并按时间倒序。
    /// 转录卡不物化进表，查询时从 bili 表动态聚合，每 bvid 取最新转录。
    pub async fn context_feed(&self) -> Result<Vec<ContextFeedItem>, String> {
        let conn = self.conn.lock().await;
        let mut out: Vec<ContextFeedItem> = Vec::new();

        // 想法卡（带断链判定：指向视频 + 自己有锚点 + 视频侧零回填 → link_broken=1）
        {
            let mut stmt = conn.prepare(
                "SELECT c.id, c.text, c.source_label, c.source_card_id, c.created_at, \
                        CASE WHEN c.source_card_id IS NOT NULL \
                             AND EXISTS(SELECT 1 FROM context_anchor_bindings b \
                                        JOIN binding_anchors ba ON ba.binding_id = b.id \
                                        WHERE b.card_id = c.id) \
                             AND NOT EXISTS(SELECT 1 FROM context_anchor_bindings vb \
                                            WHERE vb.card_id = c.source_card_id AND vb.source_card_id = c.id) \
                        THEN 1 ELSE 0 END AS link_broken \
                 FROM context_cards c WHERE c.kind = 'thought'"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok(ContextFeedItem {
                    id: row.get::<_, String>(0)?,
                    kind: "thought".to_string(),
                    text: row.get::<_, String>(1)?,
                    title: None,
                    cover_url: None,
                    bvid: None,
                    ref_path: None,
                    source_label: row.get::<_, Option<String>>(2)?,
                    source_card_id: row.get::<_, Option<String>>(3)?,
                    created_at: row.get::<_, String>(4)?,
                    link_broken: row.get::<_, i64>(5)? != 0,
                })
            }).map_err(|e| e.to_string())?;
            for r in rows.flatten() { out.push(r); }
        }

        // 已转录 B 站视频卡（combined > audio > visual 优先，每 bvid 取最新）
        {
            let mut stmt = conn.prepare(
                "SELECT a.bvid, h.title, h.cover, a.download_path, \
                        COALESCE(a.combined_transcript, a.audio_transcript, a.visual_transcript) AS transcript, \
                        MAX(COALESCE(a.combined_transcribed_at, a.audio_transcribed_at, a.visual_transcribed_at, a.updated_at, a.created_at)) AS transcribed_at \
                 FROM bili_video_assets a \
                 JOIN bili_history h ON h.bvid = a.bvid \
                 WHERE trim(COALESCE(a.combined_transcript, a.audio_transcript, a.visual_transcript, '')) <> '' \
                 GROUP BY a.bvid"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                let bvid: String = row.get(0)?;
                let title: String = row.get(1)?;
                let cover: String = row.get(2)?;
                let path: Option<String> = row.get(3)?;
                let transcript: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
                let at: String = row.get::<_, Option<String>>(5)?.unwrap_or_default();
                let summary: String = transcript_plain_text(&transcript).chars().take(150).collect();
                Ok(ContextFeedItem {
                    id: bvid.clone(),
                    kind: "bili_transcript".to_string(),
                    text: summary,
                    title: Some(title),
                    cover_url: if cover.is_empty() { None } else { Some(cover) },
                    bvid: Some(bvid),
                    ref_path: path,
                    source_label: None,
                    source_card_id: None,
                    created_at: at,
                    link_broken: false,
                })
            }).map_err(|e| e.to_string())?;
            for r in rows.flatten() { out.push(r); }
        }

        // 统一倒序：把 ISO 的 'T' 规整成空格，使两种时间格式可字符串比较
        out.sort_by(|a, b| {
            let ka = a.created_at.replacen('T', " ", 1);
            let kb = b.created_at.replacen('T', " ", 1);
            kb.cmp(&ka)
        });

        Ok(out)
    }

    // ── 锚点（语境片段 ↔ 原话 ↔ 关键词）──

    /// 新建一个语境绑定：卡内文段 + 原话 + 从原话提取的锚点关键词。
    /// 锚点关键词同名同类复用（跨卡共享），原话不共享。
    pub async fn add_anchor_binding(
        &self,
        card_id: &str,
        start_pos: i64,
        end_pos: i64,
        selected_text: &str,
        user_speech: &str,
        anchors: &[(String, String)], // (keyword, category)
        source_card_id: Option<&str>, // 同源想法卡 id（删它时本绑定级联）
    ) -> Result<BindingRow, String> {
        let conn = self.conn.lock().await;
        let now = chrono::Utc::now().to_rfc3339();
        let binding_id = uuid::Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO context_anchor_bindings (id, card_id, start_pos, end_pos, selected_text, user_speech, source_card_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
            params![binding_id, card_id, start_pos, end_pos, selected_text, user_speech, source_card_id, now],
        ).map_err(|e| e.to_string())?;

        let mut anchor_refs: Vec<AnchorRef> = Vec::new();
        for (keyword, category) in anchors {
            let kw = keyword.trim();
            if kw.is_empty() { continue; }
            // upsert：同名同类复用
            let anchor_id: String = match conn.query_row(
                "SELECT id FROM anchors WHERE keyword = ? AND category = ?",
                params![kw, category],
                |r| r.get::<_, String>(0),
            ) {
                Ok(id) => id,
                Err(_) => {
                    let id = uuid::Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO anchors (id, keyword, category, created_at, updated_at) VALUES (?,?,?,?,?)",
                        params![id, kw, category, now, now],
                    ).map_err(|e| e.to_string())?;
                    id
                }
            };
            conn.execute(
                "INSERT OR IGNORE INTO binding_anchors (binding_id, anchor_id) VALUES (?, ?)",
                params![binding_id, anchor_id],
            ).map_err(|e| e.to_string())?;
            anchor_refs.push(AnchorRef { id: anchor_id, keyword: kw.to_string(), category: category.clone() });
        }

        Ok(BindingRow {
            id: binding_id,
            card_id: card_id.to_string(),
            start_pos,
            end_pos,
            selected_text: selected_text.to_string(),
            user_speech: user_speech.to_string(),
            created_at: now,
            anchors: anchor_refs,
        })
    }

    pub async fn list_bindings_for_card(&self, card_id: &str) -> Result<Vec<BindingRow>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, card_id, start_pos, end_pos, selected_text, user_speech, created_at \
             FROM context_anchor_bindings WHERE card_id = ? ORDER BY start_pos"
        ).map_err(|e| e.to_string())?;
        let base: Vec<(String, String, i64, i64, String, String, String)> = stmt
            .query_map([card_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        drop(stmt);

        let mut astmt = conn.prepare(
            "SELECT a.id, a.keyword, a.category FROM binding_anchors ba \
             JOIN anchors a ON a.id = ba.anchor_id WHERE ba.binding_id = ?"
        ).map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for (id, card_id, start_pos, end_pos, selected_text, user_speech, created_at) in base {
            let anchors: Vec<AnchorRef> = astmt
                .query_map([&id], |r| {
                    Ok(AnchorRef { id: r.get(0)?, keyword: r.get(1)?, category: r.get(2)? })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|x| x.ok())
                .collect();
            out.push(BindingRow { id, card_id, start_pos, end_pos, selected_text, user_speech, created_at, anchors });
        }
        Ok(out)
    }

    pub async fn delete_anchor_binding(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM binding_anchors WHERE binding_id = ?", [id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM context_anchor_bindings WHERE id = ?", [id]).map_err(|e| e.to_string())?;
        // 孤儿回收（与 delete_context_card 同语义）：失去全部绑定的锚点连带向量/簇名缓存一起清，
        // 否则它会永远留在锚点域地图上
        conn.execute(
            "DELETE FROM anchor_embeddings WHERE anchor_id IN
             (SELECT id FROM anchors WHERE id NOT IN (SELECT anchor_id FROM binding_anchors))",
            [],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM anchors WHERE id NOT IN (SELECT anchor_id FROM binding_anchors)",
            [],
        ).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM anchor_cluster_names", []).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 编辑想法卡正文（可选连带语境来源标签）；整卡绑定（start_pos=0）的 selected_text/user_speech/end_pos 同步更新
    pub async fn update_context_card_text(&self, id: &str, text: &str, source_label: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let changed = match source_label {
            Some(label) => conn.execute(
                "UPDATE context_cards SET text = ?, source_label = ? WHERE id = ?",
                params![text, label, id],
            ).map_err(|e| e.to_string())?,
            None => conn.execute(
                "UPDATE context_cards SET text = ? WHERE id = ?",
                params![text, id],
            ).map_err(|e| e.to_string())?,
        };
        if changed == 0 {
            return Err("卡片不存在".to_string());
        }
        // end_pos 与前端 JS 的 string.length 同语义（UTF-16 码元数）
        let utf16_len = text.encode_utf16().count() as i64;
        conn.execute(
            "UPDATE context_anchor_bindings
             SET selected_text = ?, user_speech = ?, end_pos = ?
             WHERE card_id = ? AND start_pos = 0",
            params![text, text, utf16_len, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 编辑锚点句 / 类别（至少传一个）。
    /// keyword 变了 → 删该锚点向量（下次打开地图重嵌入）；两种变更都清簇名缓存（重新起名/分区）
    pub async fn update_anchor(&self, id: &str, keyword: Option<&str>, category: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let uniq_err = |e: rusqlite::Error| {
            if e.to_string().contains("UNIQUE") {
                "同类下已存在相同锚点句".to_string()
            } else {
                e.to_string()
            }
        };
        let changed = match (keyword, category) {
            (Some(k), Some(c)) => conn.execute(
                "UPDATE anchors SET keyword = ?, category = ?, updated_at = datetime('now') WHERE id = ?",
                params![k, c, id],
            ).map_err(uniq_err)?,
            (Some(k), None) => conn.execute(
                "UPDATE anchors SET keyword = ?, updated_at = datetime('now') WHERE id = ?",
                params![k, id],
            ).map_err(uniq_err)?,
            (None, Some(c)) => conn.execute(
                "UPDATE anchors SET category = ?, updated_at = datetime('now') WHERE id = ?",
                params![c, id],
            ).map_err(uniq_err)?,
            (None, None) => return Err("没有要更新的字段".to_string()),
        };
        if changed == 0 {
            return Err("锚点不存在".to_string());
        }
        if keyword.is_some() {
            conn.execute("DELETE FROM anchor_embeddings WHERE anchor_id = ?", [id]).map_err(|e| e.to_string())?;
        }
        conn.execute("DELETE FROM anchor_cluster_names", []).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 往已有绑定上追加一条锚点（同名同类复用全局锚点）；成员集变了 → 清簇名缓存
    pub async fn add_anchor_to_binding(&self, binding_id: &str, keyword: &str, category: &str) -> Result<AnchorRef, String> {
        let conn = self.conn.lock().await;
        let exists: bool = conn
            .query_row("SELECT 1 FROM context_anchor_bindings WHERE id = ?", [binding_id], |_| Ok(true))
            .unwrap_or(false);
        if !exists {
            return Err("绑定不存在".to_string());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let anchor_id: String = match conn.query_row(
            "SELECT id FROM anchors WHERE keyword = ? AND category = ?",
            params![keyword, category],
            |r| r.get::<_, String>(0),
        ) {
            Ok(id) => id,
            Err(_) => {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO anchors (id, keyword, category, created_at, updated_at) VALUES (?,?,?,?,?)",
                    params![id, keyword, category, now, now],
                ).map_err(|e| e.to_string())?;
                id
            }
        };
        conn.execute(
            "INSERT OR IGNORE INTO binding_anchors (binding_id, anchor_id) VALUES (?, ?)",
            params![binding_id, anchor_id],
        ).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM anchor_cluster_names", []).map_err(|e| e.to_string())?;
        Ok(AnchorRef { id: anchor_id, keyword: keyword.to_string(), category: category.to_string() })
    }

    // ── Anchor Embeddings（锚点域地图：语义向量 + 簇名缓存）──

    /// 全量读取已存的锚点向量（锚点量级小，前端一次拉全）
    pub async fn list_anchor_embeddings(&self) -> Result<Vec<AnchorEmbeddingRow>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT anchor_id, model, dims, vector FROM anchor_embeddings"
        ).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(AnchorEmbeddingRow {
                    anchor_id: r.get(0)?,
                    model: r.get(1)?,
                    dims: r.get(2)?,
                    vector: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        Ok(rows)
    }

    pub async fn upsert_anchor_embedding(&self, anchor_id: &str, model: &str, dims: i64, vector_json: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO anchor_embeddings (anchor_id, model, dims, vector, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(anchor_id) DO UPDATE SET
               model=excluded.model, dims=excluded.dims, vector=excluded.vector, updated_at=excluded.updated_at",
            params![anchor_id, model, dims, vector_json],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn list_cluster_names(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT member_hash, name FROM anchor_cluster_names"
        ).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        Ok(rows)
    }

    pub async fn upsert_cluster_name(&self, member_hash: &str, name: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO anchor_cluster_names (member_hash, name, created_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(member_hash) DO UPDATE SET name=excluded.name",
            params![member_hash, name],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Presence Spans ──

    pub async fn get_presence_spans_by_date(&self, date: &str) -> Result<Vec<PresenceSpan>, String> {
        let conn = self.conn.lock().await;
        let day_start = format!("{} 00:00:00", date);
        let mut stmt = conn.prepare(
            "SELECT id, start_time, end_time, state
             FROM presence_spans
             WHERE start_time < datetime(?1, '+1 day')
               AND COALESCE(end_time, datetime('now', 'localtime')) > ?1
             ORDER BY start_time"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&day_start], |row| PresenceSpan::from_row(row))
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

    #[cfg_attr(not(windows), allow(dead_code))]
    pub async fn record_perception_heartbeat(&self, heartbeat: PerceptionHeartbeat) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let data_json = serde_json::to_string(&heartbeat.data)
            .map_err(|e| format!("序列化感知事件失败: {}", e))?;
        let data_hash = stable_hash_hex(&data_json);
        let now = &heartbeat.observed_at;

        let upsert_bucket_sql = format!(r#"INSERT INTO {buckets_table}
               (id, kind, event_type, source, hostname, created_at, updated_at)
               VALUES (?, ?, ?, ?, '', ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   kind=excluded.kind,
                   event_type=excluded.event_type,
                   source=excluded.source,
                   updated_at=excluded.updated_at"#,
            buckets_table = PERCEPTION_BUCKETS_TABLE,
        );
        conn.execute(
            &upsert_bucket_sql,
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
                let upsert_app_sql = format!(r#"INSERT INTO {app_table}
                       (app_key, display_name, exe_path, color, first_seen, last_seen)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(app_key) DO UPDATE SET
                           display_name=excluded.display_name,
                           exe_path=COALESCE(excluded.exe_path, {app_table}.exe_path),
                           color={app_table}.color,
                           last_seen=excluded.last_seen"#,
                    app_table = APP_CATALOG_TABLE,
                );
                conn.execute(
                    &upsert_app_sql,
                    params![app, app, exe_path, &color, now, now],
                ).map_err(|e| e.to_string())?;
            }
        }

        let select_last_sql = format!(r#"SELECT id, end_at, data_json, data_hash
               FROM {events_table}
               WHERE bucket_id = ?
               ORDER BY end_at DESC, id DESC
               LIMIT 1"#,
            events_table = PERCEPTION_EVENTS_TABLE,
        );
        let last = conn.query_row(
            &select_last_sql,
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
                let update_event_sql = format!(
                    "UPDATE {events_table} SET end_at = ?, updated_at = datetime('now') WHERE id = ?",
                    events_table = PERCEPTION_EVENTS_TABLE,
                );
                conn.execute(
                    &update_event_sql,
                    params![now, id],
                ).map_err(|e| e.to_string())?;
                return Ok(());
            }
        }

        let insert_event_sql = format!(r#"INSERT INTO {events_table}
               (bucket_id, start_at, end_at, data_json, data_hash)
               VALUES (?, ?, ?, ?, ?)"#,
            events_table = PERCEPTION_EVENTS_TABLE,
        );
        conn.execute(
            &insert_event_sql,
            params![&heartbeat.bucket_id, now, now, data_json, data_hash],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn get_perception_spans_for_date(&self, date: &str) -> Result<Vec<PerceptionSpan>, String> {
        let day_start = format!("{} 00:00:00", date);
        let day_end = format!("{} 00:00:00", next_day_str(date)?);
        let conn = self.conn.lock().await;

        // 一次性把 app → 主色 拉成内存 map（来自当前平台 app_catalog，已被图标主色覆盖）
        let app_colors: std::collections::HashMap<String, String> = {
            let app_colors_sql = format!(
                "SELECT app_key, color FROM {app_table}",
                app_table = APP_CATALOG_TABLE,
            );
            let mut stmt = conn.prepare(&app_colors_sql)
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let spans_sql = format!(r#"SELECT e.id, b.kind, e.start_at, e.end_at, e.data_json
               FROM {events_table} e
               JOIN {buckets_table} b ON b.id = e.bucket_id
               WHERE e.start_at < ?1
                 AND e.end_at >= ?2
               ORDER BY e.start_at ASC, e.id ASC"#,
            events_table = PERCEPTION_EVENTS_TABLE,
            buckets_table = PERCEPTION_BUCKETS_TABLE,
        );
        let mut stmt = conn.prepare(&spans_sql).map_err(|e| e.to_string())?;

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
                    // 优先用当前平台 app_catalog 里写入的主色（=图标主色），找不到才退回 hash
                    let color = app_colors.get(&app).cloned().unwrap_or_else(|| color_for_app(&app));
                    spans.push(PerceptionSpan {
                        id,
                        track: "apps".to_string(),
                        start_at: clipped_start,
                        end_at: clipped_end,
                        title: if title.is_empty() { app.clone() } else { title },
                        group_name: Some(app.clone()),
                        color: Some(color),
                        platform: Some(PERCEPTION_PLATFORM.to_string()),
                    });
                }
                "status" => {
                    let status = data.get("status").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                    spans.push(PerceptionSpan {
                        id,
                        track: "status".to_string(),
                        start_at: clipped_start,
                        end_at: clipped_end,
                        title: status.clone(),
                        group_name: Some(status.clone()),
                        color: Some(color_for_status(&status)),
                        platform: Some(PERCEPTION_PLATFORM.to_string()),
                    });
                }
                "tag" => {
                    let title = data.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let group = data.get("group_name").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let color = data.get("color").and_then(|v| v.as_str()).map(|s| s.to_string());
                    spans.push(PerceptionSpan {
                        id,
                        track: "tags".to_string(),
                        start_at: clipped_start,
                        end_at: clipped_end,
                        title,
                        group_name: group,
                        color,
                        platform: None,
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
        let sql = format!(
            "SELECT icon_png FROM {app_table} WHERE app_key = ? LIMIT 1",
            app_table = APP_CATALOG_TABLE,
        );
        match conn.query_row(
            &sql,
            params![app_name],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        ) {
            Ok(bytes) => Ok(bytes),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 仅取 app_key 列表（用于 icon_cache 启动时回填）
    #[cfg_attr(not(windows), allow(dead_code))]
    pub async fn list_app_keys_with_icon(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT app_key FROM {app_table} WHERE icon_png IS NOT NULL",
            app_table = APP_CATALOG_TABLE,
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 拉出当前平台 app_catalog 里所有有图标的条目（启动时刷主色用）
    #[cfg_attr(not(windows), allow(dead_code))]
    pub async fn list_app_catalog_icons(&self) -> Result<Vec<(String, Vec<u8>)>, String> {
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT app_key, icon_png FROM {app_table} WHERE icon_png IS NOT NULL",
            app_table = APP_CATALOG_TABLE,
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 仅更新某个 app 的颜色字段
    #[cfg_attr(not(windows), allow(dead_code))]
    pub async fn set_app_catalog_color(&self, app_name: &str, color: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let sql = format!(
            "UPDATE {app_table} SET color = ? WHERE app_key = ?",
            app_table = APP_CATALOG_TABLE,
        );
        conn.execute(
            &sql,
            params![color, app_name],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg_attr(not(windows), allow(dead_code))]
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
        let sql = format!(r#"INSERT INTO {app_table}
               (app_key, display_name, exe_path, color, icon_png, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(app_key) DO UPDATE SET
                   display_name=excluded.display_name,
                   exe_path=COALESCE(excluded.exe_path, {app_table}.exe_path),
                   color=excluded.color,
                   icon_png=excluded.icon_png,
                   last_seen=excluded.last_seen"#,
            app_table = APP_CATALOG_TABLE,
        );
        conn.execute(
            &sql,
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
                      visual_transcribed_at, audio_transcribed_at,
                      is_favorite
               FROM bili_video_assets WHERE bvid = ? ORDER BY created_at DESC"#,
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([bvid], BiliVideoAsset::from_row)
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 删除某 bvid 的全部资产记录 + 关联转录历史。
    /// `bili_transcript_runs.asset_id` 有 `ON DELETE CASCADE`（连接已开 foreign_keys），
    /// 这里仍显式按 bvid 先清一遍 runs 作为兜底（防遗留 / FK 未生效）。
    pub async fn delete_bili_assets_by_bvid(&self, bvid: &str) -> Result<usize, String> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM bili_transcript_runs WHERE bvid = ?", [bvid])
            .map_err(|e| e.to_string())?;
        let n = conn
            .execute("DELETE FROM bili_video_assets WHERE bvid = ?", [bvid])
            .map_err(|e| e.to_string())?;
        // 删除下载/转录 → 同时清除该视频收藏（收藏统一在历史表）
        let _ = conn.execute("UPDATE bili_history SET is_favorite = 0 WHERE bvid = ?", [bvid]);
        Ok(n)
    }

    /// 设置某视频收藏态（收藏存历史表，所有看过的视频都可收藏，不限是否下载）
    pub async fn set_bili_favorite(&self, bvid: &str, favorite: bool) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE bili_history SET is_favorite = ? WHERE bvid = ?",
            params![if favorite { 1 } else { 0 }, bvid],
        ).map_err(|e| e.to_string())?;
        Ok(())
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
                      visual_transcribed_at, audio_transcribed_at,
                      is_favorite
               FROM bili_video_assets ORDER BY created_at DESC LIMIT ?"#,
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([limit], BiliVideoAsset::from_row)
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

fn migrate_legacy_perception_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        INSERT OR IGNORE INTO perception_buckets_windows
            (id, kind, event_type, source, hostname, created_at, updated_at)
        SELECT id, kind, event_type, source, hostname, created_at, updated_at
        FROM perception_buckets;

        INSERT OR IGNORE INTO perception_events_windows
            (id, bucket_id, start_at, end_at, data_json, data_hash, created_at, updated_at)
        SELECT id, bucket_id, start_at, end_at, data_json, data_hash, created_at, updated_at
        FROM perception_events
        WHERE bucket_id IN (SELECT id FROM perception_buckets_windows);

        INSERT OR IGNORE INTO app_catalog_windows
            (app_key, display_name, exe_path, color, icon_png, first_seen, last_seen)
        SELECT app_key, display_name, exe_path, color, icon_png, first_seen, last_seen
        FROM app_catalog;
    "#).map_err(|e| format!("迁移旧感知表失败: {}", e))?;
    Ok(())
}

fn local_now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<(), String> {
    let columns = table_columns(conn, table)?;
    if columns.iter().any(|c| c == column) {
        return Ok(());
    }
    conn.execute_batch(&format!("ALTER TABLE {} ADD COLUMN {}", table, definition))
        .map_err(|e| format!("为 {} 添加列 {} 失败: {}", table, column, e))
}

fn backfill_sync_ids(conn: &Connection, table: &str) -> Result<(), String> {
    let sql = format!("SELECT rowid FROM {} WHERE sync_id IS NULL OR sync_id = ''", table);
    let rowids = {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect::<Vec<_>>()
    };
    let update = format!("UPDATE {} SET sync_id = ? WHERE rowid = ?", table);
    for rowid in rowids {
        conn.execute(&update, params![Uuid::new_v4().to_string(), rowid])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_sync_metadata(conn: &Connection) -> Result<(), String> {
    for table in ["activity_categories", "activity_tags", "activity_blocks", "plan_nodes", "planned_blocks"] {
        ensure_column(conn, table, "sync_id", "sync_id TEXT")?;
        ensure_column(conn, table, "deleted_at", "deleted_at TEXT")?;
    }
    for table in ["activity_categories", "activity_tags", "activity_blocks", "planned_blocks"] {
        ensure_column(conn, table, "updated_at", "updated_at TEXT")?;
    }

    conn.execute("UPDATE activity_categories SET updated_at = COALESCE(updated_at, last_used_at, created_at, datetime('now','localtime')) WHERE updated_at IS NULL", [])
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE activity_tags SET updated_at = COALESCE(updated_at, last_used_at, created_at, datetime('now','localtime')) WHERE updated_at IS NULL", [])
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE activity_blocks SET updated_at = COALESCE(updated_at, created_at, datetime('now','localtime')) WHERE updated_at IS NULL", [])
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE planned_blocks SET updated_at = COALESCE(updated_at, created_at, datetime('now','localtime')) WHERE updated_at IS NULL", [])
        .map_err(|e| e.to_string())?;

    for table in ["activity_categories", "activity_tags", "activity_blocks", "plan_nodes", "planned_blocks"] {
        backfill_sync_ids(conn, table)?;
        conn.execute_batch(&format!(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_{}_sync_id ON {}(sync_id);",
            table, table,
        )).map_err(|e| e.to_string())?;
        conn.execute_batch(&format!(
            "CREATE INDEX IF NOT EXISTS idx_{}_sync_updated ON {}(updated_at);",
            table, table,
        )).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn get_or_create_device_id(conn: &Connection) -> Result<String, String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );"
    ).map_err(|e| e.to_string())?;
    let existing: Option<String> = conn.query_row(
        "SELECT value FROM sync_meta WHERE key = 'device_id'",
        [],
        |row| row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO sync_meta (key, value, updated_at) VALUES ('device_id', ?, ?)",
        params![&id, local_now_string()],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

/// 同步配对码哈希种子。
pub fn sync_pair_code(device_id: &str) -> String {
    let hash = stable_hash_hex(&format!("solevup:sync:v1:{device_id}"));
    format!("{}-{}", &hash[0..4], &hash[4..8]).to_uppercase()
}

// LocalSend 风格"形容词 + 水果"萌系别名词库（中文，与 LocalSend zh-CN 同源）
const ALIAS_ADJECTIVES: &[&str] = &[
    "迷人", "美丽", "巨大", "明亮", "干净", "聪明", "帅气", "可爱", "狡猾", "坚定",
    "有活力", "高效", "极好", "快速", "不错", "新鲜", "华丽", "伟大", "英俊", "炽热",
    "善良", "诚实", "神秘", "整洁", "开心", "耐心", "漂亮", "强大", "富有", "秘密",
    "稳固", "特别", "战略", "智慧",
];
const ALIAS_FRUITS: &[&str] = &[
    "苹果", "鳄梨", "香蕉", "黑莓", "蓝莓", "西兰花", "胡萝卜", "樱桃", "椰子", "葡萄",
    "柠檬", "莴苣", "芒果", "甜瓜", "蘑菇", "洋葱", "橙子", "木瓜", "桃子", "梨",
    "菠萝", "土豆", "南瓜", "覆盆子", "草莓", "番茄",
];

pub fn generate_alias(device_id: &str) -> String {
    // 跟 sync_pair_code 一致，用 Solevup 的稳定种子生成设备别名。
    let hex = stable_hash_hex(&format!("solevup:alias:v1:{device_id}"));
    let bytes = hex.as_bytes();
    let parse_u32 = |slice: &[u8]| -> u32 {
        std::str::from_utf8(slice).ok()
            .and_then(|s| u32::from_str_radix(s, 16).ok())
            .unwrap_or(0)
    };
    let adj_idx = parse_u32(&bytes[0..8]) as usize % ALIAS_ADJECTIVES.len();
    let fruit_idx = parse_u32(&bytes[8..16]) as usize % ALIAS_FRUITS.len();
    format!("{}的{}", ALIAS_ADJECTIVES[adj_idx], ALIAS_FRUITS[fruit_idx])
}

fn should_apply_sync_row(conn: &Connection, table: &str, sync_id: &str, incoming_updated_at: &str) -> Result<bool, String> {
    let sql = format!("SELECT updated_at FROM {} WHERE sync_id = ?", table);
    let local: Option<String> = conn.query_row(&sql, params![sync_id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(local.as_deref().map(|ts| incoming_updated_at > ts).unwrap_or(true))
}

fn should_apply_existing_id(conn: &Connection, table: &str, id: i64, incoming_updated_at: &str) -> Result<bool, String> {
    let sql = format!("SELECT updated_at FROM {} WHERE id = ?", table);
    let local: Option<String> = conn.query_row(&sql, params![id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(local.as_deref().map(|ts| incoming_updated_at > ts).unwrap_or(true))
}

fn should_apply_slot_row(
    conn: &Connection,
    table: &str,
    date: &str,
    minute: i32,
    incoming_sync_id: &str,
    incoming_updated_at: &str,
) -> Result<bool, String> {
    let sql = format!("SELECT sync_id, updated_at FROM {} WHERE date = ? AND minute = ?", table);
    let local: Option<(String, String)> = conn.query_row(&sql, params![date, minute], |row| {
        Ok((row.get(0)?, row.get(1)?))
    }).optional().map_err(|e| e.to_string())?;

    let Some((local_sync_id, local_updated_at)) = local else {
        return Ok(true);
    };
    if local_sync_id == incoming_sync_id {
        return Ok(true);
    }
    Ok(incoming_updated_at > local_updated_at.as_str())
}

fn lookup_id_by_sync(conn: &Connection, table: &str, sync_id: &str) -> Result<Option<i64>, String> {
    let sql = format!("SELECT id FROM {} WHERE sync_id = ?", table);
    conn.query_row(&sql, params![sync_id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

// ── Cascade-aware merge helpers (AUDIT-011) ──
// categories/tags 段 UPDATE sync_id 时，若 incoming.sync_id 被旁系行（不同业务键）
// 占用，不能裸 DELETE 旁系 —— FK ON DELETE CASCADE 会静默删它挂的 activity_tags
// / activity_blocks / plan_nodes / planned_blocks 等本地未同步子数据。
// 把旁系下的子项 FK 迁/合并到 keep_id（业务键匹配的权威行），再删空旁系。

/// 旁系 category 下的 tags 迁到 keep_id；同 (cat, full_path) 撞 UNIQUE 时递归合并 tag。
fn merge_category_conflict(conn: &Connection, sync_id: &str, keep_id: i64) -> Result<(), String> {
    let side_id: Option<i64> = conn.query_row(
        "SELECT id FROM activity_categories WHERE sync_id = ? AND id != ?",
        params![sync_id, keep_id],
        |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?;
    let Some(side_id) = side_id else { return Ok(()) };

    let side_tags: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, full_path FROM activity_tags WHERE category_id = ?",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![side_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows { out.push(row.map_err(|e| e.to_string())?); }
        out
    };
    for (side_tag_id, full_path) in side_tags {
        let target_tag_id: Option<i64> = conn.query_row(
            "SELECT id FROM activity_tags WHERE category_id = ? AND full_path = ?",
            params![keep_id, &full_path],
            |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if let Some(target_tag_id) = target_tag_id {
            // 目标 category 下已有同 path tag，合并这两个 tag 的子项
            merge_tag_children(conn, side_tag_id, target_tag_id)?;
            conn.execute("DELETE FROM activity_tags WHERE id = ?", params![side_tag_id])
                .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE activity_tags SET category_id = ? WHERE id = ?",
                params![keep_id, side_tag_id],
            ).map_err(|e| e.to_string())?;
        }
    }
    // 旁系下已无 tag，cascade 无子可吞，DELETE 安全
    conn.execute("DELETE FROM activity_categories WHERE id = ?", params![side_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 旁系 tag 的子 blocks/plan_nodes 迁到 keep_id 后删空旁系。
fn merge_tag_conflict(conn: &Connection, sync_id: &str, keep_id: i64) -> Result<(), String> {
    let side_id: Option<i64> = conn.query_row(
        "SELECT id FROM activity_tags WHERE sync_id = ? AND id != ?",
        params![sync_id, keep_id],
        |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?;
    let Some(side_id) = side_id else { return Ok(()) };
    merge_tag_children(conn, side_id, keep_id)?;
    conn.execute("DELETE FROM activity_tags WHERE id = ?", params![side_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 把 side_tag_id 下的 blocks + plan_nodes 重新挂到 keep_tag_id。
/// activity_blocks 同 (date, minute) 槽位冲突时优先保留 keep_tag_id 那份（业务权威）。
fn merge_tag_children(conn: &Connection, side_tag_id: i64, keep_tag_id: i64) -> Result<(), String> {
    // 先丢掉旁系跟 keep 同 (date,minute) 的 blocks，否则 UPDATE 会撞 UNIQUE(date,minute)
    conn.execute(
        "DELETE FROM activity_blocks WHERE tag_id = ? AND (date, minute) IN
           (SELECT date, minute FROM activity_blocks WHERE tag_id = ?)",
        params![side_tag_id, keep_tag_id],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE activity_blocks SET tag_id = ? WHERE tag_id = ?",
        params![keep_tag_id, side_tag_id],
    ).map_err(|e| e.to_string())?;
    // plan_nodes 没跟 project_tag_id 复合 UNIQUE，直接迁
    conn.execute(
        "UPDATE plan_nodes SET project_tag_id = ? WHERE project_tag_id = ?",
        params![keep_tag_id, side_tag_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn stable_hash_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

#[cfg_attr(not(windows), allow(dead_code))]
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
            // 容错读：旧查询若未 SELECT 该列也不 panic，回退 false
            is_favorite:      row.get(21).unwrap_or(false),
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
        let mut stmt = conn
            .prepare(
                r#"SELECT id, asset_id, bvid, download_path, kind, text,
                          model_id, prompt_type, source, created_at
                   FROM bili_transcript_runs
                   WHERE download_path = ?
                   ORDER BY created_at DESC, rowid DESC
                   LIMIT 80"#,
            )
            .map_err(|e| format!("准备查询转录历史失败: {}", e))?;
        let history = stmt
            .query_map(params![download_path], |r| {
                Ok(BiliTranscriptRun {
                    id: r.get(0)?,
                    asset_id: r.get(1)?,
                    bvid: r.get(2)?,
                    download_path: r.get(3)?,
                    kind: r.get(4)?,
                    text: r.get(5)?,
                    model_id: r.get(6)?,
                    prompt_type: r.get(7)?,
                    source: r.get(8)?,
                    created_at: r.get(9)?,
                })
            })
            .map_err(|e| format!("查询转录历史失败: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取转录历史失败: {}", e))?;
        Ok(match row {
            Some((v, a, c, va, aa, ca)) => BiliTranscriptCache {
                visual: v, audio: a, combined: c,
                visual_at: va, audio_at: aa, combined_at: ca,
                history,
            },
            None => BiliTranscriptCache {
                visual: None, audio: None, combined: None,
                visual_at: None, audio_at: None, combined_at: None,
                history,
            },
        })
    }

    /// 按 download_path 写入指定 kind 的转录文本（"visual" / "audio" / "combined"）
    pub async fn update_bili_transcript_by_path(
        &self,
        download_path: &str,
        kind: &str,
        text: &str,
        model_id: Option<String>,
        prompt_type: Option<String>,
        source: Option<String>,
        save_history: bool,
    ) -> Result<Option<BiliTranscriptRun>, String> {
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
        // 转录完成 → 该视频在历史表标记收藏（收藏统一在 bili_history，覆盖所有视频）
        let _ = conn.execute(
            "UPDATE bili_history SET is_favorite = 1 WHERE bvid = \
             (SELECT bvid FROM bili_video_assets WHERE download_path = ? AND download_status = 'done' LIMIT 1)",
            params![download_path],
        );
        if !save_history || text.trim().is_empty() {
            return Ok(None);
        }

        let asset: (String, String, String) = conn
            .query_row(
                r#"SELECT id, bvid, download_path
                   FROM bili_video_assets
                   WHERE download_path = ? AND download_status = 'done'
                   ORDER BY updated_at DESC LIMIT 1"#,
                params![download_path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| format!("读取转录资产失败: {}", e))?;
        let run = BiliTranscriptRun {
            id: Uuid::new_v4().to_string(),
            asset_id: asset.0,
            bvid: asset.1,
            download_path: asset.2,
            kind: kind.to_string(),
            text: text.to_string(),
            model_id,
            prompt_type,
            source: source.unwrap_or_else(|| "manual".to_string()),
            created_at: now,
        };
        conn.execute(
            r#"INSERT INTO bili_transcript_runs (
                   id, asset_id, bvid, download_path, kind, text,
                   model_id, prompt_type, source, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            params![
                &run.id,
                &run.asset_id,
                &run.bvid,
                &run.download_path,
                &run.kind,
                &run.text,
                run.model_id.as_deref(),
                run.prompt_type.as_deref(),
                &run.source,
                &run.created_at,
            ],
        )
        .map_err(|e| format!("写入转录历史失败: {}", e))?;
        Ok(Some(run))
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

// ── Context Feed Item（语境卡流条目）──
// 想法卡与已转录 B 站视频卡的统一展示模型。

#[derive(serde::Serialize, Clone)]
pub struct ContextFeedItem {
    pub id: String,
    pub kind: String,                  // 'thought' | 'bili_transcript'
    pub text: String,                  // thought=想法全文；bili=转录摘要（截断）
    pub title: Option<String>,         // bili=视频标题
    pub cover_url: Option<String>,     // bili=封面
    pub bvid: Option<String>,
    pub ref_path: Option<String>,      // bili download_path，前端展开转录全文用
    pub source_label: Option<String>,  // thought 的语境标签
    pub source_card_id: Option<String>, // thought 的来源语境卡 id（语境标签点击跳转用）
    pub created_at: String,
    // 断链标志（仅 thought）：source_card_id 指向了视频、自己也有锚点句，
    // 但视频侧零回填（没有 card_id=该视频 且 source_card_id=本卡 的绑定）→ 锚点没传到视频。
    pub link_broken: bool,
}

// ── 锚点（语境片段 ↔ 原话 ↔ 关键词）──

#[derive(serde::Serialize, Clone)]
pub struct AnchorRef {
    pub id: String,
    pub keyword: String,
    pub category: String,   // 'motive' | 'view' | 'practice'
}

#[derive(serde::Serialize, Clone)]
pub struct BindingRow {
    pub id: String,
    pub card_id: String,
    pub start_pos: i64,
    pub end_pos: i64,
    pub selected_text: String,
    pub user_speech: String,   // 你的原话，不 AI 总结
    pub created_at: String,
    pub anchors: Vec<AnchorRef>,
}

#[derive(serde::Serialize, Clone)]
pub struct AnchorEmbeddingRow {
    pub anchor_id: String,
    pub model: String,
    pub dims: i64,
    pub vector: String,  // JSON 数组文本，前端 parse
}

/// 把 ASR 的 JSONL 转录（每行 {"start","end","text"}）抽成纯文本；非 JSON 行原样保留。
fn transcript_plain_text(raw: &str) -> String {
    let mut out = String::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
                out.push_str(t);
                continue;
            }
        }
        out.push_str(line);
    }
    out
}

// ══════════════════════════════════════════════
// 模型审计：registry / pricing / bindings / call_log
// ══════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelDef {
    pub id: String,
    pub category: String,                 // 'text' | 'omni' | 'realtime' | 'embedding'
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
        // ── Qwen3.7 文本（2026-05 上线；价目 2026-06-11 从控制台模型广场详情页人工核对，存原价）──
        // max 无阶梯；06-08 快照较 05-20 增加视觉模态理解（价目相同）
        (&["qwen3.7-max", "qwen3.7-max-2026-06-08", "qwen3.7-max-2026-05-20", "qwen3.7-max-2026-05-17"], "text", "Qwen3.7 Max", &["text"], 1_048_576, &[
            (0, None, Some(12.0), None, None, None, Some(36.0), None),
        ]),
        (&["qwen3.7-max-preview"], "text", "Qwen3.7 Max Preview", &["text"], 1_048_576, &[
            (0, None, Some(12.0), None, None, None, Some(36.0), None),
        ]),
        // plus 阶梯两档：≤256K / 256K~1M
        (&["qwen3.7-plus", "qwen3.7-plus-2026-05-26"], "text", "Qwen3.7 Plus", &["text","image","video"], 1_048_576, &[
            (0,       Some(262_144),   Some(2.0), Some(2.0), Some(2.0), None, Some(8.0),  None),
            (262_144, Some(1_048_576), Some(6.0), Some(6.0), Some(6.0), None, Some(24.0), None),
        ]),

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

        // ── 向量嵌入 / 重排序（无输出 token 计费；context_window 存单次最大输入）──
        (&["text-embedding-v4"], "embedding", "Text Embedding V4", &["text"], 8_192, &[
            (0, None, Some(0.5), None, None, None, None, None),
        ]),
        (&["text-embedding-v3"], "embedding", "Text Embedding V3", &["text"], 8_192, &[
            (0, None, Some(0.5), None, None, None, None, None),
        ]),
        // 视觉向量/重排序（价目 2026-06-11 控制台核对；文本/图片输入分价，存 price_input_text/image）
        (&["qwen3-vl-embedding"], "embedding", "Qwen3 VL Embedding", &["text","image"], 32_768, &[
            (0, None, Some(0.7), Some(1.8), None, None, None, None),
        ]),
        (&["qwen3-vl-rerank"], "embedding", "Qwen3 VL Rerank", &["text","image"], 122_880, &[
            (0, None, Some(0.7), Some(1.8), None, None, None, None),
        ]),
        (&["tongyi-embedding-vision-plus", "tongyi-embedding-vision-plus-2026-03-06"], "embedding", "通义 Embedding Vision Plus", &["text","image"], 0, &[
            (0, None, Some(0.5), Some(0.5), None, None, None, None),
        ]),
        (&["tongyi-embedding-vision-flash", "tongyi-embedding-vision-flash-2026-03-06"], "embedding", "通义 Embedding Vision Flash", &["text","image"], 0, &[
            (0, None, Some(0.15), Some(0.15), None, None, None, None),
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

    // 个别模型的补充说明（折扣 / 限流 / 免费额度等计费特例；价目本体在 model_pricing）
    let notes: &[(&str, &str)] = &[
        ("qwen3.7-plus", "阶梯计费(≤256K/256K~1M)；当前限时8折、Batch Chat 5折，库内存原价；缓存命中 0.4/1.2 元/百万；免费额度至 2026-09-01"),
        ("qwen3.7-max", "无阶梯；当前限时5折(实付6/18)，库内存原价；缓存命中 2.4、显式缓存创建 15/命中 1.2"),
        ("qwen3.7-max-preview", "预览版：无折扣；限流低(RPM 60/TPM 50万)；免费额度至 2026-08-24"),
        ("text-embedding-v4", "Qwen3-Embedding 系列；Batch 调用半价 0.25 元/百万；维度 64~2048 可选；单次最大输入 8192 token；无免费额度"),
        ("text-embedding-v3", "Batch 调用半价 0.25 元/百万；维度 64~1024 可选；单次最大输入 8192 token；无免费额度"),
        ("qwen3-vl-embedding", "视觉-文本向量；最大输入 32K；无免费额度"),
        ("qwen3-vl-rerank", "视觉-文本重排序（输出相关度分数，非向量）；最大输入 120K；无免费额度"),
        ("tongyi-embedding-vision-plus", "免费额度挂在 -2026-03-06 快照 id 上（100 万，至 2026-07-23），基础别名无额度"),
        ("tongyi-embedding-vision-flash", "免费额度挂在 -2026-03-06 快照 id 上（100 万，至 2026-06-19），基础别名无额度"),
    ];
    for (id, note) in notes {
        conn.execute(
            "UPDATE model_registry SET notes = ? WHERE id = ?",
            params![note, id],
        ).map_err(|e| e.to_string())?;
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
        .unwrap_or_else(|| "qwen3.6-flash".to_string());
    let bili_audio_default = existing("bili_audio_transcribe")
        .unwrap_or_else(|| "qwen3.5-omni-flash".to_string());

    let seeds: Vec<(&str, String)> = vec![
        ("fairy_chat", "qwen3.6-flash".to_string()),
        ("fairy_omni_chat", "qwen3.5-omni-flash-realtime".to_string()),
        ("session_title", "qwen3.6-flash".to_string()),
        ("bili_omni_transcribe", bili_omni_default),
        ("bili_visual_transcribe", bili_visual_default),
        ("bili_audio_transcribe", bili_audio_default),
        // 洪流域：锚点提取/沉淀/锚点域地图
        ("context_anchor", "qwen3.6-flash".to_string()),
        ("anchor_extract", "qwen3.6-flash".to_string()),
        ("thought_distill", "qwen3.6-flash".to_string()),
        ("anchor_cluster_name", "qwen3.6-flash".to_string()),
        ("anchor_embedding", "text-embedding-v4".to_string()),
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
        // AUDIT-036：过滤 tombstone（deleted_at IS NULL）
        let mut stmt = conn.prepare(
            "SELECT id, label, api_key, is_active, created_at, updated_at
             FROM model_api_keys
             WHERE deleted_at IS NULL
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
             WHERE is_active = 1 AND deleted_at IS NULL
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
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM model_api_keys WHERE is_active = 1 AND deleted_at IS NULL",
                [], |r| r.get(0),
            ).unwrap_or(0);
            count == 0
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if should_activate {
            // AUDIT-036：把其他 active 行 bump updated_at = now，让对端 LWW
            // 能拿到 inactive 状态（之前不 bump，会让对端继续以为本地是 active）
            tx.execute(
                "UPDATE model_api_keys SET is_active = 0, updated_at = ?
                 WHERE is_active = 1 AND deleted_at IS NULL",
                params![&now],
            ).map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO model_api_keys (id, label, api_key, is_active, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(id) DO UPDATE SET
               label=excluded.label,
               api_key=excluded.api_key,
               is_active=excluded.is_active,
               updated_at=excluded.updated_at,
               deleted_at=NULL",
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
        // AUDIT-036：tombstone 行不可被 activate
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM model_api_keys WHERE id = ? AND deleted_at IS NULL",
            rusqlite::params![id],
            |r| r.get(0),
        ).unwrap_or(0);
        if exists == 0 {
            return Err("API Key 不存在".to_string());
        }
        // AUDIT-036：所有未删的 key 都 bump updated_at（既 set 也 unset），
        // 让对端 LWW 能拿到完整 active 状态变化；之前只 bump 目标 key 的
        // updated_at，被置 inactive 的其他 key 不动，导致两端各自切 active 后
        // 同步会出现多个 is_active=1 的脏数据
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE model_api_keys
             SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END,
                 updated_at = ?
             WHERE deleted_at IS NULL",
            rusqlite::params![id, &now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn delete_model_api_key(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        // AUDIT-036：改软删 — 写 deleted_at + 清明文 api_key + is_active=0，
        // 保留 row 作为 tombstone 让对端同步时知道这个 id 已删，不会再把
        // 明文 key 重新 push 回来；AUDIT-064：本地 call_log 硬删，并在
        // import/export 侧屏蔽 tombstone key 的日志，防止其他设备回流。
        let was_active: bool = conn.query_row(
            "SELECT is_active FROM model_api_keys WHERE id = ? AND deleted_at IS NULL",
            rusqlite::params![id],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        ).unwrap_or(false);

        conn.execute("DELETE FROM model_call_log WHERE api_key_id = ?", rusqlite::params![id])
            .map_err(|e| e.to_string())?;

        let now = Utc::now().to_rfc3339();
        let changed = conn.execute(
            "UPDATE model_api_keys
             SET deleted_at = ?, api_key = '', is_active = 0, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL",
            rusqlite::params![&now, &now, id],
        ).map_err(|e| e.to_string())?;
        if changed == 0 {
            return Ok(());  // 已被删 / 不存在，幂等
        }

        if was_active {
            // 找一个最近的活 key 顶上 active
            let next_id: Option<String> = conn.query_row(
                "SELECT id FROM model_api_keys
                 WHERE deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            ).ok();
            if let Some(next_id) = next_id {
                conn.execute(
                    "UPDATE model_api_keys
                     SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END,
                         updated_at = ?
                     WHERE deleted_at IS NULL",
                    rusqlite::params![next_id, &now],
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

    const QWEN3_ASR_FLASH_FILETRANS_PRICE_PER_SECOND_CNY: f64 = 0.00022;

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

    /// ASR FileTrans 按音频秒数计费，不走 token 价目。
    fn compute_asr_duration_cost(req: &LogModelCallRequest) -> Option<f64> {
        if !req.success || req.model_id != "qwen3-asr-flash-filetrans" {
            return None;
        }
        let metadata = req.metadata.as_deref()?;
        let parsed: serde_json::Value = serde_json::from_str(metadata).ok()?;
        let seconds = parsed
            .get("usageSeconds")
            .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|n| n as f64)))?;
        if !seconds.is_finite() || seconds <= 0.0 {
            return None;
        }
        Some(seconds * Self::QWEN3_ASR_FLASH_FILETRANS_PRICE_PER_SECOND_CNY)
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

        let gross_cost = Self::compute_cost(&req, &tiers)
            .or_else(|| Self::compute_asr_duration_cost(&req));
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
