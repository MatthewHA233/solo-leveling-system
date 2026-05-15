# Solo Leveling System — Claude Code 项目指南

## 仓库结构

- `clients/desktop/` — Tauri 桌面端（Windows + macOS 跨平台），主开发目标
- `clients/mobile/` — React Native 0.85（Android + iOS），待开发
- `clients/mac_old/` — 早期纯 Swift / MenuBarExtra 原型，已归档不再维护

## 构建

### Desktop 客户端（Tauri）

位于 `clients/desktop/`。Tauri 2 + React + Rust，跨平台共享主配置 + 平台特定叠加。

**正式打包（推荐用 npm 脚本）：**

```bash
cd clients/desktop

# Windows：cargo-xwin 跨编译，任意平台均可跑
npm run tauri:build:win

# macOS：需在 Mac 上跑
npm run tauri:build:mac
```

**配置文件分工：**
- `src-tauri/tauri.conf.json` — 共享主配置（productName / identifier `com.solo-leveling.system` / 版本 / 窗口）
- `src-tauri/tauri.windows.conf.json` — Windows 叠加：MSI + NSIS targets + FFmpeg 资源
- `src-tauri/tauri.macos.conf.json` — macOS 叠加：APP + DMG targets + `macOSPrivateApi` + FFmpeg 资源

**产物路径：**
- Windows：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/{msi,nsis}/`
- macOS：`src-tauri/target/release/bundle/{macos,dmg}/`

#### Windows 开发工作流

**无 Visual Studio，使用 `cargo-xwin` 交叉编译。**

**绝对禁止的操作：**

| 操作 | 原因 |
|------|------|
| `cargo check` / `cargo xwin check` | 生成 ~5.5 GB 无用 debug 产物，且不产出可执行文件 |
| `cargo build` | 没有 VS 工具链会失败 |
| 自动运行 `npm run dev` | 用户自行启动 |
| 自主使用 release 编译（`npm run tauri:build:win`） | 除非用户明确要求 |

**开发模式（两个终端分开跑）：**

```bash
# 终端 1：前端 Vite 热更新（用户自己启动）
npm run dev

# 终端 2：Rust 后端 debug 编译
cd clients/desktop/src-tauri && cargo xwin build
```

**产物：** `target/x86_64-pc-windows-msvc/debug/solo-leveling-system.exe`（**不是** `target/debug/`，那是 host target 残留无用）

#### Windows Rust 修改后的开发工作流

只要改了 `clients/desktop/src-tauri/src/**/*.rs`，按下面顺序处理。不要直接在应用运行时编译，因为 `solo-leveling-system.exe` 会占用 debug 产物。

```powershell
# 1. 关闭当前运行的应用进程
Get-Process solo-leveling-system -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. 编译纯后端 debug 产物（用绝对路径，避免 Bash 工具 cwd 漂移）
cd D:\my_pro\GitHub\solo-leveling-system\clients\desktop\src-tauri
cargo xwin build

# 3. 如需调试 WebView2/MCP，用远程调试端口重启 exe
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
D:\my_pro\GitHub\solo-leveling-system\clients\desktop\src-tauri\target\x86_64-pc-windows-msvc\debug\solo-leveling-system.exe
```

注意：前端 Vite dev server 由用户自己保持运行，Codex 不要自动运行 `npm run dev` 或 `npm run build`，除非用户明确要求。

#### 跨平台特性配置（Cargo.toml）

`tauri` 的 `macos-private-api` 特性**只在 macOS 启用**（透明 Fairy 窗口需要）。Cargo.toml 已用 target-specific 依赖块隔离：

```toml
[dependencies]
tauri = { version = "...", features = ["protocol-asset", "tray-icon"] }

