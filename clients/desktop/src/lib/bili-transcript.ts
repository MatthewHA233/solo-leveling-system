// ══════════════════════════════════════════════
// B 站转录读取 — 从本地缓存文件拉纯文本
// 供两处共用：语境库展开展示、"注视即锚定"（锁定 B 站卡无需展开即可作为锚定目标）
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'

export interface BiliTranscriptCacheResp {
  readonly visual: string | null
  readonly audio: string | null
  readonly combined: string | null
}

/** ASR 转录是逐句 JSONL（{"start","end","text"}），抽成纯文本；非 JSON 行原样保留 */
export function jsonlToPlain(raw: string): string {
  return raw
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (!t) return ''
      try {
        const obj = JSON.parse(t) as { text?: unknown }
        if (typeof obj.text === 'string') return obj.text
      } catch { /* 非 JSON 行 */ }
      return t
    })
    .join('')
}

// 按 refPath 记忆化：同一张卡反复锚定不重复读盘
const transcriptCache = new Map<string, string>()

/** 读 ref_path 对应的转录纯文本；无文件/无文本/失败返回 null */
export async function fetchBiliTranscriptPlain(refPath: string | null | undefined): Promise<string | null> {
  if (!refPath) return null
  const hit = transcriptCache.get(refPath)
  if (hit !== undefined) return hit || null
  try {
    const resp = await invoke<BiliTranscriptCacheResp>('get_bili_transcripts', { filePath: refPath })
    const raw = resp.combined || resp.audio || resp.visual || ''
    const plain = raw ? jsonlToPlain(raw) : ''
    transcriptCache.set(refPath, plain)
    return plain || null
  } catch (e) {
    console.error('[BiliTranscript] 读取转录失败', e)
    return null
  }
}
