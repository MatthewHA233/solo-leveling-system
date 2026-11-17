// ══════════════════════════════════════════════
// SyncEngine — 对一个对端做双向（pull + push）同步
//   · 复用 HTTP /api/sync/export · /api/sync/import 协议
//   · 启动任务和发现钩子都用它
//   · 发令牌和数据之前先确认对面持有同一个令牌（规则见 sync_auth.rs）
//
// 只传变过的：每台对端存一对游标（sync_cursors）
//   · pull_cursor = 上次拉成功时对端快照的 exported_at（对端的钟）
//   · push_cursor = 上次推成功时本机快照的 exported_at（本机的钟）
//   · 一轮：拉 export?since=pull_cursor、推 export_sync(push_cursor)，都往回多带 ROUND_OVERLAP
//     （有几张表存的是 UTC 时间，和游标的本地时间按字符串比会差出时区那几个小时；多带的行对面按 LWW 跳过）
//   · 没有游标时整份传一次；之后每 FULL_ROUND_EVERY 在后台再整份对一次，兜住增量漏掉的
//   · 昼夜表一有写入（note_local_change）：攒 PUSH_DEBOUNCE 后把 push_cursor 之后的变化直接推给对端的 import，
//     不拉、不发界面事件
//   · 聊天一有写入（note_chat_change）：攒 CHAT_PUSH_DEBOUNCE 后把聊天推游标（chat_sync_cursor.push_seq）之后的页
//     直接 POST 给对端的 /api/sync/chat；对端收到带图的消息马上回头拉图片文件（pull_chat_images_from）
// ══════════════════════════════════════════════

use crate::db::{ChatSyncImportResult, ChatSyncPage, Database, LinkedDevice, SyncExport, SyncImportResult};
use crate::sync_auth;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// 注意：参数永远是 &AppHandle（从 Arc<AppHandle> Deref 而来），不 clone。
// AppHandle::clone 会触发 Tauri 内部 Rc<EventLoopRunner>::clone，非主线程上是 UB。
fn emit_started(app: &AppHandle, device_id: &str) {
    let _ = app.emit("sync:started", serde_json::json!({ "device_id": device_id }));
}

fn emit_finished(app: &AppHandle, device_id: &str, ok: bool, error: Option<&str>, result: Option<&SyncRoundResult>) {
    let _ = app.emit("sync:finished", serde_json::json!({
        "device_id": device_id,
        "ok": ok,
        "error": error,
        "result": result,
    }));
}

/// 正在跑同步的对端 device_id 集合 —— 防多播洪水触发并发风暴
fn syncing_set() -> &'static std::sync::Mutex<HashSet<String>> {
    static CELL: OnceLock<std::sync::Mutex<HashSet<String>>> = OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(HashSet::new()))
}

/// 上次成功同步时间 —— maybe_sync_on_discover 用，DISCOVER_COOLDOWN 冷却
fn last_synced() -> &'static std::sync::Mutex<HashMap<String, Instant>> {
    static CELL: OnceLock<std::sync::Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 改动靠写入后直推送达，发现触发的整轮只是兜底，和手机端 DISCOVER_COOLDOWN_MS 一样一分钟一轮
const DISCOVER_COOLDOWN: Duration = Duration::from_secs(60);
/// 广播谁都能发，对端要求的间隔封顶，免得被拖成一直不同步
const MAX_PEER_SYNC_AFTER: Duration = Duration::from_secs(3600);

/// 增量的一轮往回多带这么久：盖住 UTC 存的那几张表和本地时间游标之间的时区差（最大 ±14 小时）
const ROUND_OVERLAP_SECS: i64 = 26 * 3600;
/// 写入后直推往回多带这么久：盖住同一秒内的写入
const PUSH_OVERLAP_SECS: i64 = 5;
/// 隔这么久整份对一次
const FULL_ROUND_EVERY_SECS: i64 = 24 * 3600;
/// 整份的一轮要十几秒，不在刚启动时做
const FULL_ROUND_MIN_UPTIME: Duration = Duration::from_secs(600);
/// 昼夜表写入后攒这么久再推（一次拖刷会连着写好几下）
const PUSH_DEBOUNCE: Duration = Duration::from_millis(300);
/// 聊天写入后攒这么久再推：消息是一条一条写的，只为把同一瞬间的几行（工具记录 + 回复）并成一次
const CHAT_PUSH_DEBOUNCE: Duration = Duration::from_millis(80);
const PUSH_TIMEOUT: Duration = Duration::from_secs(5);
/// 直推失败（对端不在线）后隔这么久再试，期间的变化留给下一次一起带
const PUSH_RETRY_AFTER: Duration = Duration::from_secs(30);
/// 对端正在跑整轮时，直推等这么久再看
const PUSH_BUSY_RETRY: Duration = Duration::from_secs(2);
const CURSOR_TIME_FMT: &str = "%Y-%m-%d %H:%M:%S";

