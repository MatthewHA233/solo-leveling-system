// ══════════════════════════════════════════════
// 协议志 · 灰色地带的实时判断（决策模型，见 jev.rs；用哪个模型看模型库的 protocol_gray 绑定）
//   白名单里标「灰」的条目在前台时，按协议用意问 Jev「这段内容和用意的关系」：
//   · 标题一变就判；同一标题每 60 秒复判一次；任意两次至少隔 10 秒（省钱、不刷屏）
//   · 有把握 = 选中项概率 ≥ 0.8 且 Jev 的把握度 ≥ 0.75
//     （实测：原神全剧情 1.00 / 1.00；程序员 vlog 0.81 / 0.72、Claude Code 搞笑 0.71 / 0.56 都算没把握）
//   · 有把握的「娱乐」连续 2 次 → 轻声提醒；连续 4 次起 → 把这个窗口最小化（收紧）
//     判成「直接服务」清零；没把握的、「沾边」的不加不减；离开灰色内容也清零。单次判断绝不惩罚
//   · 每次判断都记进 protocol_judgments（复盘用）
//   只有灰色条目在前台时，窗口 / 网页标题才会发出去；独立于拦截循环跑，网络慢也不耽误拦截
// ══════════════════════════════════════════════

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::db::Database;
use crate::focus_lock;
use crate::jev::{self, ChoiceOutcome, RELATION_ADJACENT, RELATION_OFF_TASK, RELATION_ON_TASK};
use crate::protocol::{NewJudgment, ProtocolSession};
use crate::protocol_watch::notify;

const TICK: Duration = Duration::from_secs(1);
const MIN_GAP: Duration = Duration::from_secs(10);
const REJUDGE_AFTER: Duration = Duration::from_secs(60);
const SURE_PROBABILITY: f64 = 0.8;
const SURE_CONFIDENCE: f64 = 0.75;
const WARN_AT: u32 = 2;
const SQUEEZE_AT: u32 = 4;
/// 扩展上报的标签页只在前台是这些浏览器时才有意义
const BROWSERS: &[&str] = &["chrome.exe", "msedge.exe"];

/// 现在前台的灰色内容
struct GrayTarget {
    app: String,
    title: String,
    host: Option<String>,
}

impl GrayTarget {
    fn key(&self) -> String {
        format!("{}|{}", self.host.as_deref().unwrap_or(&self.app), self.title)
    }

    /// 发给 Jev 的「当前窗口」：网页带上站点，判断更稳
    fn describe(&self) -> String {
        match &self.host {
            Some(h) => format!("{}（{h}）", self.title),
            None => self.title.clone(),
        }
    }
}

// ── 规则匹配（和专注锁 / 扩展同一套写法）──

/// 应用规则：exe 名 / 路径（比文件名）/ title:关键词 / window|exe|标题
fn app_matches(rule: &str, app: &str, title: &str) -> bool {
    let rule = rule.trim().replace('/', "\\").to_lowercase();
    let title = title.to_lowercase();
    if let Some(rest) = rule.strip_prefix("window|") {
        let mut parts = rest.splitn(2, '|');
        return parts.next().map(str::trim) == Some(app) && parts.next().map(str::trim) == Some(title.as_str());
    }
    if let Some(kw) = rule.strip_prefix("title:") {
        let kw = kw.trim();
        return !kw.is_empty() && title.contains(kw);
    }
    let base = rule.rsplit('\\').next().unwrap_or(&rule);
    !base.is_empty() && base == app
}

/// `*` 通配的整串匹配
fn glob(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !text.starts_with(first) || text.len() < first.len() + last.len() || !text.ends_with(last) {
        return false;
    }
    let mut rest = &text[first.len()..text.len() - last.len()];
    for mid in &parts[1..parts.len() - 1] {
        match rest.find(mid) {
            Some(i) => rest = &rest[i + mid.len()..],
            None => return false,
        }
    }
    true
}

