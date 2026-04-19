// ══════════════════════════════════════════════
// Qwen Omni Realtime — DashScope 全模态单 WS
//
// 参考: docs/参考.md（基于官方文档整理）+ OpenAI Realtime API function calling
//
// 协议流程:
//   连接(Authorization header) → session.created
//   → session.update(modalities/voice/格式/tools)
//   → input_audio_buffer.append(PCM Base64)
//   → input_audio_buffer.commit + response.create
//   ← response.audio.delta (PCM Base64)
//   ← response.text.delta  (AI 文字)
//   ← response.output_item.added/done (type=function_call → 工具调用)
//   ← response.function_call_arguments.delta/done (工具参数流式)
//   ← response.audio.done  → omni://status {audio_done}
//
// Tauri 事件（emit 到前端）:
//   omni://status      { status: "connected"|"audio_done"|"error"|"disconnected", message? }
//   omni://audio_chunk { data: string }  — Base64 PCM，前端直接解码播放
//   omni://text_chunk  { text: string }  — AI 回复增量文字
//   omni://tool_call   { call_id, name, arguments } — 工具调用（前端执行后回传 omni_tool_result）
// ══════════════════════════════════════════════

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

const WS_BASE: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

// ── 会话句柄 ──

pub struct OmniSession {
    tx: mpsc::UnboundedSender<Message>,
}

impl OmniSession {
    pub fn send_audio(&self, pcm: &[u8]) {
        let audio_b64 = STANDARD.encode(pcm);
        let msg = json!({
            "type": "input_audio_buffer.append",
            "audio": audio_b64
        });
        let _ = self.tx.send(Message::Text(msg.to_string().into()));
    }

    pub fn commit(&self) {
        let _ = self.tx.send(Message::Text(
            json!({ "type": "input_audio_buffer.commit" }).to_string().into(),
        ));
        let _ = self.tx.send(Message::Text(
            json!({ "type": "response.create" }).to_string().into(),
        ));
    }

    pub fn send_text(&self, text: &str) {
        let create = json!({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": text }]
            }
        });
        let _ = self.tx.send(Message::Text(create.to_string().into()));
        let _ = self.tx.send(Message::Text(
            json!({ "type": "response.create" }).to_string().into(),
        ));
    }

    /// 回传工具执行结果，触发 AI 继续生成回复（音频 + 文字）
    pub fn send_tool_result(&self, call_id: &str, output: &str) {
        let create = json!({
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": call_id,
                "output": output
            }
        });
        let _ = self.tx.send(Message::Text(create.to_string().into()));
        let _ = self.tx.send(Message::Text(
            json!({ "type": "response.create" }).to_string().into(),
        ));
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Message::Close(None));
    }
}

pub type OmniState = Arc<Mutex<Option<OmniSession>>>;

// ── 建立连接 ──

