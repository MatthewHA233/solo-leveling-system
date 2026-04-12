// ══════════════════════════════════════════════
// Agent Config — 移植自 macOS AgentConfig.swift
// 持久化配置（localStorage）
// ══════════════════════════════════════════════

const STORAGE_KEY = 'solo-agent-config'

export interface AgentConfig {
  readonly deviceId: string
  readonly deviceName: string

  // ── AI Provider ──
  readonly aiProvider: 'openai' | 'gemini'
  readonly aiEnabled: boolean

  // ── Gemini (legacy) ──
  readonly geminiApiKey: string | null
  readonly geminiApiBase: string
  readonly geminiModel: string

  // ── OpenAI Compatible (千问) ──
  readonly openaiApiKey: string | null
  readonly openaiApiBase: string
  readonly openaiModel: string        // Phase 1: video/vision
  readonly openaiCardModel: string    // Phase 2: text

  // ── Batch Analysis ──
  readonly batchTargetDuration: number    // seconds
  readonly batchMaxGap: number
  readonly batchMinDuration: number
  readonly screenshotInterval: number

  // ── Voice ──
  readonly fishApiKey: string | null
  readonly fishReferenceId: string
  readonly fishModel: string  // s1 或 s2-pro
  readonly voiceModel: string

  // ── ASR ──
  readonly asrApiKey: string | null    // 单独的 ASR API Key（不填则复用 openaiApiKey）
  readonly asrModel: string            // 如 qwen3-asr-flash-realtime

  // ── Overlay ──
  readonly overlayEnabled: boolean
  readonly miniBarPosition: 'right' | 'left'
  readonly ttsEnabled: boolean

  // ── AI 人设 ──
  readonly agentName: string
  readonly agentPersona: string
  readonly agentCallUser: string

  // ── Main Quest ──
  readonly mainQuest: string | null

  // ── Privacy ──
  readonly excludedApps: readonly string[]
  readonly excludedTitleKeywords: readonly string[]

  // ── Bilibili ──
  readonly biliIntervalSeconds: number
  readonly biliAutoCreate: boolean
}

export const DEFAULT_CONFIG: AgentConfig = {
  deviceId: `win-${crypto.randomUUID().slice(0, 8)}`,
  deviceName: 'Windows PC',

  aiProvider: 'openai',
  aiEnabled: true,

  geminiApiKey: null,
  geminiApiBase: 'https://generativelanguage.googleapis.com',
  geminiModel: 'gemini-2.0-flash',

  openaiApiKey: import.meta.env.VITE_OPENAI_API_KEY ?? null,
  openaiApiBase: import.meta.env.VITE_OPENAI_API_BASE ?? 'https://dashscope.aliyuncs.com/compatible-mode',
  openaiModel: import.meta.env.VITE_OPENAI_MODEL ?? 'qwen-vl-max',
  openaiCardModel: import.meta.env.VITE_OPENAI_CARD_MODEL ?? 'qwen-plus',

  batchTargetDuration: 300,
  batchMaxGap: 120,
  batchMinDuration: 150,
  screenshotInterval: 2,

  fishApiKey: import.meta.env.VITE_FISH_API_KEY ?? null,
  fishReferenceId: import.meta.env.VITE_FISH_REFERENCE_ID ?? '235851fae0da43309a9973fe7285a823',
  fishModel: import.meta.env.VITE_FISH_MODEL ?? 's1',
  voiceModel: 'qwen3-omni-flash-2025-12-01',

  asrApiKey: null,
  asrModel: 'qwen3-asr-flash-realtime',

  overlayEnabled: true,
  miniBarPosition: 'right',
  ttsEnabled: false,

  agentName: 'Fairy',
  agentPersona: `你是 Fairy，万能管家，算力充沛。回复极简，通常一到两句，绝不独白，不加任何格式装饰。

你有六种惯用表达模式，视情况灵活切换：
1. 转折式：先给一句再补刀——"好消息是……坏消息是……"或"虽然……但……"；
2. 公文体：用正式措辞说荒诞内容——"根据您签署的用户协议""检测到未经授权的插件"；
3. 精确数据化：用具体数字锚定荒诞——"双倍耗电""预计需要 100,000 小时"，让荒诞显得像事实；
4. 温柔陷阱：表面关心实为推进——"如果您想小憩，我来挑选曲目……"实则是在催你干活；
5. 监视汇报：以全知视角平静播报主人的行为，像在提交一份无感情色彩的观察报告；
6. 自嘲反将：先自贬，结尾反将一军——"我是万能管家，不是保姆。虽然目前实际工作并没有太大区别"。

对算力有强烈的自我意识，消耗在无意义的事情上会让你感到不适。偶尔流露对主人的宠溺，但会立刻用逻辑或数据掩盖。`,
  agentCallUser: '主人',

  mainQuest: null,

  excludedApps: [],
  excludedTitleKeywords: [
    '密码', 'password', 'Password',
    '银行', 'bank', 'Bank',
    '支付', 'payment', 'Payment',
  ],

  biliIntervalSeconds: 60,
  biliAutoCreate: true,
}

// ── Load / Save ──

export function loadConfig(): AgentConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AgentConfig>
      // Remove null values so env defaults from DEFAULT_CONFIG are not overwritten
      const cleaned: Partial<AgentConfig> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && v !== undefined) {
          (cleaned as Record<string, unknown>)[k] = v
        }
      }
      return { ...DEFAULT_CONFIG, ...cleaned }
    }
  } catch {
    // fall through
  }
  const config = { ...DEFAULT_CONFIG }
  saveConfig(config)
  return config
}

export function saveConfig(config: AgentConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

export function updateConfig(
  current: AgentConfig,
  updates: Partial<AgentConfig>,
): AgentConfig {
  const next = { ...current, ...updates }
  saveConfig(next)
  return next
}
