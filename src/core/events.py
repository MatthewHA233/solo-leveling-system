"""
事件总线 - 系统内部通信
所有模块通过事件总线进行松耦合通信
"""

import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Coroutine


class EventType(Enum):
    # 感知层事件
    SCREEN_CAPTURED = "screen_captured"
    WINDOW_CHANGED = "window_changed"
    INPUT_ACTIVITY = "input_activity"
    USER_IDLE = "user_idle"
    USER_ACTIVE = "user_active"

    # 认知层事件
    CONTEXT_ANALYZED = "context_analyzed"
    MOTIVE_INFERRED = "motive_inferred"
    PATTERN_DETECTED = "pattern_detected"

    # 系统事件
    QUEST_TRIGGERED = "quest_triggered"
    QUEST_COMPLETED = "quest_completed"
    QUEST_FAILED = "quest_failed"
    BUFF_ACTIVATED = "buff_activated"
    BUFF_EXPIRED = "buff_expired"
    DEBUFF_ACTIVATED = "debuff_activated"
    DEBUFF_EXPIRED = "debuff_expired"
    LEVEL_UP = "level_up"
    EXP_GAINED = "exp_gained"
    STAT_CHANGED = "stat_changed"

    # 影子军团事件
    SHADOW_EXTRACTED = "shadow_extracted"
    SHADOW_DEPLOYED = "shadow_deployed"
    SHADOW_RECALLED = "shadow_recalled"
    SHADOW_DESTROYED = "shadow_destroyed"
    SHADOW_LEVEL_UP = "shadow_level_up"
    SHADOW_EXECUTED = "shadow_executed"

    # 通知事件
    NOTIFICATION_PUSH = "notification_push"

    # 系统生命周期
    SYSTEM_START = "system_start"
    SYSTEM_STOP = "system_stop"
    SYSTEM_TICK = "system_tick"


@dataclass
class Event:
    type: EventType
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.now)
    source: str = "system"


# 事件处理器类型
EventHandler = Callable[[Event], Coroutine[Any, Any, None]]


class EventBus:
    """异步事件总线"""

    def __init__(self):
        self._handlers: dict[EventType, list[EventHandler]] = defaultdict(list)
        self._history: list[Event] = []
        self._max_history: int = 1000

    def on(self, event_type: EventType, handler: EventHandler) -> None:
        """注册事件处理器"""
        self._handlers[event_type].append(handler)

    def off(self, event_type: EventType, handler: EventHandler) -> None:
        """移除事件处理器"""
        if handler in self._handlers[event_type]:
            self._handlers[event_type].remove(handler)

    async def emit(self, event: Event) -> None:
        """触发事件，通知所有注册的处理器"""
        self._history.append(event)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

        handlers = self._handlers.get(event.type, [])
        if handlers:
            await asyncio.gather(
                *(handler(event) for handler in handlers),
                return_exceptions=True,
            )

    async def emit_simple(self, event_type: EventType, **data) -> None:
        """简便触发事件"""
        await self.emit(Event(type=event_type, data=data))

    def get_history(
        self,
        event_type: EventType | None = None,
        limit: int = 50,
    ) -> list[Event]:
        """获取事件历史"""
        if event_type:
            filtered = [e for e in self._history if e.type == event_type]
        else:
            filtered = self._history
        return filtered[-limit:]


# 全局事件总线实例
bus = EventBus()
