// ══════════════════════════════════════════════
// Agent Tools — 移植自 macOS AgentTool.swift
// ReAct 循环可用的工具定义 + 执行
// ══════════════════════════════════════════════

// ── Tool Definition (OpenAI function calling format) ──

export interface ToolDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

// ── Tool Interface ──

export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>
}

// ── Tool Context (injected by AgentManager) ──

export interface ToolContext {
  getScreenContext(): string
  getTodayCards(): string
  getGameStatus(): string
  getRecentActivity(minutes: number): string
  getConfig(): { mainQuest: string | null; motivations: readonly string[] }
  updateMainQuest(quest: string): void
  reorganizeCards(): Promise<boolean>
}

// ── Tool → Definition ──

export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

// ── Built-in Tools ──

const getScreenContext: AgentTool = {
  name: 'get_screen_context',
  description: '获取当前屏幕上下文：前台应用名称、窗口标题、活动状态',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    return ctx.getScreenContext()
  },
}

const getTodayCards: AgentTool = {
  name: 'get_today_cards',
  description: '获取今日所有 AI 生成的活动卡片 JSON 摘要',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    return ctx.getTodayCards()
  },
}

const getGameStatus: AgentTool = {
  name: 'get_game_status',
  description: '获取游戏引擎当前状态：等级、经验值、活跃任务、Buff 列表',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    return ctx.getGameStatus()
  },
}

const getRecentActivity: AgentTool = {
  name: 'get_recent_activity',
  description: '获取最近 N 分钟的原始活动历史，默认 30 分钟',
  parameters: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: '查询时间范围（分钟），默认 30' },
    },
    required: [],
  },
  async execute(args, ctx) {
    const minutes = (args.minutes as number) ?? 30
    return ctx.getRecentActivity(minutes)
  },
}

const setMainQuest: AgentTool = {
  name: 'set_main_quest',
  description: '更新用户当前的主线目标',
  parameters: {
    type: 'object',
    properties: {
      quest: { type: 'string', description: '新的主线目标描述' },
    },
    required: ['quest'],
  },
  async execute(args, ctx) {
    const quest = args.quest as string
    if (!quest) return '缺少参数：quest'
    ctx.updateMainQuest(quest)
    return `主线目标已更新：${quest}`
  },
}

const reorganizeCards: AgentTool = {
  name: 'reorganize_cards',
  description: '合并整理今日碎片活动卡片',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    const success = await ctx.reorganizeCards()
    return success ? '今日卡片整理完成' : '整理失败：AI 未配置或不可用'
  },
}

// ── Tool Registry ──

export const ALL_TOOLS: readonly AgentTool[] = [
  getScreenContext,
  getTodayCards,
  getGameStatus,
  getRecentActivity,
  setMainQuest,
  reorganizeCards,
]

// ── Execute by Name ──

export async function executeTool(
  name: string,
  argsJson: string,
  context: ToolContext,
): Promise<string> {
  const tool = ALL_TOOLS.find((t) => t.name === name)
  if (!tool) return `未知工具：${name}`

  try {
    const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    return await tool.execute(args, context)
  } catch (err) {
    return `工具执行失败：${err instanceof Error ? err.message : String(err)}`
  }
}
