// ══════════════════════════════════════════════
// System Messages — 移植自 macOS SystemMessages.swift
// 模板化通知文案
// ══════════════════════════════════════════════

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ── Boot ──

const BOOT_MESSAGES = [
  '「恭喜你成为玩家。」',
  '「系统已激活。今天也要变强。」',
  '「检测到玩家回归。系统重新上线。」',
  '「新的一天，新的挑战。准备好了吗？」',
] as const

// ── Level Up ──

const LEVEL_UP_MESSAGES = [
  '「叮！等级提升！」\n你感到力量在体内涌动。',
  '「恭喜！你突破了新的极限。」\n系统检测到显著的成长。',
  '「等级提升！」\n继续保持，更强大的力量在等着你。',
] as const

// ── Quest Trigger ──

const QUEST_TRIGGER_MESSAGES: Record<string, readonly string[]> = {
  daily: [
    '「每日任务已刷新。」\n不完成的话... 你知道后果的。',
    '「新的每日任务。」\n简单但必要。保持节奏。',
  ],
  main: [
    '「检测到新的主线任务。」\n这是你变强的关键一步。',
    '「主线任务开启。」\n系统认为你已经准备好了。',
  ],
  side: [
    '「支线任务出现。」\n有兴趣的话可以挑战一下。',
    '「发现了可选的挑战。」\n额外的经验值在等着你。',
  ],
  emergency: [
    '「⚠️ 紧急任务触发！」\n系统检测到异常状态。立即响应！',
    '「警告：紧急任务！」\n不容忽视的挑战已经出现！',
  ],
  hidden: [
    '「...系统检测到隐藏条件满足。」\n一个特殊的任务悄然浮现。',
    '「隐藏任务解锁！」\n很少有玩家能触发这个。',
  ],
}

// ── Quest Complete / Fail ──

const QUEST_COMPLETE_MESSAGES = [
  '「任务完成。」\n做得好。经验值已到账。',
  '「干得漂亮。」\n你又向前迈了一步。',
  '「完成！」\n系统已记录你的成就。',
  '「不错。」\n继续保持这个势头。',
] as const

const QUEST_FAIL_MESSAGES = [
  '「任务失败。」\n...但失败也是变强的一部分。',
  '「遗憾。」\n下次不要让系统失望。',
  '「时间到。任务已标记为失败。」',
] as const

// ── Buff / Debuff ──

const BUFF_MESSAGES: Record<string, readonly string[]> = {
  focus_zone: [
    '「专注领域」已激活。\n你进入了心流状态。万物静谧，只有目标。',
    '系统检测到持续高专注。\n「专注领域」Buff 生效中。',
  ],
  creativity_spark: [
    '「创造灵感」涌现。\n灵感之神今天眷顾了你。',
    '创造力正在飙升。\n「创造灵感」Buff 激活。',
  ],
  learning_boost: [
    '「知识加速」启动。\n学习效率提升中。',
    '系统检测到学习行为。\n「知识加速」已激活。',
  ],
  night_owl: [
    '深夜了。你还在这里。\n「夜行者」模式激活。创造力提升，但注意健康。',
  ],
}

const DEBUFF_MESSAGES: Record<string, readonly string[]> = {
  distraction_fog: [
    '「注意力涣散」\n系统检测到频繁的应用切换。集中精神！',
    '你的注意力正在分散。\n「注意力涣散」Debuff 生效。',
  ],
  fatigue_warning: [
    '「疲劳警告」\n你已经连续工作太久了。系统建议你休息。',
    '身体发出了信号。\n「疲劳警告」Debuff 生效。去休息一下。',
  ],
  procrastination_curse: [
    '「拖延诅咒」\n系统检测到持续的回避行为。面对它。',
    '你在逃避。系统看得很清楚。\n「拖延诅咒」Debuff 激活。',
  ],
}

// ── Encouragement / Late Night ──

const ENCOURAGEMENT_MESSAGES = [
  '系统正在观察。你做得很好。',
  '保持这个状态。你正在变强。',
  '不错的势头。继续。',
  '系统记录了你的努力。',
  '你比昨天更强了。',
] as const

const LATE_NIGHT_MESSAGES = [
  '已经很晚了。系统建议你休息。\n明天还有很多任务等着你。',
  '凌晨了。健康也是一种力量。\n去睡觉吧。系统会一直在。',
  '夜深了。你的坚持令人敬佩，但身体需要恢复。',
] as const

// ── Focus Streak ──

export function focusStreakMessage(streak: number, bonus: number): string {
  return `🔥 专注连击 x${streak}！额外获得 ${bonus} EXP`
}

// ── Generic Accessor ──

export function getMessage(category: string, subcategory = ''): string {
  switch (category) {
    case 'boot':
      return pick(BOOT_MESSAGES)
    case 'level_up':
      return pick(LEVEL_UP_MESSAGES)
    case 'quest_trigger':
      return pick(QUEST_TRIGGER_MESSAGES[subcategory] ?? QUEST_TRIGGER_MESSAGES.side!)
    case 'quest_complete':
      return pick(QUEST_COMPLETE_MESSAGES)
    case 'quest_fail':
      return pick(QUEST_FAIL_MESSAGES)
    case 'buff':
      return pick(BUFF_MESSAGES[subcategory] ?? ['Buff 激活。'])
    case 'debuff':
      return pick(DEBUFF_MESSAGES[subcategory] ?? ['Debuff 激活。'])
    case 'encouragement':
      return pick(ENCOURAGEMENT_MESSAGES)
    case 'late_night':
      return pick(LATE_NIGHT_MESSAGES)
    default:
      return '...'
  }
}
