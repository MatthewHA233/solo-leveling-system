// ══════════════════════════════════════════════
// 笔记基底 · 块索引：正文里的每一块在库里各有一行，另外从正文里抽出三样东西
//   · note_blocks            每一块一行：属于哪一页、父块、排第几、种类、属性、行内内容、纯文本、创建和更新时间
//   · note_refs              # 引用：哪一页哪一块指向了哪个锚点（可以点到锚点里的某一句）
//   · note_thoughts          批注 = 想法卡片：插在语境里的一段话（thought 样式），连着涂上的那片原文（thoughtHl 样式）
//   · note_sentence_versions 锚点句的各版：句子改了就留下旧的
//
//   整页正文仍然原样存在 note_pages.content 里（打开页面读的是它）；上面这些行是每次保存时对出来的，
//   用来查「谁引用了这个锚点」「我留过哪些批注」、记每一块的时间。note_pages.blocks_stamp 记着这些行
//   是照哪一份正文对的：旧版本的应用只会改正文、不会动这些行，启动时发现对不上就重新对一遍。
//
//   正文里的写法（编辑器定义见前端 notes/editor/note-schema.tsx，两边要一起改）：
//     块      { id, type, props, content: [行内…] | 表格, children: [块…] }
//     行内    { type:'text', text, styles:{ thought:'批注 id', thoughtHl:'批注 id', … } }
//             { type:'anchorRef', props:{ anchorId, sentenceId } }    # 引用
//             { type:'pageMention', props:{ pageId } }                @ 页面
//     锚点句  type = 'anchorSentence' 的块（只在 kind='anchor' 的页面里用）
// ══════════════════════════════════════════════

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use uuid::Uuid;

/// 纯文本里的引用记号：`\u{E000}#锚点id\u{E001}` / `\u{E000}@页面id\u{E001}`，读出来时换成当时的标题
pub const REF_OPEN: char = '\u{E000}';
pub const REF_CLOSE: char = '\u{E001}';

pub const BLOCK_ANCHOR_SENTENCE: &str = "anchorSentence";
const INLINE_ANCHOR_REF: &str = "anchorRef";
const INLINE_PAGE_MENTION: &str = "pageMention";
const STYLE_THOUGHT: &str = "thought";
const STYLE_THOUGHT_HL: &str = "thoughtHl";

/// 锚点句隔多久再改才算新的一版（之内的改动并进当前这一版，免得打字的每一下都留一版）
const VERSION_MERGE_SECS: i64 = 600;
const TIME_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

// ── 建表 ──

pub(crate) fn init_index_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS note_blocks (
            page_id TEXT NOT NULL,
            id TEXT NOT NULL,
            parent_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            seq INTEGER NOT NULL DEFAULT 0,
            type TEXT NOT NULL,
            props TEXT NOT NULL DEFAULT '{}',
            content TEXT,
            text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (page_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_note_blocks_type ON note_blocks(type);

        CREATE TABLE IF NOT EXISTS note_refs (
            page_id TEXT NOT NULL,
            block_id TEXT NOT NULL,
            anchor_id TEXT NOT NULL,
            sentence_id TEXT NOT NULL DEFAULT '',
            thought_id TEXT NOT NULL DEFAULT '',
            count INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            PRIMARY KEY (page_id, block_id, anchor_id, sentence_id, thought_id)
        );
        CREATE INDEX IF NOT EXISTS idx_note_refs_anchor ON note_refs(anchor_id);

        CREATE TABLE IF NOT EXISTS note_thoughts (
            id TEXT PRIMARY KEY,
            page_id TEXT NOT NULL,
            block_id TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            quote TEXT NOT NULL DEFAULT '',
            quote_blocks TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_note_thoughts_page ON note_thoughts(page_id);
        CREATE INDEX IF NOT EXISTS idx_note_thoughts_created ON note_thoughts(created_at DESC);

        CREATE TABLE IF NOT EXISTS note_sentence_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            page_id TEXT NOT NULL,
            block_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_sentence_versions ON note_sentence_versions(page_id, block_id, version);
    "#).map_err(|e| format!("创建笔记索引表失败: {}", e))?;

    // note_pages 后加的列：旧库没有就补上（旧版本的应用不认识这些列，也不受影响）
    for (column, decl) in [
        ("blocks_stamp", "TEXT"),
        ("source_kind", "TEXT"),
        ("source_id", "TEXT"),
        ("context_page_id", "TEXT"),
    ] {
        add_column_if_missing(conn, "note_pages", column, decl)?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_note_pages_kind ON note_pages(kind);
         CREATE INDEX IF NOT EXISTS idx_note_pages_source ON note_pages(source_kind, source_id);",
    ).map_err(|e| format!("创建笔记索引失败: {}", e))
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), String> {
    let exists: bool = conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?)"),
        params![column],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if !exists {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"), [])
            .map_err(|e| format!("给 {table} 加列 {column} 失败: {}", e))?;
    }
    Ok(())
}

/// 正文字符串的指纹（记在 note_pages.blocks_stamp 里，用来判断块索引是不是照这份正文对的）
pub(crate) fn content_stamp(content: &str) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:016x}:{}", hasher.finish(), content.len())
}

// ── 把正文拆开 ──

