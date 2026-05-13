// ══════════════════════════════════════════════
// Qwen-ASR Realtime — DashScope WebSocket 语音转文字
//
// 官方协议（Manual 模式）：
//   open → session.update → input_audio_buffer.append(chunks)
//        → input_audio_buffer.commit → session.finish
//        → conversation.item.input_audio_transcription.completed
// ══════════════════════════════════════════════

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use tokio::time::{timeout, Duration, Instant};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[tauri::command]
pub async fn qwen_asr_transcribe(
    wav_base64: String,
    api_key: String,
    model: String,
    ws_url: String,
) -> Result<String, String> {
    // 解码 WAV，跳过 44 字节头取原始 PCM16
    let wav_bytes = STANDARD
        .decode(&wav_base64)
        .map_err(|e| format!("WAV 解码失败: {e}"))?;

    let pcm16 = find_wav_data(&wav_bytes)
        .ok_or_else(|| "WAV 格式无效".to_string())?;

    if pcm16.is_empty() {
        return Err("PCM 数据为空".to_string());
    }

    // 建立 WebSocket 连接
    let url = format!("{ws_url}?model={model}");
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("请求构建失败: {e}"))?;

    {
        let headers = req.headers_mut();
        headers.insert("Authorization",
            format!("Bearer {api_key}").parse().map_err(|_| "API Key 无效".to_string())?);
        headers.insert("OpenAI-Beta",
            "realtime=v1".parse().map_err(|_| "header 错误".to_string())?);
    }

    let (mut ws, _) = connect_async(req)
        .await
        .map_err(|e| format!("WebSocket 连接失败: {e}"))?;

    log::info!("[QwenASR] 已连接 model={model}");

    // 等待 session.created（或直接发 session.update 也可以）
    wait_type(&mut ws, "session.created", 10).await?;

    // session.update：Manual 模式，16kHz PCM
    send(&mut ws, serde_json::json!({
        "event_id": "ev_update",
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            "input_audio_transcription": { "language": "zh" },
            "turn_detection": null
        }
    })).await?;

    wait_type(&mut ws, "session.updated", 10).await?;

    // 分块发送 PCM16（每块 3200 字节 ≈ 0.1s）
    let chunk_size = 3200usize;
    let mut offset = 0;
    while offset < pcm16.len() {
        let end = (offset + chunk_size).min(pcm16.len());
        let chunk_b64 = STANDARD.encode(&pcm16[offset..end]);
        send(&mut ws, serde_json::json!({
            "event_id": format!("ev_audio_{offset}"),
            "type": "input_audio_buffer.append",
            "audio": chunk_b64
        })).await?;
        offset = end;
    }

    // commit + finish
    send(&mut ws, serde_json::json!({ "event_id": "ev_commit", "type": "input_audio_buffer.commit" })).await?;
    send(&mut ws, serde_json::json!({ "event_id": "ev_finish", "type": "session.finish" })).await?;

    // 等待转写结果
    let transcript = recv_transcript(&mut ws, 30).await?;

    let _ = ws.close(None).await;
    log::info!("[QwenASR] 完成: {}", &transcript);
    Ok(transcript)
}

fn find_wav_data(wav: &[u8]) -> Option<&[u8]> {
    if wav.len() < 12 { return None; }
    let mut i = 12usize;
    while i + 8 <= wav.len() {
        let tag = &wav[i..i + 4];
        let size = u32::from_le_bytes(wav[i + 4..i + 8].try_into().ok()?) as usize;
        if tag == b"data" {
            let start = i + 8;
            return Some(&wav[start..wav.len().min(start + size)]);
        }
        let next = i + 8 + size;
        i = if size % 2 != 0 { next + 1 } else { next };
    }
    None
}

async fn send(ws: &mut Ws, v: serde_json::Value) -> Result<(), String> {
    ws.send(Message::Text(v.to_string().into()))
        .await
        .map_err(|e| format!("发送失败: {e}"))
}

async fn wait_type(ws: &mut Ws, event: &str, secs: u64) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let rem = deadline.saturating_duration_since(Instant::now());
        if rem.is_zero() { return Err(format!("等待 {event} 超时")); }
        match timeout(rem, ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                let typ = v["type"].as_str().unwrap_or("");
                if typ == event { return Ok(()); }
                if typ == "error" {
                    return Err(format!("API 错误: {}", v["error"]["message"].as_str().unwrap_or(&t)));
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(format!("WS 错误: {e}")),
            Ok(None) => return Err(format!("WS 关闭（等待 {event}）")),
            Err(_) => return Err(format!("等待 {event} 超时")),
        }
    }
}

async fn recv_transcript(ws: &mut Ws, secs: u64) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let rem = deadline.saturating_duration_since(Instant::now());
        if rem.is_zero() { return Err("转写超时".to_string()); }
        match timeout(rem, ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                match v["type"].as_str() {
                    Some("conversation.item.input_audio_transcription.completed") => {
                        return Ok(v["transcript"].as_str().unwrap_or("").to_string());
                    }
                    Some("error") => {
                        return Err(format!("API 错误: {}",
                            v["error"]["message"].as_str().unwrap_or(&t)));
                    }
                    _ => {}
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(format!("WS 错误: {e}")),
            Ok(None) => return Err("WS 意外关闭".to_string()),
            Err(_) => return Err("转写超时".to_string()),
        }
    }
}
