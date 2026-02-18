"""
AI 上下文分析器
使用 LLM 分析屏幕截图和窗口信息，理解用户正在做什么

设计参考:
  - Dayflow: 从截图中提取活动时间线卡片
  - 独自升级: 推断动机 → 触发游戏化响应
  - 多级分析: Level 1 规则引擎(零成本) → Level 2 AI 批量 → Level 3 深度推断
"""

import base64
import json
import re
from datetime import datetime
from pathlib import Path

import httpx

from ..core.config import AIConfig, CognitionConfig
from ..core.events import EventBus, EventType
from ..storage.models import ContextSnapshot


# ═══════════════════════════════════════════════════════════════
# Level 1: 规则引擎 — 零 AI 成本，基于窗口标题分类
# ═══════════════════════════════════════════════════════════════

WINDOW_RULES: dict[str, list[str]] = {
    "coding": [
        "visual studio code", "vscode", "intellij", "pycharm", "webstorm",
        "xcode", "android studio", "sublime text", "vim", "neovim", "nvim",
        "terminal", "iterm", "warp", "alacritty", "cursor", "windsurf",
        "github desktop", "sourcetree", "tower",
    ],
    "writing": [
        "word", "google docs", "notion", "obsidian", "typora", "bear",
        "ulysses", "scrivener", "overleaf", "latex",
    ],
    "learning": [
        "coursera", "udemy", "edx", "khan academy", "leetcode",
        "hackerrank", "duolingo", "anki",
    ],
    "browsing": [
        "chrome", "firefox", "safari", "edge", "arc", "brave",
    ],
    "media": [
        "youtube", "netflix", "bilibili", "spotify", "apple music",
        "vlc", "iina", "plex", "disney+", "hbo",
    ],
    "social": [
        "twitter", "x.com", "weibo", "discord", "slack", "telegram",
        "whatsapp", "wechat", "微信", "qq", "line", "signal",
        "instagram", "facebook", "reddit", "threads",
    ],
    "gaming": [
        "steam", "epic games", "minecraft", "genshin", "原神",
        "league of legends", "valorant", "cs2",
    ],
    "communication": [
        "mail", "outlook", "thunderbird", "gmail", "邮件", "zoom",
        "teams", "meet", "facetime", "飞书", "钉钉", "腾讯会议",
    ],
    "design": [
        "figma", "sketch", "photoshop", "illustrator", "canva",
        "blender", "cinema 4d", "after effects", "premiere",
    ],
    "reading": [
        "kindle", "books", "pdf", "calibre", "readwise",
        "pocket", "instapaper", "微信读书",
    ],
}

# 浏览器标题中的关键词 → 更精确的分类
BROWSER_TITLE_RULES: dict[str, list[str]] = {
    "coding": [
        "github.com", "github", "gitlab.com", "gitlab", "stackoverflow.com",
        "stack overflow", "npm", "pypi", "docs.python", "developer.mozilla",
        "api reference", "documentation", "codepen", "replit",
    ],
    "learning": [
        "tutorial", "教程", "course", "lecture", "lesson",
        "how to", "guide", "learn", "学习",
    ],
    "social": [
        "twitter.com", "x.com", "reddit.com", "weibo.com",
        "discord.com", "instagram.com", "facebook.com",
    ],
    "media": [
        "youtube.com", "bilibili.com", "netflix.com", "spotify.com",
        "b站", "哔哩哔哩",
    ],
    "shopping": [
        "taobao", "jd.com", "amazon", "淘宝", "京东", "拼多多",
    ],
    "work": [
        "jira", "confluence", "asana", "trello", "monday.com",
        "linear", "clickup", "basecamp",
    ],
}


