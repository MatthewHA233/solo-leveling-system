"""
经验值引擎
基于行为自动计算经验值，不只是完成任务才有经验
持续专注工作也能获得被动经验
"""

from datetime import datetime, timedelta

from ..core.events import EventBus, EventType, Event
from ..core.player import PlayerManager


# 被动经验规则: 每个分析周期根据行为给予经验
PASSIVE_EXP_RULES = {
    "coding": {"base_exp": 3, "focus_multiplier": True},
    "writing": {"base_exp": 3, "focus_multiplier": True},
    "learning": {"base_exp": 4, "focus_multiplier": True},
    "work": {"base_exp": 2, "focus_multiplier": True},
    "creative": {"base_exp": 3, "focus_multiplier": True},
    "browsing": {"base_exp": 1, "focus_multiplier": False},
    "social": {"base_exp": 0, "focus_multiplier": False},
    "media": {"base_exp": 0, "focus_multiplier": False},
    "gaming": {"base_exp": 0, "focus_multiplier": False},
    "idle": {"base_exp": 0, "focus_multiplier": False},
}

# 连续专注奖励: 连续高专注的额外经验
FOCUS_STREAK_BONUSES = {
    3: 5,     # 连续 3 次高专注: +5 EXP
    6: 15,    # 连续 6 次: +15 EXP
    10: 30,   # 连续 10 次: +30 EXP
    15: 50,   # 连续 15 次: +50 EXP
}


class ExpEngine:
    """经验值引擎"""

    def __init__(self, player_mgr: PlayerManager, event_bus: EventBus):
        self.player_mgr = player_mgr
        self.bus = event_bus
        self._focus_streak = 0          # 连续高专注次数
        self._last_streak_bonus = 0     # 上次获得奖励时的连击数
        self._total_passive_exp = 0     # 本次运行累计被动经验

        self.bus.on(EventType.CONTEXT_ANALYZED, self._on_context_analyzed)

    async def _on_context_analyzed(self, event: Event) -> None:
        """每次上下文分析后计算被动经验"""
        analysis = event.data.get("analysis", {})
        category = analysis.get("category", "idle")
        focus_score = analysis.get("focus_score", 0.0)

        # 基础被动经验
        rule = PASSIVE_EXP_RULES.get(category, {"base_exp": 0, "focus_multiplier": False})
        base_exp = rule["base_exp"]

        if base_exp <= 0:
            # 无经验活动，重置连击
            if focus_score < 0.3:
                self._focus_streak = 0
            return

        # 专注度加成
        total_exp = base_exp
        if rule["focus_multiplier"] and focus_score > 0.5:
            # 专注度 0.5-1.0 映射到 1.0-2.0 倍
            multiplier = 1.0 + (focus_score - 0.5) * 2
            total_exp = int(base_exp * multiplier)

        # 更新连击
        if focus_score >= 0.6:
            self._focus_streak += 1
        else:
            self._focus_streak = max(0, self._focus_streak - 1)

        # 连击奖励
        streak_bonus = 0
        for threshold, bonus in sorted(FOCUS_STREAK_BONUSES.items()):
            if self._focus_streak >= threshold and threshold > self._last_streak_bonus:
                streak_bonus = bonus
                self._last_streak_bonus = threshold

        if streak_bonus > 0:
            total_exp += streak_bonus
            await self.bus.emit_simple(
                EventType.NOTIFICATION_PUSH,
                notification={
                    "title": f"🔥 专注连击 x{self._focus_streak}！",
                    "message": f"连续高效专注！额外获得 {streak_bonus} EXP",
                    "style": "exp",
                    "timestamp": datetime.now().isoformat(),
                },
            )

        # 给予经验
        if total_exp > 0:
            await self.player_mgr.gain_exp(total_exp, source=f"passive:{category}")
            self._total_passive_exp += total_exp

    def get_stats(self) -> dict:
        """获取经验引擎统计"""
        return {
            "focus_streak": self._focus_streak,
            "total_passive_exp": self._total_passive_exp,
            "last_streak_bonus_at": self._last_streak_bonus,
        }
