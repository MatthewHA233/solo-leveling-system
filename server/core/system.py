"""
独自升级系统 - 主系统循环
串联感知层、认知层、系统层，启动所有引擎
"""

import asyncio
import uuid
from datetime import datetime
from pathlib import Path

import uvicorn

from .config import load_config, Config
from .events import EventBus, EventType, bus
from .player import Player, PlayerStats, PlayerManager
from ..perception.screen_capture import ScreenCapture
from ..perception.window_detector import WindowDetector
from ..perception.device_manager import DeviceManager
from ..perception.openclaw_bridge import OpenClawBridge
from ..cognition.analyzer import Analyzer
from ..cognition.pattern_detector import PatternDetector
from ..cognition.motive_engine import MotiveEngine
from ..system.quest_engine import QuestEngine
from ..system.buff_engine import BuffEngine
from ..system.exp_engine import ExpEngine
from ..system.achievement import AchievementEngine
from ..system.notification import NotificationEngine
from ..system.shop import ShopSystem
from ..system.penalty import PenaltySystem
from ..system.skills import SkillSystem
from ..system.shadow_army import ShadowArmy
from ..system.hidden_quests import HiddenQuestDetector
from ..cognition.pattern_detector import PatternDetector
from ..storage.database import Database
from ..storage.models import ContextSnapshot
from ..api.server import app as fastapi_app, set_system_ref, broadcast_ws