/// 一轮同步能不能整份传
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundMode {
    /// 有游标就只传变过的（启动、手动）
    Fast,
    /// 到了该整份对一次的时候就整份传（后台的发现钩子）
    AllowFull,
}

#[derive(Debug, Clone, Default)]
struct SyncCursor {
    pull: Option<String>,
    push: Option<String>,
    full_at: Option<String>,
}

pub(crate) fn init_cursor_tables(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS sync_cursors (
            device_id TEXT PRIMARY KEY,
            pull_cursor TEXT,
            push_cursor TEXT,
            full_synced_at TEXT
        );
    "#).map_err(|e| format!("创建同步游标表失败: {}", e))
}

impl Database {
    async fn sync_cursor(&self, device_id: &str) -> Result<SyncCursor, String> {
        use rusqlite::OptionalExtension;
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                "SELECT pull_cursor, push_cursor, full_synced_at FROM sync_cursors WHERE device_id = ?1",
                rusqlite::params![device_id],
                |r| Ok(SyncCursor { pull: r.get(0)?, push: r.get(1)?, full_at: r.get(2)? }),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.unwrap_or_default())
    }

    /// 只改传了的那几项
    async fn save_sync_cursor(&self, device_id: &str, pull: Option<&str>, push: Option<&str>, full_at: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO sync_cursors (device_id, pull_cursor, push_cursor, full_synced_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(device_id) DO UPDATE SET
               pull_cursor = COALESCE(excluded.pull_cursor, pull_cursor),
               push_cursor = COALESCE(excluded.push_cursor, push_cursor),
               full_synced_at = COALESCE(excluded.full_synced_at, full_synced_at)",
            rusqlite::params![device_id, pull, push, full_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// 游标往回挪 secs 秒；游标读不懂 = None（调用方按整份传处理）
fn cursor_back(cursor: &str, secs: i64) -> Option<String> {
    let at = chrono::NaiveDateTime::parse_from_str(cursor, CURSOR_TIME_FMT).ok()?;
    Some((at - chrono::Duration::seconds(secs)).format(CURSOR_TIME_FMT).to_string())
}

fn now_cursor() -> String {
    chrono::Local::now().format(CURSOR_TIME_FMT).to_string()
}

fn full_round_due(cursor: &SyncCursor) -> bool {
    let Some(at) = cursor.full_at.as_deref().and_then(|s| chrono::NaiveDateTime::parse_from_str(s, CURSOR_TIME_FMT).ok()) else {
        return true;
    };
    (chrono::Local::now().naive_local() - at).num_seconds() >= FULL_ROUND_EVERY_SECS
}

fn started_at() -> Instant {
    static AT: OnceLock<Instant> = OnceLock::new();
    *AT.get_or_init(Instant::now)
}

// ── 昼夜表写入后直推 ──

fn local_change() -> &'static tokio::sync::Notify {
    static N: OnceLock<tokio::sync::Notify> = OnceLock::new();
    N.get_or_init(tokio::sync::Notify::new)
}

fn push_failures() -> &'static std::sync::Mutex<HashMap<String, Instant>> {
    static M: OnceLock<std::sync::Mutex<HashMap<String, Instant>>> = OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

static DATA_DIRTY: AtomicBool = AtomicBool::new(false);
static CHAT_DIRTY: AtomicBool = AtomicBool::new(false);

/// 本机的昼夜表数据刚被改过（API 层的写请求成功后调）
pub fn note_local_change() {
    DATA_DIRTY.store(true, Ordering::SeqCst);
    local_change().notify_one();
}

/// 本机的聊天记录刚被改过（发了消息、回复出完、改标题、删会话）
pub fn note_chat_change() {
    CHAT_DIRTY.store(true, Ordering::SeqCst);
    local_change().notify_one();
}

/// 常驻任务：有写入就把变化推给各台已链接设备
pub fn spawn_change_pusher(db: Arc<Database>) {
    started_at();
    tauri::async_runtime::spawn(async move {
        loop {
            local_change().notified().await;
            let wait = if DATA_DIRTY.load(Ordering::SeqCst) { PUSH_DEBOUNCE } else { CHAT_PUSH_DEBOUNCE };
            tokio::time::sleep(wait).await;
            let data = DATA_DIRTY.swap(false, Ordering::SeqCst);
            let chat = CHAT_DIRTY.swap(false, Ordering::SeqCst);
            push_local_changes(&db, data, chat).await;
        }
    });
}

async fn push_local_changes(db: &Arc<Database>, data: bool, chat: bool) {
    let links = match db.list_linked_devices().await {
        Ok(l) => l,
        Err(e) => {
            log::warn!("[SyncEngine] 直推前读取已链接设备失败: {}", e);
            return;
        }
    };
    for link in links {
        if lock_map(push_failures()).get(&link.device_id).is_some_and(|at| at.elapsed() < PUSH_RETRY_AFTER) {
            continue;
        }
        // 整轮正在跑：它导出本机数据的时刻可能早于这次写入，等它跑完再推
        if lock_set(syncing_set()).contains(&link.device_id) {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(PUSH_BUSY_RETRY).await;
                if data {
                    note_local_change();
                }
                if chat {
                    note_chat_change();
                }
            });
            continue;
        }
        let mut failed: Option<String> = None;
        if data {
            match push_changes_to(db, &link).await {
                Ok(Some(rows)) => log::info!("[SyncEngine] 直推 {}：{} 行", link.alias, rows),
                // 还没整份同步过，没有游标：留给下一轮
                Ok(None) => {}
                Err(e) => failed = Some(e),
            }
        }
        if chat && failed.is_none() {
            match push_chat_to(db, &link).await {
                Ok((sessions, messages)) => {
                    if sessions + messages > 0 {
                        log::info!("[SyncEngine] 直推 {}：聊天会话 {} / 消息 {}", link.alias, sessions, messages);
                    }
                }
                Err(e) => failed = Some(e),
            }
        }
        match failed {
            None => {
                lock_map(push_failures()).remove(&link.device_id);
            }
            // 没推成的留给下一次写入或下一轮一起带（游标没动）
            Some(e) => {
                lock_map(push_failures()).insert(link.device_id.clone(), Instant::now());
                log::info!("[SyncEngine] 直推 {} 失败（{} 秒后再试）: {}", link.alias, PUSH_RETRY_AFTER.as_secs(), e);
            }
        }
    }
}

