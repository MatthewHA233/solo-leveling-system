# 昼夜表 (DayNightChart) — 设计文稿

> 系统根基组件，所有优化都应围绕昼夜表展开
> 持续更新中

---

## 当前实现

- 24列 × 12行 Canvas 渲染，每格 5 分钟
- 活动迹线：彩色竖线段 + 焊点节点 + 悬浮光晕
- 收起/展开：默认当前±8小时，展开全天 24 列
- 数据源：ActivityCardRecord → ChronosActivityConverter → ChronosActivity
- 右栏：点击格子显示 ChronosCellDetailView

## 核心问题

### 1. AI 输出语无伦次、碎片化

**根因：AI 看屏幕 ≠ 人看屏幕**

人的注意力是选择性的 — 屏幕上 50 个按钮，人只盯着编辑器那一行代码。
但 AI 会把所有东西都描述一遍，导致：

- **碎片化**：明明一直在写代码，被拆成"编辑文件A"、"查看终端"、"浏览 GitHub" 三张卡片
- **误判主线**：看到浏览器标签就以为切换了任务
- **冗余描述**：detailedSummary 塞满无关细节，真正做的事被淹没
- **误判新任务**：AI 把背景窗口当成独立任务

**本质：AI 缺乏「注意力焦点」概念**

人看一个界面，80% 注意力在一个区域。AI 是均匀扫描。
所以 AI 很容易因为细枝末节写出一大堆东西，但并非主人真正在做的事。

很多软件界面进入眼睛的时候，人的注意力并非把所有按钮都看一遍。
AI 却什么都会说，导致很容易误判主线、误判出很多新任务，
无法得知主人其实一直只在做一件事。

### 2. Qwen 时间感知不如 Gemini

切换到 Qwen 后，活动卡片的时间感知变差了。
可能原因：
- 提示词从给真实时间戳改为视频秒数（需要验证是否是这个导致的）
- Qwen 对视频帧的理解能力本身就不如 Gemini
- 需要对比测试

### 3. 缺乏直观的视频-时间映射展现

目前昼夜表的格子是纯色块 + 文字，看不到"那个时刻屏幕上到底是什么"。
用户点一个格子，应该能直接看到那一刻的截屏/视频画面。

## 布局设计

### 收缩状态（默认）

核心视图，展示**当前时刻附近 2 小时**的截屏缩略图矩阵。

```
4 列 × 6 行 = 24 格
2 列 = 1 小时 → 每列 = 30 分钟
6 行 → 每行 = 5 分钟
覆盖范围：上一个小时 + 当前小时（共 2 小时）
```

**单元格**：
- 比例按 macOS 屏幕比例（约 16:10）
- 背景 = 该时间点的截屏缩略图
- 上方叠加活动迹线、焊点等信息层

视觉效果：一眼就能看到最近 2 小时每 5 分钟的屏幕画面流。
左侧栏（状态/任务/设置）正常显示。

### 展开状态

展示全天 24 小时（48 列 × 6 行）。

- **当前时间节点始终保持在视野中间**（而非左边缘）
- 滚动到任意时段查看历史截屏
- 左侧栏收起，腾出空间

### 切换逻辑

- 收缩 → 展开：侧栏把手点击，展开后自动滚动到当前时间居中
- 展开 → 收缩：侧栏把手点击，回到只显示近 2 小时

---

## 设计方向

### 方向 A：截屏缩略图作为单元格背景 ✅ 确认

每个 5 分钟格子的背景 = 该时间点的截屏缩略图。
一眼就能看到一整天的屏幕变化流。

- 从 screenshots 目录加载对应时间段的截图，缩放到格子大小
- 迹线和焊点画在缩略图上方
- 收缩状态下是主要信息载体

### 方向 B：集成视频播放器

点击昼夜表的某个区域，右栏弹出视频播放器，播放那段时间的延时摄影。
播放进度与昼夜表联动 — 播放到哪一秒，昼夜表上对应的格子高亮。

### 方向 C：AI 提示词根治

重新设计 Phase 1 (视频转录) 提示词：
- 不要"仔细观察每一帧"，而是"判断用户的注意力焦点"
- 倾向合并而非拆分 — 同一个项目/同一件事不要拆成多张卡片
- 区分"前台活动"和"背景窗口"
- 对"主人一直在做一件事"的情况，要能识别出来

### 方向 D：实时活动流（不等 AI）

AI 分析有延迟（要等活跃期结束 + API 调用）。
昼夜表应该有实时层：基于规则引擎的即时分类（RuleClassifier 已有），
在 AI 结果回来之前就显示"正在做什么"。

## 待讨论

- [ ] 展开状态的列数：48列（每列30分钟）还是保持24列（每列1小时）？
- [ ] 缩略图加载性能优化方案
- [ ] Qwen vs Gemini 对比测试
- [ ] AI "一件事"合并策略
- [ ] 方向 B/C/D 优先级

