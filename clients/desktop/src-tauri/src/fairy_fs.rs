// ══════════════════════════════════════════════
// Fairy 文件工具（Read / Write / Edit）的权限关卡
//
// Fairy 会读 B 站评论、视频转写这类外部文字，里面可能藏着诱导它读写文件的指令（提示词注入）；
// 本机 UAC 关闭、进程都是管理员权限，只靠系统提示词里「破坏性操作先确认」挡不住。
//
// 规则（借鉴 Claude Code 的权限模型：工作区内放行，工作区外每次询问）：
//   · 工作区 %LOCALAPPDATA%/solevup/fairy-workspace 内：直接读写；相对路径一律落在这里
//   · 工作区外：每次弹系统对话框，主人点「允许」才执行
//   · 字面在工作区内、但经符号链接或目录联接指到外面的，算工作区外
//   · 主人点「允许」之前不碰目标文件：文件在不在、字符串出现几次都不能先从错误信息漏给模型
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

fn is_under(path: &Path, root: &Path) -> bool {
    // Windows 路径大小写不敏感
    let root = root.to_string_lossy().to_lowercase();
    let p = path.to_string_lossy().to_lowercase();
    p == root || p.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
}

/// 解析符号链接后的真实路径。目标可能还不存在：解析最近一级存在的祖先，再接上不存在的尾巴。
/// 悬空的符号链接算存在（写入时会落到它指向的地方），解析不了就返回 None
fn real_path(path: &Path) -> Option<PathBuf> {
    let mut missing = Vec::new();
    let mut existing = path;
    while std::fs::symlink_metadata(existing).is_err() {
        missing.push(existing.file_name()?);
        existing = existing.parent()?;
    }
    let mut real = std::fs::canonicalize(existing).ok()?;
    real.extend(missing.iter().rev());
    Some(real)
}

/// 工作区的真实路径。只解析它的上级：工作区自身要是符号链接，里面的路径就对不上这里，会被当成工作区外
fn real_workspace(workspace: &Path) -> Option<PathBuf> {
    Some(real_path(workspace.parent()?)?.join(workspace.file_name()?))
}

fn in_workspace(path: &Path, workspace: &Path) -> bool {
    if !is_under(path, workspace) {
        return false;
    }
    match (real_path(path), real_workspace(workspace)) {
        (Some(real), Some(root)) => is_under(&real, &root),
        _ => false,
    }
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
    let workspace = workspace_dir();
    // 还没建工作区时写根路径，会建出一个叫 fairy-workspace 的普通文件，之后工作区就废了
    if path == workspace {
        return Err(format!("「{}」是工作区目录本身，不是文件", path.display()));
    }
    if in_workspace(path, &workspace) {
        return Ok(());
    }
    // 字面在工作区里还走到这，说明被链接带出去了，让主人看到真实去向
    let via_link = if is_under(path, &workspace) {
        real_path(path).map(|r| format!("\n实际指向：{}", r.display())).unwrap_or_default()
    } else {
        String::new()
    };
    let message = format!(
        "Fairy 想{action}工作区外的文件：\n\n{}{via_link}\n{detail}\n\n只在你确实让它这么做时才点「允许」。",
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

/// 询问 → 读 → 校验唯一 → 替换写回，一次完成；工作区外也只弹一次窗
pub async fn edit(app: &AppHandle, path: &str, old: &str, new: &str) -> Result<String, String> {
    let p = resolve(path)?;
    if old.is_empty() {
        return Err("old_string 不能为空".to_string());
    }
    let detail = format!("\n把：\n{}\n\n改成：\n{}", preview(old), preview(new));
    authorize(app, "修改", &p, &detail).await?;
    let content = std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))?;
    let count = content.matches(old).count();
    if count == 0 {
        return Err(format!("未找到要替换的字符串：{}", preview(old)));
    }
    if count > 1 {
        return Err(format!("字符串不唯一（出现 {count} 次），请提供更多上下文"));
    }
    std::fs::write(&p, content.replacen(old, new, 1)).map_err(|e| format!("写入失败: {e}"))?;
    Ok(p.display().to_string())
}
