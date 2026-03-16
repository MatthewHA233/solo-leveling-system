# 战略 Buff 库

> 状态：待设计

---

## 概念

用户积累的**战略认知储备**——思维框架、行动纲领、领域知识、成长假设等。

不是游戏引擎里的临时 Buff（行为触发的短期加成），而是持久存在的"世界观"。AI 在做决策时会把这些作为背景上下文：拆解动机、生成行动目标、评估当前活动价值，都会参考 Buff 库，而不是依赖模型的泛化建议。

随着用户认知进化，Buff 库也随之更新——系统越来越了解你的思维方式。

---

## AI 如何使用

**拆解动机 → 行动目标**：

```
动机：技能出众
    ↓ 参考战略 Buff 库
        领域知识：Swift 并发 > GCD
        思维框架：费曼学习法
        成长假设：做出能用的东西比学知识更有效
    ↓ 生成行动目标
        "完成 AgentLoop 的并发重构，并向朋友解释清楚 actor 是什么"
    而不是泛化建议：
        "多学 Swift 知识" ✗
```

**评估当前活动的价值**：

```
用户在刷推特
    ↓ 参考战略 Buff 库
        行动纲领：信息输入要有意识，避免被动刷流
        成长假设：社交高成本低收益
    ↓ 判断：偏离主线，且与任何动机对齐度低
    ↓ 触发提醒（而非简单的"在刷社交媒体"）
```

**Buff 进化**：

- 用户说"我最近发现睡够 8 小时的那天效率是睡 6 小时的两倍"
- AI 提炼并存入 Buff 库
- 后续评估"今晚继续工作 vs 早点休息"时，AI 会援引这条

---

## 用户交互

用户不需要主动分类管理，AI 从日常对话中自动提炼：

- "我最近意识到……" → AI 提炼为草稿，询问确认后加入
- "以后遇到 X 就 Y" → 直接记录
- 用户否定 AI 建议 → AI 反向推断，更新储备

`/buff` 命令手动管理：
```
/buff list          — 列出所有 Buff
/buff add <内容>    — 手动添加
/buff remove <序号> — 删除
```

---

## 接入点

| 系统 | 接入方式 |
|------|---------|
| `ContextAdvisor` | Buff 库摘要注入 contextHint，Phase 1/2 AI 感知用户世界观 |
| `AgentTool` | 新增 `get_strategy_buffs()`、`add_strategy_buff()` |
| 动机系统 | 拆解动机 → 行动目标时参考 Buff 库，而非泛化策略 |
| `AgentMemory` | 独立持久化（`~/.config/solo-agent/strategy-buffs.json`），不随 `/new` 重置 |

---

## 持久化设计（草案）

```swift
struct StrategyBuff: Codable, Identifiable {
    let id: UUID
    var content: String      // 具体内容
    var source: String       // "用户手动" / "AI 从对话提炼" / "AI 从行为归纳"
    var confidence: Float    // 0-1，AI 提炼的可信度（用户确认后变 1.0）
    var usageCount: Int      // 被 AI 引用的次数
    var createdAt: Date
}
```
