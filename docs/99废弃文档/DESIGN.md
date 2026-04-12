# 独自升级系统 — 架构设计文档

> 初版：2026-02-16 | 最后更新：2026-03-07
> ⚠️ 本文档为早期架构设计，部分内容已过时。最新设计见各功能模块文档。

---

## 当前架构（实际）

```
┌────────────────────────────────────────────┐
│          macOS Agent (Swift, 本地运行)       │
│                                             │
│  Sources/App/         入口 + AgentManager   │
│  Sources/Capture/     ScreenCaptureKit 截屏  │
│  Sources/Network/     AIClient (云端 AI API) │
│  Sources/GameEngine/  游戏逻辑 (EXP/任务)    │
│  Sources/Persistence/ SwiftData (SQLite)     │
│  Sources/Overlay/     UI (昼夜表 + 悬浮面板)  │
│                                             │
│  AI: 阿里百炼 (qwen-vl-max / qwen-plus)    │
│  语音: qwen3-omni-flash                     │
│  Agent: ReAct 循环 (AgentLoop + AgentTool)  │
└────────────────────────────────────────────┘
```

与早期设想的主要差异：
- **没有后端服务器**：AI 分析直接从客户端调云端 API，不经过自建后端
- **没有 Windows/Android 客户端**：当前仅 macOS
- **用录屏而非截图送 AI**：截图攒批 → 合成视频 → 视频多模态分析
- **用 Qwen 而非 Claude**：通过阿里百炼 dashscope 调用

---

## 设计原则（仍然有效）

1. **极低资源占用** — 菜单栏常驻，后台运行，用户无感
2. **隐私优先** — 截图本地处理，不上传原图到第三方
3. **AI 分级处理** — 规则引擎零成本预分类 + AI 按需深度分析

---

## 详细设计

各功能模块的详细设计已迁移至独立文档，见 [产品愿景.md](产品愿景.md) 的功能模块索引。
