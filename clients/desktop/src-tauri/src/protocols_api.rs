// ══════════════════════════════════════════════
// 协议志 · 协议的 HTTP 端点（挂在本地 API 39733 上；数据层 protocol.rs，执行 protocol_watch.rs）
//   GET    /api/protocols                           协议列表
//   POST   /api/protocols                           新建
//   PATCH  /api/protocols/{id}                      改名 / 用意 / 白名单 / 强度 / 每日目标
//   DELETE /api/protocols/{id}                      删除（藏起来，历史局还在）
//   POST   /api/protocols/{id}/start                开局 { minutes? }
//   GET    /api/protocol-session                    进行中的一局（没有 = null）
//   POST   /api/protocol-session/stop               申请结束 / 冷却到了就结束
//   POST   /api/protocol-session/stop/cancel        撤回结束申请
//   GET    /api/protocol-sessions?date=YYYY-MM-DD   某天的各局
//   GET    /api/protocol-sessions/{id}/intercepts   这一局的拦截记录
//   GET    /api/protocol-sessions/{id}/judgments    这一局灰色地带的 AI 判断记录
//   GET    /api/protocol-app-usage?days=7           最近常用应用（白名单候选）
//   GET    /api/protocol-genesis                    最近一次开局（两份清单 / 回应 / 金字塔 / 年表；没开过 = null）
//   PUT    /api/protocol-genesis                    存开局 { id?, doc }（给了 id 覆盖，没给新开一份）
//   GET    /api/jev/config                          灰色地带判断的连接（Key 只给后四位）+ 两个功能位绑的模型
//   PUT    /api/jev/config                          改地址 / Key（模型在模型库里换）
//   POST   /api/jev/test                            拿一个窗口标题试判一次 { intent?, app?, title? }
// ══════════════════════════════════════════════

use axum::{
    extract::{Path, Query, State},
    response::Json,
    routing::{get, patch, post},
    Router,
};
use serde::Deserialize;

use crate::api::{ApiResponse, ApiState};
use crate::jev::{self, ChoiceOutcome, JevConfigView, UpdateJevConfigRequest};
use crate::protocol::{
    AppUsage, CreateProtocolRequest, Protocol, ProtocolIntercept, ProtocolJudgment, ProtocolSession, StartSessionRequest,
    UpdateProtocolRequest,
};
use crate::protocol_genesis::Genesis;
use crate::protocol_watch::{apply_session, notify_changed};

const DEFAULT_USAGE_DAYS: i64 = 7;

pub fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/protocols", get(list).post(create))
        .route("/api/protocols/{id}", patch(update).delete(remove))
        .route("/api/protocols/{id}/start", post(start))
        .route("/api/protocol-session", get(current))
        .route("/api/protocol-session/stop", post(stop))
        .route("/api/protocol-session/stop/cancel", post(cancel_stop))
        .route("/api/protocol-sessions", get(sessions_for_date))
        .route("/api/protocol-sessions/{id}/intercepts", get(intercepts))
        .route("/api/protocol-sessions/{id}/judgments", get(judgments))
        .route("/api/protocol-app-usage", get(app_usage))
        .route("/api/protocol-genesis", get(genesis_latest).put(genesis_save))
        .route("/api/jev/config", get(jev_config).put(jev_config_update))
        .route("/api/jev/test", post(jev_test))
}

