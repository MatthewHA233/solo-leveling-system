// ══════════════════════════════════════════════
// FFmpeg — 本地视频转封 H.264 以兼容 WebView2 播放
//
// 流程：
//   1) ffprobe 嗅 codec
//   2) 已是 h264 → 直接返回原路径
//   3) 否则按 NVENC → QSV → AMF → MF → libopenh264 顺序选编码器
//   4) 转封到 sibling 文件 <stem>_h264.mp4（视频转码 + 音频 copy）
//   5) 通过 transcode-progress::<id> 事件推送 phase（probe/encoding/done）
//   6) 缓存：output 比 input 新且非空 → 复用
// ══════════════════════════════════════════════

use std::collections::{HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

/// 同一输入文件并发去重锁（修 React StrictMode dev 双 fire 导致的并发转封）
static IN_FLIGHT: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
fn in_flight() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    IN_FLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 编码器永久失败缓存（如 NVENC 驱动版本不够，没必要每次都重试浪费 1 秒）
static FAILED_ENCODERS: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
fn failed_encoders() -> &'static Mutex<HashSet<&'static str>> {
    FAILED_ENCODERS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Serialize, Clone)]
struct ProgressEvent {
    phase: String,
    encoder: Option<String>,
}

/// 公开给其他模块使用（qwen_video 音频提取）
pub fn find_ffmpeg_dir_pub(app: &AppHandle) -> Result<PathBuf, String> {
    find_ffmpeg_dir(app)
}

pub fn ffmpeg_bin_name() -> &'static str {
    if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }
}

pub fn ffprobe_bin_name() -> &'static str {
    if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" }
}

/// 解析 ffmpeg 资源目录（先查 Tauri resource_dir，再尝试相对 exe 的 dev fallback）
fn find_ffmpeg_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut tried: Vec<PathBuf> = Vec::new();
    let ffmpeg_name = ffmpeg_bin_name();
    let ffprobe_name = ffprobe_bin_name();

    // 1. Tauri 标准资源目录（打包后正常路径）
    if let Ok(rd) = app.path().resource_dir() {
        let p = rd.join("resources/ffmpeg");
        if p.join(ffmpeg_name).exists() && p.join(ffprobe_name).exists() {
            return Ok(p);
        }
        tried.push(p);
    }

    // 2. dev 模式：cargo xwin build 后 exe 在 target/.../debug/，资源在 src-tauri/resources/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for rel in &[
                "../../../resources/ffmpeg",
                "../../resources/ffmpeg",
                "../resources/ffmpeg",
                "resources/ffmpeg",
            ] {
                let p = exe_dir.join(rel);
                if p.join(ffmpeg_name).exists() && p.join(ffprobe_name).exists() {
                    return Ok(p);
                }
                tried.push(p);
            }
        }
    }

    if let Some(path_dir) = find_tool_dir_in_path(ffmpeg_name, ffprobe_name) {
        return Ok(path_dir);
    }

    Err(format!("找不到 {ffmpeg_name}/{ffprobe_name}；已尝试: {:?}", tried))
}

fn find_tool_dir_in_path(ffmpeg_name: &str, ffprobe_name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    for dir in env::split_paths(&paths) {
        if dir.join(ffmpeg_name).exists() && dir.join(ffprobe_name).exists() {
            return Some(dir);
        }
    }
    None
}

/// 嗅探视频流 codec_name
async fn probe(ffprobe: &Path, input: &Path) -> Result<String, String> {
    let output = Command::new(ffprobe)
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name",
            "-of", "default=nw=1:nk=1",
        ])
        .arg(input)
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("ffprobe spawn 失败: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn list_encoders(ffmpeg: &Path) -> Result<String, String> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("ffmpeg -encoders 失败: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn pick_encoders(encoders_dump: &str) -> Vec<&'static str> {
    let priority = [
        "h264_videotoolbox",
        "h264_nvenc",
        "h264_qsv",
        "h264_amf",
        "h264_mf",
        "libopenh264",
    ];
    let failed = failed_encoders().lock().unwrap();
    priority
        .iter()
        .copied()
        .filter(|name| encoders_dump.contains(&format!(" {name} ")))
        .filter(|name| !failed.contains(name))
        .collect()
}

/// 按编码器选择输入端硬件加速参数
/// QSV 对 HEVC 输入用全 GPU 管线（hevc_qsv 解码 + 输出 QSV surface）速度最佳
/// NVENC 用 cuda 硬解；AMF/MF 用 d3d11va；其余 auto
fn input_args_for_encoder(encoder: &str, input_codec: &str) -> Vec<String> {
    match (encoder, input_codec) {
        ("h264_qsv", "hevc") => vec![
            "-hwaccel".into(), "qsv".into(),
            "-hwaccel_output_format".into(), "qsv".into(),
            "-c:v".into(), "hevc_qsv".into(),
        ],
        ("h264_videotoolbox", _) => Vec::new(),
        ("h264_nvenc", _) => vec![
            "-hwaccel".into(), "cuda".into(),
        ],
        ("h264_amf", _) | ("h264_mf", _) => vec![
            "-hwaccel".into(), "d3d11va".into(),
        ],
        _ => vec![
            "-hwaccel".into(), "auto".into(),
        ],
    }
}

