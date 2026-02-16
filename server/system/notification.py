"""
通知引擎
独自升级风格的桌面通知推送
"""

import json
import platform
import subprocess
from datetime import datetime

from ..core.events import EventBus, EventType, Event
from ..core.config import NotificationConfig


class NotificationEngine:
    """跨平台通知引擎"""

    def __init__(self, config: NotificationConfig, event_bus: EventBus):
        self.config = config
        self.bus = event_bus
        self._system = platform.system()
        self._pending: list[dict] = []  # 待推送队列 (给 WebSocket 用)
        self._register_handlers()

    def _register_handlers(self):
        self.bus.on(EventType.QUEST_TRIGGERED, self._on_quest_triggered)
        self.bus.on(EventType.QUEST_COMPLETED, self._on_quest_completed)
        self.bus.on(EventType.QUEST_FAILED, self._on_quest_failed)
        self.bus.on(EventType.BUFF_ACTIVATED, self._on_buff_activated)
        self.bus.on(EventType.DEBUFF_ACTIVATED, self._on_debuff_activated)
        self.bus.on(EventType.LEVEL_UP, self._on_level_up)
        self.bus.on(EventType.EXP_GAINED, self._on_exp_gained)

    def _is_dnd(self) -> bool:
        """检查是否在免打扰时间"""
        if not self.config.dnd.enabled:
            return False
        now = datetime.now()
        hour_min = now.strftime("%H:%M")
        start = self.config.dnd.start
        end = self.config.dnd.end

        if start <= end:
            return start <= hour_min <= end
        else:
            return hour_min >= start or hour_min <= end

    async def push(self, title: str, message: str, style: str = "info") -> None:
        """推送通知"""
        if not self.config.enabled:
            return

        notification = {
            "title": title,
            "message": message,
            "style": style,
            "timestamp": datetime.now().isoformat(),
        }

        # 添加到待推送队列 (Web UI 通过 WebSocket 获取)
        self._pending.append(notification)
        if len(self._pending) > 100:
            self._pending = self._pending[-100:]

        # 控制台输出
        icon = {"info": "ℹ️", "quest": "⚔️", "buff": "✨", "debuff": "💫",
                "levelup": "🎉", "exp": "⭐", "warning": "⚠️", "error": "❌"}.get(style, "📢")
        print(f"\n{icon} [{title}] {message}\n")

        # 桌面通知 (非免打扰时段)
        if not self._is_dnd():
            self._send_desktop_notification(title, message)

        # 触发通知事件 (给 WebSocket)
        await self.bus.emit_simple(
            EventType.NOTIFICATION_PUSH,
            notification=notification,
        )

    def pop_pending(self) -> list[dict]:
        """获取并清空待推送通知"""
        pending = self._pending.copy()
        self._pending.clear()
        return pending

    def _send_desktop_notification(self, title: str, message: str) -> None:
        """发送桌面通知"""
        try:
            if self._system == "Linux":
                subprocess.Popen(
                    ["notify-send", f"⚔️ {title}", message, "--urgency=normal"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            elif self._system == "Darwin":
                script = f'display notification "{message}" with title "⚔️ {title}"'
                subprocess.Popen(
                    ["osascript", "-e", script],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            elif self._system == "Windows":
                # 使用 PowerShell toast 通知
                ps_script = f'''
                [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
                $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
                $template.GetElementsByTagName("text")[0].AppendChild($template.CreateTextNode("⚔️ {title}")) | Out-Null
                $template.GetElementsByTagName("text")[1].AppendChild($template.CreateTextNode("{message}")) | Out-Null
                '''
                subprocess.Popen(
                    ["powershell", "-Command", ps_script],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        except Exception as e:
            print(f"[Notification] 桌面通知失败: {e}")

    # ── 事件处理 ──────────────────────────────────────

    async def _on_quest_triggered(self, event: Event) -> None:
        title = event.data.get("quest_title", "未知任务")
        difficulty = event.data.get("difficulty", "?")
        exp = event.data.get("exp_reward", 0)
        quest_type = event.data.get("quest_type", "side")

        type_label = {
            "daily": "每日任务",
            "main": "主线任务",
            "side": "支线任务",
            "hidden": "隐藏任务",
            "emergency": "紧急任务",
        }.get(quest_type, "任务")

        await self.push(
            f"新{type_label}！",
            f"[{difficulty}级] {title}\n奖励: {exp} EXP",
            style="quest",
        )

    async def _on_quest_completed(self, event: Event) -> None:
        title = event.data.get("quest_title", "未知任务")
        exp = event.data.get("exp_earned", 0)
        await self.push(
            "任务完成！",
            f"✅ {title}\n获得 {exp} EXP",
            style="quest",
        )

    async def _on_quest_failed(self, event: Event) -> None:
        title = event.data.get("quest_title", "未知任务")
        reason = event.data.get("reason", "")
        msg = f"❌ {title}"
        if reason == "expired":
            msg += "\n任务已过期"
        await self.push("任务失败", msg, style="warning")

    async def _on_buff_activated(self, event: Event) -> None:
        name = event.data.get("buff_name", "未知")
        effects = event.data.get("effects", {})
        effect_str = ", ".join(
            f"{k}: {'+' if v > 0 else ''}{v}" for k, v in effects.items()
            if k != "exp_multiplier"
        )
        if "exp_multiplier" in effects:
            effect_str += f", EXP x{effects['exp_multiplier']}"
        await self.push("Buff 激活！", f"{name}\n效果: {effect_str}", style="buff")

    async def _on_debuff_activated(self, event: Event) -> None:
        name = event.data.get("buff_name", "未知")
        await self.push("Debuff 触发！", f"{name}", style="debuff")

    async def _on_level_up(self, event: Event) -> None:
        level = event.data.get("new_level", "?")
        title = event.data.get("title", "")
        msg = f"等级提升至 Lv.{level}！"
        if event.data.get("title_changed"):
            msg += f"\n🏅 获得新称号: {title}"
        await self.push("🎉 升级！", msg, style="levelup")

    async def _on_exp_gained(self, event: Event) -> None:
        amount = event.data.get("amount", 0)
        source = event.data.get("source", "")
        multiplier = event.data.get("multiplier", 1.0)
        msg = f"+{amount} EXP"
        if multiplier > 1.0:
            msg += f" (x{multiplier} 加成)"
        # 只在大量经验时通知，避免刷屏
        if amount >= 30:
            await self.push("经验获得", msg, style="exp")
