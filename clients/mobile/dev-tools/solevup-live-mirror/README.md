# Solevup 对照工作台（洪流域 Web Mirror）

把手机端真实录屏的**视频帧**，和 mobile 还原出来的**洪流域卡片/动作**摆在一起逐帧对照的调试工作台。

右侧不是手写的 HTML 复刻，而是 Vite + React Native Web **直接 import mobile 的 `TorrentScreen.tsx`**。改 `clients/mobile/src/screens/TorrentScreen.tsx` 后浏览器热重载，看到的就是手机上同一套组件和样式。

```
┌─ 对照 #1 ───────────────────────────────────── 760px [✕] ┐
│ ┌── 左：真实录屏帧 ──────┐ ┌── 右：TorrentScreen 镜像 ──┐ │
│ │ 视频[横版▾]  10:17:27   │ │ 🔍 搜动作/卡片文本…         │ │
│ │ ◄ [====●======] ►       │ │ ‹ 05-26 ›  [卡片|动作|原始] │ │
│ │   <当前帧大图>          │ │ ┌── 390px 手机框（可滚）─┐ │ │
│ │ ▫▫●▫▫ 每秒一张缩略条    │ │ │ 真实 TorrentScreen…    │ │ │
│ └────────────────────────┘ └────────────────────────────┘ │
└──────────────────────────────── ↕ 拖底边调高度 ───────────┘
```

## 启动

```bash
cd clients/mobile/dev-tools/solevup-live-mirror

npm install        # 首次 / 依赖变动时
npm run dev        # ★ 一键起：dev.mjs 并发拉起 API + Web
npm run api        # 只起后端（mirror-server.mjs，调试用）
```

打开 **http://localhost:8766/**。

`npm run dev`（`node dev.mjs`）同时管两个进程，**任一退出则整体退出**：

| 进程 | 端口 | 作用 |
|---|---|---|
| API（`mirror-server.mjs`） | 8767 | adb 同步 DB、`/api/videos`、`/frames/*`、`/api/bench-config` |
| Web（Vite + RNW） | 8766 | 工作台页面，`/api` + `/frames` 代理到 8767 |

Vite 需要的 HTML 壳临时生成到 `.cache/web/index.html`，不作为静态界面进仓库。

## 工作台用法

- **左 · 帧选择器**：选视频 → 拖滑块 / `‹ ›` 步进 / 点缩略条选帧。顶部显示该帧的**真实时刻**（视频起始时刻 + 帧号 ÷ fps）。
- **右 · TorrentScreen 镜像**：和手机完全一致。自带日期头切日期、卡片/动作/原始三视图。
- **搜索**：右上搜索框输入 → 镜像里第一条命中的卡片/动作**滚动到位 + 高亮闪烁**（递归匹配 ListItem 内所有文本，不绑死字段）。
- **多栏对照**：右上 `+ 新建对照` 加栏，每栏 `✕` 删除。
- **栏高可调**：拖每栏底边的横条改高度（下限 380px），标题栏右侧实时显示 px。
- **自动保存**：对照栏列表 / 高度 / 搜索词任何改动，400ms 后自动落盘，刷新/换机重开都在。

## 帧目录约定

帧放在 `frames/<videoId>/`，后端 `GET /api/videos` 扫描后供左侧选择：

```
frames/
  v-10-16-50/              # 目录名即 videoId
    meta.json              # { "label", "startRealTs": "10:16:50", "fps": 3 }
    f0001.jpg f0002.jpg …  # ffmpeg 拆出的连续帧，f%04d
```

- `meta.json` 可省略：`startRealTs` 会尝试从目录名里的 `HH-MM-SS` 解析，`fps` 默认 3。
- 帧真实时刻由前端算：`startRealTs + (帧号 - 1) / fps`。

**拆帧规则**（横竖屏通用：长边缩到 1280，质量约 40%）：

```bash
ffmpeg -i Record_2026-05-26-10-16-50_xxx.mp4 \
  -vf "fps=3,scale='if(gt(a,1),1280,-2)':'if(gt(a,1),-2,1280)'" \
  -q:v 12 frames/v-10-16-50/f%04d.jpg
```

横屏 → 1280×720 标准 720p；竖屏（如 720×1608）→ 长边 1280 按比例缩（573×1280）。

## 接入手机数据

DB 同步走 `adb exec-out run-as <pkg> cat databases/solevup_perception.db`，**要求 app 可 run-as（debuggable）**：

- release 版（OSS 自更新装的）`flags=0x0` 非 debuggable，`run-as` 读不到内部 DB。
- 开发解法：**同签名覆盖安装 debug 包**（`adb install -r app-debug.apk`），数据不清（`firstInstallTime` 不变）、恢复 debuggable，`run-as` 即可读。

连真机（无线 adb）：

```bash
adb pair <ip>:<配对端口> <配对码>
adb mdns services                 # 找 _adb-tls-connect 的连接端口
adb connect <ip>:<连接端口>
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 同步状态 / 行数 / 设备 |
| GET | `/api/captures?limit=50000` | 读本地 DB 快照的 raw captures |
| POST | `/api/sync` | 拉一次手机 `solevup_perception.db` 快照 |
| GET | `/api/videos` | 视频 + 帧清单 |
| GET | `/frames/<videoId>/<file>` | 帧图片 |
| GET/PUT | `/api/bench-config` | 读写工作台布局配置 |

默认没有后台轮询，需要新数据时点页面里的「刷新」或顶栏「同步 DB」。

## 环境变量

```bash
SOLEVUP_ADB_SERIAL=192.168.0.102:33067 npm run dev   # 多设备时锁定一台
SOLEVUP_MIRROR_WEB_PORT=8776 SOLEVUP_MIRROR_API_PORT=8777 npm run dev   # 改端口
SOLEVUP_CAPTURE_LIMIT=50000 npm run dev              # 拉取条数上限
SOLEVUP_FRAMES_ROOT=/some/dir npm run dev            # 帧根目录（默认 ./frames）
```

## 落盘位置（均在 `.cache/`，已 gitignore）

- `.cache/solevup_perception.db` — adb 同步下来的 DB 快照
- `.cache/bench-config.json` — 工作台布局配置（自动保存）
- `.cache/web/index.html` — Vite HTML 壳

## 依赖

- `adb`、`sqlite3`、Node.js 22+
- 前端：`vite` / `@vitejs/plugin-react` / `react-dom` / `react-native-web`（`react` / `react-native-svg` 等从 mobile 的 `node_modules` 复用）

## 架构要点

- `react-native` 经 Vite alias 映射到 `react-native-web`；样式全部来自 `TorrentScreen.tsx` 的 `StyleSheet.create(...)`，dev-tool 不另写镜像 UI。
- 数据通过 `devSource` 注入 TorrentScreen；多个对照栏**共享同一份 captures**（只 adb 同步一次），搜索词经可选 `searchText` prop 传入（mobile 不传则行为零变化）。
