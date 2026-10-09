// ══════════════════════════════════════════════
// 洪流域 · 笔记 —— Notion 式页面树 + 块文档（全部存本地）
//   页面 = note_pages 一行：parent_id 成树、同级按 sort_order 排；
//   正文 = 编辑器（BlockNote）的块 JSON 原样存进 content，另存一份纯文本 content_text 给搜索用；
//   删除 = 进回收站：整棵子树打上同一个 deleted_at，恢复时按这个时间戳把「一起删的」捞回来；
//   彻底删除才真删行，顺手清掉没人再引用的附件。
//   附件（图片 / 文件）落在 数据目录/notes/assets/，正文里只存 note-asset://{文件名}，API 端口换了也不断链。
//   kind 列给以后的「数据库」页留位（现在只有 page）。
// ══════════════════════════════════════════════

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

use crate::db::Database;

/// 单个附件上限（图片 / 文件），和 HTTP 层的请求体上限一致
pub const NOTE_ASSET_MAX_BYTES: usize = 50 * 1024 * 1024;
const TITLE_MAX_CHARS: usize = 500;
const SEARCH_LIMIT: i64 = 50;
const SNIPPET_RADIUS: usize = 36;
const ASSET_SCHEME: &str = "note-asset://";

const PAGE_META_COLUMNS: &str =
    "id, parent_id, kind, title, icon, sort_order, favorite, created_at, updated_at, deleted_at";

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
}

#[derive(Debug, Serialize, Clone)]
pub struct NotePage {
    #[serde(flatten)]
    pub meta: NotePageMeta,
    pub cover: Option<String>,
    pub full_width: bool,
    /// 编辑器的块数组（原样存取，后端不解析结构）
    pub content: serde_json::Value,
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
    "#).map_err(|e| format!("创建笔记表失败: {}", e))
}

// ── 小工具 ──

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn map_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<NotePageMeta> {
    Ok(NotePageMeta {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        kind: row.get(2)?,
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
            &format!("SELECT {PAGE_META_COLUMNS}, cover, full_width, content FROM note_pages WHERE id = ?"),
            params![id],
            |row| {
                let meta = map_meta(row)?;
                let raw: String = row.get(12)?;
                Ok(NotePage {
                    meta,
                    cover: row.get(10)?,
                    full_width: row.get::<_, i64>(11)? != 0,
                    content: serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!([])),
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
        let now = now_string();
        let meta = NotePageMeta {
            id: Uuid::new_v4().to_string(),
            parent_id: parent_id.clone(),
            kind: "page".to_string(),
            title: clamp_title(req.title.as_deref().unwrap_or("")),
            icon: req.icon.filter(|i| !i.trim().is_empty()),
            sort_order: next_sort_order(&conn, parent_id.as_deref()),
            favorite: false,
            created_at: now.clone(),
            updated_at: now,
            deleted_at: None,
        };
        conn.execute(
            "INSERT INTO note_pages (id, parent_id, kind, title, icon, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![&meta.id, &meta.parent_id, &meta.kind, &meta.title, &meta.icon, meta.sort_order, &meta.created_at, &meta.updated_at],
        ).map_err(|e| e.to_string())?;
        Ok(meta)
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
        if let Some(content) = req.content.as_ref() {
            if !content.is_array() {
                return Err("正文必须是块数组".to_string());
            }
            sets.push("content = ?");
            vals.push(Value::Text(content.to_string()));
            touched = true;
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
            vals.push(Value::Text(now_string()));
        }
        vals.push(Value::Text(id.to_string()));
        conn.execute(
            &format!("UPDATE note_pages SET {} WHERE id = ?", sets.join(", ")),
            params_from_iter(vals),
        ).map_err(|e| e.to_string())?;
        Ok(())
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
            let text: String = row.get(10)?;
            Ok(NoteSearchHit { meta, snippet: make_snippet(&text, q) })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
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
