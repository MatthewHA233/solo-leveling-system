"""
成就系统
基于玩家行为解锁成就，类似独自升级里的隐藏奖励
"""

from datetime import datetime

from ..core.events import EventBus, EventType, Event
from ..core.player import PlayerManager
from ..storage.database import Database


# 成就定义
ACHIEVEMENTS = {
    # ── 任务相关 ──
    "first_quest": {
        "name": "🎯 初次觉醒",
        "description": "完成你的第一个任务",
        "category": "quest",
        "exp_reward": 20,
        "hidden": False,
    },
    "quest_10": {
        "name": "⚔️ 新手猎人",
        "description": "累计完成 10 个任务",
        "category": "quest",
        "exp_reward": 50,
        "hidden": False,
    },
    "quest_50": {
        "name": "🗡️ 老练猎人",
        "description": "累计完成 50 个任务",
        "category": "quest",
        "exp_reward": 150,
        "hidden": False,
    },
    "quest_100": {
        "name": "👑 百战不殆",
        "description": "累计完成 100 个任务",
        "category": "quest",
        "exp_reward": 300,
        "hidden": False,
    },
    "daily_streak_7": {
        "name": "📅 周打卡王",
        "description": "连续 7 天完成每日任务",
        "category": "quest",
        "exp_reward": 100,
        "hidden": False,
    },

    # ── 专注相关 ──
    "focus_30min": {
        "name": "🔥 初入心流",
        "description": "首次触发「专注领域」Buff",
        "category": "focus",
        "exp_reward": 30,
        "hidden": False,
    },
    "focus_streak_10": {
        "name": "🔥 专注大师",
        "description": "连续 10 次高专注分析",
        "category": "focus",
        "exp_reward": 100,
        "hidden": False,
    },
    "focus_streak_20": {
        "name": "🔥 心流之王",
        "description": "连续 20 次高专注分析",
        "category": "focus",
        "exp_reward": 250,
        "hidden": True,
    },

    # ── 升级相关 ──
    "level_5": {
        "name": "⬆️ 崭露头角",
        "description": "达到 Lv.5",
        "category": "level",
        "exp_reward": 80,
        "hidden": False,
    },
    "level_10": {
        "name": "⬆️ 实力不俗",
        "description": "达到 Lv.10",
        "category": "level",
        "exp_reward": 200,
        "hidden": False,
    },
    "level_25": {
        "name": "👑 S级猎人",
        "description": "达到 Lv.25",
        "category": "level",
        "exp_reward": 500,
        "hidden": True,
    },

    # ── 特殊行为 ──
    "night_owl": {
        "name": "🦉 夜行者",
        "description": "在凌晨 2-5 点仍在工作",
        "category": "special",
        "exp_reward": 15,
        "hidden": False,
    },
    "early_bird": {
        "name": "🌅 早起之鸟",
        "description": "在早上 6 点前就开始工作",
        "category": "special",
        "exp_reward": 25,
        "hidden": False,
    },
    "comeback": {
        "name": "💪 浪子回头",
        "description": "在触发拖延 debuff 后成功进入深度专注",
        "category": "special",
        "exp_reward": 60,
        "hidden": True,
    },
    "first_debuff": {
        "name": "💫 初尝苦果",
        "description": "第一次获得 debuff",
        "category": "special",
        "exp_reward": 10,
        "hidden": True,
    },
    "all_daily": {
        "name": "✅ 完美一天",
        "description": "一天内完成所有每日任务",
        "category": "special",
        "exp_reward": 50,
        "hidden": False,
    },

    # ── 被动经验 ──
    "passive_100": {
        "name": "⭐ 积少成多",
        "description": "累计获得 100 被动经验",
        "category": "passive",
        "exp_reward": 30,
        "hidden": False,
    },
    "passive_500": {
        "name": "⭐ 滴水穿石",
        "description": "累计获得 500 被动经验",
        "category": "passive",
        "exp_reward": 100,
        "hidden": False,
    },
    "passive_1000": {
        "name": "⭐ 日积月累",
        "description": "累计获得 1000 被动经验",
        "category": "passive",
        "exp_reward": 250,
        "hidden": True,
    },
}


