// ══════════════════════════════════════════════
// 昼夜表 · 浮岛与约束：不钉死在某个钟点、挂在某件事后面的规划区块（比如「睡醒后」「吃完饭两小时后」），
//   以及钉在钟点上的约束（比如到点早睡）
//   一条规则存一份 JSON 文档（结构和落点算法由前端定，见 src/lib/islands/island-model.ts），后端只管存取
//   每天里面几件事做没做完，记在 plan_island_checks
//   新表，不改其他表；只多一个按日期范围读 activity_blocks 的只读接口（估「近 7 天平均」用）
//
//   两张表都跟着局域网全量同步走（export_sync / import_sync 调这里的 export_islands / import_islands），
//   规则两端各有一份（手机端 SolevupDb.kt 浮岛一段），改要同时改：
//     · 规则按 id 合并，勾选按 (date, island_id, item_id) 合并，updated_at 新的赢
//     · 删除留 deleted_at 标记：删规则、取消勾都是软删，对端才知道
//     · 时间戳只到秒：同一行每次本机改动的 updated_at 都比上一次大（同一秒就往后挪一秒，同 db.rs BUMPED_UPDATED_AT）；
//       导入时时间戳相同、对面是删除而本地还在，也采用（删除赢，同 should_apply_block_row）
//
//   GET    /api/islands                                规则列表
//   POST   /api/islands                                新建 { doc }
//   PUT    /api/islands/{id}                           覆盖 { doc }
//   DELETE /api/islands/{id}                           删除（藏起来）
//   GET    /api/island-checks?date=YYYY-MM-DD          这一天勾掉的事
//   POST   /api/island-checks                          勾 / 取消 { date, island_id, item_id, done }
//   GET    /api/activities/blocks/range?from=&to=      一段日期内的实际记录（含两端，最多 31 天）
// ══════════════════════════════════════════════

use axum::{
    extract::{Path, Query, State},
    response::Json,
    routing::{get, put},
    Router,
};
use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::api::{ApiResponse, ApiState};
use crate::db::{ActivityBlock, Database};

const MAX_DOC_BYTES: usize = 32 * 1024;
const MAX_ID_CHARS: usize = 80;
const MAX_RANGE_DAYS: i64 = 31;
const DATE_FMT: &str = "%Y-%m-%d";

#[derive(Debug, Clone, Serialize)]
pub struct Island {
    pub id: String,
    pub doc: serde_json::Value,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct IslandCheck {
    pub island_id: String,
    pub item_id: String,
    pub done_at: String,
}

/// 同步用：规则一行（doc 原样传 JSON 文本）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncIsland {
    pub id: String,
    pub doc: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

/// 同步用：某天勾掉的一件事
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncIslandCheck {
    pub date: String,
    pub island_id: String,
    pub item_id: String,
    pub done_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Deserialize)]
pub struct SaveIslandRequest {
    doc: serde_json::Value,
}

#[derive(Deserialize)]
pub struct SetCheckRequest {
    date: String,
    island_id: String,
    item_id: String,
    done: bool,
}

#[derive(Deserialize)]
struct DateQuery {
    date: String,
}

#[derive(Deserialize)]
struct RangeQuery {
    from: String,
    to: String,
}