[target.'cfg(target_os = "macos")'.dependencies]
tauri = { version = "...", features = ["macos-private-api"] }
```

如果给 base `[dependencies]` 加 macOS-only 的特性，Windows 编译会报 `tauri features ↔ conf.json allowlist 不匹配` 错误。

#### WebView2 DevTools MCP 调试

用于调试 Tauri 内嵌 WebView2 页面，例如 `bailian-login`。Chrome DevTools MCP 可以连接到 WebView2 暴露出来的远程调试端口，这样 Codex 就能直接查看真实 DOM、页面文本、控制台和截图，不必靠猜测页面结构。

CC Switch 里新增 MCP 时，完整 JSON 配置如下：

```json
{
  "type": "stdio",
  "command": "cmd",
  "args": [
    "/c",
    "npx",
    "-y",
    "chrome-devtools-mcp@latest",
    "--browser-url=http://127.0.0.1:9222",
    "--no-usage-statistics"
  ],
  "env": {
    "SystemRoot": "C:\\Windows",
    "PROGRAMFILES": "C:\\Program Files"
  }
}
```

启动开发版应用时，需要先打开 WebView2 远程调试端口：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
D:\my_pro\GitHub\solo-leveling-system\clients\desktop\src-tauri\target\x86_64-pc-windows-msvc\debug\solo-leveling-system.exe
```

使用 MCP 前，先确认端口已经可访问：

```text
http://127.0.0.1:9222/json/version
```

正常情况下，MCP 能看到主 Vite 页面、`bili-login`、`bailian-login` 和 `#fairy` 等 WebView 页面。在 Codex 中可先用 `chrome devtools` 搜索工具，然后调用 `list_pages`、`select_page`、`take_snapshot`、`list_console_messages` 或截图工具来调试当前 WebView2 会话。

### Mobile 客户端

位于 `clients/mobile/`。React Native 0.85 脚手架（`SoloLevelingSystemMobile`），Android + iOS 同一套 TS 代码。待开发。

### 归档：早期 macOS 原型

位于 `clients/mac_old/SoloLevelingSystem/`。纯 Swift / MenuBarExtra 时期的实现，已停止维护，仅保留参考。不要往里加新功能 —— 真正的 macOS 支持现在走 Tauri 路径。

## 参考文档

### 人升（LifeUp）Wiki

源仓库为 git submodule，转换产物供 Obsidian 阅读。

**更新 Wiki 并重新生成笔记：**
```bash
git submodule update --remote "docs/98借鉴对象/参考软件设计——人升/官方文档-zh-cn"
python "docs/98借鉴对象/参考软件设计——人升/convert_wiki.py"
```

- submodule 路径：`docs/98借鉴对象/参考软件设计——人升/官方文档-zh-cn`
- 转换脚本：`docs/98借鉴对象/参考软件设计——人升/convert_wiki.py`
- 输出目录：`docs/98借鉴对象/参考软件设计——人升/人升官方文档/`（已加入 .gitignore）

## Desktop 架构概览

### Tauri 主进程（Rust，`clients/desktop/src-tauri/src/`）

- `lib.rs` / `main.rs` — Tauri 命令注册、应用入口、single-instance
- `db.rs` — SQLite 持久化（用户数据目录：`%LOCALAPPDATA%/solo-leveling-system/`）
- `perception.rs` + `perception_windows.rs` — 自研感知层（替代 ManicTime），Windows 走 `_windows.rs`
- `api.rs` — 本地 HTTP API 端点（端口 49733）
- `qwen_asr.rs` / `qwen_omni.rs` / `qwen_video.rs` — 阿里百炼语音/多模态
- `fish_tts.rs` — Fish Audio TTS
- `bili_download.rs` — B 站视频下载/转录
- `ffmpeg.rs` — 资源 FFmpeg 调用（LGPL 共享库打包）
- `hotkey.rs` — 全局热键
- `gpu_pref.rs` — 独显高性能偏好（注册表）

### 前端（React + Vite，`clients/desktop/src/`）

- `components/` — UI 组件（DayNightChart、FairyWindow、ChatPanel、BiliVideoPanel、ModelDialog 等）
- `components/hud/` — 像素 HUD 框架视觉（HudFrame、HudCommandStrip、NeonRule 等）
- `lib/agent/` — Agent 逻辑（memory / config / tools）
- `lib/llm/` — LLM 流式调用层（stream / retry / normalize）
- `lib/bilibili/` — B 站 API + 历史
- `lib/qwen-omni/` — Omni 多模态转录（音视频合并）
- `lib/voice/` — Fish TTS + 录音
- `lib/game/` — 游戏逻辑（经验、任务、事件总线、规则分类器）
