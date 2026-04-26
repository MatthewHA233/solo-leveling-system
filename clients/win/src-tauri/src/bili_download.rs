// ══════════════════════════════════════════════
// B 站视频下载器
// 流程：
//   1. enqueue_bili_download 命令 → 推入队列，启动 worker
//   2. worker 从 bili-login WebView 注入 JS 拿 playurl JSON（绕过 WBI 签名，
//      由浏览器同源 + cookies 处理）
//   3. axum 路由 POST /api/bilibili/playurl_result 把结果转发回 worker
//   4. reqwest 下载 video.m4s + audio.m4s（带 Referer / UA）
//   5. ffmpeg 合并为 mp4
// 进度通过 emit("bili-download-progress", DownloadProgress) 推送给前端
// ══════════════════════════════════════════════

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, Mutex};

use crate::db::Database;

const BILI_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const META_TIMEOUT_SECS: u64 = 30;

// ── 类型 ──

#[derive(Clone, Debug, Serialize)]
pub struct DownloadProgress {
    pub bvid: String,
    pub stage: String, // queued | fetching_meta | downloading_video | downloading_audio | merging | done | error
    pub percent: f32,
    pub message: Option<String>,
    pub output_path: Option<String>,
    pub queue_position: Option<usize>,
}

/// 探测一个视频可用的清晰度 qn 列表
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct QualityProbe {
    pub bvid: String,
    /// 该视频 dash.video 列表里出现过的所有 qn，去重后从高到低
    pub qns: Vec<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PlayUrlMeta {
    pub bvid: String,
    pub cid: i64,
    pub title: Option<String>,
    pub video_url: String,
    pub audio_url: String,
    /// playurl 返回的 backup_url 列表（已包含主链接）
    #[serde(default)]
    pub video_urls: Vec<String>,
    #[serde(default)]
    pub audio_urls: Vec<String>,
    pub video_qn: Option<i64>,
    pub video_codecs: Option<String>,
    pub audio_codecs: Option<String>,
}

/// 已知的快镜像 host 优先级（数字越小越优先）。
/// 排在前面的镜像通常是阿里云/华为云/百度云的 CDN，
/// 排在后面的（cosov / cosovbv 等腾讯云对象存储分流）经常被限速到 ~300KB/s。
fn host_score(host: &str) -> i32 {
    // mcdn / pcdn 一般是 P2P 加速节点，优先级最高
    if host.contains(".mcdn.bilivideo.cn") { return 0; }
    if host.contains(".szbdyd.com")        { return 1; } // 鹏博士
    // 主流云镜像（速度普遍 5MB/s 以上）
    if host.contains("upos-sz-mirrorali")    { return 10; } // 阿里云
    if host.contains("upos-sz-mirrorhw")     { return 11; } // 华为云
    if host.contains("upos-sz-mirror08c")    { return 12; }
    if host.contains("upos-sz-mirrorbd")     { return 13; } // 百度云
    if host.contains("upos-sz-mirrorks")     { return 14; } // 金山云
    if host.contains("upos-sz-estgoss")      { return 15; }
    if host.contains("upos-sz-mirror08h")    { return 16; }
    // 通用 upos
    if host.contains("upos-sz-")             { return 30; }
    // 腾讯云对象存储分流（cos / cosov / cosovbv），公认慢
    if host.contains("cosov")                { return 90; }
    if host.contains("upos-hz-")             { return 60; }
    50
}

fn replace_host(url: &str, new_host: &str) -> String {
    if let Ok(mut u) = url::Url::parse(url) {
        let _ = u.set_host(Some(new_host));
        return u.to_string();
    }
    url.to_string()
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

/// 给 playurl 返回的链接做 host 重排：
///   - 收集所有 backup_url + base_url 中的 host
///   - 按 host_score 排序后，每个 host 都用 base_url 的 path 重新拼出来
///   - 这样能保证 path 一定是合法的（避免某些 backup_url path 不一致）
fn rank_urls(urls: &[String]) -> Vec<String> {
    if urls.is_empty() { return vec![]; }
    let primary = &urls[0];

    // 候选 host：所有 url 提取 host，去重，按 score 排序
    let mut hosts: Vec<String> = urls.iter()
        .map(|u| host_of(u))
        .filter(|h| !h.is_empty())
        .collect();
    hosts.sort();
    hosts.dedup();
    hosts.sort_by_key(|h| host_score(h));

    // 用 primary 的 path/query 替换 host，得到候选下载链接
    let mut out: Vec<String> = hosts.iter()
        .map(|h| replace_host(primary, h))
        .collect();

    // 兜底：把原始 url 列表追加（防止 path 不同时漏链接）
    for u in urls {
        if !out.iter().any(|x| x == u) {
            out.push(u.clone());
        }
    }
    out
}

#[derive(Debug)]
struct DownloadJob {
    bvid: String,
    save_dir: PathBuf,
    /// 画质偏好 'auto' | '4k' | '1080p_plus' | '1080p' | '720p' | '480p'
    quality: String,
    /// bili_video_assets.id —— 用于在生命周期里更新资产表
    asset_id: Option<String>,
}

/// 把字符串 quality 转成 (qn 请求值, 上限 id) — 上限用于过滤 dash.video
fn quality_to_qn(q: &str) -> (i64, i64) {
    match q {
        "4k"         => (120, 120),
        "1080p_plus" => (112, 112),
        "1080p"      => (80,  80),
        "720p"       => (64,  64),
        "480p"       => (32,  32),
        _            => (127, 127), // auto：请求最高，过滤上限不限
    }
}

pub struct BiliDownloadState {
    queue: Mutex<VecDeque<DownloadJob>>,
    pending_meta: Mutex<Option<oneshot::Sender<Result<PlayUrlMeta, String>>>>,
    /// 探测可用清晰度的回调通道（与 pending_meta 独立，避免互相打架）
    pending_probe: Mutex<Option<oneshot::Sender<Result<QualityProbe, String>>>>,
    worker_running: Mutex<bool>,
    /// 可选的 DB 句柄（用于写资产表）；启动时未初始化也不致命
    db: Mutex<Option<Arc<Database>>>,
}

impl BiliDownloadState {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            pending_meta: Mutex::new(None),
            pending_probe: Mutex::new(None),
            worker_running: Mutex::new(false),
            db: Mutex::new(None),
        }
    }

    pub async fn set_db(&self, db: Arc<Database>) {
        let mut g = self.db.lock().await;
        *g = Some(db);
    }

    async fn db(&self) -> Option<Arc<Database>> {
        self.db.lock().await.clone()
    }
}

