// ══════════════════════════════════════════════
// Local API — Axum HTTP Server
// 局域网访问: http://<ip>:3000
// ══════════════════════════════════════════════

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{delete, get, patch, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid;
use tokio::sync::{oneshot, Mutex};
use tower_http::cors::{Any, CorsLayer};

use crate::db::{
    AppendChatMessagesRequest, ChatMessage, ChatSession,
    ChronosActivity, CreateActivityRequest, Database, UpdateActivityRequest, UpdateChatSessionRequest,
    BiliHistoryRow, UpsertBiliItem, MergeActivitiesRequest, BiliSpan, Goal, PresenceSpan,
};
use crate::bili_download::{BiliDownloadState, PlayUrlMeta, QualityProbe, deliver_playurl_result, deliver_probe_result};

// ── Bilibili 回调状态 ──

pub struct BiliState {
    pub pending: Mutex<Option<oneshot::Sender<Result<serde_json::Value, String>>>>,
}

impl BiliState {
    pub fn new() -> Self {
        Self { pending: Mutex::new(None) }
    }
}

// ── API State ──

#[derive(Clone)]
pub struct ApiState {
    pub db: Arc<Database>,
    pub bili: Arc<BiliState>,
    pub bili_dl: Arc<BiliDownloadState>,
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
struct LimitQuery {
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct BiliResultPayload {
    ok: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct BiliHistoryQuery {
    page: Option<i64>,
    page_size: Option<i64>,
    unlinked_only: Option<bool>,
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

// ── Handlers ──

/// GET /api/health
async fn health() -> Json<ApiResponse<&'static str>> {
    Json(ApiResponse::ok("ok"))
}

/// GET /api/manictime/screenshot?date=2026-04-04&time=13:30:00
async fn get_manictime_screenshot(
    Query(query): Query<ScreenshotQuery>,
) -> Response {
    let path = tokio::task::spawn_blocking(move || {
        crate::manictime::find_screenshot_near(&query.date, &query.time)
    }).await.ok().flatten();

    match path {
        None => (StatusCode::NOT_FOUND, "no screenshot").into_response(),
        Some(p) => {
            match tokio::fs::read(&p).await {
                Err(_) => (StatusCode::NOT_FOUND, "file unreadable").into_response(),
                Ok(bytes) => {
                    let mime = p.extension()
                        .and_then(|e| e.to_str())
                        .map(|e| if e.eq_ignore_ascii_case("png") { "image/png" } else { "image/jpeg" })
                        .unwrap_or("image/jpeg");
                    ([(axum::http::header::CONTENT_TYPE, mime)], bytes).into_response()
                }
            }
        }
    }
}

#[derive(Deserialize)]
struct ScreenshotQuery {
    date: String,
    time: String,
}

/// GET /api/manictime/app-icon?name=<group_name>
async fn get_manictime_app_icon(
    Query(query): Query<AppIconQuery>,
) -> Response {
    let name = query.name.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        crate::manictime::get_app_icon_png(&name)
    }).await.ok().flatten();

    match bytes {
        None => (StatusCode::NOT_FOUND, "no icon").into_response(),
        Some(b) => ([(axum::http::header::CONTENT_TYPE, "image/png")], b).into_response(),
    }
}

#[derive(Deserialize)]
struct AppIconQuery {
    name: String,
}

/// GET /api/manictime/spans?date=2026-04-04
async fn get_manictime_spans(
    Query(query): Query<DateQuery>,
) -> Json<ApiResponse<Vec<crate::manictime::MtSpan>>> {
    match tokio::task::spawn_blocking(move || {
        crate::manictime::query_spans_for_date(&query.date)
    }).await {
        Ok(Ok(spans)) => Json(ApiResponse::ok(spans)),
        Ok(Err(e))    => Json(ApiResponse::error(&e)),
        Err(e)        => Json(ApiResponse::error(&e.to_string())),
    }
}

/// GET /api/activities?date=2024-01-15
async fn get_activities(
    State(state): State<ApiState>,
    Query(query): Query<DateQuery>,
) -> Json<ApiResponse<Vec<ChronosActivity>>> {
    match state.db.get_activities_by_date(&query.date).await {
        Ok(activities) => Json(ApiResponse::ok(activities)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

#[derive(Serialize)]
struct CreateActivityResult {
    id: String,
    event_ids: Vec<String>,
}

/// POST /api/activities
async fn create_activity(
    State(state): State<ApiState>,
    Json(body): Json<CreateActivityRequest>,
) -> Json<ApiResponse<CreateActivityResult>> {
    match state.db.create_activity(body).await {
        Ok((id, event_ids)) => Json(ApiResponse::ok(CreateActivityResult { id, event_ids })),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// DELETE /api/activities/:id
async fn delete_activity(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Json<ApiResponse<()>> {
    match state.db.delete_activity(&id).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// PUT /api/activities/:id
async fn update_activity(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateActivityRequest>,
) -> Json<ApiResponse<()>> {
    match state.db.update_activity(&id, body).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::error(&e)),
    }
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

/// POST /api/activities/merge — 合并活动（移动事件，不删重建）
async fn merge_activities(
    State(state): State<ApiState>,
    Json(body): Json<MergeActivitiesRequest>,
) -> Json<ApiResponse<()>> {
    match state.db.merge_activities(body).await {
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

pub fn create_router(db: Arc<Database>, bili: Arc<BiliState>, bili_dl: Arc<BiliDownloadState>) -> Router {
    let state = ApiState { db, bili, bili_dl };

    Router::new()
        .route("/api/health", get(health))
        .route("/api/activities", get(get_activities).post(create_activity))
        .route("/api/activities/{id}", delete(delete_activity).put(update_activity))
        .route("/api/sessions", get(list_chat_sessions).post(create_chat_session))
        .route("/api/sessions/{id}/messages", get(get_chat_messages).post(append_chat_messages))
        .route("/api/sessions/{id}", patch(update_chat_session).delete(delete_chat_session))
        .route("/api/bilibili/result", post(recv_bili_result))
        .route("/api/bilibili/playurl_result", post(recv_bili_playurl_result))
        .route("/api/bilibili/qualities_result", post(recv_bili_qualities_result))
        .route("/api/bilibili/history", get(get_bili_history))
        .route("/api/bilibili/history/link", axum::routing::put(link_bili_to_event))
        .route("/api/activities/merge", post(merge_activities))
        .route("/api/bilibili/cover", get(proxy_bili_cover))
        .route("/api/bilibili/spans/day", get(get_bili_spans_day))
        .route("/api/manictime/spans", get(get_manictime_spans))
        .route("/api/manictime/screenshot", get(get_manictime_screenshot))
        .route("/api/manictime/app-icon", get(get_manictime_app_icon))
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

pub async fn start_server(db: Arc<Database>, bili: Arc<BiliState>, bili_dl: Arc<BiliDownloadState>, port: u16) {
    let app = create_router(db, bili, bili_dl);
    let addr = format!("0.0.0.0:{}", port);

    log::info!("[API] HTTP 服务器启动: http://{}", addr);

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("[API] 无法绑定端口 {}: {}", port, e);
            return;
        }
    };

    if let Err(e) = axum::serve(listener, app).await {
        log::error!("[API] 服务器错误: {}", e);
    }
}