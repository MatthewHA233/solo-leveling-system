// ══════════════════════════════════════════════
// 笔记的 HTTP 端点（挂在本地 API 39733 上，数据层见 notes.rs / notes_index.rs）
//   GET    /api/notes/pages                 页面树（不带正文）
//   POST   /api/notes/pages                 新建页面（kind: page / anchor / thought）
//   GET    /api/notes/pages/{id}            单页（含正文）
//   PATCH  /api/notes/pages/{id}            改标题 / 图标 / 封面 / 正文 / 收藏 / 全宽 / 关联的语境
//   DELETE /api/notes/pages/{id}            移进回收站
//   POST   /api/notes/pages/{id}/move       换父页面 / 换位置
//   POST   /api/notes/pages/{id}/restore    从回收站恢复
//   DELETE /api/notes/pages/{id}/purge      彻底删除
//   GET    /api/notes/trash                 回收站
//   DELETE /api/notes/trash                 清空回收站
//   GET    /api/notes/search?q=             全文搜索
//   POST   /api/notes/assets?page_id=&name= 上传附件（请求体 = 文件原始字节）
//   GET    /api/notes/assets/{name}         读附件
//   ── 锚点 ──
//   GET    /api/notes/anchor-stats          每个锚点被引用了几处、里面有几条锚点句
//   GET    /api/notes/anchors/{id}/sentences  这个锚点里的锚点句
//   GET    /api/notes/anchors/{id}/backlinks  谁引用了这个锚点
//   GET    /api/notes/sentences/{page_id}/{block_id}/versions  一条锚点句的各版
//   ── 想法卡片 ──
//   GET    /api/notes/thoughts?before=&limit=  全部想法卡片（批注 + 单独写的），按时间倒序
//   POST   /api/notes/thoughts              单独写一张（未关联语境）
//   GET    /api/notes/thoughts/heatmap?since=  每天写了几张
//   ── 语境 ──
//   GET    /api/notes/contexts              已经生成的语境页
//   POST   /api/notes/contexts/ensure       打开某个语境：有就用，没有就建
//
//   这些端点只用到数据库，所以路由按「能拿出 Arc<Database> 的状态」写：正式跑挂在 ApiState 上，
//   开发时可以单独起一个只有笔记端点的小服务（serve_notes_only，拿临时数据目录跑，不碰真实的库）。
// ══════════════════════════════════════════════

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, FromRef, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{delete, get, post},
    Router,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::api::{ApiResponse, ApiState};
use crate::db::Database;
use crate::notes::{
    is_valid_asset_name, note_assets_dir, CreateNotePageRequest, CreateThoughtRequest, EnsureContextRequest,
    MoveNotePageRequest, NoteAsset, NotePage, NotePageMeta, NoteSearchHit, UpdateNotePageRequest, NOTE_ASSET_MAX_BYTES,
};
use crate::notes_index::{AnchorSentence, AnchorStat, Backlink, ContextPage, SentenceVersion, ThoughtCard, ThoughtDay};

type Db = Arc<Database>;

impl FromRef<ApiState> for Db {
    fn from_ref(state: &ApiState) -> Self {
        state.db.clone()
    }
}

/// 想法卡片一次最多取多少张
const THOUGHTS_PAGE_DEFAULT: i64 = 60;

pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Db: FromRef<S>,
{
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
        .route("/api/notes/anchor-stats", get(anchor_stats))
        .route("/api/notes/anchors/{id}/sentences", get(anchor_sentences))
        .route("/api/notes/anchors/{id}/backlinks", get(anchor_backlinks))
        .route("/api/notes/sentences/{page_id}/{block_id}/versions", get(sentence_versions))
        .route("/api/notes/thoughts", get(list_thoughts).post(create_thought))
        .route("/api/notes/thoughts/heatmap", get(thought_heatmap))
        .route("/api/notes/contexts", get(list_contexts))
        .route("/api/notes/contexts/ensure", post(ensure_context))
}

