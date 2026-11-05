// ══════════════════════════════════════════════
// 提示词取数（对应 desktop App.tsx 的 refreshSystemPrompt / activityBlocksToContextRecords / 预热定时器）
//
// 和桌面端的差异：
//   · 活动标签在手机本地库；目标、应用使用、B 站记录在桌面端，连不上就没有这几段，不算错
//   · 桌面端取数都是本机，手机隔着局域网：桌面端离线时探测要等 3 秒，每轮发送都等就太慢了，
//     所以这部分有总时限，超时当这轮没有（探测本身还在继续，地址缓存 30 秒）
//   · 预热定时器只在实时模式、App 在前台时跑：它是给 Omni 建连时热读用的，常驻会一直探测桌面端
//   · 摄像头存在感（D5）不传：手机端没有这个能力，桌面端开关也是关的
// ══════════════════════════════════════════════

import { AppState } from 'react-native'

import type { ActivityBlock, ActivityPalette } from '../../types'
import { compactAppUsage, classifyIntent } from '../ai/context-intent'
import {
  buildConversationSummary,
  buildDynamicContext,
  buildStaticPrompt,
  type ActivityTagRecord,
  type AppUsageRecord,
  type BiliRecord,
  type GoalRecord,
} from '../ai/prompt-templates'
import { fetchBlocks, fetchPalette } from '../api'
import { desktopRequest } from '../desktop-api'
import { buildAsrVocabulary } from '../voice/asr-hints'
import { timestampMs } from './agent-memory'
import type { ChatCore } from './chat-core'
import { fetchBiliSpans, fetchPerceptionSpans } from './tools'

const ACTIVITY_BLOCK_MINUTES = 5
/** 桌面端数据的总时限；连得上时局域网请求远小于这个值 */
const DESKTOP_CONTEXT_DEADLINE_MS = 1500
const PREHEAT_INTERVAL_MS = 60_000

function clampMinute(minute: number): number {
  return Math.max(0, Math.min(1440, minute))
}

function hhmmFromMinute(minute: number): string {
  const m = clampMinute(minute)
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function dayStartMs(date: Date): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function activityBlocksToContextRecords(
  blocks: readonly ActivityBlock[],
  palette: ActivityPalette,
  sinceMs: number,
  day: Date,
): ActivityTagRecord[] {
  const tagById = new Map(palette.tags.map((tag) => [tag.id, tag]))
  const categoryById = new Map(palette.categories.map((category) => [category.id, category]))
  const baseMs = dayStartMs(day)
  const nowMs = Date.now()

  const sorted = blocks
    .filter((block) => {
      const startMs = baseMs + block.minute * 60_000
      const endMs = startMs + ACTIVITY_BLOCK_MINUTES * 60_000
      return endMs >= sinceMs && startMs <= nowMs
    })
    .sort((a, b) => a.minute - b.minute)

  const groups: Array<{ tagId: number; start: number; end: number }> = []
  for (const block of sorted) {
    const end = Math.min(1440, block.minute + ACTIVITY_BLOCK_MINUTES)
    const last = groups[groups.length - 1]
    if (last && last.tagId === block.tagId && last.end === block.minute) {
      last.end = end
    } else {
      groups.push({ tagId: block.tagId, start: block.minute, end })
    }
  }

  return groups.map((group) => {
    const tag = tagById.get(group.tagId)
    const category = tag ? categoryById.get(tag.categoryId) : undefined
    const parts = tag?.fullPath.split(',').map((part) => part.trim()).filter(Boolean) ?? []
    const firstPart = parts[0]
    const tagLabel = category?.name ?? firstPart ?? tag?.leafName ?? `tag#${group.tagId}`
    const restParts = parts.length > 1 ? parts.slice(1) : []
    const subTag = restParts.length > 0
      ? restParts.join(' / ')
      : tag?.leafName && tag.leafName !== tagLabel
        ? tag.leafName
        : undefined

    return {
      startTime: hhmmFromMinute(group.start),
      endTime: hhmmFromMinute(group.end),
      tag: tagLabel,
      subTag,
    }
  })
}

interface DesktopGoal {
  readonly title: string
  readonly tags?: string | null
}

async function fetchActiveGoals(): Promise<DesktopGoal[]> {
  const json = await desktopRequest<DesktopGoal[]>('GET', '/api/goals?status=active')
  if (!json.success || !json.data) throw new Error(json.error || '获取目标失败')
  return json.data
}

function parseGoalTags(goal: DesktopGoal): string[] {
  try {
    return JSON.parse(goal.tags ?? '[]') as string[]
  } catch {
    return []
  }
}

/** 超时或失败都算这轮没有（对应 desktop 的 Promise.allSettled + status 判断） */
function orNull<T>(work: Promise<T>, deadlineMs?: number): Promise<T | null> {
  const settled = work.catch(() => null)
  if (deadlineMs === undefined) return settled
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), deadlineMs)
    void settled.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

