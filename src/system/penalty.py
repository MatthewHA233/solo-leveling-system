"""
惩罚系统 (Penalty Zone)
原作中，失败完成每日任务会被传送到惩罚区域
在我们的系统中，连续多天不完成每日任务会触发惩罚

惩罚 = 更难的强制任务 + debuff + 经验惩罚
"""

from datetime import datetime, timedelta

from ..core.events import EventBus, EventType, Event
from ..core.player import PlayerManager


# 惩罚等级
PENALTY_LEVELS = {
    1: {
        "name": "⚠️ 警告",
        "description": "系统检测到你连续 1 天未完成每日任务。",
        "effect": {"debuff": None, "exp_penalty": 0},
    },
    2: {
        "name": "🏜️ 惩罚区域 — 沙漠",
        "description": "连续 2 天未完成任务。系统将你传送到了惩罚区域。完成紧急任务以逃出。",
        "effect": {"debuff": "penalty_zone_1", "exp_penalty": 0},
        "forced_quest": {
            "title": "⚡ 紧急: 逃离惩罚区域",
            "description": "在惩罚区域中生存！完成 1 小时的专注工作以逃出。",
            "difficulty": "B",
            "exp_reward": 80,
        },
    },
    3: {
        "name": "🏜️ 惩罚区域 — 毒蜈蚣沙漠",
        "description": "连续 3 天未完成任务！惩罚区域升级，全属性下降。",
        "effect": {
            "debuff": "penalty_zone_2",
            "stat_penalty": {"focus": -10, "productivity": -10, "wellness": -5},
            "exp_penalty": 50,
        },
        "forced_quest": {
            "title": "⚡ 紧急: 在毒蜈蚣沙漠中生存",
            "description": "完成 2 小时的深度工作以逃出升级后的惩罚区域！",
            "difficulty": "A",
            "exp_reward": 150,
        },
    },
    5: {
        "name": "💀 系统警告: 心脏停止倒计时",
        "description": "连续 5 天未完成任务！系统发出最终警告。如果明天仍未完成，将失去大量经验。",
        "effect": {
            "debuff": "heart_stop_warning",
            "stat_penalty": {"focus": -20, "productivity": -20, "consistency": -15, "wellness": -10},
            "exp_penalty": 200,
        },
        "forced_quest": {
            "title": "💀 最终警告: 完成所有每日任务",
            "description": "系统正在倒计时。立即完成所有每日任务以解除危机！",
            "difficulty": "S",
            "exp_reward": 300,
        },
    },
}

# 惩罚 buff 定义 (会被 buff_engine 使用)
PENALTY_BUFFS = {
    "penalty_zone_1": {
        "name": "🏜️ 惩罚区域",
        "effects": {"focus": -5, "productivity": -5},
        "is_debuff": True,
        "duration_minutes": 60,
    },
    "penalty_zone_2": {
        "name": "🏜️ 毒蜈蚣沙漠",
        "effects": {"focus": -15, "productivity": -15, "wellness": -5},
        "is_debuff": True,
        "duration_minutes": 120,
    },
    "heart_stop_warning": {
        "name": "💀 心脏停止倒计时",
        "effects": {"focus": -20, "productivity": -20, "consistency": -10},
        "is_debuff": True,
        "duration_minutes": 1440,  # 24 小时
    },
}


class PenaltySystem:
    """惩罚系统"""

    def __init__(self, player_mgr: PlayerManager, event_bus: EventBus):
        self.player_mgr = player_mgr
        self.bus = event_bus
        self._consecutive_fails: int = 0
        self._last_check_date: str = ""
        self._in_penalty_zone: bool = False

    async def check_daily_completion(self, completed_today: bool) -> dict | None:
        """检查每日任务完成情况"""
        today = datetime.now().strftime("%Y-%m-%d")
        if today == self._last_check_date:
            return None
        self._last_check_date = today

        if completed_today:
            if self._consecutive_fails > 0:
                self._consecutive_fails = 0
                self._in_penalty_zone = False
                await self.bus.emit_simple(
                    EventType.NOTIFICATION_PUSH,
                    notification={
                        "title": "✅ 惩罚解除",
                        "message": "每日任务已完成，惩罚状态已清除。继续保持！",
                        "style": "info",
                        "timestamp": datetime.now().isoformat(),
                    },
                )
            return None

        # 未完成
        self._consecutive_fails += 1

        # 找到对应惩罚等级
        penalty = None
        for level in sorted(PENALTY_LEVELS.keys(), reverse=True):
            if self._consecutive_fails >= level:
                penalty = PENALTY_LEVELS[level]
                break

        if not penalty:
            return None

        self._in_penalty_zone = True

        # 应用经验惩罚
        exp_penalty = penalty["effect"].get("exp_penalty", 0)
        if exp_penalty > 0:
            self.player_mgr.player.exp = max(0, self.player_mgr.player.exp - exp_penalty)

        # 应用属性惩罚
        stat_penalty = penalty["effect"].get("stat_penalty", {})
        for stat, value in stat_penalty.items():
            self.player_mgr.player.stats.apply_modifier(stat, value)

        # 发送通知
        await self.bus.emit_simple(
            EventType.NOTIFICATION_PUSH,
            notification={
                "title": penalty["name"],
                "message": penalty["description"],
                "style": "warning",
                "timestamp": datetime.now().isoformat(),
            },
        )

        return {
            "penalty_level": self._consecutive_fails,
            "penalty_name": penalty["name"],
            "forced_quest": penalty.get("forced_quest"),
        }

    def get_status(self) -> dict:
        return {
            "consecutive_fails": self._consecutive_fails,
            "in_penalty_zone": self._in_penalty_zone,
            "penalty_level": self._consecutive_fails,
        }
