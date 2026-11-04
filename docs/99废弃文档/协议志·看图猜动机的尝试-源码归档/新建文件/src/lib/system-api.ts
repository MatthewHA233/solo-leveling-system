// ══════════════════════════════════════════════
// 系统 · 感知内核的本地 API 客户端（后端 src-tauri/src/sense.rs / sense_api.rs）
//   内核每 10 秒看一眼当前窗口，粗判你此刻在推进今日动机云里的哪一颗（临时判断，广播 system:sense）；
//   一分钟都对不上就提议一颗新动机，来问你收不收（system:ask）
// ══════════════════════════════════════════════

import { API_BASE } from './local-api'

/** 后端广播：系统此刻的临时判断变了 */
export const SENSE_EVENT = 'system:sense'
/** 后端广播：系统来问你「要把……收进动机云吗？」 */
export const ASK_EVENT = 'system:ask'
/** 系统窗口里点了「聊聊」：主窗口打开聊天、把问题填进输入框（App.tsx 监听，ChatPanel 收 solevup:chat-prefill） */
export const DISCUSS_EVENT = 'system:discuss'
export const CHAT_PREFILL_EVENT = 'solevup:chat-prefill'

export interface SenseState {
  readonly app: string
  readonly title: string
  /** 此刻在推进的候选（m: 动机 / p: 这一局）；null = 都不在 / 没判 */
  readonly goalKey: string | null
  /** 给人看的一句话 */
  readonly goal: string | null
  readonly goalP: number
  readonly sure: boolean
  /** 已经收进云里（false = 系统提议、你还没答） */
  readonly confirmed: boolean
  /** shot / title / private / self / off */
  readonly source: string
  /** 同一颗连续从什么时候开始（Unix ms），心流计时用 */
  readonly sinceMs: number
  readonly atMs: number
}

/** 后端广播：思维终端多了一行（内核这一步在想什么） */
export const THOUGHT_EVENT = 'system:thought'

export type ThoughtKind = 'look' | 'pick' | 'fit' | 'propose' | 'ask' | 'skip' | 'error'

export interface Thought {
  readonly atMs: number
  readonly kind: ThoughtKind
  readonly text: string
  /** 这一步花了多久；null = 不计时 */
  readonly ms: number | null
}

export interface RawThought {
  at_ms: number
  kind: ThoughtKind
  text: string
  ms: number | null
}

export const mapThought = (r: RawThought): Thought => ({ atMs: r.at_ms, kind: r.kind, text: r.text, ms: r.ms })

export interface AskPayload {
  readonly key: string
  readonly text: string
  readonly question: string
}

export type GoalAnswer = 'yes' | 'no' | 'chat'

export interface SenseConfig {
  readonly enabled: boolean
  readonly screenshots: boolean
  readonly dailyBudgetUsd: number
}

interface RawSense {
  app: string
  title: string
  goal_key: string | null
  goal: string | null
  goal_p: number
  sure: boolean
  confirmed: boolean
  source: string
  since_ms: number
  at_ms: number
}

interface RawConfig {
  enabled: boolean
  screenshots: boolean
  daily_budget_usd: number
}

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new Error('连不上本地服务（应用后端没在运行？）')
  }
  if (!res.ok) throw new Error(`系统服务出错（${res.status}）`)
  const json = (await res.json()) as ApiResponse<T>
  if (!json.success) throw new Error(json.error ?? '系统服务出错')
  return json.data as T
}

export function mapSense(r: RawSense): SenseState {
  return {
    app: r.app,
    title: r.title,
    goalKey: r.goal_key,
    goal: r.goal,
    goalP: r.goal_p,
    sure: r.sure,
    confirmed: r.confirmed,
    source: r.source,
    sinceMs: r.since_ms,
    atMs: r.at_ms,
  }
}

/** 你对「要把……收进动机云吗？」的回答 */
export async function answerMotive(ask: AskPayload, answer: GoalAnswer): Promise<void> {
  await call<null>('/api/system/motive-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: ask.key, text: ask.text, answer }),
  })
}

const mapConfig = (r: RawConfig): SenseConfig => ({
  enabled: r.enabled, screenshots: r.screenshots, dailyBudgetUsd: r.daily_budget_usd,
})

export async function fetchSense(): Promise<SenseState> {
  return mapSense(await call<RawSense>('/api/system/sense'))
}

/** 思维终端：内核最近 300 步 */
export async function fetchThoughts(): Promise<Thought[]> {
  return (await call<RawThought[]>('/api/system/thoughts')).map(mapThought)
}

export async function fetchSenseConfig(): Promise<SenseConfig> {
  return mapConfig(await call<RawConfig>('/api/system/sense-config'))
}

export async function updateSenseConfig(cfg: SenseConfig): Promise<SenseConfig> {
  const body = { enabled: cfg.enabled, screenshots: cfg.screenshots, daily_budget_usd: cfg.dailyBudgetUsd }
  return mapConfig(await call<RawConfig>('/api/system/sense-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

// ── 今日动机云：这个月自嗨开发的动机（和洪流域的旧动机锚点无关）──

export interface SenseMotive {
  readonly id: string
  readonly text: string
  /** user = 你自己敲的；ai = 系统提议、你收下的 */
  readonly origin: 'user' | 'ai'
}

interface RawMotive {
  id: string
  text: string
  origin: 'user' | 'ai'
}

const mapMotive = (r: RawMotive): SenseMotive => ({ id: r.id, text: r.text, origin: r.origin })

export async function fetchMotives(): Promise<SenseMotive[]> {
  return (await call<RawMotive[]>('/api/system/motives')).map(mapMotive)
}

/** 你自己加一颗（直接收下）；返回 null = 没加进来 */
export async function addMotive(text: string): Promise<SenseMotive | null> {
  const r = await call<RawMotive | null>('/api/system/motives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return r ? mapMotive(r) : null
}

/** 拿出云（不删；系统以后也不会再提同一句） */
export async function dropMotive(id: string): Promise<void> {
  await call<null>(`/api/system/motives/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── 今日动机云：立约（理想）× 感知归到各动机的时间（真实）──

export interface TodayView {
  readonly date: string
  /** 这一天立约的动机（动机 id） */
  readonly declared: readonly string[]
  /** 各动机今天被感知有把握判中的累计秒数（临时判断的估计，不是记录） */
  readonly motiveSeconds: ReadonlyMap<string, number>
  /** 今天所有有把握判断的累计秒数 */
  readonly judgedSeconds: number
}

interface RawToday {
  date: string
  declared: string[]
  motives: { anchor_id: string; seconds: number }[]
  judged_seconds: number
}

export async function fetchToday(date: string): Promise<TodayView> {
  const r = await call<RawToday>(`/api/system/today?date=${encodeURIComponent(date)}`)
  return {
    date: r.date,
    declared: r.declared,
    motiveSeconds: new Map(r.motives.map((m) => [m.anchor_id, m.seconds])),
    judgedSeconds: r.judged_seconds,
  }
}

/** 立约 / 取消：返回这一天立约的全部动机 */
export async function declareMotive(date: string, anchorId: string, declared: boolean): Promise<string[]> {
  return call<string[]>('/api/system/today/declare', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, anchor_id: anchorId, declared }),
  })
}
