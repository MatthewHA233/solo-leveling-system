// ══════════════════════════════════════════════
// Local API — Axum HTTP Server
// 局域网访问: http://<ip>:49733
// ══════════════════════════════════════════════

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{delete, get, patch, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use uuid;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};
use tower_http::cors::{Any, CorsLayer};

use crate::db::{
    AppendChatMessagesRequest, ChatMessage, ChatSession, Database, UpdateChatSessionRequest,
    BiliHistoryRow, UpsertBiliItem, BiliSpan, BiliDayCount, Goal, PresenceSpan,
    ActivityCategory, ActivityTag, ActivityBlock, ActivityPalette, PlanNode, PlannedBlock,
    AddCategoryRequest, AddTagRequest, PaintBlocksRequest, EraseBlocksRequest,
    AddPlanNodeRequest, UpdatePlanNodeRequest, PaintPlannedBlocksRequest,
    UpdateCategoryRequest, RenamePathRequest, PerceptionSpan, SyncExport, SyncImportResult,
    LinkedDevice,
};
use crate::bili_download::{BiliDownloadState, PlayUrlMeta, QualityProbe, deliver_playurl_result, deliver_probe_result};
use crate::sync_discovery::{SyncDiscoveryState, SyncPeer};
use crate::sync_engine::{self, SyncRoundResult};

// ── Bilibili 回调状态 ──

pub struct BiliState {
    pub pending: Mutex<Option<oneshot::Sender<Result<serde_json::Value, String>>>>,
    pub pending_nav: Mutex<Option<oneshot::Sender<Result<serde_json::Value, String>>>>,
}

impl BiliState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(None),
            pending_nav: Mutex::new(None),
        }
    }
}

// ── API State ──

pub struct BailianState {
    pub pending_quota: Mutex<Option<oneshot::Sender<Result<Vec<crate::db::ModelFreeQuota>, String>>>>,
    pub pending_account: Mutex<Option<oneshot::Sender<Result<serde_json::Value, String>>>>,
    pub quota_progress: Mutex<VecDeque<serde_json::Value>>,
}

impl BailianState {
    pub fn new() -> Self {
        Self {
            pending_quota: Mutex::new(None),
            pending_account: Mutex::new(None),
            quota_progress: Mutex::new(VecDeque::new()),
        }
    }
}

#[derive(Clone)]
pub struct ApiState {
    pub db: Arc<Database>,
    pub bili: Arc<BiliState>,
    pub bailian: Arc<BailianState>,
    pub bili_dl: Arc<BiliDownloadState>,
    pub sync_discovery: Arc<SyncDiscoveryState>,
    // ⚠️ 必须包 Arc：AppHandle::clone 会透传到内部 Rc<tao::EventLoopRunner>，
    // axum 每收一个 HTTP 请求都会 Clone 整个 ApiState，落在 tokio-rt-worker
    // 上 → 非主线程 Rc::clone = UB → CPU illegal instruction abort。
    // Arc<AppHandle>::clone 是原子计数，永远不触发内层 Rc::clone。
    // emit 通过 Deref 拿 &AppHandle，不需要 clone。
    // 详见 tauri issue #15408。
    pub app_handle: Arc<AppHandle>,
}

// ── Response Types ──

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: Serialize> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self { success: true, data: Some(data), error: None }
    }

    pub fn error(msg: &str) -> Self {
        Self { success: false, data: None, error: Some(msg.to_string()) }
    }
}

// ── Query Params ──

#[derive(Deserialize)]
struct DateQuery {
    date: String,
}

#[derive(Deserialize)]
struct ProjectTagQuery {
    project_tag_id: i64,
}