---

# 暗影智能体 (Shadow Agent) — AI 对话系统设计

> 将右栏系统日志面板改造为真正的 AI 智能体对话界面
> 类似 Claude Code 的交互模式：理解上下文、调度 Skills、自适应决策

---

## 核心思想

当前系统日志栏（OmniscienceLogView）只是被动的事件流——截图了、分类了、加经验了。
这很"系统"但很"废物"，因为它不能：

- 接受指令（"帮我重新整理今天的卡片"）
- 理解上下文（用户此刻在做什么，该如何分析）
- 主动行动（发现卡片碎片化了，自动合并）
- 解释自己（"我为什么把这段归类为 coding"）

**目标：把日志栏升级为一个有自主判断力的 AI 智能体**，既保留底层系统日志的"硬核感"，
又能像 Claude Code 那样接受自然语言指令、调度各种能力。

---

## 架构：双层面板

```
┌─────────────────────────────────────┐
│  暗影智能体                    [⚙]  │  ← 顶栏：标题 + 设置
├─────────────────────────────────────┤
│                                     │
│  🤖 已整理今日 12 张卡片 → 4 张     │  ← AI 对话气泡
│                                     │
│  用户：帮我看看下午都在干嘛          │  ← 用户输入
│                                     │
│  🤖 下午 2:00-5:30 你一直在用       │
│     Claude Code 开发 SoloAgent      │
│     的视频播放功能，中间 3:15        │
│     刷了 10 分钟微博。              │
│     [查看详情] [跳转昼夜表]         │  ← 可交互的卡片
│                                     │
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│  ▸ 系统日志                    [∧]  │  ← 折叠式底层日志
│  21:30:01 📷 截图 #847 [Cursor]     │
│  21:30:01 🏷 coding (0.8) rule      │
│  21:30:02 🤖 POST gemini-3-flash    │
│  21:30:05 ✅ 转录完成 3 段          │
│  21:30:06 🤖 POST qwen3.5-plus      │
│  21:30:09 ✅ 卡片生成 1 张          │
│  21:30:09 ⚡ +15 EXP (coding)       │
├─────────────────────────────────────┤
│  [💬 输入指令...]            [发送]  │  ← 输入栏
└─────────────────────────────────────┘
```

### 上层：AI 对话区

- 对话气泡形式，支持 Markdown 渲染
- AI 回复中可嵌入可交互元素：跳转昼夜表、展开卡片详情、播放视频片段
- 支持流式输出（token by token，和 BatchDetailView 中已有的流式一致）

### 下层：系统日志区

- 折叠式，默认收起只显示 1-2 行最新日志
- 展开后显示真正的底层日志：API 调用、截图事件、分类结果、EXP 计算
- 日志级别颜色区分：截图=蓝、AI调用=青、错误=红、EXP=绿
- 这层保留现有 OmniscienceLogView 的核心逻辑，但增加 AI API 调用细节

### 底部：输入栏

- 自然语言输入框
- 支持 `/` 前缀快捷命令（类似 Claude Code 的 slash commands）
- 输入时显示命令自动补全

---

## Skills 系统

智能体通过 Skills（技能）来执行具体操作。每个 Skill 是一个独立的能力单元。

### 内置 Skills

| Skill | 触发方式 | 实现 | 说明 |
|-------|---------|------|------|
| `/analyze` | 自然语言 or 命令 | `BatchManager.reanalyzeBatch()` | 重新分析指定批次 |
| `/regenerate` | 自然语言 or 命令 | `BatchManager.regenerateCards()` | 用缓存转录重新生成卡片 |
| `/reorganize` | 自然语言 or 命令 | `BatchManager.reorganizeTodayCards()` | 整理今日所有卡片 |
| `/summary` | 自然语言 or 命令 | 新增 | 生成今日/指定时段的活动总结 |
| `/focus` | 自然语言 or 命令 | 新增 | 分析专注度趋势，给出建议 |
| `/quest` | 自然语言 or 命令 | `QuestEngine` | 查看/管理任务 |
| `/config` | 命令 | `AgentConfig` | 查看/修改配置 |
| `/status` | 命令 | `AgentManager` | 系统状态诊断 |
| `/ask` | 自然语言 | 通用对话 | 自由问答，关于今日活动的任何问题 |

### Skill 执行流程

```
用户输入 "帮我整理一下今天的卡片"
       │
       ▼
┌─ Intent Recognition（意图识别）──┐
│  本地规则匹配 → 命中 "reorganize" │
│  or AI 意图分类 → skill 路由     │
└──────────────┬───────────────────┘
               │
       ▼
┌─ Skill Executor ────────────────┐
│  1. 显示 "正在整理..." 状态     │
│  2. 调用 BatchManager 方法      │
│  3. 流式输出 AI 处理过程        │
│  4. 返回结果 + 可操作按钮       │
└──────────────┬───────────────────┘
               │
       ▼
┌─ Response Formatter ────────────┐
│  格式化为对话气泡               │
│  嵌入：卡片数变化、时间线预览   │
│  底部：[撤销] [查看详情]        │
└─────────────────────────────────┘
```

