// 系统窗口：什么时候浮出来说一句、说什么（纯函数，好测）
//   只在这些时刻说话：开局 / 局结束 / 有把握地换了一个小目标 / 心流满一段；拿不准的由内核发问（system:ask）
//   不放分数、不评判：没做的事安静着，系统不催

import type { SenseState } from '../../lib/system-api'
import type { LockSession } from '../../lib/protocol-api'

/** 心流满这些分钟时说一句 */
export const FLOW_MILESTONES_MIN: readonly number[] = [25, 50, 90]
/** 浮出来多久后收起 */
export const SHOW_MS = 6_000

export interface SystemMessage {
  readonly id: string
  /** 大字：一句话 */
  readonly line: string
  /** 小字：补充（可空） */
  readonly sub: string | null
}

const minutes = (ms: number) => Math.max(0, Math.floor(ms / 60_000))

export function formatSince(nowMs: number, sinceMs: number): string {
  const m = minutes(nowMs - sinceMs)
  return m < 60 ? `${m}′` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}′`
}

/** 感知变化 → 要不要说一句：只对你认过的小目标说「正在」（没认过的是猜测，交给「问」，不当成事实说） */
export function senseMessage(prev: SenseState | null, next: SenseState): SystemMessage | null {
  if (!next.sure || !next.confirmed || !next.goal || next.goalKey === prev?.goalKey) return null
  return { id: `sense-${next.goalKey}-${next.atMs}`, line: `正在：${next.goal}`, sub: null }
}

/** 局开始 / 结束 → 一句话 */
export function sessionMessage(prev: LockSession | null, next: LockSession | null, todayCount: number): SystemMessage | null {
  if (next && next.id !== prev?.id) {
    const until = next.plannedEndAt ? ` · 到 ${next.plannedEndAt.slice(11, 16)}` : ''
    return { id: `start-${next.id}`, line: `第 ${todayCount} 局开始`, sub: `${next.protocolName}${until}` }
  }
  if (prev && !next) {
    return { id: `end-${prev.id}`, line: '这一局结束了', sub: prev.protocolName }
  }
  return null
}

/** 心流里程碑：同一个小目标有把握、连续满 N 分钟（每个里程碑只说一次，记在 said 里） */
export function flowMessage(sense: SenseState | null, nowMs: number, said: ReadonlySet<string>): SystemMessage | null {
  if (!sense || !sense.sure || !sense.goal || sense.sinceMs <= 0) return null
  const m = minutes(nowMs - sense.sinceMs)
  const hit = [...FLOW_MILESTONES_MIN].reverse().find((x) => m >= x)
  if (hit === undefined) return null
  const id = `flow-${sense.goalKey}-${sense.sinceMs}-${hit}`
  if (said.has(id)) return null
  return { id, line: `连续 ${hit} 分钟`, sub: sense.goal }
}

/** 小字里的「正在什么」：太长就截断 */
export function glyphGoal(goal: string, max = 16): string {
  return goal.length > max ? `${goal.slice(0, max)}…` : goal
}