/// 把聊天推游标之后的页推给一台对端；返回对端采用的（会话数, 消息数）。地址用上次验证过的 last_base
async fn push_chat_to(db: &Arc<Database>, link: &LinkedDevice) -> Result<(usize, usize), String> {
    let client = authed_client(&link.auth_token)?;
    let url = format!("{}/api/sync/chat", normalize_base(&link.last_base));
    push_chat_pages(db, &client, &url, &link.device_id, Some(PUSH_TIMEOUT)).await
}

/// 对端刚把聊天消息直推过来：消息里引用的图片文件马上去它那里拉，拉到了通知界面重画
pub fn pull_chat_images_from(db: Arc<Database>, app: Arc<AppHandle>, device_id: String) {
    tauri::async_runtime::spawn(async move {
        let link = match db.list_linked_devices().await {
            Ok(links) => links.into_iter().find(|l| l.device_id == device_id),
            Err(_) => None,
        };
        let Some(link) = link else { return };
        let Ok(client) = authed_client(&link.auth_token) else { return };
        let pulled = pull_chat_images(&db, &client, &normalize_base(&link.last_base), &link.device_id).await;
        if pulled > 0 {
            let _ = app.emit("sync:chat-images", serde_json::json!({ "device_id": device_id, "count": pulled }));
        }
    });
}

