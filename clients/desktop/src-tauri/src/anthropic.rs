// ══════════════════════════════════════════════
// Anthropic 官方 API（Messages）：智能体（非实时语音）用；请求必须走「网络代理」设置里的端口
//   POST https://api.anthropic.com/v1/messages
//   头：x-api-key（Key 存 ai_provider_keys，provider = anthropic）、anthropic-version: 2023-06-01
//   每次调用记进 model_call_log（api_key_id 归属这把 Key）
//   模型库条目：claude-opus-5-5（主力）/ claude-sonnet-5-5 / claude-haiku-5-5 / claude-fable-5-1
//   路由：POST /api/anthropic/test 发一句很短的话，验证代理和 Key
// ══════════════════════════════════════════════

use std::time::{Duration, Instant};

use axum::{extract::State, response::Json, routing::post, Router};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::{ApiResponse, ApiState};
use crate::db::{Database, LogModelCallRequest, PROVIDER_ANTHROPIC};
use crate::network::proxy_url;

pub(crate) const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
pub(crate) const API_VERSION: &str = "2023-06-01";
const TIMEOUT: Duration = Duration::from_secs(120);
/// 测试连接用最便宜的模型
pub const TEST_MODEL: &str = "claude-haiku-5-5";
const ERROR_BODY_CHARS: usize = 300;

#[derive(Debug, Clone, Serialize)]
pub struct AnthropicReply {
    pub text: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub latency_ms: u64,
}

pub(crate) fn build_client(port: u16) -> Result<reqwest::Client, String> {
    let proxy = reqwest::Proxy::all(proxy_url(port)).map_err(|e| format!("代理地址不对：{e}"))?;
    reqwest::Client::builder()
        .proxy(proxy)
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("建立网络客户端失败：{e}"))
}

pub(crate) fn explain_send_error(e: &reqwest::Error, port: u16) -> String {
    if e.is_connect() {
        format!("连不上代理 127.0.0.1:{port}。确认代理软件开着，端口对得上（齿轮 → 网络代理）：{e}")
    } else if e.is_timeout() {
        "Anthropic 超时没响应（代理通了但对面慢，或者线路不稳）".to_string()
    } else {
        format!("请求 Anthropic 失败：{e}")
    }
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// 发一次 Messages 请求：text 为用户消息；jpeg 有值时作为图片块放在文字前面；system 可选。
/// 成功失败都记进模型审计（feature = 这次用的功能位）
pub async fn messages(
    db: &Database,
    feature: &str,
    model: &str,
    system: Option<&str>,
    text: &str,
    jpeg: Option<&[u8]>,
    max_tokens: u32,
) -> Result<AnthropicReply, String> {
    let key = db
        .get_active_model_api_key_for(PROVIDER_ANTHROPIC)
        .await?
        .ok_or_else(|| "还没填 Anthropic 的 API Key（模型库 → Key 里添加）".to_string())?;
    let port = db.network_settings().await?.proxy_port;
    let client = build_client(port)?;

    let mut content = Vec::new();
    if let Some(jpeg) = jpeg {
        content.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": "image/jpeg", "data": STANDARD.encode(jpeg) }
        }));
    }
    content.push(json!({ "type": "text", "text": text }));
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{ "role": "user", "content": content }],
    });
    if let Some(system) = system {
        body["system"] = json!(system);
    }

    let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let t0 = Instant::now();
    let result = call(&client, port, &key.api_key, &body).await;
    let latency_ms = t0.elapsed().as_millis() as u64;

    let (input_tokens, output_tokens) = result.as_ref().map(|r| (r.input_tokens, r.output_tokens)).unwrap_or((0, 0));
    let has_image = jpeg.is_some();
    let audit = LogModelCallRequest {
        api_key_id: Some(key.id.clone()),
        feature: feature.into(),
        model_id: model.into(),
        started_at,
        duration_ms: Some(latency_ms as i64),
        prompt_text_tokens: if has_image { 0 } else { input_tokens },
        prompt_image_tokens: if has_image { input_tokens } else { 0 },
        prompt_video_tokens: 0,
        prompt_audio_tokens: 0,
        completion_text_tokens: output_tokens,
        completion_audio_tokens: 0,
        success: result.is_ok(),
        error_message: result.as_ref().err().cloned(),
        metadata: None,
    };
    if let Err(e) = db.log_model_call(audit).await {
        log::warn!("[Anthropic] 记模型审计失败: {e}");
    }

    result.map(|mut r| {
        r.latency_ms = latency_ms;
        r
    })
}

