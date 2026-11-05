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
  pick(max: number): Promise<{ images: { id: string; uri: string; base64: string; mediaType: string }[]; failed: number }>
  getDirUri(): Promise<string>
  sweep(): Promise<number>
}

const Native: NativeShape | null = Platform.OS === 'android' ? (NativeModules.ChatImage as NativeShape) : null

export async function pickChatImages(max: number): Promise<{ images: PickedImage[]; failed: number }> {
  if (!Native) return { images: [], failed: 0 }
  const r = await Native.pick(max)
  return {
    failed: r.failed,
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
