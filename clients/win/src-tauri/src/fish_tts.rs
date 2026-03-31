// ══════════════════════════════════════════════
// Fish TTS WebSocket 客户端
// 支持 HTTP 代理（CONNECT 隧道）
// API: https://docs.fish.audio/api-reference/endpoint/websocket/tts-live
// ══════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::{Receiver, Sender};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use base64::{Engine as _, engine::general_purpose::STANDARD};

// ── MessagePack 消息格式 ──

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct StartEvent {
    event: String,
    request: StartRequest,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct StartRequest {
    text: String,
    reference_id: String,
    format: String,
    sample_rate: u32,
    latency: String,
}

#[derive(Serialize)]
struct TextEvent {
    event: String,
    text: String,
}

#[derive(Serialize)]
struct FlushEvent {
    event: String,
}

#[derive(Deserialize)]
struct AudioEvent {
    event: String,
    #[serde(default)]
    audio: Option<Vec<u8>>,
}

// ── Tauri 命令参数 ──

#[derive(Debug, Serialize, Deserialize)]
pub struct FishTTSConfig {
    pub api_key: String,
    pub reference_id: String,  // 音色 ID
    pub sample_rate: u32,
    pub proxy_port: u16,
    pub model: String,  // s1 或 s2-pro
}

// ── 连接状态 ──

pub struct FishTTSConnection {
    tx: Sender<FrontendMessage>,
}

enum FrontendMessage {
    Text(String),
    Flush,
    Stop,
}

impl FishTTSConnection {
    pub fn start(
        config: FishTTSConfig,
        app_handle: tauri::AppHandle,
    ) -> Result<Self, String> {
        let (tx, rx) = tokio::sync::mpsc::channel(32);

        tokio::spawn(async move {
            if let Err(e) = run_ws_loop(config, rx, app_handle).await {
                log::error!("[FishTTS] 错误: {}", e);
            }
        });

        Ok(Self { tx })
    }

    pub async fn send_text(&self, text: String) -> Result<(), String> {
        self.tx.send(FrontendMessage::Text(text)).await.map_err(|e| e.to_string())
    }

    pub async fn flush(&self) -> Result<(), String> {
        self.tx.send(FrontendMessage::Flush).await.map_err(|e| e.to_string())
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.tx.send(FrontendMessage::Stop).await.map_err(|e| e.to_string())
    }
}

// ── WebSocket 循环 ──

async fn run_ws_loop(
    config: FishTTSConfig,
    mut rx: Receiver<FrontendMessage>,
    app_handle: tauri::AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    log::info!("[FishTTS] 开始连接, 代理端口: {}, 模型: {}", config.proxy_port, config.model);

    // 通过 HTTP 代理建立隧道
    let stream = connect_via_proxy(config.proxy_port).await?;

    // 包装 TLS
    let tls_connector = tokio_native_tls::TlsConnector::from(
        native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| e.to_string())?,
    );
    let mut tls_stream = tls_connector.connect("api.fish.audio", stream).await?;

    // 手动发送 WebSocket 握手请求（确保 headers 正确传递）
    let ws_key = STANDARD.encode(rand_key());
    let handshake = format!(
        "GET /v1/tts/live HTTP/1.1\r\nHost: api.fish.audio\r\nauthorization: Bearer {}\r\nmodel: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        config.api_key, config.model, ws_key
    );
    log::info!("[FishTTS] 发送握手请求 (api_key 长度: {}):", config.api_key.len());
    tls_stream.write_all(handshake.as_bytes()).await?;
    tls_stream.flush().await?;

    // 读取 HTTP 101 响应（循环读取直到收到完整 headers）
    let mut response_buf = Vec::new();
    loop {
        let mut chunk = vec![0u8; 1024];
        let n = tls_stream.read(&mut chunk).await?;
        if n == 0 {
            return Err("连接关闭".into());
        }
        response_buf.extend_from_slice(&chunk[..n]);

        // 检查是否收到完整的 HTTP headers (\r\n\r\n)
        if let Ok(response_str) = std::str::from_utf8(&response_buf) {
            if response_str.contains("\r\n\r\n") {
                break;
            }
        }
    }

    let response_str = String::from_utf8_lossy(&response_buf);
    log::info!("[FishTTS] 握手响应: {}", response_str.lines().next().unwrap_or(""));

    if !response_str.contains("HTTP/1.1 101") && !response_str.contains("HTTP/1.0 101") {
        return Err(format!("WebSocket 握手失败: {}", response_str.lines().next().unwrap_or("")).into());
    }

    log::info!("[FishTTS] WebSocket 已连接");

    // 将 TLS stream 转为 WebSocket
    let ws = tokio_tungstenite::WebSocketStream::from_raw_socket(
        tls_stream,
        tokio_tungstenite::tungstenite::protocol::Role::Client,
        Some(WebSocketConfig::default()),
    ).await;

    // 分离 sink 和 stream
    let (mut ws_sink, mut ws_stream) = ws.split();

    log::info!("[FishTTS] WebSocket 已连接");

    // 发送 start 事件
    let start = StartEvent {
        event: "start".to_string(),
        request: StartRequest {
            text: String::new(),
            reference_id: config.reference_id.clone(),
            format: "pcm".to_string(),
            sample_rate: config.sample_rate,
            latency: "normal".to_string(),
        },
    };
    // 使用 to_vec_named 序列化为 map 格式（带字段名）
    let start_bytes = rmp_serde::to_vec_named(&start)?;
    log::info!("[FishTTS] start 消息长度: {} 字节", start_bytes.len());
    log::info!("[FishTTS] start hex: {}", start_bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>());
    ws_sink.send(Message::Binary(start_bytes.into())).await?;

    log::info!("[FishTTS] 已发送 start 事件, reference_id: {}", config.reference_id);

    // 双向循环
    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                match msg {
                    FrontendMessage::Text(text) => {
                        log::info!("[FishTTS] 收到前端文本, 长度: {}", text.len());
                        let event = TextEvent { event: "text".to_string(), text };
                        let bytes = rmp_serde::to_vec_named(&event)?;
                        log::info!("[FishTTS] 发送 text 事件, {} 字节", bytes.len());
                        ws_sink.send(Message::Binary(bytes.into())).await?;
                    }
                    FrontendMessage::Flush => {
                        log::info!("[FishTTS] 收到前端 flush");
                        let event = FlushEvent { event: "flush".to_string() };
                        let bytes = rmp_serde::to_vec_named(&event)?;
                        ws_sink.send(Message::Binary(bytes.into())).await?;
                        // 不要立即 break，继续等待音频
                    }
                    FrontendMessage::Stop => {
                        log::info!("[FishTTS] 收到前端 stop");
                        let event = FlushEvent { event: "stop".to_string() };
                        let bytes = rmp_serde::to_vec_named(&event)?;
                        let _ = ws_sink.send(Message::Binary(bytes.into())).await;
                        break;
                    }
                }
            }

            Some(msg) = ws_stream.next() => {
                match msg {
                    Ok(Message::Binary(data)) => {
                        log::info!("[FishTTS] 收到二进制消息, 长度: {} 字节", data.len());

                        // 打印完整的 hex
                        let hex_full: String = data.iter().map(|b| format!("{:02x}", b)).collect();
                        log::info!("[FishTTS] 完整数据: {}", hex_full);

                        // 尝试解析为 AudioEvent
                        if let Ok(audio_event) = rmp_serde::from_slice::<AudioEvent>(&data) {
                            log::info!("[FishTTS] 解析事件: {}, audio 字段: {:?}", audio_event.event, audio_event.audio.as_ref().map(|a| a.len()));

                            // 处理所有事件类型
                            match audio_event.event.as_str() {
                                "audio" | "audio_chunk" => {
                                    if let Some(audio) = audio_event.audio {
                                        log::info!("[FishTTS] 收到音频 {} 字节", audio.len());
                                        let _ = app_handle.emit("fish-tts-audio", &audio);
                                    }
                                }
                                "finish" => {
                                    log::info!("[FishTTS] 合成完成");
                                    let _ = app_handle.emit("fish-tts-finish", ());
                                    break;
                                }
                                _ => {
                                    log::info!("[FishTTS] 其他事件: {}", audio_event.event);
                                }
                            }
                        } else {
                            log::warn!("[FishTTS] 无法解析 AudioEvent");
                        }
                    }
                    Ok(Message::Text(text)) => {
                        log::info!("[FishTTS] 收到文本消息: {}", text);
                    }
                    Ok(Message::Close(_)) => {
                        log::info!("[FishTTS] 收到 Close 消息，触发完成");
                        let _ = app_handle.emit("fish-tts-finish", ());
                        break;
                    }
                    Err(e) => {
                        log::error!("[FishTTS] WS 错误: {}", e);
                        break;
                    }
                    _ => {
                        log::info!("[FishTTS] 收到其他消息类型");
                    }
                }
            }

            else => {
                        log::info!("[FishTTS] select! 结束，触发完成");
                        let _ = app_handle.emit("fish-tts-finish", ());
                        break;
                    }
        }
    }

    Ok(())
}

