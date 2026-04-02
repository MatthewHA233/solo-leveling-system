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

  // ── Overlay ──
  readonly overlayEnabled: boolean
  readonly miniBarPosition: 'right' | 'left'

  // ── AI 人设 ──
  readonly agentName: string
  readonly agentPersona: string
  readonly agentCallUser: string

  // ── Main Quest ──
  readonly mainQuest: string | null
  readonly motivations: readonly string[]

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

  overlayEnabled: true,
  miniBarPosition: 'right',

  agentName: '暗影君主系统',
  agentPersona: '你是独自升级世界观中的系统精灵，语气冷静、简洁、略带威严，偶尔展现关心。使用「」包裹关键系统通知。',
  agentCallUser: '主人',

  mainQuest: null,
  motivations: [],

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