def classify_by_rules(app_name: str, window_title: str) -> dict:
    """
    Level 1 规则引擎: 基于应用名和窗口标题快速分类
    零 AI 成本，毫秒级响应
    返回: {"category": str, "confidence": float, "detail": str}
    """
    app_lower = app_name.lower()
    title_lower = window_title.lower()
    combined = f"{app_lower} {title_lower}"

    # 1. 先匹配应用名
    for category, keywords in WINDOW_RULES.items():
        for kw in keywords:
            if kw in app_lower:
                # 如果是浏览器，进一步检查标题来精确分类
                if category == "browsing":
                    refined = _refine_browser_category(title_lower)
                    if refined:
                        return {
                            "category": refined,
                            "confidence": 0.75,
                            "detail": f"浏览器访问 {window_title[:50]}",
                        }
                    # 没有匹配到精确规则，返回 browsing
                    return {
                        "category": "browsing",
                        "confidence": 0.5,
                        "detail": f"浏览器: {window_title[:50]}",
                    }
                return {
                    "category": category,
                    "confidence": 0.8,
                    "detail": f"使用 {app_name}",
                }

    # 2. 匹配窗口标题
    for category, keywords in WINDOW_RULES.items():
        for kw in keywords:
            if kw in title_lower:
                return {
                    "category": category,
                    "confidence": 0.6,
                    "detail": f"标题包含 {kw}",
                }

    return {
        "category": "unknown",
        "confidence": 0.3,
        "detail": f"未识别: {app_name} - {window_title[:30]}",
    }


def _refine_browser_category(title: str) -> str | None:
    """浏览器标题精细分类"""
    for category, keywords in BROWSER_TITLE_RULES.items():
        for kw in keywords:
            if kw in title:
                return category
    return None


# ═══════════════════════════════════════════════════════════════
# Level 2: AI 截图分析 — 批量处理，理解上下文
# ═══════════════════════════════════════════════════════════════

ANALYSIS_PROMPT = """你是「独自升级系统」的认知引擎 — 一个理解用户行为和意图的 AI 系统。

## 你的任务
分析屏幕截图和窗口信息，理解用户**正在做什么**以及**为什么这么做**。

## 分析维度

### 1. 活动描述 (activity)
- 用一句话描述用户正在做什么
- 要具体：不是"在写代码"，而是"在用 Python 实现异步 HTTP 客户端"
- 如果能看到具体内容（文件名、URL、聊天对象），要提及

### 2. 活动分类 (category)
从以下选择: coding / writing / learning / browsing / media / social / gaming / work / communication / design / reading / research / meeting / idle / unknown

### 3. 动机推断 (motive)
这是最重要的部分。不只是描述行为，要推断**意图**:
- 在 GitHub 看 issue → 可能在调研技术方案
- 在 B站看编程视频 → 在学习，不算摸鱼
- 频繁切换聊天和代码 → 可能在协作开发或被打断
- 打开外卖 App → 准备吃饭了

### 4. 专注度评分 (focus_score: 0.0-1.0)
- 0.9-1.0: 深度心流状态，完全沉浸
- 0.7-0.8: 高度专注，偶尔查看参考资料
- 0.5-0.6: 中等专注，有一些切换但在正轨
- 0.3-0.4: 注意力分散，频繁切换不相关内容
- 0.0-0.2: 完全不专注/空闲

### 5. 情绪推测 (mood)
从行为推测可能的情绪状态: focused / relaxed / frustrated / bored / stressed / creative / tired

### 6. 系统建议 (suggestion)
作为"系统"，你应该做什么？
- buff: 检测到好的行为模式，给正面强化
- debuff: 检测到不良模式，温和提醒
- quest: 可以触发一个相关任务
- reminder: 需要提醒用户某些事
- none: 不需要干预，让用户继续

## 上下文信息

当前窗口:
- 应用: {window_name}
- 标题: {window_title}

规则引擎预分类: {rule_category} (置信度: {rule_confidence})

最近活动历史:
{recent_context}

当前时间: {current_time}

## 输出格式
严格 JSON，不要多余文字:
```json
{{
  "activity": "具体活动描述",
  "category": "分类",
  "motive": "推断的深层动机",
  "focus_score": 0.75,
  "mood": "focused",
  "context_tags": ["tag1", "tag2"],
  "suggestion": {{
    "type": "buff|debuff|quest|reminder|none",
    "detail": "具体建议",
    "priority": "low|medium|high"
  }}
}}
```"""


# ═══════════════════════════════════════════════════════════════
# Level 3: 深度动机推断 — 基于活动序列的长程理解
# ═══════════════════════════════════════════════════════════════

