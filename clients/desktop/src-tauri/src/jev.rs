// ══════════════════════════════════════════════
// 决策模型（System One 接口，Jev 开的头）：只做选择题 / 是非题 / 打分题，不生成文字；快（百毫秒级）、输出免费
//   协议的灰色地带拿它判断「这段内容和协议用意的关系」（见 protocol_gray.rs）
//   用哪个模型由模型库绑定（feature_bindings：protocol_gray 基础判断 / protocol_gray_vision 看图判断），
//   推荐的几个（Decision-1 / Jev / Liquid d1）由 seed_decision_models 写进模型库，带价格和实测成绩
//   渠道：默认 Vercel AI Gateway（国内直连）；连接（地址 + Key）存本机 jev_config 一行，Key 读出时只给后四位
//   每次调用记进模型审计（model_call_log，feature = 这次用的功能位）
// ══════════════════════════════════════════════

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::{Database, LogModelCallRequest};

pub const DEFAULT_BASE_URL: &str = "https://ai-gateway.vercel.sh/typesafe";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_URL_CHARS: usize = 300;
const MAX_KEY_CHARS: usize = 500;
const ERROR_BODY_CHARS: usize = 200;

/// 模型库里的功能位：按标题判断 / 看截图判断
pub const FEATURE_GRAY: &str = "protocol_gray";
pub const FEATURE_GRAY_VISION: &str = "protocol_gray_vision";
const DEFAULT_GRAY_MODEL: &str = "microsoft/microsoft-decision-1";
const DEFAULT_GRAY_VISION_MODEL: &str = "liquid/d1";

/// 模型库统一按「元 / 百万 token」记价；Vercel 标的是美元，按这个汇率折算（备注里留着美元原价）
const USD_TO_CNY: f64 = 7.1;

/// 推荐的决策模型：(id, 显示名, 能看图, 上下文, 美元 / 百万输入 token, 备注)。
/// 成绩 = 2026-10-10 灰色地带 10 题（协议用意 + 窗口标题，三选一）实测。
/// 同批候选里 GPT-6 Luna Decisions 8/10 且贵 2.4 倍、Laya 4/10，没放进来
const DECISION_MODELS: &[(&str, &str, bool, i64, f64, &str)] = &[
    (
        "microsoft/microsoft-decision-1", "Microsoft Decision-1", false, 32_768, 0.042,
        "推荐·基础判断｜灰色地带 10 题实测 10/10，有把握却判错 0｜最果断｜不留存、不拿去训练｜Vercel AI Gateway，$0.042/百万输入，输出免费",
    ),
    (
        "typesafe-ai/jev", "Jev", false, 32_000, 0.042,
        "灰色地带 10 题实测 9/10，有把握却判错 0｜最谨慎：拿不准时概率摊开，少误伤｜部分不留存、不拿去训练｜Vercel AI Gateway，$0.042/百万输入，输出免费",
    ),
    (
        "liquid/d1", "Liquid d1", true, 65_536, 0.040,
        "推荐·看图判断｜灰色地带 10 题实测 10/10，有把握却判错 0｜能看截图｜会留存、可能拿去训练（发截图要慎重）｜Vercel AI Gateway，$0.04/百万输入，输出免费",
    ),
];

// ── 配置 ──

/// 一次调用要用的连接 + 模型（模型来自模型库绑定）
#[derive(Debug, Clone)]
pub struct JevConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// 给前端看的配置：Key 不回传，只告诉有没有、后四位是什么；顺带告诉两个功能位现在绑的模型
#[derive(Debug, Serialize)]
pub struct JevConfigView {
    pub base_url: String,
    pub has_key: bool,
    pub key_tail: Option<String>,
    pub model: String,
    pub vision_model: String,
}

/// 只改传了的字段；api_key 传空串 = 清掉（模型在模型库里换）
#[derive(Debug, Deserialize)]
pub struct UpdateJevConfigRequest {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

pub(crate) fn init_jev_tables(conn: &Connection) -> Result<(), String> {
    // model 列是最早一版留下的；模型已改由模型库绑定，这里只写空串
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS jev_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            base_url TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            api_key TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );
    "#).map_err(|e| format!("创建 Jev 配置表失败: {}", e))
}

