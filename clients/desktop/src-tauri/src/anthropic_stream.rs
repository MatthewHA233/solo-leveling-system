// ══════════════════════════════════════════════
// Anthropic 流式 Messages：Fairy 聊天 / 智能体用。浏览器 fetch 走不了代理，所以请求在 Rust 里发（走网络代理端口）
//   前端组好 Anthropic 格式的 body（system / messages / tools），这里转发、解析 SSE，
//   并把事件统一成前端 ApiStreamChunk 的形状，推到 anthropic-stream-{streamId}
//   chunk：textDelta / toolCallDelta / done / error（与 lib/llm/api.ts 一致）
//   用量记进 model_call_log（和非流式调用一样）
// ══════════════════════════════════════════════

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::anthropic::{build_client, explain_send_error, truncate, ENDPOINT, API_VERSION};
use crate::db::{Database, LogModelCallRequest, PROVIDER_ANTHROPIC};

pub fn event_name(stream_id: &str) -> String {
    format!("anthropic-stream-{stream_id}")
}

/// 启动一条流：立刻返回，事件从后台推送
pub async fn start_stream(
    app: AppHandle,
    db: Arc<Database>,
    stream_id: String,
    feature: String,
    body: Value,
) -> Result<(), String> {
    let key = db
        .get_active_model_api_key_for(PROVIDER_ANTHROPIC)
        .await?
        .ok_or_else(|| "还没填 Anthropic 的 API Key（模型库 → Key 里添加）".to_string())?;
    let port = db.network_settings().await?.proxy_port;
    let client = build_client(port)?;
    let model = body["model"].as_str().unwrap_or_default().to_string();

    tauri::async_runtime::spawn(async move {
        let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let t0 = Instant::now();
        let result = run(&app, &client, port, &key.api_key, &stream_id, &body).await;
        let duration_ms = t0.elapsed().as_millis() as i64;
        let (input_tokens, output_tokens) = result.as_ref().map(|u| (u.input, u.output)).unwrap_or((0, 0));
        if let Err(e) = db
            .log_model_call(LogModelCallRequest {
                api_key_id: Some(key.id.clone()),
                feature,
                model_id: model,
                started_at,
                duration_ms: Some(duration_ms),
                prompt_text_tokens: input_tokens,
                prompt_image_tokens: 0,
                prompt_video_tokens: 0,
                prompt_audio_tokens: 0,
                completion_text_tokens: output_tokens,
                completion_audio_tokens: 0,
                success: result.is_ok(),
                error_message: result.as_ref().err().cloned(),
                metadata: None,
            })
            .await
        {
            log::warn!("[Anthropic] 记流式审计失败: {e}");
        }
        if let Err(message) = result {
            let _ = app.emit(&event_name(&stream_id), json!({ "type": "error", "status": 0, "message": message }));
        }
    });
    Ok(())
}

struct Usage {
    input: i64,
    output: i64,
}

/// 块的种类：文字块 / 工具块（工具块带上它在 toolCallDelta 里的序号）
enum Block {
    Text,
    Tool(i64),
}

fn map_stop_reason(r: &str) -> &'static str {
    match r {
        "tool_use" => "tool_calls",
        "max_tokens" => "length",
        _ => "stop",
    }
}

async fn run(
    app: &AppHandle,
    client: &reqwest::Client,
    port: u16,
    api_key: &str,
    stream_id: &str,
    body: &Value,
) -> Result<Usage, String> {
    let event = event_name(stream_id);
    let mut res = client
        .post(ENDPOINT)
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", API_VERSION)
        .json(body)
        .send()
        .await
        .map_err(|e| explain_send_error(&e, port))?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Anthropic 返回 {}：{}", status.as_u16(), truncate(&text, 300)));
    }

    let mut buf: Vec<u8> = Vec::new();   // 按字节攒，事件以 \n\n 结束（ASCII 边界，不会切断汉字）
    let mut blocks: HashMap<i64, Block> = HashMap::new();
    let mut tool_count: i64 = -1;
    let mut usage = Usage { input: 0, output: 0 };
    let mut stop_reason = "stop".to_string();

    while let Some(chunk) = res.chunk().await.map_err(|e| format!("读 Anthropic 流失败：{e}"))? {
        buf.extend_from_slice(&chunk);
        while let Some(pos) = find_event_end(&buf) {
            let raw: Vec<u8> = buf.drain(..pos + 2).collect();
            let text = String::from_utf8_lossy(&raw);
            let Some(data) = data_line(&text) else { continue };
            let Ok(ev) = serde_json::from_str::<Value>(&data) else { continue };
            match ev["type"].as_str().unwrap_or_default() {
                "message_start" => {
                    usage.input = ev["message"]["usage"]["input_tokens"].as_i64().unwrap_or(usage.input);
                }
                "content_block_start" => {
                    let index = ev["index"].as_i64().unwrap_or(0);
                    let block = &ev["content_block"];
                    if block["type"] == "tool_use" {
                        tool_count += 1;
                        blocks.insert(index, Block::Tool(tool_count));
                        emit(app, &event, json!({
                            "type": "toolCallDelta", "index": tool_count,
                            "id": block["id"], "name": block["name"], "argsDelta": null,
                        }));
                    } else {
                        blocks.insert(index, Block::Text);
                    }
                }
                "content_block_delta" => {
                    let index = ev["index"].as_i64().unwrap_or(0);
                    let delta = &ev["delta"];
                    match (delta["type"].as_str(), blocks.get(&index)) {
                        (Some("text_delta"), _) => {
                            if let Some(t) = delta["text"].as_str() {
                                emit(app, &event, json!({ "type": "textDelta", "delta": t }));
                            }
                        }
                        (Some("input_json_delta"), Some(Block::Tool(i))) => {
                            emit(app, &event, json!({
                                "type": "toolCallDelta", "index": i, "id": null, "name": null,
                                "argsDelta": delta["partial_json"],
                            }));
                        }
                        _ => {}
                    }
                }
                "message_delta" => {
                    if let Some(r) = ev["delta"]["stop_reason"].as_str() {
                        stop_reason = map_stop_reason(r).to_string();
                    }
                    usage.output = ev["usage"]["output_tokens"].as_i64().unwrap_or(usage.output);
                }
                "message_stop" => {
                    emit(app, &event, json!({
                        "type": "done", "stopReason": stop_reason,
                        "inputTokens": usage.input, "outputTokens": usage.output,
                    }));
                    return Ok(usage);
                }
                "error" => {
                    let msg = ev["error"]["message"].as_str().unwrap_or("未知错误").to_string();
                    return Err(format!("Anthropic 流错误：{msg}"));
                }
                _ => {}
            }
        }
    }
    // 流结束但没收到 message_stop：也按完成处理
    emit(app, &event, json!({
        "type": "done", "stopReason": stop_reason,
        "inputTokens": usage.input, "outputTokens": usage.output,
    }));
    Ok(usage)
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

/// 缓冲里第一个完整事件（以空行结束）的位置：返回 "\n\n" 的起始下标
fn find_event_end(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

/// 一个事件里 data: 那一行（可能有多行 data 时拼起来）
fn data_line(event: &str) -> Option<String> {
    let parts: Vec<&str> = event
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|s| s.trim_start())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}
