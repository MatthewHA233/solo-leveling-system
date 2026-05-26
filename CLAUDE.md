# Solo Leveling System — Claude Code 项目指南

## 仓库结构

- `clients/desktop/` — Tauri 桌面端（Windows + macOS 跨平台），主开发目标
- `clients/mobile/` — React Native 0.85（Android 主，iOS 后续），开发分支 `feat/mobile`，预留 LAN/HTTP 接入 desktop 共享 DB
- `clients/mac_old/` — 早期纯 Swift / MenuBarExtra 原型，已归档不再维护

## 自动化审查修复交接

项目里有 Codex 自动化会定期审查提交，并把中文报告写到 `docs/自动化监控报告/提交风险监控/`。修复这些报告里的问题时，Claude Code 按下面规则处理。

- 先读 `docs/自动化监控报告/提交风险监控/审查清单.md`，以其中的“问题追踪”为准；不要只凭某一份历史报告判断问题状态。
- 修复前明确问题 ID，例如 `AUDIT-005`，并确认当前 HEAD 是否仍存在。若问题已经被后续代码解决，只更新追踪状态或说明，不再改源码。
- 一次只修对应问题的最小范围，优先修根因；不要顺手重构无关模块、调整 UI、格式化大文件或改动未关联路径。
- 提交信息建议引用问题 ID 或来源提交 hash，例如 `fix(mobile): normalize sync timestamps (AUDIT-005)`，方便自动化下一轮识别修复提交并复审。
- 修复后必须运行或记录报告建议的最小验证步骤；无法验证时，在报告或提交说明里写清未验证项和原因。
- 修复提交本身会被下一轮自动化审查。若修复不完整或引入新问题，自动化会保留原问题为“当前仍存在/部分修复”，并另开追踪项。

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

#### macOS 开发工作流

**原生 cargo + Tauri CLI，跟 Windows 不一样：mac 上 `npm run dev` 由 Claude 自己后台跑**，因为 `tauri dev` 在两端工具链都装齐的 mac 上能稳定起，没有 Windows 那种"vite 长跑 + cargo xwin build 单次"的拆分需求。

**绝对禁止的操作：**

| 操作 | 原因 |
|------|------|
| `cargo build` / `cargo check` | `tauri features ↔ conf.json allowlist 不匹配` — `app.macOSPrivateApi: true` 只在 `tauri.macos.conf.json` overlay 里声明，cargo 不读 overlay。**只有** `tauri dev` / `tauri build` 会 merge overlay |
| 自主使用 release 打包（`npm run tauri:build:mac`） | 除非用户明确要求 |
| 用 `TAURI_CONFIG` env 绕开 conf overlay | build script 不读 runtime env，绕不过去 |

**开发模式（两个后台进程，都由 Claude 起）：**

```bash
# 终端 1：前端 Vite（tauri.conf.json 配置的 devUrl 是 http://localhost:5172）
cd clients/desktop && npm run dev

# 终端 2：Tauri dev（合 mac overlay → cargo run → 启 .app 窗口）
cd clients/desktop && PATH="$HOME/.cargo/bin:$PATH" npx tauri dev
```

**关键细节：**
- `tauri.conf.json` **没**设 `beforeDevCommand`，所以 `tauri dev` 自己不起 vite —— 必须先起 vite（或并行），不然会一直 `Warn Waiting for your frontend dev server to start on http://localhost:5172/...`
- 启动顺序：vite 起到监听 5172 → tauri dev 探测到 → cargo run 增量编译 rust → `[App] SOLO LEVELING SYSTEM 启动完成` → .app 窗口弹出

**产物：** `target/debug/solo-leveling-system`（native binary，tauri dev 自动启动 `.app` 窗口、按 ctrl-C 退出会自动清理）

**Rust 修改后重启：**
```bash
# kill 全部 dev 进程
pkill -f "tauri dev|solo-leveling-system|cargo run|vite"

# 重新按上面 2 个终端的顺序起
```

**⚠️ Cargo.toml 被 tauri dev 自动污染的坑：**

mac 上跑 `tauri dev` / `tauri build` 时，Tauri CLI 的"修复辅助"会**自动把 `macos-private-api` 加到 base `[dependencies].tauri.features`**，让 cargo run 不报 `tauri features ↔ conf.json allowlist 不匹配`。但这违反 03e43e0 commit 设计的"macOS-only 特性隔离"，会让 Windows `cargo xwin build` 报反向错误。

