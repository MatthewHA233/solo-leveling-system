"""
OpenClaw 集成层
利用 OpenClaw 的 nodes 系统实现:
- 自动发现已配对设备
- 通过 screen.record / canvas.snapshot 获取截屏
- 通过 system.run 获取窗口信息
- 通过 camera.snap 获取摄像头 (可选)
- 通过 location.get 获取位置 (可选)

OpenClaw 提供的能力:
- nodes status: 列出所有配对设备
- nodes describe: 获取设备详情和能力
- nodes canvas snapshot: 截屏
- nodes screen record: 屏幕录制
- nodes run: 在设备上执行命令
- nodes camera snap: 拍照
- nodes location get: 获取位置
- nodes notify: 发送通知到设备
"""

import asyncio
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from .device_manager import DeviceManager, DeviceType, DeviceStatus


# 设备类型检测规则
DEVICE_TYPE_HINTS = {
    "macos": DeviceType.MAC,
    "darwin": DeviceType.MAC,
    "mac": DeviceType.MAC,
    "macbook": DeviceType.MAC,
    "imac": DeviceType.MAC,
    "windows": DeviceType.WINDOWS,
    "win": DeviceType.WINDOWS,
    "android": DeviceType.ANDROID,
    "pixel": DeviceType.ANDROID,
    "samsung": DeviceType.ANDROID,
    "ios": DeviceType.IOS,
    "iphone": DeviceType.IOS,
    "ipad": DeviceType.IOS,
    "linux": DeviceType.LINUX,
    "ubuntu": DeviceType.LINUX,
}


def _detect_device_type(name: str, description: str = "") -> DeviceType:
    """根据名称推断设备类型"""
    combined = (name + " " + description).lower()
    for hint, dtype in DEVICE_TYPE_HINTS.items():
        if hint in combined:
            return dtype
    return DeviceType.UNKNOWN


class OpenClawBridge:
    """OpenClaw 桥接层 — 连接独自升级系统与 OpenClaw nodes"""

    def __init__(self, device_manager: DeviceManager, screenshots_dir: str = "data/screenshots"):
        self.device_mgr = device_manager
        self.screenshots_dir = Path(screenshots_dir)
        self.screenshots_dir.mkdir(parents=True, exist_ok=True)
        self._openclaw_available = False

    async def check_openclaw(self) -> bool:
        """检查 OpenClaw 是否可用"""
        try:
            result = await self._run_cmd(["openclaw", "nodes", "status", "--json"])
            if result:
                self._openclaw_available = True
                return True
        except Exception:
            pass
        self._openclaw_available = False
        return False

    async def discover_devices(self) -> list[dict]:
        """通过 OpenClaw 发现已配对的设备"""
        if not self._openclaw_available:
            await self.check_openclaw()
            if not self._openclaw_available:
                return []

        try:
            result = await self._run_cmd(["openclaw", "nodes", "status", "--json"])
            if not result:
                return []

            nodes = json.loads(result)
            discovered = []

            for node in (nodes if isinstance(nodes, list) else nodes.get("nodes", [])):
                node_id = node.get("id", "")
                name = node.get("name", node.get("displayName", "Unknown"))
                capabilities = node.get("capabilities", [])

                device_type = _detect_device_type(
                    name,
                    json.dumps(node.get("metadata", {})),
                )

                device = self.device_mgr.register_device(
                    device_id=node_id,
                    name=name,
                    device_type=device_type,
                    capabilities=capabilities,
                )

                # 更新在线状态
                is_online = node.get("online", node.get("connected", False))
                device.status = DeviceStatus.ONLINE if is_online else DeviceStatus.OFFLINE

                discovered.append(device.to_dict())

            return discovered

        except Exception as e:
            print(f"[OpenClawBridge] 设备发现失败: {e}")
            return []

    async def capture_device_screen(self, device_id: str) -> str | None:
        """从指定设备获取屏幕截图"""
        if not self._openclaw_available:
            return None

        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"device_{device_id[:8]}_{timestamp}.jpg"
            filepath = self.screenshots_dir / filename

            result = await self._run_cmd([
                "openclaw", "nodes", "canvas", "snapshot",
                "--node", device_id,
                "--format", "jpg",
                "--max-width", "1280",
                "--quality", "0.7",
            ])

            if result and "MEDIA:" in result:
                # OpenClaw 返回 MEDIA:path 格式
                media_path = result.strip().split("MEDIA:", 1)[1].strip()
                # 复制到我们的截图目录
                import shutil
                shutil.copy2(media_path, str(filepath))
                return str(filepath)

        except Exception as e:
            print(f"[OpenClawBridge] 截屏失败 ({device_id}): {e}")

        return None

    async def get_device_window(self, device_id: str) -> dict | None:
        """获取设备当前窗口信息"""
        if not self._openclaw_available:
            return None

        try:
            # 在设备上执行命令获取窗口信息
            # macOS:
            mac_script = '''osascript -e 'tell application "System Events" to set frontApp to name of first application process whose frontmost is true' -e 'return frontApp' '''
            # Linux:
            linux_script = '''xdotool getactivewindow getwindowname 2>/dev/null || echo "unknown"'''

            result = await self._run_cmd([
                "openclaw", "nodes", "run",
                "--node", device_id,
                "--", "sh", "-c",
                f'({mac_script}) 2>/dev/null || ({linux_script}) 2>/dev/null || echo "unknown"',
            ])

            if result:
                return {
                    "window": result.strip(),
                    "title": result.strip(),
                    "device_id": device_id,
                    "timestamp": datetime.now().isoformat(),
                }

        except Exception as e:
            print(f"[OpenClawBridge] 获取窗口失败 ({device_id}): {e}")

        return None

    async def send_notification(self, device_id: str, title: str, message: str) -> bool:
        """向指定设备发送通知"""
        if not self._openclaw_available:
            return False

        try:
            await self._run_cmd([
                "openclaw", "nodes", "notify",
                "--node", device_id,
                "--title", title,
                "--body", message,
                "--priority", "active",
            ])
            return True
        except Exception:
            return False

    async def send_notification_to_active(self, title: str, message: str) -> bool:
        """向当前活跃设备发送通知"""
        active = self.device_mgr.get_active_device()
        if active:
            return await self.send_notification(active.id, title, message)
        return False

    async def poll_all_devices(self) -> list[dict]:
        """轮询所有在线设备的状态"""
        results = []
        for device in self.device_mgr._devices.values():
            if device.status == DeviceStatus.OFFLINE:
                continue

            window_info = await self.get_device_window(device.id)
            if window_info:
                self.device_mgr.report_activity(
                    device.id,
                    window=window_info.get("window", ""),
                    title=window_info.get("title", ""),
                )
                results.append(window_info)

        return results

    async def _run_cmd(self, cmd: list[str], timeout: int = 30) -> str | None:
        """异步执行命令"""
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout,
            )
            if proc.returncode == 0:
                return stdout.decode("utf-8", errors="replace")
            return None
        except asyncio.TimeoutError:
            proc.kill()
            return None
        except FileNotFoundError:
            # openclaw 命令不存在
            self._openclaw_available = False
            return None
        except Exception:
            return None
