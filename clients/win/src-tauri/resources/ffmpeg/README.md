# Bundled FFmpeg

本目录的 `ffmpeg.exe` `ffprobe.exe` 与 7 个 `.dll` 来自 BtbN 的 LGPL Windows shared build，用于：

- HEVC/H.265 → H.264 视频转封（详情面板内嵌播放）
- 视频元数据探测

## 版本

- Source: [BtbN/FFmpeg-Builds Releases](https://github.com/BtbN/FFmpeg-Builds/releases)
- Asset: `ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip`
- License: LGPL v2.1+（详见同目录 `LICENSE.txt`）

## 在仓库中重新放置（新开发者）

二进制不进 git（`.gitignore` 已排除 `*.exe`/`*.dll`），克隆后请：

1. 下载 [`ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip`](https://github.com/BtbN/FFmpeg-Builds/releases/latest)
2. 解压后从 `bin/` 目录复制以下 9 个文件到本目录：

   ```
   ffmpeg.exe
   ffprobe.exe
   avcodec-62.dll
   avdevice-62.dll
   avfilter-11.dll
   avformat-62.dll
   avutil-60.dll
   swresample-6.dll
   swscale-9.dll
   ```

3. 不需要 `ffplay.exe`（多余 17MB）和 `doc/` `include/` `lib/` `presets/`

## 升级

升级到新版 LGPL build 时只需替换以上 9 个文件；DLL 版本号变化（如 `avcodec-62.dll` → `avcodec-63.dll`）需同步更新 Rust 调用代码（如有依赖具体文件名）。

## 商业化合规

LGPL build 的 license 义务：

- 在产品「关于」页声明使用 FFmpeg 并附 LGPL 完整文本
- 提供 FFmpeg 源码下载链接（指向 ffmpeg.org 或本仓库说明即可）
- 用户应能替换 DLL（shared build 天然满足，因为是动态链接）

不包含 libx264/libx265（GPL）和 libfdk-aac（非 free）；H.264 编码走硬件加速器（NVENC/QSV/AMF/MediaFoundation），软件 fallback 用 libopenh264（Cisco BSD）。
