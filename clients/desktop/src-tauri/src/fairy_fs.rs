// ══════════════════════════════════════════════
// Fairy 文件工具（Read / Write / Edit）的权限关卡
//
// Fairy 会读 B 站评论、视频转写这类外部文字，里面可能藏着诱导它读写文件的指令（提示词注入）；
// 本机 UAC 关闭、进程都是管理员权限，只靠系统提示词里「破坏性操作先确认」挡不住。
//
// 规则（借鉴 Claude Code 的权限模型：工作区内放行，工作区外每次询问）：
//   · 工作区 %LOCALAPPDATA%/solevup/fairy-workspace 内：直接读写；相对路径一律落在这里
//   · 工作区外：每次弹系统对话框，主人点「允许」才执行
// ══════════════════════════════════════════════

use std::path::{Component, Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::db::Database;

const PREVIEW_CHARS: usize = 200;

pub fn workspace_dir() -> PathBuf {
    Database::default_data_dir().join("fairy-workspace")
}

/// 相对路径落在工作区；按字面消解 `.` / `..`（目标文件可能还不存在，不能用 canonicalize）
fn resolve(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("缺少文件路径".to_string());
    }
    let raw = Path::new(path);
    let joined = if raw.is_absolute() { raw.to_path_buf() } else { workspace_dir().join(raw) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

fn in_workspace(path: &Path) -> bool {
    // Windows 路径大小写不敏感
    let root = workspace_dir().to_string_lossy().to_lowercase();
    let p = path.to_string_lossy().to_lowercase();
    p == root || p.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
}

fn preview(s: &str) -> String {
    let head: String = s.chars().take(PREVIEW_CHARS).collect();
    if s.chars().count() > PREVIEW_CHARS { format!("{head}……") } else { head }
}

async fn ask(app: &AppHandle, message: String) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title("Fairy 请求访问文件")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("允许".to_string(), "拒绝".to_string()))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    rx.await.unwrap_or(false)
}

async fn authorize(app: &AppHandle, action: &str, path: &Path, detail: &str) -> Result<(), String> {
    if in_workspace(path) {
        return Ok(());
    }
    let message = format!(
        "Fairy 想{action}工作区外的文件：\n\n{}\n{detail}\n\n只在你确实让它这么做时才点「允许」。",
        path.display()
    );
    if ask(app, message).await {
        log::info!("[FairyFs] 主人允许{action}: {}", path.display());
        Ok(())
    } else {
        log::warn!("[FairyFs] 主人拒绝{action}: {}", path.display());
        Err(format!(
            "主人拒绝了{action}「{}」。不要换个路径重试，先问主人是否要这样做。",
            path.display()
        ))
    }
}

pub async fn read(app: &AppHandle, path: &str) -> Result<String, String> {
    let p = resolve(path)?;
    authorize(app, "读取", &p, "").await?;
    std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))
}

pub async fn write(app: &AppHandle, path: &str, content: &str) -> Result<String, String> {
    let p = resolve(path)?;
    let mode = if p.exists() { "整个覆盖原文件" } else { "新建文件" };
    let detail = format!("\n将{mode}，共 {} 字：\n{}", content.chars().count(), preview(content));
    authorize(app, "写入", &p, &detail).await?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("写入失败: {e}"))?;
    Ok(p.display().to_string())
}

/// 读 → 校验唯一 → 询问 → 替换写回，一次完成：
/// 先校验再询问，别让主人为一次注定失败的修改点「允许」；工作区外也只弹一次窗
pub async fn edit(app: &AppHandle, path: &str, old: &str, new: &str) -> Result<String, String> {
    let p = resolve(path)?;
    if old.is_empty() {
        return Err("old_string 不能为空".to_string());
    }
    let content = std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))?;
    let count = content.matches(old).count();
    if count == 0 {
        return Err(format!("未找到要替换的字符串：{}", preview(old)));
    }
    if count > 1 {
        return Err(format!("字符串不唯一（出现 {count} 次），请提供更多上下文"));
    }
    let detail = format!("\n把：\n{}\n\n改成：\n{}", preview(old), preview(new));
    authorize(app, "修改", &p, &detail).await?;
    std::fs::write(&p, content.replacen(old, new, 1)).map_err(|e| format!("写入失败: {e}"))?;
    Ok(p.display().to_string())
}
