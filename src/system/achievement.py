"""
成就系统
基于玩家行为解锁成就，类似独自升级里的隐藏奖励

类别:
  - quest: 任务完成里程碑
  - focus: 专注力相关
  - level: 等级里程碑
  - special: 特殊行为
  - passive: 被动经验
  - shadow: 影子军团相关
  - device: 多设备相关
  - streak: 连续打卡
  - mastery: 技能精通
"""

from datetime import datetime

from ..core.events import EventBus, EventType, Event
from ..core.player import PlayerManager


# ═══════════════════════════════════════════════════════════════
# 成就定义 — 35 个成就
# ═══════════════════════════════════════════════════════════════

ACHIEVEMENTS = {
    # ── 任务里程碑 (6个) ──────────────────────────────
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
    "quest_500": {
        "name": "🏆 传说猎人",
        "description": "累计完成 500 个任务",
        "category": "quest",
        "exp_reward": 800,
        "hidden": True,
    },
    "s_rank_quest": {
        "name": "💎 S级突破",
        "description": "完成一个 S 级难度的任务",
        "category": "quest",
        "exp_reward": 200,
        "hidden": False,
    },

    # ── 专注力 (6个) ─────────────────────────────────
    "focus_30min": {
        "name": "🔥 初入心流",
        "description": "首次触发「专注领域」Buff",
        "category": "focus",
        "exp_reward": 30,
        "hidden": False,
    },
    "focus_streak_10": {
        "name": "🔥 专注大师",
        "description": "连续 10 次分析专注度 >0.7",
        "category": "focus",
        "exp_reward": 100,
        "hidden": False,
    },
    "focus_streak_20": {
        "name": "🔥 心流之王",
        "description": "连续 20 次分析专注度 >0.7",
        "category": "focus",
        "exp_reward": 250,
        "hidden": True,
    },
    "avg_focus_80": {
        "name": "🧘 禅定",
        "description": "单日平均专注度超过 0.8",
        "category": "focus",
        "exp_reward": 150,
        "hidden": False,
    },
    "zero_distraction_hour": {
        "name": "🛡️ 无懈可击",
        "description": "连续 3 小时没有打开任何社交/娱乐应用",
        "category": "focus",
        "exp_reward": 120,
        "hidden": False,
    },
    "deep_work_8h": {
        "name": "⚡ 超越极限",
        "description": "单日累计深度工作超过 8 小时",
        "category": "focus",
        "exp_reward": 300,
        "hidden": True,
    },

    # ── 等级里程碑 (5个) ─────────────────────────────
    "level_5": {
        "name": "⬆️ 崭露头角",
        "description": "达到 Lv.5",
        "category": "level",
        "exp_reward": 80,
        "hidden": False,
    },
    "level_10": {
        "name": "⬆️ 实力不俗",
        "description": "达到 Lv.10 — 第一次觉醒",
        "category": "level",
        "exp_reward": 200,
        "hidden": False,
    },
    "level_25": {
        "name": "👑 S级猎人",
        "description": "达到 Lv.25",
        "category": "level",
        "exp_reward": 500,
        "hidden": False,
    },
    "level_50": {
        "name": "🌟 国家级猎人",
        "description": "达到 Lv.50",
        "category": "level",
        "exp_reward": 1000,
        "hidden": True,
    },
    "level_99": {
        "name": "⚔️ 影之君主",
        "description": "达到 Lv.99 — 你已经是传说",
        "category": "level",
        "exp_reward": 5000,
        "hidden": True,
    },

    # ── 特殊行为 (6个) ──────────────────────────────
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
    "weekend_grind": {
        "name": "💼 卷王",
        "description": "周末工作超过 4 小时",
        "category": "special",
        "exp_reward": 80,
        "hidden": False,
    },

    # ── 被动经验 (3个) ──────────────────────────────
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

    # ── 影子军团 (4个) ──────────────────────────────
    "first_shadow": {
        "name": "🌑 初次抽取",
        "description": "抽取你的第一个影子士兵",
        "category": "shadow",
        "exp_reward": 50,
        "hidden": False,
    },
    "shadow_5": {
        "name": "🌑 影子小队",
        "description": "影子军团达到 5 名成员",
        "category": "shadow",
        "exp_reward": 100,
        "hidden": False,
    },
    "elite_shadow": {
        "name": "🌑 精英抽取",
        "description": "抽取第一个精英级影子",
        "category": "shadow",
        "exp_reward": 150,
        "hidden": False,
    },
    "shadow_level_10": {
        "name": "🌑 影子进化",
        "description": "有一个影子达到 Lv.10",
        "category": "shadow",
        "exp_reward": 200,
        "hidden": True,
    },

    # ── 连续打卡 (3个) ──────────────────────────────
    "daily_streak_3": {
        "name": "📅 三日坚持",
        "description": "连续 3 天完成每日任务",
        "category": "streak",
        "exp_reward": 40,
        "hidden": False,
    },
    "daily_streak_7": {
        "name": "📅 周打卡王",
        "description": "连续 7 天完成每日任务",
        "category": "streak",
        "exp_reward": 100,
        "hidden": False,
    },
    "daily_streak_30": {
        "name": "📅 月度传奇",
        "description": "连续 30 天完成每日任务",
        "category": "streak",
        "exp_reward": 500,
        "hidden": True,
    },

    # ── 技能精通 (2个) ──────────────────────────────
    "skill_first_activate": {
        "name": "🎯 技能觉醒",
        "description": "首次激活一个主动技能",
        "category": "mastery",
        "exp_reward": 30,
        "hidden": False,
    },
    "all_passive_unlocked": {
        "name": "🧬 被动全开",
        "description": "解锁所有被动技能",
        "category": "mastery",
        "exp_reward": 300,
        "hidden": True,
    },
}