#[derive(Debug, Clone, PartialEq)]
struct FlatBlock {
    id: String,
    parent_id: Option<String>,
    sort_order: i64,
    seq: i64,
    kind: String,
    props: String,
    content: Option<String>,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RefKey {
    block_id: String,
    anchor_id: String,
    sentence_id: String,
    thought_id: String,
}

#[derive(Debug, Default)]
struct ThoughtDraft {
    id: String,
    /// 批注文字：按出现顺序的（所在块, 一段文字）
    text_parts: Vec<(String, String)>,
    /// 涂上的原文：按出现顺序的（所在块, 这一块里的几片）
    quote_parts: Vec<(String, Vec<String>)>,
}

#[derive(Debug, Default)]
struct Extracted {
    blocks: Vec<FlatBlock>,
    refs: Vec<RefKey>,
    thoughts: Vec<ThoughtDraft>,
}

enum Atom {
    Text { text: String, thought: String, hl: String },
    Ref { anchor: String, sentence: String },
    Mention { page: String },
    Other,
}

fn str_field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn style_value(item: &Value, key: &str) -> String {
    item.get("styles").map(|s| str_field(s, key)).unwrap_or("").to_string()
}

/// 一串行内内容 → 原子（链接里的文字摊平进来）
fn push_atoms(items: &Value, out: &mut Vec<Atom>) {
    if let Some(s) = items.as_str() {
        out.push(Atom::Text { text: s.to_string(), thought: String::new(), hl: String::new() });
        return;
    }
    let Some(arr) = items.as_array() else { return };
    for item in arr {
        if let Some(s) = item.as_str() {
            out.push(Atom::Text { text: s.to_string(), thought: String::new(), hl: String::new() });
            continue;
        }
        match str_field(item, "type") {
            "text" => out.push(Atom::Text {
                text: str_field(item, "text").to_string(),
                thought: style_value(item, STYLE_THOUGHT),
                hl: style_value(item, STYLE_THOUGHT_HL),
            }),
            "link" => {
                if let Some(inner) = item.get("content") {
                    push_atoms(inner, out);
                }
            }
            INLINE_ANCHOR_REF => {
                let props = item.get("props").cloned().unwrap_or(Value::Null);
                let anchor = str_field(&props, "anchorId").to_string();
                if anchor.is_empty() {
                    out.push(Atom::Other);
                } else {
                    out.push(Atom::Ref { anchor, sentence: str_field(&props, "sentenceId").to_string() });
                }
            }
            INLINE_PAGE_MENTION => {
                let page = item.get("props").map(|p| str_field(p, "pageId")).unwrap_or("").to_string();
                if page.is_empty() { out.push(Atom::Other) } else { out.push(Atom::Mention { page }) }
            }
            _ => out.push(Atom::Other),
        }
    }
}

/// 一块的行内内容拆成若干串：普通块一串，表格每个单元格一串
fn inline_runs(content: Option<&Value>) -> Vec<Vec<Atom>> {
    let Some(content) = content else { return Vec::new() };
    if content.is_array() || content.is_string() {
        let mut run = Vec::new();
        push_atoms(content, &mut run);
        return vec![run];
    }
    if str_field(content, "type") != "tableContent" {
        return Vec::new();
    }
    let mut runs = Vec::new();
    for row in content.get("rows").and_then(Value::as_array).into_iter().flatten() {
        for cell in row.get("cells").and_then(Value::as_array).into_iter().flatten() {
            // 单元格两种形态：直接是行内数组，或 { type:'tableCell', content:[…] }
            let inner = if cell.is_array() { Some(cell) } else { cell.get("content") };
            let mut run = Vec::new();
            if let Some(inner) = inner {
                push_atoms(inner, &mut run);
            }
            runs.push(run);
        }
    }
    runs
}

fn atom_text(atom: &Atom) -> String {
    match atom {
        Atom::Text { text, .. } => text.clone(),
        Atom::Ref { anchor, .. } => format!("{REF_OPEN}#{anchor}{REF_CLOSE}"),
        Atom::Mention { page } => format!("{REF_OPEN}@{page}{REF_CLOSE}"),
        Atom::Other => String::new(),
    }
}

/// 从第 i 个原子往左 / 右找最近的一段文字，看它属于哪条批注（中间隔着的 # 引用跳过去）
fn neighbor_thought(run: &[Atom], i: usize, forward: bool) -> &str {
    let mut j = i as isize + if forward { 1 } else { -1 };
    while j >= 0 && (j as usize) < run.len() {
        match &run[j as usize] {
            Atom::Text { thought, .. } => return thought,
            Atom::Ref { .. } | Atom::Mention { .. } => {}
            Atom::Other => return "",
        }
        j += if forward { 1 } else { -1 };
    }
    ""
}

fn draft_mut<'a>(thoughts: &'a mut Vec<ThoughtDraft>, index: &mut HashMap<String, usize>, id: &str) -> &'a mut ThoughtDraft {
    let at = *index.entry(id.to_string()).or_insert_with(|| {
        thoughts.push(ThoughtDraft { id: id.to_string(), ..Default::default() });
        thoughts.len() - 1
    });
    &mut thoughts[at]
}

/// 给没有 id（或页内重复）的块补上 id。返回有没有改动
fn normalize_ids(blocks: &mut Value, seen: &mut HashSet<String>) -> bool {
    let Some(arr) = blocks.as_array_mut() else { return false };
    let mut changed = false;
    for block in arr.iter_mut() {
        let Some(obj) = block.as_object_mut() else { continue };
        let id = obj.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if id.is_empty() || seen.contains(&id) {
            let fresh = Uuid::new_v4().to_string();
            obj.insert("id".to_string(), Value::String(fresh.clone()));
            seen.insert(fresh);
            changed = true;
        } else {
            seen.insert(id);
        }
        if let Some(children) = obj.get_mut("children") {
            changed |= normalize_ids(children, seen);
        }
    }
    changed
}