**所以：mac 上 `tauri dev` 跑过后，commit 前必须 revert `Cargo.toml`：**

```bash
git diff clients/desktop/src-tauri/Cargo.toml   # 应该只看到 base features 多了 macos-private-api
git checkout -- clients/desktop/src-tauri/Cargo.toml
```

`grep` 验证 base 应该是 `["protocol-asset", "tray-icon"]`、target 块才有 `["macos-private-api"]`。

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

位于 `clients/mobile/`。React Native 0.85，自家 native module（SoloDb / Updater / Perception / Sync），不引第三方"非必要"的 native 包；可视化基础设施类的（`react-native-svg`、`react-native-safe-area-context` 等）按需引入。Android + iOS 共享 TS 代码。开发分支 `feat/mobile`，主开发目标先做 Android，iOS 后续补。

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

#### 版本号 + OSS 发布 + 自更新

**版本号手动维护**：`clients/mobile/VERSION` 两行 properties，gradle 读取 → BuildConfig 注入：

```
versionName=0.0.0.1
versionCode=1
```

四位号 `a.b.c.d`，`versionCode` 单调递增即可（OSS latest.json 用 versionCode 整数比较新旧）。

**OSS 端点配置**：`clients/mobile/sls.properties`（已 gitignore，模板见 `sls.properties.example`）：

```
ossEndpoint=oss-cn-heyuan.aliyuncs.com
ossBucket=horizn
ossPathPrefix=solo-leveling
ossCustomDomain=                   # 留空走原生 https://{bucket}.{endpoint}；配了优先 CDN
```

gradle 自动拼 `SLS_UPDATE_MANIFEST_URL = {base}/{prefix}/android/latest.json` 注入 BuildConfig；
`Updater.getUpdateManifestUrl()` 暴露给 JS，**TS / Kotlin 都不能再硬编码 URL**。

**OSS 路径布局**（覆盖式 — 测试期间只保留 latest）：

```
solo-leveling/android/
  latest.json                       # version_name / version_code / url / sha256 / changelog
  releases/sls-{name}-vc{code}-{sha12}.apk  # 文件名带 sha256 前 12 位，每次发布永远是新 URL → 绕开 CDN 旧缓存；OSS 仍只保留 latest 一份
```

**OSS AK/SK** 从 `~/Projects/Github/MW_ActivityMonitor/.env` 复用（`OSS_ACCESS_KEY_ID/SECRET`，同一台机器一套钥匙）。
**绝对禁止**把 AK/SK 写进 sls 仓库的任何文件。

**标准发布流程（双击 .command，Claude 不直接跑 python）**：

`clients/mobile/release.command` 是 mac Finder 双击入口（已 chmod +x）。Claude 的角色，**严格按顺序，每一步都不可省略**：

1. 改 `clients/mobile/VERSION`（手动 bump 两个值 versionName + versionCode）
2. 写本次 changelog 到 `clients/mobile/CHANGELOG.next.md`
3. **commit 所有相关改动**（VERSION、源码等）—— commit 后工作区 clean，stamp 会记录干净 HEAD；否则脚本第 [3/8] 步会判 dirty 强制重 build
4. **🚨 Claude 跑 `python3 scripts/release_mobile.py --build-only`**（background，3~8 分钟首次 / ~30s 增量）—— 这会 build APK 并写新鲜度 stamp（git HEAD + dirty 状态）；`--build-only` 不走 OSS 网络，不怕 Clash 代理
5. build 完成后用 `aapt dump badging app-release.apk` 校验内嵌 versionCode/versionName == VERSION（必做，结果必须出现在 Claude 对话里给用户看到）
6. **校验通过后**才 `open -R clients/mobile/release.command` 用 Finder 选中显示
7. **由用户双击 .command** 启动 Terminal 跑上传；脚本会清 Clash 代理 env、读 changelog、校验 APK 版本 + stamp HEAD 匹配后上传（一般不出错，无需用户回贴日志，除非用户主动说有问题）