/// 把 push_cursor 之后的变化推给一台对端；返回对端采用的行数。地址用上次验证过的 last_base
async fn push_changes_to(db: &Arc<Database>, link: &LinkedDevice) -> Result<Option<usize>, String> {
    let cursor = db.sync_cursor(&link.device_id).await?;
    let Some(since) = cursor.push.as_deref().and_then(|c| cursor_back(c, PUSH_OVERLAP_SECS)) else {
        return Ok(None);
    };
    let snapshot = db.export_sync(Some(since)).await.map_err(|e| format!("本地 export 失败: {}", e))?;
    let exported_at = snapshot.exported_at.clone();
    let url = format!("{}/api/sync/import", normalize_base(&link.last_base));
    let resp: ApiEnvelope<SyncImportResult> = authed_client(&link.auth_token)?
        .post(&url)
        .timeout(PUSH_TIMEOUT)
        .json(&snapshot)
        .send()
        .await
        .map_err(|e| format!("推送失败: {}", e))?
        .json()
        .await
        .map_err(|e| format!("解析对端回应失败: {}", e))?;
    if !resp.success {
        return Err(format!("对端 import 错误: {}", resp.error.unwrap_or_default()));
    }
    db.save_sync_cursor(&link.device_id, None, Some(&exported_at), None).await?;
    let applied = resp.data.map(|r| {
        r.activity_categories + r.activity_tags + r.activity_blocks + r.plan_nodes + r.planned_blocks
            + r.plan_islands + r.plan_island_checks
    }).unwrap_or(0);
    Ok(Some(applied))
}

/// 对端主动推过来：它发起的一轮已经双向做完，记一次成功，避免紧接着又反向跑一轮（手机端 onInboundImport 同理）
pub fn note_inbound_sync(device_id: &str) {
    let mut map = lock_map(last_synced());
    map.insert(device_id.to_string(), Instant::now());
}

/// 聊天增量同步一页的大小；axum 和手机端都收得下，单条超长消息会独占一页
pub const CHAT_PAGE_BYTES: usize = 1_500_000;
const CHAT_MAX_PAGES: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRoundResult {
    pub pulled: SyncImportResult,
    pub pushed: SyncImportResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ApiEnvelope<T> {
    success: bool,
    data: Option<T>,
    error: Option<String>,
}

fn http_client_builder() -> reqwest::ClientBuilder {
    // LAN 同步永远不走系统代理：开发环境里 reqwest 会读 http_proxy / https_proxy
    // env，把 192.168.x.x 内网 IP 也丢给代理，导致 "error sending request for url"。
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .no_proxy()
}

fn http_client() -> Result<reqwest::Client, String> {
    http_client_builder().build().map_err(|e| e.to_string())
}

/// 每个请求都带令牌。只在 verify_peer 通过后用
fn authed_client(token: &str) -> Result<reqwest::Client, String> {
    let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|e| e.to_string())?;
    value.set_sensitive(true);
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(reqwest::header::AUTHORIZATION, value);
    http_client_builder().default_headers(headers).build().map_err(|e| e.to_string())
}

fn normalize_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    }
}

#[derive(Debug, Deserialize)]
struct HelloProof {
    device_id: String,
    alias: Option<String>,
    proof: Option<String>,
}