fn reply<T: serde::Serialize>(r: Result<T, String>) -> Json<ApiResponse<T>> {
    match r {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

async fn list_pages(State(db): State<Db>) -> Json<ApiResponse<Vec<NotePageMeta>>> {
    reply(db.notes_list_pages().await)
}

async fn create_page(State(db): State<Db>, Json(body): Json<CreateNotePageRequest>) -> Json<ApiResponse<NotePageMeta>> {
    reply(db.notes_create_page(body).await)
}

async fn get_page(State(db): State<Db>, Path(id): Path<String>) -> Json<ApiResponse<NotePage>> {
    reply(db.notes_get_page(&id).await.and_then(|p| p.ok_or_else(|| "页面不存在".to_string())))
}

async fn update_page(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<UpdateNotePageRequest>,
) -> Json<ApiResponse<()>> {
    reply(db.notes_update_page(&id, body).await)
}

async fn trash_page(State(db): State<Db>, Path(id): Path<String>) -> Json<ApiResponse<()>> {
    reply(db.notes_trash_page(&id).await)
}

async fn move_page(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<MoveNotePageRequest>,
) -> Json<ApiResponse<()>> {
    reply(db.notes_move_page(&id, body).await)
}

async fn restore_page(State(db): State<Db>, Path(id): Path<String>) -> Json<ApiResponse<NotePageMeta>> {
    reply(db.notes_restore_page(&id).await)
}

async fn purge_page(State(db): State<Db>, Path(id): Path<String>) -> Json<ApiResponse<()>> {
    reply(db.notes_purge_page(&id).await)
}

async fn trash_list(State(db): State<Db>) -> Json<ApiResponse<Vec<NotePageMeta>>> {
    reply(db.notes_trash_list().await)
}

async fn empty_trash(State(db): State<Db>) -> Json<ApiResponse<usize>> {
    reply(db.notes_empty_trash().await)
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
}

async fn search(State(db): State<Db>, Query(query): Query<SearchQuery>) -> Json<ApiResponse<Vec<NoteSearchHit>>> {
    reply(db.notes_search(&query.q).await)
}

#[derive(Deserialize)]
struct UploadQuery {
    page_id: Option<String>,
    #[serde(default)]
    name: String,
}

async fn upload_asset(
    State(db): State<Db>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Json<ApiResponse<NoteAsset>> {
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    reply(db.notes_save_asset(query.page_id, &query.name, &mime, &body).await)
}

async fn get_asset(State(db): State<Db>, Path(name): Path<String>) -> Response {
    if !is_valid_asset_name(&name) {
        return (StatusCode::BAD_REQUEST, "bad asset name").into_response();
    }
    let bytes = match tokio::fs::read(note_assets_dir().join(&name)).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::NOT_FOUND, "asset not found").into_response(),
    };
    let mime = db.notes_asset_mime(&name).await;
    (
        [
            (header::CONTENT_TYPE, mime),
            // 文件名是 uuid，内容永不变，可以放心长缓存
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable".to_string()),
        ],
        bytes,
    ).into_response()
}

// ── 锚点 ──

async fn anchor_stats(State(db): State<Db>) -> Json<ApiResponse<Vec<AnchorStat>>> {
    reply(db.notes_anchor_stats().await)
}

async fn anchor_sentences(State(db): State<Db>, Path(id): Path<String>) -> Json<ApiResponse<Vec<AnchorSentence>>> {
    reply(db.notes_anchor_sentences(&id).await)
}

async fn anchor_backlinks(State(db): State<Db>, Path(id): Path<String>) -> Json<ApiResponse<Vec<Backlink>>> {
    reply(db.notes_anchor_backlinks(&id).await)
}

async fn sentence_versions(
    State(db): State<Db>,
    Path((page_id, block_id)): Path<(String, String)>,
) -> Json<ApiResponse<Vec<SentenceVersion>>> {
    reply(db.notes_sentence_versions(&page_id, &block_id).await)
}

// ── 想法卡片 ──

#[derive(Deserialize)]
struct ThoughtsQuery {
    /// 只要这个时间之前创建的（翻下一页时传上一页最后一张的创建时间）
    before: Option<String>,
    limit: Option<i64>,
}

async fn list_thoughts(State(db): State<Db>, Query(query): Query<ThoughtsQuery>) -> Json<ApiResponse<Vec<ThoughtCard>>> {
    reply(db.notes_list_thoughts(query.before.as_deref(), query.limit.unwrap_or(THOUGHTS_PAGE_DEFAULT)).await)
}

async fn create_thought(State(db): State<Db>, Json(body): Json<CreateThoughtRequest>) -> Json<ApiResponse<NotePageMeta>> {
    reply(db.notes_create_thought(body).await)
}

#[derive(Deserialize)]
struct HeatmapQuery {
    /// 从哪一天起算（2026-01-01）；不传就是全部
    #[serde(default)]
    since: String,
}

async fn thought_heatmap(State(db): State<Db>, Query(query): Query<HeatmapQuery>) -> Json<ApiResponse<Vec<ThoughtDay>>> {
    reply(db.notes_thought_heatmap(&query.since).await)
}

// ── 语境 ──

async fn list_contexts(State(db): State<Db>) -> Json<ApiResponse<Vec<ContextPage>>> {
    reply(db.notes_list_contexts().await)
}

async fn ensure_context(State(db): State<Db>, Json(body): Json<EnsureContextRequest>) -> Json<ApiResponse<NotePageMeta>> {
    reply(db.notes_ensure_context(body).await)
}

// ── 开发用：只有笔记端点的独立小服务 ──

/// 拿一个指定的数据目录（开发时给临时目录）单独起笔记端点，任何来源都放行。
/// 只给 examples/notes_dev.rs 用：改笔记功能时不用关掉正在跑的应用，也不往真实的库里写测试内容。
/// 库要在异步运行时外面打开（Database::new 里会同步等锁），所以这里是普通函数，自己起运行时。
pub fn serve_notes_only(data_dir: std::path::PathBuf, port: u16) -> Result<(), String> {
    use tower_http::cors::{Any, CorsLayer};

    if data_dir == Database::default_data_dir() {
        return Err("这是真实的数据目录，开发服务不在上面跑；请给一个临时目录".to_string());
    }
    let db: Db = Arc::new(Database::new(data_dir)?);
    let app = routes::<Db>()
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .with_state(db);
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(async move {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .map_err(|e| format!("端口 {} 起不来: {}", port, e))?;
            println!("笔记开发服务：http://127.0.0.1:{}", port);
            axum::serve(listener, app).await.map_err(|e| e.to_string())
        })
}