/// 网站规则：裸域名匹配自己和子域；带路径或 * 的按 host+路径 通配
fn site_matches(rule: &str, host: &str, host_path: &str) -> bool {
    let lowered = rule.trim().to_lowercase();
    let without_scheme = lowered.split_once("://").map_or(lowered.as_str(), |(_, r)| r);
    let pattern = without_scheme.trim_end_matches('/');
    if pattern.is_empty() {
        return false;
    }
    if pattern.contains('/') || pattern.contains('*') {
        return glob(pattern, host) || glob(pattern, host_path);
    }
    host == pattern || host.ends_with(&format!(".{pattern}"))
}

// ── 判断状态（每一局一份）──

struct GrayJudge {
    session_id: String,
    protocol_name: String,
    intent: String,
    gray_apps: Vec<String>,
    gray_sites: Vec<String>,
    last_call: Option<Instant>,
    last_key: Option<String>,
    key_judged_at: Option<Instant>,
    off_streak: u32,
    warned_no_key: bool,
}

impl GrayJudge {
    fn for_session(s: &ProtocolSession) -> Self {
        let grays = |list: &[crate::protocol::AllowEntry]| list.iter().filter(|e| e.gray).map(|e| e.rule.clone()).collect();
        Self {
            session_id: s.id.clone(),
            protocol_name: s.protocol_name.clone(),
            intent: if s.rules.intent.trim().is_empty() { s.protocol_name.clone() } else { s.rules.intent.clone() },
            gray_apps: grays(&s.rules.apps),
            gray_sites: grays(&s.rules.sites),
            last_call: None,
            last_key: None,
            key_judged_at: None,
            off_streak: 0,
            warned_no_key: false,
        }
    }

    fn has_grays(&self) -> bool {
        !self.gray_apps.is_empty() || !self.gray_sites.is_empty()
    }

    fn target(&self) -> Option<GrayTarget> {
        let fg = focus_lock::foreground_window()?;
        if BROWSERS.contains(&fg.app.as_str()) && !self.gray_sites.is_empty() {
            if let Some(tab) = focus_lock::active_tab() {
                if let Ok(url) = url::Url::parse(&tab.url) {
                    let host = url.host_str().unwrap_or("").to_lowercase();
                    let host_path = format!("{host}{}{}", url.path(), url.query().map(|q| format!("?{q}")).unwrap_or_default()).to_lowercase();
                    if self.gray_sites.iter().any(|r| site_matches(r, &host, &host_path)) {
                        let title = if tab.title.is_empty() { fg.title } else { tab.title };
                        return Some(GrayTarget { app: fg.app, title, host: Some(host) });
                    }
                }
            }
        }
        self.gray_apps
            .iter()
            .any(|r| app_matches(r, &fg.app, &fg.title))
            .then(|| GrayTarget { app: fg.app, title: fg.title, host: None })
    }

    async fn tick(&mut self, db: &Database, app: &AppHandle) {
        let Some(target) = self.target() else {
            // 离开灰色内容：「连续」断了
            self.off_streak = 0;
            self.last_key = None;
            return;
        };
        let now = Instant::now();
        if self.last_call.is_some_and(|t| now.duration_since(t) < MIN_GAP) {
            return;
        }
        let key = target.key();
        let same = self.last_key.as_deref() == Some(key.as_str());
        if same && self.key_judged_at.is_some_and(|t| now.duration_since(t) < REJUDGE_AFTER) {
            return;
        }

        self.last_call = Some(now);
        let cfg = match db.jev_config_for(jev::FEATURE_GRAY).await {
            Ok(c) if !c.api_key.is_empty() => c,
            Ok(_) => {
                if !self.warned_no_key {
                    log::info!("[ProtocolGray] 没填判断模型的 Key，灰色地带只放行不判断");
                    self.warned_no_key = true;
                }
                return;
            }
            Err(e) => {
                log::warn!("[ProtocolGray] 读判断模型配置失败: {e}");
                return;
            }
        };
        self.last_key = Some(key);
        self.key_judged_at = Some(now);

        let state = jev::relation_state(&self.intent, &target.app, &target.describe());
        match jev::decide_choice(db, jev::FEATURE_GRAY, &cfg, &state, &jev::relation_question()).await {
            Ok(outcome) => self.apply(db, app, &target, &outcome).await,
            Err(e) => log::warn!("[ProtocolGray] 判断失败: {e}"),
        }
    }

