"""
屏幕捕捉模块
定时截取屏幕，保存并触发分析事件
"""

import asyncio
import io
import uuid
from datetime import datetime
from pathlib import Path

from PIL import Image

from ..core.config import ScreenCaptureConfig
from ..core.events import EventBus, EventType


class ScreenCapture:
    """跨平台屏幕截图"""

    def __init__(self, config: ScreenCaptureConfig, event_bus: EventBus, save_dir: str = "data/screenshots"):
        self.config = config
        self.bus = event_bus
        self.save_dir = Path(save_dir)
        self.save_dir.mkdir(parents=True, exist_ok=True)
        self._running = False

    async def start(self) -> None:
        """开始定时截屏"""
        if not self.config.enabled:
            return
        self._running = True
        asyncio.create_task(self._capture_loop())

    async def stop(self) -> None:
        self._running = False

    async def _capture_loop(self) -> None:
        """截屏主循环"""
        while self._running:
            try:
                result = await self.capture_once()
                if result:
                    await self.bus.emit_simple(
                        EventType.SCREEN_CAPTURED,
                        screenshot_path=result["path"],
                        timestamp=result["timestamp"],
                    )
            except Exception as e:
                print(f"[ScreenCapture] 截屏出错: {e}")

            await asyncio.sleep(self.config.interval)

    async def capture_once(self) -> dict | None:
        """执行一次截屏"""
        try:
            # mss 是同步库，在线程池中运行
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, self._sync_capture)
            return result
        except Exception as e:
            print(f"[ScreenCapture] 截屏失败: {e}")
            return None

    def _sync_capture(self) -> dict | None:
        """同步截屏操作"""
        try:
            import mss
        except ImportError:
            print("[ScreenCapture] mss 未安装，跳过截屏")
            return None

        timestamp = datetime.now()
        filename = f"{timestamp.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.jpg"
        filepath = self.save_dir / filename

        with mss.mss() as sct:
            # 捕捉主显示器
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            screenshot = sct.grab(monitor)

            # 转为 PIL Image
            img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")

            # 缩放以节省空间和 token
            if self.config.resize_width and img.width > self.config.resize_width:
                ratio = self.config.resize_width / img.width
                new_size = (self.config.resize_width, int(img.height * ratio))
                img = img.resize(new_size, Image.Resampling.LANCZOS)

            # 保存
            img.save(str(filepath), "JPEG", quality=self.config.quality)

        # 清理旧截图
        self._cleanup_old_screenshots()

        return {
            "path": str(filepath),
            "timestamp": timestamp.isoformat(),
            "size": filepath.stat().st_size,
        }

    def _cleanup_old_screenshots(self) -> None:
        """清理超出数量限制的旧截图"""
        screenshots = sorted(self.save_dir.glob("*.jpg"), key=lambda p: p.stat().st_mtime)
        while len(screenshots) > self.config.max_stored:
            oldest = screenshots.pop(0)
            oldest.unlink(missing_ok=True)
