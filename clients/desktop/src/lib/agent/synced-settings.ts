// ══════════════════════════════════════════════
// 随局域网同步的设置。规则两端相同，改了要同时改（手机端、桌面端同名文件，表在 SolevupDb.kt、db.rs）：
//   · 现在只有 Fish 音色和模型，其他配置每台设备各管各的
//   · 按 updated_at 取新。手动改时写表，时间是当时
//   · 同步进来的值只更新配置，不写回表，否则两边会互相刷新修改时间
//   · 启动时用户改过默认值才写种子。种子时间比任何修改都旧，不会盖掉对端真正改过的值
// ══════════════════════════════════════════════

import type { AgentConfig } from './agent-config'

type SyncedField = 'fishReferenceId' | 'fishModel'

const FIELD_OF_KEY: Readonly<Record<string, SyncedField>> = {
  fish_reference_id: 'fishReferenceId',
  fish_model: 'fishModel',
}

export interface SettingWrite {
  readonly key: string
  readonly value: string
}

/** 同步表 → 配置更新，只含和手里不一样的项 */
export function configUpdatesFromSettings(
  rows: readonly SettingWrite[],
  config: AgentConfig,
): Partial<AgentConfig> {
  const updates: Partial<Record<SyncedField, string>> = {}
  for (const { key, value } of rows) {
    const field = FIELD_OF_KEY[key]
    if (field && config[field] !== value) updates[field] = value
  }
  return updates
}

/** 这次配置更新里要写进同步表的项 */
export function settingWrites(config: AgentConfig, updates: Partial<AgentConfig>): SettingWrite[] {
  const writes: SettingWrite[] = []
  for (const [key, field] of Object.entries(FIELD_OF_KEY)) {
    const value = updates[field]
    if (value !== undefined && value !== config[field]) writes.push({ key, value })
  }
  return writes
}

/** 启动时要写的种子：表里还没有，而且和默认值不一样 */
export function seedWrites(
  rows: readonly SettingWrite[],
  config: AgentConfig,
  defaults: AgentConfig,
): SettingWrite[] {
  const writes: SettingWrite[] = []
  for (const [key, field] of Object.entries(FIELD_OF_KEY)) {
    if (config[field] !== defaults[field] && !rows.some((r) => r.key === key)) {
      writes.push({ key, value: config[field] })
    }
  }
  return writes
}