fn reply<T: serde::Serialize>(r: Result<T, String>) -> Json<ApiResponse<T>> {
    match r {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// 局的状态变了：交给专注锁执行 + 通知前端
fn session_changed(state: &ApiState, session: &ProtocolSession) {
    apply_session(Some(session));
    notify_changed(&state.app_handle);
}

async fn list(State(state): State<ApiState>) -> Json<ApiResponse<Vec<Protocol>>> {
    reply(state.db.protocols_list().await)
}

async fn create(State(state): State<ApiState>, Json(req): Json<CreateProtocolRequest>) -> Json<ApiResponse<Protocol>> {
    reply(state.db.protocols_create(req).await)
}

async fn update(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateProtocolRequest>,
) -> Json<ApiResponse<Protocol>> {
    reply(state.db.protocols_update(&id, req).await)
}

async fn remove(State(state): State<ApiState>, Path(id): Path<String>) -> Json<ApiResponse<()>> {
    reply(state.db.protocols_delete(&id).await)
}

async fn start(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(req): Json<StartSessionRequest>,
) -> Json<ApiResponse<ProtocolSession>> {
    let result = state.db.protocol_session_start(&id, req).await;
    if let Ok(session) = &result {
        session_changed(&state, session);
    }
    reply(result)
}

async fn current(State(state): State<ApiState>) -> Json<ApiResponse<Option<ProtocolSession>>> {
    reply(state.db.protocol_session_current().await)
}

async fn stop(State(state): State<ApiState>) -> Json<ApiResponse<ProtocolSession>> {
    let result = state.db.protocol_session_request_stop().await;
    if let Ok(session) = &result {
        session_changed(&state, session);
    }
    reply(result)
}

async fn cancel_stop(State(state): State<ApiState>) -> Json<ApiResponse<ProtocolSession>> {
    let result = state.db.protocol_session_cancel_stop().await;
    if let Ok(session) = &result {
        session_changed(&state, session);
    }
    reply(result)
}

#[derive(Deserialize)]
struct DateQuery {
    date: String,
}

async fn sessions_for_date(
    State(state): State<ApiState>,
    Query(q): Query<DateQuery>,
) -> Json<ApiResponse<Vec<ProtocolSession>>> {
    reply(state.db.protocol_sessions_for_date(&q.date).await)
}

async fn intercepts(State(state): State<ApiState>, Path(id): Path<String>) -> Json<ApiResponse<Vec<ProtocolIntercept>>> {
    reply(state.db.protocol_intercepts(&id).await)
}

async fn judgments(State(state): State<ApiState>, Path(id): Path<String>) -> Json<ApiResponse<Vec<ProtocolJudgment>>> {
    reply(state.db.protocol_judgments(&id).await)
}

#[derive(Deserialize)]
struct UsageQuery {
    days: Option<i64>,
}

async fn app_usage(State(state): State<ApiState>, Query(q): Query<UsageQuery>) -> Json<ApiResponse<Vec<AppUsage>>> {
    reply(state.db.protocol_app_usage(q.days.unwrap_or(DEFAULT_USAGE_DAYS)).await)
}

async fn genesis_latest(State(state): State<ApiState>) -> Json<ApiResponse<Option<Genesis>>> {
    reply(state.db.genesis_latest().await)
}

#[derive(Deserialize)]
struct SaveGenesisRequest {
    id: Option<String>,
    doc: serde_json::Value,
}

async fn genesis_save(State(state): State<ApiState>, Json(req): Json<SaveGenesisRequest>) -> Json<ApiResponse<Genesis>> {
    reply(state.db.genesis_save(req.id.as_deref(), &req.doc).await)
}

async fn jev_config(State(state): State<ApiState>) -> Json<ApiResponse<JevConfigView>> {
    reply(state.db.jev_config_view().await)
}

async fn jev_config_update(
    State(state): State<ApiState>,
    Json(req): Json<UpdateJevConfigRequest>,
) -> Json<ApiResponse<JevConfigView>> {
    reply(state.db.jev_config_update(req).await)
}

/// 试判的默认样本：Playground 里实测过 99.6% 判「直接服务」
const TEST_INTENT: &str = "推进 Solevup 桌面端开发，写代码、看文档、和 Claude 一起改";
const TEST_APP: &str = "chrome.exe";
const TEST_TITLE: &str = "Tauri 2 无边框透明窗口完整教程 - 哔哩哔哩";

#[derive(Deserialize)]
struct JevTestRequest {
    intent: Option<String>,
    app: Option<String>,
    title: Option<String>,
}

async fn jev_test(State(state): State<ApiState>, Json(req): Json<JevTestRequest>) -> Json<ApiResponse<ChoiceOutcome>> {
    let cfg = match state.db.jev_config_for(jev::FEATURE_GRAY).await {
        Ok(c) => c,
        Err(e) => return reply(Err(e)),
    };
    let pick = |v: Option<String>, fallback: &str| v.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| fallback.to_string());
    let text = jev::relation_state(
        &pick(req.intent, TEST_INTENT),
        &pick(req.app, TEST_APP),
        &pick(req.title, TEST_TITLE),
    );
    reply(jev::decide_choice(&state.db, jev::FEATURE_GRAY, &cfg, &jev::DecideState::Text(&text), &jev::relation_question()).await)
}
