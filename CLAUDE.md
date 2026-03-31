# Solo Leveling System — Claude Code 项目指南

## 构建

### macOS 客户端

位于 `clients/macos/SoloAgent/`。

**构建 + 部署命令（必须使用固定签名 + Release）：**

```bash
cd clients/macos/SoloAgent
xcodebuild -scheme SoloAgent -configuration Release build CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="SoloAgent Dev"
```

部署到 `/Applications/`：
```bash
rm -rf /Applications/SoloAgent.app && cp -R ~/Library/Developer/Xcode/DerivedData/SoloAgent-*/Build/Products/Release/SoloAgent.app /Applications/SoloAgent.app
```

- 必须用 `-configuration Release`（Debug 模式的 stub executor + debug dylib 与自签证书有 Team ID 校验冲突）
- 必须用 `CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="SoloAgent Dev"`（ad-hoc 签名会导致重新授权隐私权限）

### Windows Tauri 客户端（关键！）

位于 `clients/win/`。**无 Visual Studio，使用 `cargo-xwin` 交叉编译。**

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
cd clients/win/src-tauri && cargo xwin build
```

**产物路径：**
- 可执行文件：`target/x86_64-pc-windows-msvc/debug/solo-agent.exe`
- 不是 `target/debug/`（那是 host target 残留，无用）

**正式打包：**
```bash
npx tauri build --runner cargo-xwin
```

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
