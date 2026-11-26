// ══════════════════════════════════════════════
// 洪流域 · 笔记 —— Notion 式页面树 + 块文档（全部存本地）
//   页面 = note_pages 一行：parent_id 成树、同级按 sort_order 排；
//   正文 = 编辑器（BlockNote）的块 JSON 原样存进 content，另存一份纯文本 content_text 给搜索用；
//   删除 = 进回收站：整棵子树打上同一个 deleted_at，恢复时按这个时间戳把「一起删的」捞回来；
//   彻底删除才真删行，顺手清掉没人再引用的附件。
//   附件（图片 / 文件）落在 数据目录/notes/assets/，正文里只存 note-asset://{文件名}，API 端口换了也不断链。
//   kind 列分页面的种类：page 普通页 / anchor 锚点页（标题就是那个词，里面是一条条锚点句）/
//     thought 单独写的想法卡片 / context 语境页（从某个来源生成，比如一个转录过的视频）/
//     group 锚点目录里的结点（最上面一层就是领域）：只用来把锚点归到一起，不能被 # 引用 /
//     alias 锚点的分身：目录里的一格，指向某个锚点（source_id 存它的 id），让同一个锚点能出现在几个领域里；
//       它没有自己的标题和正文，点它就是打开那个锚点。锚点彻底删掉时分身跟着删。
//   每次存正文，顺手把块、# 引用、批注、锚点句各版对进索引表（见 notes_index.rs）。
// ══════════════════════════════════════════════

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

use crate::db::Database;
use crate::notes_index::{self as index, AnchorSentence, AnchorStat, Backlink, ContextPage, SentenceVersion, ThoughtCard, ThoughtDay};

/// 单个附件上限（图片 / 文件），和 HTTP 层的请求体上限一致
pub const NOTE_ASSET_MAX_BYTES: usize = 50 * 1024 * 1024;
const TITLE_MAX_CHARS: usize = 500;
const SEARCH_LIMIT: i64 = 50;
const SNIPPET_RADIUS: usize = 36;
const ASSET_SCHEME: &str = "note-asset://";
/// 新建页面时能选的种类（context 只由「打开某个语境」生成，不在这里）
const CREATABLE_KINDS: [&str; 5] = ["page", "anchor", "thought", "group", "alias"];
const KIND_ALIAS: &str = "alias";
/// 分身的 source_kind
const ALIAS_SOURCE: &str = "anchor";
/// 一张单独写的想法卡片最多多少字（再长就该直接进页面里写）
const THOUGHT_MAX_CHARS: usize = 20_000;

const PAGE_META_COLUMNS: &str =
    "id, parent_id, kind, title, icon, sort_order, favorite, created_at, updated_at, deleted_at, source_id";

/// 页面子树（含自己）。用 UNION 而不是 UNION ALL：万一数据里出现环也不会死循环
const SUBTREE_CTE: &str = "WITH RECURSIVE subtree(id) AS (
        SELECT id FROM note_pages WHERE id = ?1
        UNION
        SELECT p.id FROM note_pages p JOIN subtree s ON p.parent_id = s.id
     )";

// ── 数据结构 ──

