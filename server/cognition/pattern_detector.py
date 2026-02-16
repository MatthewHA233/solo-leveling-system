"""
行为模式检测器
基于上下文历史分析行为模式，触发对应事件
"""

from datetime import datetime, timedelta
from collections import Counter

from ..core.events import EventBus, EventType, Event
from ..storage.database import Database


class PatternType:
    DEEP_FOCUS = "deep_focus"
    DISTRACTION = "distraction"
    LEARNING = "learning"
    CREATIVE = "creative"
    FATIGUE = "fatigue"
    PROCRASTINATION = "procrastination"
    NORMAL = "normal"


# 模式检测规则
PATTERN_RULES = {
    PatternType.DEEP_FOCUS: {
        "description": "连续专注工作 30+ 分钟",
        "min_snapshots": 3,
        "min_avg_focus": 0.75,
        "allowed_categories": {"coding", "writing", "work", "learning"},
    },
    PatternType.DISTRACTION: {
        "description": "频繁切换应用/浏览社交媒体",
        "min_snapshots": 3,
        "max_avg_focus": 0.35,
        "high_switch_rate": True,
    },
    PatternType.LEARNING: {
        "description": "学习/阅读教程 + 实践",
        "min_snapshots": 2,
        "required_categories": {"learning"},
        "min_ratio": 0.5,
    },
    PatternType.CREATIVE: {
        "description": "创作活动活跃",
        "min_snapshots": 2,
        "required_categories": {"writing", "creative"},
        "min_ratio": 0.5,
    },
    PatternType.FATIGUE: {
        "description": "活动减少 + 无意义浏览",
        "min_snapshots": 4,
        "max_avg_focus": 0.3,
        "fatigue_indicators": True,
    },
    PatternType.PROCRASTINATION: {
        "description": "反复打开又关闭工作应用",
        "min_snapshots": 3,
        "procrastination_indicators": True,
    },
}


class PatternDetector:
    """行为模式检测器"""

    def __init__(self, db: Database, event_bus: EventBus):
        self.db = db
        self.bus = event_bus
        self._window_history: list[dict] = []  # 窗口切换历史
        self._max_history = 100
        self._last_pattern: str = PatternType.NORMAL
        self._pattern_start: datetime | None = None

        self.bus.on(EventType.WINDOW_CHANGED, self._on_window_changed)

    async def _on_window_changed(self, event: Event) -> None:
        """记录窗口切换"""
        self._window_history.append({
            "window": event.data.get("window", ""),
            "title": event.data.get("title", ""),
            "timestamp": datetime.now(),
        })
        if len(self._window_history) > self._max_history:
            self._window_history = self._window_history[-self._max_history:]

    async def detect(self) -> str:
        """检测当前行为模式"""
        snapshots = await self.db.get_recent_snapshots(limit=10)
        if len(snapshots) < 2:
            return PatternType.NORMAL

        # 计算指标
        focus_scores = [s.focus_score for s in snapshots if s.focus_score > 0]
        categories = [s.activity_category for s in snapshots if s.activity_category]
        avg_focus = sum(focus_scores) / len(focus_scores) if focus_scores else 0.5
        category_counts = Counter(categories)

        # 窗口切换频率 (最近 5 分钟)
        recent_switches = [
            w for w in self._window_history
            if w["timestamp"] > datetime.now() - timedelta(minutes=5)
        ]
        switch_rate = len(recent_switches)

        # 逐一检测模式
        detected = PatternType.NORMAL

        # 深度专注
        if (len(snapshots) >= 3 and avg_focus >= 0.75 and
                all(s.activity_category in {"coding", "writing", "work", "learning"}
                    for s in snapshots[:3] if s.activity_category)):
            detected = PatternType.DEEP_FOCUS

        # 注意力涣散
        elif avg_focus < 0.35 and switch_rate >= 8:
            detected = PatternType.DISTRACTION

        # 学习模式
        elif category_counts.get("learning", 0) >= len(categories) * 0.5 and len(categories) >= 2:
            detected = PatternType.LEARNING

        # 创作模式
        elif (category_counts.get("writing", 0) + category_counts.get("creative", 0)) >= len(categories) * 0.5:
            detected = PatternType.CREATIVE

        # 疲劳
        elif len(snapshots) >= 4 and avg_focus < 0.3:
            now = datetime.now()
            # 深夜或连续低专注
            if now.hour >= 23 or now.hour < 5 or avg_focus < 0.2:
                detected = PatternType.FATIGUE

        # 拖延
        elif switch_rate >= 10 and avg_focus < 0.4:
            # 频繁切换 + 低专注 = 可能在拖延
            social_ratio = (category_counts.get("social", 0) + category_counts.get("media", 0)) / max(len(categories), 1)
            if social_ratio > 0.4:
                detected = PatternType.PROCRASTINATION

        # 如果模式发生变化，触发事件
        if detected != self._last_pattern:
            self._last_pattern = detected
            self._pattern_start = datetime.now()

            if detected != PatternType.NORMAL:
                await self.bus.emit_simple(
                    EventType.PATTERN_DETECTED,
                    pattern_type=detected,
                    avg_focus=round(avg_focus, 2),
                    switch_rate=switch_rate,
                    categories=dict(category_counts),
                    description=PATTERN_RULES.get(detected, {}).get("description", ""),
                )

        return detected

    def get_switch_rate(self, minutes: int = 5) -> int:
        """获取最近 N 分钟内窗口切换次数"""
        cutoff = datetime.now() - timedelta(minutes=minutes)
        return sum(1 for w in self._window_history if w["timestamp"] > cutoff)

    def get_current_pattern(self) -> dict:
        """获取当前模式信息"""
        return {
            "pattern": self._last_pattern,
            "since": self._pattern_start.isoformat() if self._pattern_start else None,
            "duration_minutes": (
                (datetime.now() - self._pattern_start).total_seconds() / 60
                if self._pattern_start else 0
            ),
            "switch_rate_5min": self.get_switch_rate(5),
        }
