// 协议志 · 协议：纯函数（强度说明、时长选项、常用站点、有效时长）
// 有效时长 = 局里的时间 ∩ 前台是白名单应用 ∩ 人不在空闲 / 离开；灰色项单独算（学习还是娱乐留给 AI 判断）

import type { AllowEntry, LockSession, LockStrength } from '../../../lib/protocol-api'
import type { PerceptionSpan } from '../../../lib/local-api'

export const STRENGTH_META: Readonly<Record<LockStrength, { readonly label: string; readonly desc: string }>> = {
  soft: { label: '软', desc: '想结束要先申请，等 1 分钟冷却' },
  firm: { label: '中', desc: '想结束要先申请，等 10 分钟冷却' },
  hard: { label: '硬', desc: '定好的时间到之前结束不了（必须定时）' },
}

export const DURATION_OPTIONS: ReadonlyArray<{ readonly minutes: number | null; readonly label: string }> = [
  { minutes: null, label: '不限时' },
  { minutes: 60, label: '1 小时' },
  { minutes: 120, label: '2 小时' },
  { minutes: 180, label: '3 小时' },
  { minutes: 240, label: '4 小时' },
]

/** 写代码常用的站点：一键加进白名单 */
export const DEV_SITE_PRESET: readonly string[] = [
  'github.com', 'claude.ai', 'anthropic.com', 'localhost', '127.0.0.1',
  'stackoverflow.com', 'developer.mozilla.org', 'react.dev', 'tauri.app',
  'docs.rs', 'crates.io', 'rust-lang.org', 'npmjs.com',
]

const DAY_SECONDS = 24 * 3600

/** 后端时间串「YYYY-MM-DD HH:MM:SS」（本地时间） */
export function parseLocalTime(s: string): Date {
  return new Date(s.slice(0, 19).replace(' ', 'T'))
}

export function formatClock(s: string): string {
  return s.slice(11, 16)
}

export function formatDuration(totalSeconds: number): string {
  const mins = Math.max(0, Math.floor(totalSeconds / 60))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m} 分`
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/** 和后端 focus_window_matches_rules 同一套写法：exe 名 / 路径（取文件名比）/ title:关键词 / window|exe|标题 */
export function appMatchesRule(app: string, title: string, rawRule: string): boolean {
  const rule = rawRule.trim().replace(/\//g, '\\').toLowerCase()
  if (!rule) return false
  const a = app.toLowerCase()
  const t = title.toLowerCase()
  if (rule.startsWith('window|')) {
    const [, ruleApp = '', ruleTitle = ''] = rule.split('|')
    return a === ruleApp.trim() && t === ruleTitle.trim()
  }
  if (rule.startsWith('title:')) {
    const kw = rule.slice('title:'.length).trim()
    return kw !== '' && t.includes(kw)
  }
  const base = rule.includes('\\') ? rule.slice(rule.lastIndexOf('\\') + 1) : rule
  return a === base
}

type AppClass = 'focus' | 'gray' | 'other'

function classifyApp(app: string, title: string, apps: readonly AllowEntry[]): AppClass {
  const hit = apps.find((e) => appMatchesRule(app, title, e.rule))
  if (!hit) return 'other'
  return hit.gray ? 'gray' : 'focus'
}

export interface FocusTally {
  /** 白名单（非灰色）应用在前台、人在的秒数 */
  readonly focusSeconds: number
  /** 灰色项在前台的秒数 */
  readonly graySeconds: number
}

/** 当天 0 点起的秒数，夹在 [0, 一天] 里 */
function secondOfDay(d: Date, dayStart: Date): number {
  return Math.min(DAY_SECONDS, Math.max(0, Math.round((d.getTime() - dayStart.getTime()) / 1000)))
}

/**
 * 某天各局的有效时长。spans = 当天的感知 spans（apps + status），sessions = 当天的各局。
 * 用一天 86400 格的「离开」标记做差：空闲 / 离开的秒不算，没有状态记录的秒按在场算（宁可少扣）
 */
export function tallyFocus(day: Date, spans: readonly PerceptionSpan[], sessions: readonly LockSession[], now: Date): FocusTally {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  const away = new Uint8Array(DAY_SECONDS)
  for (const s of spans) {
    if (s.track !== 'status' || (s.title !== 'idle' && s.title !== 'afk')) continue
    away.fill(1, secondOfDay(parseLocalTime(s.start_at), dayStart), secondOfDay(parseLocalTime(s.end_at), dayStart))
  }

  let focusSeconds = 0
  let graySeconds = 0
  const windows = spans.filter((s) => s.track === 'apps')
  for (const session of sessions) {
    const from = secondOfDay(parseLocalTime(session.startedAt), dayStart)
    const to = secondOfDay(session.endedAt ? parseLocalTime(session.endedAt) : now, dayStart)
    if (to <= from) continue
    for (const w of windows) {
      const a = Math.max(from, secondOfDay(parseLocalTime(w.start_at), dayStart))
      const b = Math.min(to, secondOfDay(parseLocalTime(w.end_at), dayStart))
      if (b <= a) continue
      const kind = classifyApp(w.group_name ?? '', w.title, session.apps)
      if (kind === 'other') continue
      let present = 0
      for (let i = a; i < b; i++) present += 1 - away[i]
      if (kind === 'focus') focusSeconds += present
      else graySeconds += present
    }
  }
  return { focusSeconds, graySeconds }
}

/** 把一项加进白名单（大小写不同也算重复） */
export function addEntry(list: readonly AllowEntry[], rule: string): readonly AllowEntry[] {
  const r = rule.trim()
  if (!r || list.some((e) => e.rule.toLowerCase() === r.toLowerCase())) return list
  return [...list, { rule: r, gray: false }]
}

export function removeEntry(list: readonly AllowEntry[], rule: string): readonly AllowEntry[] {
  return list.filter((e) => e.rule !== rule)
}

export function toggleGray(list: readonly AllowEntry[], rule: string): readonly AllowEntry[] {
  return list.map((e) => (e.rule === rule ? { ...e, gray: !e.gray } : e))
}

/** 用户贴进来的网址 → 域名（去协议、去 www.、去尾部斜杠）；本来就是域名 / 带路径的规则原样保留 */
export function normalizeSiteInput(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  const noScheme = s.replace(/^[a-z]+:\/\//i, '')
  if (noScheme !== s) {
    const host = noScheme.split('/')[0] ?? ''
    return host.replace(/^www\./i, '').toLowerCase()
  }
  return s.replace(/\/+$/, '')
}

/** 灰色地带那道题的选项（和后端 jev.rs 的 RELATION_CRITERIA 对应） */
export const RELATION_LABELS: Readonly<Record<string, string>> = {
  on_task: '直接服务于用意',
  adjacent: '沾边但偏放松',
  off_task: '娱乐，和用意无关',
}

/** 模型库里推荐的决策模型（种子见 src-tauri/src/jev.rs）的显示名；别的模型直接显示 id */
const DECISION_MODEL_NAMES: Readonly<Record<string, string>> = {
  'microsoft/microsoft-decision-1': 'Microsoft Decision-1',
  'typesafe-ai/jev': 'Jev',
  'liquid/d1': 'Liquid d1',
}

export function decisionModelName(id: string): string {
  return DECISION_MODEL_NAMES[id] ?? id
}