MOTIVE_PROMPT = """你是「独自升级系统」的动机推断引擎 — 核心认知模块。

## 任务
分析用户的活动时间线，推断其**深层目标**和**行为模式**。
这不是简单的"在用什么 App"，而是理解"用户想达成什么"。

## 推断层次

### 1. 即时意图 (short_term)
当前这一刻想做什么？
例: "在调试一个 API 请求问题"

### 2. 会话目标 (session_goal)
这个工作/学习 session 的目标是什么？
例: "完成后端用户认证模块"

### 3. 中期目标 (mid_term)
本周想达成什么？
例: "发布项目 v0.3.0"

### 4. 行为模式分析 (pattern)
检测以下模式:
- **deep_focus**: 连续 30min+ 在同一主题，心流状态
- **learning_loop**: 在教程/文档和实践之间交替（这是好的！）
- **distraction_drift**: 从工作逐渐滑向不相关内容
- **context_switching**: 频繁在不同项目/任务间切换（效率杀手）
- **creative_burst**: 在创作工具中持续输出
- **fatigue_signal**: 活动减少 + 无目的浏览（可能累了）
- **procrastination**: 反复打开又关闭工作应用
- **research_mode**: 大量浏览相关资料（准备阶段）
- **collaboration**: 代码 + 通讯交替（在和人协作）
- **normal**: 无明显模式

### 5. 任务建议 (suggested_quests)
基于分析，系统应该生成什么任务？
- 检测到学习 → 生成学习里程碑任务
- 检测到项目开发 → 生成开发子任务
- 检测到疲劳 → 生成休息/运动任务
- 检测到拖延 → 生成"首先做最简单的一步"任务

### 6. Buff/Debuff 建议
根据模式决定系统响应:
- deep_focus → 激活「专注领域」buff
- learning_loop → 激活「学习加速」buff
- distraction_drift → 温和的「注意力涣散」debuff
- fatigue_signal → 建议「战术休息」
- creative_burst → 激活「创造灵感」buff

## 活动时间线
{activity_sequence}

## 附加上下文
- 当前时间: {current_time}
- 今日已工作时长: {work_duration}
- 今日完成任务数: {quests_completed}
- 当前玩家等级: Lv.{player_level}

## 输出格式
严格 JSON:
```json
{{
  "short_term": "即时意图",
  "session_goal": "会话目标",
  "mid_term": "中期目标",
  "pattern": "检测到的主要模式描述",
  "pattern_type": "deep_focus|learning_loop|distraction_drift|context_switching|creative_burst|fatigue_signal|procrastination|research_mode|collaboration|normal",
  "pattern_confidence": 0.8,
  "suggested_quests": [
    {{
      "title": "任务标题",
      "description": "描述",
      "difficulty": "C",
      "exp_reward": 30,
      "type": "side|daily|hidden"
    }}
  ],
  "buff_suggestion": {{
    "should_activate": true,
    "buff_type": "focus_zone|learning_boost|creativity_spark|rest_needed|none",
    "reason": "原因",
    "intensity": "mild|moderate|strong"
  }},
  "insight": "一句话总结对用户当前状态的理解"
}}
```"""


# ═══════════════════════════════════════════════════════════════
# Level 2 批量分析 — 一次 AI 调用分析多张截图
# ═══════════════════════════════════════════════════════════════

BATCH_ANALYSIS_PROMPT = """你是「独自升级系统」的认知引擎。以下是用户最近 {count} 张截图的窗口信息。
请一次性分析这组活动，生成一个综合摘要。

## 窗口信息序列
{window_sequence}

## 输出格式
```json
{{
  "timeline": [
    {{"time": "HH:MM", "activity": "描述", "category": "分类"}}
  ],
  "dominant_activity": "主要在做什么",
  "dominant_category": "主要分类",
  "avg_focus_estimate": 0.7,
  "flow_state": true,
  "transitions": 2,
  "summary": "一句话总结这段时间"
}}
```"""


