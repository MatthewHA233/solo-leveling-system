# Solo Leveling System — Claude Code 项目指南

## 构建

### macOS 客户端

位于 `clients/mac_old/SoloAgent/`。

**构建 + 部署命令（必须使用固定签名 + Release）：**

```bash
cd clients/mac_old/SoloAgent
xcodebuild -scheme SoloAgent -configuration Release build CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="SoloAgent Dev"
```

部署到 `/Applications/`：
```bash
rm -rf /Applications/SoloAgent.app && cp -R ~/Library/Developer/Xcode/DerivedData/SoloAgent-*/Build/Products/Release/SoloAgent.app /Applications/SoloAgent.app
```

- 必须用 `-configuration Release`（Debug 模式的 stub executor + debug dylib 与自签证书有 Team ID 校验冲突）
- 必须用 `CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="SoloAgent Dev"`（ad-hoc 签名会导致重新授权隐私权限）

### Windows Tauri 客户端（关键！）

位于 `clients/desktop/`。**无 Visual Studio，使用 `cargo-xwin` 交叉编译。**

**绝对禁止的操作：**

| 操作 | 原因 |
|------|------|
| `cargo check` / `cargo xwin check` | 生成 ~5.5 GB 无用 debug 产物，且不产出可执行文件 |
| `cargo build` | 没有 VS 工具链会失败 |
| 自动运行 `npm run dev` | 用户自行启动 |
| 自主使用 `cargo xwin build --release` | 除非用户明确要求 |

**开发模式（两个终端分开跑）：**

```bash
# 终端 1：前端 Vite 热更新（用户自己启动）
npm run dev

# 终端 2：Rust 后端编译
cd clients/desktop/src-tauri && cargo xwin build
```

**产物路径：**
- 可执行文件：`target/x86_64-pc-windows-msvc/debug/solo-agent.exe`
- 不是 `target/debug/`（那是 host target 残留，无用）

**正式打包：**
```bash
npx tauri build --runner cargo-xwin
```

### Windows Rust 修改后的开发工作流

只要改了 `clients/desktop/src-tauri/src/**/*.rs`，需要按下面顺序处理。不要直接在应用运行时编译，因为 `solo-agent.exe` 会占用 debug 产物。

```powershell
# 1. 关闭当前由 Codex/开发流程启动的应用进程
Get-Process solo-agent -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. 编译纯后端 debug 产物
cd D:\my_pro\GitHub\solo-leveling-system\clients\desktop\src-tauri
cargo xwin build

# 3. 如需继续调试 WebView2/MCP，用远程调试端口重新启动 exe
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
D:\my_pro\GitHub\solo-leveling-system\clients\desktop\src-tauri\target\x86_64-pc-windows-msvc\debug\solo-agent.exe
```

注意：前端 Vite dev server 由用户自己保持运行，Codex 不要自动运行 `npm run dev` 或 `npm run build`，除非用户明确要求。

### WebView2 DevTools MCP 调试

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
D:\my_pro\GitHub\solo-leveling-system\clients\desktop\src-tauri\target\x86_64-pc-windows-msvc\debug\solo-agent.exe
```

使用 MCP 前，先确认端口已经可访问：

```text
http://127.0.0.1:9222/json/version
```

正常情况下，MCP 能看到主 Vite 页面、`bili-login`、`bailian-login` 和 `#fairy` 等 WebView 页面。在 Codex 中可先用 `chrome devtools` 搜索工具，然后调用 `list_pages`、`select_page`、`take_snapshot`、`list_console_messages` 或截图工具来调试当前 WebView2 会话。

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

## 架构概览

- **菜单栏应用**：纯 `MenuBarExtra`，无 Dock 图标（`NSApp.setActivationPolicy(.accessory)`）
- **全域网监控**：标准 macOS 窗口（`Window("全域网监控", id: "omniscience")`），昼夜表为主组件
- **浮动面板**：Mini status bar + 通知弹窗（`HolographicPanel` / `NSPanel`，不抢焦点，排除截图捕获）
- **热键**：`⌘⇧S` 切换全域网监控窗口

## 关键目录

- `Sources/App/` — 应用入口、AgentManager、配置
- `Sources/Overlay/Views/` — 所有 UI 视图（UnifiedSystemView、DayNightChartView 等）
- `Sources/Overlay/Style/` — Neon Brutalism 主题
- `Sources/GameEngine/` — 游戏逻辑（经验、任务、事件总线）
- `Sources/Capture/` — 屏幕截图捕获
- `Sources/Persistence/` — SQLite 持久化
