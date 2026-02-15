"""
隐藏任务系统
独自升级里最有趣的元素 — 在特殊条件下自动触发，奖励丰厚

触发类型:
  - 行为模式: 基于用户行为的连续模式
  - 时间触发: 特定时间/日期
  - 里程碑: 达到某个累计数值
  - 组合触发: 多个条件同时满足
  - 随机触发: 低概率随机出现
"""

import random
from datetime import datetime
from typing import Any


# ═══════════════════════════════════════════════════════════════
# 隐藏任务定义
# ═══════════════════════════════════════════════════════════════

HIDDEN_QUESTS = {
    # ── 行为模式触发 ────────────────────────────────────

    "night_owl": {
        "title": "🦉 夜鹰的觉悟",
        "description": "深夜 2 点后仍在高效工作。系统检测到你的意志力超乎常人。",
        "difficulty": "B",
        "exp_reward": 100,
        "trigger": {
            "type": "time_activity",
            "condition": "productive_after_2am",
            "description": "凌晨 2 点后保持生产性活动 30 分钟",
        },
        "rewards_extra": {"title": "夜鹰"},
        "system_message": "「深夜仍在战斗的猎人……系统对你的毅力表示认可。」",
        "repeatable": False,
    },
    "early_bird": {
        "title": "🌅 黎明的觉醒者",
        "description": "清晨 6 点前就开始工作。在别人还在沉睡时，你已经出发了。",
        "difficulty": "B",
        "exp_reward": 100,
        "trigger": {
            "type": "time_activity",
            "condition": "productive_before_6am",
            "description": "清晨 6 点前开始生产性活动",
        },
        "rewards_extra": {"title": "早起者"},
        "system_message": "「黎明前的黑暗中，只有强者已经出发。」",
        "repeatable": False,
    },
    "marathon_coder": {
        "title": "⌨️ 编码马拉松",
        "description": "连续编程超过 4 小时不间断。这份专注力已经达到了 S 级猎人的水准。",
        "difficulty": "A",
        "exp_reward": 200,
        "trigger": {
            "type": "continuous_activity",
            "condition": "coding_4h_continuous",
            "category": "coding",
            "duration_minutes": 240,
        },
        "rewards_extra": {"buff": "marathon_afterglow", "title": "代码狂人"},
        "system_message": "「连续 4 小时的代码战斗……你的专注力已经超越了人类的极限。」",
        "repeatable": True,
        "cooldown_hours": 48,
    },
    "focus_master": {
        "title": "🎯 心流之境",
        "description": "连续保持专注度 >0.8 超过 2 小时。你进入了传说中的心流状态。",
        "difficulty": "A",
        "exp_reward": 150,
        "trigger": {
            "type": "sustained_focus",
            "condition": "focus_above_08_2h",
            "min_focus": 0.8,
            "duration_minutes": 120,
        },
        "rewards_extra": {"buff": "flow_state_echo"},
        "system_message": "「心流状态……这是只有顶级猎人才能触及的领域。」",
        "repeatable": True,
        "cooldown_hours": 24,
    },
    "comeback_king": {
        "title": "🔥 绝地反击",
        "description": "从连续摸鱼 >30 分钟直接进入深度专注 >1 小时。这种意志力令系统刮目相看。",
        "difficulty": "A",
        "exp_reward": 180,
        "trigger": {
            "type": "pattern_transition",
            "condition": "distraction_to_deep_focus",
            "from_pattern": "distraction_drift",
            "to_pattern": "deep_focus",
            "from_duration": 30,
            "to_duration": 60,
        },
        "rewards_extra": {"title": "逆转者"},
        "system_message": "「从深渊中爬起来的猎人，比从未跌倒的人更加强大。」",
        "repeatable": True,
        "cooldown_hours": 72,
    },
    "zero_distraction": {
        "title": "🛡️ 铁壁防线",
        "description": "整整一天没有打开任何社交媒体或娱乐网站。你的自制力已达 S 级。",
        "difficulty": "S",
        "exp_reward": 300,
        "trigger": {
            "type": "daily_absence",
            "condition": "no_social_no_media_full_day",
            "forbidden_categories": ["social", "media", "gaming"],
            "min_active_hours": 6,
        },
        "rewards_extra": {"title": "铁壁"},
        "system_message": "「整整一天，没有任何干扰渗透你的防线。你是真正的铁壁。」",
        "repeatable": True,
        "cooldown_hours": 168,
    },

    # ── 里程碑触发 ──────────────────────────────────────

    "first_blood": {
        "title": "🩸 First Blood",
        "description": "完成你的第一个任务。每个猎人都从这里开始。",
        "difficulty": "E",
        "exp_reward": 50,
        "trigger": {
            "type": "milestone",
            "condition": "quests_completed_1",
            "counter": "total_quests_completed",
            "value": 1,
        },
        "system_message": "「你完成了第一个任务。这是你作为猎人的第一步。」",
        "repeatable": False,
    },
    "centurion": {
        "title": "💯 百夫长",
        "description": "累计完成 100 个任务。你已经是经验丰富的猎人了。",
        "difficulty": "A",
        "exp_reward": 500,
        "trigger": {
            "type": "milestone",
            "condition": "quests_completed_100",
            "counter": "total_quests_completed",
            "value": 100,
        },
        "rewards_extra": {"title": "百夫长"},
        "system_message": "「100 个任务……你已经从新手成长为百战老兵。」",
        "repeatable": False,
    },
    "level_10": {
        "title": "⬆️ 双重觉醒",
        "description": "达到 10 级。系统开始认可你的实力。",
        "difficulty": "B",
        "exp_reward": 200,
        "trigger": {
            "type": "milestone",
            "condition": "player_level_10",
            "counter": "player_level",
            "value": 10,
        },
        "rewards_extra": {"title": "觉醒者·双重"},
        "system_message": "「Lv.10……第一次觉醒完成。你感受到了力量在体内涌动。」",
        "repeatable": False,
    },
    "shadow_sovereign": {
        "title": "👑 影之君主",
        "description": "影子军团达到 10 名士兵。你的军团已初具规模。",
        "difficulty": "A",
        "exp_reward": 300,
        "trigger": {
            "type": "milestone",
            "condition": "shadow_army_10",
            "counter": "shadow_army_size",
            "value": 10,
        },
        "rewards_extra": {"title": "影之君主"},
        "system_message": "「十名影子已听从你的号令。影之军团，成形了。」",
        "repeatable": False,
    },

    # ── 时间/日期触发 ──────────────────────────────────

    "weekend_warrior": {
        "title": "⚔️ 周末战士",
        "description": "周末也在认真工作/学习 3 小时以上。别人在休息，你在超越。",
        "difficulty": "B",
        "exp_reward": 120,
        "trigger": {
            "type": "time_condition",
            "condition": "productive_weekend_3h",
            "day_of_week": [5, 6],  # 周六日
            "min_productive_hours": 3,
        },
        "system_message": "「周末也不停歇……这就是猎人与普通人的差距。」",
        "repeatable": True,
        "cooldown_hours": 168,
    },
    "midnight_countdown": {
        "title": "🎆 跨日挑战",
        "description": "午夜 12 点仍在工作，并在新的一天继续到 1 点。跨越时间的猎人。",
        "difficulty": "C",
        "exp_reward": 60,
        "trigger": {
            "type": "time_activity",
            "condition": "work_across_midnight",
            "description": "23:30-00:30 之间持续工作",
        },
        "system_message": "「新的一天开始了，但你的战斗还在继续。」",
        "repeatable": True,
        "cooldown_hours": 48,
    },
    "new_year_grinder": {
        "title": "🎊 新年第一刀",
        "description": "元旦当天开始工作/学习。新的一年，新的征程。",
        "difficulty": "B",
        "exp_reward": 200,
        "trigger": {
            "type": "date",
            "condition": "productive_on_jan1",
            "month": 1,
            "day": 1,
        },
        "system_message": "「新年的第一天就已在战斗……系统对你的新年决心表示认可。」",
        "repeatable": True,
        "cooldown_hours": 8760,  # 1 年
    },

    # ── 组合/特殊触发 ──────────────────────────────────

    "polyglot": {
        "title": "🌐 多语言猎人",
        "description": "一天内使用 3 种以上编程语言/工具。多面手的实力不可小觑。",
        "difficulty": "B",
        "exp_reward": 100,
        "trigger": {
            "type": "variety",
            "condition": "3_plus_tools_in_day",
            "min_distinct_tools": 3,
            "category": "coding",
        },
        "system_message": "「Python, JavaScript, Rust……你的武器库令人印象深刻。」",
        "repeatable": True,
        "cooldown_hours": 72,
    },
    "device_hopper": {
        "title": "📱 跨界猎人",
        "description": "一天内在 3 个以上设备间切换工作。你的战场不止一个。",
        "difficulty": "B",
        "exp_reward": 80,
        "trigger": {
            "type": "device",
            "condition": "3_plus_devices_in_day",
            "min_devices": 3,
        },
        "system_message": "「在多个战场之间自如切换……跨界猎人的能力得到了认可。」",
        "repeatable": True,
        "cooldown_hours": 168,
    },
    "perfect_day": {
        "title": "✨ 完美的一天",
        "description": "一天内完成所有每日任务 + 至少 2 个支线任务 + 平均专注度 >0.7。传说级成就。",
        "difficulty": "S",
        "exp_reward": 500,
        "trigger": {
            "type": "composite",
            "condition": "all_daily_plus_sides_plus_focus",
            "conditions": [
                {"type": "all_daily_completed"},
                {"type": "side_quests_completed", "min": 2},
                {"type": "avg_focus_above", "value": 0.7},
            ],
        },
        "rewards_extra": {"title": "完美主义者", "buff": "perfect_day_glow"},
        "system_message": "「所有任务完成。专注度超群。这是……完美的一天。系统向你致敬。」",
        "repeatable": True,
        "cooldown_hours": 168,
    },
    "break_the_chain": {
        "title": "💪 打破枷锁",
        "description": "连续 3 天完成所有每日任务。习惯的力量正在形成。",
        "difficulty": "A",
        "exp_reward": 200,
        "trigger": {
            "type": "streak",
            "condition": "daily_complete_streak_3",
            "streak_type": "all_daily_completed",
            "streak_days": 3,
        },
        "rewards_extra": {"title": "习惯锻造者"},
        "system_message": "「连续 3 天，一个不落。枷锁已被打破，你正在锻造新的习惯。」",
        "repeatable": False,
    },
    "seven_day_warrior": {
        "title": "⚔️ 七日磨剑",
        "description": "连续 7 天完成所有每日任务。你已经证明了你的持久力。",
        "difficulty": "S",
        "exp_reward": 400,
        "trigger": {
            "type": "streak",
            "condition": "daily_complete_streak_7",
            "streak_type": "all_daily_completed",
            "streak_days": 7,
        },
        "rewards_extra": {"title": "七日剑圣"},
        "system_message": "「七日不间断的战斗……你的意志如同百炼精钢。」",
        "repeatable": False,
    },

    # ── 随机/惊喜触发 ──────────────────────────────────

    "system_gift": {
        "title": "🎁 系统的馈赠",
        "description": "系统随机发放的奖励任务。完成任何一个当前任务即可领取。",
        "difficulty": "D",
        "exp_reward": 50,
        "trigger": {
            "type": "random",
            "condition": "random_gift",
            "probability": 0.03,  # 每次检查 3% 概率
            "check_interval_minutes": 30,
        },
        "system_message": "「偶尔……系统也会给予奖励。这是对你的一份认可。」",
        "repeatable": True,
        "cooldown_hours": 48,
    },
    "secret_double_exp": {
        "title": "⭐ 双倍经验时间",
        "description": "???触发了隐藏的双倍经验事件。接下来 30 分钟内完成的任务双倍经验！",
        "difficulty": "C",
        "exp_reward": 30,
        "trigger": {
            "type": "random",
            "condition": "random_double_exp",
            "probability": 0.02,
            "check_interval_minutes": 60,
        },
        "rewards_extra": {"buff": "double_exp_30min"},
        "system_message": "「嗯？系统似乎发生了某种波动……经验值获取速度翻倍了！」",
        "repeatable": True,
        "cooldown_hours": 72,
    },
}


