# Solo Leveling System — Claude Code 项目指南

## 构建

macOS 客户端位于 `clients/macos/SoloAgent/`。

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