/// 页面树用的轻量信息（不带正文）
#[derive(Debug, Serialize, Clone)]
pub struct NotePageMeta {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    /// 这一格是哪个锚点的分身；不是分身就是空
    pub alias_of: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct NotePage {
    #[serde(flatten)]
    pub meta: NotePageMeta,
    pub cover: Option<String>,
    pub full_width: bool,
    /// 编辑器的块数组
    pub content: serde_json::Value,
    /// 语境页的来源（比如 bili + BV 号）；别的页面是空
    pub source_kind: Option<String>,
    pub source_id: Option<String>,
    /// 单独写的想法卡片关联到的语境页；没关联是空
    pub context_page_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NoteSearchHit {
    #[serde(flatten)]
    pub meta: NotePageMeta,
    /// 正文里命中处前后一小段；只命中标题时为空
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct NoteAsset {
    /// 写进正文的地址：note-asset://{name}
    pub url: String,
    pub name: String,
    pub original_name: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
pub struct CreateNotePageRequest {
    pub parent_id: Option<String>,
    pub title: Option<String>,
    pub icon: Option<String>,
    /// page（默认）/ anchor / thought / group / alias
    pub kind: Option<String>,
    /// kind = alias 时必填：是哪个锚点的分身
    pub alias_of: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateThoughtRequest {
    pub text: String,
}

/// 打开某个语境：这个来源已经有页面就用它，没有就照传来的标题和正文建一页
#[derive(Debug, Deserialize)]
pub struct EnsureContextRequest {
    pub source_kind: String,
    pub source_id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub content: Option<serde_json::Value>,
    pub content_text: Option<String>,
}

/// 只改传了的字段；icon / cover 传空串 = 去掉
#[derive(Debug, Deserialize, Default)]
pub struct UpdateNotePageRequest {
    pub title: Option<String>,
    pub icon: Option<String>,
    pub cover: Option<String>,
    pub content: Option<serde_json::Value>,
    pub content_text: Option<String>,
    pub favorite: Option<bool>,
    pub full_width: Option<bool>,
    /// 想法卡片关联到哪个语境页；传空串 = 取消关联
    pub context_page_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MoveNotePageRequest {
    /// 新父页面；None = 移到顶层
    pub parent_id: Option<String>,
    /// 在新父页面的子页面里排第几（越界按末尾）
    pub index: usize,
}

// ── 建表 ──

pub(crate) fn init_note_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS note_pages (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            kind TEXT NOT NULL DEFAULT 'page',
            title TEXT NOT NULL DEFAULT '',
            icon TEXT,
            cover TEXT,
            content TEXT NOT NULL DEFAULT '[]',
            content_text TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            favorite INTEGER NOT NULL DEFAULT 0,
            full_width INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_note_pages_parent ON note_pages(parent_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_note_pages_deleted ON note_pages(deleted_at);

        CREATE TABLE IF NOT EXISTS note_assets (
            name TEXT PRIMARY KEY,
            page_id TEXT,
            original_name TEXT NOT NULL DEFAULT '',
            mime TEXT NOT NULL DEFAULT 'application/octet-stream',
            size INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_assets_page ON note_assets(page_id);
    "#).map_err(|e| format!("创建笔记表失败: {}", e))?;
    index::init_index_tables(conn)?;
    // 正文和块索引对不上的页面（刚升级 / 旧版本的应用改过正文）重新对一遍；对不成不挡启动
    match index::reindex_stale_pages(conn, &now_string()) {
        Ok(0) => {}
        Ok(n) => log::info!("[Notes] 重新对了 {} 页的块索引", n),
        Err(e) => log::warn!("[Notes] 对块索引失败: {}", e),
    }
    Ok(())
}

// ── 小工具 ──

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn map_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<NotePageMeta> {
    let kind: String = row.get(2)?;
    let source_id: Option<String> = row.get(10)?;
    Ok(NotePageMeta {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        alias_of: if kind == KIND_ALIAS { source_id } else { None },
        kind,
        title: row.get(3)?,
        icon: row.get(4)?,
        sort_order: row.get(5)?,
        favorite: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        deleted_at: row.get(9)?,
    })
}

fn get_meta(conn: &Connection, id: &str) -> Result<Option<NotePageMeta>, String> {
    conn.query_row(
        &format!("SELECT {PAGE_META_COLUMNS} FROM note_pages WHERE id = ?"),
        params![id],
        map_meta,
    ).optional().map_err(|e| e.to_string())
}

/// 要求页面存在且不在回收站
fn require_live(conn: &Connection, id: &str) -> Result<NotePageMeta, String> {
    match get_meta(conn, id)? {
        Some(m) if m.deleted_at.is_none() => Ok(m),
        Some(_) => Err("页面在回收站里".to_string()),
        None => Err("页面不存在".to_string()),
    }
}

fn next_sort_order(conn: &Connection, parent_id: Option<&str>) -> i64 {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM note_pages WHERE parent_id IS ? AND deleted_at IS NULL",
        params![parent_id],
        |row| row.get(0),
    ).unwrap_or(0)
}

fn clamp_title(title: &str) -> String {
    title.chars().take(TITLE_MAX_CHARS).collect()
}

/// 空串 → NULL（「去掉图标 / 封面」）
fn text_or_null(v: &str) -> Value {
    let t = v.trim();
    if t.is_empty() { Value::Null } else { Value::Text(t.to_string()) }
}

/// LIKE 模式：转义 % _ \，前后加 %
fn like_pattern(q: &str) -> String {
    let escaped: String = q.chars().flat_map(|c| match c {
        '%' | '_' | '\\' => vec!['\\', c],
        _ => vec![c],
    }).collect();
    format!("%{}%", escaped)
}

/// 正文里命中处前后各截一段（按字符算，中文不会截半个字）
fn make_snippet(text: &str, query: &str) -> String {
    let lower_text: Vec<char> = text.to_lowercase().chars().collect();
    let lower_q: Vec<char> = query.to_lowercase().chars().collect();
    if lower_q.is_empty() || lower_text.len() != text.chars().count() {
        return String::new();
    }
    let pos = lower_text.windows(lower_q.len()).position(|w| w == lower_q.as_slice());
    let Some(pos) = pos else { return String::new() };
    let chars: Vec<char> = text.chars().collect();
    let start = pos.saturating_sub(SNIPPET_RADIUS);
    let end = (pos + lower_q.len() + SNIPPET_RADIUS).min(chars.len());
    let body: String = chars[start..end].iter().collect::<String>().replace('\n', " ");
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        body.trim(),
        if end < chars.len() { "…" } else { "" },
    )
}

/// 锚点页一建出来就带一条空的锚点句
fn initial_content(kind: &str) -> serde_json::Value {
    if kind == "anchor" {
        serde_json::json!([{
            "id": Uuid::new_v4().to_string(),
            "type": index::BLOCK_ANCHOR_SENTENCE,
            "props": { "category": "" },
            "content": [],
            "children": [],
        }])
    } else {
        serde_json::json!([])
    }
}

/// 一段纯文本 → 一行一个段落块
fn text_to_blocks(text: &str) -> serde_json::Value {
    let blocks: Vec<serde_json::Value> = text
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "type": "paragraph",
            "props": {},
            "content": [{ "type": "text", "text": line, "styles": {} }],
            "children": [],
        }))
        .collect();
    serde_json::Value::Array(blocks)
}

/// 新建一页并把正文对进索引（调用方已经拿着库的锁）
#[allow(clippy::too_many_arguments)]
fn insert_page(
    conn: &Connection,
    parent_id: Option<String>,
    kind: &str,
    title: &str,
    icon: Option<String>,
    mut content: serde_json::Value,
    content_text: &str,
    source: Option<(&str, &str)>,
) -> Result<NotePageMeta, String> {
    let now = now_string();
    let meta = NotePageMeta {
        id: Uuid::new_v4().to_string(),
        parent_id: parent_id.clone(),
        kind: kind.to_string(),
        title: clamp_title(title),
        icon: icon.filter(|i| !i.trim().is_empty()),
        sort_order: next_sort_order(conn, parent_id.as_deref()),
        favorite: false,
        created_at: now.clone(),
        updated_at: now.clone(),
        deleted_at: None,
        alias_of: if kind == KIND_ALIAS { source.map(|s| s.1.to_string()) } else { None },
    };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO note_pages (id, parent_id, kind, title, icon, sort_order, created_at, updated_at, source_kind, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            &meta.id, &meta.parent_id, &meta.kind, &meta.title, &meta.icon, meta.sort_order,
            &meta.created_at, &meta.updated_at, source.map(|s| s.0), source.map(|s| s.1),
        ],
    ).map_err(|e| e.to_string())?;
    index::sync_page_index(&tx, &meta.id, &mut content, &now)?;
    let raw = content.to_string();
    tx.execute(
        "UPDATE note_pages SET content = ?, content_text = ?, blocks_stamp = ? WHERE id = ?",
        params![&raw, content_text, index::content_stamp(&raw), &meta.id],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(meta)
}

/// 锚点彻底删掉以后，指向它的分身跟着删
fn purge_orphan_aliases(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM note_pages WHERE kind = ?1 AND (source_id IS NULL OR source_id NOT IN (SELECT id FROM note_pages))",
        params![KIND_ALIAS],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ── 附件文件 ──

pub fn note_assets_dir() -> PathBuf {
    Database::default_data_dir().join("notes").join("assets")
}

/// 附件文件名只允许「uuid.扩展名」，挡住路径穿越
pub fn is_valid_asset_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    stem.len() == 36
        && stem.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && !ext.is_empty()
        && ext.len() <= 8
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

fn asset_ext(original_name: &str, mime: &str) -> String {
    let from_name = original_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()));
    from_name.unwrap_or_else(|| match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "audio/mpeg" => "mp3",
        "application/pdf" => "pdf",
        _ => "bin",
    }.to_string())
}

/// 从扩展名猜 MIME（库里没记录时兜底）
pub fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 找出「所属页面已经不在了、正文里也没人再引用」的附件，删记录，返回要删的文件名
fn collect_orphan_assets(conn: &Connection) -> Result<Vec<String>, String> {
    let candidates: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM note_assets
             WHERE page_id IS NULL OR page_id NOT IN (SELECT id FROM note_pages)",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let mut doomed = Vec::new();
    for name in candidates {
        let still_used: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM note_pages WHERE instr(content, ?) > 0 OR instr(COALESCE(cover, ''), ?) > 0)",
            params![&name, &name],
            |row| row.get(0),
        ).unwrap_or(true);
        if !still_used {
            conn.execute("DELETE FROM note_assets WHERE name = ?", params![&name]).map_err(|e| e.to_string())?;
            doomed.push(name);
        }
    }
    Ok(doomed)
}

