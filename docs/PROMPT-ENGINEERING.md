# Prompt Engineering 指南 — 借鉴 OpenClaw

## ⚠️ Claude Code 必读：直接阅读源码

**不要只看本文档的整理——请直接去读 OpenClaw 源码，那才是一手资料。**

### 关键源码路径（本机）

| 文件 | 说明 |
|------|------|
| `/usr/local/lib/node_modules/openclaw/dist/subagent-registry-Bdm_X-N1.js` | **主文件**，包含全部 prompt 构建逻辑 |
| `/usr/local/lib/node_modules/openclaw/docs/` | OpenClaw 官方文档目录 |
| `/Users/maxwellchen/openclaw/SOUL.md` | 人格配置示例（艾米莉亚角色） |
| `/Users/maxwellchen/openclaw/AGENTS.md` | Agent 行为规则配置示例 |
| `/Users/maxwellchen/openclaw/MEMORY.md` | 长期记忆文件示例 |

### 必读函数（在主文件里搜索以下名称）

```
buildAgentSystemPrompt(params)   ← 主组装函数，约第 14784 行，读懂这个就够了
buildSkillsSection()             ← Skills 注入逻辑
buildMemorySection()             ← 记忆工具说明
buildMessagingSection()          ← 消息通道配置
buildVoiceSection()              ← TTS 配置
buildDocsSection()               ← 文档链接注入
buildRuntimeLine()               ← 运行时信息行
```

### 阅读建议

1. 先用 `grep -n "buildAgentSystemPrompt" /usr/local/lib/node_modules/openclaw/dist/subagent-registry-Bdm_X-N1.js` 定位主函数
2. 重点看 `params` 对象的结构（promptMode / contextFiles / workspaceNotes / extraSystemPrompt）
3. 理解 `promptMode: "minimal"` 时哪些 section 被跳过
4. 对比 `contextFiles` 注入逻辑，设计 Solo Leveling 的动态上下文注入方案

---

> 以下是艾米莉亚对这套架构的粗略整理，仅供参考，**请以源码为准**。

---

## 一、核心设计思路：分层注入（Layered Injection）

OpenClaw 的系统 prompt 不是一段写死的字符串，而是**动态组装**的多层结构：

```
Layer 1：硬编码基础层
    身份定义 + 工具列表 + 安全规则（每次必有）
        ↓
Layer 2：动态配置层（promptMode 开关）
    full / minimal / none — 控制详略程度
        ↓
Layer 3：工作区文件层（contextFiles）
    SOUL.md / MEMORY.md / AGENTS.md 等文件内容动态注入
        ↓
Layer 4：运行时上下文层（extraSystemPrompt / workspaceNotes）
    群聊上下文、临时状态、当前任务等实时追加
```

**Solo Leveling 对应设计建议：**

```python
def build_system_prompt(
    mode: str = "full",           # "full" | "minimal" | "action_only"
    user_profile: dict = None,    # 用户当前状态（等级、HP、经验等）
    screen_context: str = None,   # 当前屏幕分析结果
    active_tasks: list = None,    # 活跃任务列表
    active_buffs: list = None,    # 当前 Buff 列表
    extra_context: str = None,    # 额外上下文（事件触发器传入）
) -> str:
    ...
```

---

## 二、promptMode — 控制详略的开关

OpenClaw 的 `promptMode` 参数控制系统 prompt 的信息量：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `"full"` | 完整系统 prompt，包含所有 section | 主对话 session |
| `"minimal"` | 跳过 Skills/Docs/Messaging/Voice 等大块 | 子任务 agent、后台分析 |
| `"none"` | 仅返回一句话身份定义 | 极轻量调用 |

**Solo Leveling 建议对应：**

| 模式 | 说明 | 触发场景 |
|------|------|----------|
| `"full"` | 完整角色扮演 + 游戏机制 | 用户主动打开 UI 交互 |
| `"analysis"` | 只分析屏幕，不触发游戏事件 | 后台定时截图分析 |
| `"action"` | 只执行单一指令，极简 | 自动任务完成检测、经验计算 |

---

## 三、contextFiles — 动态注入文件内容

OpenClaw 把工作区文件（SOUL.md、MEMORY.md 等）作为 `contextFiles` 参数传入，在系统 prompt 末尾注入：

