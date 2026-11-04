// ══════════════════════════════════════════════
// 系统 · 感知内核的 HTTP 端点（挂在本地 API 39733 上；内核见 sense.rs）
//   GET /api/system/sense          系统此刻的临时判断（窗口、最像在推进的小目标、心流起点）
//   GET /api/system/thoughts       思维终端：内核最近 300 步在想什么（实时的走 system:thought 广播）
//   GET /api/system/sense-config   开关 / 截图兜底 / 每日预算
//   PUT /api/system/sense-config
//   GET /api/system/motives                     今日动机云里的动机（这个月自嗨开发的，sense_motives.rs）
//   POST /api/system/motives                    你自己加一颗 { text }
//   DELETE /api/system/motives/{id}             拿出云
//   GET /api/system/today?date=YYYY-MM-DD        今日动机云：立约的动机 + 各动机实际推进了多久
//   PUT /api/system/today/declare               立约 / 取消 { date, anchor_id, declared }
//   POST /api/system/motive-answer              你对「要把……收进动机云吗？」的回答 { key, text, answer: yes / no / chat }
// ══════════════════════════════════════════════

use axum::{
    extract::{Path, Query, State},
    response::Json,
    routing::{delete, get, post, put},
    Router,
};
use serde::Deserialize;

use crate::api::{ApiResponse, ApiState};
use crate::sense::{current_state, SenseConfig, SenseState};
use crate::sense_motives::SenseMotive;
use crate::sense_thoughts::{self, Thought};
use crate::sense_today::TodayView;

pub fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/system/sense", get(sense))
        .route("/api/system/thoughts", get(thoughts))
        .route("/api/system/sense-config", get(config).put(update_config))
        .route("/api/system/motives", get(motives).post(add_motive))
        .route("/api/system/motives/{id}", delete(drop_motive))
        .route("/api/system/today", get(today))
        .route("/api/system/today/declare", put(declare))
        .route("/api/system/motive-answer", post(motive_answer))
}

fn reply<T: serde::Serialize>(r: Result<T, String>) -> Json<ApiResponse<T>> {
    match r {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

async fn sense() -> Json<ApiResponse<SenseState>> {
    reply(Ok(current_state()))
}

async fn thoughts() -> Json<ApiResponse<Vec<Thought>>> {
    reply(Ok(sense_thoughts::recent()))
}

async fn config(State(state): State<ApiState>) -> Json<ApiResponse<SenseConfig>> {
    reply(state.db.sense_config().await)
}

async fn update_config(State(state): State<ApiState>, Json(cfg): Json<SenseConfig>) -> Json<ApiResponse<SenseConfig>> {
    reply(state.db.sense_config_update(cfg).await)
}

async fn motives(State(state): State<ApiState>) -> Json<ApiResponse<Vec<SenseMotive>>> {
    reply(state.db.sense_motives().await)
}

#[derive(Deserialize)]
struct AddMotiveRequest {
    text: String,
}

async fn add_motive(State(state): State<ApiState>, Json(req): Json<AddMotiveRequest>) -> Json<ApiResponse<Option<SenseMotive>>> {
    reply(state.db.sense_motive_add(&req.text, true).await)
}

async fn drop_motive(State(state): State<ApiState>, Path(id): Path<String>) -> Json<ApiResponse<()>> {
    reply(state.db.sense_motive_drop(&id).await)
}

#[derive(Deserialize)]
struct DateQuery {
    date: String,
}

async fn today(State(state): State<ApiState>, Query(q): Query<DateQuery>) -> Json<ApiResponse<TodayView>> {
    reply(state.db.sense_today(&q.date).await)
}

#[derive(Deserialize)]
struct DeclareRequest {
    date: String,
    anchor_id: String,
    declared: bool,
}

async fn declare(State(state): State<ApiState>, Json(req): Json<DeclareRequest>) -> Json<ApiResponse<Vec<String>>> {
    reply(state.db.sense_declare(&req.date, &req.anchor_id, req.declared).await)
}

#[derive(Deserialize)]
struct AnswerRequest {
    key: String,
    text: String,
    answer: String,
}

async fn motive_answer(State(state): State<ApiState>, Json(req): Json<AnswerRequest>) -> Json<ApiResponse<()>> {
    reply(state.db.sense_answer(&req.key, &req.text, &req.answer).await)
}