/// 把推荐的决策模型写进模型库（provider = vercel，价格折成元），并给两个功能位绑上默认模型（已绑过的不动）
pub(crate) fn seed_decision_models(conn: &Connection) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    for (id, name, vision, ctx, usd, note) in DECISION_MODELS {
        let modalities = if *vision { r#"["text","image"]"# } else { r#"["text"]"# };
        conn.execute(
            "INSERT INTO model_registry (id, category, provider, display_name, modalities, context_window, notes, deprecated, updated_at)
             VALUES (?1, 'decision', 'vercel', ?2, ?3, ?4, ?5, 0, ?6)
             ON CONFLICT(id) DO UPDATE SET category = excluded.category, provider = excluded.provider,
                 display_name = excluded.display_name, modalities = excluded.modalities,
                 context_window = excluded.context_window, notes = excluded.notes, updated_at = excluded.updated_at",
            params![id, name, modalities, ctx, note, now],
        )
        .map_err(|e| e.to_string())?;
        let cny = (usd * USD_TO_CNY * 10_000.0).round() / 10_000.0;
        conn.execute("DELETE FROM model_pricing WHERE model_id = ?1", params![id]).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO model_pricing (model_id, tier_min_tokens, tier_max_tokens, price_input_text, price_input_image, price_output_text)
             VALUES (?1, 0, NULL, ?2, ?3, 0)",
            params![id, cny, vision.then_some(cny)],
        )
        .map_err(|e| e.to_string())?;
    }
    for (feature, model) in [(FEATURE_GRAY, DEFAULT_GRAY_MODEL), (FEATURE_GRAY_VISION, DEFAULT_GRAY_VISION_MODEL)] {
        conn.execute(
            "INSERT OR IGNORE INTO feature_bindings (feature, model_id, updated_at) VALUES (?1, ?2, ?3)",
            params![feature, model, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn default_model(feature: &str) -> &'static str {
    if feature == FEATURE_GRAY_VISION { DEFAULT_GRAY_VISION_MODEL } else { DEFAULT_GRAY_MODEL }
}

fn clean_base_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    if !url.starts_with("https://") {
        return Err("判断模型的地址要以 https:// 开头".into());
    }
    if url.chars().count() > MAX_URL_CHARS {
        return Err("判断模型的地址太长".into());
    }
    Ok(url.to_string())
}

fn clean_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.chars().count() > MAX_KEY_CHARS {
        return Err("Key 太长".into());
    }
    Ok(key.to_string())
}

fn key_tail(key: &str) -> Option<String> {
    let chars: Vec<char> = key.chars().collect();
    (!chars.is_empty()).then(|| chars[chars.len().saturating_sub(4)..].iter().collect())
}

impl Database {
    /// 连接（地址 + Key）；没配过就是默认地址、空 Key
    async fn jev_connection(&self) -> Result<(String, String), String> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row("SELECT base_url, api_key FROM jev_config WHERE id = 1", [], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.unwrap_or_else(|| (DEFAULT_BASE_URL.to_string(), String::new())))
    }

    /// 某个功能位这次调用要用的连接 + 模型库里绑定的模型
    pub async fn jev_config_for(&self, feature: &str) -> Result<JevConfig, String> {
        let (base_url, api_key) = self.jev_connection().await?;
        let model = self
            .get_feature_model(feature)
            .await?
            .unwrap_or_else(|| default_model(feature).to_string());
        Ok(JevConfig { base_url, api_key, model })
    }

    pub async fn jev_config_view(&self) -> Result<JevConfigView, String> {
        let (base_url, api_key) = self.jev_connection().await?;
        Ok(JevConfigView {
            base_url,
            has_key: !api_key.is_empty(),
            key_tail: key_tail(&api_key),
            model: self.jev_config_for(FEATURE_GRAY).await?.model,
            vision_model: self.jev_config_for(FEATURE_GRAY_VISION).await?.model,
        })
    }

    pub async fn jev_config_update(&self, req: UpdateJevConfigRequest) -> Result<JevConfigView, String> {
        let (current_url, current_key) = self.jev_connection().await?;
        let base_url = match req.base_url {
            Some(u) => clean_base_url(&u)?,
            None => current_url,
        };
        let api_key = match req.api_key {
            Some(k) => clean_key(&k)?,
            None => current_key,
        };
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO jev_config (id, base_url, model, api_key, updated_at) VALUES (1, ?1, '', ?2, datetime('now'))
                 ON CONFLICT(id) DO UPDATE SET base_url = ?1, api_key = ?2, updated_at = datetime('now')",
                params![base_url, api_key],
            )
            .map_err(|e| e.to_string())?;
        }
        self.jev_config_view().await
    }
}

// ── 调用 ──

