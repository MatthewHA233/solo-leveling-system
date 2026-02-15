"""
数据模型 - SQLite 数据层定义
"""

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any


class QuestType(str, Enum):
    DAILY = "daily"
    MAIN = "main"
    SIDE = "side"
    HIDDEN = "hidden"
    EMERGENCY = "emergency"


class QuestStatus(str, Enum):
    PENDING = "pending"       # 等待接受
    ACTIVE = "active"         # 进行中
    COMPLETED = "completed"   # 已完成
    FAILED = "failed"         # 已失败
    EXPIRED = "expired"       # 已过期


class QuestDifficulty(str, Enum):
    E = "E"
    D = "D"
    C = "C"
    B = "B"
    A = "A"
    S = "S"


@dataclass
class Quest:
    """任务数据模型"""
    id: str
    type: QuestType
    title: str
    description: str
    difficulty: QuestDifficulty
    status: QuestStatus = QuestStatus.PENDING
    objectives: list[dict[str, Any]] | None = None
    rewards: dict[str, Any] | None = None
    deadline: datetime | None = None
    source: str = "auto"       # auto | manual | daily
    context: str = ""          # 触发上下文
    created_at: datetime | None = None
    completed_at: datetime | None = None
    exp_reward: int = 0

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()
        if self.objectives is None:
            self.objectives = []
        if self.rewards is None:
            self.rewards = {}


@dataclass
class ContextSnapshot:
    """一次感知快照"""
    id: str
    timestamp: datetime
    screenshot_path: str | None = None
    active_window: str = ""
    window_title: str = ""
    ai_analysis: str = ""
    inferred_motive: str = ""
    activity_category: str = ""    # coding, browsing, writing, media, social, idle
    focus_score: float = 0.0       # 0-1 当前专注度评估
    raw_data: dict[str, Any] | None = None

    def __post_init__(self):
        if self.raw_data is None:
            self.raw_data = {}


@dataclass
class ActivitySegment:
    """一段连续活动"""
    id: str
    start_time: datetime
    end_time: datetime | None = None
    category: str = ""
    description: str = ""
    motive: str = ""
    focus_avg: float = 0.0
    snapshots_count: int = 0