/// 发现广播和地址都可能是假的：对面算得出应答，才说明它持有同一个令牌。
/// 这一步不能带令牌，所以用普通 client。通过时返回对面现在的别名
async fn verify_peer(base: &str, self_id: &str, device_id: &str, token: &str) -> Result<Option<String>, String> {
    let challenge = sync_auth::new_challenge();
    let resp: ApiEnvelope<HelloProof> = http_client()?
        .get(format!("{}/api/sync/hello", base))
        .query(&[("peer", self_id), ("challenge", challenge.as_str())])
        .send().await
        .map_err(|e| format!("连接对端失败: {}", e))?
        .json().await
        .map_err(|e| format!("解析对端 hello 失败: {}", e))?;
    if !resp.success {
        return Err(format!("对端 hello 错误: {}", resp.error.unwrap_or_default()));
    }
    let hello = resp.data.ok_or("对端 hello 数据为空")?;
    // 地址可能已被 DHCP 分给别的设备
    if hello.device_id != device_id {
        return Err(format!("地址 {} 已不是这台设备", base));
    }
    match hello.proof {
        Some(proof) if sync_auth::verify_proof(token, &challenge, device_id, &proof) => Ok(hello.alias),
        _ => Err("对方不认这次配对了，可能已经解除。请解除链接后重新配对".to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct PairedPeer {
    pub token: String,
    pub device_id: String,
    pub alias: String,
}

/// 拿对方屏幕上的配对码换令牌。两边都把对方记成已链接
pub async fn pair_with_peer(peer_base: &str, code: &str, self_id: &str, self_alias: &str) -> Result<PairedPeer, String> {
    let url = format!("{}/api/sync/pair", normalize_base(peer_base));
    let resp: ApiEnvelope<PairedPeer> = http_client()?
        .post(&url)
        .json(&serde_json::json!({ "code": code, "device_id": self_id, "alias": self_alias }))
        .send().await
        .map_err(|e| format!("连接对端失败: {}", e))?
        .json().await
        .map_err(|e| format!("对端版本太旧或回复异常，请两边都升级后再配对: {}", e))?;
    if !resp.success {
        return Err(resp.error.unwrap_or_else(|| "配对失败".to_string()));
    }
    resp.data.ok_or_else(|| "对端配对结果为空".to_string())
}

/// 解除链接时顺手告诉对方，对方连不上也没关系：它下次同步会校验失败，提示主人解除
pub async fn notify_unpair(peer_base: &str, token: &str) {
    let url = format!("{}/api/sync/unpair", normalize_base(peer_base));
    let Ok(client) = authed_client(token) else { return };
    if let Err(e) = client.post(&url).timeout(Duration::from_secs(3)).send().await {
        log::info!("[SyncEngine] 通知对端解除配对失败（{}）: {}", peer_base, e);
    }
}

/// 双向：先从对端 export 拉本地 import，再本地 export 推到对端 import。
/// 任何一段失败就早退，错误带上下文。
pub async fn bidirectional_sync(
    db: Arc<Database>,
    link: &LinkedDevice,
    mode: RoundMode,
) -> Result<SyncRoundResult, String> {
    let base = normalize_base(&link.last_base);
    bidirectional_sync_at(db, link, &base, mode).await
}

/// 同上，但连另一个地址：发现到已链接设备的新地址时用，同步成功才写库
async fn bidirectional_sync_at(
    db: Arc<Database>,
    link: &LinkedDevice,
    base: &str,
    mode: RoundMode,
) -> Result<SyncRoundResult, String> {
    let self_id = db.sync_device_id().await?;
    let peer_alias = verify_peer(base, &self_id, &link.device_id, &link.auth_token).await?;
    // 对方可能改过名。校验通过才信
    if let Some(alias) = peer_alias.filter(|a| !a.trim().is_empty() && *a != link.alias) {
        db.set_link_alias(&link.device_id, &alias).await?;
    }
    let client = authed_client(&link.auth_token)?;

    // 这一轮传多少：两个游标都在、也没轮到整份对，就只传游标之后变过的
    let cursor = db.sync_cursor(&link.device_id).await?;
    let want_full = mode == RoundMode::AllowFull && full_round_due(&cursor);
    let since = if want_full {
        None
    } else {
        cursor.pull.as_deref().and_then(|c| cursor_back(c, ROUND_OVERLAP_SECS))
            .zip(cursor.push.as_deref().and_then(|c| cursor_back(c, ROUND_OVERLAP_SECS)))
    };
    let full = since.is_none();
    let (pull_since, push_since) = since.unzip();

    // 1) 拉对端快照
    let pull_url = format!("{}/api/sync/export", base);
    let mut pull_req = client.get(&pull_url);
    if let Some(since) = &pull_since {
        pull_req = pull_req.query(&[("since", since)]);
    }
    let pull_resp: ApiEnvelope<SyncExport> = pull_req.send().await
        .map_err(|e| format!("拉取对端 export 失败: {}", e))?
        .json().await
        .map_err(|e| format!("解析对端 export 失败: {}", e))?;
    if !pull_resp.success {
        return Err(format!("对端 export 错误: {}", pull_resp.error.unwrap_or_default()));
    }
    let remote_snapshot = pull_resp.data.ok_or("对端 export 数据为空")?;
    let peer_device_id = remote_snapshot.device_id.clone();
    let remote_exported_at = remote_snapshot.exported_at.clone();

    // 2) 本地导入
    let mut pulled = db.import_sync(remote_snapshot).await
        .map_err(|e| format!("本地 import 失败: {}", e))?;

    // 3) 本地 export
    let local_snapshot = db.export_sync(push_since).await
        .map_err(|e| format!("本地 export 失败: {}", e))?;
    let local_exported_at = local_snapshot.exported_at.clone();

    // 4) 推到对端 import
    let push_url = format!("{}/api/sync/import", base);
    let push_resp: ApiEnvelope<SyncImportResult> = client.post(&push_url).json(&local_snapshot).send().await
        .map_err(|e| format!("推送对端 import 失败: {}", e))?
        .json().await
        .map_err(|e| format!("解析对端 import 失败: {}", e))?;
    if !push_resp.success {
        return Err(format!("对端 import 错误: {}", push_resp.error.unwrap_or_default()));
    }
    let mut pushed = push_resp.data.ok_or("对端 import 数据为空")?;

    // 两个方向都成功了才挪游标。对端的 exported_at 读不懂（不是约定的本地时间格式）就不记，下一轮整份拉
    let pull_cursor = cursor_back(&remote_exported_at, 0);
    let full_at = full.then(now_cursor);
    if let Err(e) = db.save_sync_cursor(&link.device_id, pull_cursor.as_deref(), Some(&local_exported_at), full_at.as_deref()).await {
        log::warn!("[SyncEngine] 记同步游标失败（下一轮会多传一些，不影响数据）: {}", e);
    }

    // 5) 聊天记录走独立通道：失败不影响上面已经同步好的数据
    if let Err(e) = sync_chat(&db, &client, base, &peer_device_id, &mut pulled, &mut pushed).await {
        log::info!("[SyncEngine] 聊天记录同步跳过 ({}): {}", base, e);
    }

    // 6) 消息同步过来了，图片文件也要有。失败不影响这一轮，下一轮再试
    pulled.chat_images = pull_chat_images(&db, &client, base, &peer_device_id).await;

    Ok(SyncRoundResult { pulled, pushed })
}

const CHAT_IMAGE_MAX_BYTES: usize = 16 * 1024 * 1024;
const CHAT_IMAGE_BATCH: usize = 32;
/// 对端也没有的图片（可能是第三台设备发的），隔这么久再问
const CHAT_IMAGE_RETRY: Duration = Duration::from_secs(600);

fn chat_image_misses() -> &'static std::sync::Mutex<HashMap<String, Instant>> {
    static MISSES: OnceLock<std::sync::Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MISSES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 消息引用了、本机没有文件的图片，从这台对端拉（规则见 src/lib/agent/chat-images.ts）
async fn pull_chat_images(db: &Database, client: &reqwest::Client, base: &str, peer_device_id: &str) -> usize {
    let ids = match db.chat_image_ids().await {
        Ok(ids) => ids,
        Err(e) => {
            log::warn!("[SyncEngine] 读图片引用失败: {}", e);
            return 0;
        }
    };
    let dir = crate::chat_image_root();
    let mut pulled = 0;
    let mut tried = 0;
    for id in ids {
        if tried >= CHAT_IMAGE_BATCH { break; }
        if !crate::is_chat_image_id(&id) || dir.join(format!("{}.jpg", id)).exists() { continue; }
        let miss_key = format!("{}:{}", peer_device_id, id);
        if lock_map(chat_image_misses()).get(&miss_key).is_some_and(|at| at.elapsed() < CHAT_IMAGE_RETRY) {
            continue;
        }
        tried += 1;
        match fetch_chat_image(client, base, &id).await {
            Ok(Some(bytes)) => match save_pulled_image(&dir, &id, &bytes) {
                Ok(()) => pulled += 1,
                Err(e) => log::warn!("[SyncEngine] 保存图片失败: {}", e),
            },
            Ok(None) => { lock_map(chat_image_misses()).insert(miss_key, Instant::now()); }
            Err(e) => {
                log::info!("[SyncEngine] 拉图片中断 ({}): {}", base, e);
                break;
            }
        }
    }
    pulled
}

/// None = 对端没有这张（旧版对端没有这个接口，也算没有）
async fn fetch_chat_image(client: &reqwest::Client, base: &str, id: &str) -> Result<Option<Vec<u8>>, String> {
    let resp = client.get(format!("{}/api/sync/chat-image/{}", base, id)).send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("令牌失效".to_string());
    }
    if !resp.status().is_success() { return Ok(None); }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > CHAT_IMAGE_MAX_BYTES || !bytes.starts_with(&[0xFF, 0xD8]) { return Ok(None); }
    Ok(Some(bytes.to_vec()))
}

/// 先写临时文件再改名：中途断了不会留下半张图
fn save_pulled_image(dir: &std::path::Path, id: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let part = dir.join(format!("{}.part", id));
    std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&part, dir.join(format!("{}.jpg", id))).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        e.to_string()
    })
}

