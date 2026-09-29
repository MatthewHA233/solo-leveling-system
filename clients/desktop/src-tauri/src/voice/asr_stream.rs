// ══════════════════════════════════════════════
// 流式语音识别客户端（百炼 Qwen-Audio-ASR-Streaming / Fun-ASR 协议）
//
//   连接 → run-task（参数 + 即时热词 + 对话上下文）→ task-started
//        → 二进制 PCM 帧 … → finish-task → result-generated* → task-finished
//
// 每个连接跑在自己的任务里：上游通过 AsrInput 喂音频、下游通过 AsrOutput 收结果。
// task-started 之前到达的音频先攒着，开始后按序补发。重连 / 重放由会话编排层决定。
// ══════════════════════════════════════════════

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::time::{timeout, Duration, Instant};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const START_TIMEOUT: Duration = Duration::from_secs(5);
/// 发出 finish-task 后等 task-finished 的上限（正常约 0.3 秒）
const FINALIZE_TIMEOUT: Duration = Duration::from_secs(8);
/// 上下文：服务端最多保留最近 5 轮，每轮 user + assistant 合计不超过 400 字
pub const CONTEXT_MAX_TURNS: usize = 5;
const CONTEXT_TURN_CHARS: usize = 400;
/// 即时热词：普通权重上限 5；数量控制在 100 以内，太多会稀释效果
const VOCAB_MAX_WEIGHT: i32 = 5;
const VOCAB_MAX_WORDS: usize = 100;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ContextTurn {
    pub user: String,
    pub assistant: String,
}

#[derive(Debug, Clone)]
pub struct AsrConfig {
    pub api_key: String,
    pub model: String,
    /// 按顺序尝试，第一个连上的为准（业务空间专属域名优先，通用域名兜底）
    pub endpoints: Vec<String>,
    pub vocabulary: Vec<String>,
    pub context: Vec<ContextTurn>,
    pub language_hints: Vec<String>,
}

pub enum AsrInput {
    Audio(Vec<u8>),
    Finish,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct AsrUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug)]
pub enum AsrOutput {
    Started { connect_ms: u64, start_ms: u64 },
    Partial(String),
    Final { text: String, usage: Option<AsrUsage> },
    Finished,
    /// retryable=false 表示换条连接也没用（鉴权失败、参数错误等）
    Failed { message: String, retryable: bool },
}

// ── 协议构造 ──

pub fn run_task_message(task_id: &str, cfg: &AsrConfig) -> String {
    let mut parameters = json!({
        "format": "pcm",
        "sample_rate": 16_000,
        // 对着电脑说话属于近场；默认的远场模型更适合会议室
        "vad_model": "near_meeting_16k",
    });
    if !cfg.language_hints.is_empty() {
        parameters["language_hints"] = json!(cfg.language_hints);
    }
    let vocabulary = vocabulary_json(&cfg.vocabulary);
    if !vocabulary.is_empty() {
        parameters["vocabulary"] = Value::Object(vocabulary);
    }
    let context = context_json(&cfg.context);
    let input = if context.is_empty() { json!({}) } else { json!({ "context": context }) };
    json!({
        "header": { "action": "run-task", "task_id": task_id, "streaming": "duplex" },
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": cfg.model,
            "parameters": parameters,
            "input": input,
        }
    })
    .to_string()
}

pub fn finish_task_message(task_id: &str) -> String {
    json!({
        "header": { "action": "finish-task", "task_id": task_id, "streaming": "duplex" },
        "payload": { "input": {} }
    })
    .to_string()
}

fn vocabulary_json(words: &[String]) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    for w in words.iter().map(|w| w.trim()).filter(|w| !w.is_empty()) {
        if map.len() >= VOCAB_MAX_WORDS {
            break;
        }
        map.entry(w.to_string()).or_insert(json!(VOCAB_MAX_WEIGHT));
    }
    map
}

