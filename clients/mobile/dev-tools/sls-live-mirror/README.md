# SLS 洪流域 Web Mirror

同步手机端 `perception.db` 到本机，并用 Web 端直接渲染 mobile 的同一份洪流域相关组件。

这个工具用于调试 mobile 洪流域 UI：不是手写一份 HTML 复刻，而是 Vite + React Native Web 直接 import mobile 源码。默认渲染 `DayNightScreen mode="torrent"` 的融合页；改 mobile 源码后，浏览器热重载看到同一套组件和样式。

## 启动

```bash
cd clients/mobile/dev-tools/sls-live-mirror
npm install
npm run dev
```

默认地址：

```text
http://localhost:8766/
```

旧版完整洪流域调试页仍保留：

```text
http://localhost:8766/?screen=torrent
```

`npm run dev` 会同时启动：

- API：`http://localhost:8767`，负责 adb 同步 DB。
- Web：`http://localhost:8766`，Vite dev server，代理 `/api` 到 API。
- Vite 需要的 HTML 壳会临时生成到 `.cache/web/index.html`，不作为静态界面进仓库。

## 常用环境变量

```bash
SLS_ADB_SERIAL=192.168.0.102:40783 npm run dev
SLS_MIRROR_WEB_PORT=8776 SLS_MIRROR_API_PORT=8777 npm run dev
SLS_SYNC_INTERVAL_MS=1500 node mirror-server.mjs
SLS_CAPTURE_LIMIT=50000 node mirror-server.mjs
```

## 依赖

- `adb`
- `sqlite3`
- Node.js 22+

## 页面结构

- 默认页面主体是 mobile 的 `DayNightScreen mode="torrent"`；`?screen=torrent` 可切回完整 `TorrentScreen` 调试页。
- 数据源通过 `devSource` 注入：Web 端从 `/api/captures` 读取 adb 同步出来的 DB。
- React Native 组件通过 Vite alias 映射到 `react-native-web`。
- 样式来自 `TorrentScreen.tsx` 的 `StyleSheet.create(...)`，不是 dev-tool 另写 UI。

## API

- `GET /api/status`
- `GET /api/captures?limit=50000`
- `POST /api/sync`