/// 旧版对端没有 /api/sync/chat：游标不前进，等它升级后补齐
async fn sync_chat(
    db: &Database,
    client: &reqwest::Client,
    base: &str,
    peer_device_id: &str,
    pulled: &mut SyncImportResult,
    pushed: &mut SyncImportResult,
) -> Result<(), String> {
    let self_id = db.sync_device_id().await?;
    let (pull_seq, _) = db.chat_sync_cursor(peer_device_id).await?;

    let url = format!("{}/api/sync/chat", base);
    let mut since = pull_seq;
    for _ in 0..CHAT_MAX_PAGES {
        let resp: ApiEnvelope<ChatSyncPage> = client.get(&url)
            .query(&[
                ("since", since.to_string()),
                ("peer", self_id.clone()),
                ("max_bytes", CHAT_PAGE_BYTES.to_string()),
            ])
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        if !resp.success {
            return Err(resp.error.unwrap_or_default());
        }
        let page = resp.data.ok_or("聊天记录数据为空")?;
        let (seq, more) = (page.seq, page.more);
        let result = db.chat_sync_import(page).await?;
        pulled.chat_sessions += result.chat_sessions;
        pulled.chat_messages += result.chat_messages;
        db.save_chat_pull_seq(peer_device_id, seq).await?;
        since = seq;
        if !more {
            break;
        }
    }

    let (sessions, messages) = push_chat_pages(db, client, &url, peer_device_id, None).await?;
    pushed.chat_sessions += sessions;
    pushed.chat_messages += messages;
    Ok(())
}

