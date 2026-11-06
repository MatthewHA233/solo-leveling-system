// ══════════════════════════════════════════════
// Fairy 聊天组件层的类型（对齐 desktop App.tsx 的 ChatMessage / OmniDebugInfo）
// 组件只认这里的形状，状态由调用方（AgentPanel）通过 props 传入。
//
// src/types.ts 的 ChatMessage（chat-controller 产出）可以直接赋值过来；
// debugSnapshots / omniDebugInfo / usage / audio.path 都是可选，有值时气泡才显示对应功能。
// ══════════════════════════════════════════════

import type { ApiRequestSnapshot } from '../../lib/llm/api'
import type { ModelCallLog } from '../../lib/models/model-audit'
import type { ChatImageAttachment } from '../../types'

export type FairyState = 'idle' | 'thinking' | 'listening' | 'speaking'

export interface OmniDebugItem {
  readonly type: 'text' | 'audio'
  readonly ts: string
  readonly content?: string
  readonly wavBase64?: string
  readonly durationMs?: number
}

export interface OmniDebugInfo {
  readonly systemPrompt: string
  readonly model: string
  readonly voice: string
  readonly ts: string
  readonly items: readonly OmniDebugItem[]
}

/** 语音附件。桌面端是 audioUrl + durationMs + transcript 三个字段，手机端已有的结构是 audio 对象，这里沿用 */
export interface FairyAudio {
  /** saveAudioFile 返回的相对路径（DB 的 audio_path）；还没落盘时为空 */
  readonly path?: string | null
  readonly durationMs?: number
  /** 0..1；没有就按路径生成一个稳定的占位波形（手机端没法在 JS 里解码本地文件） */
  readonly waveform?: readonly number[]
  readonly transcript?: string
}

export interface FairyMessage {
  readonly id: string
  readonly role: 'user' | 'agent' | 'system'
  readonly content: string
  /** 手机端现有消息是毫秒数，从 DB 恢复 / 桌面端同步来的是 ISO 字符串，两种都接受 */
  readonly timestamp: number | string
  readonly reasoning?: string
  readonly streaming?: boolean
  readonly images?: readonly ChatImageAttachment[]
  readonly audio?: FairyAudio
  readonly debugSnapshots?: readonly ApiRequestSnapshot[]
  readonly omniDebugInfo?: OmniDebugInfo
  readonly usage?: ModelCallLog | null
  /** 压缩提示点开看到的摘要（规则见 lib/agent/chat-history.ts） */
  readonly summary?: string
}

export interface FairyGazeTarget {
  readonly kind: 'thought' | 'bili_transcript'
  readonly title: string | null
  readonly text: string
}

/** 跳到某条消息并高亮（历史会话搜索命中）；nonce 变化才触发一次 */
export interface FairyJumpTarget {
  readonly timestamp: number | string
  readonly nonce: number
}
