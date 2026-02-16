"""
任务引擎
自动生成、管理、追踪任务
"""

import uuid
from datetime import datetime, timedelta

from ..core.events import EventBus, EventType
from ..core.player import PlayerManager
from ..storage.models import Quest, QuestType, QuestStatus, QuestDifficulty
from ..storage.database import Database


# 每日任务模板
DAILY_QUESTS = [
    {
        "title": "晨间训练",
        "description": "完成至少 15 分钟的运动或拉伸。身体是革命的本钱。",
        "difficulty": "D",
        "exp_reward": 20,
        "category": "wellness",
    },
    {
        "title": "知识汲取",
        "description": "阅读至少 30 分钟的书籍、文档或教程。",
        "difficulty": "D",
        "exp_reward": 20,
        "category": "learning",
    },
    {
        "title": "专注时刻",
        "description": "完成至少 1 小时不间断的深度工作。",
        "difficulty": "C",
        "exp_reward": 30,
        "category": "focus",
    },
]

# 难度对应经验值范围
DIFFICULTY_EXP = {
    "E": (5, 15),
    "D": (15, 30),
    "C": (30, 60),
    "B": (60, 120),
    "A": (120, 250),
    "S": (250, 500),
}


class QuestEngine:
    """任务引擎"""

    def __init__(self, db: Database, player_mgr: PlayerManager, event_bus: EventBus):
        self.db = db
        self.player_mgr = player_mgr
        self.bus = event_bus
        self._register_handlers()

    def _register_handlers(self):
        """注册事件处理器"""
        self.bus.on(EventType.MOTIVE_INFERRED, self._on_motive_inferred)
        self.bus.on(EventType.PATTERN_DETECTED, self._on_pattern_detected)

    async def generate_daily_quests(self) -> list[Quest]:
        """生成每日任务 (避免重复)"""
        # 检查今天是否已生成
        active = await self.db.get_active_quests()
        today = datetime.now().strftime('%Y%m%d')
        existing_daily = [q for q in active if q.type == QuestType.DAILY and q.id.startswith(f"daily_{today}")]
        if existing_daily:
            return existing_daily  # 今天已有每日任务，不重复生成

        quests = []
        for template in DAILY_QUESTS:
            quest = Quest(
                id=f"daily_{datetime.now().strftime('%Y%m%d')}_{uuid.uuid4().hex[:6]}",
                type=QuestType.DAILY,
                title=template["title"],
                description=template["description"],
                difficulty=QuestDifficulty(template["difficulty"]),
                status=QuestStatus.ACTIVE,
                exp_reward=template["exp_reward"],
                source="daily",
                objectives=[{"desc": template["description"], "done": False}],
                rewards={"exp": template["exp_reward"]},
                deadline=datetime.now().replace(hour=23, minute=59, second=59),
            )
            await self.db.save_quest(quest)
            quests.append(quest)

            await self.bus.emit_simple(
                EventType.QUEST_TRIGGERED,
                quest_id=quest.id,
                quest_title=quest.title,
                quest_type=quest.type.value,
                difficulty=quest.difficulty.value,
                exp_reward=quest.exp_reward,
            )

        return quests

    async def create_quest_from_ai(self, suggestion: dict) -> Quest | None:
        """根据 AI 建议创建任务"""
        if not suggestion.get("title"):
            return None

        # 检查是否已有类似任务
        active = await self.db.get_active_quests()
        for q in active:
            if q.title == suggestion["title"]:
                return None  # 避免重复

        difficulty = suggestion.get("difficulty", "C")
        exp_range = DIFFICULTY_EXP.get(difficulty, (30, 60))
        exp_reward = suggestion.get("exp_reward", exp_range[0])

        quest = Quest(
            id=f"auto_{uuid.uuid4().hex[:8]}",
            type=QuestType(suggestion.get("type", "side")),
            title=suggestion["title"],
            description=suggestion.get("description", ""),
            difficulty=QuestDifficulty(difficulty),
            status=QuestStatus.ACTIVE,
            exp_reward=exp_reward,
            source="auto_detected",
            context=suggestion.get("context", ""),
            objectives=[{"desc": suggestion.get("description", ""), "done": False}],
            rewards={"exp": exp_reward},
        )

        await self.db.save_quest(quest)

        await self.bus.emit_simple(
            EventType.QUEST_TRIGGERED,
            quest_id=quest.id,
            quest_title=quest.title,
            quest_type=quest.type.value,
            difficulty=quest.difficulty.value,
            exp_reward=quest.exp_reward,
        )

        return quest

    async def complete_quest(self, quest_id: str) -> bool:
        """完成任务"""
        quest = await self.db.get_quest(quest_id)
        if not quest or quest.status != QuestStatus.ACTIVE:
            return False

        quest.status = QuestStatus.COMPLETED
        quest.completed_at = datetime.now()
        await self.db.save_quest(quest)

        # 给予经验奖励
        await self.player_mgr.gain_exp(quest.exp_reward, source=f"quest:{quest.id}")
        self.player_mgr.player.total_quests_completed += 1

        await self.bus.emit_simple(
            EventType.QUEST_COMPLETED,
            quest_id=quest.id,
            quest_title=quest.title,
            exp_earned=quest.exp_reward,
        )

        return True

    async def fail_quest(self, quest_id: str) -> bool:
        """任务失败"""
        quest = await self.db.get_quest(quest_id)
        if not quest or quest.status != QuestStatus.ACTIVE:
            return False

        quest.status = QuestStatus.FAILED
        await self.db.save_quest(quest)

        await self.bus.emit_simple(
            EventType.QUEST_FAILED,
            quest_id=quest.id,
            quest_title=quest.title,
        )

        return True

    async def check_expired_quests(self) -> None:
        """检查过期任务"""
        active = await self.db.get_active_quests()
        now = datetime.now()
        for quest in active:
            if quest.deadline and quest.deadline < now:
                quest.status = QuestStatus.EXPIRED
                await self.db.save_quest(quest)
                await self.bus.emit_simple(
                    EventType.QUEST_FAILED,
                    quest_id=quest.id,
                    quest_title=quest.title,
                    reason="expired",
                )

    async def _on_motive_inferred(self, event) -> None:
        """处理动机推断事件，自动生成任务"""
        motive = event.data.get("motive", {})
        suggested = motive.get("suggested_quests", [])

        active = await self.db.get_active_quests()
        if len(active) >= 10:  # 不超过最大任务数
            return

        for suggestion in suggested[:2]:  # 每次最多生成 2 个
            await self.create_quest_from_ai(suggestion)

    async def _on_pattern_detected(self, event) -> None:
        """处理行为模式事件"""
        pattern = event.data.get("pattern_type", "")

        if pattern == "procrastination":
            # 触发紧急任务
            await self.create_quest_from_ai({
                "title": "⚡ 克服惰性挑战",
                "description": "系统检测到拖延模式。立即开始你一直推迟的任务，坚持 25 分钟。",
                "difficulty": "B",
                "exp_reward": 80,
                "type": "emergency",
                "context": "拖延模式检测",
            })
