// ══════════════════════════════════════════════
// 协议志 · 协议（锁机白名单）—— 每份协议自带一份白名单，开局后只放行名单里的应用 / 网站
//   协议 = protocols 一行；白名单每项可标「灰色」= 先放行、留给 AI 实时判断（现在只放行 + 照常记感知）
//   一局 = protocol_sessions 一行：开局时把白名单和强度冻结进 rules（开局后改协议，下一局才生效）；
//          ended_at 为空 = 正在进行，软件重启后接着锁（protocol_watch.rs）
//   拦截记录 = protocol_intercepts，复盘用，界面上不实时显示
//   强度：soft 申请结束后冷却 1 分钟 / firm 冷却 10 分钟 / hard 定好的时间到之前不能结束（必须定时）
//   执行复用专注锁（focus_lock.rs）：网站走 Chrome 扩展（全拦 + 白名单放行），应用走前台窗口监控
// ══════════════════════════════════════════════

use chrono::{Duration, Local, NaiveDateTime, TimeZone};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use crate::db::{Database, PERCEPTION_BUCKETS_TABLE, PERCEPTION_EVENTS_TABLE};

const TIME_FMT: &str = "%Y-%m-%d %H:%M:%S";
const NAME_MAX_CHARS: usize = 60;
const INTENT_MAX_CHARS: usize = 500;
const RULE_MAX_CHARS: usize = 300;
const MAX_ENTRIES: usize = 200;
const SOFT_STOP_COOLDOWN_SECS: i64 = 60;
const FIRM_STOP_COOLDOWN_SECS: i64 = 10 * 60;
const MAX_SESSION_MINUTES: i64 = 16 * 60;
const MAX_DAILY_TARGET_MIN: i64 = 24 * 60;
const DEFAULT_DAILY_TARGET_MIN: i64 = 600;
const INTERCEPT_LIST_LIMIT: i64 = 500;
const APP_USAGE_MAX_DAYS: i64 = 30;
const APP_USAGE_LIMIT: usize = 60;

// ── 数据结构 ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strength {
    Soft,
    Firm,
    Hard,
}

impl Strength {
    fn as_str(self) -> &'static str {
        match self {
            Strength::Soft => "soft",
            Strength::Firm => "firm",
            Strength::Hard => "hard",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "firm" => Strength::Firm,
            "hard" => Strength::Hard,
            _ => Strength::Soft,
        }
    }

    fn stop_cooldown(self) -> Duration {
        match self {
            Strength::Soft => Duration::seconds(SOFT_STOP_COOLDOWN_SECS),
            Strength::Firm => Duration::seconds(FIRM_STOP_COOLDOWN_SECS),
            Strength::Hard => Duration::zero(),
        }
    }
}