pub async fn connect(
    api_key: String,
    model: String,
    voice: String,
    system_prompt: String,
    tools: Value,
    app_handle: tauri::AppHandle,
) -> Result<OmniSession, String> {
    let url = format!("{WS_BASE}?model={model}");

    // IntoClientRequest 自动生成 Sec-WebSocket-Key 等握手头，再追加 Authorization
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("请求构建失败: {e}"))?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {api_key}")
            .parse()
            .map_err(|_| "API Key 格式无效".to_string())?,
    );

    let key_preview: String = api_key.chars().take(8).collect();
    log::info!("[OmniRealtime] 连接 {}  key={}...", url, key_preview);

    // 连接前用 reqwest 探测：看 DashScope 实际返回什么
    {
        let http_url = url.replace("wss://", "https://");
        match reqwest::Client::new()
            .get(&http_url)
            .header("Authorization", format!("Bearer {api_key}"))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                log::info!("[OmniRealtime] HTTP 探测 status={}", status);
                if status.as_u16() == 401 {
                    let body = resp.text().await.unwrap_or_default();
                    log::warn!("[OmniRealtime] HTTP 探测 body={}", &body[..body.len().min(300)]);
                    return Err("API Key 无效（401 Unauthorized），请在设置中填入正确的 Key".to_string());
                }
            }
            Err(e) => log::warn!("[OmniRealtime] HTTP 探测失败: {e}"),
        }
    }

    let (ws, _) = connect_async(req)
        .await
        .map_err(|e| format!("WebSocket 连接失败: {e:?}"))?;

    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // 转发任务：内部通道 → WebSocket sink
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // 接收任务：WebSocket stream → Tauri 事件
    let tx_clone = tx.clone();
    tokio::spawn(async move {
        let mut session_ready = false;
        // item_id → (call_id, name) ：用于 arguments.delta/done 事件找回对应 call
        let mut pending_calls: HashMap<String, (String, String)> = HashMap::new();
        // item_id → accumulated arguments（部分实现只发 delta，不发 done 的 arguments 字段）
        let mut call_args: HashMap<String, String> = HashMap::new();

        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => {
                    let v: Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let event_type = v["type"].as_str().unwrap_or("");
                    log::debug!("[OmniRealtime] ← {}", event_type);

                    match event_type {
                        "session.created" => {
                            if !session_ready {
                                session_ready = true;
                                // 发送 session.update
                                send_session_update(&tx_clone, &voice, &system_prompt, &tools);
                            }
                        }

                        "session.updated" => {
                            log::info!("[OmniRealtime] 会话就绪");
                            let _ = app_handle.emit("omni://status", json!({
                                "status": "connected"
                            }));
                        }

                        "response.audio.delta" => {
                            if let Some(delta) = v["delta"].as_str() {
                                if !delta.is_empty() {
                                    log::debug!("[OmniRealtime] ← audio_delta {} bytes(b64)", delta.len());
                                    let _ = app_handle.emit("omni://audio_chunk", json!({
                                        "data": delta
                                    }));
                                }
                            }
                        }

                        // AI 回复文字：text 模态或 audio 转写，两种事件名都接
                        "response.text.delta"
                        | "response.audio.transcript.delta"
                        | "response.audio_transcript.delta" => {
                            if let Some(delta) = v["delta"].as_str() {
                                if !delta.is_empty() {
                                    log::debug!("[OmniRealtime] ← text_delta({event_type}) {:?}", &delta[..delta.len().min(40)]);
                                    let _ = app_handle.emit("omni://text_chunk", json!({
                                        "text": delta
                                    }));
                                }
                            }
                        }

                        "response.audio.done" => {
                            log::info!("[OmniRealtime] 音频回复完成");
                            let _ = app_handle.emit("omni://status", json!({
                                "status": "audio_done"
                            }));
                        }

                        // 工具调用 item 首次出现：登记 item_id ↔ call_id/name 映射
                        "response.output_item.added" => {
                            let item = &v["item"];
                            if item["type"].as_str() == Some("function_call") {
                                let item_id = item["id"].as_str().unwrap_or("").to_string();
                                let call_id = item["call_id"].as_str().unwrap_or("").to_string();
                                let name    = item["name"].as_str().unwrap_or("").to_string();
                                if !item_id.is_empty() && !call_id.is_empty() {
                                    log::info!("[OmniRealtime] 工具调用开始 item={} call={} name={}", item_id, call_id, name);
                                    pending_calls.insert(item_id.clone(), (call_id, name));
                                    call_args.insert(item_id, String::new());
                                }
                            }
                        }

                        // 工具参数流式
                        "response.function_call_arguments.delta" => {
                            let item_id = v["item_id"].as_str().unwrap_or("");
                            if let Some(delta) = v["delta"].as_str() {
                                if let Some(buf) = call_args.get_mut(item_id) {
                                    buf.push_str(delta);
                                }
                            }
                        }

                        // 工具参数完成：触发前端执行
                        "response.function_call_arguments.done" => {
                            let item_id = v["item_id"].as_str().unwrap_or("").to_string();
                            let final_args = v["arguments"]
                                .as_str()
                                .map(|s| s.to_string())
                                .or_else(|| call_args.get(&item_id).cloned())
                                .unwrap_or_default();
                            if let Some((call_id, name)) = pending_calls.remove(&item_id) {
                                call_args.remove(&item_id);
                                log::info!("[OmniRealtime] 工具调用完成 call={} name={} args={}",
                                    call_id, name, &final_args[..final_args.len().min(200)]);
                                let _ = app_handle.emit("omni://tool_call", json!({
                                    "call_id": call_id,
                                    "name": name,
                                    "arguments": final_args,
                                }));
                            }
                        }

                        // 兜底：某些实现只发 output_item.done（不发 arguments.done）
                        "response.output_item.done" => {
                            let item = &v["item"];
                            if item["type"].as_str() == Some("function_call") {
                                let item_id = item["id"].as_str().unwrap_or("").to_string();
                                // 若 arguments.done 已处理，这里 pending_calls 已空，跳过
                                if let Some((call_id, name)) = pending_calls.remove(&item_id) {
                                    let final_args = item["arguments"]
                                        .as_str()
                                        .map(|s| s.to_string())
                                        .or_else(|| call_args.get(&item_id).cloned())
                                        .unwrap_or_default();
                                    call_args.remove(&item_id);
                                    log::info!("[OmniRealtime] 工具调用完成(item.done) call={} name={} args={}",
                                        call_id, name, &final_args[..final_args.len().min(200)]);
                                    let _ = app_handle.emit("omni://tool_call", json!({
                                        "call_id": call_id,
                                        "name": name,
                                        "arguments": final_args,
                                    }));
                                }
                            }
                        }

                        "conversation.item.input_audio_transcription.completed" => {
                            if let Some(transcript) = v["transcript"].as_str() {
                                if !transcript.trim().is_empty() {
                                    log::debug!("[OmniRealtime] ← 用户转写: {}", transcript);
                                    let _ = app_handle.emit("omni://user_transcript", json!({
                                        "text": transcript
                                    }));
                                }
                            }
                        }

                        "error" => {
                            let msg_str = v["error"]["message"]
                                .as_str()
                                .unwrap_or("未知错误")
                                .to_string();
                            log::error!("[OmniRealtime] 服务端错误: {}", &msg_str);
                            let _ = app_handle.emit("omni://status", json!({
                                "status": "error",
                                "message": msg_str
                            }));
                        }

                        other => {
                            log::debug!("[OmniRealtime] ← {other}");
                        }
                    }
                }

                Message::Close(_) => {
                    log::info!("[OmniRealtime] 连接关闭");
                    let _ = app_handle.emit("omni://status", json!({
                        "status": "disconnected"
                    }));
                    break;
                }

                _ => {}
            }
        }
    });

    Ok(OmniSession { tx })
}

fn send_session_update(
    tx: &mpsc::UnboundedSender<Message>,
    voice: &str,
    system_prompt: &str,
    tools: &Value,
) {
    // 音色空时使用默认
    let voice_val = if voice.is_empty() { "Tina" } else { voice };

    let mut session = json!({
        "modalities": ["text", "audio"],
        "voice": voice_val,
        "input_audio_format": "pcm",
        "output_audio_format": "pcm",
        "instructions": system_prompt,
        "input_audio_transcription": { "model": "qwen-turbo" },
        // manual 模式：用户手动 commit，配合 Alt 长按 UX
        "turn_detection": null
    });

    // tools 非空数组时注入（Realtime API 扁平格式：{type, name, description, parameters}）
    if let Some(arr) = tools.as_array() {
        if !arr.is_empty() {
            session["tools"] = tools.clone();
            session["tool_choice"] = json!("auto");
        }
    }

    let msg = json!({
        "type": "session.update",
        "session": session,
    });
    let _ = tx.send(Message::Text(msg.to_string().into()));
}