/// 取最近几轮，每轮先保证用户原话、再把剩余额度给助手回复
fn context_json(turns: &[ContextTurn]) -> Vec<Value> {
    let start = turns.len().saturating_sub(CONTEXT_MAX_TURNS);
    let mut out = Vec::new();
    for t in &turns[start..] {
        let user: String = t.user.trim().chars().take(CONTEXT_TURN_CHARS).collect();
        if user.is_empty() {
            continue;
        }
        let budget = CONTEXT_TURN_CHARS - user.chars().count();
        let assistant: String = t.assistant.trim().chars().take(budget).collect();
        out.push(json!({ "role": "user", "content": [{ "type": "input_text", "text": user }] }));
        if !assistant.is_empty() {
            out.push(json!({ "role": "assistant", "content": [{ "type": "text", "text": assistant }] }));
        }
    }
    out
}

// ── 协议解析 ──

#[derive(Debug, PartialEq)]
pub enum ServerEvent {
    Started,
    Partial(String),
    Final { text: String, usage: Option<(u64, u64)> },
    Finished,
    Failed { code: String, message: String },
    Ignore,
}

pub fn parse_server_event(raw: &str) -> ServerEvent {
    let Ok(v) = serde_json::from_str::<Value>(raw) else { return ServerEvent::Ignore };
    match v["header"]["event"].as_str() {
        Some("task-started") => ServerEvent::Started,
        Some("task-finished") => ServerEvent::Finished,
        Some("task-failed") => ServerEvent::Failed {
            code: v["header"]["error_code"].as_str().unwrap_or("UNKNOWN").to_string(),
            message: v["header"]["error_message"].as_str().unwrap_or("识别任务失败").to_string(),
        },
        Some("result-generated") => {
            let s = &v["payload"]["output"]["sentence"];
            if s["heartbeat"].as_bool() == Some(true) {
                return ServerEvent::Ignore;
            }
            let text = s["text"].as_str().unwrap_or("").to_string();
            if s["sentence_end"].as_bool() == Some(true) {
                let u = &v["payload"]["usage"];
                let usage = u["input_tokens"].as_u64().map(|i| (i, u["output_tokens"].as_u64().unwrap_or(0)));
                ServerEvent::Final { text, usage }
            } else {
                ServerEvent::Partial(text)
            }
        }
        _ => ServerEvent::Ignore,
    }
}

/// 鉴权 / 参数类错误重连也没用
fn is_retryable(code: &str) -> bool {
    !matches!(code, "InvalidApiKey" | "AccessDenied" | "InvalidParameter" | "ModelNotFound" | "Arrearage")
}

// ── 连接任务 ──

pub fn spawn(cfg: AsrConfig) -> (UnboundedSender<AsrInput>, UnboundedReceiver<AsrOutput>) {
    let (in_tx, in_rx) = unbounded_channel();
    let (out_tx, out_rx) = unbounded_channel();
    tokio::spawn(async move {
        if let Err((message, retryable)) = session(cfg, in_rx, &out_tx).await {
            let _ = out_tx.send(AsrOutput::Failed { message, retryable });
        }
    });
    (in_tx, out_rx)
}

type Fail = (String, bool);