// ── Tauri 命令：入队 ──

#[tauri::command]
pub async fn enqueue_bili_download(
    bvid: String,
    save_dir: String,
    quality: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, Arc<BiliDownloadState>>,
) -> Result<(), String> {
    if bvid.is_empty() {
        return Err("bvid 为空".into());
    }
    let save_dir_pb = PathBuf::from(&save_dir);
    if save_dir.trim().is_empty() {
        return Err("下载目录未配置".into());
    }
    let quality = quality.unwrap_or_else(|| "auto".to_string());

    // 写资产表（一次下载 = 一条记录）
    let asset_id: Option<String> = if let Some(db) = state.db().await {
        match db.create_bili_asset(&bvid, Some(&quality)).await {
            Ok(id) => {
                log::info!("[BiliDL] 创建资产记录 {} for {}", id, bvid);
                Some(id)
            }
            Err(e) => {
                log::warn!("[BiliDL] 创建资产记录失败 {}: {}", bvid, e);
                None
            }
        }
    } else {
        None
    };

    let job = DownloadJob {
        bvid: bvid.clone(),
        save_dir: save_dir_pb,
        quality,
        asset_id,
    };

    let position = {
        let mut q = state.queue.lock().await;
        q.push_back(job);
        q.len()
    };

    let _ = app.emit(
        "bili-download-progress",
        DownloadProgress {
            bvid: bvid.clone(),
            stage: "queued".into(),
            percent: 0.0,
            message: Some(format!("队列位置 #{}", position)),
            output_path: None,
            queue_position: Some(position),
        },
    );

    // 确保 worker 在跑
    let mut running = state.worker_running.lock().await;
    if !*running {
        *running = true;
        drop(running);
        let st = state.inner().clone();
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            worker_loop(st, app_clone).await;
        });
    }

    Ok(())
}

// ── 由 axum 路由调用：playurl 回调 ──

pub async fn deliver_playurl_result(
    state: &BiliDownloadState,
    result: Result<PlayUrlMeta, String>,
) {
    let mut guard = state.pending_meta.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(result);
    }
}

pub async fn deliver_probe_result(
    state: &BiliDownloadState,
    result: Result<QualityProbe, String>,
) {
    let mut guard = state.pending_probe.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(result);
    }
}