/// 白名单一项：应用写 exe 名（或路径 / title:关键词，同专注锁），网站写域名（可带路径和 *）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AllowEntry {
    pub rule: String,
    /// 灰色地带：放行，但这段时间是学习还是娱乐留给 AI 判断
    #[serde(default)]
    pub gray: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Protocol {
    pub id: String,
    pub name: String,
    /// 这份协议为了什么（一句话；以后 AI 判断灰色地带时拿它当标准）
    pub intent: String,
    pub apps: Vec<AllowEntry>,
    pub sites: Vec<AllowEntry>,
    pub strength: Strength,
    pub daily_target_min: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateProtocolRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProtocolRequest {
    pub name: Option<String>,
    pub intent: Option<String>,
    pub apps: Option<Vec<AllowEntry>>,
    pub sites: Option<Vec<AllowEntry>>,
    pub strength: Option<Strength>,
    pub daily_target_min: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct StartSessionRequest {
    /// 这一局多长（分钟）；不填 = 不限时（硬锁必须填）
    pub minutes: Option<i64>,
}

/// 开局时冻结下来的规则
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRules {
    pub apps: Vec<AllowEntry>,
    pub sites: Vec<AllowEntry>,
    pub strength: Strength,
    /// 协议用意（灰色地带的判断标准）；空 = 用协议名
    #[serde(default)]
    pub intent: String,
}

/// 灰色地带的一次 AI 判断（复盘用）
#[derive(Debug, Serialize)]
pub struct ProtocolJudgment {
    pub at: String,
    pub app: String,
    pub host: Option<String>,
    pub title: String,
    pub choice: String,
    pub confidence: f64,
    pub probabilities: serde_json::Value,
    /// on / adjacent / off = 有把握的判断；unsure = 没把握
    pub verdict: String,
    /// none / warn = 提醒了 / squeeze = 收起了窗口
    pub action: String,
}

pub struct NewJudgment<'a> {
    pub session_id: &'a str,
    pub app: &'a str,
    pub host: Option<&'a str>,
    pub title: &'a str,
    pub choice: &'a str,
    pub confidence: f64,
    pub probabilities: &'a serde_json::Value,
    pub latency_ms: u64,
    pub verdict: &'a str,
    pub action: &'a str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProtocolSession {
    pub id: String,
    pub protocol_id: String,
    pub protocol_name: String,
    pub rules: SessionRules,
    pub started_at: String,
    pub planned_end_at: Option<String>,
    pub ended_at: Option<String>,
    /// done = 到点 / stopped = 自己结束
    pub end_reason: Option<String>,
    pub stop_requested_at: Option<String>,
    /// 最早什么时候能结束：软 / 中 = 申请结束 + 冷却（没申请 = None）；硬 = 定好的结束时刻
    pub can_stop_at: Option<String>,
    pub intercept_count: i64,
}

#[derive(Debug, Serialize)]
pub struct ProtocolIntercept {
    pub at: String,
    pub kind: String,
    pub target: String,
    pub title: String,
}

/// 最近一段时间各应用在前台的时长（白名单候选）
#[derive(Debug, Serialize)]
pub struct AppUsage {
    pub app: String,
    pub seconds: i64,
}

// ── 建表 ──

pub(crate) fn init_protocol_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS protocols (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            intent TEXT NOT NULL DEFAULT '',
            apps TEXT NOT NULL DEFAULT '[]',
            sites TEXT NOT NULL DEFAULT '[]',
            strength TEXT NOT NULL DEFAULT 'soft',
            daily_target_min INTEGER NOT NULL DEFAULT 600,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS protocol_sessions (
            id TEXT PRIMARY KEY,
            protocol_id TEXT NOT NULL,
            protocol_name TEXT NOT NULL,
            rules TEXT NOT NULL,
            started_at TEXT NOT NULL,
            planned_end_at TEXT,
            ended_at TEXT,
            end_reason TEXT,
            stop_requested_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_protocol_sessions_started ON protocol_sessions(started_at);
        CREATE INDEX IF NOT EXISTS idx_protocol_sessions_open ON protocol_sessions(ended_at);
        CREATE TABLE IF NOT EXISTS protocol_intercepts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            at TEXT NOT NULL,
            kind TEXT NOT NULL,
            target TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_protocol_intercepts_session ON protocol_intercepts(session_id, at);
        CREATE TABLE IF NOT EXISTS protocol_judgments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            at TEXT NOT NULL,
            app TEXT NOT NULL,
            host TEXT,
            title TEXT NOT NULL,
            choice TEXT NOT NULL,
            confidence REAL NOT NULL,
            probabilities TEXT NOT NULL,
            latency_ms INTEGER NOT NULL,
            verdict TEXT NOT NULL,
            action TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_protocol_judgments_session ON protocol_judgments(session_id, at);
    "#).map_err(|e| format!("创建协议表失败: {}", e))
}

// ── 时间 ──

fn now() -> NaiveDateTime {
    Local::now().naive_local()
}

pub(crate) fn fmt_time(t: NaiveDateTime) -> String {
    t.format(TIME_FMT).to_string()
}

pub(crate) fn parse_time(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, TIME_FMT).ok()
}

pub(crate) fn to_unix_ms(t: NaiveDateTime) -> Option<i64> {
    Local.from_local_datetime(&t).earliest().map(|d| d.timestamp_millis())
}

// ── 校验 ──

fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("协议名不能为空".into());
    }
    Ok(name.chars().take(NAME_MAX_CHARS).collect())
}

