"""
技能系统
主动技能和被动技能，可以升级
灵感来自原作的 System Skills
"""

from datetime import datetime
from ..core.events import EventBus, EventType, Event


# 被动技能 — 随等级和行为自动解锁
PASSIVE_SKILLS = {
    "will_to_recover": {
        "name": "💚 意志恢复",
        "description": "完成任务后属性自动回复少量。原作: 旷日恢复",
        "unlock_level": 1,
        "effect": "任务完成后恢复 3 点随机属性",
        "max_level": 5,
    },
    "longevity": {
        "name": "🛡️ 持久力",
        "description": "连续专注超过 1 小时，专注度衰减速度减半",
        "unlock_level": 3,
        "effect": "长时间工作时专注度 debuff 减半",
        "max_level": 3,
    },
    "detoxification": {
        "name": "🧹 净化",
        "description": "debuff 持续时间缩短 20%",
        "unlock_level": 5,
        "effect": "所有 debuff 持续时间 -20%",
        "max_level": 3,
    },
    "tenacity": {
        "name": "🔥 坚韧",
        "description": "属性低于 30 时，下降速度减半",
        "unlock_level": 8,
        "effect": "低属性保护",
        "max_level": 3,
    },
    "advanced_focus": {
        "name": "🎯 高级专注术",
        "description": "编程/写作时额外 +15% 经验",
        "unlock_level": 10,
        "effect": "生产性活动经验加成 15%",
        "max_level": 5,
    },
}

# 主动技能 — 玩家主动触发
ACTIVE_SKILLS = {
    "stealth": {
        "name": "👻 潜行",
        "description": "激活免打扰模式 2 小时，关闭所有通知",
        "unlock_level": 2,
        "cooldown_minutes": 240,
        "effect": "2 小时免打扰",
        "max_level": 3,
    },
    "bloodlust": {
        "name": "💢 杀意",
        "description": "激活高压专注模式，30 分钟内必须保持高专注否则受到 debuff",
        "unlock_level": 5,
        "cooldown_minutes": 120,
        "effect": "30 分钟强制专注挑战",
        "max_level": 5,
    },
    "quicksilver": {
        "name": "⚡ 快银",
        "description": "激活后 1 小时内经验获取速度 +30%",
        "unlock_level": 7,
        "cooldown_minutes": 180,
        "effect": "1 小时经验加速",
        "max_level": 5,
    },
    "rulers_authority": {
        "name": "👑 支配者之力",
        "description": "强制开启一个新任务（系统立即分析当前状态并生成任务）",
        "unlock_level": 10,
        "cooldown_minutes": 60,
        "effect": "主动触发任务生成",
        "max_level": 3,
    },
    "shadow_extraction": {
        "name": "🌑 影子抽取",
        "description": "将完成的任务转化为「影子士兵」— 自动化脚本/例行工作的记录",
        "unlock_level": 15,
        "cooldown_minutes": 360,
        "effect": "记录并自动化重复性任务",
        "max_level": 5,
    },
}


class SkillSystem:
    """技能系统"""

    def __init__(self, event_bus: EventBus):
        self.bus = event_bus
        self._skill_levels: dict[str, int] = {}  # skill_id -> current_level
        self._cooldowns: dict[str, datetime] = {}  # skill_id -> cooldown_until
        self._skill_exp: dict[str, int] = {}  # 技能熟练度

    def get_available_skills(self, player_level: int) -> dict:
        """获取当前可用的技能"""
        passive = []
        for skill_id, skill in PASSIVE_SKILLS.items():
            if player_level >= skill["unlock_level"]:
                passive.append({
                    "id": skill_id,
                    "name": skill["name"],
                    "description": skill["description"],
                    "effect": skill["effect"],
                    "level": self._skill_levels.get(skill_id, 1),
                    "max_level": skill["max_level"],
                    "type": "passive",
                    "unlocked": True,
                })
            else:
                passive.append({
                    "id": skill_id,
                    "name": "🔒 ???",
                    "description": f"达到 Lv.{skill['unlock_level']} 解锁",
                    "type": "passive",
                    "unlocked": False,
                })

        active = []
        now = datetime.now()
        for skill_id, skill in ACTIVE_SKILLS.items():
            if player_level >= skill["unlock_level"]:
                cd_until = self._cooldowns.get(skill_id)
                on_cooldown = cd_until and cd_until > now
                active.append({
                    "id": skill_id,
                    "name": skill["name"],
                    "description": skill["description"],
                    "effect": skill["effect"],
                    "level": self._skill_levels.get(skill_id, 1),
                    "max_level": skill["max_level"],
                    "type": "active",
                    "unlocked": True,
                    "on_cooldown": on_cooldown,
                    "cooldown_remaining": (
                        int((cd_until - now).total_seconds() / 60)
                        if on_cooldown else 0
                    ),
                })
            else:
                active.append({
                    "id": skill_id,
                    "name": "🔒 ???",
                    "description": f"达到 Lv.{skill['unlock_level']} 解锁",
                    "type": "active",
                    "unlocked": False,
                })

        return {"passive": passive, "active": active}

    async def activate_skill(self, skill_id: str, player_level: int) -> dict:
        """激活主动技能"""
        if skill_id not in ACTIVE_SKILLS:
            return {"success": False, "error": "技能不存在"}

        skill = ACTIVE_SKILLS[skill_id]
        if player_level < skill["unlock_level"]:
            return {"success": False, "error": f"需要 Lv.{skill['unlock_level']}"}

        now = datetime.now()
        cd_until = self._cooldowns.get(skill_id)
        if cd_until and cd_until > now:
            remaining = int((cd_until - now).total_seconds() / 60)
            return {"success": False, "error": f"冷却中 ({remaining} 分钟)"}

        # 设置冷却
        from datetime import timedelta
        self._cooldowns[skill_id] = now + timedelta(minutes=skill["cooldown_minutes"])

        # 增加技能熟练度
        self._skill_exp[skill_id] = self._skill_exp.get(skill_id, 0) + 1

        await self.bus.emit_simple(
            EventType.NOTIFICATION_PUSH,
            notification={
                "title": f"🎯 技能激活: {skill['name']}",
                "message": skill["effect"],
                "style": "skill",
                "timestamp": now.isoformat(),
            },
        )

        return {
            "success": True,
            "skill": skill["name"],
            "effect": skill["effect"],
            "cooldown_minutes": skill["cooldown_minutes"],
        }
