// ══════════════════════════════════════════════
// Bilibili API — 通过 Tauri 命令 + 内嵌 WebView 获取历史
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import type { BiliHistoryItem } from './types'
import type { ChronosActivity } from '../../types'
import type { DbBiliItem } from '../local-api'

/** 将 DB 中的 B站历史条目转为 ChronosActivity（供自动建档 + 手动加入活动） */
export function dbBiliItemToActivity(item: DbBiliItem): {
  date: Date
  bvid: string
  activity: Omit<ChronosActivity, 'id'>
} {
  const exitDate = new Date(item.view_at * 1000)
  const watchedSec = item.progress === -1 ? (item.duration || 60) : Math.max(item.progress, 60)
  const watchedMin = Math.ceil(watchedSec / 60)
  const endMinute = exitDate.getHours() * 60 + exitDate.getMinutes()
  const startMinute = Math.max(0, endMinute - watchedMin)
  const date = new Date(exitDate.getFullYear(), exitDate.getMonth(), exitDate.getDate())
  const progressPct = item.progress === -1
    ? 100
    : item.duration > 0 ? Math.round((item.progress / item.duration) * 100) : 0
  return {
    bvid: item.bvid,
    date,
    activity: {
      title: '看B站视频',
      category: 'media',
      startMinute,
      endMinute: Math.min(1440, endMinute),
      goalAlignment: undefined,
      events: [{
        id: '', minute: startMinute, label: '1',
        title: `${item.title}  ·  ${item.author_name}  (${progressPct}%)`,
      }],
    },
  }
}

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

/** 将 B站历史条目转为 ChronosActivity
 *  - 活动名：「看B站视频」
 *  - 时间：从 view_at（退出时刻）减去实际观看时长反推开始时间
 *  - 里程碑步骤：视频标题 + UP主，时间为开始观看的分钟数
 */
export function biliItemToActivity(item: BiliHistoryItem): {
  date: Date
  activity: Omit<ChronosActivity, 'id'>
} {
  const exitDate = new Date(item.view_at * 1000)

  // 实际观看秒数：-1 表示看完整个视频
  const watchedSec = item.progress === -1
    ? (item.duration || 60)
    : Math.max(item.progress, 60)
  const watchedMin = Math.ceil(watchedSec / 60)

  const endMinute = exitDate.getHours() * 60 + exitDate.getMinutes()
  const startMinute = Math.max(0, endMinute - watchedMin)

  const date = new Date(exitDate.getFullYear(), exitDate.getMonth(), exitDate.getDate())

  const progressPct = item.progress === -1
    ? 100
    : item.duration > 0 ? Math.round((item.progress / item.duration) * 100) : 0

  return {
    date,
    activity: {
      title: '看B站视频',
      category: 'media',
      startMinute,
      endMinute: Math.min(1440, endMinute),
      goalAlignment: undefined,
      events: [
        {
          id: '',   // 由服务端生成，发送时会被忽略
          minute: startMinute,
          label: '1',
          title: `${item.title}  ·  ${item.author_name}  (${progressPct}%)`,
        },
      ],
    },
  }
}
