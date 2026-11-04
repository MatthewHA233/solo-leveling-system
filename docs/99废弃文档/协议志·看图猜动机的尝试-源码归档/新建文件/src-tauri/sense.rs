// ══════════════════════════════════════════════
// 系统 · 感知内核 —— 协议志的「系统」靠它粗略地感到：你此刻在推进今日动机云里的哪一颗
//   敏感、快、不心疼 token：
//     基础节拍每 10 秒看一眼；另外每 0.25 秒瞄一下前台，换了窗口（或标题变了）停稳 0.6 秒就马上加看一眼
//   每一眼只判一件粗的事，一次请求问完：
//     截当前窗口 768px + 标题 → 决策模型做一道选择题「在推进云里的哪一颗 / 这一局的用意 / 都不在」，
//     外加每一颗一道是非题「是在推进它吗」（选择题一定会选一个，是非题兜「其实都不在」的底）
//     动机是这个月自嗨开发的动机（sense_motives.rs，和洪流域的旧动机锚点无关）
//   有把握判中 → 今天这一颗按实际间隔累计时长（sense_tally）→ 动机云里它更亮
//   一次没落在任何一颗上 → 马上请会看图的大模型提议一颗（sense_hypo.rs；换窗口时和判断同时发出去），提出来就由系统窗口问你
//     「要把「……」收进动机云吗？」（system:ask），你答「是」它才算数
//   每一步想了什么、花了多久都写进思维终端（sense_thoughts.rs）
//   全部是临时判断：只在内存里滚动，不进昼夜表；聊天 / 密码类窗口什么都不发；每天有预算上限
//   模型在模型库绑定（system_sense_vision / system_sense / system_sense_hypothesis）
// ══════════════════════════════════════════════

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::db::Database;
use crate::focus_lock;
use crate::jev::{self, DecideState, FEATURE_SENSE, FEATURE_SENSE_VISION};
use crate::sense_motives::Candidate;
use crate::sense_hypo;
use crate::sense_thoughts::think;

pub const SENSE_EVENT: &str = "system:sense";
pub const ASK_EVENT: &str = "system:ask";

/// 基础节拍：每 10 秒看一眼
const TICK: Duration = Duration::from_secs(10);
const TICK_SECONDS: i64 = 10;
/// 另外每 0.25 秒瞄一下前台窗口：换了窗口（或标题变了）停稳 0.6 秒就马上加看一眼，不等节拍；
/// 两次看之间至少隔 2 秒（有的窗口标题一直在跳）
const POLL: Duration = Duration::from_millis(250);
const SWITCH_SETTLE: Duration = Duration::from_millis(600);
const SWITCH_MIN_GAP: Duration = Duration::from_secs(2);
const SHOT_SIDE: u32 = 768;
const SHOT_QUALITY: u8 = 80;
const SURE_PROBABILITY: f64 = 0.8;
const SURE_CONFIDENCE: f64 = 0.75;
/// 选中后再问一道是非题「此刻是在推进它吗」：低于这个算「都不在」，高于 FIT_SURE 才算有把握
/// （选择题一定会选一个，很多时候真答案不在选项里——这道题就是兜这个底）
const FIT_NONE: f64 = 0.5;
const FIT_SURE: f64 = 0.8;
/// 一次没落在云里任何一颗动机上就马上提议新动机；两次提议只隔几秒（防同一瞬间重复），没提成 10 秒后再试
/// 换窗口时不等判完：判断和提议同时发出去，判下来对不上，提议已经在手上（不心疼 token）
const PROPOSE_AFTER: u32 = 1;
const PROPOSE_COOLDOWN: Duration = Duration::from_secs(5);
const PROPOSE_RETRY: Duration = Duration::from_secs(10);
/// 提议一次约多少美元（百炼 Max 3.8 关思考：~600 输入 token，按 ¥12/百万折算），计进每日预算
const PROPOSE_USD: f64 = 0.001;
/// 两次发问至少隔 6 秒；同一颗没理会的提议 3 分钟后可以再问
const ASK_COOLDOWN: Duration = Duration::from_secs(6);
const ASK_SAME_KEY_COOLDOWN: Duration = Duration::from_secs(3 * 60);
const CONFIG_REFRESH: Duration = Duration::from_secs(30);
const TITLE_MAX_CHARS: usize = 200;
/// 估算花费（美元 / 百万输入 token）：截图走 Liquid d1、标题走 Decision-1
const TEXT_USD_PER_M: f64 = 0.042;
const IMAGE_USD_PER_M: f64 = 0.04;
const DEFAULT_DAILY_BUDGET_USD: f64 = 3.0;
const NONE_KEY: &str = "none";