    async fn apply(&mut self, db: &Database, app: &AppHandle, target: &GrayTarget, o: &ChoiceOutcome) {
        let p = o.answer.probabilities.get(&o.answer.choice).copied().unwrap_or(0.0);
        let sure = p >= SURE_PROBABILITY && o.answer.confidence >= SURE_CONFIDENCE;
        let verdict = match (sure, o.answer.choice.as_str()) {
            (true, RELATION_ON_TASK) => "on",
            (true, RELATION_ADJACENT) => "adjacent",
            (true, RELATION_OFF_TASK) => "off",
            _ => "unsure",
        };
        match verdict {
            "off" => self.off_streak += 1,
            "on" => self.off_streak = 0,
            _ => {}
        }

        let mut action = "none";
        if verdict == "off" && self.off_streak >= SQUEEZE_AT {
            if focus_lock::minimize_foreground_app(&target.app) {
                action = "squeeze";
                notify(app, "协议 · 先收起来了", &format!("「{}」连续几次看起来都是娱乐，和「{}」无关", target.title, self.protocol_name));
            }
        } else if verdict == "off" && self.off_streak == WARN_AT {
            action = "warn";
            notify(app, "协议 · 这段像是娱乐", &format!("「{}」\n还在「{}」这一局里", target.title, self.protocol_name));
        }

        let probabilities = serde_json::to_value(&o.answer.probabilities).unwrap_or(serde_json::Value::Null);
        let record = NewJudgment {
            session_id: &self.session_id,
            app: &target.app,
            host: target.host.as_deref(),
            title: &target.title,
            choice: &o.answer.choice,
            confidence: o.answer.confidence,
            probabilities: &probabilities,
            latency_ms: o.latency_ms,
            verdict,
            action,
        };
        if let Err(e) = db.protocol_judgment_record(record).await {
            log::warn!("[ProtocolGray] 记判断失败: {e}");
        }
    }
}

/// 灰色地带判断的后台循环：跟着进行中的局走（换局就换一份判断状态）
pub fn spawn_gray_judge(db: Arc<Database>, app: Arc<AppHandle>) {
    tauri::async_runtime::spawn(async move {
        let mut judge: Option<GrayJudge> = None;
        loop {
            tokio::time::sleep(TICK).await;
            let Some(rules) = focus_lock::protocol_rules() else {
                judge = None;
                continue;
            };
            if judge.as_ref().map(|j| j.session_id.as_str()) != Some(rules.session_id.as_str()) {
                judge = match db.protocol_session_current().await {
                    Ok(Some(s)) if s.id == rules.session_id => Some(GrayJudge::for_session(&s)),
                    _ => None,
                };
            }
            if let Some(j) = judge.as_mut().filter(|j| j.has_grays()) {
                j.tick(&db, &app).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sites() {
        assert!(site_matches("bilibili.com", "www.bilibili.com", "www.bilibili.com/video/bv1"));
        assert!(!site_matches("bilibili.com", "notbilibili.com", "notbilibili.com/"));
        assert!(site_matches("https://www.bilibili.com/", "www.bilibili.com", "www.bilibili.com/"));
        assert!(site_matches("bilibili.com/video/*", "bilibili.com", "bilibili.com/video/bv1"));
        assert!(!site_matches("bilibili.com/video/*", "bilibili.com", "bilibili.com/read/1"));
    }

    #[test]
    fn apps() {
        assert!(app_matches("WindowsTerminal.exe", "windowsterminal.exe", ""));
        assert!(app_matches("C:/Games/Steam.exe", "steam.exe", ""));
        assert!(app_matches("title:原神", "chrome.exe", "【4K】原神 全剧情"));
        assert!(!app_matches("", "chrome.exe", ""));
    }
}