/// 真正的转封：调 ffmpeg，把视频流换成 H.264，音频 copy
async fn transcode(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    encoder: &'static str,
    input_codec: &str,
) -> Result<(), String> {
    let preset = match encoder {
        "h264_nvenc" => "p1",       // NVENC: p1=fastest p7=slowest
        "h264_qsv" => "veryfast",
        "h264_amf" => "speed",
        "h264_mf" => "speed",       // MF 也支持
        "libopenh264" => "ultrafast",
        _ => "veryfast",
    };

    // 输入端硬解：HEVC + QSV 走全 GPU 管线（实测 12.5x realtime）
    // 其他组合按编码器选合适的 hwaccel；fallback 到 auto
    let in_args = input_args_for_encoder(encoder, input_codec);

    // -pix_fmt yuv420p: 10bit→8bit，避免 NVENC -40。
    // 但全 GPU 管线（QSV+HEVC）输出的是 surface 格式，强制 yuv420p 会让
    // ffmpeg 在 surface 与 CPU 像素格式之间死锁报错，必须省掉。
    let is_full_gpu = encoder == "h264_qsv" && input_codec == "hevc";

    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-y", "-nostats"]);
    for a in &in_args {
        cmd.arg(a);
    }
    cmd.args(["-i"])
        .arg(input)
        .args(["-c:v", encoder, "-preset", preset]);
    if !is_full_gpu {
        cmd.args(["-pix_fmt", "yuv420p"]);
    }
    cmd.args(["-c:a", "copy"])
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("ffmpeg spawn 失败: {e}"))?;

    if !out.status.success() {
        // 标记为永久失败 —— 比如 NVENC 驱动版本不够会一直失败，
        // 没必要每次新视频都浪费 1s 重试再 fallback
        failed_encoders().lock().unwrap().insert(encoder);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail = stderr
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(format!(
            "encoder={} exit={} stderr_tail=...{}",
            encoder,
            out.status.code().unwrap_or(-1),
            tail
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn ensure_h264_playable(
    input_path: String,
    event_id: String,
    app: AppHandle,
) -> Result<String, String> {
    let topic = format!("transcode-progress::{event_id}");
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!("文件不存在: {input_path}"));
    }

    // 同一文件并发去重：React StrictMode dev 模式下 useEffect 会双 fire，
    // 两个并发 ffmpeg 进程写同一个 _h264.mp4 是损坏文件的常见原因。
    // 串行化后第二次会直接命中下面的缓存检测，秒返回。
    let key_lock = {
        let mut map = in_flight().lock().unwrap();
        map.entry(input_path.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _guard = key_lock.lock().await;

    let dir = find_ffmpeg_dir(&app)?;
    let ffmpeg = dir.join(ffmpeg_bin_name());
    let ffprobe = dir.join(ffprobe_bin_name());
    log::info!("[FFmpeg] dir={}", dir.display());

    let _ = app.emit(
        &topic,
        ProgressEvent {
            phase: "probe".into(),
            encoder: None,
        },
    );

    let codec = probe(&ffprobe, &input).await?;
    log::info!("[FFmpeg] codec={codec}");

    if codec == "h264" {
        let _ = app.emit(
            &topic,
            ProgressEvent {
                phase: "done".into(),
                encoder: None,
            },
        );
        return Ok(input_path);
    }

    // 输出 sibling: <stem>_h264.mp4
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".into());
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    let output = parent.join(format!("{stem}_h264.mp4"));

    // 缓存命中检测
    if let (Ok(om), Ok(im)) = (std::fs::metadata(&output), std::fs::metadata(&input)) {
        if om.len() > 0 {
            if let (Ok(ot), Ok(it)) = (om.modified(), im.modified()) {
                if ot >= it {
                    log::info!("[FFmpeg] 缓存命中: {}", output.display());
                    let _ = app.emit(
                        &topic,
                        ProgressEvent {
                            phase: "done".into(),
                            encoder: None,
                        },
                    );
                    return Ok(output.to_string_lossy().to_string());
                }
            }
        }
    }

    let dump = list_encoders(&ffmpeg).await?;
    let encoders = pick_encoders(&dump);
    if encoders.is_empty() {
        return Err("ffmpeg build 中没有可用 H.264 编码器".into());
    }
    log::info!("[FFmpeg] 候选编码器: {:?}", encoders);

    let mut last_err: Option<String> = None;
    for encoder in encoders {
        let _ = app.emit(
            &topic,
            ProgressEvent {
                phase: "encoding".into(),
                encoder: Some(encoder.into()),
            },
        );
        match transcode(&ffmpeg, &input, &output, encoder, &codec).await {
            Ok(()) => {
                log::info!("[FFmpeg] 编码成功 encoder={encoder}");
                let _ = app.emit(
                    &topic,
                    ProgressEvent {
                        phase: "done".into(),
                        encoder: Some(encoder.into()),
                    },
                );
                return Ok(output.to_string_lossy().to_string());
            }
            Err(e) => {
                log::warn!("[FFmpeg] {encoder} 失败：{e}，尝试下一个");
                last_err = Some(e);
                let _ = std::fs::remove_file(&output);
            }
        }
    }

    Err(format!(
        "所有编码器尝试失败：{}",
        last_err.unwrap_or_default()
    ))
}