async fn session(
    cfg: AsrConfig,
    mut input: UnboundedReceiver<AsrInput>,
    out: &UnboundedSender<AsrOutput>,
) -> Result<(), Fail> {
    let t0 = Instant::now();
    let ws = connect_any(&cfg).await?;
    let connect_ms = t0.elapsed().as_millis() as u64;
    let (mut sink, mut stream) = ws.split();

    let task_id = uuid::Uuid::new_v4().simple().to_string();
    sink.send(Message::Text(run_task_message(&task_id, &cfg).into()))
        .await
        .map_err(|e| (format!("发送识别任务失败: {e}"), true))?;

    // task-started 之前到达的音频先攒着
    let mut backlog: Vec<Vec<u8>> = Vec::new();
    let mut finish_requested = false;
    let start_deadline = Instant::now() + START_TIMEOUT;
    loop {
        tokio::select! {
            msg = stream.next() => match handle_frame(msg, out)? {
                Some(ServerEvent::Started) => break,
                Some(_) | None => {}
            },
            item = input.recv() => match item {
                Some(AsrInput::Audio(a)) => backlog.push(a),
                Some(AsrInput::Finish) => finish_requested = true,
                None => return Ok(()), // 会话被取消
            },
            _ = tokio::time::sleep_until(start_deadline) => {
                return Err(("识别服务启动超时".to_string(), true));
            }
        }
    }
    let _ = out.send(AsrOutput::Started { connect_ms, start_ms: t0.elapsed().as_millis() as u64 });
    for frame in backlog.drain(..) {
        sink.send(Message::Binary(frame.into())).await.map_err(|e| (format!("发送音频失败: {e}"), true))?;
    }
    if finish_requested {
        sink.send(Message::Text(finish_task_message(&task_id).into()))
            .await
            .map_err(|e| (format!("结束识别任务失败: {e}"), true))?;
    }

    let mut finish_deadline = finish_requested.then(|| Instant::now() + FINALIZE_TIMEOUT);
    loop {
        tokio::select! {
            msg = stream.next() => match handle_frame(msg, out)? {
                Some(ServerEvent::Finished) => {
                    let _ = out.send(AsrOutput::Finished);
                    return Ok(());
                }
                Some(_) | None => {}
            },
            item = input.recv(), if finish_deadline.is_none() => match item {
                Some(AsrInput::Audio(a)) => {
                    sink.send(Message::Binary(a.into())).await.map_err(|e| (format!("发送音频失败: {e}"), true))?;
                }
                Some(AsrInput::Finish) => {
                    finish_deadline = Some(Instant::now() + FINALIZE_TIMEOUT);
                    sink.send(Message::Text(finish_task_message(&task_id).into()))
                        .await
                        .map_err(|e| (format!("结束识别任务失败: {e}"), true))?;
                }
                None => {
                    let _ = sink.close().await; // 会话被取消
                    return Ok(());
                }
            },
            _ = sleep_until_opt(finish_deadline) => {
                return Err(("识别收尾超时".to_string(), true));
            }
        }
    }
}

