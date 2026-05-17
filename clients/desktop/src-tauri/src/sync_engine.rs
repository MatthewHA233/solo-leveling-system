// ══════════════════════════════════════════════
// SyncEngine — 对一个对端做双向（pull + push）同步
//   · 复用 HTTP /api/sync/export · /api/sync/import 协议
//   · 启动任务和发现钩子都用它
// ══════════════════════════════════════════════

use crate::db::{Database, SyncExport, SyncImportResult};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

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
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
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
pub async fn bidirectional_sync(db: Arc<Database>, peer_base: &str) -> Result<SyncRoundResult, String> {
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
pub async fn run_startup_sync(db: Arc<Database>) {
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
        let base = link.last_base.clone();
        let device_id = link.device_id.clone();
        let alias = link.alias.clone();
        tokio::spawn(async move {
            match bidirectional_sync(db_for_sync.clone(), &base).await {
                Ok(result) => {
                    let total = result.pulled.activity_categories + result.pulled.activity_tags
                        + result.pulled.activity_blocks + result.pulled.plan_nodes
                        + result.pulled.planned_blocks
                        + result.pushed.activity_categories + result.pushed.activity_tags
                        + result.pushed.activity_blocks + result.pushed.plan_nodes
                        + result.pushed.planned_blocks;
                    if let Err(e) = db_for_sync.touch_link_synced(&device_id, &base).await {
                        log::warn!("[SyncEngine] 更新 {} 同步时间失败: {}", alias, e);
                    }
                    log::info!("[SyncEngine] 已同步 {} ({}): {} 条变更", alias, base, total);
                }
                Err(e) => {
                    log::warn!("[SyncEngine] {} ({}) 同步失败: {}", alias, base, e);
                }
            }
        });
    }
}

/// 发现回调用：multicast 看到一台 device_id 时调一下，命中已链接就静默拉一轮。
pub async fn maybe_sync_on_discover(db: Arc<Database>, device_id: &str, base: &str) {
    let links = match db.list_linked_devices().await {
        Ok(l) => l,
        Err(_) => return,
    };
    let Some(_link) = links.into_iter().find(|l| l.device_id == device_id) else {
        return;
    };
    let base_owned = base.to_string();
    let device_id_owned = device_id.to_string();
    tokio::spawn(async move {
        if let Ok(_) = bidirectional_sync(db.clone(), &base_owned).await {
            let _ = db.touch_link_synced(&device_id_owned, &base_owned).await;
        }
    });
}
