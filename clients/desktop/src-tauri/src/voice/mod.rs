// ══════════════════════════════════════════════
// 语音输入会话（按住说话）——借鉴 Claude Code hooks/useVoice.ts 的结构
//
//   按下 voice_start ─┬─ 原生录音线程（capture）：立刻开麦，100 ms 一块
//                     └─ 流式识别连接（asr_stream）：并行建连，就绪前的音频先缓冲
//   说话中            → voice://partial（边说边出字）、voice://level（音量给 Fairy 动画）
//   松开 voice_stop   → 多录 250 ms 尾巴 → finish-task → 定稿全文 + 录音 WAV + 用量 + 各段耗时
//
// 失败兜底（「绝不丢掉用户说的话」）：
//   · 出第一个字之前识别连接出错 → 换新连接，重放已录全部音频（至多再试一次）
//   · 录到了声音、识别却一个字都没回 → 同样重放一次
//   · 两次都失败 → 用批量识别（qwen3-asr-flash-realtime）把整段录音再转一遍
// 隐私：只在按住期间开麦；最长 90 秒自动停止，防止按键抬起事件丢失后麦克风一直开着。
// ══════════════════════════════════════════════

pub mod asr_stream;
mod capture;
mod resample;

use std::sync::atomic::{AtomicU64, Ordering};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc::unbounded_channel, oneshot, Mutex};
use tokio::time::{timeout, Duration, Instant};

use asr_stream::{AsrConfig, AsrInput, AsrOutput, AsrUsage, ContextTurn};
use capture::{CaptureEvent, TARGET_RATE};

