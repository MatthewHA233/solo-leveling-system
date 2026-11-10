// ══════════════════════════════════════════════
// 共享类型 — 活动记录 + 聊天消息
// ══════════════════════════════════════════════

import type { OmniDebugInfo } from './components/fairy/types'
import type { ToolCallView } from './lib/agent/tool-call-view'
import type { ApiRequestSnapshot } from './lib/llm/api'
import type { ModelCallLog } from './lib/models/model-audit'

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

/** 气泡和输入框上的图片。uri 指向本机文件；别的设备发的图，文件不在这台上（规则见 lib/agent/chat-images.ts） */
export interface ChatImageAttachment {
  id: string
  uri: string
}

/** 语音附件（对应 desktop ChatMessage 的 audioUrl / durationMs / transcript） */
export interface ChatAudioAttachment {
  /** saveAudioFile 返回的相对路径（库里的 audio_path）；还没落盘时为空 */
  path?: string | null
  durationMs?: number
  waveform?: number[]   // 0..1；从库里恢复的消息没有，气泡按路径生成占位波形
  transcript?: string
}

export interface ChatMessage {
  /** 和库里 chat_messages.id 是同一个值：同一条消息重复写入按它合并 */
  id: string
  role: ChatRole
  content: string
  /** ISO 字符串，从库里恢复的保持原样（搜索跳转按这个值定位气泡） */
  timestamp: string
  images?: ChatImageAttachment[]
  audio?: ChatAudioAttachment
  /** 手机端多的标记：这条还在生成。这轮结束后正文仍为空时不再显示「正在思考」 */
  streaming?: boolean
  /** 思考模型的推演过程（reasoningDelta 流式累积；不进对话历史，仅 UI 展示+持久化） */
  reasoning?: string
  /** 本轮实际发给模型的请求（调试弹窗用，不入库） */
  debugSnapshots?: ApiRequestSnapshot[]
  /** Omni 实时模式的上下文快照（调试弹窗用，不入库） */
  omniDebugInfo?: OmniDebugInfo
  /** 模型审计整行（入库到 usage_json，恢复时过 parseModelCallLog） */
  usage?: ModelCallLog | null
  /** 压缩提示（system）点开看到的摘要（规则见 lib/agent/chat-history.ts） */
  summary?: string
  /** 一次工具调用（system）：单独一行，点开看参数和结果（规则见 lib/agent/tool-call-view.ts） */
  tool?: ToolCallView
}
