// ══════════════════════════════════════════════
// 洪流域 · 笔记的 HTTP 端点（挂在本地 API 39733 上，数据层见 notes.rs）
//   GET    /api/notes/pages                 页面树（不带正文）
//   POST   /api/notes/pages                 新建页面
//   GET    /api/notes/pages/{id}            单页（含正文）
//   PATCH  /api/notes/pages/{id}            改标题 / 图标 / 封面 / 正文 / 收藏 / 全宽
//   DELETE /api/notes/pages/{id}            移进回收站
//   POST   /api/notes/pages/{id}/move       换父页面 / 换位置
//   POST   /api/notes/pages/{id}/restore    从回收站恢复
//   DELETE /api/notes/pages/{id}/purge      彻底删除
//   GET    /api/notes/trash                 回收站
//   DELETE /api/notes/trash                 清空回收站
//   GET    /api/notes/search?q=             全文搜索
//   POST   /api/notes/assets?page_id=&name= 上传附件（请求体 = 文件原始字节）
//   GET    /api/notes/assets/{name}         读附件
// ══════════════════════════════════════════════

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{delete, get, post},
    Router,
};
use serde::Deserialize;

use crate::api::{ApiResponse, ApiState};
use crate::notes::{
    is_valid_asset_name, note_assets_dir, CreateNotePageRequest, MoveNotePageRequest, NoteAsset,
    NotePage, NotePageMeta, NoteSearchHit, UpdateNotePageRequest, NOTE_ASSET_MAX_BYTES,
};

pub fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/notes/pages", get(list_pages).post(create_page))
        .route("/api/notes/pages/{id}", get(get_page).patch(update_page).delete(trash_page))
        .route("/api/notes/pages/{id}/move", post(move_page))
        .route("/api/notes/pages/{id}/restore", post(restore_page))
        .route("/api/notes/pages/{id}/purge", delete(purge_page))
        .route("/api/notes/trash", get(trash_list).delete(empty_trash))
        .route("/api/notes/search", get(search))
        .route(
            "/api/notes/assets",
            // axum 默认请求体上限 2MB，截图 / 照片经常超，单独放宽到附件上限（再留 1MB 余量）
            post(upload_asset).layer(DefaultBodyLimit::max(NOTE_ASSET_MAX_BYTES + 1024 * 1024)),
        )
        .route("/api/notes/assets/{name}", get(get_asset))
}

fn reply<T: serde::Serialize>(r: Result<T, String>) -> Json<ApiResponse<T>> {
    match r {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

async fn list_pages(State(state): State<ApiState>) -> Json<ApiResponse<Vec<NotePageMeta>>> {
    reply(state.db.notes_list_pages().await)
}

async fn create_page(
    State(state): State<ApiState>,
    Json(body): Json<CreateNotePageRequest>,
) -> Json<ApiResponse<NotePageMeta>> {
    reply(state.db.notes_create_page(body).await)
}

async fn get_page(State(state): State<ApiState>, Path(id): Path<String>) -> Json<ApiResponse<NotePage>> {
    reply(state.db.notes_get_page(&id).await.and_then(|p| p.ok_or_else(|| "页面不存在".to_string())))
}

async fn update_page(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateNotePageRequest>,
) -> Json<ApiResponse<()>> {
    reply(state.db.notes_update_page(&id, body).await)
}

async fn trash_page(State(state): State<ApiState>, Path(id): Path<String>) -> Json<ApiResponse<()>> {
    reply(state.db.notes_trash_page(&id).await)
}

async fn move_page(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<MoveNotePageRequest>,
) -> Json<ApiResponse<()>> {
    reply(state.db.notes_move_page(&id, body).await)
}

async fn restore_page(State(state): State<ApiState>, Path(id): Path<String>) -> Json<ApiResponse<NotePageMeta>> {
    reply(state.db.notes_restore_page(&id).await)
}

async fn purge_page(State(state): State<ApiState>, Path(id): Path<String>) -> Json<ApiResponse<()>> {
    reply(state.db.notes_purge_page(&id).await)
}

async fn trash_list(State(state): State<ApiState>) -> Json<ApiResponse<Vec<NotePageMeta>>> {
    reply(state.db.notes_trash_list().await)
}

async fn empty_trash(State(state): State<ApiState>) -> Json<ApiResponse<usize>> {
    reply(state.db.notes_empty_trash().await)
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
}

async fn search(State(state): State<ApiState>, Query(query): Query<SearchQuery>) -> Json<ApiResponse<Vec<NoteSearchHit>>> {
    reply(state.db.notes_search(&query.q).await)
}

#[derive(Deserialize)]
struct UploadQuery {
    page_id: Option<String>,
    #[serde(default)]
    name: String,
}

async fn upload_asset(
    State(state): State<ApiState>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Json<ApiResponse<NoteAsset>> {
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    reply(state.db.notes_save_asset(query.page_id, &query.name, &mime, &body).await)
}

async fn get_asset(State(state): State<ApiState>, Path(name): Path<String>) -> Response {
    if !is_valid_asset_name(&name) {
        return (StatusCode::BAD_REQUEST, "bad asset name").into_response();
    }
    let bytes = match tokio::fs::read(note_assets_dir().join(&name)).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::NOT_FOUND, "asset not found").into_response(),
    };
    let mime = state.db.notes_asset_mime(&name).await;
    (
        [
            (header::CONTENT_TYPE, mime),
            // 文件名是 uuid，内容永不变，可以放心长缓存
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable".to_string()),
        ],
        bytes,
    ).into_response()
}