// ── Tauri 命令：探测视频可用清晰度 ──
//
// 不下载，只发起一次 playurl(qn=127) 拿 dash.video[].id 列表
// 失败时返回空列表（前端可回退到展示全部选项）

#[tauri::command]
pub async fn probe_bili_qualities(
    bvid: String,
    app: AppHandle,
    state: tauri::State<'_, Arc<BiliDownloadState>>,
) -> Result<Vec<i64>, String> {
    if bvid.is_empty() {
        return Err("bvid 为空".into());
    }

    let win = app
        .get_webview_window("bili-login")
        .ok_or_else(|| "bili-login WebView 未打开".to_string())?;

    let (tx, rx) = oneshot::channel::<Result<QualityProbe, String>>();
    {
        let mut guard = state.pending_probe.lock().await;
        *guard = Some(tx);
    }

    let js = format!(
        r#"(async()=>{{
  const BV='{bvid}';
  const post=(body)=>fetch('http://localhost:3000/api/bilibili/qualities_result',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(body)}});
  try {{
    const r1=await fetch('https://api.bilibili.com/x/player/pagelist?bvid='+BV,{{credentials:'include'}});
    const d1=await r1.json();
    if(d1.code!==0) throw new Error('pagelist '+d1.code+': '+(d1.message||''));
    const part=d1.data&&d1.data[0];
    if(!part) throw new Error('无分 P 数据');
    const cid=part.cid;
    const url='https://api.bilibili.com/x/player/playurl?bvid='+BV+'&cid='+cid+'&qn=127&fnval=4048&fourk=1';
    const r2=await fetch(url,{{credentials:'include'}});
    const d2=await r2.json();
    if(d2.code!==0) throw new Error('playurl '+d2.code+': '+(d2.message||''));
    const dash=d2.data&&d2.data.dash;
    if(!dash||!dash.video) throw new Error('无 DASH 视频流');
    const qns=[...new Set(dash.video.map(v=>v.id))].sort((a,b)=>b-a);
    await post({{ok:{{bvid:BV,qns}}}});
  }} catch(e) {{
    await post({{error:String(e&&e.message||e)}});
  }}
}})();"#
    );

    win.eval(&js).map_err(|e| format!("JS 注入失败: {}", e))?;

    match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(Ok(probe))) => Ok(probe.qns),
        Ok(Ok(Err(e))) => Err(format!("探测失败: {}", e)),
        Ok(Err(_)) => Err("探测通道关闭".into()),
        Err(_) => Err("探测请求超时".into()),
    }
}

// ── 内部 worker ──

async fn worker_loop(state: Arc<BiliDownloadState>, app: AppHandle) {
    loop {
        let job = {
            let mut q = state.queue.lock().await;
            q.pop_front()
        };
        let job = match job {
            Some(j) => j,
            None => {
                let mut running = state.worker_running.lock().await;
                *running = false;
                log::info!("[BiliDL] 队列空，worker 退出");
                return;
            }
        };

        log::info!("[BiliDL] 开始下载 {}", job.bvid);
        if let Err(e) = process_job(&state, &app, &job).await {
            log::warn!("[BiliDL] 任务失败 {}: {}", job.bvid, e);
            emit_error(&app, &job.bvid, &e);
            if let (Some(asset_id), Some(db)) = (job.asset_id.as_ref(), state.db().await) {
                let _ = db.fail_bili_asset(asset_id, &e).await;
            }
        }
    }
}

