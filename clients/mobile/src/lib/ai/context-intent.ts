// ══════════════════════════════════════════════
// 上下文治理 — 应用列表瘦身 + 意图驱动加载
//   · compactAppUsage：去终端 spinner 噪音、合并连续同进程段、限量
//   · classifyIntent：按用户消息关键词决定加载哪些上下文段（规则版，零延迟）
// ══════════════════════════════════════════════

import type { AppUsageRecord } from './prompt-templates'

// 终端标题里的动画噪音：盲文 spinner（U+2800–U+28FF）+ 常见装饰星号
const SPINNER_RE = /[⠀-⣿✳✴✸✽✱✲·]/g
const MAX_APP_ROWS = 12

/** 归一化窗口标题：剥 spinner + 前导符号 + trim */
function normalizeTitle(s: string): string {
  return s.replace(SPINNER_RE, '').replace(/^[\s\-–—·•|*✳]+/, '').trim()
}

/**
 * 瘦身应用使用列表：
 * 1. 归一化标题（去 spinner）
 * 2. 合并相邻同进程段（同一终端的标题帧/分支名变化合成一条，时间取首尾）
 * 3. 限量最近 ~12 条
 */
export function compactAppUsage(records: readonly AppUsageRecord[]): AppUsageRecord[] {
  if (records.length === 0) return []
  const merged: AppUsageRecord[] = []
  for (const r of records) {
    const title = normalizeTitle(r.appName)
    const last = merged[merged.length - 1]
    // windowTitle 字段实为进程名（如 WindowsTerminal.exe）；相邻同进程合并
    if (last && last.windowTitle === r.windowTitle) {
      last.endTime = r.endTime
      if (title) last.appName = title // 取最后一个非空标题
    } else {
      merged.push({ ...r, appName: title })
    }
  }
  return merged.slice(-MAX_APP_ROWS)
}

// ── 意图分类（规则版）──────────────────────────

export interface ContextIntent {
  activity: boolean // 活动标签 + 应用使用
  bili: boolean     // B 站观看
  goals: boolean    // 目标 / 动机
}

const RE_ACTIVITY = /今天|刚才|刚刚|在干|在做|做了|做什么|干了|干嘛|忙|多久|多少时间|几点|效率|摸鱼|分心|专注|记录|状态|时间都/
const RE_BILI = /视频|b站|bilibili|哔哩|看了|刷|up主|番剧/i
const RE_GOALS = /目标|计划|想做|规划|愿景|动机|要做|打算|方向/

/**
 * 按用户消息判断需要哪些上下文段。
 * 都不命中（纯闲聊/情绪）→ 全 false：只留 D1 时间 + D5 存在感，最省。
 * Fairy 有 GetAppUsage/GetBiliHistory 等工具，漏加载可按需查，分类不必完美。
 */
export function classifyIntent(text: string): ContextIntent {
  return {
    activity: RE_ACTIVITY.test(text),
    bili: RE_BILI.test(text),
    goals: RE_GOALS.test(text),
  }
}