fn remove_asset_files(names: &[String]) {
    let dir = note_assets_dir();
    for name in names {
        if let Err(e) = std::fs::remove_file(dir.join(name)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("[Notes] 删除附件文件失败 {}: {}", name, e);
            }
        }
    }
}

// ── 页面读写 ──

impl Database {
    /// 页面树：所有不在回收站里的页面（不带正文）
    pub async fn notes_list_pages(&self) -> Result<Vec<NotePageMeta>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {PAGE_META_COLUMNS} FROM note_pages
             WHERE deleted_at IS NULL
             ORDER BY sort_order ASC, created_at ASC"
        )).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], map_meta).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 单页完整内容（回收站里的也能读，界面上只读展示）
    pub async fn notes_get_page(&self, id: &str) -> Result<Option<NotePage>, String> {
        let conn = self.conn.lock().await;
        conn.query_row(
            &format!("SELECT {PAGE_META_COLUMNS}, cover, full_width, content, source_kind, source_id, context_page_id FROM note_pages WHERE id = ?"),
            params![id],
            |row| {
                let meta = map_meta(row)?;
                let raw: String = row.get(13)?;
                Ok(NotePage {
                    meta,
                    cover: row.get(11)?,
                    full_width: row.get::<_, i64>(12)? != 0,
                    content: serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!([])),
                    source_kind: row.get(14)?,
                    source_id: row.get(15)?,
                    context_page_id: row.get(16)?,
                })
            },
        ).optional().map_err(|e| e.to_string())
    }

    pub async fn notes_create_page(&self, req: CreateNotePageRequest) -> Result<NotePageMeta, String> {
        let conn = self.conn.lock().await;
        let parent_id = req.parent_id.filter(|p| !p.is_empty());
        if let Some(p) = parent_id.as_deref() {
            require_live(&conn, p).map_err(|e| format!("父页面不可用：{}", e))?;
        }
        let kind = req.kind.as_deref().map(str::trim).filter(|k| !k.is_empty()).unwrap_or("page");
        if !CREATABLE_KINDS.contains(&kind) {
            return Err(format!("不认识的页面种类：{}", kind));
        }
        if kind == KIND_ALIAS {
            // 分身：只认还活着的锚点，自己不带标题和正文
            let target = req.alias_of.as_deref().map(str::trim).unwrap_or("");
            let target_meta = require_live(&conn, target).map_err(|e| format!("要放分身的锚点不可用：{}", e))?;
            if target_meta.kind != "anchor" {
                return Err("只有锚点能放分身".to_string());
            }
            return insert_page(&conn, parent_id, kind, "", None, serde_json::json!([]), "", Some((ALIAS_SOURCE, target)));
        }
        insert_page(&conn, parent_id, kind, req.title.as_deref().unwrap_or(""), req.icon, initial_content(kind), "", None)
    }

    /// 单独写一张想法卡片（没贴着任何语境）：一行一个段落
    pub async fn notes_create_thought(&self, req: CreateThoughtRequest) -> Result<NotePageMeta, String> {
        let text = req.text.trim();
        if text.is_empty() {
            return Err("想法是空的".to_string());
        }
        if text.chars().count() > THOUGHT_MAX_CHARS {
            return Err(format!("太长了（上限 {} 字），长文请进页面里写", THOUGHT_MAX_CHARS));
        }
        let conn = self.conn.lock().await;
        insert_page(&conn, None, "thought", "", None, text_to_blocks(text), text, None)
    }

    /// 打开某个语境（比如一个转录过的视频）：已经有页面就用它（在回收站里就捞回来），没有就建一页
    pub async fn notes_ensure_context(&self, req: EnsureContextRequest) -> Result<NotePageMeta, String> {
        let source_kind = req.source_kind.trim();
        let source_id = req.source_id.trim();
        if source_kind.is_empty() || source_id.is_empty() {
            return Err("语境的来源不能为空".to_string());
        }
        let conn = self.conn.lock().await;
        let existing: Option<String> = conn.query_row(
            "SELECT id FROM note_pages WHERE kind = 'context' AND source_kind = ? AND source_id = ?
             ORDER BY (deleted_at IS NULL) DESC, updated_at DESC LIMIT 1",
            params![source_kind, source_id],
            |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if let Some(id) = existing {
            conn.execute("UPDATE note_pages SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL", params![&id])
                .map_err(|e| e.to_string())?;
            return get_meta(&conn, &id)?.ok_or_else(|| "页面不存在".to_string());
        }
        let content = req.content.filter(|c| c.is_array()).unwrap_or_else(|| serde_json::json!([]));
        insert_page(
            &conn,
            None,
            "context",
            req.title.as_deref().unwrap_or(""),
            req.icon,
            content,
            req.content_text.as_deref().unwrap_or(""),
            Some((source_kind, source_id)),
        )
    }

    pub async fn notes_update_page(&self, id: &str, req: UpdateNotePageRequest) -> Result<(), String> {
        let conn = self.conn.lock().await;
        // 回收站里的页面也收：切页时「最后一次保存」可能和「移到回收站」前后脚到，先到的删除不能把改动挡掉。
        // 界面上回收站的页面是只读的，正常操作不会再往里写。
        if get_meta(&conn, id)?.is_none() {
            return Err("页面不存在".to_string());
        }

        let mut sets: Vec<&str> = Vec::new();
        let mut vals: Vec<Value> = Vec::new();
        // 只有内容类改动才算「编辑过」（收藏 / 全宽不刷新 updated_at）
        let mut touched = false;

        if let Some(title) = req.title.as_deref() {
            sets.push("title = ?");
            vals.push(Value::Text(clamp_title(title)));
            touched = true;
        }
        if let Some(icon) = req.icon.as_deref() {
            sets.push("icon = ?");
            vals.push(text_or_null(icon));
            touched = true;
        }
        if let Some(cover) = req.cover.as_deref() {
            sets.push("cover = ?");
            vals.push(text_or_null(cover));
            touched = true;
        }
        let now = now_string();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        if let Some(mut content) = req.content {
            if !content.is_array() {
                return Err("正文必须是块数组".to_string());
            }
            // 块、# 引用、批注、锚点句各版跟着这次保存一起对齐（没有 id 的块在这里补上）
            index::sync_page_index(&tx, id, &mut content, &now)?;
            let raw = content.to_string();
            sets.push("blocks_stamp = ?");
            vals.push(Value::Text(index::content_stamp(&raw)));
            sets.push("content = ?");
            vals.push(Value::Text(raw));
            touched = true;
        }
        if let Some(context) = req.context_page_id.as_deref() {
            let context = context.trim();
            if !context.is_empty() {
                if context == id {
                    return Err("不能把想法卡片关联到它自己".to_string());
                }
                require_live(&tx, context).map_err(|e| format!("语境页不可用：{}", e))?;
            }
            sets.push("context_page_id = ?");
            vals.push(text_or_null(context));
        }
        if let Some(text) = req.content_text {
            sets.push("content_text = ?");
            vals.push(Value::Text(text));
        }
        if let Some(fav) = req.favorite {
            sets.push("favorite = ?");
            vals.push(Value::Integer(fav as i64));
        }
        if let Some(full) = req.full_width {
            sets.push("full_width = ?");
            vals.push(Value::Integer(full as i64));
        }
        if sets.is_empty() {
            return Ok(());
        }
        if touched {
            sets.push("updated_at = ?");
            vals.push(Value::Text(now));
        }
        vals.push(Value::Text(id.to_string()));
        tx.execute(
            &format!("UPDATE note_pages SET {} WHERE id = ?", sets.join(", ")),
            params_from_iter(vals),
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// 换父页面 / 换位置：目标父页面下的兄弟重新从 0 编号
    pub async fn notes_move_page(&self, id: &str, req: MoveNotePageRequest) -> Result<(), String> {
        let mut conn = self.conn.lock().await;
        require_live(&conn, id)?;
        let parent_id = req.parent_id.filter(|p| !p.is_empty());
        if let Some(p) = parent_id.as_deref() {
            require_live(&conn, p).map_err(|e| format!("目标页面不可用：{}", e))?;
            let inside_self: bool = conn.query_row(
                &format!("{SUBTREE_CTE} SELECT EXISTS(SELECT 1 FROM subtree WHERE id = ?2)"),
                params![id, p],
                |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            if inside_self {
                return Err("不能把页面移到它自己的子页面里".to_string());
            }
        }

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut siblings: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM note_pages
                 WHERE parent_id IS ? AND deleted_at IS NULL AND id != ?
                 ORDER BY sort_order ASC, created_at ASC",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![parent_id.as_deref(), id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let index = req.index.min(siblings.len());
        siblings.insert(index, id.to_string());

        tx.execute(
            "UPDATE note_pages SET parent_id = ? WHERE id = ?",
            params![parent_id.as_deref(), id],
        ).map_err(|e| e.to_string())?;
        for (i, sid) in siblings.iter().enumerate() {
            tx.execute(
                "UPDATE note_pages SET sort_order = ? WHERE id = ? AND sort_order != ?",
                params![i as i64, sid, i as i64],
            ).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// 移进回收站：整棵子树里还活着的页面打上同一个删除时间
    pub async fn notes_trash_page(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        require_live(&conn, id)?;
        conn.execute(
            &format!("{SUBTREE_CTE}
             UPDATE note_pages SET deleted_at = ?2
             WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL"),
            params![id, now_string()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 从回收站恢复：和它同一批删掉的子页面一起回来；原父页面不在了就落到顶层
    pub async fn notes_restore_page(&self, id: &str) -> Result<NotePageMeta, String> {
        let conn = self.conn.lock().await;
        let meta = get_meta(&conn, id)?.ok_or("页面不存在")?;
        let Some(stamp) = meta.deleted_at.clone() else { return Ok(meta) };

        conn.execute(
            &format!("{SUBTREE_CTE}
             UPDATE note_pages SET deleted_at = NULL
             WHERE id IN (SELECT id FROM subtree) AND deleted_at = ?2"),
            params![id, &stamp],
        ).map_err(|e| e.to_string())?;

        let parent_alive = match meta.parent_id.as_deref() {
            Some(p) => matches!(get_meta(&conn, p)?, Some(pm) if pm.deleted_at.is_none()),
            None => true,
        };
        if !parent_alive {
            let order = next_sort_order(&conn, None);
            conn.execute(
                "UPDATE note_pages SET parent_id = NULL, sort_order = ? WHERE id = ?",
                params![order, id],
            ).map_err(|e| e.to_string())?;
        }
        get_meta(&conn, id)?.ok_or_else(|| "页面不存在".to_string())
    }

    /// 回收站：只列「被删的那一层」（子页面跟着父页面一起删的不单独列）
    pub async fn notes_trash_list(&self) -> Result<Vec<NotePageMeta>, String> {
        let conn = self.conn.lock().await;
        let cols = PAGE_META_COLUMNS.split(", ").map(|c| format!("p.{c}")).collect::<Vec<_>>().join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT {cols} FROM note_pages p
             LEFT JOIN note_pages par ON par.id = p.parent_id
             WHERE p.deleted_at IS NOT NULL
               AND (par.id IS NULL OR par.deleted_at IS NULL OR par.deleted_at != p.deleted_at)
             ORDER BY p.deleted_at DESC"
        )).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], map_meta).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 彻底删除（只能删回收站里的）：整棵子树连同不再被引用的附件
    pub async fn notes_purge_page(&self, id: &str) -> Result<(), String> {
        let doomed_files = {
            let conn = self.conn.lock().await;
            let meta = get_meta(&conn, id)?.ok_or("页面不存在")?;
            if meta.deleted_at.is_none() {
                return Err("只能彻底删除回收站里的页面".to_string());
            }
            conn.execute(
                &format!("{SUBTREE_CTE} DELETE FROM note_pages WHERE id IN (SELECT id FROM subtree)"),
                params![id],
            ).map_err(|e| e.to_string())?;
            purge_orphan_aliases(&conn)?;
            index::purge_orphan_index(&conn)?;
            collect_orphan_assets(&conn)?
        };
        remove_asset_files(&doomed_files);
        Ok(())
    }

    /// 清空回收站
    pub async fn notes_empty_trash(&self) -> Result<usize, String> {
        let (count, doomed_files) = {
            let conn = self.conn.lock().await;
            let count = conn.execute("DELETE FROM note_pages WHERE deleted_at IS NOT NULL", [])
                .map_err(|e| e.to_string())?;
            purge_orphan_aliases(&conn)?;
            index::purge_orphan_index(&conn)?;
            (count, collect_orphan_assets(&conn)?)
        };
        remove_asset_files(&doomed_files);
        Ok(count)
    }

    /// 全文搜索：标题命中排前面，其次按最近编辑
    pub async fn notes_search(&self, query: &str) -> Result<Vec<NoteSearchHit>, String> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().await;
        let pattern = like_pattern(q);
        let mut stmt = conn.prepare(&format!(
            "SELECT {PAGE_META_COLUMNS}, content_text FROM note_pages
             WHERE deleted_at IS NULL
               AND (title LIKE ?1 ESCAPE '\\' OR content_text LIKE ?1 ESCAPE '\\')
             ORDER BY (title LIKE ?1 ESCAPE '\\') DESC, updated_at DESC
             LIMIT ?2"
        )).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![pattern, SEARCH_LIMIT], |row| {
            let meta = map_meta(row)?;
            let text: String = row.get(11)?;
            Ok(NoteSearchHit { meta, snippet: make_snippet(&text, q) })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ── 锚点 / 想法卡片 / 语境（数据在 notes_index.rs 的索引表里）──

    pub async fn notes_anchor_stats(&self) -> Result<Vec<AnchorStat>, String> {
        let conn = self.conn.lock().await;
        index::anchor_stats(&conn)
    }

    pub async fn notes_anchor_sentences(&self, anchor_id: &str) -> Result<Vec<AnchorSentence>, String> {
        let conn = self.conn.lock().await;
        index::anchor_sentences(&conn, anchor_id)
    }

    pub async fn notes_anchor_backlinks(&self, anchor_id: &str) -> Result<Vec<Backlink>, String> {
        let conn = self.conn.lock().await;
        index::anchor_backlinks(&conn, anchor_id)
    }

    pub async fn notes_sentence_versions(&self, page_id: &str, block_id: &str) -> Result<Vec<SentenceVersion>, String> {
        let conn = self.conn.lock().await;
        index::sentence_versions(&conn, page_id, block_id)
    }

    pub async fn notes_list_thoughts(&self, before: Option<&str>, limit: i64) -> Result<Vec<ThoughtCard>, String> {
        let conn = self.conn.lock().await;
        index::list_thoughts(&conn, before, limit)
    }

    pub async fn notes_thought_heatmap(&self, since: &str) -> Result<Vec<ThoughtDay>, String> {
        let conn = self.conn.lock().await;
        index::thought_heatmap(&conn, since)
    }

    pub async fn notes_list_contexts(&self) -> Result<Vec<ContextPage>, String> {
        let conn = self.conn.lock().await;
        index::list_context_pages(&conn)
    }

    // ── 附件 ──

    pub async fn notes_save_asset(
        &self,
        page_id: Option<String>,
        original_name: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<NoteAsset, String> {
        if bytes.is_empty() {
            return Err("文件是空的".to_string());
        }
        if bytes.len() > NOTE_ASSET_MAX_BYTES {
            return Err(format!("文件太大（上限 {} MB）", NOTE_ASSET_MAX_BYTES / 1024 / 1024));
        }
        let mime = if mime.trim().is_empty() { "application/octet-stream" } else { mime.trim() };
        let name = format!("{}.{}", Uuid::new_v4(), asset_ext(original_name, mime));
        let dir = note_assets_dir();
        tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("创建附件目录失败: {}", e))?;
        tokio::fs::write(dir.join(&name), bytes).await.map_err(|e| format!("写入附件失败: {}", e))?;

        let original: String = original_name.chars().take(200).collect();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO note_assets (name, page_id, original_name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![&name, page_id.filter(|p| !p.is_empty()), &original, mime, bytes.len() as i64, now_string()],
        ).map_err(|e| e.to_string())?;
        Ok(NoteAsset {
            url: format!("{ASSET_SCHEME}{name}"),
            name,
            original_name: original,
            mime: mime.to_string(),
            size: bytes.len() as u64,
        })
    }

    /// 附件的 MIME（库里有记录用记录的，没有按扩展名猜）
    pub async fn notes_asset_mime(&self, name: &str) -> String {
        let conn = self.conn.lock().await;
        conn.query_row("SELECT mime FROM note_assets WHERE name = ?", params![name], |row| row.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .unwrap_or_else(|| guess_mime(name).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_reject_traversal() {
        assert!(is_valid_asset_name("0f8fad5b-d9cb-469f-a165-70867728950e.png"));
        assert!(!is_valid_asset_name("../solo.db"));
        assert!(!is_valid_asset_name("0f8fad5b-d9cb-469f-a165-70867728950e.png/../../x"));
        assert!(!is_valid_asset_name("0f8fad5b-d9cb-469f-a165-70867728950e"));
    }

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
    }

    #[test]
    fn snippet_cuts_around_hit_by_chars() {
        let text = "今天读了一本关于钛合金机体设计的书，感觉材质感很重要";
        let s = make_snippet(text, "材质");
        assert!(s.contains("材质"));
        assert!(make_snippet(text, "不存在").is_empty());
    }
}