async fn process_job(
    state: &BiliDownloadState,
    app: &AppHandle,
    job: &DownloadJob,
) -> Result<(), String> {
    // 1. 拿 playurl
    let (qn_request, max_id) = quality_to_qn(&job.quality);
    emit_stage(
        app,
        &job.bvid,
        "fetching_meta",
        0.0,
        Some(&format!("解析视频流（画质偏好 {}）...", job.quality)),
    );

    let meta = fetch_playurl_via_webview(state, app, &job.bvid, qn_request, max_id).await?;
    log::info!(
        "[BiliDL] {} 选中画质 qn={} (请求 {}, 上限 {})",
        job.bvid,
        meta.video_qn.unwrap_or(0),
        qn_request,
        max_id
    );

    // DB：标记 downloading + started_at
    if let (Some(asset_id), Some(db)) = (job.asset_id.as_ref(), state.db().await) {
        let _ = db.update_bili_asset_status(asset_id, "downloading", true).await;
    }

    // 2. 准备临时目录
    let temp_dir = std::env::temp_dir().join(format!("bili-dl-{}", &job.bvid));
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("创建临时目录失败: {}", e))?;
    let video_path = temp_dir.join("video.m4s");
    let audio_path = temp_dir.join("audio.m4s");

    // 候选 URL：把 backup_url 也算进来，按 host 速度排序
    let video_candidates = {
        let mut v = if meta.video_urls.is_empty() {
            vec![meta.video_url.clone()]
        } else {
            meta.video_urls.clone()
        };
        if !v.iter().any(|u| u == &meta.video_url) && !meta.video_url.is_empty() {
            v.insert(0, meta.video_url.clone());
        }
        rank_urls(&v)
    };
    let audio_candidates = {
        let mut a = if meta.audio_urls.is_empty() {
            vec![meta.audio_url.clone()]
        } else {
            meta.audio_urls.clone()
        };
        if !a.iter().any(|u| u == &meta.audio_url) && !meta.audio_url.is_empty() {
            a.insert(0, meta.audio_url.clone());
        }
        rank_urls(&a)
    };

    log::info!(
        "[BiliDL] {} 视频候选 {} 个，首选 host: {}",
        job.bvid,
        video_candidates.len(),
        video_candidates.first().map(|u| host_of(u)).unwrap_or_default()
    );

    // 3. 下载视频流
    download_with_fallback(
        &video_candidates,
        &video_path,
        &job.bvid,
        "downloading_video",
        app,
    )
    .await?;

    // 4. 下载音频流
    download_with_fallback(
        &audio_candidates,
        &audio_path,
        &job.bvid,
        "downloading_audio",
        app,
    )
    .await?;

    // 5. 合并
    tokio::fs::create_dir_all(&job.save_dir)
        .await
        .map_err(|e| format!("创建保存目录失败: {}", e))?;

    let title = meta
        .title
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&job.bvid);
    let safe = sanitize_filename(title);
    let out_name = format!("{}_{}.mp4", safe, job.bvid);
    let out_path = job.save_dir.join(&out_name);

    emit_stage(app, &job.bvid, "merging", 0.0, Some("ffmpeg 合并..."));

    merge_with_ffmpeg(&video_path, &audio_path, &out_path).await?;

    // 6. 清理
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;

    let out_str = out_path.to_string_lossy().to_string();
    log::info!("[BiliDL] 完成 {} → {}", job.bvid, out_str);

    // DB：写完成记录
    if let (Some(asset_id), Some(db)) = (job.asset_id.as_ref(), state.db().await) {
        let file_size = tokio::fs::metadata(&out_path).await.ok().map(|m| m.len() as i64);
        let _ = db.complete_bili_asset(
            asset_id,
            &out_str,
            meta.video_qn,
            meta.video_codecs.as_deref(),
            meta.audio_codecs.as_deref(),
            file_size,
        ).await;
    }

    let _ = app.emit(
        "bili-download-progress",
        DownloadProgress {
            bvid: job.bvid.clone(),
            stage: "done".into(),
            percent: 100.0,
            message: Some(format!("已保存 {}", out_name)),
            output_path: Some(out_str),
            queue_position: None,
        },
    );

    Ok(())
}

// ── 通过 WebView 注入 JS 调 playurl ──

