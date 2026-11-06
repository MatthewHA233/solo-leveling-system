// ══════════════════════════════════════════════
// SyncEngine — 对一个对端做双向（pull + push）同步
//   · 复用 HTTP /api/sync/export · /api/sync/import 协议
//   · 启动任务和发现钩子都用它
//   · 发令牌和数据之前先确认对面持有同一个令牌（规则见 sync_auth.rs）
// ══════════════════════════════════════════════

use crate::db::{ChatSyncImportResult, ChatSyncPage, Database, LinkedDevice, SyncExport, SyncImportResult};
use crate::sync_auth;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

/// 上次成功同步时间 —— maybe_sync_on_discover 用，10 秒冷却
fn last_synced() -> &'static std::sync::Mutex<HashMap<String, Instant>> {
    static CELL: OnceLock<std::sync::Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

const DISCOVER_COOLDOWN: Duration = Duration::from_secs(10);
/// 广播谁都能发，对端要求的间隔封顶，免得被拖成一直不同步
const MAX_PEER_SYNC_AFTER: Duration = Duration::from_secs(3600);

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
) -> Result<SyncRoundResult, String> {
    let base = normalize_base(&link.last_base);
    bidirectional_sync_at(db, link, &base).await
}

/// 同上，但连另一个地址：发现到已链接设备的新地址时用，同步成功才写库
async fn bidirectional_sync_at(
    db: Arc<Database>,
    link: &LinkedDevice,
    base: &str,
) -> Result<SyncRoundResult, String> {
    let self_id = db.sync_device_id().await?;
    let peer_alias = verify_peer(base, &self_id, &link.device_id, &link.auth_token).await?;
    // 对方可能改过名。校验通过才信
    if let Some(alias) = peer_alias.filter(|a| !a.trim().is_empty() && *a != link.alias) {
        db.set_link_alias(&link.device_id, &alias).await?;
    }
    let client = authed_client(&link.auth_token)?;

    // 1) 拉对端快照
    let pull_url = format!("{}/api/sync/export", base);
    let pull_resp: ApiEnvelope<SyncExport> = client.get(&pull_url).send().await
        .map_err(|e| format!("拉取对端 export 失败: {}", e))?
        .json().await
        .map_err(|e| format!("解析对端 export 失败: {}", e))?;
    if !pull_resp.success {
        return Err(format!("对端 export 错误: {}", pull_resp.error.unwrap_or_default()));
    }
    let remote_snapshot = pull_resp.data.ok_or("对端 export 数据为空")?;
    let peer_device_id = remote_snapshot.device_id.clone();

    // 2) 本地导入
    let mut pulled = db.import_sync(remote_snapshot).await
        .map_err(|e| format!("本地 import 失败: {}", e))?;

    // 3) 本地 export
    let local_snapshot = db.export_sync(None).await
        .map_err(|e| format!("本地 export 失败: {}", e))?;

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
    let (pull_seq, push_seq) = db.chat_sync_cursor(peer_device_id).await?;

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

    let mut since = push_seq;
    for _ in 0..CHAT_MAX_PAGES {
        let page = db.chat_sync_page(since, Some(peer_device_id), CHAT_PAGE_BYTES).await?;
        let (seq, more) = (page.seq, page.more);
        if !page.sessions.is_empty() || !page.messages.is_empty() {
            let resp: ApiEnvelope<ChatSyncImportResult> = client.post(&url).json(&page).send().await
                .map_err(|e| e.to_string())?
                .json().await.map_err(|e| e.to_string())?;
            if !resp.success {
                return Err(resp.error.unwrap_or_default());
            }
            let result = resp.data.ok_or("聊天记录推送结果为空")?;
            pushed.chat_sessions += result.chat_sessions;
            pushed.chat_messages += result.chat_messages;
        }
        db.save_chat_push_seq(peer_device_id, seq).await?;
        since = seq;
        if !more {
            break;
        }
    }
    Ok(())
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
            let result = bidirectional_sync(db_for_sync.clone(), &link).await;
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
/// 2. 上次成功 < 10 秒 → 跳过（避免同一对端反复 ping 触发风暴）
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
        let result = bidirectional_sync_at(db.clone(), &link, &normalize_base(&base_owned)).await;
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