// ── 通过 HTTP 代理建立隧道 ──

async fn connect_via_proxy(
    proxy_port: u16,
) -> Result<tokio::net::TcpStream, Box<dyn std::error::Error + Send + Sync>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let proxy_addr = format!("127.0.0.1:{}", proxy_port);
    let mut stream = tokio::net::TcpStream::connect(&proxy_addr).await?;

    log::info!("[FishTTS] 已连接代理 {}", proxy_addr);

    // 发送 CONNECT 请求
    let connect_req = format!(
        "CONNECT api.fish.audio:443 HTTP/1.1\r\nHost: api.fish.audio:443\r\n\r\n"
    );
    stream.write_all(connect_req.as_bytes()).await?;

    // 读取响应
    let mut response = vec![0u8; 1024];
    let n = stream.read(&mut response).await?;
    let response_str = String::from_utf8_lossy(&response[..n]);

    if !response_str.starts_with("HTTP/1.1 200") && !response_str.starts_with("HTTP/1.0 200") {
        return Err(format!("代理 CONNECT 失败: {}", response_str).into());
    }

    log::info!("[FishTTS] 代理隧道已建立");

    Ok(stream)
}

// ── 生成随机 WebSocket Key ──

fn rand_key() -> [u8; 16] {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    let mut key = [0u8; 16];
    for i in 0..8 {
        key[i] = ((now >> (i * 8)) & 0xFF) as u8;
    }
    // 填充随机部分
    for i in 8..16 {
        key[i] = (i as u8) ^ 0x5A;
    }
    key
}