async fn fetch_playurl_via_webview(
    state: &BiliDownloadState,
    app: &AppHandle,
    bvid: &str,
    qn_request: i64,
    max_id: i64,
) -> Result<PlayUrlMeta, String> {
    let win = app
        .get_webview_window("bili-login")
        .ok_or_else(|| "bili-login WebView 未打开".to_string())?;

    let (tx, rx) = oneshot::channel::<Result<PlayUrlMeta, String>>();
    {
        let mut guard = state.pending_meta.lock().await;
        *guard = Some(tx);
    }

    // JS：拿 cid → 拿 playurl(DASH) → POST 回 localhost:3000
    // 把 base_url + backup_url[] 一起带回（让 Rust 端选 host）
    // qn_request 决定向 B 站请求的清晰度上限；max_id 在客户端再过滤一次（防止返回更高）
    let js = format!(
        r#"(async()=>{{
  const BV='{bvid}';
  const QN={qn_request};
  const MAX_ID={max_id};
  const post=(body)=>fetch('http://localhost:3000/api/bilibili/playurl_result',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(body)}});
  const collectUrls=(m)=>{{
    const arr=[m.baseUrl||m.base_url];
    const bk=m.backupUrl||m.backup_url||[];
    if(Array.isArray(bk)) for(const u of bk) arr.push(u);
    return arr.filter(Boolean);
  }};
  try {{
    const r1=await fetch('https://api.bilibili.com/x/player/pagelist?bvid='+BV,{{credentials:'include'}});
    const d1=await r1.json();
    if(d1.code!==0) throw new Error('pagelist '+d1.code+': '+(d1.message||''));
    const part=d1.data&&d1.data[0];
    if(!part) throw new Error('无分 P 数据');
    const cid=part.cid;
    const title=part.part||'';
    const url='https://api.bilibili.com/x/player/playurl?bvid='+BV+'&cid='+cid+'&qn='+QN+'&fnval=4048&fourk=1';
    const r2=await fetch(url,{{credentials:'include'}});
    const d2=await r2.json();
    if(d2.code!==0) throw new Error('playurl '+d2.code+': '+(d2.message||''));
    const dash=d2.data&&d2.data.dash;
    if(!dash||!dash.video||!dash.audio) throw new Error('无 DASH 流（可能为充电视频或受限）');
    // 先按上限过滤，挑最高一档；过滤后为空就回退到全部里挑最高
    const sortDesc=(a,b)=>(b.id-a.id)||(b.bandwidth-a.bandwidth);
    const filtered=[...dash.video].filter(v=>v.id<=MAX_ID).sort(sortDesc);
    const video=filtered[0]||[...dash.video].sort(sortDesc)[0];
    const audio=[...dash.audio].sort((a,b)=>b.bandwidth-a.bandwidth)[0];
    const video_urls=collectUrls(video);
    const audio_urls=collectUrls(audio);
    await post({{ok:{{
      bvid:BV,cid,title,
      video_url:video_urls[0]||'',audio_url:audio_urls[0]||'',
      video_urls,audio_urls,
      video_qn:video.id,video_codecs:video.codecs||'',audio_codecs:audio.codecs||''
    }}}});
  }} catch(e) {{
    await post({{error:String(e&&e.message||e)}});
  }}
}})();"#
    );

    win.eval(&js).map_err(|e| format!("JS 注入失败: {}", e))?;

    match tokio::time::timeout(Duration::from_secs(META_TIMEOUT_SECS), rx).await {
        Ok(Ok(Ok(meta))) => Ok(meta),
        Ok(Ok(Err(e))) => Err(format!("playurl 失败: {}", e)),
        Ok(Err(_)) => Err("playurl 通道关闭".into()),
        Err(_) => Err("playurl 请求超时".into()),
    }
}

// ── 带 host fallback 的下载 ──

async fn download_with_fallback(
    candidates: &[String],
    path: &Path,
    bvid: &str,
    stage: &str,
    app: &AppHandle,
) -> Result<(), String> {
    if candidates.is_empty() {
        return Err("无候选下载链接".into());
    }
    let mut last_err = String::new();
    for (i, url) in candidates.iter().enumerate() {
        let host = host_of(url);
        log::info!(
            "[BiliDL] {} {} 尝试 host #{} = {} (score={})",
            bvid, stage, i + 1, host, host_score(&host)
        );
        emit_stage(
            app, bvid, stage, 0.0,
            Some(&format!("尝试 {} ...", host)),
        );
        match download_with_progress(url, path, bvid, stage, app).await {
            Ok(()) => {
                log::info!("[BiliDL] {} {} 使用 host {} 下载成功", bvid, stage, host);
                return Ok(());
            }
            Err(e) => {
                log::warn!("[BiliDL] {} {} host {} 失败: {}", bvid, stage, host, e);
                last_err = format!("host {} 失败: {}", host, e);
                // 删掉残留 part 文件再换 host 重来
                let _ = tokio::fs::remove_file(path).await;
            }
        }
    }
    Err(format!("所有候选 host 均失败；最后错误: {}", last_err))
}

// ── 流式下载（单个 URL） ──

