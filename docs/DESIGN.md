# 独自升级系统 (Solo Leveling System) - 架构设计文档 v2

> "你已被选中为玩家。"

## 🎯 项目愿景

一个以《独自升级》为灵感的 AI Agent 系统。核心理念：**AI 注意力跟随用户切换设备**。

用户在 Mac 上写代码 → 切到手机刷消息 → 再回到 Windows 打游戏，系统全程感知、分析、理解动机，主动触发任务和反馈。

**不是 Dayflow 的复刻** —— Dayflow 是 macOS 单平台时间线记录器。我们的系统是**跨设备的、主动的、游戏化的 AI 伴侣**。

### 与 Dayflow 的关系

| | Dayflow | 独自升级系统 |
|---|---|---|
| **平台** | macOS only (SwiftUI) | Mac + Windows + Android |
| **核心** | 记录时间线 | 理解动机 + 主动介入 |
| **AI 用途** | 生成活动摘要 | 动机推断 + 任务触发 + 行为模式 |
| **交互** | 被动查看 | 主动通知、任务、buff/debuff |
| **游戏化** | 无 | 完整 RPG 系统 |
| **数据流** | 本地完成 | 客户端采集 → 服务器分析 |
| **借鉴** | — | 截屏流程、AI pipeline、隐私设计 |

---