fn walk_blocks(
    blocks: &Value,
    parent_id: Option<&str>,
    seq: &mut i64,
    out: &mut Extracted,
    thought_index: &mut HashMap<String, usize>,
) {
    let Some(arr) = blocks.as_array() else { return };
    let mut sort_order = 0i64;
    for block in arr {
        if !block.is_object() {
            continue;
        }
        let id = str_field(block, "id").to_string();
        if id.is_empty() {
            continue;
        }
        let content = block.get("content").filter(|c| !c.is_null());
        let runs = inline_runs(content);

        let text = runs
            .iter()
            .map(|run| run.iter().map(atom_text).collect::<String>())
            .collect::<Vec<_>>()
            .join(" | ");

        for run in &runs {
            let mut prev_hl = String::new();
            for (i, atom) in run.iter().enumerate() {
                match atom {
                    Atom::Text { text, thought, hl } => {
                        if !thought.is_empty() {
                            draft_mut(&mut out.thoughts, thought_index, thought).text_parts.push((id.clone(), text.clone()));
                        }
                        if !hl.is_empty() {
                            let draft = draft_mut(&mut out.thoughts, thought_index, hl);
                            let same_block = draft.quote_parts.last().is_some_and(|(b, _)| *b == id);
                            if same_block && prev_hl == *hl {
                                // 紧挨着的同一片（中间只是换了粗体之类的样式）：接上
                                if let Some(piece) = draft.quote_parts.last_mut().and_then(|(_, pieces)| pieces.last_mut()) {
                                    piece.push_str(text);
                                }
                            } else if same_block {
                                if let Some((_, pieces)) = draft.quote_parts.last_mut() {
                                    pieces.push(text.clone());
                                }
                            } else {
                                draft.quote_parts.push((id.clone(), vec![text.clone()]));
                            }
                        }
                        prev_hl = hl.clone();
                    }
                    Atom::Ref { anchor, sentence } => {
                        let left = neighbor_thought(run, i, false);
                        let right = neighbor_thought(run, i, true);
                        let inside = if !left.is_empty() && left == right { left.to_string() } else { String::new() };
                        if !inside.is_empty() {
                            draft_mut(&mut out.thoughts, thought_index, &inside).text_parts.push((id.clone(), atom_text(atom)));
                        }
                        out.refs.push(RefKey {
                            block_id: id.clone(),
                            anchor_id: anchor.clone(),
                            sentence_id: sentence.clone(),
                            thought_id: inside,
                        });
                        prev_hl.clear();
                    }
                    Atom::Mention { .. } => {
                        let left = neighbor_thought(run, i, false);
                        let right = neighbor_thought(run, i, true);
                        if !left.is_empty() && left == right {
                            let inside = left.to_string();
                            draft_mut(&mut out.thoughts, thought_index, &inside).text_parts.push((id.clone(), atom_text(atom)));
                        }
                        prev_hl.clear();
                    }
                    Atom::Other => prev_hl.clear(),
                }
            }
        }

        out.blocks.push(FlatBlock {
            id: id.clone(),
            parent_id: parent_id.map(str::to_string),
            sort_order,
            seq: *seq,
            kind: str_field(block, "type").to_string(),
            props: block.get("props").filter(|p| p.is_object()).map(Value::to_string).unwrap_or_else(|| "{}".to_string()),
            content: content.map(Value::to_string),
            text,
        });
        sort_order += 1;
        *seq += 1;

        if let Some(children) = block.get("children") {
            walk_blocks(children, Some(&id), seq, out, thought_index);
        }
    }
}

fn extract(content: &Value) -> Extracted {
    let mut out = Extracted::default();
    let mut seq = 0i64;
    let mut thought_index = HashMap::new();
    walk_blocks(content, None, &mut seq, &mut out, &mut thought_index);
    out
}

/// 批注原话：去掉外面那一层括号（括号是插批注时自动带上的）
fn strip_brackets(s: &str) -> String {
    let t = s.trim();
    let mut chars = t.chars();
    let (Some(first), Some(last)) = (chars.next(), chars.next_back()) else { return t.to_string() };
    if matches!(first, '（' | '(') && matches!(last, '）' | ')') {
        chars.as_str().trim().to_string()
    } else {
        t.to_string()
    }
}

fn thought_text(draft: &ThoughtDraft) -> String {
    let mut out = String::new();
    let mut last_block: Option<&str> = None;
    for (block, part) in &draft.text_parts {
        if last_block.is_some_and(|b| b != block) {
            out.push('\n');
        }
        out.push_str(part);
        last_block = Some(block);
    }
    strip_brackets(&out)
}