fn clean_entries(list: Vec<AllowEntry>) -> Result<Vec<AllowEntry>, String> {
    if list.len() > MAX_ENTRIES {
        return Err(format!("白名单最多 {MAX_ENTRIES} 项"));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(list.len());
    for entry in list {
        let rule = entry.rule.trim();
        if rule.is_empty() {
            continue;
        }
        if rule.chars().count() > RULE_MAX_CHARS {
            return Err(format!("白名单单项最长 {RULE_MAX_CHARS} 字"));
        }
        if seen.insert(rule.to_lowercase()) {
            out.push(AllowEntry { rule: rule.to_string(), gray: entry.gray });
        }
    }
    Ok(out)
}

fn to_json(entries: &[AllowEntry]) -> Result<String, String> {
    serde_json::to_string(entries).map_err(|e| e.to_string())
}

// ── 行映射 ──

const PROTOCOL_COLUMNS: &str =
    "id, name, intent, apps, sites, strength, daily_target_min, created_at, updated_at";

fn map_protocol(row: &rusqlite::Row) -> rusqlite::Result<Protocol> {
    let apps: String = row.get(3)?;
    let sites: String = row.get(4)?;
    let strength: String = row.get(5)?;
    Ok(Protocol {
        id: row.get(0)?,
        name: row.get(1)?,
        intent: row.get(2)?,
        apps: serde_json::from_str(&apps).unwrap_or_default(),
        sites: serde_json::from_str(&sites).unwrap_or_default(),
        strength: Strength::parse(&strength),
        daily_target_min: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const SESSION_COLUMNS: &str = "s.id, s.protocol_id, s.protocol_name, s.rules, s.started_at, s.planned_end_at,
     s.ended_at, s.end_reason, s.stop_requested_at,
     (SELECT COUNT(*) FROM protocol_intercepts i WHERE i.session_id = s.id)";

fn can_stop_at(rules: &SessionRules, planned_end_at: Option<&str>, stop_requested_at: Option<&str>) -> Option<String> {
    match rules.strength {
        Strength::Hard => planned_end_at.map(str::to_string),
        s => stop_requested_at
            .and_then(parse_time)
            .map(|t| fmt_time(t + s.stop_cooldown())),
    }
}

fn map_session(row: &rusqlite::Row) -> rusqlite::Result<ProtocolSession> {
    let rules_json: String = row.get(3)?;
    let rules: SessionRules = serde_json::from_str(&rules_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let planned_end_at: Option<String> = row.get(5)?;
    let stop_requested_at: Option<String> = row.get(8)?;
    let can_stop = can_stop_at(&rules, planned_end_at.as_deref(), stop_requested_at.as_deref());
    Ok(ProtocolSession {
        id: row.get(0)?,
        protocol_id: row.get(1)?,
        protocol_name: row.get(2)?,
        rules,
        started_at: row.get(4)?,
        planned_end_at,
        ended_at: row.get(6)?,
        end_reason: row.get(7)?,
        stop_requested_at,
        can_stop_at: can_stop,
        intercept_count: row.get(9)?,
    })
}

fn get_protocol(conn: &Connection, id: &str) -> Result<Option<Protocol>, String> {
    conn.query_row(
        &format!("SELECT {PROTOCOL_COLUMNS} FROM protocols WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        map_protocol,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn get_session(conn: &Connection, id: &str) -> Result<Option<ProtocolSession>, String> {
    conn.query_row(
        &format!("SELECT {SESSION_COLUMNS} FROM protocol_sessions s WHERE s.id = ?1"),
        params![id],
        map_session,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn current_session(conn: &Connection) -> Result<Option<ProtocolSession>, String> {
    conn.query_row(
        &format!(
            "SELECT {SESSION_COLUMNS} FROM protocol_sessions s
             WHERE s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1"
        ),
        [],
        map_session,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn end_session(conn: &Connection, id: &str, reason: &str, ended_at: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE protocol_sessions SET ended_at = ?2, end_reason = ?3 WHERE id = ?1 AND ended_at IS NULL",
        params![id, ended_at, reason],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── 协议 CRUD / 开局 / 结束 ──

impl Database {
    pub async fn protocols_list(&self) -> Result<Vec<Protocol>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PROTOCOL_COLUMNS} FROM protocols WHERE deleted_at IS NULL
                 ORDER BY sort_order ASC, created_at ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], map_protocol).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub async fn protocols_create(&self, req: CreateProtocolRequest) -> Result<Protocol, String> {
        let name = clean_name(&req.name)?;
        let id = Uuid::new_v4().to_string();
        let ts = fmt_time(now());
        let conn = self.conn.lock().await;
        let next_order: i64 = conn
            .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM protocols", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO protocols (id, name, daily_target_min, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, DEFAULT_DAILY_TARGET_MIN, next_order, ts],
        )
        .map_err(|e| e.to_string())?;
        get_protocol(&conn, &id)?.ok_or_else(|| "新建的协议没读到".to_string())
    }

    pub async fn protocols_update(&self, id: &str, req: UpdateProtocolRequest) -> Result<Protocol, String> {
        let conn = self.conn.lock().await;
        let current = get_protocol(&conn, id)?.ok_or_else(|| "协议不存在".to_string())?;
        let name = match req.name {
            Some(n) => clean_name(&n)?,
            None => current.name,
        };
        let intent: String = req
            .intent
            .map(|s| s.trim().chars().take(INTENT_MAX_CHARS).collect())
            .unwrap_or(current.intent);
        let apps = match req.apps {
            Some(list) => clean_entries(list)?,
            None => current.apps,
        };
        let sites = match req.sites {
            Some(list) => clean_entries(list)?,
            None => current.sites,
        };
        let strength = req.strength.unwrap_or(current.strength);
        let target = req
            .daily_target_min
            .map(|m| m.clamp(0, MAX_DAILY_TARGET_MIN))
            .unwrap_or(current.daily_target_min);
        conn.execute(
            "UPDATE protocols SET name = ?2, intent = ?3, apps = ?4, sites = ?5, strength = ?6,
                 daily_target_min = ?7, updated_at = ?8
             WHERE id = ?1",
            params![id, name, intent, to_json(&apps)?, to_json(&sites)?, strength.as_str(), target, fmt_time(now())],
        )
        .map_err(|e| e.to_string())?;
        get_protocol(&conn, id)?.ok_or_else(|| "协议不存在".to_string())
    }

    /// 删除只是藏起来：历史上的局还指着它
    pub async fn protocols_delete(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE protocols SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, fmt_time(now())],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn protocol_session_current(&self) -> Result<Option<ProtocolSession>, String> {
        let conn = self.conn.lock().await;
        current_session(&conn)
    }

    /// 开局：同一时间只能有一局；白名单和强度在这一刻冻结
    pub async fn protocol_session_start(&self, protocol_id: &str, req: StartSessionRequest) -> Result<ProtocolSession, String> {
        let conn = self.conn.lock().await;
        if let Some(active) = current_session(&conn)? {
            return Err(format!("「{}」这一局还没结束", active.protocol_name));
        }
        let protocol = get_protocol(&conn, protocol_id)?.ok_or_else(|| "协议不存在".to_string())?;
        let minutes = match req.minutes {
            Some(m) if !(1..=MAX_SESSION_MINUTES).contains(&m) => {
                return Err(format!("一局时长要在 1 到 {MAX_SESSION_MINUTES} 分钟之间"));
            }
            other => other,
        };
        if protocol.strength == Strength::Hard && minutes.is_none() {
            return Err("硬锁必须定好这一局多长".into());
        }

        let started = now();
        let planned_end = minutes.map(|m| fmt_time(started + Duration::minutes(m)));
        let intent = if protocol.intent.trim().is_empty() { protocol.name.clone() } else { protocol.intent.clone() };
        let rules = SessionRules { apps: protocol.apps, sites: protocol.sites, strength: protocol.strength, intent };
        let rules_json = serde_json::to_string(&rules).map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO protocol_sessions (id, protocol_id, protocol_name, rules, started_at, planned_end_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, protocol.id, protocol.name, rules_json, fmt_time(started), planned_end],
        )
        .map_err(|e| e.to_string())?;
        get_session(&conn, &id)?.ok_or_else(|| "新开的一局没读到".to_string())
    }

    /// 结束这一局：软 / 中锁第一次调用 = 申请（开始冷却），冷却到了再调用 = 真结束；硬锁到点前拒绝
    pub async fn protocol_session_request_stop(&self) -> Result<ProtocolSession, String> {
        let conn = self.conn.lock().await;
        let session = current_session(&conn)?.ok_or_else(|| "没有进行中的局".to_string())?;
        let t = now();

        if session.rules.strength == Strength::Hard {
            let end = session.planned_end_at.as_deref().and_then(parse_time);
            if end.is_some_and(|e| t < e) {
                return Err(format!("硬锁：{} 之前不能结束", session.planned_end_at.unwrap_or_default()));
            }
        } else if session.stop_requested_at.is_none() {
            conn.execute(
                "UPDATE protocol_sessions SET stop_requested_at = ?2 WHERE id = ?1",
                params![session.id, fmt_time(t)],
            )
            .map_err(|e| e.to_string())?;
            return get_session(&conn, &session.id)?.ok_or_else(|| "这一局没读到".to_string());
        } else if session.can_stop_at.as_deref().and_then(parse_time).is_some_and(|ready| t < ready) {
            return Ok(session);
        }

        end_session(&conn, &session.id, "stopped", &fmt_time(t))?;
        get_session(&conn, &session.id)?.ok_or_else(|| "这一局没读到".to_string())
    }

    /// 撤回结束申请（冷却期间改主意了）
    pub async fn protocol_session_cancel_stop(&self) -> Result<ProtocolSession, String> {
        let conn = self.conn.lock().await;
        let session = current_session(&conn)?.ok_or_else(|| "没有进行中的局".to_string())?;
        conn.execute(
            "UPDATE protocol_sessions SET stop_requested_at = NULL WHERE id = ?1",
            params![session.id],
        )
        .map_err(|e| e.to_string())?;
        get_session(&conn, &session.id)?.ok_or_else(|| "这一局没读到".to_string())
    }

    /// 定时局到点：结束时刻记成定好的时刻（软件关着错过了也不会多算）
    pub async fn protocol_session_finish(&self, id: &str, ended_at: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        end_session(&conn, id, "done", ended_at)
    }

    /// 和某天有交集的各局（还在进行的也算）
    pub async fn protocol_sessions_for_date(&self, date: &str) -> Result<Vec<ProtocolSession>, String> {
        let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "日期格式应为 YYYY-MM-DD".to_string())?;
        let day_start = format!("{} 00:00:00", day.format("%Y-%m-%d"));
        let next = day.succ_opt().ok_or_else(|| "日期越界".to_string())?;
        let day_end = format!("{} 00:00:00", next.format("%Y-%m-%d"));
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SESSION_COLUMNS} FROM protocol_sessions s
                 WHERE s.started_at < ?2 AND (s.ended_at IS NULL OR s.ended_at >= ?1)
                 ORDER BY s.started_at ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![day_start, day_end], map_session).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub async fn protocol_intercept_record(&self, session_id: &str, kind: &str, target: &str, title: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO protocol_intercepts (session_id, at, kind, target, title) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, fmt_time(now()), kind, target, title],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn protocol_judgment_record(&self, j: NewJudgment<'_>) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO protocol_judgments
                 (session_id, at, app, host, title, choice, confidence, probabilities, latency_ms, verdict, action)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                j.session_id, fmt_time(now()), j.app, j.host, j.title, j.choice, j.confidence,
                j.probabilities.to_string(), j.latency_ms as i64, j.verdict, j.action
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn protocol_judgments(&self, session_id: &str) -> Result<Vec<ProtocolJudgment>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT at, app, host, title, choice, confidence, probabilities, verdict, action
                 FROM protocol_judgments WHERE session_id = ?1 ORDER BY at DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![session_id, INTERCEPT_LIST_LIMIT], |r| {
                let probs: String = r.get(6)?;
                Ok(ProtocolJudgment {
                    at: r.get(0)?,
                    app: r.get(1)?,
                    host: r.get(2)?,
                    title: r.get(3)?,
                    choice: r.get(4)?,
                    confidence: r.get(5)?,
                    probabilities: serde_json::from_str(&probs).unwrap_or(serde_json::Value::Null),
                    verdict: r.get(7)?,
                    action: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub async fn protocol_intercepts(&self, session_id: &str) -> Result<Vec<ProtocolIntercept>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT at, kind, target, title FROM protocol_intercepts
                 WHERE session_id = ?1 ORDER BY at DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![session_id, INTERCEPT_LIST_LIMIT], |r| {
                Ok(ProtocolIntercept { at: r.get(0)?, kind: r.get(1)?, target: r.get(2)?, title: r.get(3)? })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 最近 N 天各应用在前台的总时长（从感知层的窗口事件算），给白名单当候选
    pub async fn protocol_app_usage(&self, days: i64) -> Result<Vec<AppUsage>, String> {
        let since = fmt_time(now() - Duration::days(days.clamp(1, APP_USAGE_MAX_DAYS)));
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT e.start_at, e.end_at, e.data_json
                 FROM {PERCEPTION_EVENTS_TABLE} e JOIN {PERCEPTION_BUCKETS_TABLE} b ON b.id = e.bucket_id
                 WHERE b.kind = 'window' AND e.start_at >= ?1"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            .map_err(|e| e.to_string())?;

        let mut totals: HashMap<String, i64> = HashMap::new();
        for (start, end, data) in rows.filter_map(|r| r.ok()) {
            let secs = match (parse_time(start.get(..19).unwrap_or(&start)), parse_time(end.get(..19).unwrap_or(&end))) {
                (Some(s), Some(e)) => (e - s).num_seconds().max(0),
                _ => continue,
            };
            let app = serde_json::from_str::<serde_json::Value>(&data)
                .ok()
                .and_then(|v| v.get("app").and_then(|a| a.as_str()).map(str::to_string));
            if let Some(app) = app {
                *totals.entry(app).or_insert(0) += secs;
            }
        }
        let mut list: Vec<AppUsage> = totals.into_iter().map(|(app, seconds)| AppUsage { app, seconds }).collect();
        list.sort_by(|a, b| b.seconds.cmp(&a.seconds));
        list.truncate(APP_USAGE_LIMIT);
        Ok(list)
    }
}
