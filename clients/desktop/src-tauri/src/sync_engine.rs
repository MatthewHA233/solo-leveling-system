// ══════════════════════════════════════════════
// SyncEngine — 对一个对端做双向（pull + push）同步
//   · 复用 HTTP /api/sync/export · /api/sync/import 协议
//   · 启动任务和发现钩子都用它
// ══════════════════════════════════════════════

use crate::db::{Database, SyncExport, SyncImportResult};
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

fn emit_finished(app: &AppHandle, device_id: &str, ok: bool, error: Option<&str>) {
    let _ = app.emit("sync:finished", serde_json::json!({
        "device_id": device_id,
        "ok": ok,
        "error": error,
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

fn http_client() -> Result<reqwest::Client, String> {
    // LAN 同步永远不走系统代理：开发环境里 reqwest 会读 http_proxy / https_proxy
    // env，把 192.168.x.x 内网 IP 也丢给代理，导致 "error sending request for url"。
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}

fn normalize_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    }
}

/// 双向：先从对端 export 拉本地 import，再本地 export 推到对端 import。
/// 任何一段失败就早退，错误带上下文。
pub async fn bidirectional_sync(
    db: Arc<Database>,
    peer_base: &str,
) -> Result<SyncRoundResult, String> {
    let base = normalize_base(peer_base);
    let client = http_client()?;

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

    // 2) 本地导入
    let pulled = db.import_sync(remote_snapshot).await
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
    let pushed = push_resp.data.ok_or("对端 import 数据为空")?;

    Ok(SyncRoundResult { pulled, pushed })
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
            let result = bidirectional_sync(db_for_sync.clone(), &base).await;
            match &result {
                Ok(round) => {
                    let total = round.pulled.activity_categories + round.pulled.activity_tags
                        + round.pulled.activity_blocks + round.pulled.plan_nodes
                        + round.pulled.planned_blocks
                        + round.pushed.activity_categories + round.pushed.activity_tags
                        + round.pushed.activity_blocks + round.pushed.plan_nodes
                        + round.pushed.planned_blocks;
                    if let Err(e) = db_for_sync.touch_link_synced(&device_id, &base).await {
                        log::warn!("[SyncEngine] 更新 {} 同步时间失败: {}", alias, e);
                    }
                    let mut map = lock_map(last_synced());
                    map.insert(device_id.clone(), Instant::now());
                    log::info!("[SyncEngine] 已同步 {} ({}): {} 条变更", alias, base, total);
                }
                Err(e) => {
                    log::warn!("[SyncEngine] {} ({}) 同步失败: {}", alias, base, e);
                }
            }
            emit_finished(&app_for_sync, &device_id, result.is_ok(), result.as_ref().err().map(|s| s.as_str()));
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
pub async fn maybe_sync_on_discover(db: Arc<Database>, app: Arc<AppHandle>, device_id: &str, base: &str) {
    let links = match db.list_linked_devices().await {
        Ok(l) => l,
        Err(_) => return,
    };
    if !links.iter().any(|l| l.device_id == device_id) {
        return;
    }

    // 冷却检查
    {
        let map = lock_map(last_synced());
        if let Some(at) = map.get(device_id) {
            if at.elapsed() < DISCOVER_COOLDOWN {
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
        let result = bidirectional_sync(db.clone(), &base_owned).await;
        match &result {
            Ok(_) => {
                let _ = db.touch_link_synced(&device_id_owned, &base_owned).await;
                let mut map = lock_map(last_synced());
                map.insert(device_id_owned.clone(), Instant::now());
            }
            Err(e) => {
                log::warn!("[SyncEngine] discover-triggered 同步 {} 失败: {}", device_id_owned, e);
            }
        }
        emit_finished(&app, &device_id_owned, result.is_ok(), result.as_ref().err().map(|s| s.as_str()));
        let mut set = lock_set(syncing_set());
        set.remove(&device_id_owned);
    });
}
