"""
影子军团系统 (Shadow Army)
独自升级核心元素 — 将重复性任务"抽取"为影子士兵，自动执行

设计理念:
  用户完成一个重复性任务后，可以"抽取"它变成影子士兵
  影子士兵会自动执行该任务，解放用户的注意力
  影子越多，用户的"军团"越强大
  
影子士兵类型:
  - 🗡️ 战士型: 定时执行命令/脚本 (cron job)
  - 🛡️ 守卫型: 监控某个状态，异常时报警
  - 📋 文书型: 自动整理/汇总/记录
  - 🔮 法师型: AI 驱动的智能任务
  - 👑 精英型: 复杂的多步骤自动化
"""

import json
import uuid
from datetime import datetime, timedelta
from enum import Enum
from dataclasses import dataclass, field
from typing import Any

from ..core.events import EventBus, EventType, Event


class ShadowRank(Enum):
    """影子等级 — 对应原作的影子军团等级"""
    NORMAL = "normal"       # 普通影子 — 简单自动化
    ELITE = "elite"         # 精英影子 — 复杂自动化
    KNIGHT = "knight"       # 骑士影子 — 核心自动化
    COMMANDER = "commander" # 指挥官影子 — 系统级自动化
    MONARCH = "monarch"     # 君主级 — 完全自主 AI 代理


class ShadowType(Enum):
    """影子类型"""
    WARRIOR = "warrior"     # 🗡️ 战士: 定时执行
    GUARDIAN = "guardian"    # 🛡️ 守卫: 监控报警
    SCRIBE = "scribe"       # 📋 文书: 整理记录
    MAGE = "mage"           # 🔮 法师: AI 智能任务
    GENERAL = "general"     # 👑 将军: 多步骤编排


class ShadowStatus(Enum):
    """影子状态"""
    DORMANT = "dormant"       # 休眠中
    ACTIVE = "active"         # 执行中
    COOLDOWN = "cooldown"     # 冷却中
    DESTROYED = "destroyed"   # 已销毁 (任务失败过多)


SHADOW_TYPE_ICONS = {
    ShadowType.WARRIOR: "🗡️",
    ShadowType.GUARDIAN: "🛡️",
    ShadowType.SCRIBE: "📋",
    ShadowType.MAGE: "🔮",
    ShadowType.GENERAL: "👑",
}

SHADOW_RANK_NAMES = {
    ShadowRank.NORMAL: "普通影子",
    ShadowRank.ELITE: "精英影子",
    ShadowRank.KNIGHT: "骑士影子",
    ShadowRank.COMMANDER: "指挥官影子",
    ShadowRank.MONARCH: "君主影子",
}

# 等级对应的最大影子数
RANK_ARMY_LIMITS = {
    ShadowRank.NORMAL: 99,
    ShadowRank.ELITE: 20,
    ShadowRank.KNIGHT: 5,
    ShadowRank.COMMANDER: 2,
    ShadowRank.MONARCH: 1,
}

# 抽取影子所需的玩家等级
RANK_REQUIRED_LEVELS = {
    ShadowRank.NORMAL: 5,
    ShadowRank.ELITE: 15,
    ShadowRank.KNIGHT: 25,
    ShadowRank.COMMANDER: 40,
    ShadowRank.MONARCH: 60,
}


