# Solo Leveling System — Claude Code 项目指南

## 仓库结构

- `clients/desktop/` — Tauri 桌面端（Windows + macOS 跨平台），主开发目标
- `clients/mobile/` — React Native 0.85（Android 主，iOS 后续），开发分支 `feat/mobile`，预留 LAN/HTTP 接入 desktop 共享 DB
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

位于 `clients/mobile/`。React Native 0.85，纯 RN（零原生依赖），Android + iOS 共享 TS 代码。开发分支 `feat/mobile`，主开发目标先做 Android，iOS 后续补。

**包名：** `com.sololevelingsystemmobile`（入口 `MainActivity`）

#### 开发环境

- Node ≥ 20，JDK 17，Android SDK + emulator
- 调试用 **MuMu 模拟器**（用户本机已装，adb 自动检测）— `adb devices` 应能看到一台 `127.0.0.1:xxxx`
- 屏幕已锁竖屏：`android/app/src/main/AndroidManifest.xml` 的 `MainActivity` 加了 `android:screenOrientation="portrait"`，改了要重新 `assembleDebug`

#### 启动开发（Claude 自己管 Metro + APK 安装）

跟 desktop 不一样，mobile 这边 Metro 由 **Claude 后台跑**比较方便，用户只需要让模拟器开着即可。

```bash
# Metro：后台启动（Bash 工具 run_in_background:true）
cd clients/mobile && npm start
# 如果端口 8081 被占，先：lsof -ti:8081 | xargs kill -9

# 装 debug APK 到模拟器并启动（首次 / native 改动后）
cd clients/mobile && npx react-native run-android
```

之后改 RN/TS 代码靠 Fast Refresh 或 reload（见下），不用再跑 `run-android`。

只有这些情况要重跑 `run-android`：
- 改了 `android/` 下的 native 配置（AndroidManifest、build.gradle、icons）
- 加了带 native module 的 npm 包
- 重启了模拟器或 app 卸载后

如果 `run-android` 报 `Permission denied: gradlew`：
```bash
chmod +x clients/mobile/android/gradlew
```

启动 Metro 后用户开模拟器即可看到 app；Claude 通过 adb 截图验证 UI。

#### Fast Refresh / Reload

- 改 RN 组件 / 样式 → Metro Fast Refresh 自动生效，不用 reload
- 改 `useRef(PanResponder.create(...))` 这种闭包捕获的内部 ref → Fast Refresh 不会重建 ref，**必须 reload** 才能看到新逻辑
- 改 `mock.ts` module-level state（如 `overrides` Map）→ reload 会清空

**Reload 命令：**
```bash
# 弹出 RN Dev Menu（在 MuMu 上等同于摇晃手机）
adb shell input keyevent 82

# 在 MuMu 默认分辨率 1440x2560 下，Reload 菜单项约在 (720, 1031)
adb shell input tap 720 1031
```

或者用户在 Metro 终端按 `r`。

#### adb 调试套路

MuMu 默认 1440×2560，density 360。调试 UI 主要靠截图回看（uiautomator 在 MuMu 上没有，dump 不出 view tree）。

```bash
# 屏幕分辨率
adb shell wm size && adb shell wm density

# 截图（推荐流程：先截到设备，再 pull 到本地 /tmp）
adb shell screencap -p /sdcard/shot.png
adb pull /sdcard/shot.png /tmp/shot.png
# 然后用 Read 工具读 /tmp/shot.png 看图

# 点击 / 滑动
adb shell input tap <x> <y>
adb shell input swipe <x1> <y1> <x2> <y2> <duration_ms>
# 注意 swipe 偶尔会报 SecurityException INJECT_EVENTS，
# 一般是模拟器临时状态，过会儿就好

# 看 JS console.log 输出
adb logcat -c                      # 先清掉旧日志
# 触发要观察的操作
adb logcat -d -s ReactNativeJS:V   # 倒出本次日志

# 重启 app（保留模拟器，不清前端 Metro）
adb shell am force-stop com.sololevelingsystemmobile
adb shell am start -n com.sololevelingsystemmobile/.MainActivity

# 查看包名
adb shell pm list packages | grep solo
```

#### MuMu / RN Fabric 已知渲染瑕疵

新架构 `newArchEnabled=true`（Fabric）下，MuMu 模拟器偶尔会把 absolute Text 在屏幕另一处复绘出"ghost"灰字，位置稳定但和实际渲染元素无关。

**诊断方法：** 把怀疑 Text 的 `color` 临时改成 `#FF0000`。如果 ghost 仍是深色（不是红），说明它不是该 Text 元素 → MuMu 渲染 bug，真机不会出现，可以忽略。

#### LSP 误报

`Cannot find name 'Map' / 'Set'` 之类是 false positive（`node_modules` 没装 TS lib types 时），实际 Metro 编译 + 运行都正常。已用 `tsc --noEmit` 验证过。看到这类 diagnostics 直接忽略。

#### 打包 APK

```bash
cd clients/mobile/android
./gradlew assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

iOS 打包待补（需要 macOS + Xcode 真机签名）。

#### LAN 数据层（已预留，未启用）

`src/lib/api.ts` 已写成"先打局域网 HTTP，失败 fallback 到 mock"的形态，端口对齐 desktop 的 `49733`（详见 `clients/desktop/src-tauri/src/api.rs`）。当前手机端总是走 mock —— `setLanHost(null)`。后续 LAN 共享数据库框架定下来后，调用 `setLanHost('192.168.x.x:49733')` 即可切到真实数据。

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

## Mobile 架构概览

`clients/mobile/`（RN + TS，纯 RN 零原生依赖）

- `App.tsx` — SafeAreaProvider + StatusBar + TabBar，切换 `DayNightScreen` / `ChatScreen`
- `src/theme.ts` — 浅色克制主题；`categoryColors` 给活动分类配色；`alpha()` 助手
- `src/types.ts` — `ActivityBlock` / `ActivityTag` / `ChatMessage` 等共享类型
- `src/components/TabBar.tsx` — 底部 Tab 极简栏
- `src/screens/DayNightScreen.tsx` — 鱼眼焦点网格：18 完整行（12×5min）+ 上下缩进行；编辑模式 PanResponder 区间拖拽涂色；色块按 horizontal run 绝对定位渲染（解决凹凸 / 列对齐）
- `src/screens/ChatScreen.tsx` — 暗影聊天：图片附件 modal、录音覆盖层、omni/regular 模式切换
- `src/lib/time.ts` — 日期/分钟格式化
- `src/lib/mock.ts` — 本地 mock 数据：按日期 hash 稳定生成 `BASE_SPANS` + 内存 overrides 编辑覆盖层
- `src/lib/api.ts` — LAN HTTP 优先（`/api/activities/*` 对齐 desktop 49733 端口），失败 fallback 到 mock；`setLanHost(host|null)` 切换源

### 昼夜表设计要点

- 网格按"鱼眼"折叠：focusStart..+18 是 1 cell = 5min 的完整行；上下是 1 cell = 1hr 的缩进行（按每分钟段比例铺色 + 文字标签 + 不响应编辑）
- 拖拽涂色用"快照 + 区间"语义（PC Excel 式）：grant 时 snapshot 当前 blocks 并记起点 minute，move 每次基于 snapshot 重算 `[start, curr]` 区间，反向拖能自然回退
- 同色起点判定 erase 模式，异色/空格判定 paint 模式（覆盖）
- 色块按 horizontal run 绝对定位（不按 per-cell），整段一个 rect，标签在段中央居中、不省略
- 跨行段每行独立显示标签（避免 stair-step 凸起），同色相同 → 视觉理解为同事件
