// ══════════════════════════════════════════════
// 协议志 · 协议（锁机白名单）的本地 API 客户端（后端 src-tauri/src/protocols_api.rs）
//   协议 = 一份白名单 + 强度 + 每日目标；一局 = 开局时冻结的那份白名单，进行中由后端执行拦截
// ══════════════════════════════════════════════

import { API_BASE, toLocalDateStr } from './local-api'

export type LockStrength = 'soft' | 'firm' | 'hard'

/** 白名单一项：应用写 exe 名，网站写域名（可带路径和 *）；gray = 灰色地带（放行，留给 AI 判断） */
export interface AllowEntry {
  readonly rule: string
  readonly gray: boolean
}

export interface LockProtocol {
  readonly id: string
  readonly name: string
  readonly intent: string
  readonly apps: readonly AllowEntry[]
  readonly sites: readonly AllowEntry[]
  readonly strength: LockStrength
  readonly dailyTargetMin: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface LockProtocolPatch {
  readonly name?: string
  readonly intent?: string
  readonly apps?: readonly AllowEntry[]
  readonly sites?: readonly AllowEntry[]
  readonly strength?: LockStrength
  readonly dailyTargetMin?: number
}

export interface LockSession {
  readonly id: string
  readonly protocolId: string
  readonly protocolName: string
  readonly apps: readonly AllowEntry[]
  readonly sites: readonly AllowEntry[]
  readonly strength: LockStrength
  readonly startedAt: string
  readonly plannedEndAt: string | null
  readonly endedAt: string | null
  /** done = 到点 / stopped = 自己结束 */
  readonly endReason: string | null
  readonly stopRequestedAt: string | null
  /** 最早能结束的时刻：软 / 中 = 申请结束 + 冷却；硬 = 定好的结束时刻 */
  readonly canStopAt: string | null
  readonly interceptCount: number
}

export interface LockIntercept {
  readonly at: string
  readonly kind: string
  readonly target: string
  readonly title: string
}

export interface AppUsage {
  readonly app: string
  readonly seconds: number
}

/** 后端广播：开局 / 结束 / 申请结束 / 到点 */
export const SESSION_CHANGED_EVENT = 'protocol:session-changed'

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

interface RawProtocol {
  id: string
  name: string
  intent: string
  apps: AllowEntry[]
  sites: AllowEntry[]
  strength: LockStrength
  daily_target_min: number
  created_at: string
  updated_at: string
}

interface RawSession {
  id: string
  protocol_id: string
  protocol_name: string
  rules: { apps: AllowEntry[]; sites: AllowEntry[]; strength: LockStrength }
  started_at: string
  planned_end_at: string | null
  ended_at: string | null
  end_reason: string | null
  stop_requested_at: string | null
  can_stop_at: string | null
  intercept_count: number
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new Error('连不上本地服务（应用后端没在运行？）')
  }
  if (!res.ok) throw new Error(`协议服务出错（${res.status}）`)
  const json = (await res.json()) as ApiResponse<T>
  if (!json.success) throw new Error(json.error ?? '协议服务出错')
  return json.data as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

function mapProtocol(r: RawProtocol): LockProtocol {
  return {
    id: r.id,
    name: r.name,
    intent: r.intent,
    apps: r.apps,
    sites: r.sites,
    strength: r.strength,
    dailyTargetMin: r.daily_target_min,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapSession(r: RawSession): LockSession {
  return {
    id: r.id,
    protocolId: r.protocol_id,
    protocolName: r.protocol_name,
    apps: r.rules.apps,
    sites: r.rules.sites,
    strength: r.rules.strength,
    startedAt: r.started_at,
    plannedEndAt: r.planned_end_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
    stopRequestedAt: r.stop_requested_at,
    canStopAt: r.can_stop_at,
    interceptCount: r.intercept_count,
  }
}

export async function fetchProtocols(): Promise<LockProtocol[]> {
  return (await call<RawProtocol[]>('/api/protocols')).map(mapProtocol)
}

export async function createProtocol(name: string): Promise<LockProtocol> {
  return mapProtocol(await call<RawProtocol>('/api/protocols', jsonInit('POST', { name })))
}

export async function updateProtocol(id: string, patch: LockProtocolPatch): Promise<LockProtocol> {
  const body = {
    name: patch.name,
    intent: patch.intent,
    apps: patch.apps,
    sites: patch.sites,
    strength: patch.strength,
    daily_target_min: patch.dailyTargetMin,
  }
  return mapProtocol(await call<RawProtocol>(`/api/protocols/${encodeURIComponent(id)}`, jsonInit('PATCH', body)))
}

export async function deleteProtocol(id: string): Promise<void> {
  await call<null>(`/api/protocols/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** minutes = null 不限时（硬锁必须定时） */
export async function startSession(protocolId: string, minutes: number | null): Promise<LockSession> {
  const path = `/api/protocols/${encodeURIComponent(protocolId)}/start`
  return mapSession(await call<RawSession>(path, jsonInit('POST', { minutes })))
}

export async function fetchCurrentSession(): Promise<LockSession | null> {
  const r = await call<RawSession | null>('/api/protocol-session')
  return r ? mapSession(r) : null
}

/** 软 / 中锁：第一次 = 申请结束（开始冷却），冷却到了再调 = 真结束；硬锁到点前会报错 */
export async function requestStop(): Promise<LockSession> {
  return mapSession(await call<RawSession>('/api/protocol-session/stop', { method: 'POST' }))
}

export async function cancelStop(): Promise<LockSession> {
  return mapSession(await call<RawSession>('/api/protocol-session/stop/cancel', { method: 'POST' }))
}

export async function fetchSessionsForDate(date: Date): Promise<LockSession[]> {
  const raw = await call<RawSession[]>(`/api/protocol-sessions?date=${toLocalDateStr(date)}`)
  return raw.map(mapSession)
}

export async function fetchIntercepts(sessionId: string): Promise<LockIntercept[]> {
  return call<LockIntercept[]>(`/api/protocol-sessions/${encodeURIComponent(sessionId)}/intercepts`)
}

export async function fetchAppUsage(days: number): Promise<AppUsage[]> {
  return call<AppUsage[]>(`/api/protocol-app-usage?days=${days}`)
}

// ── 灰色地带的 AI 判断（决策模型，默认走 Vercel AI Gateway）──

export interface JevConfig {
  readonly baseUrl: string
  readonly hasKey: boolean
  /** Key 的后四位（后端不回传整个 Key） */
  readonly keyTail: string | null
  /** 模型库里「协议·灰色地带判断」绑的模型 */
  readonly model: string
  /** 模型库里「协议·灰色地带判断（看图）」绑的模型 */
  readonly visionModel: string
}

/** 只改传了的字段；apiKey 传 '' = 清掉（模型在模型库里换） */
export interface JevConfigPatch {
  readonly baseUrl?: string
  readonly apiKey?: string
}

export interface JevVerdict {
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly latencyMs: number
  readonly model: string
  readonly inputTokens: number
}

interface RawJevConfig {
  base_url: string
  has_key: boolean
  key_tail: string | null
  model: string
  vision_model: string
}

interface RawVerdict {
  choice: string
  confidence: number
  probabilities: Record<string, number>
  latency_ms: number
  model: string
  input_tokens: number
}

const mapJevConfig = (r: RawJevConfig): JevConfig => ({
  baseUrl: r.base_url, hasKey: r.has_key, keyTail: r.key_tail, model: r.model, visionModel: r.vision_model,
})

export async function fetchJevConfig(): Promise<JevConfig> {
  return mapJevConfig(await call<RawJevConfig>('/api/jev/config'))
}

export async function updateJevConfig(patch: JevConfigPatch): Promise<JevConfig> {
  const body = { base_url: patch.baseUrl, api_key: patch.apiKey }
  return mapJevConfig(await call<RawJevConfig>('/api/jev/config', jsonInit('PUT', body)))
}

/** 拿一个窗口标题试判一次；不传就用内置样本（Tauri 教程，应判「直接服务」） */
export async function testJev(sample: { intent?: string; app?: string; title?: string } = {}): Promise<JevVerdict> {
  const r = await call<RawVerdict>('/api/jev/test', jsonInit('POST', sample))
  return {
    choice: r.choice,
    confidence: r.confidence,
    probabilities: r.probabilities,
    latencyMs: r.latency_ms,
    model: r.model,
    inputTokens: r.input_tokens,
  }
}