## 🏗️ 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        客户端层 (Agents)                         │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  macOS Agent  │  │ Windows Agent│  │   Android Agent       │  │
│  │  (Swift)      │  │ (C#/.NET)   │  │   (Kotlin)            │  │
│  │              │  │              │  │                       │  │
│  │ • 屏幕捕捉   │  │ • 屏幕捕捉   │  │ • 屏幕捕捉 (Media     │  │
│  │ • 窗口检测   │  │ • 窗口检测   │  │   Projection)         │  │
│  │ • 应用监控   │  │ • 进程监控   │  │ • 前台应用检测         │  │
│  │ • 系统通知   │  │ • 系统通知   │  │ • 通知栏通知           │  │
│  │ • 菜单栏常驻 │  │ • 托盘常驻   │  │ • Accessibility       │  │
│  │             │  │              │  │   Service              │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         │                 │                       │              │
│         └────────────┬────┴──────────────────────┘              │
│                      │ HTTPS + WebSocket                         │
└──────────────────────┼──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│                    后端服务 (Server)                              │
│                    Python + FastAPI                               │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │  API 网关    │  │  设备管理器   │  │   认知引擎             │  │
│  │  (FastAPI)   │  │  Device Mgr  │  │   (AI Analyzer +      │  │
│  │             │  │              │  │    Motive Engine)      │  │
│  │ • REST API  │  │ • 设备注册   │  │                        │  │
│  │ • WebSocket │  │ • 心跳管理   │  │ • 截图分析 (Claude)    │  │
│  │ • 认证      │  │ • 焦点切换   │  │ • 动机推断             │  │
│  │ • 限流      │  │ • 状态同步   │  │ • 行为模式检测         │  │
│  └─────────────┘  └──────────────┘  └────────────────────────┘  │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │  游戏引擎    │  │  通知引擎     │  │   数据层              │  │
│  │             │  │              │  │                        │  │
│  │ • 任务系统  │  │ • 推送管理   │  │ • SQLite / PostgreSQL │  │
│  │ • Buff 系统 │  │ • OpenClaw   │  │ • 截图存储 (本地/S3)  │  │
│  │ • 经验系统  │  │   桥接       │  │ • 时间线数据          │  │
│  │ • 成就系统  │  │ • 多端同步   │  │ • 缓存层              │  │
│  │ • 商店系统  │  │   推送       │  │                        │  │
│  │ • 技能系统  │  │              │  │                        │  │
│  └─────────────┘  └──────────────┘  └────────────────────────┘  │
│                                                                  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│                   展示层 (Dashboard)                             │
│                   Web 面板 (轻量, 非重点)                        │
│                                                                  │
│  • 玩家状态面板       • 时间线查看                               │
│  • 任务列表           • 设备状态                                 │
│  • 每日/每周报告      • 设置页面                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📱 客户端架构 (核心重点)

客户端是系统的**眼睛和耳朵**，负责感知用户的一切行为。参考 Dayflow 的设计哲学：**轻量、低功耗、隐私优先**。

### 设计原则 (来自 Dayflow)

1. **极低资源占用** — Dayflow 只用 ~100MB RAM, <1% CPU。我们的客户端也必须做到这一点
2. **后台常驻** — 系统托盘/菜单栏/前台服务，用户无感
3. **隐私优先** — 截图只在本地短暂存在，压缩后上传，可配置保留策略
4. **断网可用** — 本地缓存，恢复网络后批量上传

### 统一客户端协议 (Agent Protocol)

不管哪个平台的客户端，都通过统一的协议和服务器通信：

```
// Agent → Server: 上报感知数据
POST /api/v1/agent/report
{
  "device_id": "cc-macbook-pro",
  "timestamp": "2026-02-16T10:30:00+08:00",
  "snapshot": {
    "screenshot_b64": "...",          // 压缩截图 (JPEG, 720p, quality=60)
    "active_window": {
      "app_name": "Visual Studio Code",
      "window_title": "main.py — solo-leveling-system",
      "bundle_id": "com.microsoft.VSCode"  // macOS
    },
    "idle_seconds": 0,                // 距上次输入的秒数
    "is_screen_locked": false,
    "battery_level": 85,              // 移动端
    "network_type": "wifi"            // 移动端
  }
}

// Server → Agent: 推送指令
WS /ws/agent/{device_id}
{
  "type": "notification",
  "payload": {
    "title": "⚔️ 新任务！",
    "body": "[B级] 完成项目架构设计",
    "actions": ["接受", "稍后"]
  }
}
```

### 各平台实现策略

#### macOS Agent (Swift, 最高优先级)

**借鉴 Dayflow 的核心**:
- `ScreenCaptureKit` / `CGWindowListCreateImage` 截屏
- `NSWorkspace.shared.frontmostApplication` 检测前台应用
- `CGEvent` 监控用户活动 (检测空闲)
- Menu Bar 常驻 (SwiftUI `MenuBarExtra`)
- `UserNotifications` 系统通知

```
Dayflow 的 AI Pipeline:
  Video → Extract Frames → AI Description → Merge → Timeline Cards

我们的 Pipeline:
  Screenshot → Compress → Upload → Server AI Analysis → Motive → Quest/Buff
```

**关键差异**: Dayflow 在本地做 AI 分析（需要本机算力或 API key），我们在服务器端统一分析（一个 API key 服务所有设备）。

#### Windows Agent (C# / .NET, 高优先级)

- `Graphics.CopyFromScreen` / `Desktop Duplication API` 截屏
- `GetForegroundWindow` + `GetWindowText` 检测前台窗口
- `GetLastInputInfo` 检测空闲
- System Tray 常驻 (`NotifyIcon`)
- Windows Toast Notification
- 打包: MSIX 或 standalone exe

#### Android Agent (Kotlin, 中优先级)

- `MediaProjection` API 截屏 (需要用户授权)
- `UsageStatsManager` 获取前台应用
- `AccessibilityService` 可选 (更详细的上下文)
- `Foreground Service` 常驻
- `WorkManager` 定时任务
- Firebase / 自建推送
- 考虑通过 **OpenClaw Node** 桥接 (已有 Android node 支持)

### 截屏策略 (来自 Dayflow 的智慧)

Dayflow 录制视频再分析。我们用截图，但要聪明地截：

```python
# 智能截屏策略
class CaptureStrategy:
    """不是死板地每 N 秒截一次，而是根据活动状态调整"""
    
    # 活跃状态: 用户在操作
    ACTIVE_INTERVAL = 30       # 每 30 秒截一次
    
    # 空闲状态: 用户可能在阅读/思考
    IDLE_INTERVAL = 120        # 每 2 分钟截一次
    
    # 深度空闲: 离开电脑
    DEEP_IDLE_INTERVAL = 300   # 每 5 分钟截一次
    
    # 窗口切换: 立即截图
    ON_WINDOW_SWITCH = True    # 切换应用时立刻截一张
    
    # 锁屏: 停止截图
    ON_SCREEN_LOCK = "pause"
```

### 截图压缩和隐私

```python
# 截图处理流程
def process_screenshot(raw_screenshot):
    # 1. 缩小分辨率 (1080p → 720p)
    resized = resize(raw_screenshot, max_width=1280)
    
    # 2. JPEG 压缩 (quality=60, 足够 AI 分析)
    compressed = jpeg_encode(resized, quality=60)
    
    # 3. 可选: 模糊敏感区域 (密码输入框等)
    if detect_sensitive_input(raw_screenshot):
        compressed = blur_region(compressed, sensitive_area)
    
    # 4. 本地短暂缓存 (上传成功后删除)
    cache_locally(compressed, ttl=3600)
    
    # 5. 上传到服务器
    upload(compressed)
    
    # 最终大小: ~30-80KB per screenshot
    # 30秒间隔 → ~100-250MB/天 (可接受)
```

---

## 🧠 认知引擎 (服务器端)

### AI 分析 Pipeline

参考 Dayflow 的多级 pipeline，但我们的分析在服务器端统一执行：

```
┌─────────────────────────────────────────────────────┐
│              AI Analysis Pipeline                    │
│                                                      │
│  Level 1: 快速分析 (每次截图)                        │
│  ├─ 窗口标题 + 应用名 → 活动分类                     │
│  ├─ 规则引擎 (不调 AI, 零成本)                       │
│  └─ 结果: "编程/浏览/娱乐/通讯/..."                  │
│                                                      │
│  Level 2: AI 分析 (每 5 分钟, 批量)                  │
│  ├─ 收集最近 10 张截图                               │
│  ├─ 一次 AI 调用分析整组                             │
│  └─ 结果: 活动摘要 + 上下文理解                      │
│                                                      │
│  Level 3: 动机推断 (每 15 分钟)                      │
│  ├─ 结合 Level 2 摘要 + 历史数据                     │
│  ├─ 推断用户当前目标和动机                           │
│  └─ 结果: 动机标签 + 置信度 + 建议动作               │
│                                                      │
│  Level 4: 每日总结 (每天结束)                        │
│  ├─ 汇总全天数据                                     │
│  ├─ 生成 Dayflow 风格时间线                          │
│  └─ 结果: 日报 + 效率分析 + 建议                     │
└─────────────────────────────────────────────────────┘
```

### 为什么分级？

Dayflow 每次分析都调 AI (2-33 次 LLM 调用 per chunk)，成本高。我们的分级策略：

- **Level 1 零成本**: 90% 的情况靠规则引擎就够了 (看窗口标题就知道在干嘛)
- **Level 2 低成本**: 批量分析，一次 AI 调用处理多张截图
- **Level 3 中成本**: 只在需要深度理解时调用
- **Level 4 日结**: 一天一次，可以用更强的模型

预估日成本: ~$0.50-$2.00 (Claude API, 通过 xingsuan 中转)

---

## 🔄 多设备协同 (核心创新)

这是我们和 Dayflow 最大的区别 —— Dayflow 只在一台 Mac 上运行，我们要跨设备。

### 设备焦点 (Device Focus)

```
系统维护一个"焦点设备"概念，代表用户当前的注意力所在：

Timeline:
  10:00 ─── [MacBook] VS Code 写代码 ──────────
  10:45 ─── [Android] 微信回消息 ──── (焦点切换到手机)
  10:50 ─── [MacBook] 继续写代码 ──── (焦点切回电脑)
  12:00 ─── [Android] 外卖 App ────── (午餐时间)
  12:30 ─── [MacBook] 回来工作 ─────
  
系统需要理解:
  - 10:45 的微信不是摸鱼，是正常通讯
  - 12:00-12:30 是合理的休息时间
  - 但如果 10:45 后手机上一直在刷 B站，那才是摸鱼
```

### 焦点切换检测

```python
class DeviceFocusManager:
    """追踪用户注意力在哪个设备上"""
    
    def determine_focus(self, reports: list[AgentReport]) -> str:
        """
        规则:
        1. 最近有输入活动的设备 = 焦点设备
        2. 如果多个设备都活跃，优先桌面端
        3. 如果所有设备都空闲 > 5min，标记为"离开"
        """
        active_devices = [r for r in reports if r.idle_seconds < 60]
        
        if not active_devices:
            return "away"
        
        # 优先返回最近有输入的设备
        return min(active_devices, key=lambda r: r.idle_seconds).device_id
    
    def on_focus_change(self, old_device, new_device):
        """焦点切换时的处理"""
        # 记录切换事件
        emit_event("device_focus_changed", old=old_device, new=new_device)
        
        # 如果从工作设备切到娱乐设备，开始计时
        if is_work_device(old_device) and is_entertainment_device(new_device):
            start_break_timer()
```

### 跨设备数据模型

```python
# 时间线条目 — 跨设备统一
class TimelineEntry:
    timestamp: datetime
    device_id: str            # 哪个设备
    device_type: str          # mac / windows / android
    activity_type: str        # coding / browsing / communication / entertainment
    app_name: str
    window_title: str
    ai_summary: str           # AI 生成的活动描述
    motive: str               # 推断的动机
    focus_score: float        # 0-1, 专注度评分
    screenshot_path: str      # 截图存储路径 (可选保留)

# 设备状态
class DeviceState:
    device_id: str
    device_name: str          # "CC 的 MacBook Pro"
    device_type: str          # mac / windows / android
    platform_version: str     # "macOS 15.2" / "Windows 11" / "Android 14"
    agent_version: str        # 客户端版本号
    last_seen: datetime       # 最后心跳时间
    is_online: bool
    is_focused: bool          # 当前是否是焦点设备
    battery_level: int        # 电量 (移动端)
```

---

## 🎮 游戏系统 (现有, 继续完善)

现有的游戏化系统已经相当完整 (v0.2.0)，继续作为后端核心：

- **玩家系统**: 等级 / 经验 / 属性 / 称号
- **任务系统**: 每日 / 主线 / 支线 / 隐藏 / 紧急
- **Buff/Debuff**: 基于行为模式自动激活
- **成就系统**: 19 个成就 (含隐藏)
- **商店系统**: 金币 + 道具
- **技能系统**: 被动 + 主动
- **惩罚区域**: 未完成每日任务的后果
- **系统消息**: 独自升级风格文案

### 独自升级元素映射

| 独自升级原作 | 系统对应 |
|-------------|---------|
| 系统面板 | 各端原生 UI + Web Dashboard |
| 每日任务 | 每日打卡 (运动、学习、编程等) |
| 紧急任务 | 拖延检测触发 |
| 等级提升 | 经验值累积 |
| 称号 | 成就解锁 |
| Buff/Debuff | 行为模式激活 |
| Boss 战 | 大型项目截止日期 |
| **影子军团** | **自动化脚本 / AI 助手** (Phase 3 核心) |
| 猎人等级 | 综合能力评估 |
| 双重觉醒 | 跨设备无缝切换 |

---

## 🛡️ 影子军团系统 (Shadow Army)

独自升级里最核心的元素之一。映射到我们的系统：

```
影子军团 = 用户的自动化能力集合

每个"影子士兵"是一个自动化任务:
  - 📧 邮件影子: 自动整理邮件、标记重要消息
  - 📅 日程影子: 监控日历、提前提醒
  - 💻 代码影子: 定时 git pull、跑测试、检查 CI
  - 📊 报告影子: 每日自动生成效率报告
  - 🔍 监控影子: 监控特定网站/服务状态

用户通过"抽取影子"(完成特定任务) 来解锁新的自动化能力
每个影子有等级，使用越多越强 (更智能的自动化)
```

---

## 📁 项目结构 (v2 目标)

```
solo-leveling-system/
├── server/                          # 后端服务
│   ├── src/
│   │   ├── core/                    # 系统核心 (现有)
│   │   ├── perception/              # 感知层 → 改为接收客户端数据
│   │   ├── cognition/               # 认知引擎 (现有 + 增强)
│   │   ├── system/                  # 游戏系统 (现有)
│   │   ├── api/                     # API 层 (现有 + 扩展)
│   │   ├── storage/                 # 数据层 (现有)
│   │   └── devices/                 # 新增: 设备管理
│   │       ├── manager.py           # 设备注册/心跳/状态
│   │       ├── focus.py             # 焦点追踪
│   │       └── sync.py             # 跨设备数据同步
│   ├── config/
│   ├── data/
│   └── requirements.txt
│
├── clients/                         # 各平台客户端
│   ├── macos/                       # macOS Agent (Swift)
│   │   ├── SoloAgent/
│   │   │   ├── App/
│   │   │   ├── Capture/             # 屏幕捕捉
│   │   │   ├── Monitor/             # 窗口/应用监控
│   │   │   ├── Network/             # 服务器通信
│   │   │   ├── Notification/        # 系统通知
│   │   │   └── UI/                  # 菜单栏 UI
│   │   └── SoloAgent.xcodeproj
│   │
│   ├── windows/                     # Windows Agent (C#)
│   │   ├── SoloAgent/
│   │   │   ├── Capture/
│   │   │   ├── Monitor/
│   │   │   ├── Network/
│   │   │   ├── Notification/
│   │   │   └── UI/                  # 系统托盘
│   │   └── SoloAgent.sln
│   │
│   └── android/                     # Android Agent (Kotlin)
│       ├── app/
│       │   ├── capture/
│       │   ├── monitor/
│       │   ├── network/
│       │   ├── notification/
│       │   └── ui/
│       └── build.gradle.kts
│
├── web/                             # Web Dashboard (轻量)
│   └── index.html                   # 单页面, 调后端 API
│
├── protocol/                        # 通信协议定义
│   ├── agent-protocol.md            # Agent ↔ Server 协议
│   └── schemas/                     # JSON Schema
│       ├── report.json
│       ├── notification.json
│       └── device.json
│
├── docs/
│   ├── DESIGN.md                    # 本文档
│   ├── ROADMAP.md                   # 路线图
│   └── DAYFLOW-NOTES.md             # Dayflow 学习笔记
│
└── README.md
```

---

## 🗓️ 开发计划 (修订)

### Phase 3: 真实感知 + 多设备基础 (v0.3.0, 当前)
- [ ] 重构: server/ 目录分离后端代码
- [ ] Agent Protocol 定义 (协议文档 + JSON Schema)
- [ ] 设备管理 API (注册/心跳/状态)
- [ ] 焦点追踪器
- [ ] AI 分析 Pipeline (Level 1-3)
- [ ] 真实截图分析 (Claude API via xingsuan)
- [ ] OpenClaw Node 桥接 (Android 可先通过 OpenClaw)

### Phase 4: macOS 客户端 (v0.4.0, 最高优先级)
- [ ] macOS Agent MVP (Swift, 参考 Dayflow)
  - 截屏 (ScreenCaptureKit)
  - 窗口检测 (NSWorkspace)
  - 菜单栏常驻 (MenuBarExtra)
  - 上报服务器
  - 接收通知
- [ ] 智能截屏策略
- [ ] 隐私模式 (暂停采集)

### Phase 5: Windows 客户端 + Android (v0.5.0)
- [ ] Windows Agent (C# / .NET)
- [ ] Android Agent (Kotlin) 或 OpenClaw Node 深度集成
- [ ] 跨设备时间线合并
- [ ] 设备切换通知

### Phase 6: 影子军团 + 智能进化 (v0.6.0)
- [ ] 影子军团系统
- [ ] 行为模式学习 (个性化适应)
- [ ] 长期目标追踪
- [ ] 智能任务推荐

### Phase 7: 终极形态 (v1.0.0)
- [ ] 完整 RPG 体验
- [ ] 副本系统
- [ ] 装备系统
- [ ] 多语言
- [ ] 开源

---

## 🔑 关键设计决策

### 1. 服务器端 AI vs 本地 AI

**选择: 服务器端**

Dayflow 让用户自己配 API key，每个设备独立分析。我们选择服务器端统一分析：
- ✅ 一个 API key 服务所有设备
- ✅ 可以做跨设备关联分析
- ✅ 客户端极简 (只负责采集)
- ✅ AI 模型升级只需改服务器
- ❌ 需要网络 (但有本地缓存兜底)
- ❌ 隐私敏感 (但服务器是自己的)

### 2. 截图 vs 录屏

**选择: 截图**

Dayflow 用录屏，但我们选截图：
- ✅ 带宽更小 (~50KB vs 几MB)
- ✅ 分析更快 (图片 vs 视频)
- ✅ 实现更简单
- ✅ 移动端更省电
- ❌ 信息密度不如视频 (但对我们的用途够了)

### 3. 客户端技术选型

**选择: 各平台原生**

不用 Electron/Flutter 之类的跨平台方案：
- ✅ 最低资源占用 (Dayflow 证明了原生的优势)
- ✅ 最好的系统集成 (截屏、通知、后台运行)
- ✅ 用户体验最好
- ❌ 开发成本高 (三套代码)
- 💡 但客户端逻辑很简单 (截屏+上传)，不需要复杂 UI

---

*文档版本: 2.