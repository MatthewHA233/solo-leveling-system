// ══════════════════════════════════════════════
// OCR — 滚动文章视频转录（逐帧 OCR）
//
//   1) extract_video_frames：按时间间隔从本地视频均匀抽帧
//      （ffmpeg -vf fps=1/interval，长边缩放 ≤1600 控 token），输出 jpg 到
//      <video>_ocrframes/frame_%05d.jpg
//   2) qwen_vl_ocr：把单帧 base64 后调 Qwen-VL-OCR（DashScope OpenAI 兼容端点）
//      做纯文字识别（text_recognition），返回该帧文本
//
//   抽出的相邻帧滚动重叠，最终"去重缝合成文"由前端 queryModel（文本模型）完成。
//   帧图供前端浏览：local API GET /api/ocr/frame?path=...（见 api.rs）
// ══════════════════════════════════════════════

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::process::Command;

use crate::ffmpeg::{ffmpeg_bin_name, find_ffmpeg_dir_pub};

const OCR_TIMEOUT_SECS: u64 = 120;
const FRAME_EXTRACT_TIMEOUT_SECS: u64 = 300;
const DEFAULT_OCR_MODEL: &str = "qwen-vl-ocr";

/// 纯文字识别提示词（OpenAI 兼容接口需在 text 字段手动传任务 prompt）
const OCR_PROMPT: &str = "请提取图片中的所有文字，严格按从上到下、从左到右的阅读顺序输出纯文本。\
不要翻译、不要总结、不要润色、不要描述图片，也不要添加任何解释或额外标记。";

#[derive(Serialize, Clone)]
pub struct ExtractedFrame {
    pub index: u32,
    pub path: String,
    pub ts_sec: f64,
}

#[derive(Serialize, Clone)]
pub struct FramesResult {
    pub dir: String,
    pub frames: Vec<ExtractedFrame>,
}

/// 帧输出目录：<video_parent>/<stem>_ocrframes/
fn frames_dir_for(video: &Path) -> Option<PathBuf> {
    let parent = video.parent()?;
    let stem = video.file_stem()?.to_str()?;
    Some(parent.join(format!("{stem}_ocrframes")))
}

