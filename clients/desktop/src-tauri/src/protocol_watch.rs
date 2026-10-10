// ══════════════════════════════════════════════
// 协议志 · 协议的执行循环（数据层见 protocol.rs）
//   · 启动时接着上次没结束的局（软件被关掉 / 崩了，重新打开照样锁着）；定好的时间已过就记成到点结束
//   · 进行中：每 0.5 秒看一眼前台窗口，不在白名单就最小化、记一条拦截、发通知（同一应用 10 秒内只算一次）
//   · 定时局到点自动结束，通知前端（protocol:session-changed）
//   网站那一半由 Chrome 扩展执行：开局 / 结束时把规则交给 focus_lock，快照会推给扩展
// ══════════════════════════════════════════════

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::db::Database;
use crate::focus_lock::{self, ProtocolRules};
use crate::protocol::{parse_time, to_unix_ms, ProtocolSession};

/// 前端据此刷新协议页（开局 / 结束 / 申请结束 / 到点）
pub const SESSION_CHANGED_EVENT: &str = "protocol:session-changed";

const ENFORCE_TICK: Duration = Duration::from_millis(500);
const IDLE_TICK: Duration = Duration::from_secs(1);
/// 同一应用两次拦截记录 / 通知之间的最小间隔：反复点开也不刷屏、不灌库
const INTERCEPT_COOLDOWN: Duration = Duration::from_secs(10);

fn rules_for_lock(session: &ProtocolSession) -> ProtocolRules {
    ProtocolRules {
        session_id: session.id.clone(),
        protocol_name: session.protocol_name.clone(),
        apps: session.rules.apps.iter().map(|e| e.rule.clone()).collect(),
        sites: session.rules.sites.iter().map(|e| e.rule.clone()).collect(),
        planned_end_ms: session
            .planned_end_at
            .as_deref()
            .and_then(parse_time)
            .and_then(to_unix_ms),
    }
}

/// 把这一局（或「没有局」）交给专注锁执行
pub fn apply_session(session: Option<&ProtocolSession>) {
    let active = session.filter(|s| s.ended_at.is_none());
    focus_lock::set_protocol_rules(active.map(rules_for_lock));
}

pub fn notify_changed(app: &AppHandle) {
    if let Err(e) = app.emit(SESSION_CHANGED_EVENT, ()) {
        log::warn!("[Protocol] 通知前端失败: {e}");
    }
}

pub(crate) fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("[Protocol] 发送通知失败: {e}");
    }
}

/// 启动时：接着上次没结束的局；定好的时间已经过了就按到点结束
async fn resume(db: &Database) {
    let session = match db.protocol_session_current().await {
        Ok(Some(s)) => s,
        Ok(None) => return,
        Err(e) => {
            log::warn!("[Protocol] 读进行中的局失败: {e}");
            return;
        }
    };
    let expired = session
        .planned_end_at
        .as_deref()
        .and_then(parse_time)
        .and_then(to_unix_ms)
        .is_some_and(|end| focus_lock::now_ms() >= end);
    if expired {
        let ended_at = session.planned_end_at.clone().unwrap_or_default();
        if let Err(e) = db.protocol_session_finish(&session.id, &ended_at).await {
            log::warn!("[Protocol] 结束过期的局失败: {e}");
        }
        return;
    }
    log::info!("[Protocol] 接着上次的局：{}（{} 开局）", session.protocol_name, session.started_at);
    apply_session(Some(&session));
}

async fn finish_planned(db: &Database, app: &AppHandle, rules: &ProtocolRules) {
    let ended_at = match db.protocol_session_current().await {
        Ok(Some(s)) if s.id == rules.session_id => s.planned_end_at.unwrap_or_default(),
        // 这一局已经不在了（比如刚被手动结束）：只把锁撤掉
        _ => String::new(),
    };
    if !ended_at.is_empty() {
        if let Err(e) = db.protocol_session_finish(&rules.session_id, &ended_at).await {
            log::warn!("[Protocol] 到点结束失败: {e}");
            return;
        }
        notify(app, "协议 · 这一局到点了", &format!("「{}」结束，锁已解开", rules.protocol_name));
    }
    apply_session(None);
    notify_changed(app);
}

pub fn spawn_protocol_watcher(db: Arc<Database>, app: Arc<AppHandle>) {
    // setup() 是同步上下文，要用 Tauri 的 async runtime spawn（见 focus_lock::spawn_enforcement_watcher）
    tauri::async_runtime::spawn(async move {
        resume(&db).await;
        let mut last_hit: HashMap<String, Instant> = HashMap::new();
        loop {
            let Some(rules) = focus_lock::protocol_rules() else {
                last_hit.clear();
                tokio::time::sleep(IDLE_TICK).await;
                continue;
            };

            if rules.planned_end_ms.is_some_and(|end| focus_lock::now_ms() >= end) {
                finish_planned(&db, &app, &rules).await;
                continue;
            }

            if let Some(hit) = focus_lock::enforce_protocol_foreground(&rules) {
                let fresh = last_hit
                    .get(&hit.app)
                    .map_or(true, |t| t.elapsed() >= INTERCEPT_COOLDOWN);
                if fresh {
                    last_hit.insert(hit.app.clone(), Instant::now());
                    if let Err(e) = db.protocol_intercept_record(&rules.session_id, "app", &hit.app, &hit.title).await {
                        log::warn!("[Protocol] 记拦截失败: {e}");
                    }
                    notify(
                        app.as_ref(),
                        "协议 · 已拦下",
                        &format!("「{}」不在「{}」的白名单里", hit.app, rules.protocol_name),
                    );
                }
            }
            tokio::time::sleep(ENFORCE_TICK).await;
        }
    });
}