async fn sleep_until_opt(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

/// 处理一个服务端帧：结果转发给下游，失败 / 断开转成错误
fn handle_frame(
    msg: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
    out: &UnboundedSender<AsrOutput>,
) -> Result<Option<ServerEvent>, Fail> {
    match msg {
        Some(Ok(Message::Text(t))) => {
            let ev = parse_server_event(&t);
            match &ev {
                ServerEvent::Partial(text) => {
                    let _ = out.send(AsrOutput::Partial(text.clone()));
                }
                ServerEvent::Final { text, usage } => {
                    let usage = usage.map(|(i, o)| AsrUsage { input_tokens: i, output_tokens: o });
                    let _ = out.send(AsrOutput::Final { text: text.clone(), usage });
                }
                ServerEvent::Failed { code, message } => {
                    return Err((format!("识别失败（{code}）：{message}"), is_retryable(code)));
                }
                _ => {}
            }
            Ok(Some(ev))
        }
        Some(Ok(Message::Close(frame))) => {
            let reason = frame.map(|f| f.reason.as_str().to_string()).unwrap_or_default();
            Err((format!("识别连接被关闭 {reason}"), true))
        }
        Some(Ok(_)) => Ok(None),
        Some(Err(e)) => Err((format!("识别连接出错: {e}"), true)),
        None => Err(("识别连接意外断开".to_string(), true)),
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_any(cfg: &AsrConfig) -> Result<Ws, Fail> {
    let mut last = ("没有可用的识别服务地址".to_string(), true);
    for url in &cfg.endpoints {
        let mut req = match url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                last = (format!("识别地址无效 {url}: {e}"), false);
                continue;
            }
        };
        let auth = format!("Bearer {}", cfg.api_key).parse().map_err(|_| ("API Key 格式无效".to_string(), false))?;
        req.headers_mut().insert("Authorization", auth);
        match timeout(CONNECT_TIMEOUT, connect_async(req)).await {
            Ok(Ok((ws, _))) => return Ok(ws),
            Ok(Err(e)) => {
                let text = e.to_string();
                let auth_failed = text.contains("401") || text.contains("403");
                log::warn!("[Voice] 识别服务连接失败 {url}: {text}");
                last = if auth_failed {
                    ("识别服务拒绝了 API Key（401/403），请检查百炼 Key".to_string(), false)
                } else {
                    (format!("连接识别服务失败: {text}"), true)
                };
                if auth_failed {
                    break;
                }
            }
            Err(_) => {
                log::warn!("[Voice] 识别服务连接超时 {url}");
                last = ("连接识别服务超时".to_string(), true);
            }
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AsrConfig {
        AsrConfig {
            api_key: "k".into(),
            model: "qwen-audio-3.1-asr-flash-streaming".into(),
            endpoints: vec![],
            vocabulary: vec![" Solevup ".into(), "Fairy".into(), "".into(), "Fairy".into()],
            context: vec![],
            language_hints: vec!["zh".into(), "en".into()],
        }
    }

    #[test]
    fn run_task_carries_parameters_vocabulary_and_empty_input() {
        let v: Value = serde_json::from_str(&run_task_message("t1", &cfg())).unwrap();
        assert_eq!(v["header"]["action"], "run-task");
        assert_eq!(v["header"]["streaming"], "duplex");
        let p = &v["payload"]["parameters"];
        assert_eq!(p["format"], "pcm");
        assert_eq!(p["sample_rate"], 16_000);
        assert_eq!(p["vad_model"], "near_meeting_16k");
        assert_eq!(p["vocabulary"], json!({ "Solevup": 5, "Fairy": 5 }));
        assert_eq!(v["payload"]["input"], json!({}));
    }

    #[test]
    fn context_keeps_last_five_turns_within_budget() {
        let mut c = cfg();
        c.context = (0..8)
            .map(|i| ContextTurn { user: format!("第{i}轮{}", "说".repeat(300)), assistant: "答".repeat(300) })
            .collect();
        let v: Value = serde_json::from_str(&run_task_message("t", &c)).unwrap();
        let ctx = v["payload"]["input"]["context"].as_array().unwrap();
        assert_eq!(ctx.len(), 10);
        assert!(ctx[0]["content"][0]["text"].as_str().unwrap().starts_with("第3轮"));
        for pair in ctx.chunks(2) {
            let n = pair.iter().map(|m| m["content"][0]["text"].as_str().unwrap().chars().count()).sum::<usize>();
            assert!(n <= 400, "turn chars={n}");
        }
        assert_eq!(ctx[1]["role"], "assistant");
        assert_eq!(ctx[1]["content"][0]["type"], "text");
    }

    #[test]
    fn parses_server_events() {
        let partial = r#"{"header":{"event":"result-generated"},"payload":{"output":{"sentence":{"text":"拖到","sentence_end":false}},"usage":null}}"#;
        assert_eq!(parse_server_event(partial), ServerEvent::Partial("拖到".into()));
        let fin = r#"{"header":{"event":"result-generated"},"payload":{"output":{"sentence":{"text":"好，我知道了","sentence_end":true}},"usage":{"input_tokens":184,"output_tokens":22}}}"#;
        assert_eq!(parse_server_event(fin), ServerEvent::Final { text: "好，我知道了".into(), usage: Some((184, 22)) });
        let hb = r#"{"header":{"event":"result-generated"},"payload":{"output":{"sentence":{"text":"","heartbeat":true,"sentence_end":true}}}}"#;
        assert_eq!(parse_server_event(hb), ServerEvent::Ignore);
        let failed = r#"{"header":{"event":"task-failed","error_code":"CLIENT_ERROR","error_message":"request timeout after 23 seconds."},"payload":{}}"#;
        assert_eq!(
            parse_server_event(failed),
            ServerEvent::Failed { code: "CLIENT_ERROR".into(), message: "request timeout after 23 seconds.".into() }
        );
        assert_eq!(parse_server_event("not json"), ServerEvent::Ignore);
        assert!(!is_retryable("InvalidApiKey"));
        assert!(is_retryable("CLIENT_ERROR"));
    }
}