/// 把聊天推游标之后的页一页页 POST 给对端，每页成功就挪游标。整轮和写入后直推共用；
/// 两边偶尔同时推到同一页也没关系，对端按 id 合并
async fn push_chat_pages(
    db: &Database,
    client: &reqwest::Client,
    url: &str,
    peer_device_id: &str,
    timeout: Option<Duration>,
) -> Result<(usize, usize), String> {
    let (_, push_seq) = db.chat_sync_cursor(peer_device_id).await?;
    let mut since = push_seq;
    let (mut sessions, mut messages) = (0usize, 0usize);
    for _ in 0..CHAT_MAX_PAGES {
        let page = db.chat_sync_page(since, Some(peer_device_id), CHAT_PAGE_BYTES).await?;
        let (seq, more) = (page.seq, page.more);
        if !page.sessions.is_empty() || !page.messages.is_empty() {
            let mut req = client.post(url).json(&page);
            if let Some(t) = timeout {
                req = req.timeout(t);
            }
            let resp: ApiEnvelope<ChatSyncImportResult> = req.send().await
                .map_err(|e| e.to_string())?
                .json().await.map_err(|e| e.to_string())?;
            if !resp.success {
                return Err(resp.error.unwrap_or_default());
            }
            let result = resp.data.ok_or("聊天记录推送结果为空")?;
            sessions += result.chat_sessions;
            messages += result.chat_messages;
        }
        db.save_chat_push_seq(peer_device_id, seq).await?;
        since = seq;
        if !more {
            break;
        }
    }
    Ok((sessions, messages))
}

/// 启动时遍历 linked_devices 做一轮，失败只记日志不打扰用户。
pub async fn run_startup_sync(db: Arc<Database>, app: Arc<AppHandle>) {
    let links = match db.list_linked_devices().await {
        Ok(l) => l,
        Err(e) => {
            log::warn!("[SyncEngine] 读取已链接设备失败: {}", e);
            return;
        }
    };
    if links.is_empty() {
        log::info!("[SyncEngine] 启动时没有已链接设备");
        return;
    }

    log::info!("[SyncEngine] 启动时尝试自动同步 {} 台已链接设备", links.len());
    for link in links {
        let db_for_sync = db.clone();
        let app_for_sync = app.clone();
        let base = link.last_base.clone();
        let device_id = link.device_id.clone();
        let alias = link.alias.clone();

        // 占位避免与 discover 钩子并发
        {
            let mut set = lock_set(syncing_set());
            if !set.insert(device_id.clone()) {
                continue;
            }
        }

        tokio::spawn(async move {
            emit_started(&app_for_sync, &device_id);
            let result = bidirectional_sync(db_for_sync.clone(), &link, RoundMode::Fast).await;
            match &result {
                Ok(round) => {
                    if let Err(e) = db_for_sync.touch_link_synced(&device_id, &base).await {
                        log::warn!("[SyncEngine] 更新 {} 同步时间失败: {}", alias, e);
                    }
                    let mut map = lock_map(last_synced());
                    map.insert(device_id.clone(), Instant::now());
                    log::info!(
                        "[SyncEngine] {} startup-sync done | pull cat={} tag={} blk={} pn={} pblk={} | push cat={} tag={} blk={} pn={} pblk={}",
                        alias,
                        round.pulled.activity_categories, round.pulled.activity_tags, round.pulled.activity_blocks,
                        round.pulled.plan_nodes, round.pulled.planned_blocks,
                        round.pushed.activity_categories, round.pushed.activity_tags, round.pushed.activity_blocks,
                        round.pushed.plan_nodes, round.pushed.planned_blocks,
                    );
                }
                Err(e) => {
                    log::warn!("[SyncEngine] {} ({}) 同步失败: {}", alias, base, e);
                }
            }
            emit_finished(
                &app_for_sync,
                &device_id,
                result.is_ok(),
                result.as_ref().err().map(|s| s.as_str()),
                result.as_ref().ok(),
            );
            let mut set = lock_set(syncing_set());
            set.remove(&device_id);
        });
    }
}