fn thought_quote(draft: &ThoughtDraft) -> String {
    draft.quote_parts
        .iter()
        .map(|(_, pieces)| pieces.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" … "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn seconds_between(earlier: &str, later: &str) -> Option<i64> {
    let a = chrono::NaiveDateTime::parse_from_str(earlier, TIME_FORMAT).ok()?;
    let b = chrono::NaiveDateTime::parse_from_str(later, TIME_FORMAT).ok()?;
    Some((b - a).num_seconds())
}

// ── 把一页的正文对进索引 ──

/// 照 content 把这一页的块、引用、批注、锚点句各版对齐。
/// content 里没有 id 的块会被补上 id（返回 true 表示 content 被改过，调用方要把改过的存回正文）。
/// 调用方负责放在事务里，并在之后更新 note_pages.blocks_stamp。
pub(crate) fn sync_page_index(conn: &Connection, page_id: &str, content: &mut Value, now: &str) -> Result<bool, String> {
    let err = |e: rusqlite::Error| e.to_string();
    if !content.is_array() {
        return Err("正文必须是块数组".to_string());
    }
    let ids_changed = normalize_ids(content, &mut HashSet::new());
    let extracted = extract(content);

    // 1. 块
    type OldBlock = (Option<String>, i64, i64, String, String, Option<String>, String);
    let mut old_blocks: HashMap<String, OldBlock> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, sort_order, seq, type, props, content, text FROM note_blocks WHERE page_id = ?",
        ).map_err(err)?;
        let rows = stmt.query_map(params![page_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?),
            ))
        }).map_err(err)?;
        for row in rows {
            let (id, rest) = row.map_err(err)?;
            old_blocks.insert(id, rest);
        }
    }
    for b in &extracted.blocks {
        match old_blocks.remove(&b.id) {
            None => {
                conn.execute(
                    "INSERT INTO note_blocks (page_id, id, parent_id, sort_order, seq, type, props, content, text, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![page_id, &b.id, &b.parent_id, b.sort_order, b.seq, &b.kind, &b.props, &b.content, &b.text, now, now],
                ).map_err(err)?;
            }
            Some((parent, sort, seq, kind, props, old_content, _text)) => {
                let body_changed = kind != b.kind || props != b.props || old_content != b.content;
                let moved = parent != b.parent_id || sort != b.sort_order || seq != b.seq;
                if body_changed {
                    conn.execute(
                        "UPDATE note_blocks SET parent_id = ?, sort_order = ?, seq = ?, type = ?, props = ?, content = ?, text = ?, updated_at = ?
                         WHERE page_id = ? AND id = ?",
                        params![&b.parent_id, b.sort_order, b.seq, &b.kind, &b.props, &b.content, &b.text, now, page_id, &b.id],
                    ).map_err(err)?;
                } else if moved {
                    // 只是挪了位置：不算改过内容，更新时间不动
                    conn.execute(
                        "UPDATE note_blocks SET parent_id = ?, sort_order = ?, seq = ? WHERE page_id = ? AND id = ?",
                        params![&b.parent_id, b.sort_order, b.seq, page_id, &b.id],
                    ).map_err(err)?;
                }
            }
        }
    }
    for gone in old_blocks.keys() {
        conn.execute("DELETE FROM note_blocks WHERE page_id = ? AND id = ?", params![page_id, gone]).map_err(err)?;
    }

    // 2. # 引用：整页重写，原来就有的保留它第一次出现的时间
    let mut old_refs: HashMap<RefKey, String> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT block_id, anchor_id, sentence_id, thought_id, created_at FROM note_refs WHERE page_id = ?",
        ).map_err(err)?;
        let rows = stmt.query_map(params![page_id], |row| {
            Ok((
                RefKey { block_id: row.get(0)?, anchor_id: row.get(1)?, sentence_id: row.get(2)?, thought_id: row.get(3)? },
                row.get::<_, String>(4)?,
            ))
        }).map_err(err)?;
        for row in rows {
            let (key, created) = row.map_err(err)?;
            old_refs.insert(key, created);
        }
    }
    let mut counts: Vec<(RefKey, i64)> = Vec::new();
    let mut count_index: HashMap<RefKey, usize> = HashMap::new();
    for key in &extracted.refs {
        match count_index.get(key) {
            Some(&at) => counts[at].1 += 1,
            None => {
                count_index.insert(key.clone(), counts.len());
                counts.push((key.clone(), 1));
            }
        }
    }
    conn.execute("DELETE FROM note_refs WHERE page_id = ?", params![page_id]).map_err(err)?;
    for (key, count) in &counts {
        let created = old_refs.get(key).map(String::as_str).unwrap_or(now);
        conn.execute(
            "INSERT INTO note_refs (page_id, block_id, anchor_id, sentence_id, thought_id, count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![page_id, &key.block_id, &key.anchor_id, &key.sentence_id, &key.thought_id, count, created],
        ).map_err(err)?;
    }

    // 3. 批注（想法卡片）：还在的更新，不在了的打上删除时间（剪切再贴回来 / 贴到别的页，会按 id 接回去）
    let mut alive: HashSet<String> = HashSet::new();
    for draft in &extracted.thoughts {
        let text = thought_text(draft);
        let quote = thought_quote(draft);
        if text.is_empty() && quote.is_empty() {
            continue;
        }
        let block_id = draft.text_parts.first().map(|(b, _)| b.clone())
            .or_else(|| draft.quote_parts.first().map(|(b, _)| b.clone()))
            .unwrap_or_default();
        let mut quote_blocks: Vec<&str> = Vec::new();
        for (b, _) in &draft.quote_parts {
            if !quote_blocks.contains(&b.as_str()) {
                quote_blocks.push(b);
            }
        }
        let quote_blocks = serde_json::to_string(&quote_blocks).unwrap_or_else(|_| "[]".to_string());
        let existing: Option<(String, String)> = conn.query_row(
            "SELECT text, quote FROM note_thoughts WHERE id = ?",
            params![&draft.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(err)?;
        match existing {
            None => {
                conn.execute(
                    "INSERT INTO note_thoughts (id, page_id, block_id, text, quote, quote_blocks, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    params![&draft.id, page_id, &block_id, &text, &quote, &quote_blocks, now, now],
                ).map_err(err)?;
            }
            Some((old_text, old_quote)) => {
                if old_text != text || old_quote != quote {
                    conn.execute(
                        "UPDATE note_thoughts SET page_id = ?, block_id = ?, text = ?, quote = ?, quote_blocks = ?, updated_at = ?, deleted_at = NULL WHERE id = ?",
                        params![page_id, &block_id, &text, &quote, &quote_blocks, now, &draft.id],
                    ).map_err(err)?;
                } else {
                    conn.execute(
                        "UPDATE note_thoughts SET page_id = ?, block_id = ?, quote_blocks = ?, deleted_at = NULL WHERE id = ?",
                        params![page_id, &block_id, &quote_blocks, &draft.id],
                    ).map_err(err)?;
                }
            }
        }
        alive.insert(draft.id.clone());
    }
    let was_here: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM note_thoughts WHERE page_id = ? AND deleted_at IS NULL").map_err(err)?;
        let rows = stmt.query_map(params![page_id], |row| row.get::<_, String>(0)).map_err(err)?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in was_here.iter().filter(|id| !alive.contains(*id)) {
        conn.execute("UPDATE note_thoughts SET deleted_at = ? WHERE id = ?", params![now, id]).map_err(err)?;
    }

    // 4. 锚点句的各版
    for b in extracted.blocks.iter().filter(|b| b.kind == BLOCK_ANCHOR_SENTENCE) {
        let text = b.text.trim();
        if text.is_empty() {
            continue;
        }
        let latest: Option<(i64, i64, String, String)> = conn.query_row(
            "SELECT id, version, text, updated_at FROM note_sentence_versions
             WHERE page_id = ? AND block_id = ? ORDER BY version DESC LIMIT 1",
            params![page_id, &b.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(err)?;
        match latest {
            None => {
                conn.execute(
                    "INSERT INTO note_sentence_versions (page_id, block_id, version, text, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)",
                    params![page_id, &b.id, text, now, now],
                ).map_err(err)?;
            }
            Some((_, _, old_text, _)) if old_text == text => {}
            Some((row_id, version, _, updated_at)) => {
                let fresh = seconds_between(&updated_at, now).is_some_and(|s| (0..=VERSION_MERGE_SECS).contains(&s));
                if fresh {
                    conn.execute(
                        "UPDATE note_sentence_versions SET text = ?, updated_at = ? WHERE id = ?",
                        params![text, now, row_id],
                    ).map_err(err)?;
                } else {
                    conn.execute(
                        "INSERT INTO note_sentence_versions (page_id, block_id, version, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                        params![page_id, &b.id, version + 1, text, now, now],
                    ).map_err(err)?;
                }
            }
        }
    }

    Ok(ids_changed)
}

/// 启动时：正文和块索引对不上的页面（刚升级 / 旧版本的应用改过正文）重新对一遍。返回对了几页
pub(crate) fn reindex_stale_pages(conn: &Connection, now: &str) -> Result<usize, String> {
    let err = |e: rusqlite::Error| e.to_string();
    let stale: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, content, blocks_stamp FROM note_pages").map_err(err)?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
        }).map_err(err)?;
        rows.filter_map(|r| r.ok())
            .filter(|(_, content, stamp)| stamp.as_deref() != Some(content_stamp(content).as_str()))
            .map(|(id, content, _)| (id, content))
            .collect()
    };
    if stale.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut done = 0usize;
    for (id, raw) in &stale {
        let mut content: Value = serde_json::from_str(raw).unwrap_or_else(|_| Value::Array(Vec::new()));
        if !content.is_array() {
            content = Value::Array(Vec::new());
        }
        let ids_changed = sync_page_index(&tx, id, &mut content, now)?;
        if ids_changed {
            // 只是给块补了 id：正文算没改过，更新时间不动
            let fixed = content.to_string();
            tx.execute(
                "UPDATE note_pages SET content = ?, blocks_stamp = ? WHERE id = ?",
                params![&fixed, content_stamp(&fixed), id],
            ).map_err(err)?;
        } else {
            tx.execute("UPDATE note_pages SET blocks_stamp = ? WHERE id = ?", params![content_stamp(raw), id]).map_err(err)?;
        }
        done += 1;
    }
    tx.commit().map_err(err)?;
    Ok(done)
}