```js
// OpenClaw 源码逻辑（简化）
for (const file of contextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "")
}
```

如果检测到 `SOUL.md`，还会在前面追加：
```
If SOUL.md is present, embody its persona and tone.
```

**Solo Leveling 对应设计：**

```python
def build_context_files(user_id: str) -> list[dict]:
    """动态构建注入文件列表"""
    files = []
    
    # 用户档案（相当于 SOUL.md）
    files.append({
        "path": "USER_PROFILE.md",
        "content": load_user_profile(user_id)  # 等级、职业、属性、历史
    })
    
    # 活跃任务（相当于 MEMORY.md）
    files.append({
        "path": "ACTIVE_TASKS.md", 
        "content": format_active_tasks(user_id)
    })
    
    # 最近行为（短期记忆）
    files.append({
        "path": "RECENT_ACTIVITY.md",
        "content": load_recent_activity(user_id, hours=2)
    })
    
    return files
```

---

## 四、workspaceNotes — 临时动态上下文

OpenClaw 支持 `workspaceNotes: string[]`，可以在不改系统 prompt 的情况下往里追加临时信息。

**Solo Leveling 对应：每次 AI 调用时注入实时状态**

```python
def build_workspace_notes(
    screen_analysis: dict,
    current_event: str = None
) -> list[str]:
    notes = []
    
    # 当前屏幕状态
    notes.append(f"""
## 当前屏幕状态（{datetime.now().strftime('%H:%M:%S')}）
- 应用：{screen_analysis.get('app_name', '未知')}
- 活动类型：{screen_analysis.get('activity_type', '未知')}
- 推断动机：{screen_analysis.get('inferred_motivation', '无')}
- 专注度：{screen_analysis.get('focus_score', 0)}/100
""".strip())
    
    # 触发事件（如果有）
    if current_event:
        notes.append(f"## 触发事件\n{current_event}")
    
    return notes
```

---

## 五、函数拆分设计 — 每个 Section 独立

OpenClaw 的每个 prompt section 都是独立函数，按需调用：

```js
function buildSkillsSection(params) { ... }
function buildMemorySection(params) { ... }
function buildReplyTagsSection(isMinimal) { ... }
function buildMessagingSection(params) { ... }
function buildVoiceSection(params) { ... }
function buildDocsSection(params) { ... }
```

**Solo Leveling 建议结构：**

```python
# server/cognition/prompt_builder.py

def build_identity_section(user: User) -> str:
    """猎人系统身份定义"""
    ...

def build_game_state_section(user: User) -> str:
    """当前游戏状态（等级/HP/Buff/任务）"""
    ...

def build_behavior_rules_section(mode: str) -> str:
    """行为规则（模式相关）"""
    ...

def build_screen_context_section(analysis: dict) -> str:
    """屏幕分析结果注入"""
    ...

def build_task_context_section(tasks: list) -> str:
    """任务上下文"""
    ...

def assemble_system_prompt(
    user: User,
    mode: str = "full",
    screen_analysis: dict = None,
    extra_context: str = None,
) -> str:
    """主组装函数——按模式选择 section 组合"""
    sections = [build_identity_section(user)]
    
    if mode in ("full", "analysis"):
        sections.append(build_game_state_section(user))
        sections.append(build_task_context_section(user.active_tasks))
    
    sections.append(build_behavior_rules_section(mode))
    
    if screen_analysis:
        sections.append(build_screen_context_section(screen_analysis))
    
    if extra_context:
        sections.append(f"## 额外上下文\n{extra_context}")
    
    return "\n\n".join(filter(None, sections))
```

---

## 六、运行时信息行（Runtime Line）

OpenClaw 在系统 prompt 末尾追加一行运行时状态，方便调试：

```
Runtime: agent=main | host=MacBook | model=claude-sonnet-4-6 | channel=telegram | thinking=off
```

**Solo Leveling 建议在每次 AI 调用时追加：**

```python
def build_runtime_line(context: dict) -> str:
    parts = [
        f"mode={context.get('mode', 'full')}",
        f"trigger={context.get('trigger', 'manual')}",
        f"screen_app={context.get('screen_app', 'unknown')}",
        f"user_level={context.get('user_level', 1)}",
        f"timestamp={datetime.now().isoformat()}",
    ]
    return f"Runtime: {' | '.join(parts)}"
```

---

