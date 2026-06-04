// ══════════════════════════════════════════════
// Bilibili API — 通过 Tauri 命令 + 内嵌 WebView 获取历史
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import type { BiliHistoryItem } from './types'
import type { DbBiliItem } from '../local-api'

/** 打开内嵌 B站登录窗口 */
export async function openBiliLogin(): Promise<void> {
  await invoke('open_bili_login')
}

export interface BiliNavInfo {
  is_login: boolean
  uname: string | null
  mid: number | null
}

/** 通过内嵌 WebView 调 nav 接口拿登录态 + 用户名（登录窗口未创建时返回 is_login=false） */
export async function getBiliNav(): Promise<BiliNavInfo> {
  return await invoke<BiliNavInfo>('bili_get_nav')
}

/** 格式化观看时间 */
export function formatViewTime(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (diffSec < 60) return `${diffSec}秒前`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`

  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${min}`
}

/** 计算观看进度 0~1（BiliHistoryItem） */
export function calcProgress(item: BiliHistoryItem): number {
  if (item.progress === -1) return 1
  if (!item.duration || item.duration === 0) return 0
  return Math.min(1, item.progress / item.duration)
}

/** 计算观看进度 0~1（DbBiliItem） */
export function calcProgressFromDb(item: DbBiliItem): number {
  if (item.progress === -1) return 1
  if (!item.duration || item.duration === 0) return 0
  return Math.min(1, item.progress / item.duration)
}
