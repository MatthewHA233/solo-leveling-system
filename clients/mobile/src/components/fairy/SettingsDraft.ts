// ══════════════════════════════════════════════
// 设置面板的草稿（对应 desktop SettingsPanel 的 draft / handleApply）
// 改的时候只动草稿，点保存才写配置。回退规则照搬 desktop（比如 agentName 留空回到 Fairy）。
//
// 和 desktop 的差别：desktop 保存时整份草稿写回；这里只写主人改过的字段。
// 关掉面板时未保存的草稿会留着，这期间顶栏切模式、模型中心换 Key 都可能改配置，整份写回会盖掉它们。
// ══════════════════════════════════════════════

import { DEFAULT_CONFIG, type AgentConfig } from '../../lib/agent/agent-config'

export interface SettingsDraft {
  readonly aiMode: AgentConfig['aiMode']
  readonly agentName: string
  readonly agentPersona: string
  readonly agentCallUser: string
  readonly mainQuest: string
  readonly fishReferenceId: string
  readonly fishModel: string
  readonly ttsEnabled: boolean
  readonly omniVoice: string
  readonly omniApiKey: string
  readonly omniApiBase: string
  readonly omniModel: string
  readonly asrApiKey: string
  readonly asrModel: string
}

const DRAFT_KEYS: readonly (keyof SettingsDraft)[] = [
  'aiMode', 'agentName', 'agentPersona', 'agentCallUser', 'mainQuest',
  'fishReferenceId', 'fishModel', 'ttsEnabled', 'omniVoice',
  'omniApiKey', 'omniApiBase', 'omniModel', 'asrApiKey', 'asrModel',
]

export function draftFromConfig(config: AgentConfig): SettingsDraft {
  return {
    aiMode: config.aiMode,
    agentName: config.agentName,
    agentPersona: config.agentPersona,
    agentCallUser: config.agentCallUser,
    mainQuest: config.mainQuest ?? '',
    fishReferenceId: config.fishReferenceId,
    fishModel: config.fishModel,
    ttsEnabled: config.ttsEnabled,
    omniVoice: config.omniVoice,
    omniApiKey: config.omniApiKey ?? '',
    omniApiBase: config.omniApiBase,
    omniModel: config.omniModel,
    asrApiKey: config.asrApiKey ?? '',
    asrModel: config.asrModel,
  }
}

/** Key 手机上多半是粘贴的，前后带空白会鉴权失败；只有空白时也算没填，才能回落到别的 Key */
const keyOrNull = (value: string): string | null => value.trim() || null

/** 对应 desktop handleApply 里的回退规则 */
function draftToConfig(draft: SettingsDraft) {
  return {
    aiMode: draft.aiMode,
    agentName: draft.agentName || DEFAULT_CONFIG.agentName,
    agentPersona: draft.agentPersona,
    agentCallUser: draft.agentCallUser || DEFAULT_CONFIG.agentCallUser,
    mainQuest: draft.mainQuest || null,
    fishReferenceId: draft.fishReferenceId,
    fishModel: draft.fishModel || DEFAULT_CONFIG.fishModel,
    ttsEnabled: draft.ttsEnabled,
    omniVoice: draft.omniVoice,
    omniApiKey: keyOrNull(draft.omniApiKey),
    omniApiBase: draft.omniApiBase || DEFAULT_CONFIG.omniApiBase,
    omniModel: draft.omniModel || DEFAULT_CONFIG.omniModel,
    asrApiKey: keyOrNull(draft.asrApiKey),
    asrModel: draft.asrModel || DEFAULT_CONFIG.asrModel,
  }
}

/** 主人改过的字段（和起点比），保存时只写这些 */
export function changedFields(draft: SettingsDraft, baseline: SettingsDraft): Partial<AgentConfig> {
  const next = draftToConfig(draft)
  const prev = draftToConfig(baseline)
  const updates: Record<string, unknown> = {}
  for (const key of DRAFT_KEYS) {
    if (next[key] !== prev[key]) updates[key] = next[key]
  }
  return updates as Partial<AgentConfig>
}

export function isDraftDirty(draft: SettingsDraft, baseline: SettingsDraft): boolean {
  return DRAFT_KEYS.some((key) => draft[key] !== baseline[key])
}

/** 重新打开面板：没动过的字段取最新配置，改了没保存的留着 */
export function rebaseDraft(draft: SettingsDraft, baseline: SettingsDraft, config: AgentConfig): SettingsDraft {
  const fresh = draftFromConfig(config)
  const merged: Record<string, unknown> = { ...fresh }
  for (const key of DRAFT_KEYS) {
    if (draft[key] !== baseline[key]) merged[key] = draft[key]
  }
  return merged as unknown as SettingsDraft
}
