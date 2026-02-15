# 独自升级系统 (Solo Leveling System) - 系统设计文档

> "你已被选中为玩家。"

## 🎯 项目愿景

一个以《独自升级》为灵感的 AI Agent 系统，能实时感知用户的电子设备使用行为，
推断用户动机与意图，主动触发任务、给予 buff/debuff、推送系统提醒。

不是一个被动的时间追踪器，而是一个**主动的、有自我意识的系统面板**。

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────┐
│                   系统面板 (UI)                       │
│          任务列表 / 状态面板 / 通知弹窗               │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│               系统核心 (System Core)                  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 任务引擎  │  │ Buff引擎  │  │  通知/推送引擎    │  │
│  │ Quest    │  │ Buff     │  │  Notification     │  │
│  │ Engine   │  │ Engine   │  │  Engine           │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │          认知引擎 (Cognitive Engine)           │    │
│  │  动机推断 / 上下文理解 / 行为模式识别          │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              感知层 (Perception Layer)                │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 屏幕捕捉  │  │ 窗口检测  │  │  键鼠活动检测    │  │
│  │ Screen   │  │ Window   │  │  Input           │  │
│  │ Capture  │  │ Detector │  │  Monitor         │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 📊 核心概念

### 1. 玩家状态 (Player Status)

```json
{
  "player": {
    "name": "CC",
    "level": 1,
    "exp": 0,
    "exp_to_next": 100,
    "title": "觉醒者",
    "stats": {
      "focus": 50,       // 专注力 (根据实际行为动态调整)
      "productivity": 50, // 生产力
      "consistency": 50,  // 持续性
      "creativity": 50,   // 创造力
      "wellness": 50      // 健康度
    }
  }
}
```

### 2. 任务系统 (Quest System)

任务来源：
- **系统自动生成** — 基于 AI 对用户行为的分析自动创建
- **用户自定义** — 用户手动添加的目标
- **每日任务** — 类似独自升级的每日必做（运动、学习等）
- **隐藏任务** — 系统检测到特殊行为模式时触发

```json
{
  "quest": {
    "id": "quest_001",
    "type": "daily|main|side|hidden|emergency",
    "title": "完成代码项目的初始架构",
    "description": "系统检测到你正在进行新项目开发...",
    "objectives": [
      {"desc": "创建项目结构", "done": false},
      {"desc": "编写核心模块", "done": false}
    ],
    "rewards": {
      "exp": 50,
      "buffs": ["专注光环 +10%"],
      "title": null
    },
    "deadline": "2026-02-16T23:59:59",
    "difficulty": "B",  // S, A, B, C, D, E
    "source": "auto_detected",
    "context": "检测到用户在 VS Code 中创建了新项目目录"
  }
}
```

### 3. Buff/Debuff 系统

```json
{
  "buff": {
    "id": "buff_focus_zone",
    "name": "🔥 专注领域",
    "description": "连续专注工作超过 30 分钟",
    "effect": {"focus": "+20%", "exp_multiplier": 1.5},
    "duration": "until_break",
    "trigger": "continuous_focus_30min"
  }
}

{
  "debuff": {
    "id": "debuff_distraction",
    "name": "💫 注意力涣散",
    "description": "频繁在社交媒体和工作之间切换",
    "effect": {"focus": "-15%", "productivity": "-10%"},
    "duration": "10min",
    "trigger": "frequent_app_switching"
  }
}
```

### 4. 系统通知风格

```
╔══════════════════════════════════════╗
║  ⚔️  新任务已触发！                  ║
║                                      ║
║  [B级任务] 完成项目架构设计           ║
║                                      ║
║  系统检测到你正在构思新项目。         ║
║  完成初始架构可获得 50 EXP。          ║
║                                      ║
║  奖励: 50 EXP | 专注光环 Buff        ║
║  期限: 今日 23:59                    ║
║                                      ║
║  [接受]              [查看详情]       ║
╚══════════════════════════════════════╝

╔══════════════════════════════════════╗
║  ✨ Buff 激活！                      ║
║                                      ║
║  【专注领域】已激活                   ║
║  连续专注 30 分钟，进入心流状态       ║
║  效果: 专注力 +20% | 经验值 x1.5     ║
║                                      ║
║  继续保持！                          ║
╚══════════════════════════════════════╝
```

---

## 🧠 认知引擎 (核心创新)

这是区别于 Dayflow 的关键 —— 不只是"记录你做了什么"，而是"理解你想做什么"。

### 动机推断流程

```
屏幕截图 + 窗口信息 + 键鼠活动
         │
         ▼
   AI 上下文分析
   "用户在 VS Code 中打开了新项目，
    同时在浏览器搜索 'Python async best practices'"
         │
         ▼
   动机推断
   "用户正在学习异步编程，目的是应用到新项目中"
         │
         ▼
   意图映射
   ┌─ 当前意图: 学习 + 开发
   ├─ 目标推断: 完成某个异步编程项目
   ├─ 专注度评估: 高（持续在相关页面）
   └─ 建议动作: 触发学习任务 / 给予专注 buff
```

### 行为模式识别