---

## 上下文感知引擎 — 核心创新

### 问题

当前 Phase 1 提示词是写死的：`PromptTemplates.videoTranscriptionPrompt()`。
AI 模型看到终端画面就说"用户在操作终端"，完全不理解那其实是 Claude Code 对话。

**根因：提示词缺乏上下文注入。**

### 解决方案：Context Advisor

智能体在 Phase 1 转录之前，先基于已有信息构建「上下文提示」注入到提示词中：

```
┌─ Context Advisor ───────────────────────────────────────┐
│                                                         │
│  信号源：                                               │
│  ├─ RuleClassifier 实时分类结果                         │
│  │   → "当前在 Terminal.app, 窗口标题含 ccrun"          │
│  │                                                     │
│  ├─ 最近 N 张卡片的 pattern                             │
│  │   → "过去 2 小时都在 coding 类别"                    │
│  │                                                     │
│  ├─ 主线目标 (mainQuest)                                │
│  │   → "开发独自升级系统"                               │
│  │                                                     │
│  ├─ 用户偏好/历史修正                                   │
│  │   → "ccrun/claude-code 终端 = AI 编程对话"           │
│  │   → "Cursor 里打开的是 SoloAgent 项目"               │
│  │                                                     │
│  └─ 当前窗口元数据                                      │
│      → bundleId, windowTitle, 前台应用                  │
│                                                         │
│  输出：contextHint (注入 Phase 1 提示词的额外段落)      │
│                                                         │
│  示例输出：                                             │
│  "注意：用户当前主要在使用 Claude Code (ccrun 启动器)   │
│   进行 AI 辅助编程。终端中的内容是用户与 AI 的对话，    │
│   不是普通的命令行操作。用户正在开发的项目是             │
│   SoloAgent（独自升级系统的 macOS 客户端）。             │
│   请将相关活动理解为'AI 辅助开发 SoloAgent'，           │
│   而非'操作终端'或'浏览文本'。"                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### contextHint 注入点

```swift
// PromptTemplates 新增参数
static func videoTranscriptionPrompt(
    videoDurationSeconds: Int,
    frameTimeMapping: String = "",
    contextHint: String = ""        // ← 新增
) -> String {
    // ... 现有内容 ...
    // 在任务说明之前注入上下文：
    """
    \(contextHint.isEmpty ? "" : """
    ## 重要上下文（来自系统观察）
    \(contextHint)
    请基于以上上下文来理解视频中的活动。
    """)
    """
}
```

### 用户修正机制

当用户发现 AI 误判，可以直接对智能体说：

> "以后看到 ccrun 的终端就是我在用 Claude Code 写代码"

智能体将这条规则保存到 `contextRules`（持久化），以后每次构建 contextHint 时自动包含。

```swift
struct ContextRule: Codable {
    let pattern: String      // "ccrun" / "Terminal 标题含 claude"
    let interpretation: String // "用户在用 Claude Code 进行 AI 辅助编程"
    let createdAt: Date
}
```

---

## 自适应分析策略

### 当前问题

每个批次都用完全相同的提示词分析，不管用户这 5 分钟是在写代码还是在看视频。
这导致 AI 花大量 token 描述不需要描述的内容。

### 解决方案：Adaptive Strategy

智能体根据 RuleClassifier 的实时分类结果，决定分析策略：

```
场景 A: 过去 5 分钟都在同一个编辑器里
  → 策略: "轻量转录" — 只需确认还在同一个任务，不需详细描述每个操作
  → 效果: 省 token，减少碎片化

场景 B: 频繁切换应用（编辑器→浏览器→终端→编辑器）
  → 策略: "标准转录" — 逐段描述
  → 效果: 正常详细度

场景 C: 进入了从未见过的应用
  → 策略: "探索转录" — 详细描述 UI 布局和内容
  → 效果: 帮助理解新的活动类别

场景 D: 长时间 idle 后恢复
  → 策略: "恢复转录" — 重点关注用户回来后做的第一件事
  → 效果: 准确标记休息结束的边界
```

---

## 数据流重构

```
UnifiedSystemView
  ├─ 左栏: VesselMatrix / Directives / Settings
  ├─ 中央: DayNightChartView / ExpandedVideoPlayer
  └─ 右栏: ← 重构
       ├─ 选中批次时: BatchDetailView (保持不变)
       └─ 未选中时: ShadowAgentView (替代 OmniscienceLogView)
              ├─ AgentChatView (对话区)
              │    ├─ ChatBubble[] (消息列表)
              │    └─ ChatInputBar (输入框 + 命令补全)
              ├─ SystemLogView (折叠式底层日志)
              │    └─ 复用 OmniscienceLogView 核心逻辑
              └─ ContextAdvisorBadge (当前上下文状态指示)