async fn download_with_progress(
    url: &str,
    path: &Path,
    bvid: &str,
    stage: &str,
    app: &AppHandle,
) -> Result<(), String> {
    let referer = format!("https://www.bilibili.com/video/{}", bvid);

    let client = reqwest::Client::builder()
        .user_agent(BILI_UA)
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(60 * 30))
        .build()
        .map_err(|e| format!("client 构造失败: {}", e))?;

    let resp = client
        .get(url)
        .header("Referer", &referer)
        .header("Origin", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|e| format!("创建文件失败: {}", e))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut speed_check_done = false;

    // 慢速主动放弃阈值：3 秒内 < 200KB/s 就当慢镜像，触发 host fallback
    const SPEED_PROBE_SECS: u64 = 3;
    const MIN_SPEED_BPS: u64 = 200 * 1024;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("接收数据失败: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;

        // 速度探测（只查一次）
        if !speed_check_done {
            let elapsed = started.elapsed();
            if elapsed >= Duration::from_secs(SPEED_PROBE_SECS) {
                let bps = downloaded / elapsed.as_secs().max(1);
                speed_check_done = true;
                if bps < MIN_SPEED_BPS && total > downloaded + MIN_SPEED_BPS * 30 {
                    return Err(format!(
                        "速度过慢 {}/s（< 200KB/s），切换 host",
                        fmt_bytes(bps)
                    ));
                }
            }
        }

        if last_emit.elapsed() >= Duration::from_millis(250) {
            let elapsed_secs = started.elapsed().as_secs_f64().max(0.001);
            let bps = (downloaded as f64 / elapsed_secs) as u64;
            let pct = if total > 0 {
                (downloaded as f32 / total as f32 * 100.0).min(100.0)
            } else {
                0.0
            };
            emit_stage(
                app,
                bvid,
                stage,
                pct,
                Some(&format!(
                    "{} / {} @ {}/s",
                    fmt_bytes(downloaded),
                    if total > 0 { fmt_bytes(total) } else { "?".into() },
                    fmt_bytes(bps),
                )),
            );
            last_emit = Instant::now();
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("刷新文件失败: {}", e))?;

    let elapsed_secs = started.elapsed().as_secs_f64().max(0.001);
    let avg_bps = (downloaded as f64 / elapsed_secs) as u64;
    emit_stage(
        app,
        bvid,
        stage,
        100.0,
        Some(&format!("完成 {} @ {}/s", fmt_bytes(downloaded), fmt_bytes(avg_bps))),
    );

    Ok(())
}

// ── ffmpeg 合并 ──

async fn merge_with_ffmpeg(
    video: &Path,
    audio: &Path,
    output: &Path,
) -> Result<(), String> {
    let ffmpeg = locate_ffmpeg();

    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.args([
        "-y",
        "-loglevel", "error",
        "-i", &video.to_string_lossy(),
        "-i", &audio.to_string_lossy(),
        "-c", "copy",
        &output.to_string_lossy(),
    ]);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output_res = cmd
        .output()
        .await
        .map_err(|e| format!("ffmpeg 启动失败（请确认系统已安装 ffmpeg 或在 PATH 中）: {}", e))?;

    if !output_res.status.success() {
        let stderr = String::from_utf8_lossy(&output_res.stderr);
        return Err(format!("ffmpeg 合并失败: {}", stderr.trim()));
    }
    Ok(())
}

fn locate_ffmpeg() -> String {
    // 先看环境变量；否则用 PATH 中的 ffmpeg
    std::env::var("SOLO_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

// ── 工具 ──

fn sanitize_filename(name: &str) -> String {
    // 按字符截断（中文 1 字符 = 3 字节，按字节截会切到 UTF-8 边界中间 → panic）
    const MAX_CHARS: usize = 60;
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let mut s: String = trimmed.chars().take(MAX_CHARS).collect();
    if s.is_empty() {
        s = "video".into();
    }
    s
}

fn fmt_bytes(b: u64) -> String {
    let kb = 1024u64;
    let mb = kb * 1024;
    let gb = mb * 1024;
    if b >= gb {
        format!("{:.2} GB", b as f64 / gb as f64)
    } else if b >= mb {
        format!("{:.1} MB", b as f64 / mb as f64)
    } else if b >= kb {
        format!("{:.0} KB", b as f64 / kb as f64)
    } else {
        format!("{} B", b)
    }
}

fn emit_stage(app: &AppHandle, bvid: &str, stage: &str, pct: f32, msg: Option<&str>) {
    let _ = app.emit(
        "bili-download-progress",
        DownloadProgress {
            bvid: bvid.to_string(),
            stage: stage.to_string(),
            percent: pct,
            message: msg.map(|s| s.to_string()),
            output_path: None,
            queue_position: None,
        },
    );
}

fn emit_error(app: &AppHandle, bvid: &str, msg: &str) {
    let _ = app.emit(
        "bili-download-progress",
        DownloadProgress {
            bvid: bvid.to_string(),
            stage: "error".into(),
            percent: 0.0,
            message: Some(msg.to_string()),
            output_path: None,
            queue_position: None,
        },
    );
}
