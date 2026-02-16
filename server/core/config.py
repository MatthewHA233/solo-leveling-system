"""
配置管理模块
加载 YAML 配置，支持默认配置 + 本地覆盖
"""

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class PlayerConfig(BaseModel):
    name: str = "Player"
    initial_level: int = 1
    initial_stats: dict[str, int] = Field(default_factory=lambda: {
        "focus": 50,
        "productivity": 50,
        "consistency": 50,
        "creativity": 50,
        "wellness": 50,
    })


class AIConfig(BaseModel):
    provider: str = "claude"
    api_base: str = "https://cn.xingsuancode.com/v1"
    model: str = "claude-opus-4-6"
    api_key: str = ""
    max_tokens: int = 2048
    temperature: float = 0.7


class ScreenCaptureConfig(BaseModel):
    enabled: bool = True
    interval: int = 30
    quality: int = 70
    resize_width: int = 1280
    max_stored: int = 100


class WindowDetectorConfig(BaseModel):
    enabled: bool = True
    interval: int = 5


class InputMonitorConfig(BaseModel):
    enabled: bool = False


class PerceptionConfig(BaseModel):
    screen_capture: ScreenCaptureConfig = Field(default_factory=ScreenCaptureConfig)
    window_detector: WindowDetectorConfig = Field(default_factory=WindowDetectorConfig)
    input_monitor: InputMonitorConfig = Field(default_factory=InputMonitorConfig)


class CognitionConfig(BaseModel):
    analysis_style: str = "solo_leveling"
    context_window: int = 10
    motive_sensitivity: float = 0.6


class QuestsConfig(BaseModel):
    daily_reset_hour: int = 5
    auto_generate: bool = True
    max_active_quests: int = 10


class DNDConfig(BaseModel):
    enabled: bool = True
    start: str = "23:00"
    end: str = "08:00"


class NotificationConfig(BaseModel):
    enabled: bool = True
    style: str = "solo_leveling"
    sound: bool = True
    dnd: DNDConfig = Field(default_factory=DNDConfig)


class WebConfig(BaseModel):
    enabled: bool = True
    host: str = "0.0.0.0"
    port: int = 8888


class StorageConfig(BaseModel):
    database: str = "data/system.db"
    screenshots_dir: str = "data/screenshots"
    max_screenshot_age_days: int = 7
    max_storage_mb: int = 2048


class SystemConfig(BaseModel):
    name: str = "独自升级系统"
    version: str = "0.1.0"
    capture_interval: int = 30
    analysis_interval: int = 60
    timezone: str = "Asia/Shanghai"


class Config(BaseModel):
    system: SystemConfig = Field(default_factory=SystemConfig)
    player: PlayerConfig = Field(default_factory=PlayerConfig)
    ai: AIConfig = Field(default_factory=AIConfig)
    perception: PerceptionConfig = Field(default_factory=PerceptionConfig)
    cognition: CognitionConfig = Field(default_factory=CognitionConfig)
    quests: QuestsConfig = Field(default_factory=QuestsConfig)
    notification: NotificationConfig = Field(default_factory=NotificationConfig)
    web: WebConfig = Field(default_factory=WebConfig)
    storage: StorageConfig = Field(default_factory=StorageConfig)


def load_config(config_dir: str | Path = "config") -> Config:
    """加载配置文件，优先级: local.yaml > default.yaml"""
    config_dir = Path(config_dir)
    data: dict[str, Any] = {}

    # 加载默认配置
    default_path = config_dir / "default.yaml"
    if default_path.exists():
        with open(default_path) as f:
            data = yaml.safe_load(f) or {}

    # 加载本地覆盖
    local_path = config_dir / "local.yaml"
    if local_path.exists():
        with open(local_path) as f:
            local_data = yaml.safe_load(f) or {}
            data = _deep_merge(data, local_data)

    # 从环境变量读取 API key
    if not data.get("ai", {}).get("api_key"):
        env_key = os.environ.get("SOLO_AI_API_KEY", "")
        if env_key:
            data.setdefault("ai", {})["api_key"] = env_key

    return Config(**data)


def _deep_merge(base: dict, override: dict) -> dict:
    """深度合并两个字典"""
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result