> 🚨🚨🚨 **第 4 步绝不可省略 —— 惨痛血泪教训**：
>
> 0.0.0.8 那次发布事故的真实根因 = Claude **直接跳到第 6 步**让用户双击 .command，没预 build。脚本里有 fallback build，但当时 release.command 不带 `--build`，python 脚本看到 `app-release.apk` 已存在（vc7 的旧产物）就**复用上传**了，于是 manifest 写 vc8 / APK 内部还是 vc7，手机检测到更新但装的是旧版，CDN 还缓存 4~8 小时无法刷新，排查耗了一整下午。
>
> **三层防护（不要因此放松第 4 步）**：
> - **`--build-only` 写 stamp**：APK 旁边写 `app-release.apk.stamp.json` 记录 `git_head + git_dirty + built_at`
> - **脚本 [3/8] 复用条件（任一不满足都重 build）**：APK 存在 + 内嵌版本 == VERSION + stamp 存在 + stamp.git_head == 当前 HEAD + stamp.git_dirty == false + 当前工作区 clean
> - **上传前 verify_apk_version 兜底**：aapt 再读一次内嵌版本
>
> 这三层中只要 stamp 校验是核心 —— 它捕获"VERSION 没变但源码变了"的场景（AUDIT-023）。Claude 必须先 commit 再 build，让 stamp 锚定干净 HEAD。
>
> **强制 clean build**：`cd clients/mobile/android && ./gradlew clean` 然后再跑 `--build-only`（缓存出问题时用）
>
> **绝对禁止 Claude 自己直接跑 `python3 release_mobile.py`（不带 --build-only）走正常上传** —— Claude 的后台 Bash 继承 Clash 代理，OSS 国内域会 502 / 超慢；上传必须由用户双击 .command 走（脚本里 unset 了代理 env）

**为什么不让 Claude 直接 `python3 scripts/release_mobile.py`：**
- Claude 的后台 Bash 继承 mac 全局代理（Clash 等），OSS 国内域被代理走会 502 / 超慢
- 用户的全局代理是 codex/其他工具需要的，不能关
- `.command` 里 `unset http_proxy https_proxy ...` 干净绕开

`release.command` 还会在发布成功后问"是否清空 `CHANGELOG.next.md`"，下一版本重新写。

**发布脚本** `scripts/release_mobile.py`（依赖 `oss2 python-dotenv`）的细节，**仅供调试/绕路时直接调用**：
- 上传走 `oss2.resumable_upload` 4 线程 multipart，4MB part_size，> 10MB 自动分片（50MB APK 实测 11s ≈ 4.5MB/s；单流模式被国内 ISP 限速到 80KB/s）
- 上传前用 `aapt dump badging` 校验 APK 内嵌 `versionName/versionCode` 必须等于 `clients/mobile/VERSION`，避免旧 APK 被新 manifest 发布
- 阶段化打印 `[n/8]` 进度 + 每步耗时 + 实时进度条/速度
- 默认覆盖式：先清 `solo-leveling/android/releases/` 下旧 `.apk` 再传新的；`latest.json` 直接 PUT 覆盖

```bash
# 紧急 / 调试用法（绕过 .command）：
unset http_proxy https_proxy && \
python3 scripts/release_mobile.py --changelog "..." [--build] [--dry-run] [--min-supported N]
```

发布前自己改 `clients/mobile/VERSION` 两个值；脚本不会自动 bump。

**自更新流程（mobile 端）**：
- `Updater` NativeModule（`clients/mobile/android/.../updater/`）+ `src/lib/updater.ts`
- 启动 PerceptionScreen 时静默 `checkForUpdate()` 拉 latest.json 对比 BuildConfig.SLS_VERSION_CODE
- 有新版本弹 ConfirmDialog（用户可"稍后"）；手动按"检查更新"也走同一路径
- 点确认 → `DownloadManager` 下到 `getExternalFilesDir("updates")/{远端APK文件名}`，不要固定 `sls-latest.apk`，否则部分 OEM 安装器会按 FileProvider `content://` URI 缓存旧 APK 元数据
- 完成后 FileProvider 包装 → `ACTION_VIEW application/vnd.android.package-archive` 拉系统安装器
- 用户首次需要在系统设置允许"未知来源安装"；Android 不允许完全无感更新
- 权限：manifest 加了 `REQUEST_INSTALL_PACKAGES`，FileProvider authorities=`${applicationId}.fileprovider`，paths 配 `external-files-path name="updates" path="updates/"`

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

`clients/mobile/`（RN + TS，自家 native module + `react-native-svg` / `react-native-safe-area-context` 等可视化基础包）

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