/// 页面被彻底删掉之后：它名下的块、引用、批注、锚点句各版一起清掉
pub(crate) fn purge_orphan_index(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM note_blocks WHERE page_id NOT IN (SELECT id FROM note_pages);
         DELETE FROM note_refs WHERE page_id NOT IN (SELECT id FROM note_pages);
         DELETE FROM note_thoughts WHERE page_id NOT IN (SELECT id FROM note_pages);
         DELETE FROM note_sentence_versions WHERE page_id NOT IN (SELECT id FROM note_pages);",
    ).map_err(|e| e.to_string())
}

/// 照块的行把一页正文拼回来（现在打开页面读的是整页正文，这个留给以后按块同步用；测试里拿它核对索引没丢东西）
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn assemble_page(conn: &Connection, page_id: &str) -> Result<Value, String> {
    let err = |e: rusqlite::Error| e.to_string();
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, type, props, content FROM note_blocks WHERE page_id = ? ORDER BY seq ASC",
    ).map_err(err)?;
    let rows: Vec<(String, Option<String>, String, String, Option<String>)> = stmt
        .query_map(params![page_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
        .map_err(err)?
        .filter_map(|r| r.ok())
        .collect();

    let mut children: HashMap<Option<String>, Vec<usize>> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        children.entry(row.1.clone()).or_default().push(i);
    }
    fn build(
        parent: Option<String>,
        rows: &[(String, Option<String>, String, String, Option<String>)],
        children: &HashMap<Option<String>, Vec<usize>>,
    ) -> Vec<Value> {
        children.get(&parent).into_iter().flatten().map(|&i| {
            let (id, _, kind, props, content) = &rows[i];
            let mut obj = serde_json::Map::new();
            obj.insert("id".to_string(), Value::String(id.clone()));
            obj.insert("type".to_string(), Value::String(kind.clone()));
            obj.insert("props".to_string(), serde_json::from_str(props).unwrap_or_else(|_| Value::Object(Default::default())));
            if let Some(c) = content {
                obj.insert("content".to_string(), serde_json::from_str(c).unwrap_or(Value::Null));
            }
            obj.insert("children".to_string(), Value::Array(build(Some(id.clone()), rows, children)));
            Value::Object(obj)
        }).collect()
    }
    Ok(Value::Array(build(None, &rows, &children)))
}

// ── 读 ──

/// 全部页面的标题（把纯文本里的引用记号换成标题用）
pub(crate) fn page_titles(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn.prepare("SELECT id, title FROM note_pages WHERE deleted_at IS NULL").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// `\u{E000}#id\u{E001}` → `#标题`，`\u{E000}@id\u{E001}` → `@标题`
pub(crate) fn resolve_ref_tokens(text: &str, titles: &HashMap<String, String>) -> String {
    if !text.contains(REF_OPEN) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(REF_OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + REF_OPEN.len_utf8()..];
        let Some(end) = after.find(REF_CLOSE) else {
            rest = after;
            continue;
        };
        let token = &after[..end];
        let mut chars = token.chars();
        let sigil = chars.next().unwrap_or('#');
        let id = chars.as_str();
        let title = titles.get(id).map(|t| t.trim()).filter(|t| !t.is_empty());
        out.push(sigil);
        out.push_str(title.unwrap_or(if sigil == '#' { "已删除的锚点" } else { "已删除的页面" }));
        rest = &after[end + REF_CLOSE.len_utf8()..];
    }
    out.push_str(rest);
    out
}

#[derive(Debug, Serialize)]
pub struct AnchorStat {
    pub anchor_id: String,
    /// 被多少处引用（引用它的页面不在回收站里才算）
    pub refs: i64,
    /// 里面有几条写了字的锚点句
    pub sentences: i64,
}

