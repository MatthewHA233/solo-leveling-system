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
use serde::{Deserialize, Serialize};
use tokio::time::{timeout, Duration, Instant};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const FILETRANS_SUBMIT_URL: &str = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
const FILETRANS_TASK_URL_BASE: &str = "https://dashscope.aliyuncs.com/api/v1/tasks";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QwenAsrWord {
    pub begin_time: i64,
    pub end_time: i64,
    pub text: String,
    pub punctuation: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QwenAsrSentence {
    pub sentence_id: Option<i64>,
    pub begin_time: i64,
    pub end_time: i64,
    pub language: Option<String>,
    pub emotion: Option<String>,
    pub text: String,
    #[serde(default)]
    pub words: Vec<QwenAsrWord>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QwenAsrTranscript {
    pub channel_id: Option<i64>,
    pub text: Option<String>,
    #[serde(default)]
    pub sentences: Vec<QwenAsrSentence>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QwenAsrFileTransResult {
    pub task_id: String,
    pub task_status: String,
    pub transcription_url: Option<String>,
    pub usage_seconds: Option<i64>,
    pub transcripts: Vec<QwenAsrTranscript>,
    pub jsonl: String,
    pub raw_json: serde_json::Value,
}

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

#[tauri::command]
pub async fn qwen_asr_filetrans(
    file_url: String,
    api_key: String,
    model: Option<String>,
    language: Option<String>,
    enable_words: Option<bool>,
    poll_interval_ms: Option<u64>,
    timeout_secs: Option<u64>,
) -> Result<QwenAsrFileTransResult, String> {
    let model = model.unwrap_or_else(|| "qwen3-asr-flash-filetrans".to_string());
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {}", e))?;

    let mut parameters = serde_json::Map::new();
    parameters.insert("enable_words".to_string(), serde_json::json!(enable_words.unwrap_or(true)));
    parameters.insert("enable_itn".to_string(), serde_json::json!(false));
    parameters.insert("channel_id".to_string(), serde_json::json!([0]));
    if let Some(lang) = language.filter(|s| !s.trim().is_empty()) {
        parameters.insert("language".to_string(), serde_json::json!(lang));
    }

    let body = serde_json::json!({
        "model": model,
        "input": { "file_url": file_url },
        "parameters": parameters,
    });

    let submit = client
        .post(FILETRANS_SUBMIT_URL)
        .bearer_auth(&api_key)
        .header("Content-Type", "application/json")
        .header("X-DashScope-Async", "enable")
        .header("X-DashScope-OssResourceResolve", "enable")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ASR 任务提交失败: {e}"))?;
    let submit_status = submit.status();
    let submit_text = submit.text().await.unwrap_or_default();
    if !submit_status.is_success() {
        return Err(format!("ASR 任务提交失败 [{}]: {}", submit_status, submit_text));
    }
    let submit_json: serde_json::Value = serde_json::from_str(&submit_text)
        .map_err(|e| format!("ASR 提交响应解析失败: {} ({})", e, submit_text))?;
    let task_id = submit_json["output"]["task_id"]
        .as_str()
        .ok_or_else(|| format!("ASR 提交响应缺少 task_id: {}", submit_json))?
        .to_string();

    let deadline = Instant::now() + Duration::from_secs(timeout_secs.unwrap_or(900));
    let interval = Duration::from_millis(poll_interval_ms.unwrap_or(1500).max(500));
    let final_task = loop {
        if Instant::now() >= deadline {
            return Err(format!("ASR 任务超时: {}", task_id));
        }
        tokio::time::sleep(interval).await;
        let task_resp = client
            .get(format!("{}/{}", FILETRANS_TASK_URL_BASE, task_id))
            .bearer_auth(&api_key)
            .send()
            .await
            .map_err(|e| format!("ASR 任务查询失败: {e}"))?;
        let status = task_resp.status();
        let text = task_resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("ASR 任务查询失败 [{}]: {}", status, text));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("ASR 任务查询响应解析失败: {} ({})", e, text))?;
        let task_status = json["output"]["task_status"].as_str().unwrap_or("");
        match task_status {
            "SUCCEEDED" => break json,
            "FAILED" | "CANCELED" | "UNKNOWN" => {
                let message = json["output"]["message"]
                    .as_str()
                    .or_else(|| json["message"].as_str())
                    .unwrap_or("未知错误");
                return Err(format!("ASR 任务失败 [{}]: {}", task_status, message));
            }
            _ => {}
        }
    };

    let output = &final_task["output"];
    let transcription_url = output["results"]
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(|row| row["transcription_url"].as_str())
        .or_else(|| output["result"]["transcription_url"].as_str())
        .or_else(|| output["transcription_url"].as_str())
        .map(|s| s.to_string());
    let usage_seconds = output["usage"]["duration"]
        .as_i64()
        .or_else(|| output["usage"]["duration_seconds"].as_i64())
        .or_else(|| output["usage_seconds"].as_i64());
    let url = transcription_url
        .as_deref()
        .ok_or_else(|| format!("ASR 成功但缺少 transcription_url: {}", final_task))?;

    let transcript_resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("ASR 结果下载失败: {e}"))?;
    let transcript_status = transcript_resp.status();
    let transcript_text = transcript_resp.text().await.unwrap_or_default();
    if !transcript_status.is_success() {
        return Err(format!("ASR 结果下载失败 [{}]: {}", transcript_status, transcript_text));
    }
    let raw_json: serde_json::Value = serde_json::from_str(&transcript_text)
        .map_err(|e| format!("ASR 结果 JSON 解析失败: {} ({})", e, transcript_text))?;
    let transcripts = parse_filetrans_transcripts(&raw_json)?;
    let jsonl = transcripts_to_jsonl(&transcripts)?;

    Ok(QwenAsrFileTransResult {
        task_id,
        task_status: "SUCCEEDED".to_string(),
        transcription_url,
        usage_seconds,
        transcripts,
        jsonl,
        raw_json,
    })
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

fn parse_filetrans_transcripts(v: &serde_json::Value) -> Result<Vec<QwenAsrTranscript>, String> {
    if let Some(rows) = v.get("transcripts").and_then(|x| x.as_array()) {
        return serde_json::from_value::<Vec<QwenAsrTranscript>>(serde_json::Value::Array(rows.clone()))
            .map_err(|e| format!("ASR transcripts 解析失败: {}", e));
    }
    if let Some(rows) = v.pointer("/output/transcripts").and_then(|x| x.as_array()) {
        return serde_json::from_value::<Vec<QwenAsrTranscript>>(serde_json::Value::Array(rows.clone()))
            .map_err(|e| format!("ASR output.transcripts 解析失败: {}", e));
    }
    if let Some(sentences) = v.get("sentences").and_then(|x| x.as_array()) {
        let transcript = QwenAsrTranscript {
            channel_id: Some(0),
            text: v.get("text").and_then(|x| x.as_str()).map(|s| s.to_string()),
            sentences: serde_json::from_value(serde_json::Value::Array(sentences.clone()))
                .map_err(|e| format!("ASR sentences 解析失败: {}", e))?,
        };
        return Ok(vec![transcript]);
    }
    Err(format!("ASR 结果缺少 transcripts/sentences: {}", v))
}

fn transcripts_to_jsonl(transcripts: &[QwenAsrTranscript]) -> Result<String, String> {
    let mut lines = Vec::new();
    for transcript in transcripts {
        for sentence in &transcript.sentences {
            let text = sentence.text.trim();
            if text.is_empty() {
                continue;
            }
            let line = serde_json::json!({
                "start": millis_to_sec(sentence.begin_time),
                "end": millis_to_sec(sentence.end_time),
                "text": text,
                "speaker": channel_label(transcript.channel_id),
            });
            lines.push(serde_json::to_string(&line).map_err(|e| format!("ASR JSONL 序列化失败: {}", e))?);
        }
    }
    Ok(lines.join("\n"))
}

fn channel_label(channel_id: Option<i64>) -> Option<String> {
    channel_id.map(|id| {
        if id <= 0 {
            "主音轨".to_string()
        } else {
            format!("音轨 {}", id + 1)
        }
    })
}

fn millis_to_sec(value: i64) -> f64 {
    (value.max(0) as f64 / 1000.0 * 1000.0).round() / 1000.0
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