export interface PromptFlow {
  readonly refreshSystemPrompt: (userText?: string) => Promise<string>
  /** 启动时预热一次，实时模式下每分钟刷新；返回停止函数 */
  readonly startPreheat: () => () => void
}

export function createPromptFlow(core: ChatCore): PromptFlow {
  const refreshSystemPrompt = async (userText?: string) => {
    const cfg = core.config
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const today = new Date()
    const toHHmm = (s: string) => s.slice(11, 16)

    // 意图驱动：有 userText 按意图裁剪上下文段；无（定时/Omni 热读）则全量
    const intent = userText ? classifyIntent(userText) : null
    const wantActivity = !intent || intent.activity
    const wantBili = !intent || intent.bili
    const wantGoals = !intent || intent.goals

    const [goalsRes, perceptionSpans, activityBlocksRes, activityPaletteRes, biliSpans] = await Promise.all([
      orNull(fetchActiveGoals(), DESKTOP_CONTEXT_DEADLINE_MS),
      orNull(fetchPerceptionSpans(today), DESKTOP_CONTEXT_DEADLINE_MS),
      orNull(fetchBlocks(today)),
      orNull(fetchPalette()),
      orNull(fetchBiliSpans(today), DESKTOP_CONTEXT_DEADLINE_MS),
    ])

    const goals: GoalRecord[] = goalsRes
      ? goalsRes.map((g) => ({ title: g.title, tags: parseGoalTags(g) }))
      : []
    const perceptionData = perceptionSpans ?? []

    const todayBlocks = activityBlocksRes ?? []
    const currentPalette = activityPaletteRes ?? { categories: [], tags: [] }
    const activityTags = activityBlocksToContextRecords(todayBlocks, currentPalette, oneHourAgo, today)

    const appUsageRaw: AppUsageRecord[] = perceptionData
      // span 时间是带空格的本地时间，这种写法 ES 规范没有定义，不能直接交给 Hermes 的 Date；NaN 会把整段背景滤光
      .filter((s) => s.track === 'apps' && timestampMs(s.end_at) >= oneHourAgo)
      .map((s) => ({ startTime: toHHmm(s.start_at), endTime: toHHmm(s.end_at), appName: s.title, windowTitle: s.group_name ?? '' }))
    // 瘦身：去终端 spinner 噪音、合并连续同进程段、限量
    const appUsage = compactAppUsage(appUsageRaw)

    const biliHistory: BiliRecord[] = biliSpans
      ? biliSpans
          .filter((s) => timestampMs(s.start_at) >= oneHourAgo)
          .map((s) => ({ time: toHHmm(s.start_at), title: s.title, url: `https://www.bilibili.com/video/${s.bvid}` }))
      : []

    const staticPrompt = buildStaticPrompt(cfg.agentName, cfg.agentPersona, cfg.agentCallUser, cfg.mainQuest)
    // 按意图选择性注入；传 undefined 的段 buildDynamicContext 会自动跳过
    const dynamicContext = buildDynamicContext({
      goals: wantGoals ? goals : undefined,
      activityTags: wantActivity ? activityTags : undefined,
      appUsage: wantActivity ? appUsage : undefined,
      biliHistory: wantBili ? biliHistory : undefined,
      // 锁定卡不走意图裁剪：体量小且主人随时可能说"这张卡片"
      focusedCard: core.focusedCard ?? undefined,
    })
    core.promptParts = { staticPrompt, dynamicContext }
    core.asrVocabulary = buildAsrVocabulary({
      agentName: cfg.agentName,
      goalTitles: goals.map((g) => g.title),
      appNames: appUsage.map((a) => a.appName),
    })
    // Omni 实时会话每次都是新连接，要靠 instructions 带上动态背景和最近对话摘要；
    // 文字模式不用它（历史就在消息里），只用 promptParts
    const history = buildConversationSummary(
      core.messages.map((m) => ({ role: m.role, content: m.content || m.audio?.transcript || '' })),
    )
    const base = `${staticPrompt}\n\n${dynamicContext}`
    core.systemPrompt = history ? `${base}\n\n${history}` : base
    return core.systemPrompt
  }

  const startPreheat = () => {
    refreshSystemPrompt().catch(() => {})
    const timer = setInterval(() => {
      if (core.config.aiMode !== 'omni' || AppState.currentState !== 'active') return
      refreshSystemPrompt().catch(() => {})
    }, PREHEAT_INTERVAL_MS)
    return () => clearInterval(timer)
  }

  return { refreshSystemPrompt, startPreheat }
}
