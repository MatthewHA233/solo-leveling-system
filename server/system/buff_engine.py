"""
Buff/Debuff 引擎
根据行为模式自动激活/失效 buff 和 debuff
"""

from datetime import datetime, timedelta

from ..core.events import EventBus, EventType, Event
from ..core.player import PlayerManager, ActiveBuff


# Buff 定义
BUFF_DEFINITIONS = {
    "focus_zone": {
        "name": "🔥 专注领域",
        "description": "连续专注工作，进入心流状态",
        "effects": {"focus": 20, "exp_multiplier": 1.5},
        "is_debuff": False,
    },
    "creativity_spark": {
        "name": "✨ 创造灵感",
        "description": "创作活动活跃，灵感涌现",
        "effects": {"creativity": 25, "exp_multiplier": 1.3},
        "is_debuff": False,
    },
    "learning_boost": {
        "name": "📚 知识加速",
        "description": "学习模式活跃，知识吸收加速",
        "effects": {"productivity": 15, "exp_multiplier": 1.2},
        "is_debuff": False,
    },
    "early_bird": {
        "name": "🌅 早起之力",
        "description": "早起开始工作，状态极佳",
        "effects": {"focus": 10, "productivity": 10, "wellness": 5},
        "is_debuff": False,
    },
    "distraction_fog": {
        "name": "💫 注意力涣散",
        "description": "频繁切换应用，注意力分散",
        "effects": {"focus": -15, "productivity": -10},
        "is_debuff": True,
        "duration_minutes": 10,
    },
    "fatigue_warning": {
        "name": "😴 疲劳警告",
        "description": "长时间工作未休息，效率下降",
        "effects": {"focus": -10, "wellness": -5},
        "is_debuff": True,
        "duration_minutes": 15,
    },
    "night_owl": {
        "name": "🦉 夜行者",
        "description": "深夜仍在工作，夜间模式激活",
        "effects": {"creativity": 10, "wellness": -10},
        "is_debuff": False,
    },
    "procrastination_curse": {
        "name": "⛓️ 拖延诅咒",
        "description": "持续回避任务，系统检测到拖延行为",
        "effects": {"productivity": -20, "focus": -10},
        "is_debuff": True,
        "duration_minutes": 20,
    },
}


class BuffEngine:
    """Buff/Debuff 管理引擎"""

    def __init__(self, player_mgr: PlayerManager, event_bus: EventBus):
        self.player_mgr = player_mgr
        self.bus = event_bus
        self._register_handlers()

    def _register_handlers(self):
        self.bus.on(EventType.MOTIVE_INFERRED, self._on_motive_inferred)
        self.bus.on(EventType.CONTEXT_ANALYZED, self._on_context_analyzed)
        self.bus.on(EventType.SYSTEM_TICK, self._on_tick)

    async def activate_buff(self, buff_id: str, duration_minutes: int | None = None) -> None:
        """激活一个 buff"""
        definition = BUFF_DEFINITIONS.get(buff_id)
        if not definition:
            return

        # 检查是否已激活
        for existing in self.player_mgr.player.active_buffs:
            if existing.id == buff_id:
                return  # 已有，不重复激活

        now = datetime.now()
        expires = None
        if duration_minutes:
            expires = now + timedelta(minutes=duration_minutes)
        elif "duration_minutes" in definition:
            expires = now + timedelta(minutes=definition["duration_minutes"])

        buff = ActiveBuff(
            id=buff_id,
            name=definition["name"],
            effects=definition["effects"],
            activated_at=now,
            expires_at=expires,
            is_debuff=definition.get("is_debuff", False),
        )

        await self.player_mgr.apply_buff(buff)

    async def deactivate_buff(self, buff_id: str) -> None:
        """移除 buff"""
        await self.player_mgr.remove_buff(buff_id)

    async def check_expired(self) -> None:
        """检查并移除过期 buff"""
        now = datetime.now()
        expired = [
            b for b in self.player_mgr.player.active_buffs
            if b.expires_at and b.expires_at <= now
        ]
        for buff in expired:
            await self.deactivate_buff(buff.id)

    async def _on_context_analyzed(self, event: Event) -> None:
        """根据上下文分析结果激活/取消 buff"""
        analysis = event.data.get("analysis", {})
        focus_score = analysis.get("focus_score", 0.5)

        # 高专注 → 专注领域 buff
        if focus_score >= 0.8:
            await self.activate_buff("focus_zone")
        elif focus_score < 0.3:
            # 低专注 → 移除专注 buff
            await self.deactivate_buff("focus_zone")

        # 检查活动类别
        category = analysis.get("category", "")
        if category == "social" and focus_score < 0.4:
            await self.activate_buff("distraction_fog")

        # 深夜工作
        hour = datetime.now().hour
        if hour >= 23 or hour < 5:
            await self.activate_buff("night_owl")
        else:
            await self.deactivate_buff("night_owl")

    async def _on_motive_inferred(self, event: Event) -> None:
        """根据动机推断激活 buff"""
        motive = event.data.get("motive", {})
        buff_suggestion = motive.get("buff_suggestion", {})

        if buff_suggestion.get("should_activate"):
            buff_type = buff_suggestion.get("buff_type", "none")
            if buff_type != "none" and buff_type in BUFF_DEFINITIONS:
                await self.activate_buff(buff_type)

        # 行为模式对应 buff
        pattern = motive.get("pattern_type", "normal")
        pattern_buff_map = {
            "deep_focus": "focus_zone",
            "creative": "creativity_spark",
            "learning": "learning_boost",
            "distraction": "distraction_fog",
            "fatigue": "fatigue_warning",
            "procrastination": "procrastination_curse",
        }
        if pattern in pattern_buff_map:
            await self.activate_buff(pattern_buff_map[pattern])

    async def _on_tick(self, event: Event) -> None:
        """每个系统 tick 检查过期 buff"""
        await self.check_expired()
