"""
玩家状态管理
等级、经验值、属性、称号
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any

from .events import EventBus, EventType


# 等级经验值表 (等级 -> 所需经验)
LEVEL_TABLE: dict[int, int] = {
    1: 100,
    2: 200,
    3: 400,
    4: 700,
    5: 1100,
    6: 1600,
    7: 2200,
    8: 3000,
    9: 4000,
    10: 5500,
}
# 10 级以上每级 +1000
def exp_for_level(level: int) -> int:
    if level in LEVEL_TABLE:
        return LEVEL_TABLE[level]
    return 5500 + (level - 10) * 1000


# 称号系统
TITLES: dict[str, dict[str, Any]] = {
    "觉醒者": {"min_level": 1, "description": "刚刚觉醒的玩家"},
    "E级猎人": {"min_level": 3, "description": "初出茅庐"},
    "D级猎人": {"min_level": 5, "description": "崭露头角"},
    "C级猎人": {"min_level": 8, "description": "实力不俗"},
    "B级猎人": {"min_level": 12, "description": "令人瞩目"},
    "A级猎人": {"min_level": 18, "description": "顶尖高手"},
    "S级猎人": {"min_level": 25, "description": "超越极限"},
    "国家级猎人": {"min_level": 35, "description": "国之栋梁"},
    "影之君主": {"min_level": 50, "description": "独自升级，登顶巅峰"},
}


@dataclass
class PlayerStats:
    """玩家属性"""
    focus: int = 50           # 专注力
    productivity: int = 50    # 生产力
    consistency: int = 50     # 持续性
    creativity: int = 50      # 创造力
    wellness: int = 50        # 健康度

    def apply_modifier(self, stat: str, value: int) -> None:
        """应用属性修正"""
        if hasattr(self, stat):
            current = getattr(self, stat)
            # 属性范围 0-100
            setattr(self, stat, max(0, min(100, current + value)))

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


@dataclass
class ActiveBuff:
    """当前生效的 buff/debuff"""
    id: str
    name: str
    effects: dict[str, Any]
    activated_at: datetime
    expires_at: datetime | None = None  # None = 直到条件解除
    is_debuff: bool = False


@dataclass
class Player:
    """玩家核心数据"""
    name: str = "Player"
    level: int = 1
    exp: int = 0
    title: str = "觉醒者"
    stats: PlayerStats = field(default_factory=PlayerStats)
    active_buffs: list[ActiveBuff] = field(default_factory=list)
    titles_unlocked: list[str] = field(default_factory=lambda: ["觉醒者"])
    total_quests_completed: int = 0
    created_at: datetime = field(default_factory=datetime.now)

    @property
    def exp_to_next(self) -> int:
        return exp_for_level(self.level)

    @property
    def exp_progress(self) -> float:
        """当前等级经验进度 (0.0 - 1.0)"""
        return self.exp / self.exp_to_next if self.exp_to_next > 0 else 0

    @property
    def available_title(self) -> str:
        """根据等级可获得的最高称号"""
        best = "觉醒者"
        for title, info in TITLES.items():
            if self.level >= info["min_level"]:
                best = title
        return best

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "level": self.level,
            "exp": self.exp,
            "exp_to_next": self.exp_to_next,
            "exp_progress": round(self.exp_progress, 2),
            "title": self.title,
            "stats": self.stats.to_dict(),
            "active_buffs": [
                {
                    "id": b.id,
                    "name": b.name,
                    "is_debuff": b.is_debuff,
                    "effects": b.effects,
                }
                for b in self.active_buffs
            ],
            "titles_unlocked": self.titles_unlocked,
            "total_quests_completed": self.total_quests_completed,
        }


class PlayerManager:
    """玩家状态管理器"""

    def __init__(self, player: Player, event_bus: EventBus):
        self.player = player
        self.bus = event_bus

    async def gain_exp(self, amount: int, source: str = "quest") -> None:
        """获得经验值"""
        # 应用经验加成 buff
        multiplier = 1.0
        for buff in self.player.active_buffs:
            if "exp_multiplier" in buff.effects:
                multiplier *= buff.effects["exp_multiplier"]

        actual_amount = int(amount * multiplier)
        self.player.exp += actual_amount

        await self.bus.emit_simple(
            EventType.EXP_GAINED,
            amount=actual_amount,
            source=source,
            multiplier=multiplier,
        )

        # 检查升级
        while self.player.exp >= self.player.exp_to_next:
            self.player.exp -= self.player.exp_to_next
            await self._level_up()

    async def _level_up(self) -> None:
        """升级！"""
        self.player.level += 1

        # 检查新称号
        new_title = self.player.available_title
        title_changed = new_title != self.player.title
        if title_changed and new_title not in self.player.titles_unlocked:
            self.player.titles_unlocked.append(new_title)
            self.player.title = new_title

        # 升级时属性小幅提升
        for stat in ["focus", "productivity", "consistency", "creativity", "wellness"]:
            self.player.stats.apply_modifier(stat, 1)

        await self.bus.emit_simple(
            EventType.LEVEL_UP,
            new_level=self.player.level,
            title=self.player.title,
            title_changed=title_changed,
        )

    async def apply_buff(self, buff: ActiveBuff) -> None:
        """应用 buff"""
        # 移除同 ID 的旧 buff
        self.player.active_buffs = [
            b for b in self.player.active_buffs if b.id != buff.id
        ]
        self.player.active_buffs.append(buff)

        # 应用属性效果
        for stat, value in buff.effects.items():
            if stat != "exp_multiplier" and hasattr(self.player.stats, stat):
                self.player.stats.apply_modifier(stat, value)

        event_type = EventType.DEBUFF_ACTIVATED if buff.is_debuff else EventType.BUFF_ACTIVATED
        await self.bus.emit_simple(
            event_type,
            buff_id=buff.id,
            buff_name=buff.name,
            effects=buff.effects,
        )

    async def remove_buff(self, buff_id: str) -> None:
        """移除 buff"""
        removed = None
        new_buffs = []
        for b in self.player.active_buffs:
            if b.id == buff_id:
                removed = b
            else:
                new_buffs.append(b)
        self.player.active_buffs = new_buffs

        if removed:
            # 反转属性效果
            for stat, value in removed.effects.items():
                if stat != "exp_multiplier" and hasattr(self.player.stats, stat):
                    self.player.stats.apply_modifier(stat, -value)

            event_type = EventType.DEBUFF_EXPIRED if removed.is_debuff else EventType.BUFF_EXPIRED
            await self.bus.emit_simple(
                event_type,
                buff_id=removed.id,
                buff_name=removed.name,
            )

    async def update_stats(self, changes: dict[str, int]) -> None:
        """直接更新属性"""
        for stat, value in changes.items():
            self.player.stats.apply_modifier(stat, value)

        await self.bus.emit_simple(
            EventType.STAT_CHANGED,
            changes=changes,
            current_stats=self.player.stats.to_dict(),
        )
