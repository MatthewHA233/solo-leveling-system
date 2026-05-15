// ══════════════════════════════════════════════
// Qwen Video Upload — DashScope 临时存储空间
//
// 流程：
//   1) GET /api/v1/uploads?action=getPolicy&model=xxx → 拿到 OSS 预签名 policy
//   2) POST {upload_host} multipart/form-data → 上传文件到 OSS
//   3) 返回 oss://{bucketname}/{key} 形式的 URL
//
// 后续在 chat/completions 请求里：
//   - body content[].video_url.url = "oss://..."
//   - 必须加 header X-DashScope-OssResourceResolve: enable
//
// 文档：https://help.aliyun.com/zh/model-studio/get-temporary-file-url
// ══════════════════════════════════════════════

use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use std::path::Path;
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
struct PolicyResponse {
    data: PolicyData,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PolicyData {
    policy: String,
    signature: String,
    upload_dir: String,
    upload_host: String,
    expire_in_seconds: i64,
    max_file_size_mb: i64,
    capacity_limit_mb: i64,
    oss_access_key_id: String,
    x_oss_object_acl: String,
    x_oss_forbid_overwrite: String,
}

/// 内部上传逻辑，被 qwen_video_upload 和音频上传复用
async fn upload_to_dashscope(api_key: &str, model: &str, path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    let raw_filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("文件名解析失败")?
        .to_string();
    let filename = sanitize_filename(&raw_filename);

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {}", e))?;

    let policy_url = format!(
        "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model={}",
        model
    );
    let policy_resp = client
        .get(&policy_url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("getPolicy 请求失败: {}", e))?;

    let status = policy_resp.status();
    let body_text = policy_resp
        .text()
        .await
        .map_err(|e| format!("getPolicy 响应读取失败: {}", e))?;
    if !status.is_success() {
        return Err(format!("getPolicy 失败 [{}]: {}", status, body_text));
    }
    let policy: PolicyResponse = serde_json::from_str(&body_text)
        .map_err(|e| format!("getPolicy JSON 解析失败: {} (body={})", e, body_text))?;
    let p = policy.data;

    let metadata = std::fs::metadata(path).map_err(|e| format!("读取文件元数据失败: {}", e))?;
    let size_mb = metadata.len() as f64 / 1024.0 / 1024.0;
    if size_mb > p.max_file_size_mb as f64 {
        return Err(format!(
            "文件 {:.1}MB 超过模型 {} 上限 {}MB",
            size_mb, model, p.max_file_size_mb
        ));
    }

    let object_key = format!("{}/{}", p.upload_dir.trim_end_matches('/'), filename);
    let file_bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;

    let form = Form::new()
        .text("OSSAccessKeyId", p.oss_access_key_id.clone())
        .text("Signature", p.signature)
        .text("policy", p.policy)
        .text("x-oss-object-acl", p.x_oss_object_acl)
        .text("x-oss-forbid-overwrite", p.x_oss_forbid_overwrite)
        .text("key", object_key.clone())
        .text("success_action_status", "200")
        .part(
            "file",
            Part::bytes(file_bytes)
                .file_name(raw_filename.clone())
                .mime_str("application/octet-stream")
                .map_err(|e| format!("MIME 设置失败: {}", e))?,
        );

    let upload_resp = client
        .post(&p.upload_host)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("OSS 上传请求失败: {}", e))?;

    let up_status = upload_resp.status();
    if !up_status.is_success() {
        let txt = upload_resp.text().await.unwrap_or_default();
        return Err(format!("OSS 上传失败 [{}]: {}", up_status, txt));
    }

    // DashScope 文档：oss://{object_key} 中前缀不是物理 bucket
    let oss_url = format!("oss://{}", object_key);
    log::info!("[QwenVideo] 上传成功 {} → {}", path.display(), oss_url);
    Ok(oss_url)
}

/// 上传本地文件到 DashScope 临时存储，返回 oss://... URL
#[tauri::command]
pub async fn qwen_video_upload(
    api_key: String,
    model: String,
    file_path: String,
) -> Result<String, String> {
    upload_to_dashscope(&api_key, &model, Path::new(&file_path)).await
}

/// 用 FFmpeg 从视频中提取音轨，输出 <stem>_audio.m4a，返回路径
/// 已有缓存且比输入新则复用
#[tauri::command]
pub async fn qwen_audio_extract(
    file_path: String,
    app: AppHandle,
) -> Result<String, String> {
    let input = std::path::PathBuf::from(&file_path);
    if !input.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }

    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".into());
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    let output = parent.join(format!("{stem}_audio.m4a"));

    // 缓存命中
    if let (Ok(om), Ok(im)) = (std::fs::metadata(&output), std::fs::metadata(&input)) {
        if om.len() > 0 {
            if let (Ok(ot), Ok(it)) = (om.modified(), im.modified()) {
                if ot >= it {
                    log::info!("[QwenAudio] 缓存命中: {}", output.display());
                    return Ok(output.to_string_lossy().to_string());
                }
            }
        }
    }

    let dir = crate::ffmpeg::find_ffmpeg_dir_pub(&app)?;
    let ffmpeg = dir.join(crate::ffmpeg::ffmpeg_bin_name());

    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-y", "-nostats"])
        .arg("-i").arg(&input)
        .args(["-vn", "-c:a", "aac", "-b:a", "128k"])
        .arg(&output)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("ffmpeg 音频提取失败: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("音频提取失败: {}", stderr.chars().rev().take(200).collect::<String>().chars().rev().collect::<String>()));
    }

    log::info!("[QwenAudio] 提取完成: {}", output.display());
    Ok(output.to_string_lossy().to_string())
}

/// 把文件名变 URL 安全：仅保留 ASCII 字母数字 + . - _，其余按 utf-8 字节 hex 编码
/// 这样 DashScope 拿到的 oss:// 路径里不会含中文 / 空格 / ! ? ， # 等
fn sanitize_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
            out.push(c);
        } else {
            // 用 utf-8 字节序列做 %XX 风格替换（这里直接用 _XX 避免引入第二种保留字符）
            let mut buf = [0u8; 4];
            for &b in c.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("_{:02x}", b));
            }
        }
    }
    if out.is_empty() { "file".to_string() } else { out }
}
