// ══════════════════════════════════════════════
// Local API — Axum HTTP Server
// 局域网访问: http://<ip>:3000
// ══════════════════════════════════════════════

use axum::{
    extract::{Path, Query, State},
    response::Json,
    routing::{delete, get},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use crate::db::{ChronosActivity, CreateActivityRequest, Database, UpdateActivityRequest};

// ── API State ──

#[derive(Clone)]
pub struct ApiState {
    pub db: Arc<Database>,
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

// ── Handlers ──

/// GET /api/health
async fn health() -> Json<ApiResponse<&'static str>> {
    Json(ApiResponse::ok("ok"))
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

/// POST /api/activities
async fn create_activity(
    State(state): State<ApiState>,
    Json(body): Json<CreateActivityRequest>,
) -> Json<ApiResponse<String>> {
    match state.db.create_activity(body).await {
        Ok(id) => Json(ApiResponse::ok(id)),
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

// ── Server ──

pub fn create_router(db: Arc<Database>) -> Router {
    let state = ApiState { db };

    Router::new()
        .route("/api/health", get(health))
        .route("/api/activities", get(get_activities).post(create_activity))
        .route("/api/activities/{id}", delete(delete_activity).put(update_activity))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

pub async fn start_server(db: Arc<Database>, port: u16) {
    let app = create_router(db);
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