#[derive(Deserialize)]
struct LimitQuery {
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct SessionSearchQuery {
    q: String,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct BiliResultPayload {
    ok: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct BailianQuotaPayload {
    ok: Option<Vec<crate::db::ModelFreeQuota>>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct BailianAccountPayload {
    ok: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct BiliHistoryQuery {
    page: Option<i64>,
    page_size: Option<i64>,
    unlinked_only: Option<bool>,
}

#[derive(Deserialize)]
struct BiliSearchQuery {
    q: String,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct BiliDayCountQuery {
    from: String,   // "YYYY-MM-DD"
    to: String,     // "YYYY-MM-DD"
}

#[derive(Serialize)]
struct BiliHistoryPageResult {
    items: Vec<BiliHistoryRow>,
    total: i64,
    page: i64,
    page_size: i64,
}

#[derive(Deserialize)]
struct LinkBiliPayload {
    bvids: Vec<String>,
    event_id: String,
}

#[derive(Deserialize)]
struct SyncExportQuery {
    since: Option<String>,
}

#[derive(Serialize)]
struct SyncHello {
    device_id: String,
    pair_code: String,
    server_time: String,
    protocol_version: i32,
    tables: Vec<&'static str>,
    alias: String,
    device_type: String,
    device_model: String,
}

#[derive(Deserialize)]
struct SetAliasPayload {
    alias: String,
}

#[derive(Deserialize)]
struct AddLinkPayload {
    device_id: String,
    alias: String,
    last_base: String,
}

// ── Handlers ──

/// GET /api/health
async fn health() -> Json<ApiResponse<&'static str>> {
    Json(ApiResponse::ok("ok"))
}

/// GET /api/perception/screenshot?date=2026-04-04&time=13:30:00
async fn get_perception_screenshot(
    Query(query): Query<ScreenshotQuery>,
) -> Response {
    let path = tokio::task::spawn_blocking({
        let date = query.date.clone();
        let time = query.time.clone();
        move || crate::perception::find_screenshot_near(&date, &time)
    }).await.ok().flatten();

    match path {
        None => (StatusCode::NOT_FOUND, "no screenshot").into_response(),
        Some(p) => {
            match tokio::fs::read(&p).await {
                Err(_) => (StatusCode::NOT_FOUND, "file unreadable").into_response(),
                Ok(bytes) => {
                    ([(axum::http::header::CONTENT_TYPE, image_mime_for_path(&p))], bytes).into_response()
                }
            }
        }
    }
}

fn image_mime_for_path(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/jpeg",
    }
}

#[derive(Deserialize)]
struct ScreenshotQuery {
    date: String,
    time: String,
}

/// GET /api/perception/app-icon?name=<group_name>
async fn get_perception_app_icon(
    State(state): State<ApiState>,
    Query(query): Query<AppIconQuery>,
) -> Response {
    let name = query.name.clone();
    if let Some(bytes) = state.db.get_perception_app_icon_png(&name).await.ok().flatten() {
        return ([(axum::http::header::CONTENT_TYPE, "image/bmp")], bytes).into_response();
    }

    (StatusCode::NOT_FOUND, "no icon").into_response()
}

#[derive(Deserialize)]
struct AppIconQuery {
    name: String,
}

/// GET /api/perception/spans?date=2026-04-04
async fn get_perception_spans(
    State(state): State<ApiState>,
    Query(query): Query<DateQuery>,
) -> Json<ApiResponse<Vec<PerceptionSpan>>> {
    match state.db.get_perception_spans_for_date(&query.date).await {
        Ok(spans) => Json(ApiResponse::ok(spans)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/activities/data-days?from=2026-04-01&to=2026-04-30
/// 返回区间内"有数据"的日期列表（聚合 activity_blocks / bili / presence / perception）
async fn get_data_days(
    State(state): State<ApiState>,
    Query(query): Query<BiliDayCountQuery>,
) -> Json<ApiResponse<Vec<String>>> {
    match state.db.get_data_days(&query.from, &query.to).await {
        Ok(days) => Json(ApiResponse::ok(days)),
        Err(e)   => Json(ApiResponse::error(&e)),
    }
}

// ── 活动记录：标签库 + 5min 块 ──

/// GET /api/activities/palette — 整库 categories + tags
async fn get_activity_palette(
    State(state): State<ApiState>,
) -> Json<ApiResponse<ActivityPalette>> {
    match state.db.get_activity_palette().await {
        Ok(palette) => Json(ApiResponse::ok(palette)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/activities/categories
async fn add_activity_category(
    State(state): State<ApiState>,
    Json(body): Json<AddCategoryRequest>,
) -> Json<ApiResponse<ActivityCategory>> {
    match state.db.add_activity_category(body).await {
        Ok(c) => Json(ApiResponse::ok(c)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// DELETE /api/activities/categories/{id}
async fn delete_activity_category(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
) -> Json<ApiResponse<()>> {
    match state.db.delete_activity_category(id).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// PATCH /api/activities/categories/{id} — 改名 / 改颜色，级联更新 tag 路径
async fn update_activity_category(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
    Json(mut body): Json<UpdateCategoryRequest>,
) -> Json<ApiResponse<()>> {
    body.id = id;
    match state.db.update_activity_category(body).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/activities/tags/rename — 重命名标签路径中的某段（叶子或中间）
async fn rename_activity_path(
    State(state): State<ApiState>,
    Json(body): Json<RenamePathRequest>,
) -> Json<ApiResponse<()>> {
    match state.db.rename_activity_path(body).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/activities/tags
async fn add_activity_tag(
    State(state): State<ApiState>,
    Json(body): Json<AddTagRequest>,
) -> Json<ApiResponse<ActivityTag>> {
    match state.db.add_activity_tag(body).await {
        Ok(t) => Json(ApiResponse::ok(t)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// DELETE /api/activities/tags/{id}
async fn delete_activity_tag(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
) -> Json<ApiResponse<()>> {
    match state.db.delete_activity_tag(id).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/activities/blocks?date=2026-04-04
async fn get_activity_blocks(
    State(state): State<ApiState>,
    Query(query): Query<DateQuery>,
) -> Json<ApiResponse<Vec<ActivityBlock>>> {
    match state.db.get_activity_blocks_by_date(&query.date).await {
        Ok(blocks) => Json(ApiResponse::ok(blocks)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/activities/blocks/paint
async fn paint_activity_blocks(
    State(state): State<ApiState>,
    Json(body): Json<PaintBlocksRequest>,
) -> Json<ApiResponse<i64>> {
    match state.db.paint_activity_blocks(body).await {
        Ok(n) => Json(ApiResponse::ok(n)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/activities/blocks/erase
async fn erase_activity_blocks(
    State(state): State<ApiState>,
    Json(body): Json<EraseBlocksRequest>,
) -> Json<ApiResponse<i64>> {
    match state.db.erase_activity_blocks(body).await {
        Ok(n) => Json(ApiResponse::ok(n)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/plans/nodes?project_tag_id=123
async fn get_plan_nodes(
    State(state): State<ApiState>,
    Query(query): Query<ProjectTagQuery>,
) -> Json<ApiResponse<Vec<PlanNode>>> {
    match state.db.get_plan_nodes_by_project(query.project_tag_id).await {
        Ok(nodes) => Json(ApiResponse::ok(nodes)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/plans/nodes
async fn add_plan_node(
    State(state): State<ApiState>,
    Json(body): Json<AddPlanNodeRequest>,
) -> Json<ApiResponse<PlanNode>> {
    match state.db.add_plan_node(body).await {
        Ok(node) => Json(ApiResponse::ok(node)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// PATCH /api/plans/nodes/{id}
async fn update_plan_node(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
    Json(mut body): Json<UpdatePlanNodeRequest>,
) -> Json<ApiResponse<()>> {
    body.id = id;
    match state.db.update_plan_node(body).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// DELETE /api/plans/nodes/{id}
async fn delete_plan_node(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
) -> Json<ApiResponse<()>> {
    match state.db.delete_plan_node(id).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/plans/blocks?date=2026-04-04
async fn get_planned_blocks(
    State(state): State<ApiState>,
    Query(query): Query<DateQuery>,
) -> Json<ApiResponse<Vec<PlannedBlock>>> {
    match state.db.get_planned_blocks_by_date(&query.date).await {
        Ok(blocks) => Json(ApiResponse::ok(blocks)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/plans/blocks/paint
async fn paint_planned_blocks(
    State(state): State<ApiState>,
    Json(body): Json<PaintPlannedBlocksRequest>,
) -> Json<ApiResponse<i64>> {
    match state.db.paint_planned_blocks(body).await {
        Ok(n) => Json(ApiResponse::ok(n)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/plans/blocks/erase
async fn erase_planned_blocks(
    State(state): State<ApiState>,
    Json(body): Json<EraseBlocksRequest>,
) -> Json<ApiResponse<i64>> {
    match state.db.erase_planned_blocks(body).await {
        Ok(n) => Json(ApiResponse::ok(n)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/sync/hello
async fn sync_hello(State(state): State<ApiState>) -> Json<ApiResponse<SyncHello>> {
    match state.db.sync_device_id().await {
        Ok(device_id) => {
            let alias = state.sync_discovery.alias();
            Json(ApiResponse::ok(SyncHello {
                pair_code: crate::db::sync_pair_code(&device_id),
                device_id,
                server_time: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                protocol_version: 1,
                tables: vec![
                    "activity_categories",
                    "activity_tags",
                    "activity_blocks",
                    "plan_nodes",
                    "planned_blocks",
                    "model_api_keys",
                    "model_call_log",
                    "model_free_quota",
                    "feature_bindings",
                ],
                alias,
                device_type: state.sync_discovery.device_type.to_string(),
                device_model: state.sync_discovery.device_model.to_string(),
            }))
        }
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/sync/alias  — 改本机别名（写入 sync_meta + 广播状态）
async fn sync_set_alias(
    State(state): State<ApiState>,
    Json(payload): Json<SetAliasPayload>,
) -> Json<ApiResponse<String>> {
    match state.db.set_sync_alias(payload.alias).await {
        Ok(stored) => {
            state.sync_discovery.set_alias(stored.clone());
            // 通知 LAN 上其他设备别名已更新（让对端缓存的 alias 也刷新）
            let announcer = state.sync_discovery.clone();
            tokio::spawn(async move {
                let _ = announcer.send_announcement().await;
            });
            Json(ApiResponse::ok(stored))
        }
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/sync/export?since=YYYY-MM-DD%20HH:MM:SS
async fn sync_export(
    State(state): State<ApiState>,
    Query(query): Query<SyncExportQuery>,
) -> Json<ApiResponse<SyncExport>> {
    match state.db.export_sync(query.since).await {
        Ok(snapshot) => Json(ApiResponse::ok(snapshot)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/sync/import
async fn sync_import(
    State(state): State<ApiState>,
    Json(payload): Json<SyncExport>,
) -> Json<ApiResponse<SyncImportResult>> {
    let from_device_id = payload.device_id.clone();
    match state.db.import_sync(payload).await {
        Ok(result) => {
            // 通知前端：数据库被对端 import 改过了，全局重拉
            let total = result.activity_categories
                + result.activity_tags
                + result.activity_blocks
                + result.plan_nodes
                + result.planned_blocks;
            if total > 0 {
                let _ = state.app_handle.emit("sync:imported", serde_json::json!({
                    "from_device_id": from_device_id,
                    "changed": total,
                    "result": &result,
                }));
            }
            Json(ApiResponse::ok(result))
        }
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/sync/links — 已链接（持久自动同步）设备列表
async fn sync_links(State(state): State<ApiState>) -> Json<ApiResponse<Vec<LinkedDevice>>> {
    match state.db.list_linked_devices().await {
        Ok(list) => Json(ApiResponse::ok(list)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/sync/links — 建立链接（写入 linked_devices 并立刻同步一轮）
async fn sync_link_add(
    State(state): State<ApiState>,
    Json(body): Json<AddLinkPayload>,
) -> Json<ApiResponse<LinkedDevice>> {
    match state.db.add_linked_device(body.device_id, body.alias, body.last_base.clone()).await {
        Ok(link) => {
            let db_for_sync = state.db.clone();
            let app_for_sync = state.app_handle.clone();
            let base = link.last_base.clone();
            let device_id = link.device_id.clone();
            tokio::spawn(async move {
                let _ = app_for_sync.emit("sync:started", serde_json::json!({ "device_id": &device_id }));
                let result = sync_engine::bidirectional_sync(db_for_sync.clone(), &base).await;
                if result.is_ok() {
                    let _ = db_for_sync.touch_link_synced(&device_id, &base).await;
                }
                let _ = app_for_sync.emit("sync:finished", serde_json::json!({
                    "device_id": &device_id,
                    "ok": result.is_ok(),
                    "error": result.as_ref().err().map(|s| s.as_str()),
                    "result": result.as_ref().ok(),
                }));
            });
            Json(ApiResponse::ok(link))
        }
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// DELETE /api/sync/links/{device_id} — 解除链接
async fn sync_link_remove(
    State(state): State<ApiState>,
    Path(device_id): Path<String>,
) -> Json<ApiResponse<()>> {
    match state.db.remove_linked_device(&device_id).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/sync/links/{device_id}/sync — 立即手动同步一次
async fn sync_link_run(
    State(state): State<ApiState>,
    Path(device_id): Path<String>,
) -> Json<ApiResponse<SyncRoundResult>> {
    let links = match state.db.list_linked_devices().await {
        Ok(l) => l,
        Err(e) => return Json(ApiResponse::error(&e)),
    };
    let Some(link) = links.into_iter().find(|l| l.device_id == device_id) else {
        return Json(ApiResponse::error("设备未链接"));
    };
    let _ = state.app_handle.emit("sync:started", serde_json::json!({ "device_id": &device_id }));
    let result = sync_engine::bidirectional_sync(state.db.clone(), &link.last_base).await;
    let _ = state.app_handle.emit("sync:finished", serde_json::json!({
        "device_id": &device_id,
        "ok": result.is_ok(),
        "error": result.as_ref().err().map(|s| s.as_str()),
        "result": result.as_ref().ok(),
    }));
    match result {
        Ok(round) => {
            let _ = state.db.touch_link_synced(&device_id, &link.last_base).await;
            Json(ApiResponse::ok(round))
        }
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/sync/peers
async fn sync_peers(State(state): State<ApiState>) -> Json<ApiResponse<Vec<SyncPeer>>> {
    Json(ApiResponse::ok(state.sync_discovery.peers().await))
}

/// POST /api/sync/discover
async fn sync_discover(State(state): State<ApiState>) -> Json<ApiResponse<Vec<SyncPeer>>> {
    if let Err(e) = state.sync_discovery.send_announcement().await {
        return Json(ApiResponse::error(&e));
    }
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    Json(ApiResponse::ok(state.sync_discovery.peers().await))
}

/// GET /api/sessions?limit=N
async fn list_chat_sessions(
    State(state): State<ApiState>,
    Query(query): Query<LimitQuery>,
) -> Json<ApiResponse<Vec<ChatSession>>> {
    let limit = query.limit.unwrap_or(20).min(100);
    match state.db.get_recent_chat_sessions(limit).await {
        Ok(sessions) => Json(ApiResponse::ok(sessions)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/sessions/search?q=xxx&limit=N
async fn search_chat_sessions(
    State(state): State<ApiState>,
    Query(query): Query<SessionSearchQuery>,
) -> Json<ApiResponse<Vec<crate::db::SessionSearchHit>>> {
    let q = query.q.trim();
    if q.is_empty() {
        return Json(ApiResponse::ok(Vec::new()));
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    match state.db.search_chat_sessions(q, limit).await {
        Ok(hits) => Json(ApiResponse::ok(hits)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/sessions
async fn create_chat_session(
    State(state): State<ApiState>,
) -> Json<ApiResponse<ChatSession>> {
    match state.db.create_chat_session().await {
        Ok(session) => Json(ApiResponse::ok(session)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/sessions/:id/messages
async fn get_chat_messages(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Json<ApiResponse<Vec<ChatMessage>>> {
    match state.db.get_chat_messages(&id).await {
        Ok(messages) => Json(ApiResponse::ok(messages)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// POST /api/sessions/:id/messages
async fn append_chat_messages(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<AppendChatMessagesRequest>,
) -> Json<ApiResponse<()>> {
    match state.db.append_chat_messages(&id, body).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// PATCH /api/sessions/:id
async fn update_chat_session(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateChatSessionRequest>,
) -> Json<ApiResponse<()>> {
    match state.db.update_chat_session(&id, body).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// DELETE /api/sessions/:id
async fn delete_chat_session(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Json<ApiResponse<()>> {
    match state.db.delete_chat_session(&id).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

#[derive(Deserialize)]
struct CleanupQuery {
    except: Option<String>,
}

/// POST /api/sessions/cleanup_empty?except=ID
/// 删除所有没有任何 chat_messages 的会话；except 参数排除当前正在使用的会话 id。
/// 返回被删的 session id 列表，前端用于本地状态同步。
async fn cleanup_empty_chat_sessions(
    State(state): State<ApiState>,
    Query(q): Query<CleanupQuery>,
) -> Json<ApiResponse<Vec<String>>> {
    match state.db.delete_empty_chat_sessions(q.except.as_deref()).await {
        Ok(ids) => Json(ApiResponse::ok(ids)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

#[derive(Deserialize)]
struct LocalFileQuery {
    path: String,
}

/// GET /api/local-video?path=<absolute-path>
/// 本地视频流端点（绕过 Tauri asset.localhost — 它响应里漏 Accept-Ranges 头，Chromium 不肯走流式）
/// 完整支持 Range：返回 206 + Content-Range + Accept-Ranges: bytes
async fn serve_local_video(
    Query(q): Query<LocalFileQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    use axum::body::Body;
    use axum::http::header;
    use tokio::fs::File;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
    use tokio_util::io::ReaderStream;

    let path = std::path::PathBuf::from(&q.path);

    // 安全：拒绝目录跳转 + 仅允许常见视频/音频后缀
    let ok_ext = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .map(|e| matches!(e.as_str(), "mp4" | "m4v" | "mov" | "webm" | "mkv" | "wav" | "mp3" | "m4a" | "aac"))
        .unwrap_or(false);
    if !ok_ext {
        return (StatusCode::BAD_REQUEST, "unsupported extension").into_response();
    }

    let mut file = match File::open(&path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };
    let total = match file.metadata().await {
        Ok(m) => m.len(),
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "metadata failed").into_response(),
    };

    let content_type = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .map(|e| match e.as_str() {
            "mp4" | "m4v" => "video/mp4",
            "mov"         => "video/quicktime",
            "webm"        => "video/webm",
            "mkv"         => "video/x-matroska",
            "wav"         => "audio/wav",
            "mp3"         => "audio/mpeg",
            "m4a" | "aac" => "audio/mp4",
            _ => "application/octet-stream",
        })
        .unwrap_or("application/octet-stream");

    // 解析 Range: bytes=START-END （END 可省）
    let range_str = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let (start, end, status) = match range_str.and_then(|s| parse_byte_range(s, total)) {
        Some((s, e)) => (s, e, StatusCode::PARTIAL_CONTENT),
        None => (0, total.saturating_sub(1), StatusCode::OK),
    };

    if start >= total {
        return (StatusCode::RANGE_NOT_SATISFIABLE, "out of range").into_response();
    }
    if let Err(_) = file.seek(SeekFrom::Start(start)).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, "seek failed").into_response();
    }
    let length = end - start + 1;
    let limited = file.take(length);
    let body = Body::from_stream(ReaderStream::new(limited));

    let mut resp = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(header::CACHE_CONTROL, "no-cache");

    if status == StatusCode::PARTIAL_CONTENT {
        resp = resp.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, end, total),
        );
    }

    resp.body(body).unwrap_or_else(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, "build body failed").into_response()
    })
}

/// 解析 "bytes=START-END" / "bytes=START-" 形式；返回闭区间 (start, end)。
/// 不支持 multi-range（少见，<video> 不会发）
fn parse_byte_range(s: &str, total: u64) -> Option<(u64, u64)> {
    let s = s.strip_prefix("bytes=")?;
    let (lo, hi) = s.split_once('-')?;
    let start: u64 = lo.trim().parse().ok()?;
    let end: u64 = if hi.trim().is_empty() {
        total.saturating_sub(1)
    } else {
        hi.trim().parse().ok()?
    };
    if end >= total { Some((start, total - 1)) } else { Some((start, end)) }
}

/// 从 Bilibili API JSON 响应中提取可 upsert 的条目
fn extract_bili_items(data: &serde_json::Value) -> Vec<UpsertBiliItem> {
    let list = data
        .get("data").and_then(|d| d.get("list"))
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();

    list.iter().filter_map(|item| {
        let history = item.get("history")?;
        let bvid = history.get("bvid")?.as_str().unwrap_or("").to_string();
        if bvid.is_empty() { return None; }
        Some(UpsertBiliItem {
            bvid,
            oid:         history.get("oid").and_then(|v| v.as_i64()).unwrap_or(0),
            title:       item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            author_name: item.get("author_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            cover:       item.get("cover").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            duration:    item.get("duration").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            progress:    item.get("progress").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            view_at:     item.get("view_at").and_then(|v| v.as_i64()).unwrap_or(0),
        })
    }).collect()
}

/// POST /api/bilibili/nav_result — 接收 bilibili 内嵌 WebView 调 nav 接口的回调（仅用于读用户名/登录状态）
async fn recv_bili_nav_result(
    State(state): State<ApiState>,
    Json(body): Json<BiliResultPayload>,
) -> Json<ApiResponse<()>> {
    let result = match body.ok {
        Some(data) => Ok(data),
        None => Err(body.error.unwrap_or_else(|| "未知错误".to_string())),
    };
    let mut guard = state.bili.pending_nav.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(result);
    }
    Json(ApiResponse::ok(()))
}

/// POST /api/bilibili/result — 接收 bilibili 内嵌 WebView 注入 JS 的回调结果，同时入库
async fn recv_bili_result(
    State(state): State<ApiState>,
    Json(body): Json<BiliResultPayload>,
) -> Json<ApiResponse<()>> {
    let result = if let Some(ref data) = body.ok {
        // 解析并入库
        let items = extract_bili_items(data);
        if !items.is_empty() {
            if let Err(e) = state.db.upsert_bili_history(&items).await {
                log::warn!("[Bili] upsert 失败: {}", e);
            } else {
                log::info!("[Bili] upsert {} 条历史", items.len());
            }
        }
        Ok(body.ok.unwrap())
    } else {
        Err(body.error.unwrap_or_else(|| "未知错误".to_string()))
    };

    let mut guard = state.bili.pending.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(result);
    }

    Json(ApiResponse::ok(()))
}

// ── B站下载 playurl 回调 ──

async fn recv_bailian_quota_result(
    State(state): State<ApiState>,
    Json(body): Json<BailianQuotaPayload>,
) -> Json<ApiResponse<()>> {
    let result = match body.ok {
        Some(rows) => {
            if let Err(e) = state.db.upsert_model_free_quotas(&rows).await {
                log::warn!("[Bailian] quota cache upsert failed: {}", e);
            }
            Ok(rows)
        }
        None => Err(body.error.unwrap_or_else(|| "unknown error".to_string())),
    };

    let mut guard = state.bailian.pending_quota.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(result);
    }

    Json(ApiResponse::ok(()))
}

async fn recv_bailian_account_result(
    State(state): State<ApiState>,
    Json(body): Json<BailianAccountPayload>,
) -> Json<ApiResponse<()>> {
    let result = match body.ok {
        Some(data) => Ok(data),
        None => Err(body.error.unwrap_or_else(|| "unknown error".to_string())),
    };

    let mut guard = state.bailian.pending_account.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(result);
    }

    Json(ApiResponse::ok(()))
}

async fn recv_bailian_quota_progress(
    State(state): State<ApiState>,
    Json(body): Json<serde_json::Value>,
) -> Json<ApiResponse<()>> {
    let mut progress = state.bailian.quota_progress.lock().await;
    if progress.len() >= 160 {
        progress.pop_front();
    }
    progress.push_back(body);
    Json(ApiResponse::ok(()))
}

#[derive(Deserialize)]
struct PlayUrlResultPayload {
    ok: Option<PlayUrlMeta>,
    error: Option<String>,
}

/// POST /api/bilibili/playurl_result — 接收 WebView 注入 JS 拿到的 DASH 流地址
async fn recv_bili_playurl_result(
    State(state): State<ApiState>,
    Json(body): Json<PlayUrlResultPayload>,
) -> Json<ApiResponse<()>> {
    let result = match body.ok {
        Some(meta) => Ok(meta),
        None => Err(body.error.unwrap_or_else(|| "未知错误".to_string())),
    };
    deliver_playurl_result(&state.bili_dl, result).await;
    Json(ApiResponse::ok(()))
}

#[derive(Deserialize)]
struct QualitiesResultPayload {
    ok: Option<QualityProbe>,
    error: Option<String>,
}

/// POST /api/bilibili/qualities_result — 接收清晰度探测回调
async fn recv_bili_qualities_result(
    State(state): State<ApiState>,
    Json(body): Json<QualitiesResultPayload>,
) -> Json<ApiResponse<()>> {
    let result = match body.ok {
        Some(probe) => Ok(probe),
        None => Err(body.error.unwrap_or_else(|| "未知错误".to_string())),
    };
    deliver_probe_result(&state.bili_dl, result).await;
    Json(ApiResponse::ok(()))
}

/// GET /api/bilibili/spans/day?date=2026-04-06
async fn get_bili_spans_day(
    State(state): State<ApiState>,
    Query(query): Query<DateQuery>,
) -> Json<ApiResponse<Vec<BiliSpan>>> {
    match state.db.get_bili_spans_for_date(&query.date).await {
        Ok(spans) => Json(ApiResponse::ok(spans)),
        Err(e)    => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/bilibili/day-counts?from=2026-04-01&to=2026-04-30
async fn get_bili_day_counts(
    State(state): State<ApiState>,
    Query(query): Query<BiliDayCountQuery>,
) -> Json<ApiResponse<Vec<BiliDayCount>>> {
    match state.db.get_bili_day_counts(&query.from, &query.to).await {
        Ok(rows) => Json(ApiResponse::ok(rows)),
        Err(e)   => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/bilibili/history?page=0&page_size=50&unlinked_only=false
async fn get_bili_history(
    State(state): State<ApiState>,
    Query(query): Query<BiliHistoryQuery>,
) -> Json<ApiResponse<BiliHistoryPageResult>> {
    let page      = query.page.unwrap_or(0).max(0);
    let page_size = query.page_size.unwrap_or(50).clamp(1, 200);
    let unlinked  = query.unlinked_only.unwrap_or(false);

    match state.db.get_bili_history(page, page_size, unlinked).await {
        Ok((items, total)) => Json(ApiResponse::ok(BiliHistoryPageResult { items, total, page, page_size })),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// GET /api/bilibili/history/search?q=xxx&limit=30 — 模糊搜索 title/author/bvid
async fn search_bili_history(
    State(state): State<ApiState>,
    Query(query): Query<BiliSearchQuery>,
) -> Json<ApiResponse<Vec<BiliHistoryRow>>> {
    let limit = query.limit.unwrap_or(30).clamp(1, 200);
    match state.db.search_bili_history(&query.q, limit).await {
        Ok(items) => Json(ApiResponse::ok(items)),
        Err(e)    => Json(ApiResponse::error(&e)),
    }
}

/// PUT /api/bilibili/history/link — 将 bvids 关联到事件
async fn link_bili_to_event(
    State(state): State<ApiState>,
    Json(body): Json<LinkBiliPayload>,
) -> Json<ApiResponse<()>> {
    match state.db.link_bili_to_event(&body.bvids, &body.event_id).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

// ── Bilibili 封面图片代理 ──

#[derive(Deserialize)]
struct CoverQuery {
    url: String,
}

/// GET /api/bilibili/cover?url=https://i0.hdslb.com/...
/// 带正确 Referer 头代理请求 B站图片，绕过防盗链
async fn proxy_bili_cover(
    Query(query): Query<CoverQuery>,
) -> Response {
    // 只允许 B站 CDN 域名，防止 SSRF
    let allowed = ["i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com", "hdslb.com"];
    let is_allowed = url::Url::parse(&query.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| allowed.iter().any(|a| host == *a || host.ends_with(&format!(".{}", a))))
        .unwrap_or(false);

    if !is_allowed {
        return (StatusCode::FORBIDDEN, "不允许的图片域名").into_response();
    }

    let client = match reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
    {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let resp = match client
        .get(&query.url)
        .header("Referer", "https://www.bilibili.com/")
        .header("Origin", "https://www.bilibili.com")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    };

    if !resp.status().is_success() {
        return (StatusCode::BAD_GATEWAY, format!("上游返回 {}", resp.status())).into_response();
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    };

    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, content_type),
         (axum::http::header::CACHE_CONTROL, "public, max-age=86400".to_string())],
        bytes,
    ).into_response()
}

// ── Server ──

// ── Goals ──

#[derive(Deserialize)]
struct GoalStatusQuery { status: Option<String> }

#[derive(Deserialize)]
struct CreateGoalBody { title: String, tags: Option<Vec<String>> }

#[derive(Deserialize)]
struct UpdateGoalBody {
    title: Option<String>,
    status: Option<String>,
    tags: Option<Vec<String>>,
}

async fn get_goals(
    State(s): State<ApiState>,
    Query(q): Query<GoalStatusQuery>,
) -> Json<ApiResponse<Vec<Goal>>> {
    match s.db.get_goals(q.status.as_deref()).await {
        Ok(goals) => Json(ApiResponse::ok(goals)),
        Err(e)    => Json(ApiResponse::error(&e)),
    }
}

async fn create_goal(
    State(s): State<ApiState>,
    Json(body): Json<CreateGoalBody>,
) -> Json<ApiResponse<Goal>> {
    let tags_json = serde_json::to_string(&body.tags.unwrap_or_default()).unwrap_or_else(|_| "[]".into());
    let goal = Goal {
        id: uuid::Uuid::new_v4().to_string(),
        title: body.title,
        status: "active".into(),
        tags: tags_json,
        created_at: chrono::Utc::now().to_rfc3339(),
        completed_at: None,
    };
    match s.db.create_goal(&goal).await {
        Ok(_)  => Json(ApiResponse::ok(goal)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

async fn update_goal(
    State(s): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateGoalBody>,
) -> Json<ApiResponse<()>> {
    let tags_json = body.tags.as_ref().map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".into()));
    match s.db.update_goal(&id, body.title.as_deref(), body.status.as_deref(), tags_json.as_deref()).await {
        Ok(_)  => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

async fn delete_goal(
    State(s): State<ApiState>,
    Path(id): Path<String>,
) -> Json<ApiResponse<()>> {
    match s.db.delete_goal(&id).await {
        Ok(_)  => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

// ── Presence Spans ──

#[derive(Deserialize)]
struct PresenceDateQuery { date: Option<String> }

#[derive(Deserialize)]
struct UpsertPresenceBody {
    id: String,
    start_time: String,
    end_time: Option<String>,
    state: String,
}

#[derive(Deserialize)]
struct ClosePresenceBody {
    end_time: String,
}

async fn get_presence_spans(
    State(s): State<ApiState>,
    Query(q): Query<PresenceDateQuery>,
) -> Json<ApiResponse<Vec<PresenceSpan>>> {
    let date = q.date.unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    match s.db.get_presence_spans_by_date(&date).await {
        Ok(spans) => Json(ApiResponse::ok(spans)),
        Err(e)    => Json(ApiResponse::error(&e)),
    }
}

async fn upsert_presence_span(
    State(s): State<ApiState>,
    Json(body): Json<UpsertPresenceBody>,
) -> Json<ApiResponse<()>> {
    let span = PresenceSpan {
        id: body.id,
        start_time: body.start_time,
        end_time: body.end_time,
        state: body.state,
    };
    match s.db.upsert_presence_span(&span).await {
        Ok(_)  => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

async fn close_presence_span(
    State(s): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<ClosePresenceBody>,
) -> Json<ApiResponse<()>> {
    match s.db.close_presence_span(&id, &body.end_time).await {
        Ok(_)  => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

pub fn create_router(
    db: Arc<Database>,
    bili: Arc<BiliState>,
    bailian: Arc<BailianState>,
    bili_dl: Arc<BiliDownloadState>,
    sync_discovery: Arc<SyncDiscoveryState>,
    app_handle: Arc<AppHandle>,
) -> Router {
    let state = ApiState { db, bili, bailian, bili_dl, sync_discovery, app_handle };

    Router::new()
        .route("/api/health", get(health))
        .route("/api/activities/data-days", get(get_data_days))
        .route("/api/activities/palette", get(get_activity_palette))
        .route("/api/activities/categories", post(add_activity_category))
        .route("/api/activities/categories/{id}", delete(delete_activity_category).patch(update_activity_category))
        .route("/api/activities/tags", post(add_activity_tag))
        .route("/api/activities/tags/{id}", delete(delete_activity_tag))
        .route("/api/activities/tags/rename", post(rename_activity_path))
        .route("/api/activities/blocks", get(get_activity_blocks))
        .route("/api/activities/blocks/paint", post(paint_activity_blocks))
        .route("/api/activities/blocks/erase", post(erase_activity_blocks))
        .route("/api/plans/nodes", get(get_plan_nodes).post(add_plan_node))
        .route("/api/plans/nodes/{id}", patch(update_plan_node).delete(delete_plan_node))
        .route("/api/plans/blocks", get(get_planned_blocks))
        .route("/api/plans/blocks/paint", post(paint_planned_blocks))
        .route("/api/plans/blocks/erase", post(erase_planned_blocks))
        .route("/api/sync/hello", get(sync_hello))
        .route("/api/sync/alias", post(sync_set_alias))
        .route("/api/sync/export", get(sync_export))
        .route("/api/sync/import", post(sync_import))
        .route("/api/sync/peers", get(sync_peers))
        .route("/api/sync/discover", post(sync_discover))
        .route("/api/sync/links", get(sync_links).post(sync_link_add))
        .route("/api/sync/links/{device_id}", delete(sync_link_remove))
        .route("/api/sync/links/{device_id}/sync", post(sync_link_run))
        .route("/api/sessions", get(list_chat_sessions).post(create_chat_session))
        .route("/api/sessions/search", get(search_chat_sessions))
        .route("/api/sessions/cleanup_empty", post(cleanup_empty_chat_sessions))
        .route("/api/local-video", get(serve_local_video))
        .route("/api/sessions/{id}/messages", get(get_chat_messages).post(append_chat_messages))
        .route("/api/sessions/{id}", patch(update_chat_session).delete(delete_chat_session))
        .route("/api/bilibili/result", post(recv_bili_result))
        .route("/api/bailian/quota_result", post(recv_bailian_quota_result))
        .route("/api/bailian/account_result", post(recv_bailian_account_result))
        .route("/api/bailian/quota_progress", post(recv_bailian_quota_progress))
        .route("/api/bilibili/nav_result", post(recv_bili_nav_result))
        .route("/api/bilibili/playurl_result", post(recv_bili_playurl_result))
        .route("/api/bilibili/qualities_result", post(recv_bili_qualities_result))
        .route("/api/bilibili/history", get(get_bili_history))
        .route("/api/bilibili/history/search", get(search_bili_history))
        .route("/api/bilibili/day-counts", get(get_bili_day_counts))
        .route("/api/bilibili/history/link", axum::routing::put(link_bili_to_event))
        .route("/api/bilibili/cover", get(proxy_bili_cover))
        .route("/api/bilibili/spans/day", get(get_bili_spans_day))
        .route("/api/perception/spans", get(get_perception_spans))
        .route("/api/perception/screenshot", get(get_perception_screenshot))
        .route("/api/perception/app-icon", get(get_perception_app_icon))
        .route("/api/goals", get(get_goals).post(create_goal))
        .route("/api/goals/{id}", axum::routing::put(update_goal).delete(delete_goal))
        .route("/api/presence/spans", get(get_presence_spans).post(upsert_presence_span))
        .route("/api/presence/spans/{id}/close", axum::routing::put(close_presence_span))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

pub async fn start_server(
    db: Arc<Database>,
    bili: Arc<BiliState>,
    bailian: Arc<BailianState>,
    bili_dl: Arc<BiliDownloadState>,
    app_handle: Arc<AppHandle>,
    port: u16,
) {
    let sync_discovery = crate::sync_discovery::start(db.clone(), app_handle.clone(), port).await;
    let app = create_router(db, bili, bailian, bili_dl, sync_discovery, app_handle);
    let addr = format!("0.0.0.0:{}", port);

    log::info!("[API] HTTP 服务器启动: http://{}", addr);

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("[API] 无法绑定端口 {}: {}", port, e);
            return;
        }
    };

    // 关键：禁用 socket 句柄继承
    // Windows 上 std::process::Command::spawn 默认会让所有 handle 被子进程继承。
    // 主进程退出时，子进程（webview2 + 我们 spawn 的 cmd helper）会继续持有
    // listener socket 的句柄 → OS 不释放端口 → 新进程 bind 永远失败 → 数据全空。
    // 在 listener 创建后立即 SetHandleInformation HANDLE_FLAG_INHERIT=0 修这个问题。
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Foundation::{HANDLE, SetHandleInformation, HANDLE_FLAG_INHERIT};
        let raw_socket = listener.as_raw_socket();
        unsafe {
            // SOCKET 是 usize/HANDLE 别名，可直接当 HANDLE 用
            if SetHandleInformation(raw_socket as HANDLE, HANDLE_FLAG_INHERIT, 0) == 0 {
                let err = std::io::Error::last_os_error();
                log::warn!("[API] SetHandleInformation 失败: {} (重启可能仍 hang)", err);
            } else {
                log::info!("[API] socket 句柄已禁用继承（防止 webview 子进程持有）");
            }
        }
    }

    if let Err(e) = axum::serve(listener, app).await {
        log::error!("[API] 服务器错误: {}", e);
    }
}