/// 按时间间隔抽全片帧（真正转录用）。interval_sec 钳制到 0.1~60。
#[tauri::command]
pub async fn extract_video_frames(
    file_path: String,
    interval_sec: f64,
    app: AppHandle,
) -> Result<FramesResult, String> {
    let input = PathBuf::from(&file_path);
    if !input.exists() {
        return Err(format!("视频不存在: {}", input.display()));
    }
    let interval = if interval_sec.is_finite() {
        interval_sec.clamp(0.1, 60.0)
    } else {
        5.0
    };

    let out_dir = frames_dir_for(&input).ok_or("无法推导帧输出目录")?;
    // 清空旧帧，重新抽
    let _ = tokio::fs::remove_dir_all(&out_dir).await;
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("创建帧目录失败: {e}"))?;

    let ffmpeg_dir = find_ffmpeg_dir_pub(&app)?;
    let ffmpeg = ffmpeg_dir.join(ffmpeg_bin_name());

    // fps=1/interval 均匀抽帧；长边缩放到 ≤1600 控制 OCR token 成本
    let vf = format!("fps=1/{interval},scale='min(1600,iw)':-2");
    let pattern = out_dir.join("frame_%05d.jpg");

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-y", "-nostats", "-loglevel", "error"])
        .arg("-i")
        .arg(&input)
        .args(["-vf", &vf])
        .args(["-q:v", "3"])
        .arg(&pattern)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = tokio::time::timeout(Duration::from_secs(FRAME_EXTRACT_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "抽帧超时".to_string())?
        .map_err(|e| format!("ffmpeg 启动失败: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "ffmpeg 抽帧失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // 收集并按文件名排序帧
    let mut entries: Vec<PathBuf> = Vec::new();
    let mut rd = tokio::fs::read_dir(&out_dir)
        .await
        .map_err(|e| format!("读取帧目录失败: {e}"))?;
    while let Ok(Some(ent)) = rd.next_entry().await {
        let p = ent.path();
        if p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("jpg"))
            .unwrap_or(false)
        {
            entries.push(p);
        }
    }
    entries.sort();

    let frames: Vec<ExtractedFrame> = entries
        .iter()
        .enumerate()
        .map(|(i, p)| ExtractedFrame {
            index: i as u32,
            path: p.to_string_lossy().to_string(),
            ts_sec: (i as f64) * interval,
        })
        .collect();

    if frames.is_empty() {
        return Err("未抽到任何帧（视频可能过短或解码失败）".into());
    }

    log::info!(
        "[OCR] 抽帧完成 interval={}s 帧数={} dir={}",
        interval,
        frames.len(),
        out_dir.display()
    );
    Ok(FramesResult {
        dir: out_dir.to_string_lossy().to_string(),
        frames,
    })
}

/// 快速抓取单帧（预览用）：输入前 `-ss` 关键帧快进定位 + 只取 1 帧，≈0.2~0.5s（不解码整片）。
/// 输出到 <video>_ocrframes/_preview_{ms}.jpg（与全片抽帧同目录，供本地 API 浏览）。
#[tauri::command]
pub async fn grab_video_frame(
    file_path: String,
    ts_sec: f64,
    app: AppHandle,
) -> Result<String, String> {
    let input = PathBuf::from(&file_path);
    if !input.exists() {
        return Err(format!("视频不存在: {}", input.display()));
    }
    let ts = if ts_sec.is_finite() && ts_sec >= 0.0 { ts_sec } else { 0.0 };

    let out_dir = frames_dir_for(&input).ok_or("无法推导帧输出目录")?;
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("创建帧目录失败: {e}"))?;
    let ms = (ts * 1000.0).round() as i64;
    let out = out_dir.join(format!("_preview_{ms}.jpg"));

    let ffmpeg_dir = find_ffmpeg_dir_pub(&app)?;
    let ffmpeg = ffmpeg_dir.join(ffmpeg_bin_name());

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-y", "-nostats", "-loglevel", "error"])
        .args(["-ss", &format!("{ts}")]) // 放在 -i 前 = 快进定位（快）
        .arg("-i")
        .arg(&input)
        // 预览用：不解音轨、缩到 960 长边、稍降质量 —— 单帧抓取更快
        .args(["-an", "-frames:v", "1"])
        .args(["-vf", "scale='min(960,iw)':-2"])
        .args(["-q:v", "4"])
        .arg(&out)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let output = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "抓帧超时".to_string())?
        .map_err(|e| format!("ffmpeg 启动失败: {e}"))?;
    if !output.status.success() {
        return Err(format!("抓帧失败: {}", String::from_utf8_lossy(&output.stderr)));
    }
    if !out.exists() {
        return Err("抓帧未产出（时间点可能超出视频长度）".into());
    }
    Ok(out.to_string_lossy().to_string())
}

// ── Qwen-VL-OCR 单帧识别 ──

#[derive(Deserialize)]
struct ChatResp {
    choices: Vec<ChatChoice>,
}
#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMsg,
}
#[derive(Deserialize)]
struct ChatMsg {
    content: Option<String>,
}

/// 单帧 OCR：读图 → base64 data URL → 调 DashScope OpenAI 兼容 chat/completions。
/// api_key 由前端传入（与 ASR 转录同源 getDashScopeApiKey）。
#[tauri::command]
pub async fn qwen_vl_ocr(
    image_path: String,
    api_key: String,
    model: Option<String>,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("缺少 API Key".into());
    }
    let model = model.unwrap_or_else(|| DEFAULT_OCR_MODEL.to_string());
    let p = PathBuf::from(&image_path);
    let bytes = tokio::fs::read(&p)
        .await
        .map_err(|e| format!("读取帧失败 {}: {e}", p.display()))?;
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };
    let data_url = format!("data:{};base64,{}", mime, STANDARD.encode(&bytes));

    let body = serde_json::json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url } },
                { "type": "text", "text": OCR_PROMPT }
            ]
        }]
    });

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(OCR_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {e}"))?;

    let resp = client
        .post("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OCR 请求失败: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取 OCR 响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("OCR HTTP {}: {}", status.as_u16(), text));
    }
    let parsed: ChatResp = serde_json::from_str(&text)
        .map_err(|e| format!("解析 OCR 响应失败: {e}; 原文: {}", truncate(&text, 400)))?;
    let content = parsed
        .choices
        .first()
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();
    Ok(content)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}