| 模式 | 检测条件 | 系统响应 |
|------|---------|---------|
| 深度专注 | 同一应用/主题 >30min | 激活「专注领域」buff |
| 摸鱼漂移 | 社交媒体切换频繁 | 警告 + debuff |
| 学习模式 | 文档/教程浏览 + 代码实践 | 触发学习任务 |
| 创作模式 | 写作/绘画/编曲工具活跃 | 激活「创造灵感」buff |
| 疲劳征兆 | 活动减少 + 无意义浏览 | 建议休息 |
| 拖延循环 | 反复打开又关闭工作应用 | 触发「克服惰性」紧急任务 |

---

## 🛠️ 技术实现

### 技术栈

- **核心引擎**: Python 3.11+
- **AI 分析**: Claude API / Gemini API (通过 xingsuan 中转)
- **屏幕捕捉**: `mss` (跨平台截屏) + `pyautogui`
- **窗口检测**: 平台原生 API (Windows: `pywin32`, macOS: `AppKit`, Linux: `xdotool`)
- **数据存储**: SQLite (本地优先)
- **通知系统**: 跨平台桌面通知 + Web UI
- **Web 面板**: FastAPI + WebSocket (实时更新)

### 目录结构

```
solo-leveling-system/
├── docs/
│   └── DESIGN.md              # 本文档
├── src/
│   ├── core/
│   │   ├── __init__.py
│   │   ├── system.py           # 系统主循环
│   │   ├── player.py           # 玩家状态管理
│   │   ├── config.py           # 配置管理
│   │   └── events.py           # 事件总线
│   ├── perception/
│   │   ├── __init__.py
│   │   ├── screen_capture.py   # 屏幕捕捉
│   │   ├── window_detector.py  # 活动窗口检测
│   │   └── input_monitor.py    # 键鼠活动监控
│   ├── cognition/
│   │   ├── __init__.py
│   │   ├── analyzer.py         # AI 上下文分析
│   │   ├── motive_engine.py    # 动机推断引擎
│   │   └── pattern_detector.py # 行为模式检测
│   ├── system/
│   │   ├── __init__.py
│   │   ├── quest_engine.py     # 任务引擎
│   │   ├── buff_engine.py      # Buff/Debuff 引擎
│   │   ├── exp_engine.py       # 经验值与升级
│   │   └── notification.py     # 通知推送
│   ├── storage/
│   │   ├── __init__.py
│   │   ├── database.py         # SQLite 数据层
│   │   └── models.py           # 数据模型
│   ├── api/
│   │   ├── __init__.py
│   │   ├── server.py           # FastAPI 服务
│   │   └── websocket.py        # WebSocket 实时推送
│   └── ui/
│       └── web/                # Web 面板前端
│           ├── index.html
│           ├── style.css
│           └── app.js
├── config/
│   ├── default.yaml            # 默认配置
│   └── quests/                 # 预定义任务模板
│       ├── daily.yaml
│       └── achievements.yaml
├── data/                       # 运行时数据 (gitignore)
├── requirements.txt
├── pyproject.toml
└── README.md
```

### 核心循环

```python
async def system_loop():
    while True:
        # 1. 感知：捕捉屏幕 + 窗口 + 活动
        snapshot = await perception.capture()
        
        # 2. 认知：AI 分析当前上下文
        context = await cognition.analyze(snapshot)
        
        # 3. 推断：理解用户动机
        motive = await cognition.infer_motive(context, history)
        
        # 4. 检测：行为模式匹配
        patterns = pattern_detector.detect(context, motive)
        
        # 5. 响应：触发任务/buff/通知
        for pattern in patterns:
            await system.respond(pattern, player)
        
        # 6. 更新：玩家状态
        await player.update(context, patterns)
        
        # 7. 等待下一个周期 (默认 30 秒)
        await asyncio.sleep(CAPTURE_INTERVAL)
```

---

## 📐 MVP 范围 (Phase 1)

### 必须有
- [x] 项目结构与配置系统
- [ ] 屏幕截图捕捉（定时）
- [ ] AI 分析截图内容（调用 Claude/Gemini）
- [ ] 基础动机推断
- [ ] 玩家状态系统（等级、经验值、属性）
- [ ] 任务系统（自动生成 + 手动创建）
- [ ] Buff/Debuff 基础逻辑
- [ ] 桌面通知（系统原生通知）
- [ ] 简单 Web 面板查看状态

### 后续迭代
- [ ] 行为模式学习（个性化）
- [ ] 成就系统
- [ ] 每日/每周报告
- [ ] 多设备同步
- [ ] 手机端
- [ ] 社交功能（排行榜等）

---

## 🎮 独自升级元素映射

| 独自升级原作 | 系统对应 |
|-------------|---------|
| 系统面板 | Web UI 状态面板 |
| 每日任务 | 每日打卡任务（运动、学习等） |
| 紧急任务 | 检测到拖延/异常时触发 |
| 等级提升 | 经验值累积升级 |
| 称号 | 基于成就解锁 |
| Buff/Debuff | 基于行为模式激活 |
| Boss 战 | 大型项目/截止日期 |
| 影子军团 | 自动化脚本/AI 助手 |
| 猎人等级 | 用户整体能力评估 |

---

*文档版本: 0.1.0 | 创建时间: 2026-02-16*
*作者: 小光 🎀 | 为 CC 设计*