```

### 新增文件（预估）

| 文件 | 位置 | 职责 |
|------|------|------|
| `ShadowAgentView.swift` | `Overlay/Views/` | 智能体主面板 |
| `AgentChatView.swift` | `Overlay/Views/` | 对话区视图 |
| `ChatInputBar.swift` | `Overlay/Views/` | 输入框 + 命令补全 |
| `ShadowAgent.swift` | `App/` | 智能体核心逻辑 |
| `ContextAdvisor.swift` | `Analysis/` | 上下文感知引擎 |
| `SkillRegistry.swift` | `App/` | Skill 注册与路由 |
| `AgentChatStore.swift` | `Persistence/` | 对话历史持久化 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `UnifiedSystemView.swift` | 右栏：OmniscienceLogView → ShadowAgentView |
| `AgentManager.swift` | 持有 ShadowAgent 实例，暴露 skill 调用 |
| `BatchManager.swift` | 接受 contextHint 参数 |
| `PromptTemplates.swift` | 所有 prompt 新增 contextHint 注入 |
| `ActivityFeed.swift` | 新增 `.agentMessage` 类型 |

---

## 系统日志增强

现有 ActivityFeed 只推送高层事件（截图了、加经验了）。
增强后的系统日志应该展示 AI 管道的真实底层操作：

```
// 新增日志类型
enum FeedItemType {
    // ... 现有 ...
    case apiCall       // AI API 请求 (POST gemini-3-flash, 200ms)
    case apiResponse   // AI API 响应 (tokens: 1250, cost: $0.002)
    case pipeline      // 管道阶段 (Phase 1 开始, Phase 2 完成)
    case contextRule   // 上下文规则命中 (ccrun → Claude Code)
    case skillExec     // Skill 执行 (reorganize started)
}
```

日志样式：
```
21:30:01.123  📷  截图 #847               [ScreenCapture]
21:30:01.125  🏷  coding (conf=0.80)      [RuleClassifier]
21:30:01.130  📐  上下文: ccrun → AI编程   [ContextAdvisor]
21:30:02.001  🌐  POST gemini-3-flash      [AIClient]
             ↳ video: 2.3MB, prompt: 1.2k tokens
21:30:05.432  ✅  转录完成: 3 段           [Phase1]
21:30:05.440  🌐  POST qwen3.5-plus        [AIClient]
             ↳ prompt: 3.8k tokens (含上下文)
21:30:09.120  ✅  卡片生成: 1 张           [Phase2]
21:30:09.125  ⚡  +15 EXP (coding, 5min)   [ExpEngine]
```

---

## 实现优先级

### P0 — 基础框架（先让它能说话）

1. `ShadowAgentView` 替代 `OmniscienceLogView`
2. 对话 UI（气泡 + 输入框）
3. 基本 Skill 路由（`/reorganize`, `/analyze`, `/status`）
4. 系统日志折叠面板

### P1 — 上下文感知（让它聪明起来）

5. `ContextAdvisor` — 基于 RuleClassifier + 窗口元数据构建 contextHint
6. contextHint 注入 Phase 1/Phase 2 提示词
7. 用户修正规则 (`ContextRule` 持久化)

### P2 — 自适应策略（让它高效起来）

8. 分析策略自动选择（轻量/标准/探索/恢复）
9. 智能合并判断（是否应该返回空数组）
10. token 用量统计与优化

### P3 — 高级交互（让它好用起来）

11. 自然语言意图识别（不依赖 `/` 命令）
12. 对话历史持久化
13. 可操作的回复元素（跳转、播放、编辑卡片）
14. 每日/每周自动总结报告

---

## 设计哲学

**暗影君主不是一个被动的记录器，而是一个主动的 AI 伙伴。**

- 它知道主人在做什么（上下文感知）
- 它能判断什么值得记录（自适应策略）
- 它能接受指令并执行（Skills 系统）
- 它会主动汇报和建议（智能体行为）
- 它的内部运作对主人透明（底层日志）

**与 Claude Code 的类比：**

| Claude Code | 暗影智能体 |
|-------------|-----------|
| 读文件、搜索代码 | 读截图、分析视频 |
| 写代码、编辑文件 | 生成卡片、整理时间线 |
| 运行测试、构建 | 转录视频、调用 AI API |
| 理解项目上下文 | 理解用户当前活动上下文 |
| `/commit`, `/review` | `/reorganize`, `/analyze` |
| 工具调用日志 | 系统底层日志 |
