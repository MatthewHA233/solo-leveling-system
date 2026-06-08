// ══════════════════════════════════════════════
// 共享类型 — 活动记录 + 聊天消息
// ══════════════════════════════════════════════

// ── 活动记录：自定义标签 + 5min 块（与 desktop types.ts 对齐）──

export interface ActivityCategory {
  id: number
  name: string
  color: string
  sortOrder: number
  createdAt: string
  lastUsedAt: string
}

export interface ActivityTag {
  id: number
  categoryId: number
  fullPath: string    // "工作,Solevup,手机端"
  leafName: string
  depth: number       // 1..4
  createdAt: string
  lastUsedAt: string
}

export interface ActivityBlock {
  date: string        // 'YYYY-MM-DD'
  minute: number      // 0/5/10/.../1435
  tagId: number
  note: string | null
  createdAt: string
}

export interface ActivityPalette {
  categories: ActivityCategory[]
  tags: ActivityTag[]
}

// ── 多模态聊天 ──

export type ChatRole = 'user' | 'agent' | 'system'
export type AiMode = 'regular' | 'omni'

/** 图片附件（mock 阶段用占位色块，接入后端后换真实 uri） */
export interface ChatImageAttachment {
  id: string
  label: string
  tint: string
  uri?: string
}

/** 语音附件（mock 阶段用合成波形） */
export interface ChatAudioAttachment {
  durationMs: number
  waveform: number[]   // 0..1
  transcript?: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  timestamp: number
  images?: ChatImageAttachment[]
  audio?: ChatAudioAttachment
  streaming?: boolean
  mode?: AiMode
}