const MAX_RECORD: Duration = Duration::from_secs(90);
const MAX_ATTEMPTS: u32 = 2;
/// 录音结束后等识别收尾的上限（识别任务自身另有 8 秒收尾超时）
const FINALIZE_TIMEOUT: Duration = Duration::from_secs(12);
/// voice_stop 等整个会话出结果的上限（含兜底批量识别）
const STOP_TIMEOUT: Duration = Duration::from_secs(40);
const FALLBACK_TIMEOUT: Duration = Duration::from_secs(20);
/// 一块音频 RMS 超过它就算「有人在说话」
const SPEECH_LEVEL: f32 = 0.015; // 笔记本麦克风阵列安静时底噪约 0.008
/// 回放重放时每帧 3200 字节（100 ms）
const REPLAY_FRAME_SAMPLES: usize = 1_600;
const GENERIC_ENDPOINT: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const FALLBACK_ENDPOINT: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const FALLBACK_MODEL: &str = "qwen3-asr-flash-realtime";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartRequest {
    pub api_key: String,
    pub model: String,
    /// 百炼业务空间 ID：配了就优先走专属域名，连不上再回退通用域名
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub vocabulary: Vec<String>,
    #[serde(default)]
    pub context: Vec<ContextTurn>,
    #[serde(default)]
    pub language_hints: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTimings {
    pub mic_open_ms: Option<u64>,
    pub asr_connect_ms: Option<u64>,
    pub asr_start_ms: Option<u64>,
    pub first_partial_ms: Option<u64>,
    /// 松手 → 拿到定稿
    pub finalize_ms: Option<u64>,
    pub total_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceResult {
    pub session: u64,
    pub text: String,
    pub wav_base64: String,
    pub duration_ms: u64,
    pub had_speech: bool,
    pub model: String,
    pub usage: Option<AsrUsage>,
    pub attempts: u32,
    /// 流式识别两次都失败，改用批量识别得到的结果
    pub fallback: bool,
    pub device: Option<String>,
    pub timings: VoiceTimings,
}

struct Active {
    stop_tx: Option<oneshot::Sender<()>>,
    cancel_tx: Option<oneshot::Sender<()>>,
    result_rx: oneshot::Receiver<Result<VoiceResult, String>>,
}

impl Active {
    fn cancel(mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Default)]
pub struct VoiceState {
    active: Mutex<Option<Active>>,
    seq: AtomicU64,
}

// ── Tauri 命令 ──

/// 开始一次按住说话：立即返回会话号，开麦 / 建连在后台进行（就绪时发 voice://ready）
#[tauri::command]
pub async fn voice_start(
    app: AppHandle,
    state: State<'_, VoiceState>,
    req: VoiceStartRequest,
) -> Result<u64, String> {
    if req.api_key.trim().is_empty() {
        return Err("未配置百炼 API Key，无法语音识别".to_string());
    }
    let mut guard = state.active.lock().await;
    if let Some(old) = guard.take() {
        old.cancel(); // 快速连按 / 上一轮没收尾：旧会话作废
    }
    let session = state.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let (stop_tx, stop_rx) = oneshot::channel();
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (result_tx, result_rx) = oneshot::channel();
    tokio::spawn(async move {
        let result = run_session(&app, session, req, stop_rx, cancel_rx).await;
        if let Err(e) = &result {
            log::warn!("[Voice] 会话#{session} 失败: {e}");
        }
        let _ = result_tx.send(result);
    });
    *guard = Some(Active { stop_tx: Some(stop_tx), cancel_tx: Some(cancel_tx), result_rx });
    Ok(session)
}

/// 松手：停止录音并等待定稿
#[tauri::command]
pub async fn voice_stop(state: State<'_, VoiceState>) -> Result<VoiceResult, String> {
    let mut active = state.active.lock().await.take().ok_or("当前没有进行中的录音")?;
    if let Some(tx) = active.stop_tx.take() {
        let _ = tx.send(());
    }
    match timeout(STOP_TIMEOUT, &mut active.result_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("录音会话意外结束".to_string()),
        Err(_) => {
            active.cancel();
            Err("语音识别超时，请重试".to_string())
        }
    }
}

/// 放弃本次录音（误触、按了取消键）
#[tauri::command]
pub async fn voice_cancel(state: State<'_, VoiceState>) -> Result<(), String> {
    if let Some(active) = state.active.lock().await.take() {
        active.cancel();
    }
    Ok(())
}

// ── 会话编排 ──

fn endpoints(workspace_id: Option<&str>) -> Vec<String> {
    let mut list = Vec::new();
    if let Some(id) = workspace_id.map(str::trim).filter(|id| {
        !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    }) {
        list.push(format!("wss://{id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"));
    }
    list.push(GENERIC_ENDPOINT.to_string());
    list
}

fn pcm_bytes(pcm: &[i16]) -> Vec<u8> {
    pcm.iter().flat_map(|s| s.to_le_bytes()).collect()
}

fn joined(finals: &[String], partial: &str) -> String {
    let mut s = finals.concat();
    s.push_str(partial);
    s.trim().to_string()
}

fn replay(tx: &tokio::sync::mpsc::UnboundedSender<AsrInput>, pcm: &[i16], finish: bool) {
    for frame in pcm.chunks(REPLAY_FRAME_SAMPLES) {
        let _ = tx.send(AsrInput::Audio(pcm_bytes(frame)));
    }
    if finish {
        let _ = tx.send(AsrInput::Finish);
    }
}

fn ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

async fn sleep_until_opt(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

async fn run_session(
    app: &AppHandle,
    session: u64,
    req: VoiceStartRequest,
    mut stop_rx: oneshot::Receiver<()>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<VoiceResult, String> {
    let t0 = Instant::now();
    let (cap_tx, mut cap_rx) = unbounded_channel();
    let capture = capture::start(cap_tx);

    let cfg = AsrConfig {
        api_key: req.api_key.clone(),
        model: req.model.clone(),
        endpoints: endpoints(req.workspace_id.as_deref()),
        vocabulary: req.vocabulary.clone(),
        context: req.context.clone(),
        language_hints: req.language_hints.clone(),
    };
    let (mut asr_tx, mut asr_rx) = asr_stream::spawn(cfg.clone());
    let mut attempts = 1u32;

    let mut audio: Vec<i16> = Vec::new();
    let mut finals: Vec<String> = Vec::new();
    let mut partial = String::new();
    let mut usage: Option<AsrUsage> = None;
    let mut had_speech = false;
    let mut device: Option<String> = None;
    let mut timings = VoiceTimings::default();
    let mut capture_error: Option<String> = None;
    let mut asr_error: Option<String> = None;
    let mut stopping = false;
    let mut stop_at: Option<Instant> = None;
    let mut capture_done = false;
    let mut asr_done = false;
    let mut finalize_deadline: Option<Instant> = None;
    let record_deadline = t0 + MAX_RECORD;

    while !(capture_done && asr_done) {
        tokio::select! {
            _ = &mut cancel_rx => {
                capture.request_stop();
                return Err("已取消".to_string());
            }
            _ = &mut stop_rx, if !stopping => {
                stopping = true;
                stop_at = Some(Instant::now());
                capture.request_stop();
            }
            _ = tokio::time::sleep_until(record_deadline), if !stopping => {
                stopping = true;
                stop_at = Some(Instant::now());
                capture.request_stop();
                log::warn!("[Voice] 会话#{session} 录音超过 {} 秒，自动停止", MAX_RECORD.as_secs());
                let _ = app.emit("voice://auto_stop", json!({ "session": session }));
            }
            ev = cap_rx.recv(), if !capture_done => match ev {
                Some(CaptureEvent::Ready(info)) => {
                    timings.mic_open_ms = Some(ms(t0));
                    log::info!(
                        "[Voice] 会话#{session} 麦克风就绪 {}ms（线程内 {}ms）: {} {}Hz {}ch {}",
                        ms(t0), info.open_ms, info.device, info.sample_rate, info.channels, info.format
                    );
                    let _ = app.emit("voice://ready", json!({ "session": session, "device": info.device }));
                    device = Some(info.device);
                }
                Some(CaptureEvent::Chunk { pcm, level }) => {
                    had_speech |= level > SPEECH_LEVEL;
                    let _ = app.emit("voice://level", json!({ "session": session, "level": level }));
                    let _ = asr_tx.send(AsrInput::Audio(pcm_bytes(&pcm)));
                    audio.extend_from_slice(&pcm);
                }
                Some(CaptureEvent::Error(e)) => {
                    log::error!("[Voice] 会话#{session} 录音出错: {e}");
                    capture.request_stop();
                    stopping = true;
                    stop_at.get_or_insert_with(Instant::now);
                    capture_error = Some(e);
                }
                None => {
                    capture_done = true;
                    if audio.is_empty() {
                        return Err(capture_error.unwrap_or_else(|| "没有录到声音：麦克风没有数据".to_string()));
                    }
                    let _ = asr_tx.send(AsrInput::Finish);
                    finalize_deadline = Some(Instant::now() + FINALIZE_TIMEOUT);
                }
            },
            out = asr_rx.recv(), if !asr_done => match out {
                Some(AsrOutput::Started { connect_ms, start_ms }) => {
                    timings.asr_connect_ms.get_or_insert(connect_ms);
                    timings.asr_start_ms.get_or_insert(start_ms);
                }
                Some(AsrOutput::Partial(text)) => {
                    if !text.is_empty() && timings.first_partial_ms.is_none() {
                        timings.first_partial_ms = Some(ms(t0));
                    }
                    partial = text;
                    let _ = app.emit("voice://partial", json!({ "session": session, "text": joined(&finals, &partial) }));
                }
                Some(AsrOutput::Final { text, usage: u }) => {
                    finals.push(text);
                    partial.clear();
                    if u.is_some() {
                        usage = u; // 服务端给的是本任务累计用量
                    }
                    let _ = app.emit("voice://partial", json!({ "session": session, "text": joined(&finals, "") }));
                }
                Some(AsrOutput::Finished) => {
                    let silent_drop = joined(&finals, &partial).is_empty() && had_speech;
                    if capture_done && silent_drop && attempts < MAX_ATTEMPTS {
                        attempts += 1;
                        log::warn!("[Voice] 会话#{session} 有声音却没识别出字，重放整段音频重试");
                        (asr_tx, asr_rx) = asr_stream::spawn(cfg.clone());
                        replay(&asr_tx, &audio, true);
                    } else if capture_done {
                        asr_done = true;
                    } else {
                        // 还在录音，服务端却先结束了：当作连接失败处理
                        asr_error = Some("识别服务提前结束了任务".to_string());
                        if attempts < MAX_ATTEMPTS {
                            attempts += 1;
                            (asr_tx, asr_rx) = asr_stream::spawn(cfg.clone());
                            replay(&asr_tx, &audio, false);
                        } else {
                            asr_done = true;
                        }
                    }
                }
                Some(AsrOutput::Failed { message, retryable }) => {
                    log::warn!("[Voice] 会话#{session} 第 {attempts} 次识别失败: {message}");
                    let nothing_yet = joined(&finals, &partial).is_empty();
                    if retryable && nothing_yet && attempts < MAX_ATTEMPTS {
                        attempts += 1;
                        (asr_tx, asr_rx) = asr_stream::spawn(cfg.clone());
                        replay(&asr_tx, &audio, capture_done);
                    } else {
                        asr_error = Some(message);
                        asr_done = true;
                    }
                }
                None => {
                    asr_error.get_or_insert_with(|| "识别连接意外结束".to_string());
                    asr_done = true;
                }
            },
            _ = sleep_until_opt(finalize_deadline) => {
                asr_error.get_or_insert_with(|| "识别收尾超时".to_string());
                asr_done = true;
            }
        }
    }
    drop(asr_tx); // 关掉仍在进行的识别连接

    let mut text = joined(&finals, &partial);
    let mut fallback = false;
    if text.is_empty() && had_speech {
        if let Some(err) = &asr_error {
            log::warn!("[Voice] 会话#{session} 流式识别失败（{err}），改用批量识别兜底");
            match timeout(
                FALLBACK_TIMEOUT,
                crate::qwen_asr::transcribe_pcm16(&pcm_bytes(&audio), &req.api_key, FALLBACK_MODEL, FALLBACK_ENDPOINT),
            )
            .await
            {
                Ok(Ok(t)) => {
                    text = t.trim().to_string();
                    fallback = true;
                }
                Ok(Err(e)) => return Err(format!("{err}；批量识别兜底也失败：{e}")),
                Err(_) => return Err(format!("{err}；批量识别兜底超时")),
            }
        }
    }

    timings.finalize_ms = stop_at.map(ms);
    timings.total_ms = ms(t0);
    let duration_ms = audio.len() as u64 * 1_000 / TARGET_RATE as u64;
    log::info!(
        "[Voice] 会话#{session} 完成：录音 {duration_ms}ms，开麦 {:?}ms，识别就绪 {:?}ms，首字 {:?}ms，松手到定稿 {:?}ms，尝试 {attempts} 次{}，{} 字",
        timings.mic_open_ms, timings.asr_start_ms, timings.first_partial_ms, timings.finalize_ms,
        if fallback { "（批量兜底）" } else { "" },
        text.chars().count()
    );

    Ok(VoiceResult {
        session,
        text,
        wav_base64: STANDARD.encode(wav_bytes(&audio)),
        duration_ms,
        had_speech,
        model: if fallback { FALLBACK_MODEL.to_string() } else { req.model },
        usage: if fallback { None } else { usage },
        attempts,
        fallback,
        device,
        timings,
    })
}

/// 16 kHz 单声道 PCM16 → WAV（给用户语音气泡回放）
fn wav_bytes(pcm: &[i16]) -> Vec<u8> {
    let data_len = (pcm.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    out.extend_from_slice(&TARGET_RATE.to_le_bytes());
    out.extend_from_slice(&(TARGET_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(&pcm_bytes(pcm));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_prefer_valid_workspace_then_generic() {
        assert_eq!(endpoints(None), vec![GENERIC_ENDPOINT.to_string()]);
        assert_eq!(endpoints(Some("  ")), vec![GENERIC_ENDPOINT.to_string()]);
        let e = endpoints(Some("ws-abc123"));
        assert_eq!(e[0], "wss://ws-abc123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference");
        assert_eq!(e[1], GENERIC_ENDPOINT);
        // 非法字符（防止拼进 URL）直接忽略
        assert_eq!(endpoints(Some("evil.com/x?")), vec![GENERIC_ENDPOINT.to_string()]);
    }

    #[test]
    fn wav_header_is_valid() {
        let pcm = vec![0i16, 1000, -1000];
        let wav = wav_bytes(&pcm);
        assert_eq!(wav.len(), 44 + 6);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 6);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(i16::from_le_bytes([wav[46], wav[47]]), 1000);
    }

    #[test]
    fn joins_finals_and_partial() {
        let finals = vec!["今天好累。".to_string(), "但是".to_string()];
        assert_eq!(joined(&finals, "还想学习"), "今天好累。但是还想学习");
        assert_eq!(joined(&[], "  "), "");
    }
}
