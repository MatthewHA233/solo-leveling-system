"""
动机推断引擎 (独立模块)
不只是分析"用户在做什么"，而是理解"用户想做什么"
基于活动历史、时间模式、行为序列进行深度推断
"""

from datetime import datetime
from collections import Counter


class MotiveEngine:
    """动机推断引擎"""

    # 活动-动机映射规则
    ACTIVITY_MOTIVE_MAP = {
        # (类别序列模式) -> 推断动机
        ("coding", "coding", "coding"): "深度开发 — 用户正在全力推进一个编程项目",
        ("coding", "learning", "coding"): "边学边做 — 用户在学习新技术并立即实践",
        ("learning", "learning", "learning"): "系统学习 — 用户正在进行有目的的学习",
        ("coding", "writing"): "项目文档化 — 用户在为代码写文档或总结",
        ("social", "social"): "社交休息 — 用户在放松或社交",
        ("browsing", "social", "browsing"): "漫无目的浏览 — 用户可能在拖延",
        ("coding", "social", "coding"): "短暂休息后回归 — 用户自我调节能力不错",
        ("idle", "coding"): "重新开始 — 用户休息后回到工作",
    }

    # 时间段动机修正
    TIME_MOTIVES = {
        (0, 5): "深夜工作 — 可能是灵感迸发或截止日期压力",
        (5, 8): "早起工作 — 自律型人格，利用清晨高效时段",
        (8, 12): "上午工作 — 正常工作时段，精力充沛",
        (12, 14): "午间活动 — 午休或午后恢复",
        (14, 18): "下午工作 — 可能有午后倦怠",
        (18, 21): "晚间活动 — 个人时间或加班",
        (21, 24): "深夜活动 — 个人项目或娱乐",
    }

    def __init__(self):
        self._activity_history: list[dict] = []
        self._motive_history: list[dict] = []

    def add_activity(self, category: str, focus_score: float, activity: str) -> None:
        """记录一次活动"""
        self._activity_history.append({
            "category": category,
            "focus_score": focus_score,
            "activity": activity,
            "timestamp": datetime.now(),
        })
        # 保留最近 50 条
        if len(self._activity_history) > 50:
            self._activity_history = self._activity_history[-50:]

    def infer(self) -> dict:
        """推断当前动机"""
        if len(self._activity_history) < 2:
            return {
                "short_term": "数据不足，系统正在学习你的行为模式",
                "confidence": 0.1,
                "pattern": "observing",
            }

        recent = self._activity_history[-5:]
        categories = [a["category"] for a in recent]
        focus_scores = [a["focus_score"] for a in recent]
        avg_focus = sum(focus_scores) / len(focus_scores)

        # 1. 序列模式匹配
        sequence_motive = self._match_sequence(categories)

        # 2. 时间段分析
        hour = datetime.now().hour
        time_motive = ""
        for (start, end), motive in self.TIME_MOTIVES.items():
            if start <= hour < end:
                time_motive = motive
                break

        # 3. 专注度趋势
        focus_trend = self._analyze_focus_trend(focus_scores)

        # 4. 综合推断
        short_term = sequence_motive or self._basic_motive(categories[-1], avg_focus)

        # 5. 置信度
        confidence = min(1.0, len(self._activity_history) / 10 * 0.5 + avg_focus * 0.5)

        result = {
            "short_term": short_term,
            "time_context": time_motive,
            "focus_trend": focus_trend,
            "avg_focus": round(avg_focus, 2),
            "confidence": round(confidence, 2),
            "dominant_activity": Counter(categories).most_common(1)[0][0] if categories else "unknown",
            "activity_diversity": len(set(categories)),
        }

        self._motive_history.append({
            "timestamp": datetime.now(),
            "inference": result,
        })

        return result

    def _match_sequence(self, categories: list[str]) -> str:
        """匹配活动序列模式"""
        for length in range(min(len(categories), 3), 1, -1):
            seq = tuple(categories[-length:])
            if seq in self.ACTIVITY_MOTIVE_MAP:
                return self.ACTIVITY_MOTIVE_MAP[seq]
        return ""

    def _basic_motive(self, current_category: str, avg_focus: float) -> str:
        """基础动机推断"""
        motives = {
            "coding": "编程开发中" + ("，状态很好" if avg_focus > 0.7 else "，但专注度一般"),
            "writing": "写作/文档中" + ("，思路清晰" if avg_focus > 0.6 else ""),
            "learning": "学习知识中" + ("，吸收效率高" if avg_focus > 0.6 else ""),
            "work": "处理工作事务",
            "browsing": "浏览网页" + ("" if avg_focus > 0.4 else "，可能在拖延"),
            "social": "社交活动" + ("" if avg_focus > 0.3 else "，有点分心了"),
            "media": "观看/收听媒体内容",
            "gaming": "娱乐放松中",
            "idle": "空闲状态",
        }
        return motives.get(current_category, "未知活动")

    def _analyze_focus_trend(self, scores: list[float]) -> str:
        """分析专注度趋势"""
        if len(scores) < 3:
            return "数据不足"

        recent_avg = sum(scores[-3:]) / 3
        older_avg = sum(scores[:-3]) / max(len(scores) - 3, 1) if len(scores) > 3 else recent_avg

        diff = recent_avg - older_avg
        if diff > 0.15:
            return "📈 专注度上升中"
        elif diff < -0.15:
            return "📉 专注度下降中"
        elif recent_avg > 0.7:
            return "📊 保持高专注"
        elif recent_avg < 0.3:
            return "📊 持续低专注"
        else:
            return "📊 专注度稳定"

    def get_history(self) -> list[dict]:
        """获取推断历史"""
        return self._motive_history[-20:]
