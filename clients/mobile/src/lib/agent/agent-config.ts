// ══════════════════════════════════════════════
// Agent Config — 暗影体聊天配置（mobile 版）
// 与 desktop 的 src/lib/agent/agent-config.ts 保持同构：
//   同字段命名 / 同 helper 签名，存储后端从 localStorage
//   换成 SolevupDb 的 SharedPreferences（async）。
// ══════════════════════════════════════════════

import { solevupGetPref, solevupSetPref } from '../solevupdb'

export interface AgentConfig {
  // 常规模式 (OpenAI Compatible / DashScope)
  readonly dashscopeApiKey: string | null
  readonly openaiApiBase: string
  readonly chatModel: string        // 对应 desktop feature binding 'fairy_chat'

  // AI 人设
  readonly agentName: string
  readonly agentPersona: string
  readonly agentCallUser: string
}

export const DEFAULT_CONFIG: AgentConfig = {
  dashscopeApiKey: null,
  openaiApiBase: 'https://dashscope.aliyuncs.com/compatible-mode',
  chatModel: 'qwen3.6-flash',

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
}

const PREF_KEY = 'chat.agent-config.v1'

export async function loadConfig(): Promise<AgentConfig> {
  try {
    const raw = await solevupGetPref(PREF_KEY, '')
    if (raw) return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<AgentConfig>) }
  } catch {}
  return DEFAULT_CONFIG
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  try {
    await solevupSetPref(PREF_KEY, JSON.stringify(config))
  } catch {}
}

export function updateConfig(current: AgentConfig, updates: Partial<AgentConfig>): AgentConfig {
  const next = { ...current, ...updates }
  void saveConfig(next)
  return next
}

export function getDashScopeApiKey(config: AgentConfig): string | null {
  return config.dashscopeApiKey
}

// ── system prompt（desktop buildSystemPrompt 的精简版：人设 + 称呼 + 当前时间） ──

export function buildSystemPrompt(config: AgentConfig): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  return [
    config.agentPersona,
    `称呼用户为「${config.agentCallUser}」。`,
    `当前时间：${ts}。你运行在${config.agentCallUser}的手机上（Solevup 移动端）。`,
  ].join('\n\n')
}

// ── 聊天可选模型（DashScope 常用档位；模型面板里也允许自定义输入） ──

export const CHAT_MODEL_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'qwen3.6-flash', label: 'Qwen3.6 Flash（快 / 便宜）' },
  { id: 'qwen-flash', label: 'Qwen Flash' },
  { id: 'qwen-plus', label: 'Qwen Plus（均衡）' },
  { id: 'qwen-max', label: 'Qwen Max（最强）' },
]