pub(crate) fn init_island_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS plan_islands (
            id TEXT PRIMARY KEY,
            doc TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS plan_island_checks (
            date TEXT NOT NULL,
            island_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            done_at TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT '',
            deleted_at TEXT,
            PRIMARY KEY (date, island_id, item_id)
        );
    "#).map_err(|e| format!("创建浮岛表失败: {}", e))?;
    // 第一版的勾选表没有 updated_at / deleted_at（取消勾是直接删行，传不到对端）；已经有这两列时 ALTER 会报错，忽略
    let _ = conn.execute_batch("ALTER TABLE plan_island_checks ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    let _ = conn.execute_batch("ALTER TABLE plan_island_checks ADD COLUMN deleted_at TEXT");
    conn.execute_batch("UPDATE plan_island_checks SET updated_at = done_at WHERE updated_at = ''")
        .map_err(|e| format!("补浮岛勾选时间失败: {}", e))
}

fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 本机改一行时的 updated_at：这一行上次改动就在同一秒或更晚时，往后挪一秒。
/// column 是要比的列（UPSERT 里要带表名），now 是「现在」的占位符
fn bumped(column: &str, now: &str) -> String {
    format!("CASE WHEN {column} >= {now} THEN datetime({column}, '+1 second') ELSE {now} END")
}

fn doc_text(doc: &serde_json::Value) -> Result<String, String> {
    if !doc.is_object() {
        return Err("浮岛规则必须是一个 JSON 对象".into());
    }
    let text = doc.to_string();
    if text.len() > MAX_DOC_BYTES {
        return Err("浮岛规则太大了".into());
    }
    Ok(text)
}

/// 对端传来的 id：非空、不太长
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_CHARS
}

fn parse_date(s: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s, DATE_FMT).map_err(|_| format!("日期格式不对：{s}"))
}

