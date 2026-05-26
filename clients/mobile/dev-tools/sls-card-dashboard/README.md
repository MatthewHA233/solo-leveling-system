# SLS 卡片对照 Dashboard

调试洪流域"还原卡片/还原动作"功能的本地 dashboard。
用真实 B 站录屏帧 vs SLS 截屏并排展示 + 缺陷清单。

## 启动

```bash
cd clients/mobile/dev-tools/sls-card-dashboard
python3 -m http.server 8765
# 浏览器打开 http://localhost:8765/
```

页面每 5s 自动 reload manifest，改了 `manifest.json` 或 `shots/` 直接刷新就能看到。

## 文件结构

- `index.html` — 单页 dashboard（三栏布局：真实帧 / SLS 截屏 / 缺陷清单）
- `manifest.json` — 对照单元的描述（看哪段、用哪些帧、哪些 SLS 截屏、什么缺陷）
- `frames/f####.jpg` — 真实 B 站录屏的关键帧
- `shots/*.png` — SLS app 截屏（手动 adb 抓 + 用 sips 缩小到 700px）

## 添加新对照单元

1. 抓 SLS 截屏：
   ```bash
   DEV=192.168.0.102:40783  # adb devices 看实际
   adb -s $DEV exec-out screencap -p > /tmp/sls.png
   sips -Z 700 /tmp/sls.png --out shots/card-XXX.png
   ```

2. 编辑 `manifest.json`，加一段 `compare_units[]`：
   ```json
   {
     "id": "card-xxx",
     "title": "卡片 #N · 某某",
     "real_time_range": "HH:MM:SS ~ HH:MM:SS",
     "real_frames": [{ "src": "frames/fNNNN.jpg", "caption": "+Ns / HH:MM:SS xxx" }],
     "sls_shots": [{ "src": "shots/card-xxx.png", "caption": "vN" }],
     "issues": [
       { "code": "A", "level": "high", "text": "缺陷描述", "root_cause": "...", "fix": "..." }
     ],
     "status": "pending"
   }
   ```

3. 刷新浏览器（或等自动 reload）。

## 重新生成视频帧

```bash
ffmpeg -y -i Record_2026-05-26-10-16-50.MP4 \
  -vf "fps=3,scale=400:-1" \
  -q:v 5 \
  frames/f%04d.jpg
```

帧号 → 视频秒 = 帧号 / fps；视频秒 → 真实时刻 = 视频起始 + 视频秒。

## 缺陷 level 取值

| level | 颜色 | 含义 |
|---|---|---|
| `high` | 红 | 阻塞性，必须修 |
| `mid` | 橙 | 影响体验 |
| `low` | 黄 | 优化项 |
| `skip` | 灰（半透）| 不修（如系统 chrome 不属业务范围）|
| `fixed` | 绿（半透）| 已修复 |

## status 取值

- `pending` — 还有缺陷待修
- `fixed` — 全部缺陷已修