@dataclass
class ShadowSoldier:
    """影子士兵"""
    id: str = field(default_factory=lambda: f"shadow_{uuid.uuid4().hex[:8]}")
    name: str = ""                                   # 影子的名字 (用户命名或自动生成)
    shadow_type: ShadowType = ShadowType.WARRIOR
    rank: ShadowRank = ShadowRank.NORMAL
    status: ShadowStatus = ShadowStatus.DORMANT
    
    # 来源 — 从哪个任务抽取的
    source_quest_id: str | None = None
    source_quest_title: str = ""
    
    # 自动化定义
    description: str = ""                            # 这个影子做什么
    trigger: dict[str, Any] = field(default_factory=dict)  # 触发条件
    action: dict[str, Any] = field(default_factory=dict)   # 执行动作
    
    # 状态
    level: int = 1                                   # 影子等级 (使用越多越强)
    exp: int = 0                                     # 影子经验
    exp_to_next: int = 100
    total_executions: int = 0                        # 总执行次数
    successful_executions: int = 0                   # 成功次数
    failed_executions: int = 0                       # 失败次数
    last_executed: datetime | None = None
    
    # 元数据
    created_at: datetime = field(default_factory=datetime.now)
    loyalty: float = 1.0                             # 忠诚度 0-1 (失败太多会降低)

    @property
    def icon(self) -> str:
        return SHADOW_TYPE_ICONS.get(self.shadow_type, "👤")
    
    @property
    def rank_name(self) -> str:
        return SHADOW_RANK_NAMES.get(self.rank, "未知")
    
    @property
    def success_rate(self) -> float:
        if self.total_executions == 0:
            return 0.0
        return self.successful_executions / self.total_executions

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "icon": self.icon,
            "type": self.shadow_type.value,
            "rank": self.rank.value,
            "rank_name": self.rank_name,
            "status": self.status.value,
            "description": self.description,
            "trigger": self.trigger,
            "action": self.action,
            "level": self.level,
            "exp": self.exp,
            "exp_to_next": self.exp_to_next,
            "total_executions": self.total_executions,
            "successful_executions": self.successful_executions,
            "failed_executions": self.failed_executions,
            "success_rate": round(self.success_rate * 100, 1),
            "last_executed": self.last_executed.isoformat() if self.last_executed else None,
            "created_at": self.created_at.isoformat(),
            "loyalty": round(self.loyalty, 2),
            "source_quest_title": self.source_quest_title,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ShadowSoldier":
        return cls(
            id=data["id"],
            name=data["name"],
            shadow_type=ShadowType(data["type"]),
            rank=ShadowRank(data["rank"]),
            status=ShadowStatus(data["status"]),
            description=data.get("description", ""),
            trigger=data.get("trigger", {}),
            action=data.get("action", {}),
            level=data.get("level", 1),
            exp=data.get("exp", 0),
            exp_to_next=data.get("exp_to_next", 100),
            total_executions=data.get("total_executions", 0),
            successful_executions=data.get("successful_executions", 0),
            failed_executions=data.get("failed_executions", 0),
            last_executed=datetime.fromisoformat(data["last_executed"]) if data.get("last_executed") else None,
            created_at=datetime.fromisoformat(data["created_at"]) if data.get("created_at") else datetime.now(),
            loyalty=data.get("loyalty", 1.0),
            source_quest_id=data.get("source_quest_id"),
            source_quest_title=data.get("source_quest_title", ""),
        )


# 预定义影子模板 — 通过特定条件解锁
SHADOW_TEMPLATES = {
    "email_scout": {
        "name": "📧 邮件斥候·铁",
        "type": ShadowType.GUARDIAN,
        "rank": ShadowRank.NORMAL,
        "description": "定期检查邮箱，发现重要邮件时通知主人",
        "trigger": {"kind": "cron", "interval_minutes": 30},
        "action": {"kind": "check_email", "filter": "important"},
        "unlock_condition": "完成 10 个通讯类任务",
    },
    "git_sentinel": {
        "name": "💻 代码哨兵·影",
        "type": ShadowType.WARRIOR,
        "rank": ShadowRank.NORMAL,
        "description": "定时检查 Git 仓库状态，未提交代码时提醒",
        "trigger": {"kind": "cron", "interval_minutes": 60},
        "action": {"kind": "shell", "command": "git status --porcelain"},
        "unlock_condition": "连续 7 天有 git commit",
    },
    "calendar_watcher": {
        "name": "📅 日程守望者",
        "type": ShadowType.SCRIBE,
        "rank": ShadowRank.NORMAL,
        "description": "监控日历，提前 30 分钟提醒即将到来的事件",
        "trigger": {"kind": "cron", "interval_minutes": 15},
        "action": {"kind": "check_calendar", "advance_minutes": 30},
        "unlock_condition": "使用日历功能 5 次",
    },
    "daily_reporter": {
        "name": "📊 每日报告官",
        "type": ShadowType.SCRIBE,
        "rank": ShadowRank.ELITE,
        "description": "每天结束时自动生成效率报告",
        "trigger": {"kind": "cron", "time": "22:00"},
        "action": {"kind": "generate_report", "type": "daily"},
        "unlock_condition": "达到 Lv.15",
    },
    "focus_guardian": {
        "name": "🛡️ 专注守护者·贝尔",
        "type": ShadowType.GUARDIAN,
        "rank": ShadowRank.ELITE,
        "description": "检测到摸鱼行为超过 15 分钟时主动提醒",
        "trigger": {"kind": "behavior", "pattern": "distraction", "threshold_minutes": 15},
        "action": {"kind": "notify", "message": "主人，该回到正事了。", "style": "gentle"},
        "unlock_condition": "克服 20 次摸鱼 debuff",
    },
    "weekly_analyst": {
        "name": "🔮 周报分析师·伊格里特",
        "type": ShadowType.MAGE,
        "rank": ShadowRank.KNIGHT,
        "description": "每周分析行为模式，生成个性化建议",
        "trigger": {"kind": "cron", "weekday": "sunday", "time": "20:00"},
        "action": {"kind": "ai_analyze", "scope": "weekly", "generate_suggestions": True},
        "unlock_condition": "达到 Lv.25 且连续使用 4 周",
    },
    "project_commander": {
        "name": "👑 项目指挥官·向",
        "type": ShadowType.GENERAL,
        "rank": ShadowRank.COMMANDER,
        "description": "追踪所有进行中的项目，自动分解任务并设置截止日期",
        "trigger": {"kind": "event", "event": "project_detected"},
        "action": {"kind": "ai_orchestrate", "scope": "project_management"},
        "unlock_condition": "达到 Lv.40 且完成 100 个任务",
    },
}


