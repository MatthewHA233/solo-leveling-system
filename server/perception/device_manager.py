"""
多设备管理器
跨设备感知: Mac / Windows / Android / iOS
利用 OpenClaw Nodes 系统实现设备发现和数据收集
当用户切换设备时，系统注意力跟随转移

架构:
  Gateway (服务器) ← WebSocket → Node (Mac/Win/Android)
  
  每个 Node 定期上报:
  - 屏幕截图 (canvas.snapshot / screen.record)  
  - 活跃窗口信息 (system.run)
  - 设备状态 (电量/网络等)
  
  Gateway 端的独自升级系统:
  - 接收多设备数据
  - 判断哪个设备是当前活跃设备
  - 将注意力聚焦到活跃设备
  - 合并多设备的活动时间线
"""

from datetime import datetime, timedelta
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class DeviceType(str, Enum):
    MAC = "mac"
    WINDOWS = "windows"
    LINUX = "linux"
    ANDROID = "android"
    IOS = "ios"
    UNKNOWN = "unknown"


class DeviceStatus(str, Enum):
    ONLINE = "online"
    IDLE = "idle"
    OFFLINE = "offline"
    SLEEPING = "sleeping"


@dataclass
class DeviceInfo:
    """设备信息"""
    id: str                          # OpenClaw Node ID
    name: str                        # 设备名称
    device_type: DeviceType          # 设备类型
    status: DeviceStatus = DeviceStatus.OFFLINE
    last_seen: datetime | None = None
    last_activity: datetime | None = None
    is_active: bool = False          # 当前是否为活跃设备
    capabilities: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    # 感知数据
    current_window: str = ""
    current_title: str = ""
    screen_brightness: float = -1    # -1 = 未知
    battery_level: float = -1        # -1 = 未知
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "device_type": self.device_type.value,
            "status": self.status.value,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
            "last_activity": self.last_activity.isoformat() if self.last_activity else None,
            "is_active": self.is_active,
            "capabilities": self.capabilities,
            "current_window": self.current_window,
            "current_title": self.current_title,
            "battery_level": self.battery_level,
        }


class DeviceManager:
    """多设备管理器"""

    def __init__(self):
        self._devices: dict[str, DeviceInfo] = {}
        self._active_device_id: str | None = None
        self._activity_history: list[dict] = []
        self._switch_history: list[dict] = []  # 设备切换记录

    def register_device(self, device_id: str, name: str,
                       device_type: DeviceType,
                       capabilities: list[str] | None = None) -> DeviceInfo:
        """注册一个新设备"""
        device = DeviceInfo(
            id=device_id,
            name=name,
            device_type=device_type,
            capabilities=capabilities or [],
            status=DeviceStatus.ONLINE,
            last_seen=datetime.now(),
        )
        self._devices[device_id] = device
        return device

    def update_device(self, device_id: str, **kwargs) -> DeviceInfo | None:
        """更新设备状态"""
        device = self._devices.get(device_id)
        if not device:
            return None

        device.last_seen = datetime.now()

        for key, value in kwargs.items():
            if hasattr(device, key):
                setattr(device, key, value)

        # 如果有活动数据，标记为活跃
        if kwargs.get("current_window") or kwargs.get("current_title"):
            device.last_activity = datetime.now()
            device.status = DeviceStatus.ONLINE

        return device

    def report_activity(self, device_id: str, window: str = "",
                       title: str = "", screenshot_path: str = "") -> None:
        """设备上报活动数据"""
        device = self._devices.get(device_id)
        if not device:
            return

        now = datetime.now()
        device.last_seen = now
        device.last_activity = now
        device.current_window = window
        device.current_title = title
        device.status = DeviceStatus.ONLINE

        # 检查是否需要切换活跃设备
        self._check_active_device_switch(device_id)

        # 记录活动
        self._activity_history.append({
            "device_id": device_id,
            "device_name": device.name,
            "window": window,
            "title": title,
            "timestamp": now.isoformat(),
        })
        if len(self._activity_history) > 500:
            self._activity_history = self._activity_history[-500:]

    def _check_active_device_switch(self, reporting_device_id: str) -> None:
        """检查是否需要切换活跃设备"""
        now = datetime.now()
        reporting = self._devices.get(reporting_device_id)
        if not reporting:
            return

        current_active = self._devices.get(self._active_device_id) if self._active_device_id else None

        should_switch = False

        if not current_active:
            # 没有活跃设备，直接切换
            should_switch = True
        elif current_active.id == reporting_device_id:
            # 同一个设备，无需切换
            return
        elif current_active.last_activity:
            # 当前活跃设备超过 2 分钟没有活动
            idle_seconds = (now - current_active.last_activity).total_seconds()
            if idle_seconds > 120:
                should_switch = True
        else:
            should_switch = True

        if should_switch:
            old_active_id = self._active_device_id

            # 取消旧设备的活跃状态
            if current_active:
                current_active.is_active = False

            # 设置新活跃设备
            self._active_device_id = reporting_device_id
            reporting.is_active = True

            # 记录切换
            self._switch_history.append({
                "from_device": old_active_id,
                "from_name": current_active.name if current_active else None,
                "to_device": reporting_device_id,
                "to_name": reporting.name,
                "timestamp": now.isoformat(),
            })
            if len(self._switch_history) > 100:
                self._switch_history = self._switch_history[-100:]

    def check_idle_devices(self) -> None:
        """检查并标记空闲设备"""
        now = datetime.now()
        for device in self._devices.values():
            if device.last_seen:
                seconds_since = (now - device.last_seen).total_seconds()
                if seconds_since > 300:  # 5 分钟无活动
                    device.status = DeviceStatus.OFFLINE
                elif seconds_since > 60:  # 1 分钟无活动
                    device.status = DeviceStatus.IDLE

    def get_active_device(self) -> DeviceInfo | None:
        """获取当前活跃设备"""
        if self._active_device_id:
            return self._devices.get(self._active_device_id)
        return None

    def get_all_devices(self) -> list[dict]:
        """获取所有设备"""
        self.check_idle_devices()
        return [d.to_dict() for d in self._devices.values()]

    def get_switch_history(self, limit: int = 20) -> list[dict]:
        """获取设备切换历史"""
        return self._switch_history[-limit:]

    def get_merged_timeline(self, limit: int = 50) -> list[dict]:
        """获取合并的多设备活动时间线"""
        return sorted(
            self._activity_history[-limit:],
            key=lambda x: x["timestamp"],
            reverse=True,
        )

    def get_stats(self) -> dict:
        """获取多设备统计"""
        online = sum(1 for d in self._devices.values() if d.status == DeviceStatus.ONLINE)
        return {
            "total_devices": len(self._devices),
            "online_devices": online,
            "active_device": self._active_device_id,
            "active_device_name": (
                self._devices[self._active_device_id].name
                if self._active_device_id and self._active_device_id in self._devices
                else None
            ),
            "total_switches": len(self._switch_history),
        }
