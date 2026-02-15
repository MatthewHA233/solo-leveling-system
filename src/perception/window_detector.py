"""
活动窗口检测模块
检测当前活动窗口和标题，跨平台支持
"""

import asyncio
import platform
import subprocess
from datetime import datetime

from ..core.events import EventBus, EventType


class WindowDetector:
    """跨平台窗口检测"""

    def __init__(self, event_bus: EventBus, interval: int = 5):
        self.bus = event_bus
        self.interval = interval
        self._running = False
        self._last_window = ""
        self._last_title = ""
        self._system = platform.system()

    async def start(self) -> None:
        self._running = True
        asyncio.create_task(self._detect_loop())

    async def stop(self) -> None:
        self._running = False

    async def _detect_loop(self) -> None:
        while self._running:
            try:
                info = await self.get_active_window()
                if info and (info["window"] != self._last_window or info["title"] != self._last_title):
                    self._last_window = info["window"]
                    self._last_title = info["title"]
                    await self.bus.emit_simple(
                        EventType.WINDOW_CHANGED,
                        window=info["window"],
                        title=info["title"],
                        timestamp=datetime.now().isoformat(),
                    )
            except Exception as e:
                print(f"[WindowDetector] 检测出错: {e}")

            await asyncio.sleep(self.interval)

    async def get_active_window(self) -> dict[str, str] | None:
        """获取当前活动窗口信息"""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._sync_get_window)

    def _sync_get_window(self) -> dict[str, str] | None:
        try:
            if self._system == "Linux":
                return self._get_linux_window()
            elif self._system == "Darwin":
                return self._get_macos_window()
            elif self._system == "Windows":
                return self._get_windows_window()
            return None
        except Exception:
            return None

    def _get_linux_window(self) -> dict[str, str] | None:
        """Linux: 使用 xdotool"""
        try:
            window_id = subprocess.check_output(
                ["xdotool", "getactivewindow"], stderr=subprocess.DEVNULL
            ).decode().strip()

            window_name = subprocess.check_output(
                ["xdotool", "getactivewindow", "getwindowname"], stderr=subprocess.DEVNULL
            ).decode().strip()

            # 尝试获取进程名
            try:
                pid = subprocess.check_output(
                    ["xdotool", "getactivewindow", "getwindowpid"], stderr=subprocess.DEVNULL
                ).decode().strip()
                proc_name = subprocess.check_output(
                    ["ps", "-p", pid, "-o", "comm="], stderr=subprocess.DEVNULL
                ).decode().strip()
            except Exception:
                proc_name = "unknown"

            return {"window": proc_name, "title": window_name}
        except FileNotFoundError:
            # xdotool 未安装，尝试 xprop
            try:
                result = subprocess.check_output(
                    ["xprop", "-root", "_NET_ACTIVE_WINDOW"], stderr=subprocess.DEVNULL
                ).decode().strip()
                return {"window": "unknown", "title": result}
            except Exception:
                return None
        except Exception:
            return None

    def _get_macos_window(self) -> dict[str, str] | None:
        """macOS: 使用 osascript"""
        try:
            script = '''
            tell application "System Events"
                set frontApp to name of first application process whose frontmost is true
                set frontTitle to ""
                try
                    tell application process frontApp
                        set frontTitle to name of front window
                    end tell
                end try
                return frontApp & "|||" & frontTitle
            end tell
            '''
            result = subprocess.check_output(
                ["osascript", "-e", script], stderr=subprocess.DEVNULL
            ).decode().strip()

            parts = result.split("|||", 1)
            return {
                "window": parts[0] if parts else "unknown",
                "title": parts[1] if len(parts) > 1 else "",
            }
        except Exception:
            return None

    def _get_windows_window(self) -> dict[str, str] | None:
        """Windows: 使用 pywin32"""
        try:
            import win32gui
            import win32process
            import psutil

            hwnd = win32gui.GetForegroundWindow()
            title = win32gui.GetWindowText(hwnd)
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            try:
                proc = psutil.Process(pid)
                name = proc.name()
            except Exception:
                name = "unknown"

            return {"window": name, "title": title}
        except ImportError:
            return None
        except Exception:
            return None