const CHAT_APPS: &[&str] = &[
    "qq.exe", "wechat.exe", "weixin.exe", "tim.exe", "telegram.exe", "discord.exe",
    "dingtalk.exe", "feishu.exe", "lark.exe", "whatsapp.exe", "line.exe",
];
const VAULT_APPS: &[&str] = &["1password.exe", "keepass.exe", "keepassxc.exe", "bitwarden.exe"];
/// 标题带这些词的窗口不截图（只按标题判）
const NO_SHOT_WORDS: &[&str] = &["密码", "银行", "支付", "验证码", "password", "bank", "login", "登录"];

// ── 状态 / 配置 ──

/// 系统此刻的临时判断
#[derive(Clone, Debug, Default, Serialize)]
pub struct SenseState {
    pub app: String,
    pub title: String,
    /// 此刻在推进的候选（m: 动机 / p: 这一局）；None = 都不在 / 没判
    pub goal_key: Option<String>,
    /// 给人看的一句话
    pub goal: Option<String>,
    pub goal_p: f64,
    pub sure: bool,
    /// 已经收进云里（false = 系统提议、你还没答）
    pub confirmed: bool,
    /// shot / title / private / self / off / budget
    pub source: String,
    /// 同一颗连续从什么时候开始（Unix ms），心流计时用
    pub since_ms: i64,
    pub at_ms: i64,
}

/// 系统来问你
#[derive(Clone, Debug, Serialize)]
pub struct AskPayload {
    pub key: String,
    pub text: String,
    pub question: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SenseConfig {
    pub enabled: bool,
    pub screenshots: bool,
    pub daily_budget_usd: f64,
}

impl Default for SenseConfig {
    fn default() -> Self {
        Self { enabled: true, screenshots: true, daily_budget_usd: DEFAULT_DAILY_BUDGET_USD }
    }
}

static CURRENT: OnceLock<std::sync::Mutex<SenseState>> = OnceLock::new();

fn current() -> &'static std::sync::Mutex<SenseState> {
    CURRENT.get_or_init(|| std::sync::Mutex::new(SenseState::default()))
}

pub fn current_state() -> SenseState {
    current().lock().unwrap().clone()
}

pub(crate) fn init_sense_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS sense_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER NOT NULL DEFAULT 1,
            screenshots INTEGER NOT NULL DEFAULT 1,
            daily_budget_usd REAL NOT NULL DEFAULT 0.5,
            updated_at TEXT NOT NULL
        );
    "#).map_err(|e| format!("创建感知表失败: {}", e))
}

impl Database {
    pub async fn sense_config(&self) -> Result<SenseConfig, String> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row("SELECT enabled, screenshots, daily_budget_usd FROM sense_config WHERE id = 1", [], |r| {
                Ok(SenseConfig { enabled: r.get(0)?, screenshots: r.get(1)?, daily_budget_usd: r.get(2)? })
            })
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.unwrap_or_default())
    }

    pub async fn sense_config_update(&self, cfg: SenseConfig) -> Result<SenseConfig, String> {
        let budget = if cfg.daily_budget_usd.is_finite() { cfg.daily_budget_usd.clamp(0.0, 10.0) } else { DEFAULT_DAILY_BUDGET_USD };
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO sense_config (id, enabled, screenshots, daily_budget_usd, updated_at) VALUES (1, ?1, ?2, ?3, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET enabled = ?1, screenshots = ?2, daily_budget_usd = ?3, updated_at = datetime('now')",
            params![cfg.enabled, cfg.screenshots, budget],
        )
        .map_err(|e| e.to_string())?;
        Ok(SenseConfig { daily_budget_usd: budget, ..cfg })
    }
}