class AchievementEngine:
    """成就系统引擎"""

    def __init__(self, player_mgr: PlayerManager, event_bus: EventBus):
        self.player_mgr = player_mgr
        self.bus = event_bus
        self._unlocked: set[str] = set()
        self._had_procrastination = False
        self._focus_streak: int = 0
        self._daily_streak: int = 0
        self._last_streak_date: str = ""

        # 注册事件
        self.bus.on(EventType.QUEST_COMPLETED, self._on_quest_completed)
        self.bus.on(EventType.LEVEL_UP, self._on_level_up)
        self.bus.on(EventType.BUFF_ACTIVATED, self._on_buff_activated)
        self.bus.on(EventType.DEBUFF_ACTIVATED, self._on_debuff_activated)
        self.bus.on(EventType.PATTERN_DETECTED, self._on_pattern_detected)
        self.bus.on(EventType.CONTEXT_ANALYZED, self._on_context_analyzed)
        self.bus.on(EventType.SHADOW_EXTRACTED, self._on_shadow_extracted)

    async def _unlock(self, achievement_id: str) -> None:
        """解锁成就"""
        if achievement_id in self._unlocked:
            return
        if achievement_id not in ACHIEVEMENTS:
            return

        self._unlocked.add(achievement_id)
        ach = ACHIEVEMENTS[achievement_id]

        if ach["exp_reward"] > 0:
            await self.player_mgr.gain_exp(ach["exp_reward"], source=f"achievement:{achievement_id}")

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

    # ── 事件处理器 ──────────────────────────────────────

    async def _on_quest_completed(self, event: Event) -> None:
        total = self.player_mgr.player.total_quests_completed
        quest_data = event.data

        if total >= 1:
            await self._unlock("first_quest")
        if total >= 10:
            await self._unlock("quest_10")
        if total >= 50:
            await self._unlock("quest_50")
        if total >= 100:
            await self._unlock("quest_100")
        if total >= 500:
            await self._unlock("quest_500")

        # S 级任务
        if quest_data.get("difficulty") == "S":
            await self._unlock("s_rank_quest")

    async def _on_level_up(self, event: Event) -> None:
        level = event.data.get("new_level", 0)
        if level >= 5:
            await self._unlock("level_5")
        if level >= 10:
            await self._unlock("level_10")
        if level >= 25:
            await self._unlock("level_25")
        if level >= 50:
            await self._unlock("level_50")
        if level >= 99:
            await self._unlock("level_99")

    async def _on_buff_activated(self, event: Event) -> None:
        buff_id = event.data.get("buff_id", "")
        if buff_id == "focus_zone":
            await self._unlock("focus_30min")
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
        now = datetime.now()
        analysis = event.data.get("analysis", {})
        category = analysis.get("category", "idle")
        focus = analysis.get("focus_score", 0)

        # 时间相关
        if category not in ("idle", "unknown"):
            if 2 <= now.hour < 5:
                await self._unlock("night_owl")
            if now.hour < 6:
                await self._unlock("early_bird")
            if now.weekday() >= 5:  # 周末
                await self._unlock("weekend_grind")

        # 专注力连续
        if focus >= 0.7:
            self._focus_streak += 1
            if self._focus_streak >= 10:
                await self._unlock("focus_streak_10")
            if self._focus_streak >= 20:
                await self._unlock("focus_streak_20")
        else:
            self._focus_streak = 0

    async def _on_shadow_extracted(self, event: Event) -> None:
        await self._unlock("first_shadow")
        rank = event.data.get("rank", "")
        if rank in ("elite", "knight", "commander", "monarch"):
            await self._unlock("elite_shadow")

    # ── 外部调用检查 ────────────────────────────────────

    async def check_shadow_army(self, army_size: int, max_shadow_level: int) -> None:
        """由外部调用检查影子军团成就"""
        if army_size >= 5:
            await self._unlock("shadow_5")
        if max_shadow_level >= 10:
            await self._unlock("shadow_level_10")

    async def check_daily_streak(self, streak: int) -> None:
        """由外部调用检查连续打卡"""
        if streak >= 3:
            await self._unlock("daily_streak_3")
        if streak >= 7:
            await self._unlock("daily_streak_7")
        if streak >= 30:
            await self._unlock("daily_streak_30")

    async def check_skill_activation(self) -> None:
        """技能首次激活"""
        await self._unlock("skill_first_activate")

    async def check_all_daily_done(self) -> None:
        """所有每日任务完成"""
        await self._unlock("all_daily")

    # ── 查询接口 ────────────────────────────────────────

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
        return [a for a in self.get_all() if a["unlocked"]]

    def get_progress(self) -> dict:
        total = len(ACHIEVEMENTS)
        unlocked = len(self._unlocked)
        by_category = {}
        for ach_id, ach in ACHIEVEMENTS.items():
            cat = ach["category"]
            if cat not in by_category:
                by_category[cat] = {"total": 0, "unlocked": 0}
            by_category[cat]["total"] += 1
            if ach_id in self._unlocked:
                by_category[cat]["unlocked"] += 1

        return {
            "total": total,
            "unlocked": unlocked,
            "progress": round(unlocked / total, 2) if total > 0 else 0,
            "remaining": total - unlocked,
            "by_category": by_category,
        }

    # ── 序列化 ──────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "unlocked": list(self._unlocked),
            "focus_streak": self._focus_streak,
            "daily_streak": self._daily_streak,
        }

    def load_from_dict(self, data: dict) -> None:
        self._unlocked = set(data.get("unlocked", []))
        self._focus_streak = data.get("focus_streak", 0)
        self._daily_streak = data.get("daily_streak", 0)