class SoloLevelingSystem:
    """独自升级系统核心"""

    def __init__(self, config: Config | None = None):
        self.config = config or load_config()
        self.bus = bus  # 使用全局事件总线
        self.running = False
        self.start_time: datetime | None = None

        # 初始化各模块
        self.db = Database(self.config.storage.database)

        # 玩家
        self.player = Player(
            name=self.config.player.name,
            stats=PlayerStats(**self.config.player.initial_stats),
        )
        self.player_mgr = PlayerManager(self.player, self.bus)

        # 感知层
        self.screen_capture = ScreenCapture(
            self.config.perception.screen_capture,
            self.bus,
            self.config.storage.screenshots_dir,
        )
        self.window_detector = WindowDetector(
            self.bus,
            self.config.perception.window_detector.interval,
        )
        self.device_manager = DeviceManager()
        self.openclaw_bridge = OpenClawBridge(
            self.device_manager,
            self.config.storage.screenshots_dir,
        )

        # 认知层
        self.analyzer = Analyzer(self.config.ai, self.config.cognition, self.bus)
        self.pattern_detector = PatternDetector(self.db, self.bus)
        self.motive_engine = MotiveEngine()

        # 系统层
        self.quest_engine = QuestEngine(self.db, self.player_mgr, self.bus)
        self.buff_engine = BuffEngine(self.player_mgr, self.bus)
        self.exp_engine = ExpEngine(self.player_mgr, self.bus)
        self.achievement_engine = AchievementEngine(self.player_mgr, self.bus)
        self.notification_engine = NotificationEngine(self.config.notification, self.bus)
        self.shop = ShopSystem(self.bus)
        self.penalty_system = PenaltySystem(self.player_mgr, self.bus)
        self.skill_system = SkillSystem(self.bus)
        self.shadow_army = ShadowArmy(self.bus)
        self.hidden_quest_detector = HiddenQuestDetector()

        # 状态追踪
        self._current_window = ""
        self._current_title = ""
        self._analysis_counter = 0

        # 注册核心事件处理
        self.bus.on(EventType.SCREEN_CAPTURED, self._on_screen_captured)
        self.bus.on(EventType.WINDOW_CHANGED, self._on_window_changed)
        self.bus.on(EventType.NOTIFICATION_PUSH, self._on_notification)

    async def start(self) -> None:
        """启动系统"""
        print("=" * 60)
        print("  ⚔️  独自升级系统 v0.1.0")
        print("  你已被选中为玩家。")
        print("=" * 60)

        # 连接数据库
        await self.db.connect()

        # 加载已有玩家数据
        saved = await self.db.load_player()
        if saved:
            self.player.name = saved["name"]
            self.player.level = saved["level"]
            self.player.exp = saved["exp"]
            self.player.title = saved["title"]
            self.player.stats = PlayerStats(**saved["stats"])
            self.player.titles_unlocked = saved["titles_unlocked"]
            self.player.total_quests_completed = saved["total_quests_completed"]
            print(f"  ✅ 加载存档: {self.player.name} Lv.{self.player.level}")
        else:
            print(f"  🆕 新建存档: {self.player.name}")

        self.running = True
        self.start_time = datetime.now()

        # 发送系统启动事件
        await self.bus.emit_simple(EventType.SYSTEM_START)

        # 生成每日任务
        await self.quest_engine.generate_daily_quests()

        # 欢迎通知
        await self.notification_engine.push(
            "系统已激活",
            f"欢迎回来, {self.player.name}。\n"
            f"当前等级: Lv.{self.player.level} | 称号: {self.player.title}",
            style="info",
        )

        # 启动感知层
        await self.screen_capture.start()
        await self.window_detector.start()

        # 检查 OpenClaw 多设备支持
        if await self.openclaw_bridge.check_openclaw():
            devices = await self.openclaw_bridge.discover_devices()
            if devices:
                print(f"  📱 发现 {len(devices)} 个已配对设备")
                for d in devices:
                    status = "🟢" if d["status"] == "online" else "⚪"
                    print(f"     {status} {d['name']} ({d['device_type']})")
            else:
                print(f"  📱 OpenClaw 可用，暂无配对设备")
        else:
            print(f"  📱 OpenClaw 未检测到，使用本地感知模式")

        # 设置 Web API 引用
        set_system_ref(self)

        print(f"\n  🌐 Web 面板: http://localhost:{self.config.web.port}")
        print(f"  📊 感知间隔: {self.config.perception.screen_capture.interval}s")
        print(f"  🧠 分析间隔: {self.config.system.analysis_interval}s")
        print(f"  🤖 AI 模型: {self.config.ai.model}")
        print("=" * 60)
        print("  系统运行中... (Ctrl+C 停止)\n")

        # 启动主循环和 Web 服务
        await asyncio.gather(
            self._main_loop(),
            self._start_web(),
            self._save_loop(),
        )

    async def stop(self) -> None:
        """停止系统"""
        print("\n⚔️ 系统关闭中...")
        self.running = False
        await self.screen_capture.stop()
        await self.window_detector.stop()
        await self._save_player()
        await self.db.close()
        await self.bus.emit_simple(EventType.SYSTEM_STOP)
        print("✅ 系统已安全关闭。存档已保存。")

    async def _main_loop(self) -> None:
        """主系统循环"""
        tick_count = 0
        analysis_interval = self.config.system.analysis_interval

        while self.running:
            try:
                tick_count += 1
                await self.bus.emit_simple(EventType.SYSTEM_TICK, tick=tick_count)

                # 每 N 秒执行一次 AI 分析
                if tick_count % (analysis_interval // 10) == 0:
                    await self._run_analysis()

                # 每 5 分钟检查过期任务
                if tick_count % 30 == 0:
                    await self.quest_engine.check_expired_quests()

                # 每 2 分钟轮询多设备状态
                if tick_count % 12 == 0 and self.openclaw_bridge._openclaw_available:
                    await self.openclaw_bridge.poll_all_devices()

            except Exception as e:
                print(f"[System] 主循环错误: {e}")

            await asyncio.sleep(10)  # 主循环每 10 秒 tick 一次

    async def _run_analysis(self) -> None:
        """执行一次 AI 分析"""
        self._analysis_counter += 1

        # 分析当前屏幕
        # 找最新截图
        screenshots_dir = Path(self.config.storage.screenshots_dir)
        screenshots = sorted(screenshots_dir.glob("*.jpg"), key=lambda p: p.stat().st_mtime)
        latest_screenshot = str(screenshots[-1]) if screenshots else None

        analysis = await self.analyzer.analyze_screenshot(
            screenshot_path=latest_screenshot,
            window_name=self._current_window,
            window_title=self._current_title,
        )

        if analysis:
            # 保存快照
            snapshot = ContextSnapshot(
                id=f"snap_{uuid.uuid4().hex[:8]}",
                timestamp=datetime.now(),
                screenshot_path=latest_screenshot,
                active_window=self._current_window,
                window_title=self._current_title,
                ai_analysis=analysis.get("activity", ""),
                inferred_motive=analysis.get("motive", ""),
                activity_category=analysis.get("category", ""),
                focus_score=analysis.get("focus_score", 0.5),
            )
            await self.db.save_snapshot(snapshot)

            # 每 3 次分析做一次深度动机推断
            if self._analysis_counter % 3 == 0:
                await self.analyzer.infer_motive()

            # 每次分析后检测行为模式
            await self.pattern_detector.detect()

    async def _start_web(self) -> None:
        """启动 Web 服务"""
        if not self.config.web.enabled:
            return

        config = uvicorn.Config(
            fastapi_app,
            host=self.config.web.host,
            port=self.config.web.port,
            log_level="warning",
        )
        server = uvicorn.Server(config)
        await server.serve()

    async def _save_loop(self) -> None:
        """定时保存玩家数据"""
        while self.running:
            await asyncio.sleep(60)
            await self._save_player()

    async def _save_player(self) -> None:
        """保存玩家数据"""
        try:
            await self.db.save_player(self.player.to_dict())
        except Exception as e:
            print(f"[System] 保存失败: {e}")

    async def _on_screen_captured(self, event) -> None:
        """处理截屏事件"""
        pass  # 分析在 _run_analysis 中按间隔执行

    async def _on_window_changed(self, event) -> None:
        """处理窗口切换事件"""
        self._current_window = event.data.get("window", "")
        self._current_title = event.data.get("title", "")

    async def _on_notification(self, event) -> None:
        """转发通知到 WebSocket"""
        notification = event.data.get("notification")
        if notification:
            await broadcast_ws({"notification": notification})


async def main():
    """入口"""
    system = SoloLevelingSystem()
    try:
        await system.start()
    except KeyboardInterrupt:
        await system.stop()
    except Exception as e:
        print(f"[Fatal] {e}")
        await system.stop()


if __name__ == "__main__":
    asyncio.run(main())
