// ══════════════════════════════════════════════
// Anthropic 官方 API（Messages）：智能体（非实时语音）用；请求必须走「网络代理」设置里的端口
//   POST https://api.anthropic.com/v1/messages
//   头：x-api-key（Key 存 ai_provider_keys，provider = anthropic）、anthropic-version: 2023-06-01
//   每次调用记进 model_call_log（api_key_id 归属这把 Key）
//   模型清单和价目不写死：从 models.dev 取（fetch_models_dev，同样走代理），前端解析后写进模型库（lib/models/models-dev.ts）
//   路由：POST /api/anthropic/test 发一句很短的话，验证代理和 Key
// ══════════════════════════════════════════════

use std::time::{Duration, Instant};

use axum::{extract::State, response::Json, routing::post, Router};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::{ApiResponse, ApiState};
use crate::db::{Database, LogModelCallRequest, PROVIDER_ANTHROPIC};
use crate::network::proxy_url;

pub(crate) const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
pub(crate) const API_VERSION: &str = "2023-06-01";
const TIMEOUT: Duration = Duration::from_secs(120); // 连接 / 读取的空闲上限，不是总时长：流式长回复可以超过它
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
        .connect_timeout(TIMEOUT).read_timeout(TIMEOUT)
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

// ── 模型清单：models.dev（公开的模型目录），和 Anthropic 一样走代理端口 ──

const MODELS_DEV_URL: &str = "https://models.dev/api.json";

/// 取 models.dev 的全量目录，返回 JSON 文本（约 6 MB）。错误文字接在前端的「从 models.dev 拉模型清单失败：」后面
pub async fn fetch_models_dev(db: &Database) -> Result<String, String> {
    let port = db.network_settings().await?.proxy_port;
    let res = build_client(port)?
        .get(MODELS_DEV_URL)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                format!("连不上代理 127.0.0.1:{port}。确认代理软件开着，端口对得上（齿轮 → 网络代理）：{e}")
            } else if e.is_timeout() {
                "超时没响应（代理通了但对面慢，或者线路不稳）".to_string()
            } else {
                format!("请求失败：{e}")
            }
        })?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("返回 {}", status.as_u16()));
    }
    res.text().await.map_err(|e| format!("读回复失败：{e}"))
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