class ShadowArmy:
    """
    影子军团管理器
    
    核心能力:
    - 从完成的任务中"抽取"影子 (shadow extraction)
    - 管理影子军团 (部署/休眠/升级/销毁)
    - 自动执行影子任务
    - 影子升级系统 (使用越多越强)
    """

    def __init__(self, event_bus: EventBus):
        self.bus = event_bus
        self._army: dict[str, ShadowSoldier] = {}
        self._extraction_history: list[dict] = []

        # 注册事件监听
        self.bus.on(EventType.QUEST_COMPLETED, self._on_quest_completed)

    # ── 影子抽取 ────────────────────────────────────────

    async def extract_shadow(
        self,
        source_quest_id: str | None,
        source_quest_title: str,
        name: str,
        shadow_type: ShadowType,
        rank: ShadowRank,
        description: str,
        trigger: dict,
        action: dict,
        player_level: int,
    ) -> dict[str, Any]:
        """
        从完成的任务中抽取影子
        
        这是独自升级里最经典的场景:
        "站起来吧。" — 然后影子从地面升起
        """
        # 检查玩家等级
        required_level = RANK_REQUIRED_LEVELS.get(rank, 999)
        if player_level < required_level:
            return {
                "success": False,
                "error": f"影子抽取失败。需要 Lv.{required_level} 才能抽取{SHADOW_RANK_NAMES[rank]}。",
            }

        # 检查军团容量
        current_count = sum(
            1 for s in self._army.values()
            if s.rank == rank and s.status != ShadowStatus.DESTROYED
        )
        max_count = RANK_ARMY_LIMITS.get(rank, 0)
        if current_count >= max_count:
            return {
                "success": False,
                "error": f"军团已满。{SHADOW_RANK_NAMES[rank]}上限: {max_count}",
            }

        # 创建影子
        shadow = ShadowSoldier(
            name=name,
            shadow_type=shadow_type,
            rank=rank,
            status=ShadowStatus.DORMANT,
            source_quest_id=source_quest_id,
            source_quest_title=source_quest_title,
            description=description,
            trigger=trigger,
            action=action,
        )

        self._army[shadow.id] = shadow

        # 记录抽取历史
        self._extraction_history.append({
            "shadow_id": shadow.id,
            "shadow_name": name,
            "source_quest": source_quest_title,
            "rank": rank.value,
            "timestamp": datetime.now().isoformat(),
        })

        # 发送史诗级通知
        await self.bus.emit_simple(
            EventType.NOTIFICATION_PUSH,
            notification={
                "title": "🌑 影子抽取成功",
                "message": self._extraction_message(shadow),
                "style": "shadow_extraction",
                "timestamp": datetime.now().isoformat(),
            },
        )

        return {
            "success": True,
            "shadow": shadow.to_dict(),
            "message": f"「站起来吧。」\n\n{shadow.icon} {shadow.name} 加入了你的影子军团。",
        }

    def _extraction_message(self, shadow: ShadowSoldier) -> str:
        """生成抽取成功的系统消息"""
        rank_text = SHADOW_RANK_NAMES[shadow.rank]
        lines = [
            f"「站起来吧。」",
            f"",
            f"暗影从地面升起，凝聚成形——",
            f"",
            f"{shadow.icon} {shadow.name}",
            f"等级: {rank_text}",
            f"职责: {shadow.description}",
            f"",
            f"新的影子已加入你的军团。",
        ]
        return "\n".join(lines)

    # ── 模板抽取 ────────────────────────────────────────

    async def extract_from_template(
        self, template_id: str, player_level: int
    ) -> dict[str, Any]:
        """从预定义模板抽取影子"""
        if template_id not in SHADOW_TEMPLATES:
            return {"success": False, "error": "未知的影子模板"}

        template = SHADOW_TEMPLATES[template_id]
        return await self.extract_shadow(
            source_quest_id=None,
            source_quest_title=f"[模板] {template['name']}",
            name=template["name"],
            shadow_type=template["type"],
            rank=template["rank"],
            description=template["description"],
            trigger=template["trigger"],
            action=template["action"],
            player_level=player_level,
        )

    # ── 军团管理 ────────────────────────────────────────

    def get_army(self) -> dict:
        """获取军团状态"""
        soldiers = [s.to_dict() for s in self._army.values() if s.status != ShadowStatus.DESTROYED]
        
        # 统计
        total = len(soldiers)
        active = sum(1 for s in self._army.values() if s.status == ShadowStatus.ACTIVE)
        by_rank = {}
        for rank in ShadowRank:
            count = sum(1 for s in self._army.values() 
                       if s.rank == rank and s.status != ShadowStatus.DESTROYED)
            if count > 0:
                by_rank[rank.value] = {
                    "count": count,
                    "max": RANK_ARMY_LIMITS[rank],
                    "name": SHADOW_RANK_NAMES[rank],
                }

        return {
            "total": total,
            "active": active,
            "soldiers": sorted(soldiers, key=lambda s: (
                list(ShadowRank).index(ShadowRank(s["rank"])),  # 高等级优先
                -s["level"],  # 同等级按 level 降序
            )),
            "by_rank": by_rank,
            "army_power": self._calculate_army_power(),
        }

    def _calculate_army_power(self) -> int:
        """计算军团总战力"""
        power = 0
        rank_multiplier = {
            ShadowRank.NORMAL: 1,
            ShadowRank.ELITE: 5,
            ShadowRank.KNIGHT: 20,
            ShadowRank.COMMANDER: 50,
            ShadowRank.MONARCH: 200,
        }
        for shadow in self._army.values():
            if shadow.status == ShadowStatus.DESTROYED:
                continue
            base = rank_multiplier.get(shadow.rank, 1)
            power += base * shadow.level * shadow.loyalty
        return int(power)

    async def deploy_shadow(self, shadow_id: str) -> dict:
        """部署影子 (激活)"""
        shadow = self._army.get(shadow_id)
        if not shadow:
            return {"success": False, "error": "影子不存在"}
        if shadow.status == ShadowStatus.DESTROYED:
            return {"success": False, "error": "影子已被销毁"}
        if shadow.status == ShadowStatus.ACTIVE:
            return {"success": False, "error": "影子已在执行中"}

        shadow.status = ShadowStatus.ACTIVE
        
        await self.bus.emit_simple(
            EventType.NOTIFICATION_PUSH,
            notification={
                "title": f"{shadow.icon} 影子已部署",
                "message": f"{shadow.name} 开始执行任务: {shadow.description}",
                "style": "shadow_deploy",
                "timestamp": datetime.now().isoformat(),
            },
        )

        return {"success": True, "shadow": shadow.to_dict()}

    async def recall_shadow(self, shadow_id: str) -> dict:
        """召回影子 (休眠)"""
        shadow = self._army.get(shadow_id)
        if not shadow:
            return {"success": False, "error": "影子不存在"}

        shadow.status = ShadowStatus.DORMANT
        return {"success": True, "shadow": shadow.to_dict()}

    async def destroy_shadow(self, shadow_id: str) -> dict:
        """销毁影子"""
        shadow = self._army.get(shadow_id)
        if not shadow:
            return {"success": False, "error": "影子不存在"}

        shadow.status = ShadowStatus.DESTROYED
        
        await self.bus.emit_simple(
            EventType.NOTIFICATION_PUSH,
            notification={
                "title": "💨 影子已消散",
                "message": f"{shadow.name} 消散在黑暗中...",
                "style": "shadow_destroy",
                "timestamp": datetime.now().isoformat(),
            },
        )

        return {"success": True}

    # ── 影子执行 ────────────────────────────────────────

    async def execute_shadow(self, shadow_id: str) -> dict:
        """
        执行影子的任务
        返回执行结果，由调用方决定具体实现
        """
        shadow = self._army.get(shadow_id)
        if not shadow:
            return {"success": False, "error": "影子不存在"}
        if shadow.status != ShadowStatus.ACTIVE:
            return {"success": False, "error": "影子未部署"}

        shadow.total_executions += 1
        shadow.last_executed = datetime.now()

        # 返回 action 定义，由上层实际执行
        return {
            "success": True,
            "shadow_id": shadow.id,
            "shadow_name": shadow.name,
            "action": shadow.action,
            "trigger": shadow.trigger,
            "execution_number": shadow.total_executions,
        }

    async def report_execution_result(
        self, shadow_id: str, success: bool, details: str = ""
    ) -> None:
        """报告影子执行结果"""
        shadow = self._army.get(shadow_id)
        if not shadow:
            return

        if success:
            shadow.successful_executions += 1
            shadow.exp += 10 + shadow.level * 2
            
            # 升级检查
            if shadow.exp >= shadow.exp_to_next:
                shadow.level += 1
                shadow.exp -= shadow.exp_to_next
                shadow.exp_to_next = int(shadow.exp_to_next * 1.5)
                
                await self.bus.emit_simple(
                    EventType.NOTIFICATION_PUSH,
                    notification={
                        "title": f"⬆️ 影子升级!",
                        "message": f"{shadow.icon} {shadow.name} 升到了 Lv.{shadow.level}!",
                        "style": "shadow_levelup",
                        "timestamp": datetime.now().isoformat(),
                    },
                )
        else:
            shadow.failed_executions += 1
            shadow.loyalty = max(0.1, shadow.loyalty - 0.05)
            
            # 忠诚度过低 → 销毁
            if shadow.loyalty <= 0.2:
                shadow.status = ShadowStatus.DESTROYED
                await self.bus.emit_simple(
                    EventType.NOTIFICATION_PUSH,
                    notification={
                        "title": "💀 影子叛逃",
                        "message": f"{shadow.name} 因多次失败，忠诚度归零，已消散。",
                        "style": "shadow_destroy",
                        "timestamp": datetime.now().isoformat(),
                    },
                )

    # ── 可解锁影子检查 ──────────────────────────────────

    def get_unlockable_templates(self, player_level: int) -> list[dict]:
        """获取可以解锁的影子模板"""
        result = []
        existing_templates = {
            s.source_quest_title for s in self._army.values()
            if s.source_quest_title.startswith("[模板]")
        }

        for template_id, template in SHADOW_TEMPLATES.items():
            already_have = f"[模板] {template['name']}" in existing_templates
            required_level = RANK_REQUIRED_LEVELS.get(template["rank"], 999)
            can_unlock = player_level >= required_level and not already_have
            
            result.append({
                "template_id": template_id,
                "name": template["name"],
                "icon": SHADOW_TYPE_ICONS.get(template["type"], "👤"),
                "type": template["type"].value,
                "rank": template["rank"].value,
                "rank_name": SHADOW_RANK_NAMES[template["rank"]],
                "description": template["description"],
                "unlock_condition": template["unlock_condition"],
                "can_unlock": can_unlock,
                "already_have": already_have,
                "required_level": required_level,
            })

        return result

    # ── 事件处理 ────────────────────────────────────────

    async def _on_quest_completed(self, event: Event) -> None:
        """任务完成时检查是否可以抽取影子"""
        quest_data = event.data.get("quest", {})
        # 这里可以添加自动提示抽取的逻辑
        # 比如: 同一类任务完成 3 次以上，提示"这个任务可以抽取为影子"

    # ── 序列化 ──────────────────────────────────────────

    def to_dict(self) -> dict:
        """序列化整个军团"""
        return {
            "army": {sid: s.to_dict() for sid, s in self._army.items()},
            "extraction_history": self._extraction_history,
        }

    def load_from_dict(self, data: dict) -> None:
        """从字典恢复军团"""
        self._army = {}
        for sid, sdata in data.get("army", {}).items():
            self._army[sid] = ShadowSoldier.from_dict(sdata)
        self._extraction_history = data.get("extraction_history", [])