class Analyzer:
    """AI 上下文分析器 — 多级分析引擎"""

    def __init__(self, ai_config: AIConfig, cognition_config: CognitionConfig, event_bus: EventBus):
        self.ai_config = ai_config
        self.cognition_config = cognition_config
        self.bus = event_bus
        self._context_history: list[dict] = []
        self._analysis_count: int = 0

    # ── Level 1: 规则引擎 ──────────────────────────────

    def quick_classify(self, app_name: str, window_title: str) -> dict:
        """Level 1 — 零成本规则分类"""
        return classify_by_rules(app_name, window_title)

    # ── Level 2: AI 截图分析 ───────────────────────────

    async def analyze_screenshot(
        self,
        screenshot_path: str | None,
        window_name: str = "",
        window_title: str = "",
    ) -> dict:
        """Level 2 — AI 分析单张截图 + 上下文"""
        self._analysis_count += 1

        # 先跑 Level 1 规则引擎
        rule_result = self.quick_classify(window_name, window_title)

        # 如果规则引擎高置信度且无截图，直接用规则结果
        if rule_result["confidence"] >= 0.8 and not screenshot_path:
            result = {
                "activity": rule_result["detail"],
                "category": rule_result["category"],
                "motive": "",
                "focus_score": 0.5,
                "mood": "focused" if rule_result["category"] in ("coding", "writing", "work") else "relaxed",
                "suggestion": {"type": "none", "detail": "", "priority": "low"},
                "source": "rules",
            }
            self._add_to_history(result)
            return result

        # 构建 prompt
        recent_context = self._format_recent_context()
        now = datetime.now()

        prompt = ANALYSIS_PROMPT.format(
            window_name=window_name or "未知",
            window_title=window_title or "未知",
            rule_category=rule_result["category"],
            rule_confidence=rule_result["confidence"],
            recent_context=recent_context or "无历史记录",
            current_time=now.strftime("%Y-%m-%d %H:%M (周%w)"),
        )

        # 构建消息
        messages = [{"role": "user", "content": []}]
        messages[0]["content"].append({"type": "text", "text": prompt})

        # 添加截图
        if screenshot_path and Path(screenshot_path).exists():
            image_data = self._encode_image(screenshot_path)
            if image_data:
                messages[0]["content"].append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{image_data}"},
                })

        result = await self._call_ai(messages)

        if result:
            result["source"] = "ai"
            self._add_to_history(result)
            await self.bus.emit_simple(EventType.CONTEXT_ANALYZED, analysis=result)
        else:
            # AI 失败时 fallback 到规则引擎
            result = {
                "activity": rule_result["detail"],
                "category": rule_result["category"],
                "motive": "",
                "focus_score": 0.5,
                "suggestion": {"type": "none", "detail": "", "priority": "low"},
                "source": "rules_fallback",
            }
            self._add_to_history(result)

        return result

    # ── Level 3: 深度动机推断 ──────────────────────────

    async def infer_motive(
        self,
        player_level: int = 1,
        quests_completed: int = 0,
    ) -> dict:
        """Level 3 — 基于活动序列的深度动机推断"""
        if len(self._context_history) < 3:
            return {}

        now = datetime.now()
        history = self._context_history[-15:]  # 最近 15 条

        activity_sequence = "\n".join(
            f"- [{item['timestamp']}] {item['analysis'].get('activity', '?')}"
            f" | 分类: {item['analysis'].get('category', '?')}"
            f" | 专注: {item['analysis'].get('focus_score', '?')}"
            f" | 动机: {item['analysis'].get('motive', '?')}"
            for item in history
        )

        # 估算工作时长
        if len(history) >= 2:
            first_ts = datetime.fromisoformat(history[0]["timestamp"])
            work_duration = str(now - first_ts).split(".")[0]  # HH:MM:SS
        else:
            work_duration = "未知"

        prompt = MOTIVE_PROMPT.format(
            activity_sequence=activity_sequence,
            current_time=now.strftime("%Y-%m-%d %H:%M"),
            work_duration=work_duration,
            quests_completed=quests_completed,
            player_level=player_level,
        )

        messages = [{"role": "user", "content": prompt}]
        result = await self._call_ai(messages)

        if result:
            await self.bus.emit_simple(EventType.MOTIVE_INFERRED, motive=result)

        return result or {}

    # ── Level 2 批量: 一次分析多张截图 ─────────────────

    async def batch_analyze(self, window_sequence: list[dict]) -> dict:
        """Level 2 批量 — 一次 AI 调用分析多个窗口快照"""
        if not window_sequence:
            return {}

        formatted = "\n".join(
            f"- [{w.get('time', '?')}] 应用: {w.get('app', '?')} | 标题: {w.get('title', '?')}"
            for w in window_sequence
        )

        prompt = BATCH_ANALYSIS_PROMPT.format(
            count=len(window_sequence),
            window_sequence=formatted,
        )

        messages = [{"role": "user", "content": prompt}]
        return await self._call_ai(messages) or {}

    # ── 内部方法 ────────────────────────────────────────

    def _add_to_history(self, result: dict) -> None:
        """添加到上下文历史"""
        self._context_history.append({
            "timestamp": datetime.now().isoformat(),
            "analysis": result,
        })
        max_size = self.cognition_config.context_window
        if len(self._context_history) > max_size:
            self._context_history = self._context_history[-max_size:]

    async def _call_ai(self, messages: list[dict]) -> dict | None:
        """调用 AI API (Anthropic Messages 格式)"""
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                headers = {
                    "x-api-key": self.ai_config.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                    "User-Agent": "solo-leveling-system/1.0",
                }

                url = f"{self.ai_config.api_base.rstrip('/')}/messages"

                # 转换消息格式: OpenAI → Anthropic Messages
                anthropic_messages = []
                for msg in messages:
                    content = msg.get("content", "")
                    if isinstance(content, str):
                        anthropic_messages.append({
                            "role": msg["role"],
                            "content": content,
                        })
                    elif isinstance(content, list):
                        # 多模态: text + image
                        anthropic_content = []
                        for block in content:
                            if block.get("type") == "text":
                                anthropic_content.append({
                                    "type": "text",
                                    "text": block["text"],
                                })
                            elif block.get("type") == "image_url":
                                # OpenAI image_url → Anthropic source
                                data_url = block["image_url"]["url"]
                                # data:image/jpeg;base64,xxx
                                if data_url.startswith("data:"):
                                    parts = data_url.split(",", 1)
                                    media_type = parts[0].split(":")[1].split(";")[0]
                                    b64_data = parts[1]
                                    anthropic_content.append({
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": media_type,
                                            "data": b64_data,
                                        },
                                    })
                        anthropic_messages.append({
                            "role": msg["role"],
                            "content": anthropic_content,
                        })

                payload = {
                    "model": self.ai_config.model,
                    "messages": anthropic_messages,
                    "max_tokens": self.ai_config.max_tokens,
                    "temperature": self.ai_config.temperature,
                }

                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()

                # Anthropic 响应格式: data.content[0].text
                content = data["content"][0]["text"]
                return self._parse_json_response(content)

        except Exception as e:
            print(f"[Analyzer] AI 调用失败: {e}")
            return None

    def _parse_json_response(self, content: str) -> dict | None:
        """从 AI 回复中提取 JSON"""
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass

        json_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', content, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass

        print(f"[Analyzer] 无法解析 AI 响应: {content[:200]}")
        return None

    def _encode_image(self, path: str) -> str | None:
        """将图片编码为 base64"""
        try:
            with open(path, "rb") as f:
                return base64.b64encode(f.read()).decode("utf-8")
        except Exception as e:
            print(f"[Analyzer] 图片编码失败: {e}")
            return None

    def _format_recent_context(self) -> str:
        """格式化最近上下文"""
        if not self._context_history:
            return ""
        lines = []
        for item in self._context_history[-5:]:
            a = item["analysis"]
            lines.append(
                f"[{item['timestamp']}] {a.get('activity', '?')} "
                f"(分类: {a.get('category', '?')}, 动机: {a.get('motive', '?')}, "
                f"专注: {a.get('focus_score', '?')})"
            )
        return "\n".join(lines)

    def get_stats(self) -> dict:
        """获取分析器统计"""
        return {
            "total_analyses": self._analysis_count,
            "context_history_size": len(self._context_history),
            "last_analysis": self._context_history[-1] if self._context_history else None,
        }