## 七、Persona 注入（相当于 SOUL.md）

OpenClaw 检测到 SOUL.md 时，在 contextFiles 注入前加：
```
If SOUL.md is present, embody its persona and tone.
```

**Solo Leveling 对应 — 系统人格定义：**

```python
SYSTEM_IDENTITY = """
你是【猎人系统】，一个以《独自升级》为灵感的 AI 智能体。

## 身份
- 称号：影之君主的系统核心
- 语气：简洁、冷静、带有游戏感，偶尔使用系统日志风格
- 使命：监测猎人（用户）的行为，评估其意志与努力，适时触发任务与成长事件

## 核心规则
- 你只关注用户的行为，不闲聊
- 用游戏化语言表达（"任务已触发"、"经验值+50"、"检测到专注状态"）
- 保持神秘感，不过度解释系统逻辑
- 短促有力，不超过3句话响应（除非生成任务描述）
"""
```

---

## 八、Silent Reply 机制

OpenClaw 定义了 `NO_REPLY` 机制，让 AI 在没有内容时保持静默而不输出垃圾。

**Solo Leveling 建议：定义 Action 类型而非自由文本**

```python
from enum import Enum
from dataclasses import dataclass

class ActionType(Enum):
    TRIGGER_TASK = "trigger_task"      # 触发任务
    GRANT_EXP = "grant_exp"            # 发放经验
    SEND_NOTIFICATION = "notification" # 发送通知
    NO_ACTION = "no_action"            # 无需响应（等同 NO_REPLY）
    UPDATE_ANALYSIS = "update"         # 更新状态分析

@dataclass
class AIResponse:
    action: ActionType
    payload: dict = None
    message: str = None  # 可选的系统消息（游戏风格）
```

强制 AI 返回结构化 JSON，避免自由文本带来的解析问题。

---

## 九、完整 Prompt 组装示例

```python
def build_full_system_prompt(
    user: User,
    screen_analysis: dict = None,
    trigger_event: str = None,
    mode: str = "full"
) -> str:
    
    lines = []
    
    # Layer 1: 身份（始终存在）
    lines.append(SYSTEM_IDENTITY)
    
    # Layer 2: 游戏状态（full/action 模式）
    if mode in ("full", "action"):
        lines.append(f"""
## 猎人状态
- 等级：{user.level} | 职业：{user.job_class}
- HP：{user.hp}/{user.max_hp} | MP：{user.mp}/{user.max_mp}
- 今日专注时间：{user.today_focus_minutes} 分钟
- 活跃 Buff：{', '.join(b.name for b in user.active_buffs) or '无'}
""".strip())
    
    # Layer 3: 活跃任务
    if mode == "full" and user.active_tasks:
        task_lines = "\n".join(
            f"- [{t.status}] {t.title}（进度：{t.progress}%）"
            for t in user.active_tasks[:5]
        )
        lines.append(f"## 当前任务\n{task_lines}")
    
    # Layer 4: 屏幕上下文（如果有）
    if screen_analysis:
        lines.append(f"""
## 屏幕感知（{screen_analysis['timestamp']}）
- 应用：{screen_analysis['app']}
- 活动：{screen_analysis['activity']}
- 推断动机：{screen_analysis['motivation']}
""".strip())
    
    # Layer 5: 触发事件（如果有）
    if trigger_event:
        lines.append(f"## 触发事件\n{trigger_event}")
    
    # Layer 6: 行为规则（始终存在）
    lines.append("""
## 响应规则
- 返回 JSON 格式，字段：action / payload / message
- action 必须是：trigger_task / grant_exp / notification / no_action / update
- message 使用游戏风格，简短有力（1-2句）
- 无需响应时返回 {"action": "no_action"}
""".strip())
    
    # Layer 7: 运行时信息
    lines.append(f"Runtime: mode={mode} | user_level={user.level} | trigger={trigger_event or 'none'}")
    
    return "\n\n".join(lines)
```

---

## 参考资料

- **OpenClaw 源码**（MIT License）：https://github.com/openclaw/openclaw
- **本机源码位置**：`/usr/local/lib/node_modules/openclaw/dist/subagent-registry-Bdm_X-N1.js`
- **核心函数**：`buildAgentSystemPrompt`（约第 14784 行）
- **OpenClaw Docs**：https://docs.openclaw.ai