class HiddenQuestDetector:
    """
    隐藏任务检测器
    监听各种事件和状态，在条件满足时触发隐藏任务
    """

    def __init__(self):
        self._triggered: set[str] = set()            # 已触发的非重复任务
        self._cooldowns: dict[str, datetime] = {}     # 重复任务的冷却时间
        self._last_random_check: datetime = datetime.now()
        # 追踪状态
        self._continuous_category: str = ""
        self._continuous_start: datetime | None = None
        self._focus_above_start: datetime | None = None
        self._last_pattern: str = ""
        self._last_pattern_start: datetime | None = None
        self._daily_categories: set[str] = set()
        self._daily_devices: set[str] = set()
        self._streak_days: int = 0
        self._last_streak_date: str = ""

    def check_triggers(
        self,
        current_category: str = "",
        focus_score: float = 0.0,
        pattern_type: str = "",
        player_level: int = 1,
        quests_completed: int = 0,
        shadow_army_size: int = 0,
        daily_all_done: bool = False,
        side_quests_done: int = 0,
        device_id: str = "",
        active_devices_today: int = 1,
    ) -> list[dict]:
        """
        检查所有隐藏任务的触发条件
        返回: 本次触发的隐藏任务列表
        """
        now = datetime.now()
        triggered = []

        for quest_id, quest in HIDDEN_QUESTS.items():
            # 跳过已触发的不可重复任务
            if quest_id in self._triggered and not quest.get("repeatable", False):
                continue

            # 检查冷却
            if quest_id in self._cooldowns:
                if now < self._cooldowns[quest_id]:
                    continue

            # 检查触发条件
            trigger = quest["trigger"]
            should_trigger = False

            match trigger["type"]:
                case "time_activity":
                    should_trigger = self._check_time_activity(trigger, now, current_category)
                case "continuous_activity":
                    should_trigger = self._check_continuous(trigger, current_category, now)
                case "sustained_focus":
                    should_trigger = self._check_sustained_focus(trigger, focus_score, now)
                case "pattern_transition":
                    should_trigger = self._check_pattern_transition(trigger, pattern_type, now)
                case "daily_absence":
                    should_trigger = self._check_daily_absence(trigger)
                case "milestone":
                    should_trigger = self._check_milestone(
                        trigger, player_level, quests_completed, shadow_army_size
                    )
                case "time_condition":
                    should_trigger = self._check_time_condition(trigger, now, current_category)
                case "date":
                    should_trigger = self._check_date(trigger, now, current_category)
                case "variety":
                    should_trigger = self._check_variety(trigger)
                case "device":
                    should_trigger = self._check_device(trigger, active_devices_today)
                case "composite":
                    should_trigger = self._check_composite(
                        trigger, daily_all_done, side_quests_done, focus_score
                    )
                case "streak":
                    should_trigger = self._check_streak(trigger, daily_all_done, now)
                case "random":
                    should_trigger = self._check_random(trigger, now)

            if should_trigger:
                triggered.append(quest)
                self._triggered.add(quest_id)
                
                # 设置冷却
                cooldown_hours = quest.get("cooldown_hours", 0)
                if cooldown_hours > 0:
                    from datetime import timedelta
                    self._cooldowns[quest_id] = now + timedelta(hours=cooldown_hours)

        # 更新追踪状态
        self._update_tracking(current_category, focus_score, pattern_type, device_id, now)

        return triggered

    # ── 条件检查方法 ────────────────────────────────────

    def _check_time_activity(self, trigger: dict, now: datetime, category: str) -> bool:
        cond = trigger["condition"]
        productive = category in ("coding", "writing", "work", "learning", "research", "design")
        
        if cond == "productive_after_2am":
            return now.hour >= 2 and now.hour < 5 and productive
        elif cond == "productive_before_6am":
            return now.hour < 6 and productive
        elif cond == "work_across_midnight":
            return now.hour == 0 and now.minute < 30 and productive
        return False

    def _check_continuous(self, trigger: dict, category: str, now: datetime) -> bool:
        target_cat = trigger.get("category", "")
        duration = trigger.get("duration_minutes", 60)
        
        if category == target_cat and self._continuous_category == target_cat:
            if self._continuous_start:
                elapsed = (now - self._continuous_start).total_seconds() / 60
                return elapsed >= duration
        return False

    def _check_sustained_focus(self, trigger: dict, focus: float, now: datetime) -> bool:
        min_focus = trigger.get("min_focus", 0.8)
        duration = trigger.get("duration_minutes", 120)
        
        if focus >= min_focus:
            if self._focus_above_start:
                elapsed = (now - self._focus_above_start).total_seconds() / 60
                return elapsed >= duration
        return False

    def _check_pattern_transition(self, trigger: dict, current_pattern: str, now: datetime) -> bool:
        to_pattern = trigger.get("to_pattern", "")
        from_pattern = trigger.get("from_pattern", "")
        to_duration = trigger.get("to_duration", 60)
        
        if current_pattern == to_pattern and self._last_pattern == from_pattern:
            if self._last_pattern_start:
                # 要求当前好模式已经持续足够久
                # 简化: 只检查模式转换是否发生过
                return True
        return False

    def _check_daily_absence(self, trigger: dict) -> bool:
        forbidden = set(trigger.get("forbidden_categories", []))
        return len(self._daily_categories & forbidden) == 0 and len(self._daily_categories) > 0

    def _check_milestone(
        self, trigger: dict, level: int, quests: int, shadows: int
    ) -> bool:
        counter = trigger.get("counter", "")
        value = trigger.get("value", 0)
        
        match counter:
            case "total_quests_completed":
                return quests >= value
            case "player_level":
                return level >= value
            case "shadow_army_size":
                return shadows >= value
        return False

    def _check_time_condition(self, trigger: dict, now: datetime, category: str) -> bool:
        days = trigger.get("day_of_week", [])
        productive = category in ("coding", "writing", "work", "learning", "research")
        return now.weekday() in days and productive

    def _check_date(self, trigger: dict, now: datetime, category: str) -> bool:
        month = trigger.get("month", 0)
        day = trigger.get("day", 0)
        productive = category in ("coding", "writing", "work", "learning", "research")
        return now.month == month and now.day == day and productive

    def _check_variety(self, trigger: dict) -> bool:
        min_tools = trigger.get("min_distinct_tools", 3)
        return len(self._daily_categories) >= min_tools

    def _check_device(self, trigger: dict, active_devices: int) -> bool:
        min_devices = trigger.get("min_devices", 3)
        return active_devices >= min_devices

    def _check_composite(
        self, trigger: dict, daily_done: bool, sides_done: int, focus: float
    ) -> bool:
        conditions = trigger.get("conditions", [])
        for cond in conditions:
            match cond["type"]:
                case "all_daily_completed":
                    if not daily_done:
                        return False
                case "side_quests_completed":
                    if sides_done < cond.get("min", 0):
                        return False
                case "avg_focus_above":
                    if focus < cond.get("value", 0):
                        return False
        return True

    def _check_streak(self, trigger: dict, daily_done: bool, now: datetime) -> bool:
        target_streak = trigger.get("streak_days", 3)
        today = now.strftime("%Y-%m-%d")
        
        if daily_done and today != self._last_streak_date:
            self._streak_days += 1
            self._last_streak_date = today
        
        return self._streak_days >= target_streak

    def _check_random(self, trigger: dict, now: datetime) -> bool:
        probability = trigger.get("probability", 0.01)
        interval = trigger.get("check_interval_minutes", 30)
        
        elapsed = (now - self._last_random_check).total_seconds() / 60
        if elapsed < interval:
            return False
        
        self._last_random_check = now
        return random.random() < probability

    # ── 状态追踪更新 ────────────────────────────────────

    def _update_tracking(
        self, category: str, focus: float, pattern: str, device_id: str, now: datetime
    ):
        """更新内部追踪状态"""
        # 连续活动追踪
        if category and category == self._continuous_category:
            pass  # 继续计时
        else:
            self._continuous_category = category
            self._continuous_start = now

        # 高专注度追踪
        if focus >= 0.8:
            if self._focus_above_start is None:
                self._focus_above_start = now
        else:
            self._focus_above_start = None

        # 模式转换追踪
        if pattern and pattern != self._last_pattern:
            self._last_pattern = pattern
            self._last_pattern_start = now

        # 每日分类追踪
        if category:
            self._daily_categories.add(category)

        # 设备追踪
        if device_id:
            self._daily_devices.add(device_id)

    def reset_daily(self):
        """每日重置 (凌晨调用)"""
        self._daily_categories.clear()
        self._daily_devices.clear()

    # ── 序列化 ──────────────────────────────────────────

    def get_status(self) -> dict:
        """获取检测器状态"""
        return {
            "triggered_count": len(self._triggered),
            "triggered_ids": list(self._triggered),
            "active_cooldowns": {
                qid: cd.isoformat()
                for qid, cd in self._cooldowns.items()
                if cd > datetime.now()
            },
            "tracking": {
                "continuous_category": self._continuous_category,
                "continuous_minutes": (
                    round((datetime.now() - self._continuous_start).total_seconds() / 60)
                    if self._continuous_start else 0
                ),
                "focus_sustained_minutes": (
                    round((datetime.now() - self._focus_above_start).total_seconds() / 60)
                    if self._focus_above_start else 0
                ),
                "daily_categories": list(self._daily_categories),
                "daily_devices": list(self._daily_devices),
                "streak_days": self._streak_days,
            },
            "total_hidden_quests": len(HIDDEN_QUESTS),
            "available_quests": len(HIDDEN_QUESTS) - len(self._triggered),
        }

    def to_dict(self) -> dict:
        return {
            "triggered": list(self._triggered),
            "cooldowns": {k: v.isoformat() for k, v in self._cooldowns.items()},
            "streak_days": self._streak_days,
            "last_streak_date": self._last_streak_date,
        }

    def load_from_dict(self, data: dict) -> None:
        self._triggered = set(data.get("triggered", []))
        self._cooldowns = {
            k: datetime.fromisoformat(v) for k, v in data.get("cooldowns", {}).items()
        }
        self._streak_days = data.get("streak_days", 0)
        self._last_streak_date = data.get("last_streak_date", "")
