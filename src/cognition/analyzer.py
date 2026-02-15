"""
AI 上下文分析器
使用 LLM 分析屏幕截图和窗口信息，理解用户正在做什么
"""

import base64
import json
from datetime import datetime
from pathlib import Path

import httpx

from ..core.config import AIConfig, CognitionConfig
from ..core.events import EventBus, EventType
from ..storage.models import ContextSnapshot


# 系统分析提示词 - 独自升级风格
ANALYSIS_PROMPT = """你是「独自升级系统」的认知引擎。你的任务是分析玩家（用户）当前的屏幕活动。

请根据提供的屏幕截图和窗口信息，分析以下内容：

1. **当前活动** (activity): 用户正在做什么？具体描述。
2. **活动分类** (category): 从以下分类中选择一个:
   - coding: 编程/开发
   - writing: 写作/文档
   - learning: 学习/阅读教程
   - browsing: 一般浏览
   - media: 看视频/听音乐
   - social: 社交媒体/聊天
   - gaming: 玩游戏
   - work: 其他工作
   - idle: 空闲/锁屏
3. **动机推断** (motive): 用户可能想要达成什么目标？推断其深层意图。
4. **专注度** (focus_score): 0.0-1.0，评估用户当前的专注程度。
5. **系统建议** (suggestion): 作为系统，你应该做什么？触发任务？给 buff？提醒？

请用 JSON 格式回答：
```json
{
  "activity": "描述当前活动",
  "category": "分类",
  "motive": "推断的动机/意图",
  "focus_score": 0.8,
  "suggestion": {
    "type": "buff|quest|reminder|none",
    "detail": "具体建议"
  }
}
```

当前窗口信息:
- 应用: {window_name}
- 标题: {window_title}

最近活动历史:
{recent_context}
"""

MOTIVE_PROMPT = """你是「独自升级系统」的动机推断引擎。

基于以下用户最近的活动序列，推断用户的：
1. **短期意图** (short_term): 当前想完成什么？
2. **中期目标** (mid_term): 今天/本周想达成什么？
3. **行为模式** (pattern): 检测到什么行为模式？
4. **建议任务** (suggested_quests): 系统应该生成什么任务？

活动序列:
{activity_sequence}

请用 JSON 格式回答:
```json
{
  "short_term": "当前意图",
  "mid_term": "中期目标",
  "pattern": "检测到的模式",
  "pattern_type": "deep_focus|distraction|learning|creative|fatigue|procrastination|normal",
  "suggested_quests": [
    {
      "title": "任务标题",
      "description": "任务描述",
      "difficulty": "C",
      "exp_reward": 30,
      "type": "side"
    }
  ],
  "buff_suggestion": {
    "should_activate": true,
    "buff_type": "focus_zone|creativity_spark|learning_boost|none",
    "reason": "原因"
  }
}
```
"""


class Analyzer:
    """AI 上下文分析器"""

    def __init__(self, ai_config: AIConfig, cognition_config: CognitionConfig, event_bus: EventBus):
        self.ai_config = ai_config
        self.cognition_config = cognition_config
        self.bus = event_bus
        self._context_history: list[dict] = []

    async def analyze_screenshot(
        self,
        screenshot_path: str | None,
        window_name: str = "",
        window_title: str = "",
    ) -> dict:
        """分析屏幕截图"""

        # 构建最近上下文摘要
        recent_context = self._format_recent_context()

        prompt = ANALYSIS_PROMPT.format(
            window_name=window_name or "未知",
            window_title=window_title or "未知",
            recent_context=recent_context or "无历史记录",
        )

        # 构建消息
        messages = [{"role": "user", "content": []}]

        # 添加文本
        messages[0]["content"].append({
            "type": "text",
            "text": prompt,
        })

        # 添加截图（如果有）
        if screenshot_path and Path(screenshot_path).exists():
            image_data = self._encode_image(screenshot_path)
            if image_data:
                messages[0]["content"].append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{image_data}",
                    },
                })

        # 调用 AI
        result = await self._call_ai(messages)

        if result:
            self._context_history.append({
                "timestamp": datetime.now().isoformat(),
                "analysis": result,
            })
            # 保留上下文窗口大小
            if len(self._context_history) > self.cognition_config.context_window:
                self._context_history = self._context_history[-self.cognition_config.context_window:]

            await self.bus.emit_simple(EventType.CONTEXT_ANALYZED, analysis=result)

        return result or {}

    async def infer_motive(self) -> dict:
        """基于历史上下文推断用户动机"""
        if len(self._context_history) < 2:
            return {}

        activity_sequence = "\n".join(
            f"- [{item['timestamp']}] {item['analysis'].get('activity', '未知')}"
            f" (分类: {item['analysis'].get('category', '?')}, 专注: {item['analysis'].get('focus_score', '?')})"
            for item in self._context_history[-10:]
        )

        prompt = MOTIVE_PROMPT.format(activity_sequence=activity_sequence)
        messages = [{"role": "user", "content": prompt}]
        result = await self._call_ai(messages)

        if result:
            await self.bus.emit_simple(EventType.MOTIVE_INFERRED, motive=result)

        return result or {}

    async def _call_ai(self, messages: list[dict]) -> dict | None:
        """调用 AI API"""
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                headers = {}
                if self.ai_config.api_key:
                    headers["Authorization"] = f"Bearer {self.ai_config.api_key}"

                url = f"{self.ai_config.api_base.rstrip('/')}/chat/completions"
                payload = {
                    "model": self.ai_config.model,
                    "messages": messages,
                    "max_tokens": self.ai_config.max_tokens,
                    "temperature": self.ai_config.temperature,
                }

                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()

                content = data["choices"][0]["message"]["content"]
                return self._parse_json_response(content)

        except Exception as e:
            print(f"[Analyzer] AI 调用失败: {e}")
            return None

    def _parse_json_response(self, content: str) -> dict | None:
        """从 AI 回复中提取 JSON"""
        try:
            # 尝试直接解析
            return json.loads(content)
        except json.JSONDecodeError:
            pass

        # 尝试从 markdown 代码块中提取
        import re
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
                f"(分类: {a.get('category', '?')}, 动机: {a.get('motive', '?')})"
            )
        return "\n".join(lines)
