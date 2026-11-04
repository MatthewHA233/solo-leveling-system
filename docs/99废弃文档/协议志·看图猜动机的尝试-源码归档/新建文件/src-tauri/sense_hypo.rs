// ══════════════════════════════════════════════
// 系统 · 提议动机：持续对不上云里任何一颗动机时，让会看图的大模型概括一句「你在推进的那件更大的事」
//   决策模型只会在给定的选项里挑；新动机得有人先说出来——这里由大模型先提，再由系统窗口问你收不收（sense_motives）
//   模型在模型库绑定（system_sense_hypothesis，默认千问 Max 3.8 多模态，走百炼、用当前启用的 Key）；调用记进模型审计
// ══════════════════════════════════════════════

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rusqlite::params;
use serde::Deserialize;

use crate::db::{Database, LogModelCallRequest};

pub const FEATURE_HYPOTHESIS: &str = "system_sense_hypothesis";
const DEFAULT_MODEL: &str = "qwen3.8-max";
const ENDPOINT: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TOKENS: u32 = 60;

#[derive(Deserialize)]
struct ChatResp {
    choices: Vec<ChatChoice>,
    usage: Option<Usage>,
}
#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMsg,
}
#[derive(Deserialize)]
struct ChatMsg {
    content: Option<String>,
}
#[derive(Deserialize)]
struct Usage {
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
}

pub(crate) fn seed_binding(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO feature_bindings (feature, model_id, updated_at) VALUES (?1, ?2, ?3)",
        params![FEATURE_HYPOTHESIS, DEFAULT_MODEL, chrono::Utc::now().to_rfc3339()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(TIMEOUT).build().unwrap_or_else(|_| reqwest::Client::new()))
}

fn prompt(app: &str, title: &str, known: &[String]) -> String {
    let known = if known.is_empty() { "（暂无）".to_string() } else { known.join("；") };
    format!(
        "这是用户电脑当前窗口的截图（{app}「{title}」）。\n\
         用户云里已有的动机：{known}\n\
         这一阵子用户在做的事，和这些都对不上（已经判过了）。用一句话概括用户在推进的那件更大的事——\
         项目、动机层面，不是此刻的小动作；不要和已有的动机重复；不超过 16 字、以动词开头，\
         比如「把协议志做成独自升级系统」「打磨 Solevup 的桌面端界面」。\
         只输出这一句，不要解释。"
    )
}

/// 看截图提一句动机；失败返回原因（思维终端里显示）
pub async fn propose_motive(db: &Database, jpeg: &[u8], app: &str, title: &str, known: &[String]) -> Result<String, String> {
    let key = match db.get_active_model_api_key().await {
        Ok(Some(k)) if !k.api_key.trim().is_empty() => k,
        _ => {
            return Err("没有启用的百炼 Key".into());
        }
    };
    let model = db.get_feature_model(FEATURE_HYPOTHESIS).await.ok().flatten().unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let body = serde_json::json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        // 只要一句话：关掉深度思考（开着时一句话要 25 秒、上千个思考 token）
        "enable_thinking": false,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg)) } },
                { "type": "text", "text": prompt(app, title, known) }
            ]
        }]
    });
    let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let t0 = Instant::now();
    let result: Result<(String, i64, i64), String> = async {
        let resp = client().post(ENDPOINT).bearer_auth(key.api_key.trim()).json(&body).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
        }
        let parsed: ChatResp = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let content = parsed.choices.first().and_then(|c| c.message.content.clone()).unwrap_or_default();
        let usage = parsed.usage.as_ref();
        Ok((
            content,
            usage.and_then(|u| u.prompt_tokens).unwrap_or(0),
            usage.and_then(|u| u.completion_tokens).unwrap_or(0),
        ))
    }
    .await;

    let (prompt_tokens, completion_tokens) = result.as_ref().map(|(_, p, c)| (*p, *c)).unwrap_or((0, 0));
    let audit = LogModelCallRequest {
        api_key_id: Some(key.id.clone()),
        feature: FEATURE_HYPOTHESIS.into(),
        model_id: model,
        started_at,
        duration_ms: Some(t0.elapsed().as_millis() as i64),
        prompt_text_tokens: 0,
        prompt_image_tokens: prompt_tokens,
        prompt_video_tokens: 0,
        prompt_audio_tokens: 0,
        completion_text_tokens: completion_tokens,
        completion_audio_tokens: 0,
        success: result.is_ok(),
        error_message: result.as_ref().err().cloned(),
        metadata: None,
    };
    if let Err(e) = db.log_model_call(audit).await {
        log::warn!("[Sense] 记模型审计失败: {e}");
    }
    match result {
        // 只取第一行；模型偶尔会带编号或「-」，去掉
        Ok((content, _, _)) => content
            .lines()
            .map(|l| l.trim().trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | '、' | '-' | ' ')).trim().to_string())
            .find(|l| !l.is_empty())
            .ok_or_else(|| "模型什么也没说".to_string()),
        Err(e) => Err(format!("调用失败：{e}")),
    }
}
