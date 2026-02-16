"""
系统消息文案
独自升级风格的系统提示文案，让体验更沉浸
"""

import random

# ── 系统启动 ──
SYSTEM_BOOT_MESSAGES = [
    "「恭喜你成为玩家。」",
    "「系统已激活。今天也要变强。」",
    "「检测到玩家回归。系统重新上线。」",
    "「新的一天，新的挑战。准备好了吗？」",
]

# ── 升级 ──
LEVEL_UP_MESSAGES = [
    "「叮！等级提升！」\n你感到力量在体内涌动。",
    "「恭喜！你突破了新的极限。」\n系统检测到显著的成长。",
    "「等级提升！」\n继续保持，更强大的力量在等着你。",
]

# ── 任务触发 ──
QUEST_TRIGGER_MESSAGES = {
    "daily": [
        "「每日任务已刷新。」\n不完成的话... 你知道后果的。",
        "「新的每日任务。」\n简单但必要。保持节奏。",
    ],
    "main": [
        "「检测到新的主线任务。」\n这是你变强的关键一步。",
        "「主线任务开启。」\n系统认为你已经准备好了。",
    ],
    "side": [
        "「支线任务出现。」\n有兴趣的话可以挑战一下。",
        "「发现了可选的挑战。」\n额外的经验值在等着你。",
    ],
    "emergency": [
        "「⚠️ 紧急任务触发！」\n系统检测到异常状态。立即响应！",
        "「警告：紧急任务！」\n不容忽视的挑战已经出现！",
    ],
    "hidden": [
        "「...系统检测到隐藏条件满足。」\n一个特殊的任务悄然浮现。",
        "「隐藏任务解锁！」\n很少有玩家能触发这个。",
    ],
}

# ── 任务完成 ──
QUEST_COMPLETE_MESSAGES = [
    "「任务完成。」\n做得好。经验值已到账。",
    "「干得漂亮。」\n你又向前迈了一步。",
    "「完成！」\n系统已记录你的成就。",
    "「不错。」\n继续保持这个势头。",
]

# ── 任务失败 ──
QUEST_FAIL_MESSAGES = [
    "「任务失败。」\n...但失败也是变强的一部分。",
    "「遗憾。」\n下次不要让系统失望。",
    "「时间到。任务已标记为失败。」",
]

# ── Buff 激活 ──
BUFF_MESSAGES = {
    "focus_zone": [
        "「专注领域」已激活。\n你进入了心流状态。万物静谧，只有目标。",
        "系统检测到持续高专注。\n「专注领域」Buff 生效中。",
    ],
    "creativity_spark": [
        "「创造灵感」涌现。\n灵感之神今天眷顾了你。",
        "创造力正在飙升。\n「创造灵感」Buff 激活。",
    ],
    "learning_boost": [
        "「知识加速」启动。\n学习效率提升中。",
        "系统检测到学习行为。\n「知识加速」已激活。",
    ],
    "night_owl": [
        "深夜了。你还在这里。\n「夜行者」模式激活。创造力提升，但注意健康。",
    ],
}

# ── Debuff ──
DEBUFF_MESSAGES = {
    "distraction_fog": [
        "「注意力涣散」\n系统检测到频繁的应用切换。集中精神！",
        "你的注意力正在分散。\n「注意力涣散」Debuff 生效。",
    ],
    "fatigue_warning": [
        "「疲劳警告」\n你已经连续工作太久了。系统建议你休息。",
        "身体发出了信号。\n「疲劳警告」Debuff 生效。去休息一下。",
    ],
    "procrastination_curse": [
        "「拖延诅咒」\n系统检测到持续的回避行为。面对它。",
        "你在逃避。系统看得很清楚。\n「拖延诅咒」Debuff 激活。",
    ],
}

# ── 惩罚区域 ──
PENALTY_MESSAGES = [
    "「你已被传送至惩罚区域。」\n完成紧急任务以离开。",
    "「惩罚区域。」\n这里没有风，没有太阳，没有月亮，也没有星星。\n只有你和你需要完成的任务。",
    "「警告：心脏停止倒计时已开始。」\n立即完成任务。系统不是在开玩笑。",
]

# ── 成就解锁 ──
ACHIEVEMENT_MESSAGES = [
    "「叮！隐藏条件满足。」\n成就已解锁。",
    "「成就解锁！」\n你的努力没有白费。",
    "「新成就！」\n继续收集。每一个都是你的勋章。",
]

# ── 系统闲聊 (心流状态时偶尔的鼓励) ──
ENCOURAGEMENT_MESSAGES = [
    "系统正在观察。你做得很好。",
    "保持这个状态。你正在变强。",
    "不错的势头。继续。",
    "系统记录了你的努力。",
    "你比昨天更强了。",
]

# ── 深夜警告 ──
LATE_NIGHT_MESSAGES = [
    "已经很晚了。系统建议你休息。\n明天还有很多任务等着你。",
    "凌晨了。健康也是一种力量。\n去睡觉吧。系统会一直在。",
    "夜深了。你的坚持令人敬佩，但身体需要恢复。",
]


def get_message(category: str, subcategory: str = "") -> str:
    """获取一条随机消息"""
    if category == "boot":
        return random.choice(SYSTEM_BOOT_MESSAGES)
    elif category == "level_up":
        return random.choice(LEVEL_UP_MESSAGES)
    elif category == "quest_trigger":
        msgs = QUEST_TRIGGER_MESSAGES.get(subcategory, QUEST_TRIGGER_MESSAGES["side"])
        return random.choice(msgs)
    elif category == "quest_complete":
        return random.choice(QUEST_COMPLETE_MESSAGES)
    elif category == "quest_fail":
        return random.choice(QUEST_FAIL_MESSAGES)
    elif category == "buff":
        msgs = BUFF_MESSAGES.get(subcategory, ["Buff 激活。"])
        return random.choice(msgs)
    elif category == "debuff":
        msgs = DEBUFF_MESSAGES.get(subcategory, ["Debuff 激活。"])
        return random.choice(msgs)
    elif category == "penalty":
        return random.choice(PENALTY_MESSAGES)
    elif category == "achievement":
        return random.choice(ACHIEVEMENT_MESSAGES)
    elif category == "encouragement":
        return random.choice(ENCOURAGEMENT_MESSAGES)
    elif category == "late_night":
        return random.choice(LATE_NIGHT_MESSAGES)
    return "..."