class AchievementEngine:
    """成就系统引擎"""

    def __init__(self, player_mgr: PlayerManager, event_bus: EventBus):
        self.player_mgr = player_mgr
        self.bus = event_bus
        self._unlocked: set[str] = set()
        self._had_procrastination = False  # 追踪是否有过拖延
        self._daily_completed_today: int = 0

        # 注册事件
        self.bus.on(EventType.QUEST_COMPLETED, self._on_quest_completed)
        self.bus.on(EventType.LEVEL_UP, self._on_level_up)
        self.bus.on(EventType.BUFF_ACTIVATED, self._on_buff_activated)
        self.bus.on(EventType.DEBUFF_ACTIVATED, self._on_debuff_activated)
        self.bus.on(EventType.PATTERN_DETECTED, self._on_pattern_detected)
        self.bus.on(EventType.CONTEXT_ANALYZED, self._on_context_analyzed)

    async def _unlock(self, achievement_id: str) -> None:
        """解锁成就"""
        if achievement_id in self._unlocked:
            return
        if achievement_id not in ACHIEVEMENTS:
            return

        self._unlocked.add(achievement_id)
        ach = ACHIEVEMENTS[achievement_id]

        # 给予经验奖励
        if ach["exp_reward"] > 0:
            await self.player_mgr.gain_exp(ach["exp_reward"], source=f"achievement:{achievement_id}")

        # 推送通知
        hidden_tag = " [隐藏成就]" if ach.get("hidden") else ""
        await self.bus.emit_simple(
            EventType.NOTIFICATION_PUSH,
            notification={
                "title": f"🏆 成就解锁！{hidden_tag}",
                "message": f"{ach['name']}\n{ach['description']}\n奖励: +{ach['exp_reward']} EXP",
                "style": "achievement",
                "timestamp": datetime.now().isoformat(),
            },
        )

    async def _on_quest_completed(self, event: Event) -> None:
        total = self.player_mgr.player.total_quests_completed

        if total >= 1:
            await self._unlock("first_quest")
        if total >= 10:
            await self._unlock("quest_10")
        if total >= 50:
            await self._unlock("quest_50")
        if total >= 100:
            await self._unlock("quest_100")

    async def _on_level_up(self, event: Event) -> None:
        level = event.data.get("new_level", 0)
        if level >= 5:
            await self._unlock("level_5")
        if level >= 10:
            await self._unlock("level_10")
        if level >= 25:
            await self._unlock("level_25")

    async def _on_buff_activated(self, event: Event) -> None:
        buff_id = event.data.get("buff_id", "")
        if buff_id == "focus_zone":
            await self._unlock("focus_30min")
            # 检查浪子回头
            if self._had_procrastination:
                await self._unlock("comeback")
                self._had_procrastination = False

    async def _on_debuff_activated(self, event: Event) -> None:
        await self._unlock("first_debuff")

    async def _on_pattern_detected(self, event: Event) -> None:
        pattern = event.data.get("pattern_type", "")
        if pattern == "procrastination":
            self._had_procrastination = True

    async def _on_context_analyzed(self, event: Event) -> None:
        # 夜行者 / 早起检测
        hour = datetime.now().hour
        analysis = event.data.get("analysis", {})
        category = analysis.get("category", "idle")

        if category not in ("idle",):
            if 2 <= hour < 5:
                await self._unlock("night_owl")
            if hour < 6:
                await self._unlock("early_bird")

    def get_all(self) -> list[dict]:
        """获取所有成就列表"""
        result = []
        for ach_id, ach in ACHIEVEMENTS.items():
            unlocked = ach_id in self._unlocked
            item = {
                "id": ach_id,
                "name": ach["name"],
                "category": ach["category"],
                "exp_reward": ach["exp_reward"],
                "unlocked": unlocked,
            }
            if unlocked or not ach.get("hidden"):
                item["description"] = ach["description"]
            else:
                item["name"] = "❓ ???"
                item["description"] = "隐藏成就，满足条件后解锁"
            result.append(item)
        return result

    def get_unlocked(self) -> list[dict]:
        """获取已解锁成就"""
        return [a for a in self.get_all() if a["unlocked"]]

    def get_progress(self) -> dict:
        """获取成就进度"""
        total = len(ACHIEVEMENTS)
        unlocked = len(self._unlocked)
        return {
            "total": total,
            "unlocked": unlocked,
            "progress": round(unlocked / total, 2) if total > 0 else 0,
            "remaining": total - unlocked,
        }
