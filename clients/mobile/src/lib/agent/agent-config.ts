// ══════════════════════════════════════════════
// Agent Config — Fairy 配置（mobile 版）
// 与 desktop 的 src/lib/agent/agent-config.ts 同字段命名、同默认值、同 helper 语义，
// 存储后端从 localStorage 换成 SolevupDb 的 SharedPreferences（async）。
//
// 没搬过来的字段（desktop 有，手机端没有这个功能）：
//   deviceId/deviceName/aiEnabled/batch*/screenshotInterval/miniBarPosition —— 旧 Swift 原型遗留，desktop 也没有读取方
//   overlayEnabled —— desktop 只用来开关摄像头存在感检测
//   fairyWindowEnabled/fairyWindowScale —— 独立悬浮窗口
//   bili*/ocrFrameIntervalSec —— B 站轮询、下载和 OCR 只在 desktop 跑
//   useDiscreteGpu —— Windows 独显偏好
// ══════════════════════════════════════════════

import { solevupGetPref, solevupSetPref } from '../solevupdb'

export interface AgentConfig {
  // ── AI Provider ──
  readonly aiProvider: 'openai' | 'gemini'
  /** 语音模式：regular = 级联（原生录音 + 流式识别 → 主循环，默认）；omni = 实时（实验，独立小模型） */
  readonly aiMode: 'regular' | 'omni'
  /** 已把旧版默认的实时模式迁到级联（只迁一次，之后尊重主人自己的选择） */
  readonly voiceCascadeMigrated?: boolean
  readonly dashscopeApiKey: string | null

  // ── Gemini (legacy) ──
  readonly geminiApiKey: string | null
  readonly geminiApiBase: string
  readonly geminiModel: string

  // ── 常规模式 (OpenAI Compatible) ──
  readonly openaiApiKey: string | null
  readonly openaiApiBase: string
  readonly openaiCardModel: string    // 聊天模型

  // ── 全模态模式 (Omni Realtime WS) ──
  readonly omniApiKey: string | null   // 留空则复用 openaiApiKey
  readonly omniApiBase: string
  readonly omniModel: string

  // ── Voice ──
  readonly fishApiKey: string | null
  readonly fishReferenceId: string
  readonly fishModel: string  // s1 或 s2-pro
  readonly asrApiKey: string | null    // 单独的 ASR API Key（不填则复用 openaiApiKey）
  readonly asrModel: string            // 如 qwen3-asr-flash-realtime

  // ── Omni 语音输出音色 ──
  readonly omniVoice: string           // 输出音色 ID（全模态模式下使用）

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
}

export const DEFAULT_CONFIG: AgentConfig = {
  aiProvider: 'openai',
  aiMode: 'regular',
  voiceCascadeMigrated: true,

  geminiApiKey: null,
  geminiApiBase: 'https://generativelanguage.googleapis.com',
  geminiModel: 'gemini-2.0-flash',

  openaiApiKey: null,
  dashscopeApiKey: null,
  openaiApiBase: 'https://dashscope.aliyuncs.com/compatible-mode',
  openaiCardModel: 'qwen3.6-flash',

  omniApiKey: null,
  omniApiBase: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  omniModel: 'qwen3.5-omni-flash-realtime',

  fishApiKey: null,
  fishReferenceId: '235851fae0da43309a9973fe7285a823',
  fishModel: 's1',
  asrApiKey: null,
  asrModel: 'qwen3-asr-flash-realtime',

  omniVoice: '',

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
}

// ── Load / Save ──

const PREF_KEY = 'chat.agent-config.v1'

/** onReadFail：读失败时返回什么。运行中重读要传手里那份，否则默认值会顶掉内存里的配置，下次保存就写进库了 */
export async function loadConfig(onReadFail?: AgentConfig): Promise<AgentConfig> {
  let raw = ''
  try {
    raw = await solevupGetPref(PREF_KEY, '')
  } catch {
    // 读失败不等于没存过：这里写默认值会冲掉主人的人设和 Key
    return onReadFail ?? { ...DEFAULT_CONFIG }
  }
  try {
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AgentConfig> & { chatModel?: string }
      // Remove null values so defaults from DEFAULT_CONFIG are not overwritten
      const cleaned: Partial<AgentConfig> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && v !== undefined && !['voiceModel', 'voicePipeline', 'omniContextRounds', 'openaiModel', 'omniAsrEnabled', 'omniTtsEnabled', 'chatModel'].includes(k)) {
          (cleaned as Record<string, unknown>)[k] = v
        }
      }
      const merged = { ...DEFAULT_CONFIG, ...cleaned }
      // 手机端旧版只存 chatModel，没有 openaiCardModel
      const withCardModel = parsed.openaiCardModel || !parsed.chatModel
        ? merged
        : { ...merged, openaiCardModel: parsed.chatModel }
      // 迁移：存量配置里已下架的旧模型名（qwen-plus/turbo/max 一代）改写为现代默认
      const modelMigrated = /^qwen-(plus|turbo|max)/.test(withCardModel.openaiCardModel ?? '')
        ? { ...withCardModel, openaiCardModel: DEFAULT_CONFIG.openaiCardModel }
        : withCardModel
      // 迁移（2026-09）：语音默认改为级联——实时模式是独立的小模型大脑，答不上 Fairy 的水平
      // 看存档里有没有这个标记（merged 已带默认值 true，不能用它判断）
      const migrated = parsed.voiceCascadeMigrated
        ? modelMigrated
        : { ...modelMigrated, aiMode: 'regular' as const, voiceCascadeMigrated: true }
      const dashscopeApiKey = migrated.dashscopeApiKey
        ?? migrated.openaiApiKey
        ?? migrated.omniApiKey
        ?? migrated.asrApiKey
        ?? null
      return {
        ...migrated,
        dashscopeApiKey,
        openaiApiKey: migrated.openaiApiKey ?? dashscopeApiKey,
        omniApiKey: migrated.omniApiKey ?? null,
        asrApiKey: migrated.asrApiKey ?? null,
      }
    }
  } catch {
    // fall through
  }
  const config = { ...DEFAULT_CONFIG }
  await saveConfig(config)
  return config
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  try {
    await solevupSetPref(PREF_KEY, JSON.stringify(config))
  } catch {}
}

export function getDashScopeApiKey(config: AgentConfig): string | null {
  return config.dashscopeApiKey
    ?? config.openaiApiKey
    ?? config.omniApiKey
    ?? config.asrApiKey
    ?? null
}

export function getOmniApiKey(config: AgentConfig): string | null {
  return config.omniApiKey
    ?? config.dashscopeApiKey
    ?? config.openaiApiKey
    ?? null
}

export function getAsrApiKey(config: AgentConfig): string | null {
  return config.asrApiKey
    ?? config.dashscopeApiKey
    ?? config.openaiApiKey
    ?? null
}

export function updateConfig(current: AgentConfig, updates: Partial<AgentConfig>): AgentConfig {
  const next = { ...current, ...updates }
  if (updates.dashscopeApiKey !== undefined) {
    next.openaiApiKey = updates.dashscopeApiKey
  }
  void saveConfig(next)
  return next
}
