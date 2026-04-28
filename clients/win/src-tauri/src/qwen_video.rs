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

/// 上传本地文件到 DashScope 临时存储，返回 oss://... URL
#[tauri::command]
pub async fn qwen_video_upload(
    api_key: String,
    model: String,
    file_path: String,
) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }
    let raw_filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("文件名解析失败")?
        .to_string();
    // OSS object key + 后续 oss:// URL 必须 URL 安全；DashScope 拒绝含中文 / 空格 / ? ! 等的路径
    let filename = sanitize_filename(&raw_filename);

    // 1) 获取上传凭证
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {}", e))?;

    // model 名只含字母数字 + . - _，URL 安全，无需额外编码
    let policy_url = format!(
        "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model={}",
        model
    );
    let policy_resp = client
        .get(&policy_url)
        .bearer_auth(&api_key)
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

    // 2) 检查文件大小
    let metadata = std::fs::metadata(path).map_err(|e| format!("读取文件元数据失败: {}", e))?;
    let size_mb = metadata.len() as f64 / 1024.0 / 1024.0;
    if size_mb > p.max_file_size_mb as f64 {
        return Err(format!(
            "文件 {:.1}MB 超过模型 {} 上限 {}MB",
            size_mb, model, p.max_file_size_mb
        ));
    }

    // 3) 构造 OSS object key（policy 返回 upload_dir 是该 model 下的目录前缀）
    let object_key = format!("{}/{}", p.upload_dir.trim_end_matches('/'), filename);

    // 4) 读取文件
    let file_bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;

    // 5) 构造 multipart form（顺序按 OSS 规范：所有签名字段在前，file 放最后）
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

    // 6) 返回 oss://{object_key}
    // 注意：DashScope 文档示例 `oss://dashscope-instant/xxx/.../cat.png` 中
    // "dashscope-instant" 是 object key 的前缀，不是物理 OSS bucket。
    // 物理 bucket（dashscope-file-mgr）在 upload_host 里，对模型侧不可见。
    let oss_url = format!("oss://{}", object_key);
    log::info!("[QwenVideo] 上传成功 {} → {}", file_path, oss_url);
    Ok(oss_url)
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