fn get_island(conn: &Connection, id: &str) -> Result<Island, String> {
    let (doc, sort_order, created_at, updated_at): (String, i64, String, String) = conn
        .query_row(
            "SELECT doc, sort_order, created_at, updated_at FROM plan_islands WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| "找不到这条浮岛规则".to_string())?;
    let doc = serde_json::from_str(&doc).map_err(|e| format!("浮岛规则损坏: {e}"))?;
    Ok(Island { id: id.to_string(), doc, sort_order, created_at, updated_at })
}

impl Database {
    pub async fn islands_list(&self) -> Result<Vec<Island>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT id, doc, sort_order, created_at, updated_at FROM plan_islands
                 WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (id, doc, sort_order, created_at, updated_at) = row.map_err(|e| e.to_string())?;
            // 一条坏了不拖累其他的：跳过并记日志
            match serde_json::from_str(&doc) {
                Ok(doc) => out.push(Island { id, doc, sort_order, created_at, updated_at }),
                Err(e) => eprintln!("[Islands] 规则 {id} 损坏，已跳过: {e}"),
            }
        }
        Ok(out)
    }

    pub async fn islands_create(&self, doc: &serde_json::Value) -> Result<Island, String> {
        let text = doc_text(doc)?;
        let id = Uuid::new_v4().to_string();
        let now = now_str();
        let conn = self.conn.lock().await;
        let next_order: i64 = conn
            .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_islands", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO plan_islands (id, doc, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, text, next_order, now],
        )
        .map_err(|e| e.to_string())?;
        get_island(&conn, &id)
    }

    pub async fn islands_update(&self, id: &str, doc: &serde_json::Value) -> Result<Island, String> {
        let text = doc_text(doc)?;
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                &format!("UPDATE plan_islands SET doc = ?3, updated_at = {} WHERE id = ?1 AND deleted_at IS NULL", bumped("updated_at", "?2")),
                params![id, now_str(), text],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("找不到这条浮岛规则".into());
        }
        get_island(&conn, id)
    }

    pub async fn islands_delete(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                &format!("UPDATE plan_islands SET deleted_at = ?2, updated_at = {} WHERE id = ?1 AND deleted_at IS NULL", bumped("updated_at", "?2")),
                params![id, now_str()],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("找不到这条浮岛规则".into());
        }
        Ok(())
    }

    pub async fn island_checks_for_date(&self, date: &str) -> Result<Vec<IslandCheck>, String> {
        parse_date(date)?;
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare("SELECT island_id, item_id, done_at FROM plan_island_checks WHERE date = ?1 AND deleted_at IS NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![date], |r| Ok(IslandCheck { island_id: r.get(0)?, item_id: r.get(1)?, done_at: r.get(2)? }))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub async fn island_check_set(&self, req: SetCheckRequest) -> Result<(), String> {
        parse_date(&req.date)?;
        if req.island_id.is_empty() || req.item_id.is_empty() || req.island_id.len() > MAX_ID_CHARS || req.item_id.len() > MAX_ID_CHARS {
            return Err("浮岛或事项的 id 不对".into());
        }
        let conn = self.conn.lock().await;
        if req.done {
            // 已经勾着的不动（保留原来的勾选时刻）；取消过的重新勾上
            conn.execute(
                &format!(
                    "INSERT INTO plan_island_checks (date, island_id, item_id, done_at, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, ?4, NULL)
                     ON CONFLICT(date, island_id, item_id) DO UPDATE SET
                         done_at = excluded.done_at, updated_at = {}, deleted_at = NULL
                     WHERE plan_island_checks.deleted_at IS NOT NULL",
                    bumped("plan_island_checks.updated_at", "?4"),
                ),
                params![req.date, req.island_id, req.item_id, now_str()],
            )
        } else {
            conn.execute(
                &format!(
                    "UPDATE plan_island_checks SET deleted_at = ?4, updated_at = {}
                     WHERE date = ?1 AND island_id = ?2 AND item_id = ?3 AND deleted_at IS NULL",
                    bumped("updated_at", "?4"),
                ),
                params![req.date, req.island_id, req.item_id, now_str()],
            )
        }
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 全量同步导出：since 之后变过的规则和勾选（含删除标记）。规则两端一致，见文件头
    pub(crate) fn export_islands(
        conn: &Connection,
        since: Option<&str>,
    ) -> Result<(Vec<SyncIsland>, Vec<SyncIslandCheck>), String> {
        let changed = |updated_at: &str, deleted_at: Option<&str>| match since {
            Some(cursor) => updated_at > cursor || deleted_at.is_some_and(|d| d > cursor),
            None => true,
        };
        let mut stmt = conn
            .prepare("SELECT id, doc, sort_order, created_at, updated_at, deleted_at FROM plan_islands")
            .map_err(|e| e.to_string())?;
        let islands = stmt
            .query_map([], |r| {
                Ok(SyncIsland {
                    id: r.get(0)?,
                    doc: r.get(1)?,
                    sort_order: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    deleted_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .filter(|r| changed(&r.updated_at, r.deleted_at.as_deref()))
            .collect();
        let mut stmt = conn
            .prepare("SELECT date, island_id, item_id, done_at, updated_at, deleted_at FROM plan_island_checks")
            .map_err(|e| e.to_string())?;
        let checks = stmt
            .query_map([], |r| {
                Ok(SyncIslandCheck {
                    date: r.get(0)?,
                    island_id: r.get(1)?,
                    item_id: r.get(2)?,
                    done_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    deleted_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .filter(|r| changed(&r.updated_at, r.deleted_at.as_deref()))
            .collect();
        Ok((islands, checks))
    }

    /// 全量同步导入，返回 (写进去的规则数, 写进去的勾选数, 跳过数)。规则两端一致，见文件头
    pub(crate) fn import_islands(
        conn: &Connection,
        islands: Vec<SyncIsland>,
        checks: Vec<SyncIslandCheck>,
    ) -> Result<(usize, usize, usize), String> {
        let (mut applied_islands, mut applied_checks, mut skipped) = (0, 0, 0);
        for row in islands {
            let doc_ok = row.doc.len() <= MAX_DOC_BYTES
                && serde_json::from_str::<serde_json::Value>(&row.doc).is_ok_and(|v| v.is_object());
            if !valid_id(&row.id) || !doc_ok {
                skipped += 1;
                continue;
            }
            let n = conn
                .execute(
                    "INSERT INTO plan_islands (id, doc, sort_order, created_at, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET
                         doc = excluded.doc, sort_order = excluded.sort_order, created_at = excluded.created_at,
                         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
                     WHERE excluded.updated_at > plan_islands.updated_at
                        OR (excluded.updated_at = plan_islands.updated_at
                            AND excluded.deleted_at IS NOT NULL AND plan_islands.deleted_at IS NULL)",
                    params![row.id, row.doc, row.sort_order, row.created_at, row.updated_at, row.deleted_at],
                )
                .map_err(|e| e.to_string())?;
            if n > 0 { applied_islands += 1 } else { skipped += 1 }
        }
        for row in checks {
            if parse_date(&row.date).is_err() || !valid_id(&row.island_id) || !valid_id(&row.item_id) {
                skipped += 1;
                continue;
            }
            let n = conn
                .execute(
                    "INSERT INTO plan_island_checks (date, island_id, item_id, done_at, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(date, island_id, item_id) DO UPDATE SET
                         done_at = excluded.done_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
                     WHERE excluded.updated_at > plan_island_checks.updated_at
                        OR (excluded.updated_at = plan_island_checks.updated_at
                            AND excluded.deleted_at IS NOT NULL AND plan_island_checks.deleted_at IS NULL)",
                    params![row.date, row.island_id, row.item_id, row.done_at, row.updated_at, row.deleted_at],
                )
                .map_err(|e| e.to_string())?;
            if n > 0 { applied_checks += 1 } else { skipped += 1 }
        }
        Ok((applied_islands, applied_checks, skipped))
    }

    /// 一段日期内的实际记录（只读）
    pub async fn activity_blocks_range(&self, from: &str, to: &str) -> Result<Vec<ActivityBlock>, String> {
        let (start, end) = (parse_date(from)?, parse_date(to)?);
        let days = (end - start).num_days();
        if days < 0 || days >= MAX_RANGE_DAYS {
            return Err(format!("日期范围要在 1 到 {MAX_RANGE_DAYS} 天之间"));
        }
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT date, minute, tag_id, note, created_at FROM activity_blocks
                 WHERE date >= ?1 AND date <= ?2 AND deleted_at IS NULL
                 ORDER BY date ASC, minute ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![from, to], |r| {
                Ok(ActivityBlock { date: r.get(0)?, minute: r.get(1)?, tag_id: r.get(2)?, note: r.get(3)?, created_at: r.get(4)? })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }
}

// ── HTTP ──

pub fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/islands", get(list).post(create))
        .route("/api/islands/{id}", put(update).delete(remove))
        .route("/api/island-checks", get(checks).post(set_check))
        .route("/api/activities/blocks/range", get(blocks_range))
}

fn reply<T: Serialize>(r: Result<T, String>) -> Json<ApiResponse<T>> {
    match r {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

async fn list(State(state): State<ApiState>) -> Json<ApiResponse<Vec<Island>>> {
    reply(state.db.islands_list().await)
}

async fn create(State(state): State<ApiState>, Json(req): Json<SaveIslandRequest>) -> Json<ApiResponse<Island>> {
    reply(state.db.islands_create(&req.doc).await)
}

async fn update(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(req): Json<SaveIslandRequest>,
) -> Json<ApiResponse<Island>> {
    reply(state.db.islands_update(&id, &req.doc).await)
}

async fn remove(State(state): State<ApiState>, Path(id): Path<String>) -> Json<ApiResponse<()>> {
    reply(state.db.islands_delete(&id).await)
}

async fn checks(State(state): State<ApiState>, Query(q): Query<DateQuery>) -> Json<ApiResponse<Vec<IslandCheck>>> {
    reply(state.db.island_checks_for_date(&q.date).await)
}

async fn set_check(State(state): State<ApiState>, Json(req): Json<SetCheckRequest>) -> Json<ApiResponse<()>> {
    reply(state.db.island_check_set(req).await)
}

async fn blocks_range(State(state): State<ApiState>, Query(q): Query<RangeQuery>) -> Json<ApiResponse<Vec<ActivityBlock>>> {
    reply(state.db.activity_blocks_range(&q.from, &q.to).await)
}