fn lock_set<'a>(m: &'a std::sync::Mutex<HashSet<String>>) -> std::sync::MutexGuard<'a, HashSet<String>> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn lock_map<'a>(m: &'a std::sync::Mutex<HashMap<String, Instant>>) -> std::sync::MutexGuard<'a, HashMap<String, Instant>> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 发现回调用：multicast 看到一台 device_id 时调一下，命中已链接就静默拉一轮。
///
/// 防护：
/// 1. 同 device_id 已在同步中 → 直接返回（防多播洪水）
/// 2. 上次成功不到 DISCOVER_COOLDOWN → 跳过（避免同一对端反复 ping 触发风暴）
/// 3. 对端在广播里要求放慢（手机在后台发 sync_after_s=300）→ 按它的间隔，一轮要双向传整份数据
pub async fn maybe_sync_on_discover(
    db: Arc<Database>,
    app: Arc<AppHandle>,
    device_id: &str,
    base: &str,
    sync_after: Duration,
) {
    let links = match db.list_linked_devices().await {
        Ok(l) => l,
        Err(_) => return,
    };
    let Some(link) = links.into_iter().find(|l| l.device_id == device_id) else {
        return;
    };

    // 冷却检查
    {
        let cooldown = DISCOVER_COOLDOWN.max(sync_after.min(MAX_PEER_SYNC_AFTER));
        let map = lock_map(last_synced());
        if let Some(at) = map.get(device_id) {
            if at.elapsed() < cooldown {
                return;
            }
        }
    }

    // 去重：占位失败说明已经在跑
    {
        let mut set = lock_set(syncing_set());
        if !set.insert(device_id.to_string()) {
            return;
        }
    }

    let base_owned = base.to_string();
    let device_id_owned = device_id.to_string();
    tokio::spawn(async move {
        emit_started(&app, &device_id_owned);
        // 整份的一轮只在后台做，且不在刚启动时
        let mode = if started_at().elapsed() >= FULL_ROUND_MIN_UPTIME { RoundMode::AllowFull } else { RoundMode::Fast };
        let result = bidirectional_sync_at(db.clone(), &link, &normalize_base(&base_owned), mode).await;
        match &result {
            Ok(round) => {
                let _ = db.touch_link_synced(&device_id_owned, &base_owned).await;
                let mut map = lock_map(last_synced());
                map.insert(device_id_owned.clone(), Instant::now());
                log::info!(
                    "[SyncEngine] {} discover-sync done | pull blk={} pn={} pblk={} tag={} | push blk={} pn={} pblk={} tag={}",
                    device_id_owned,
                    round.pulled.activity_blocks, round.pulled.plan_nodes, round.pulled.planned_blocks, round.pulled.activity_tags,
                    round.pushed.activity_blocks, round.pushed.plan_nodes, round.pushed.planned_blocks, round.pushed.activity_tags,
                );
            }
            Err(e) => {
                log::warn!("[SyncEngine] discover-triggered 同步 {} 失败: {}", device_id_owned, e);
            }
        }
        emit_finished(
            &app,
            &device_id_owned,
            result.is_ok(),
            result.as_ref().err().map(|s| s.as_str()),
            result.as_ref().ok(),
        );
        let mut set = lock_set(syncing_set());
        set.remove(&device_id_owned);
    });
}