pub(crate) fn anchor_stats(conn: &Connection) -> Result<Vec<AnchorStat>, String> {
    let mut stmt = conn.prepare(
        "SELECT p.id,
                (SELECT COUNT(*) FROM note_refs r JOIN note_pages sp ON sp.id = r.page_id
                  WHERE r.anchor_id = p.id AND sp.deleted_at IS NULL),
                (SELECT COUNT(*) FROM note_blocks b
                  WHERE b.page_id = p.id AND b.type = 'anchorSentence' AND trim(b.text) <> '')
         FROM note_pages p WHERE p.kind = 'anchor' AND p.deleted_at IS NULL",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(AnchorStat { anchor_id: row.get(0)?, refs: row.get(1)?, sentences: row.get(2)? })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Debug, Serialize)]
pub struct AnchorSentence {
    pub block_id: String,
    pub text: String,
    /// 动机 motive / 观点 view / 实践 practice，没标是空串
    pub category: String,
    /// 现在是第几版（还没写字是 0）
    pub version: i64,
    /// 有多少处引用点到了这一句
    pub refs: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn anchor_sentences(conn: &Connection, anchor_id: &str) -> Result<Vec<AnchorSentence>, String> {
    let titles = page_titles(conn)?;
    let mut stmt = conn.prepare(
        "SELECT b.id, b.text, b.props, b.created_at, b.updated_at,
                COALESCE((SELECT MAX(v.version) FROM note_sentence_versions v WHERE v.page_id = b.page_id AND v.block_id = b.id), 0),
                (SELECT COUNT(*) FROM note_refs r JOIN note_pages sp ON sp.id = r.page_id
                  WHERE r.anchor_id = b.page_id AND r.sentence_id = b.id AND sp.deleted_at IS NULL)
         FROM note_blocks b WHERE b.page_id = ? AND b.type = 'anchorSentence' ORDER BY b.seq ASC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![anchor_id], |row| {
        let props: String = row.get(2)?;
        let category = serde_json::from_str::<Value>(&props).ok()
            .map(|p| str_field(&p, "category").to_string())
            .unwrap_or_default();
        Ok(AnchorSentence {
            block_id: row.get(0)?,
            text: row.get(1)?,
            category,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            version: row.get(5)?,
            refs: row.get(6)?,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).map(|mut s| {
        s.text = resolve_ref_tokens(&s.text, &titles);
        s
    }).collect())
}

#[derive(Debug, Serialize)]
pub struct SentenceVersion {
    pub version: i64,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn sentence_versions(conn: &Connection, page_id: &str, block_id: &str) -> Result<Vec<SentenceVersion>, String> {
    let titles = page_titles(conn)?;
    let mut stmt = conn.prepare(
        "SELECT version, text, created_at, updated_at FROM note_sentence_versions
         WHERE page_id = ? AND block_id = ? ORDER BY version DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![page_id, block_id], |row| {
        Ok(SentenceVersion { version: row.get(0)?, text: row.get(1)?, created_at: row.get(2)?, updated_at: row.get(3)? })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).map(|mut v| {
        v.text = resolve_ref_tokens(&v.text, &titles);
        v
    }).collect())
}

/// 一处引用：哪一页的哪一块指向了这个锚点
#[derive(Debug, Serialize)]
pub struct Backlink {
    pub page_id: String,
    pub page_title: String,
    pub page_icon: Option<String>,
    pub page_kind: String,
    pub block_id: String,
    /// 那一块的文字（引用记号已换成标题）
    pub block_text: String,
    /// 点到了哪一句（空串 = 整个锚点）
    pub sentence_id: String,
    /// 这处引用在某条批注里：批注的 id、原话、涂上的原文
    pub thought_id: String,
    pub thought_text: String,
    pub thought_quote: String,
    pub created_at: String,
}

pub(crate) fn anchor_backlinks(conn: &Connection, anchor_id: &str) -> Result<Vec<Backlink>, String> {
    let titles = page_titles(conn)?;
    let mut stmt = conn.prepare(
        "SELECT r.page_id, p.title, p.icon, p.kind, r.block_id, COALESCE(b.text, ''), r.sentence_id, r.thought_id,
                COALESCE(t.text, ''), COALESCE(t.quote, ''), r.created_at
         FROM note_refs r
         JOIN note_pages p ON p.id = r.page_id AND p.deleted_at IS NULL
         LEFT JOIN note_blocks b ON b.page_id = r.page_id AND b.id = r.block_id
         LEFT JOIN note_thoughts t ON t.id = r.thought_id AND t.deleted_at IS NULL
         WHERE r.anchor_id = ? AND r.page_id != ?
         ORDER BY p.updated_at DESC, r.page_id, COALESCE(b.seq, 0) ASC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![anchor_id, anchor_id], |row| {
        Ok(Backlink {
            page_id: row.get(0)?,
            page_title: row.get(1)?,
            page_icon: row.get(2)?,
            page_kind: row.get(3)?,
            block_id: row.get(4)?,
            block_text: row.get(5)?,
            sentence_id: row.get(6)?,
            thought_id: row.get(7)?,
            thought_text: row.get(8)?,
            thought_quote: row.get(9)?,
            created_at: row.get(10)?,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).map(|mut b| {
        b.block_text = resolve_ref_tokens(&b.block_text, &titles);
        b.thought_text = resolve_ref_tokens(&b.thought_text, &titles);
        b
    }).collect())
}

#[derive(Debug, Serialize, Clone)]
pub struct ThoughtAnchor {
    pub id: String,
    pub title: String,
}

/// 一张想法卡片。两个来路：inline = 插在某一页里的批注；page = 单独写的（kind='thought' 的页面）
#[derive(Debug, Serialize)]
pub struct ThoughtCard {
    pub id: String,
    pub origin: String,
    pub text: String,
    /// 涂上的原文（只有批注有）
    pub quote: String,
    /// 它在哪一页：批注 = 所在的语境页；单独写的 = 它自己
    pub page_id: String,
    /// 批注文字所在的块（跳回原处用；单独写的是空串）
    pub block_id: String,
    /// 关联的语境页：批注就是所在的那一页；单独写的可以没有（未关联语境）
    pub context_page_id: Option<String>,
    pub context_title: String,
    pub context_icon: Option<String>,
    pub context_kind: String,
    pub anchors: Vec<ThoughtAnchor>,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn list_thoughts(conn: &Connection, before: Option<&str>, limit: i64) -> Result<Vec<ThoughtCard>, String> {
    let err = |e: rusqlite::Error| e.to_string();
    let titles = page_titles(conn)?;
    let limit = limit.clamp(1, 500);
    // 时间上限：不传就取一个比任何时间都大的串
    let before = before.filter(|b| !b.is_empty()).unwrap_or("9999");
    let mut cards: Vec<ThoughtCard> = Vec::new();

    {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.text, t.quote, t.page_id, t.block_id, p.title, p.icon, p.kind, t.created_at, t.updated_at
             FROM note_thoughts t JOIN note_pages p ON p.id = t.page_id AND p.deleted_at IS NULL
             WHERE t.deleted_at IS NULL AND t.created_at < ?
             ORDER BY t.created_at DESC LIMIT ?",
        ).map_err(err)?;
        let rows = stmt.query_map(params![before, limit], |row| {
            let page_id: String = row.get(3)?;
            Ok(ThoughtCard {
                id: row.get(0)?,
                origin: "inline".to_string(),
                text: row.get(1)?,
                quote: row.get(2)?,
                page_id: page_id.clone(),
                block_id: row.get(4)?,
                context_page_id: Some(page_id),
                context_title: row.get(5)?,
                context_icon: row.get(6)?,
                context_kind: row.get(7)?,
                anchors: Vec::new(),
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        }).map_err(err)?;
        cards.extend(rows.filter_map(|r| r.ok()));
    }
    {
        let mut stmt = conn.prepare(
            "SELECT p.id, p.content_text, p.title, p.context_page_id, c.title, c.icon, c.kind, p.created_at, p.updated_at
             FROM note_pages p
             LEFT JOIN note_pages c ON c.id = p.context_page_id AND c.deleted_at IS NULL
             WHERE p.kind = 'thought' AND p.deleted_at IS NULL AND p.created_at < ?
             ORDER BY p.created_at DESC LIMIT ?",
        ).map_err(err)?;
        let rows = stmt.query_map(params![before, limit], |row| {
            let id: String = row.get(0)?;
            let body: String = row.get(1)?;
            let title: String = row.get(2)?;
            let context_title: Option<String> = row.get(4)?;
            // 有标题的（成篇的文章）标题放在最前面
            let text = match (title.trim().is_empty(), body.trim().is_empty()) {
                (true, _) => body,
                (false, true) => title,
                (false, false) => format!("{}\n{}", title.trim(), body),
            };
            Ok(ThoughtCard {
                id: id.clone(),
                origin: "page".to_string(),
                text,
                quote: String::new(),
                page_id: id,
                block_id: String::new(),
                // 语境页不在了（进了回收站）就当没关联
                context_page_id: if context_title.is_some() { row.get(3)? } else { None },
                context_title: context_title.unwrap_or_default(),
                context_icon: row.get(5)?,
                context_kind: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                anchors: Vec::new(),
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        }).map_err(err)?;
        cards.extend(rows.filter_map(|r| r.ok()));
    }

    cards.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    cards.truncate(limit as usize);

    let mut by_thought = conn.prepare("SELECT DISTINCT anchor_id FROM note_refs WHERE thought_id = ?").map_err(err)?;
    let mut by_page = conn.prepare("SELECT DISTINCT anchor_id FROM note_refs WHERE page_id = ?").map_err(err)?;
    for card in &mut cards {
        let stmt = if card.origin == "inline" { &mut by_thought } else { &mut by_page };
        let ids: Vec<String> = stmt.query_map(params![&card.id], |row| row.get::<_, String>(0)).map_err(err)?
            .filter_map(|r| r.ok()).collect();
        card.anchors = ids.into_iter()
            .filter_map(|id| titles.get(&id).map(|t| ThoughtAnchor { id, title: t.clone() }))
            .collect();
        card.text = resolve_ref_tokens(&card.text, &titles);
    }
    Ok(cards)
}

#[derive(Debug, Serialize)]
pub struct ThoughtDay {
    /// 2026-11-23
    pub day: String,
    pub count: i64,
}

/// 每天写了几张想法卡片（批注 + 单独写的），只算 since 这一天之后的
pub(crate) fn thought_heatmap(conn: &Connection, since: &str) -> Result<Vec<ThoughtDay>, String> {
    let mut stmt = conn.prepare(
        "SELECT day, SUM(n) FROM (
            SELECT substr(t.created_at, 1, 10) AS day, COUNT(*) AS n
              FROM note_thoughts t JOIN note_pages p ON p.id = t.page_id AND p.deleted_at IS NULL
             WHERE t.deleted_at IS NULL AND t.created_at >= ?1 GROUP BY day
            UNION ALL
            SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
              FROM note_pages WHERE kind = 'thought' AND deleted_at IS NULL AND created_at >= ?1 GROUP BY day
         ) GROUP BY day ORDER BY day ASC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![since], |row| Ok(ThoughtDay { day: row.get(0)?, count: row.get(1)? }))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 语境页（kind='context'）：从某个来源（现在只有 B 站转录）生成的一页
#[derive(Debug, Serialize)]
pub struct ContextPage {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub source_kind: String,
    pub source_id: String,
    /// 上面留了几条批注
    pub thoughts: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn list_context_pages(conn: &Connection) -> Result<Vec<ContextPage>, String> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.icon, COALESCE(p.source_kind, ''), COALESCE(p.source_id, ''),
                (SELECT COUNT(*) FROM note_thoughts t WHERE t.page_id = p.id AND t.deleted_at IS NULL),
                p.created_at, p.updated_at
         FROM note_pages p WHERE p.kind = 'context' AND p.deleted_at IS NULL
         ORDER BY p.updated_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(ContextPage {
            id: row.get(0)?,
            title: row.get(1)?,
            icon: row.get(2)?,
            source_kind: row.get(3)?,
            source_id: row.get(4)?,
            thoughts: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::notes::init_note_tables(&conn).unwrap();
        conn
    }

    fn add_page(conn: &Connection, id: &str, kind: &str, title: &str) {
        conn.execute(
            "INSERT INTO note_pages (id, kind, title, created_at, updated_at) VALUES (?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
            params![id, kind, title],
        ).unwrap();
    }

    fn text(t: &str) -> Value {
        json!({ "type": "text", "text": t, "styles": {} })
    }

    fn styled(t: &str, styles: Value) -> Value {
        json!({ "type": "text", "text": t, "styles": styles })
    }

    fn para(id: &str, content: Vec<Value>) -> Value {
        json!({ "id": id, "type": "paragraph", "props": {}, "content": content, "children": [] })
    }

    #[test]
    fn blocks_keep_identity_and_times_across_saves() {
        let conn = open();
        add_page(&conn, "p1", "page", "一页");
        let mut v1 = json!([
            para("a", vec![text("第一段")]),
            { "id": "b", "type": "paragraph", "props": {}, "content": [text("第二段")], "children": [para("b1", vec![text("子块")])] },
        ]);
        assert!(!sync_page_index(&conn, "p1", &mut v1, "2026-01-01 10:00:00").unwrap());
        assert_eq!(assemble_page(&conn, "p1").unwrap(), v1);

        // 改第二段、把子块提到顶层、加一段、删第一段
        let mut v2 = json!([
            para("b", vec![text("第二段改过")]),
            para("b1", vec![text("子块")]),
            para("c", vec![text("新的一段")]),
        ]);
        sync_page_index(&conn, "p1", &mut v2, "2026-01-02 10:00:00").unwrap();
        assert_eq!(assemble_page(&conn, "p1").unwrap(), v2);

        let times = |id: &str| -> (String, String) {
            conn.query_row("SELECT created_at, updated_at FROM note_blocks WHERE page_id = 'p1' AND id = ?", params![id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        assert_eq!(times("b"), ("2026-01-01 10:00:00".to_string(), "2026-01-02 10:00:00".to_string()));
        // 只挪了位置的块：更新时间不动
        assert_eq!(times("b1"), ("2026-01-01 10:00:00".to_string(), "2026-01-01 10:00:00".to_string()));
        assert_eq!(times("c").0, "2026-01-02 10:00:00");
        let gone: i64 = conn.query_row("SELECT COUNT(*) FROM note_blocks WHERE id = 'a'", [], |r| r.get(0)).unwrap();
        assert_eq!(gone, 0);
    }

    #[test]
    fn blocks_without_ids_get_one() {
        let conn = open();
        add_page(&conn, "p1", "page", "一页");
        let mut content = json!([
            { "type": "paragraph", "props": {}, "content": [text("没有 id")], "children": [] },
            para("dup", vec![text("甲")]),
            para("dup", vec![text("乙")]),
        ]);
        assert!(sync_page_index(&conn, "p1", &mut content, "2026-01-01 10:00:00").unwrap());
        let ids: Vec<&str> = content.as_array().unwrap().iter().map(|b| b["id"].as_str().unwrap()).collect();
        assert!(!ids[0].is_empty());
        assert_eq!(ids[1], "dup");
        assert_ne!(ids[2], "dup");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM note_blocks WHERE page_id = 'p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
    }

    #[test]
    fn refs_thoughts_and_backlinks() {
        let conn = open();
        add_page(&conn, "book", "page", "一本书");
        add_page(&conn, "anc", "anchor", "虚构词");
        let anchor_ref = json!({ "type": "anchorRef", "props": { "anchorId": "anc", "sentenceId": "" } });
        let mut content = json!([
            para("x", vec![
                text("原文开头，"),
                styled("被涂上的一片", json!({ "thoughtHl": "t1" })),
                styled("（我的想法 ", json!({ "thought": "t1" })),
                anchor_ref.clone(),
                styled(" 就是这样）", json!({ "thought": "t1" })),
                text("原文继续。"),
            ]),
            para("y", vec![styled("跨段也涂", json!({ "thoughtHl": "t1", "bold": true })), text("，这里直接插一个 "), anchor_ref.clone()]),
        ]);
        sync_page_index(&conn, "book", &mut content, "2026-01-01 10:00:00").unwrap();

        let (t, q, block): (String, String, String) = conn.query_row(
            "SELECT text, quote, block_id FROM note_thoughts WHERE id = 't1'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(t, format!("我的想法 {REF_OPEN}#anc{REF_CLOSE} 就是这样"));
        assert_eq!(q, "被涂上的一片\n跨段也涂");
        assert_eq!(block, "x");

        let links = anchor_backlinks(&conn, "anc").unwrap();
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].block_id, "x");
        assert_eq!(links[0].thought_id, "t1");
        assert_eq!(links[0].thought_text, "我的想法 #虚构词 就是这样");
        assert_eq!(links[1].thought_id, "");
        assert!(links[1].block_text.ends_with("#虚构词"));

        let stats = anchor_stats(&conn).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].refs, 2);

        let cards = list_thoughts(&conn, None, 50).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].origin, "inline");
        assert_eq!(cards[0].context_title, "一本书");
        assert_eq!(cards[0].anchors.len(), 1);

        // 批注从页面上删掉：卡片打上删除时间；再贴回来按 id 接上，创建时间不变
        let mut without = json!([para("x", vec![text("原文开头，被涂上的一片原文继续。")])]);
        sync_page_index(&conn, "book", &mut without, "2026-01-02 10:00:00").unwrap();
        assert!(list_thoughts(&conn, None, 50).unwrap().is_empty());
        assert!(anchor_backlinks(&conn, "anc").unwrap().is_empty());
        sync_page_index(&conn, "book", &mut content, "2026-01-03 10:00:00").unwrap();
        let cards = list_thoughts(&conn, None, 50).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].created_at, "2026-01-01 10:00:00");
    }

    #[test]
    fn sentence_versions_merge_within_window() {
        let conn = open();
        add_page(&conn, "anc", "anchor", "虚构词");
        let sentence = |t: &str| json!([{ "id": "s1", "type": "anchorSentence", "props": { "category": "view" }, "content": [text(t)], "children": [] }]);

        sync_page_index(&conn, "anc", &mut sentence("第一种说法"), "2026-01-01 10:00:00").unwrap();
        // 十分钟之内接着改：并进第一版
        sync_page_index(&conn, "anc", &mut sentence("第一种说法，补了半句"), "2026-01-01 10:05:00").unwrap();
        // 隔了一天再改：第二版
        sync_page_index(&conn, "anc", &mut sentence("第二种说法"), "2026-01-02 09:00:00").unwrap();
        // 没改：不多出一版
        sync_page_index(&conn, "anc", &mut sentence("第二种说法"), "2026-01-03 09:00:00").unwrap();

        let versions = sentence_versions(&conn, "anc", "s1").unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].version, 2);
        assert_eq!(versions[0].text, "第二种说法");
        assert_eq!(versions[1].text, "第一种说法，补了半句");

        let sentences = anchor_sentences(&conn, "anc").unwrap();
        assert_eq!(sentences.len(), 1);
        assert_eq!(sentences[0].category, "view");
        assert_eq!(sentences[0].version, 2);
    }

    #[test]
    fn stale_pages_are_reindexed() {
        let conn = open();
        add_page(&conn, "p1", "page", "一页");
        let content = json!([para("a", vec![text("旧版本应用写进来的")])]).to_string();
        conn.execute("UPDATE note_pages SET content = ? WHERE id = 'p1'", params![&content]).unwrap();
        assert_eq!(reindex_stale_pages(&conn, "2026-01-01 10:00:00").unwrap(), 1);
        assert_eq!(reindex_stale_pages(&conn, "2026-01-01 10:00:01").unwrap(), 0);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM note_blocks WHERE page_id = 'p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn tokens_resolve_to_titles() {
        let titles = HashMap::from([("a".to_string(), "虚构词".to_string())]);
        let raw = format!("前面 {REF_OPEN}#a{REF_CLOSE} 中间 {REF_OPEN}@gone{REF_CLOSE} 后面");
        assert_eq!(resolve_ref_tokens(&raw, &titles), "前面 #虚构词 中间 @已删除的页面 后面");
        assert_eq!(strip_brackets("（ 一句话 ）"), "一句话");
        assert_eq!(strip_brackets("没有括号"), "没有括号");
    }
}
