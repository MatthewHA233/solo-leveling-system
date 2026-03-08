# 独自升级系统 — 路线图

> 最后更新：2026-03-07
> 当前阶段：macOS 原生客户端开发中

---

## ✅ 已完成

### macOS 基础框架
- [x] 菜单栏应用（MenuBarExtra，无 Dock 图标）
- [x] 浮动面板（HolographicPanel，不抢焦点，排除截图捕获）
- [x] 全域网监控窗口（⌘⇧S 切换）
- [x] 热键系统

### 感知层
- [x] ScreenCaptureKit 截屏（10 秒/帧）
- [x] 窗口标题 + 应用检测（WindowMonitorService）
- [x] 规则引擎实时分类（RuleClassifier）
- [x] 批次管理（截图攒批 → 合成视频）
- [x] 智能截屏策略（CaptureStrategy：active/idle/deepIdle/screenLocked/windowSwitched）
- [x] Context Advisor（buildContextHint，注入 Phase 1 提示词）
- [x] 用户上下文规则（ContextRule + ContextRuleStore，/rule 命令管理）

### AI 分析管线
- [x] Phase 1：视频转录（qwen-vl-max）
- [x] Phase 2：活动卡片生成（qwen-plus）
- [x] ActivityCardRecord 持久化（SwiftData）
- [x] 流式 SSE 解析（AIClient）

### 游戏引擎
- [x] 经验值 / 等级系统
- [x] Buff/Debuff 系统
- [x] 任务系统（主线 / 每日）
- [x] 事件总线

### 暗影君王智能体（ReAct 架构）
- [x] AgentLoop（推理→工具→观察循环）
- [x] AgentTool（10 个工具）
- [x] AgentMemory（滑动窗口会话记忆 + 持久化）
- [x] 语音输入/输出（qwen3-omni-flash）
- [x] `/new` 重置会话
- [x] 对话 UI（ShadowAgentView + AgentChatView + ChatInputBar）
- [x] Skills 系统（7 个：/reorganize /analyze /regenerate /status /context /rule /help）

### 昼夜表（基础版）
- [x] 24列 × 12行 Canvas 渲染，每格 5 分钟
- [x] 电路走线 + 焊点 + 辉光
- [x] 收起/展开（当前±8小时 / 全天 24 列）
- [x] 点击格子显示 ChronosCellDetailView

---

## 🚧 进行中

### 昼夜表优化
- [ ] 截屏缩略图作为单元格背景（[设计文档](昼夜表/视觉风格.md)）
- [ ] 事件标题文字显示在走线上
- [ ] 左右平移导航
- [ ] AI 提示词优化（注意力焦点、合并而非拆分）

---

## 📋 待开发（按优先级）

### P0 — 视觉回溯智能体完善
[详见设计文档](AI系统/视觉回溯智能体.md)（智能截屏已实现，待完善深层过滤）：
- [ ] 第 1 层：像素差异检测，过滤重复帧
- [ ] 第 2 层：本地小模型初筛（Apple MLX / 量化 Qwen-VL）
- [ ] 按活动切换事件触发 AI 分析，而非固定批次

### P0 — 上下文感知增强
[详见设计文档](AI系统/上下文感知.md)（ContextAdvisor 已实现，待完善）：
- [ ] 自适应分析策略（轻量/标准/探索/恢复）
- [ ] AI 提示词优化（注意力焦点、合并而非拆分）

### P1 — 动机系统
[详见设计文档](面向未来升级/动机系统.md)：
- [ ] 多维度动机定义（有魅力、有钱、技能出众……）
- [ ] 各动机独立经验值 + 等级
- [ ] AI 自动推断活动对应哪个动机
- [ ] 悬浮面板多维度辉光进度条

### P1 — 活动合并 + 昼夜表数据层
[详见设计文档](昼夜表/数据架构.md)：
- [ ] Phase 3：活动合并层（连续相同活动合并为大区块）
- [ ] Phase 4：细目提取（从 detailedSummary 提取步骤/里程碑）
- [ ] 视频播放器集成（点击格子看延时摄影）

### P2 — 管制与惩罚系统
[详见设计文档](AI系统/管制与惩罚.md)：
- [ ] 偏离主线实时检测（窗口切换秒级响应）
- [ ] 惩罚升级链（语音提醒 → 全屏推送 → 限制应用）
- [ ] AI 语音主动干预（Fish TTS 固定音色）

### P2 — 暗影君王智能体升级
[详见设计文档](AI系统/暗影君王智能体.md)（对话 UI + Skills 已实现，待完善）：
- [ ] 系统日志折叠面板（API 调用细节、pipeline 阶段）
- [ ] 对话回复中嵌入可交互元素（跳转昼夜表、展开卡片详情）

### P3 — 训练系统
[详见设计文档](AI系统/训练系统.md)：
- [ ] 体验提问（游戏/电影/会议后 AI 出题）
- [ ] 间隔重复队列

### P3 — 多设备（未来）
- [ ] iOS 推送（APNs）
- [ ] 跨设备焦点追踪

---

## 🗑️ 已废弃（早期方向）

以下为早期 Python 后端时代的计划，已随架构转向 macOS 原生而废弃：

- Python FastAPI 后端、Web Dashboard
- Windows / Android 客户端
- OpenClaw 桥接层
- 服务器端统一 AI 分析（改为客户端直接调云端 API）