/// 一道选择题：criteria = [(选项 key, 选项描述)]
pub struct ChoiceQuestion<'a> {
    pub id: &'a str,
    pub instructions: &'a str,
    pub criteria: &'a [(&'a str, &'a str)],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChoiceAnswer {
    pub choice: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub probabilities: HashMap<String, f64>,
}

#[derive(Debug, Serialize)]
pub struct ChoiceOutcome {
    #[serde(flatten)]
    pub answer: ChoiceAnswer,
    pub latency_ms: u64,
    pub model: String,
    pub input_tokens: i64,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

async fn post_choice(cfg: &JevConfig, state: &str, q: &ChoiceQuestion<'_>) -> Result<(serde_json::Value, u64), String> {
    if cfg.api_key.is_empty() {
        return Err("还没填判断模型的 Key".into());
    }
    let criteria: serde_json::Map<String, serde_json::Value> = q
        .criteria
        .iter()
        .map(|(k, v)| ((*k).to_string(), serde_json::Value::String((*v).to_string())))
        .collect();
    let body = serde_json::json!({
        "model": cfg.model,
        "state": state,
        "questions": { q.id: { "type": "choice", "instructions": q.instructions, "criteria": criteria } },
    });
    let started = Instant::now();
    let res = client()
        .post(format!("{}/v1/systemone", cfg.base_url))
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "判断模型超时没响应".to_string() } else { format!("连不上判断模型：{e}") })?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("读判断结果失败：{e}"))?;
    let latency_ms = started.elapsed().as_millis() as u64;
    if !status.is_success() {
        return Err(format!("判断模型返回 {}：{}", status.as_u16(), truncate(&text, ERROR_BODY_CHARS)));
    }
    let json = serde_json::from_str(&text)
        .map_err(|_| format!("判断模型返回的不是 JSON：{}", truncate(&text, ERROR_BODY_CHARS)))?;
    Ok((json, latency_ms))
}

/// 问一道选择题；成功失败都记进模型审计（feature = 这次用的功能位）
pub async fn decide_choice(
    db: &Database,
    feature: &str,
    cfg: &JevConfig,
    state: &str,
    q: &ChoiceQuestion<'_>,
) -> Result<ChoiceOutcome, String> {
    let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let result = post_choice(cfg, state, q).await.and_then(|(json, latency_ms)| {
        let answer: ChoiceAnswer = serde_json::from_value(json["answers"][q.id].clone())
            .map_err(|_| format!("判断结果里没有这道题的答案：{}", truncate(&json.to_string(), ERROR_BODY_CHARS)))?;
        Ok(ChoiceOutcome {
            answer,
            latency_ms,
            model: json["model"].as_str().unwrap_or(&cfg.model).to_string(),
            input_tokens: json["usage"]["input_tokens"].as_i64().unwrap_or(0),
        })
    });

    let audit = LogModelCallRequest {
        api_key_id: None,
        feature: feature.into(),
        model_id: cfg.model.clone(),
        started_at,
        duration_ms: result.as_ref().ok().map(|o| o.latency_ms as i64),
        prompt_text_tokens: result.as_ref().map(|o| o.input_tokens).unwrap_or(0),
        prompt_image_tokens: 0,
        prompt_video_tokens: 0,
        prompt_audio_tokens: 0,
        completion_text_tokens: 0,
        completion_audio_tokens: 0,
        success: result.is_ok(),
        error_message: result.as_ref().err().cloned(),
        metadata: None,
    };
    if let Err(e) = db.log_model_call(audit).await {
        log::warn!("[Jev] 记模型审计失败: {e}");
    }
    result
}

// ── 灰色地带那道题 ──

pub const RELATION_QUESTION_ID: &str = "relation";
pub const RELATION_ON_TASK: &str = "on_task";
pub const RELATION_ADJACENT: &str = "adjacent";
pub const RELATION_OFF_TASK: &str = "off_task";

/// Playground 实测：「判断不了」这一项模型几乎从不选（不确定会体现为概率摊开），所以只放三项
pub const RELATION_CRITERIA: &[(&str, &str)] = &[
    (RELATION_ON_TASK, "直接服务于用意（学习、查资料、和工作相关）"),
    (RELATION_ADJACENT, "沾边但偏放松"),
    (RELATION_OFF_TASK, "娱乐，和用意无关"),
];

pub fn relation_question() -> ChoiceQuestion<'static> {
    ChoiceQuestion { id: RELATION_QUESTION_ID, instructions: "这段内容和协议用意的关系", criteria: RELATION_CRITERIA }
}

pub fn relation_state(intent: &str, app: &str, title: &str) -> String {
    format!("协议用意：{intent}\n当前窗口：{app}「{title}」")
}