async fn call(client: &reqwest::Client, port: u16, api_key: &str, body: &serde_json::Value) -> Result<AnthropicReply, String> {
    let res = client
        .post(ENDPOINT)
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", API_VERSION)
        .json(body)
        .send()
        .await
        .map_err(|e| explain_send_error(&e, port))?;
    let status = res.status();
    let raw = res.text().await.map_err(|e| format!("读 Anthropic 回复失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("Anthropic 返回 {}：{}", status.as_u16(), truncate(&raw, ERROR_BODY_CHARS)));
    }
    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| format!("Anthropic 返回的不是 JSON：{}", truncate(&raw, ERROR_BODY_CHARS)))?;
    // content 是一组块，文字块拼起来
    let text: String = json["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    Ok(AnthropicReply {
        text,
        model: json["model"].as_str().unwrap_or_default().to_string(),
        input_tokens: json["usage"]["input_tokens"].as_i64().unwrap_or(0),
        output_tokens: json["usage"]["output_tokens"].as_i64().unwrap_or(0),
        latency_ms: 0,
    })
}

// ── 模型库种子（Anthropic 官网价目，2026-10 核对；单位美元 / 百万 token，入库保留美元原价，currency = USD）──

/// (模型 id, 显示名, 价格阶梯 (min, max, 输入 $, 输出 $), 备注)
const MODELS: &[(&str, &str, &[(i64, Option<i64>, f64, f64)], &str)] = &[
    ("claude-opus-5-5", "Claude Opus 5.5", &[(0, None, 4.0, 20.0)],
        "智能体主力（官网推荐的默认）。缓存写入 5 分钟 $5 / 1 小时 $8，缓存命中 $0.20（每百万 token）；上下文 100 万，最多输出 12.8 万"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", &[(0, None, 2.0, 10.0)],
        "速度与智能的平衡。缓存写入 5 分钟 $2.5 / 1 小时 $4，缓存命中 $0.10；上下文 100 万，最多输出 12.8 万"),
    ("claude-haiku-5-5", "Claude Haiku 5.5", &[(0, Some(100_000), 0.10, 0.50), (100_000, None, 0.50, 2.50)],
        "最便宜；分类、抽取、路由。按输入长度两档（≤10 万 / >10 万）。缓存命中 $0.01 / $0.05"),
    ("claude-fable-5-1", "Claude Fable 5.1", &[(0, None, 10.0, 50.0)],
        "最贵；高难推理、长程智能体，Opus 不够时再用。缓存写入 5 分钟 $12.5 / 1 小时 $20，缓存命中 $0.25"),
];

pub(crate) fn seed_anthropic_models(conn: &Connection) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let modalities = serde_json::to_string(&["text", "image"]).unwrap_or_else(|_| "[]".to_string());
    for (id, display_name, tiers, note) in MODELS {
        conn.execute(
            "INSERT INTO model_registry
             (id, category, provider, display_name, modalities, context_window, notes, deprecated, updated_at, currency)
             VALUES (?, 'text', 'anthropic', ?, ?, 1000000, ?, 0, ?, 'USD')
             ON CONFLICT(id) DO UPDATE SET
               category=excluded.category, provider=excluded.provider, display_name=excluded.display_name,
               modalities=excluded.modalities, context_window=excluded.context_window,
               notes=excluded.notes, updated_at=excluded.updated_at, currency=excluded.currency",
            params![id, display_name, &modalities, note, &now],
        )
        .map_err(|e| e.to_string())?;

        conn.execute("DELETE FROM model_pricing WHERE model_id = ?", params![id]).map_err(|e| e.to_string())?;
        for (min, max, in_usd, out_usd) in *tiers {
            conn.execute(
                "INSERT INTO model_pricing
                 (model_id, tier_min_tokens, tier_max_tokens,
                  price_input_text, price_input_image, price_output_text, price_output_text_thinking)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![id, min, max, in_usd, in_usd, out_usd, out_usd],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    log::info!("[Database] Anthropic 模型种子写入 {} 个", MODELS.len());
    Ok(())
}

// ── HTTP：测试连接 ──

pub fn routes() -> Router<ApiState> {
    Router::new().route("/api/anthropic/test", post(test_connection))
}

#[derive(Deserialize)]
struct TestBody {
    /// 缺省用最便宜的 Haiku 5.5
    model: Option<String>,
}

#[derive(Serialize)]
struct TestResult {
    model: String,
    reply: String,
    latency_ms: u64,
    input_tokens: i64,
    output_tokens: i64,
}

async fn test_connection(State(state): State<ApiState>, Json(body): Json<TestBody>) -> Json<ApiResponse<TestResult>> {
    let model = body.model.unwrap_or_else(|| TEST_MODEL.to_string());
    let r = messages(&state.db, "anthropic_test", &model, None, "只回一个字：好", None, 16).await;
    Json(match r {
        Ok(r) => ApiResponse::ok(TestResult {
            model: r.model,
            reply: r.text,
            latency_ms: r.latency_ms,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
        }),
        Err(e) => ApiResponse::error(&e),
    })
}
