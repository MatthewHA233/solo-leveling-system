// ══════════════════════════════════════════════
// ChatImage Native Module 桥接 (Android-only)
// 系统选图 → 压缩 → 存 chat-images/。规则见 agent/chat-images.ts
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'
import type { ImageBlock } from './llm/types'

export const MAX_CHAT_IMAGES = 4

export interface PickedImage {
  readonly id: string
  readonly uri: string
  readonly block: ImageBlock
}

type NativeShape = {
  pick(max: number): Promise<{ images: { id: string; uri: string; base64: string; mediaType: string }[]; failed: number; skipped: number }>
  getDirUri(): Promise<string>
  sweep(): Promise<number>
}

const Native: NativeShape | null = Platform.OS === 'android' ? (NativeModules.ChatImage as NativeShape) : null

/** failed = 读不了的张数，skipped = 超过上限没有加上的张数 */
export async function pickChatImages(max: number): Promise<{ images: PickedImage[]; failed: number; skipped: number }> {
  if (!Native) return { images: [], failed: 0, skipped: 0 }
  const r = await Native.pick(max)
  return {
    failed: r.failed,
    skipped: r.skipped,
    images: r.images.map((i) => ({
      id: i.id,
      uri: i.uri,
      block: { type: 'image' as const, mediaType: i.mediaType, data: i.base64 },
    })),
  }
}

let dirUri = ''

/** 启动时取一次，顺手清掉没有消息引用的旧文件 */
export async function initChatImages(): Promise<void> {
  if (!Native) return
  dirUri = await Native.getDirUri()
  Native.sweep().catch(() => {})
}

export function chatImageUri(id: string): string {
  return dirUri ? `${dirUri}/${id}.jpg` : ''
}