/// 去掉标题里会变的噪声：开头的转圈 / 状态符号、未读数「(3)」、浏览器后缀
pub(crate) fn normalize_title(title: &str) -> String {
    let t = title.trim_start_matches(|c: char| {
        ('\u{2800}'..='\u{28FF}').contains(&c) || "✳✻✶✢✽·*•◐◓◑◒●○ ".contains(c)
    });
    let t = match t.strip_prefix('(').and_then(|r| r.split_once(')')) {
        Some((n, rest)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => rest.trim_start(),
        _ => t,
    };
    let t = t.trim_end_matches(" - Google Chrome").trim_end_matches(" - Microsoft Edge");
    t.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(TITLE_MAX_CHARS).collect()
}

/// 候选给人看的一句话：动机就是它本身；这一局的用意带个前缀
fn display_of(c: &Candidate) -> String {
    match c.text.strip_prefix("这一局的用意：") {
        Some(intent) => format!("这一局：{intent}"),
        None => c.text.clone(),
    }
}

fn question_of(c: &Candidate) -> String {
    format!("要把「{}」收进动机云吗？", c.text)
}

// ── 每日预算 ──

struct Budget {
    day: chrono::NaiveDate,
    spent_usd: f64,
    warned: bool,
}

impl Budget {
    fn new() -> Self {
        Self { day: chrono::Local::now().date_naive(), spent_usd: 0.0, warned: false }
    }

    fn allows(&mut self, limit: f64) -> bool {
        let today = chrono::Local::now().date_naive();
        if today != self.day {
            *self = Self::new();
        }
        let ok = self.spent_usd < limit;
        if !ok && !self.warned {
            log::info!("[Sense] 今天的判断预算 ${limit} 已用完，系统先歇着");
            self.warned = true;
        }
        ok
    }

    fn add(&mut self, tokens: i64, image: bool) {
        let rate = if image { IMAGE_USD_PER_M } else { TEXT_USD_PER_M };
        self.spent_usd += tokens.max(0) as f64 * rate / 1_000_000.0;
    }
}

// ── 截图 ──

/// 截当前窗口；返回 JPEG 和「抓屏 / 转换 / 缩放编码」各段耗时的说明
fn capture() -> Option<(Vec<u8>, String)> {
    #[cfg(windows)]
    {
        match crate::perception::capture_active_window_jpeg(SHOT_SIDE, SHOT_QUALITY) {
            Ok(shot) => Some((shot.jpeg, format!("抓 {} + 转 {} + 缩 {}ms", shot.grab_ms, shot.convert_ms, shot.shrink_ms))),
            Err(e) => {
                log::warn!("[Sense] 截图失败: {e}");
                None
            }
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

// ── 主循环 ──

#[derive(Clone)]
struct Judgment {
    /// None = 都不在（选了「都不在」，或选中的那个核实下来不是）
    candidate: Option<Candidate>,
    p: f64,
    /// 选中且核实过：p、把握度、是非题都过线
    sure: bool,
}

impl Judgment {
    const NOTHING: Judgment = Judgment { candidate: None, p: 0.0, sure: false };

    /// 有把握地落在云里某一颗动机上（含系统提议、还没答的）
    fn on_motive(&self) -> bool {
        self.sure && self.candidate.as_ref().is_some_and(|c| c.key.starts_with("m:"))
    }
}

#[derive(Default)]
struct Kernel {
    config: Option<(Instant, SenseConfig)>,
    budget: Option<Budget>,
    /// 连续多少次没落在任何一颗动机上
    miss_streak: u32,
    /// 下一次最早什么时候可以提议
    next_proposal: Option<Instant>,
    last_ask: Option<Instant>,
    asked: HashMap<String, Instant>,
    /// 上一次看的是哪个窗口：前台换了就马上加看一眼
    judged_window: Option<String>,
    /// 上一次判是什么时候：今天推进了多久按实际间隔累计（换窗口加看的那几眼不重复记满 10 秒）
    last_judged: Option<Instant>,
}

/// 前台窗口的身份：exe + 去掉噪声的标题；Solevup 自己在前台时是 "self"
fn window_key(fg: Option<&focus_lock::ForegroundWindow>) -> String {
    fg.map_or_else(|| "self".to_string(), |w| format!("{}\u{1}{}", w.app, normalize_title(&w.title)))
}

/// 这一眼看到的东西（提议时要用）
struct Look<'a> {
    jpeg: Option<&'a [u8]>,
    app: &'a str,
    title: &'a str,
    /// 云里已有的动机（提议别和它们重复）
    known: &'a [String],
}

/// 大模型的提议（或没提成的原因）+ 耗时
type Proposal = (Result<String, String>, u64);

async fn propose_timed(db: &Database, jpeg: &[u8], look: &Look<'_>) -> Proposal {
    let t0 = Instant::now();
    let r = sense_hypo::propose_motive(db, jpeg, look.app, look.title, look.known).await;
    (r, t0.elapsed().as_millis() as u64)
}

fn publish(app: &AppHandle, state: SenseState) {
    *current().lock().unwrap() = state.clone();
    if let Err(e) = app.emit(SENSE_EVENT, state) {
        log::warn!("[Sense] 广播失败: {e}");
    }
}

impl Kernel {
    async fn config(&mut self, db: &Database) -> SenseConfig {
        if let Some((t, c)) = &self.config {
            if t.elapsed() < CONFIG_REFRESH {
                return c.clone();
            }
        }
        let c = db.sense_config().await.unwrap_or_default();
        self.config = Some((Instant::now(), c.clone()));
        c
    }

    fn budget(&mut self) -> &mut Budget {
        self.budget.get_or_insert_with(Budget::new)
    }

    /// 问决策模型；返回答案和耗时
    async fn ask_model(&mut self, db: &Database, app: &AppHandle, state: &DecideState<'_>, questions: serde_json::Value) -> Option<(serde_json::Value, u64)> {
        let image = matches!(state, DecideState::WithImage { .. });
        let feature = if image { FEATURE_SENSE_VISION } else { FEATURE_SENSE };
        let Some(cfg) = db.jev_config_for(feature).await.ok().filter(|c| !c.api_key.is_empty()) else {
            think(app, "error", "没填判断模型的 Key".into(), None);
            return None;
        };
        match jev::decide(db, feature, &cfg, state, questions).await {
            Ok(out) => {
                self.budget().add(out.input_tokens, image);
                Some((out.answers, out.latency_ms))
            }
            Err(e) => {
                think(app, "error", format!("判断失败：{e}"), None);
                None
            }
        }
    }

    /// 一次请求问完：选择题「此刻在推进哪一颗」+ 每一颗一道是非题「是在推进它吗」
    /// （选择题一定会选一个，是非题兜「其实都不在」的底；合在一起只走一趟网络）
    async fn judge(&mut self, db: &Database, app: &AppHandle, candidates: &[Candidate], text: &str, jpeg: Option<&[u8]>) -> Option<Judgment> {
        if candidates.is_empty() {
            think(app, "pick", "云里还没有动机 → 都不在".into(), None);
            return Some(Judgment::NOTHING);
        }
        let state = match jpeg {
            Some(j) => DecideState::WithImage { text, jpeg: j },
            None => DecideState::Text(text),
        };
        let mut criteria: Vec<(String, String)> = candidates.iter().enumerate().map(|(i, c)| (format!("g{i}"), c.text.clone())).collect();
        criteria.push((NONE_KEY.into(), "都不在：在做别的事".into()));
        let mut questions = serde_json::Map::new();
        questions.insert("goal".into(), jev::choice_json("用户此刻在推进哪一件事", &criteria));
        for (i, c) in candidates.iter().enumerate() {
            questions.insert(format!("fit{i}"), jev::noul_json(&format!("用户此刻在做的事，是在推进「{}」", display_of(c))));
        }
        let (answers, ms) = self.ask_model(db, app, &state, serde_json::Value::Object(questions)).await?;
        let answer = jev::parse_choice(&answers, "goal")?;
        let p = answer.probabilities.get(&answer.choice).copied().unwrap_or(0.0);
        let picked = answer.choice.strip_prefix('g').and_then(|n| n.parse::<usize>().ok()).filter(|&i| i < candidates.len());
        let Some(i) = picked else {
            think(app, "pick", format!("{} 个候选 → 都不在（p {p:.2}）", candidates.len()), Some(ms));
            return Some(Judgment { p, ..Judgment::NOTHING });
        };
        let candidate = candidates[i].clone();
        let fit = jev::parse_noul(&answers, &format!("fit{i}")).unwrap_or(0.0);
        let sure = p >= SURE_PROBABILITY && answer.confidence >= SURE_CONFIDENCE && fit >= FIT_SURE;
        let verdict = if fit < FIT_NONE { "不是，算都不在" } else if sure { "算数" } else { "没把握" };
        think(
            app,
            "pick",
            format!("{} 个候选 → 「{}」 p {p:.2} 把握 {:.2} 核实 {fit:.2} → {verdict}", candidates.len(), display_of(&candidate), answer.confidence),
            Some(ms),
        );
        if fit < FIT_NONE {
            return Some(Judgment { p, ..Judgment::NOTHING });
        }
        Some(Judgment { candidate: Some(candidate), p, sure })
    }

    /// 现在能不能请大模型提议（冷却过了、预算还有）
    fn proposal_open(&mut self, cfg: &SenseConfig) -> bool {
        self.next_proposal.map_or(true, |t| Instant::now() >= t) && self.budget().allows(cfg.daily_budget_usd)
    }

    /// 没落在云里任何一颗上 → 请大模型看图提一颗；提进来了返回它（马上拿去问你）
    /// early = 换窗口时和判断同时发出去、已经拿到手的提议（这时不再请一次）
    async fn maybe_propose(&mut self, db: &Database, app: &AppHandle, look: &Look<'_>, cfg: &SenseConfig, early: Option<Proposal>) -> Option<Candidate> {
        let (line, ms) = match early {
            Some(p) => p,
            None => {
                let jpeg = look.jpeg?;
                if self.miss_streak < PROPOSE_AFTER || !self.proposal_open(cfg) {
                    return None;
                }
                self.budget().spent_usd += PROPOSE_USD;
                think(app, "propose", "对不上云里任何一颗 → 请大模型看图提一颗".into(), None);
                propose_timed(db, jpeg, look).await
            }
        };
        self.next_proposal = Some(Instant::now() + PROPOSE_RETRY);
        let ms = Some(ms);
        let retry = PROPOSE_RETRY.as_secs();
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                think(app, "error", format!("没提成（{e}），{retry} 秒后再试"), ms);
                return None;
            }
        };
        match db.sense_motive_add(&line, false).await {
            Ok(Some(m)) => {
                self.next_proposal = Some(Instant::now() + PROPOSE_COOLDOWN);
                think(app, "propose", format!("提议：{}", m.text), ms);
                Some(Candidate { key: format!("m:{}", m.id), text: m.text, kept: false })
            }
            Ok(None) => {
                think(app, "propose", format!("提议「{line}」之前被你拿掉过，{retry} 秒后再试"), ms);
                None
            }
            Err(e) => {
                think(app, "error", format!("记提议失败：{e}"), None);
                None
            }
        }
    }

    /// 落在一颗系统提议、你还没答的动机上 → 问你收不收
    fn maybe_ask(&mut self, app: &AppHandle, j: &Judgment) {
        let Some(c) = &j.candidate else { return };
        if c.kept || !c.key.starts_with("m:") {
            return;
        }
        if self.last_ask.is_some_and(|t| t.elapsed() < ASK_COOLDOWN) || self.asked.get(&c.key).is_some_and(|t| t.elapsed() < ASK_SAME_KEY_COOLDOWN) {
            think(app, "skip", "刚问过，先不打扰".into(), None);
            return;
        }
        self.last_ask = Some(Instant::now());
        self.asked.insert(c.key.clone(), Instant::now());
        let payload = AskPayload { key: c.key.clone(), text: c.text.clone(), question: question_of(c) };
        think(app, "ask", format!("问你：{}", payload.question), None);
        if let Err(e) = app.emit(ASK_EVENT, payload) {
            log::warn!("[Sense] 发问失败: {e}");
        }
    }

    /// switched = 这一眼是换了窗口加看的（不是 10 秒节拍）
    async fn tick(&mut self, db: &Database, app: &AppHandle, switched: bool) {
        let fg = focus_lock::foreground_window();
        self.judged_window = Some(window_key(fg.as_ref()));
        let cfg = self.config(db).await;
        let now_ms = focus_lock::now_ms();
        let prev = current_state();
        if !cfg.enabled {
            if prev.source != "off" {
                think(app, "skip", "感知已关".into(), None);
                publish(app, SenseState { source: "off".into(), at_ms: now_ms, ..SenseState::default() });
            }
            return;
        }
        let Some(fg) = fg else {
            if prev.source != "self" {
                think(app, "skip", "前台是 Solevup 自己，不看".into(), None);
                publish(app, SenseState { app: "Solevup".into(), source: "self".into(), at_ms: now_ms, ..SenseState::default() });
            }
            return;
        };
        let title = normalize_title(&fg.title);
        if CHAT_APPS.contains(&fg.app.as_str()) || VAULT_APPS.contains(&fg.app.as_str()) {
            if prev.source != "private" {
                think(app, "skip", format!("{} 是聊天 / 密码类，不看", fg.app), None);
            }
            publish(app, SenseState { app: fg.app, source: "private".into(), at_ms: now_ms, ..SenseState::default() });
            return;
        }

        let protocol = match db.protocol_session_current().await {
            Ok(Some(s)) => Some((s.id.clone(), s.rules.intent.clone())),
            _ => None,
        };
        let protocol_ref = protocol.as_ref().map(|(id, intent)| (id.as_str(), intent.as_str()));
        let candidates = db.sense_candidates(protocol_ref).await;
        let lowered = title.to_lowercase();
        let t0 = Instant::now();
        let shot = if cfg.screenshots && !NO_SHOT_WORDS.iter().any(|w| lowered.contains(w)) { capture() } else { None };
        let why = if switched { "换窗口 · " } else { "" };
        let look = match &shot {
            Some((j, parts)) => format!("{why}{}「{title}」 截图 {}KB（{parts}）", fg.app, j.len() / 1024),
            None => format!("{why}{}「{title}」 只看标题", fg.app),
        };
        let jpeg = shot.map(|(j, _)| j);
        think(app, "look", look, Some(t0.elapsed().as_millis() as u64));
        let text = format!("用户电脑当前窗口：{}「{title}」", fg.app);

        if !self.budget().allows(cfg.daily_budget_usd) {
            think(app, "skip", "今天的预算用完了".into(), None);
            return;
        }
        let lived_seconds = self.last_judged.map_or(TICK_SECONDS, |t| (t.elapsed().as_secs() as i64).min(TICK_SECONDS));
        self.last_judged = Some(Instant::now());
        let known: Vec<String> = candidates.iter().filter(|c| c.key.starts_with("m:")).map(|c| c.text.clone()).collect();
        let look = Look { jpeg: jpeg.as_deref(), app: &fg.app, title: &title, known: &known };
        // 换窗口：判断和提议同时发出去（不心疼 token），判下来对不上就直接用这条提议，省一趟
        let speculate = switched && jpeg.is_some() && self.proposal_open(&cfg);
        let (mut judgment, early) = match (speculate, jpeg.as_deref()) {
            (true, Some(jp)) => {
                self.budget().spent_usd += PROPOSE_USD;
                think(app, "propose", "换窗口 → 判断的同时先请大模型看图提一颗".into(), None);
                let (j, p) = tokio::join!(self.judge(db, app, &candidates, &text, jpeg.as_deref()), propose_timed(db, jp, &look));
                (j, Some(p))
            }
            _ => (self.judge(db, app, &candidates, &text, jpeg.as_deref()).await, None),
        };
        if let Some(j) = &judgment {
            self.miss_streak = if j.on_motive() { 0 } else { self.miss_streak + 1 };
        }

        // 没落在云里任何一颗上 → 马上提议一颗，提出来就问你收不收（不再重判，省一趟）
        if judgment.as_ref().is_some_and(|j| !j.on_motive()) {
            if let Some(c) = self.maybe_propose(db, app, &look, &cfg, early).await {
                self.miss_streak = 0;
                judgment = Some(Judgment { candidate: Some(c), p: 0.0, sure: false });
            }
        } else if let (true, Some((Ok(line), _))) = (judgment.as_ref().is_some_and(|j| j.on_motive()), early) {
            think(app, "skip", format!("判中了，提议「{line}」作废"), None);
        }

        let sure = judgment.as_ref().is_some_and(|j| j.sure);
        let candidate = judgment.as_ref().and_then(|j| j.candidate.clone());
        if let Some(j) = &judgment {
            if let (true, Some(c)) = (sure, &candidate) {
                if lived_seconds > 0 {
                    db.sense_tally_add(&c.key, lived_seconds).await;
                }
            }
            self.maybe_ask(app, j);
        }

        let key = candidate.as_ref().map(|c| c.key.clone());
        let since_ms = if key.is_some() && key == prev.goal_key && prev.since_ms > 0 { prev.since_ms } else { now_ms };
        publish(
            app,
            SenseState {
                app: fg.app,
                title,
                goal: candidate.as_ref().map(display_of),
                confirmed: candidate.as_ref().is_some_and(|c| c.kept),
                goal_key: key,
                goal_p: judgment.as_ref().map_or(0.0, |j| j.p),
                sure,
                source: if jpeg.is_some() { "shot".into() } else { "title".into() },
                since_ms,
                at_ms: now_ms,
            },
        );
    }
}

/// 感知内核的后台循环（setup 里启动）：每 10 秒看一眼；另外每 0.25 秒瞄一下前台，换了窗口停稳就马上加看一眼
pub fn spawn_sense_kernel(db: Arc<Database>, app: Arc<AppHandle>) {
    tauri::async_runtime::spawn(async move {
        let mut kernel = Kernel::default();
        let mut last_tick = Instant::now();
        // 前台窗口，以及它从什么时候起没再变
        let mut seen: Option<(String, Instant)> = None;
        loop {
            tokio::time::sleep(POLL).await;
            let key = window_key(focus_lock::foreground_window().as_ref());
            if seen.as_ref().map_or(true, |(k, _)| *k != key) {
                seen = Some((key.clone(), Instant::now()));
            }
            let settled = seen.as_ref().is_some_and(|(_, since)| since.elapsed() >= SWITCH_SETTLE);
            let switched = settled && kernel.judged_window.as_deref() != Some(key.as_str()) && last_tick.elapsed() >= SWITCH_MIN_GAP;
            if switched || last_tick.elapsed() >= TICK {
                last_tick = Instant::now();
                kernel.tick(&db, &app, switched).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles() {
        assert_eq!(normalize_title("⠐ Claude Code"), "Claude Code");
        assert_eq!(normalize_title("(3) 微信"), "微信");
        assert_eq!(normalize_title("New chat - Claude - Google Chrome"), "New chat - Claude");
    }

    #[test]
    fn questions() {
        let m = Candidate { key: "m:1".into(), text: "把协议志做成独自升级系统".into(), kept: false };
        assert_eq!(question_of(&m), "要把「把协议志做成独自升级系统」收进动机云吗？");
        let p = Candidate { key: "p:1".into(), text: "这一局的用意：推进 Solevup".into(), kept: true };
        assert_eq!(display_of(&p), "这一局：推进 Solevup");
    }
}
