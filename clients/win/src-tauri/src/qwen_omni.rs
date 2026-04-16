// ══════════════════════════════════════════════
// Qwen Omni Realtime — DashScope 全模态单 WS
//
// 参考: docs/参考.md（基于官方文档整理）
//
// 协议流程:
//   连接(Authorization header) → session.created
//   → session.update(modalities/voice/格式)
//   → input_audio_buffer.append(PCM Base64)
//   → input_audio_buffer.commit + response.create
//   ← response.audio.delta (PCM Base64)
//   ← response.text.delta  (AI 文字)
//   ← response.audio.done  → omni://status {audio_done}
//
// Tauri 事件（emit 到前端）:
//   omni://status      { status: "connected"|"audio_done"|"error"|"disconnected", message? }
//   omni://audio_chunk { data: string }  — Base64 PCM，前端直接解码播放
//   omni://text_chunk  { text: string }  — AI 回复增量文字
// ══════════════════════════════════════════════

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
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
                                send_session_update(&tx_clone, &voice, &system_prompt);
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

                        "response.text.delta" => {
                            if let Some(delta) = v["delta"].as_str() {
                                if !delta.is_empty() {
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
) {
    // 音色空时使用默认
    let voice_val = if voice.is_empty() { "Tina" } else { voice };

    let msg = json!({
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "voice": voice_val,
            "input_audio_format": "pcm",
            "output_audio_format": "pcm",
            "instructions": system_prompt,
            // manual 模式：用户手动 commit，配合 Alt 长按 UX
            "turn_detection": null
        }
    });
    let _ = tx.send(Message::Text(msg.to_string().into()));
}
