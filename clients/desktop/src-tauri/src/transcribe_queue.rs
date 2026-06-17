// ══════════════════════════════════════════════
// 转录队列 — 把"音频转录"搬到后端做成并发队列
//
// 动机：转录原本是前端面板驱动的，关掉界面就停了。搬到后端后：
//   - 关界面/切页都继续跑（像下载一样后端常驻）
//   - 并发（默认 3 路），支持批量一次点多个
//   - 复用现有 Rust 命令链：qwen_audio_extract → qwen_video_upload → qwen_asr_filetrans → 落库
//   - 进度通过 tauri 事件 'bili-transcribe-progress'（按 bvid 区分）推给前端
// ══════════════════════════════════════════════

use std::collections::VecDeque;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::db::Database;

const ASR_MODEL: &str = "qwen3-asr-flash-filetrans";
const MAX_TRANSCRIBE_WORKERS: usize = 3;

#[derive(Clone)]
struct TranscribeJob {
    bvid: String,
    file_path: String,
    api_key: String,
}

#[derive(Serialize, Clone)]
struct TranscribeProgress {
    bvid: String,
    file_path: String,
    /// queued | extracting | uploading | transcribing | done | error
    stage: String,
    message: Option<String>,
    queue_position: Option<usize>,
}

struct QueueInner {
    jobs: VecDeque<TranscribeJob>,
    active: usize,
}

pub struct TranscribeQueueState {
    inner: Mutex<QueueInner>,
    db: Mutex<Option<Arc<Database>>>,
}

impl TranscribeQueueState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(QueueInner { jobs: VecDeque::new(), active: 0 }),
            db: Mutex::new(None),
        }
    }
    pub async fn set_db(&self, db: Arc<Database>) {
        *self.db.lock().await = Some(db);
    }
    async fn db(&self) -> Option<Arc<Database>> {
        self.db.lock().await.clone()
    }
}

fn emit_progress(app: &AppHandle, p: TranscribeProgress) {
    let _ = app.emit("bili-transcribe-progress", p);
}

fn progress(bvid: &str, file_path: &str, stage: &str, message: Option<String>) -> TranscribeProgress {
    TranscribeProgress {
        bvid: bvid.to_string(),
        file_path: file_path.to_string(),
        stage: stage.to_string(),
        message,
        queue_position: None,
    }
}

/// 入队一个转录任务。立即返回；后台并发执行，关界面也继续。
#[tauri::command]
pub async fn enqueue_transcribe(
    bvid: String,
    file_path: String,
    api_key: String,
    app: AppHandle,
    state: tauri::State<'_, Arc<TranscribeQueueState>>,
) -> Result<(), String> {
    if file_path.trim().is_empty() {
        return Err("file_path 为空".into());
    }
    if api_key.trim().is_empty() {
        return Err("缺少 API Key".into());
    }
    let job = TranscribeJob { bvid: bvid.clone(), file_path: file_path.clone(), api_key };

    // 单锁内：入队 + 决定是否拉新 worker（与 worker 的"取空即退出"互斥，避免任务搁浅）
    let (position, spawn) = {
        let mut g = state.inner.lock().await;
        g.jobs.push_back(job);
        let position = g.jobs.len();
        let spawn = g.active < MAX_TRANSCRIBE_WORKERS;
        if spawn {
            g.active += 1;
        }
        (position, spawn)
    };

    emit_progress(
        &app,
        TranscribeProgress {
            bvid,
            file_path,
            stage: "queued".into(),
            message: Some(format!("排队 #{}", position)),
            queue_position: Some(position),
        },
    );

    if spawn {
        let st = state.inner().clone();
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            transcribe_worker(st, app2).await;
        });
    }
    Ok(())
}

async fn transcribe_worker(state: Arc<TranscribeQueueState>, app: AppHandle) {
    loop {
        let job = {
            let mut g = state.inner.lock().await;
            match g.jobs.pop_front() {
                Some(j) => j,
                None => {
                    g.active -= 1;
                    return;
                }
            }
        };
        log::info!("[Transcribe] 开始转录 {}", job.bvid);
        if let Err(e) = run_transcribe_job(&state, &app, &job).await {
            log::warn!("[Transcribe] 失败 {}: {}", job.bvid, e);
            emit_progress(&app, progress(&job.bvid, &job.file_path, "error", Some(e)));
        }
    }
}

async fn run_transcribe_job(
    state: &TranscribeQueueState,
    app: &AppHandle,
    job: &TranscribeJob,
) -> Result<(), String> {
    // 1) 提取音轨（命中下载保留的 <stem>_audio.m4a 缓存则秒回）
    emit_progress(app, progress(&job.bvid, &job.file_path, "extracting", None));
    let audio = crate::qwen_video::qwen_audio_extract(job.file_path.clone(), app.clone()).await?;

    // 2) 上传 OSS
    emit_progress(app, progress(&job.bvid, &job.file_path, "uploading", None));
    let oss = crate::qwen_video::qwen_video_upload(job.api_key.clone(), ASR_MODEL.to_string(), audio).await?;

    // 3) ASR 文件转录（后端轮询，关界面也不影响）
    emit_progress(app, progress(&job.bvid, &job.file_path, "transcribing", None));
    let res = crate::qwen_asr::qwen_asr_filetrans(
        oss,
        job.api_key.clone(),
        Some(ASR_MODEL.to_string()),
        Some("zh".to_string()),
        Some(true),
        Some(1500),
        Some(900),
    )
    .await?;
    let text = res.jsonl.trim().to_string();
    if text.is_empty() {
        return Err("ASR 返回为空或无句级时间戳".into());
    }

    // 4) 落库（kind=audio，与单条面板同表同命令）
    if let Some(db) = state.db().await {
        db.update_bili_transcript_by_path(
            &job.file_path,
            "audio",
            &text,
            Some(ASR_MODEL.to_string()),
            Some("asr".to_string()),
            Some("asr_filetrans_batch".to_string()),
            true,
        )
        .await?;
    }

    log::info!("[Transcribe] 完成 {}", job.bvid);
    emit_progress(app, progress(&job.bvid, &job.file_path, "done", None));
    Ok(())
}
