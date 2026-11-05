// ══════════════════════════════════════════════
// 想法卡待发送队列 — 提炼结果写到桌面端，连不上时暂存、下次补发，不丢
//
// 桌面端 App.tsx 的沉淀是「建想法卡 → 语境卡高亮绑定 → 想法卡自身绑定」连续直写本地 API。
// 手机端隔着局域网，任何一步都可能断，所以先把这几步落成一条持久化任务再发：
//   · 存在 SharedPreferences（设备本地，不走同步）；任务量小，不值得为它建表
//   · 每写成一步就落盘进度，重试时不会重复建卡
//   · 请求发出后才断的（响应丢了，桌面端可能已写入）标记 uncertain，重试前先查重
//   · 想法卡带上说话时刻作为 created_at，补发的卡在语境流里仍排在原来的时间
// ══════════════════════════════════════════════

import { AppState, DeviceEventEmitter } from 'react-native'
import { solevupGetPref, solevupSetPref } from '../solevupdb'
import { subscribeSyncStatus } from '../syncserver'
import {
  addBinding,
  addContextCard,
  fetchCardBindings,
  fetchContextFeed,
  isDesktopUnreachable,
  type AnchorCategory,
} from '../desktop-api'
import type { DistilledThought } from './thought-distill'
import type { ContextAnchorResult } from './anchor-to-context'
import { locateSegment } from './segment-locate'

const PREF_KEY = 'distill.outbox.v1'

/** 对应 desktop 的 solevup:context-updated：想法卡写进桌面端后发出，语境相关界面据此重拉 */
export const CONTEXT_UPDATED_EVENT = 'solevup:context-updated'

interface BindingDraft {
  /** null = 绑到本任务的想法卡自身；否则是语境卡 id */
  cardId: string | null
  startPos: number
  endPos: number
  selectedText: string
  userSpeech: string
  anchors: Array<{ keyword: string; category: AnchorCategory }>
  /** true = 语境卡上的同源绑定，source_card_id 指向本任务的想法卡（删想法卡时级联） */
  derived: boolean
}

interface OutboxJob {
  /** 说话时刻，传给桌面端作为想法卡 created_at，同时是查重依据 */
  createdAt: string
  cardText: string
  sourceLabel: string | null
  sourceCardId: string | null
  /** 桌面端返回的想法卡 id；有值说明建卡这步已完成 */
  thoughtId: string | null
  /** 还没写成的绑定，按桌面端的先后顺序，写成一条移除一条 */
  bindings: BindingDraft[]
  lastError: string | null
  uncertain: boolean
}

export interface OutboxSubmitResult {
  /** true = 已写进桌面端；false = 桌面端连不上或拒绝，留在队列里等补发 */
  delivered: boolean
  /** 语境卡上定位到了原文片段（要建高亮）；独立想法卡恒为 false */
  highlighted: boolean
}

export interface OutboxFlushResult {
  sent: number
  remaining: number
}

// ── 持久化 ──

let jobs: OutboxJob[] | null = null
let loading: Promise<OutboxJob[]> | null = null
let writeChain: Promise<unknown> = Promise.resolve()

function loadJobs(): Promise<OutboxJob[]> {
  if (jobs) return Promise.resolve(jobs)
  if (!loading) {
    loading = solevupGetPref(PREF_KEY, '[]')
      .then((raw) => {
        let parsed: OutboxJob[] = []
        try {
          const value = JSON.parse(raw) as unknown
          if (Array.isArray(value)) parsed = value as OutboxJob[]
        } catch (e) {
          console.warn('[Outbox] 队列数据损坏，已清空', e)
        }
        jobs = parsed
        return parsed
      })
      .finally(() => {
        loading = null
      })
  }
  return loading
}

/** 按调用顺序串行写，快照在调用时取，保证后写的一定是更新的状态 */
function saveJobs(): Promise<void> {
  const snapshot = JSON.stringify(jobs ?? [])
  const write = writeChain
    .then(() => solevupSetPref(PREF_KEY, snapshot))
    .then((ok) => {
      if (!ok) console.warn('[Outbox] 本机存储不可用，队列只在内存里，重启会丢')
    })
    .catch((e) => console.warn('[Outbox] 队列写入失败', e))
  writeChain = write
  return write
}

// ── 投递 ──

async function findDeliveredCard(job: OutboxJob): Promise<string | null> {
  const feed = await fetchContextFeed()
  const hit = feed.find((c) => c.kind === 'thought' && c.created_at === job.createdAt && c.text === job.cardText)
  return hit?.id ?? null
}

async function hasBinding(cardId: string, draft: BindingDraft): Promise<boolean> {
  const existing = await fetchCardBindings(cardId)
  return existing.some((b) =>
    b.start_pos === draft.startPos
    && b.end_pos === draft.endPos
    && b.selected_text === draft.selectedText
    && b.user_speech === draft.userSpeech)
}

async function deliver(job: OutboxJob): Promise<void> {
  if (!job.thoughtId) {
    const existing = job.uncertain ? await findDeliveredCard(job) : null
    job.thoughtId = existing ?? await addContextCard(
      job.cardText,
      job.sourceLabel ?? undefined,
      job.createdAt,
      job.sourceCardId ?? undefined,
    )
    job.uncertain = false
    await saveJobs()
  }
  const thoughtId = job.thoughtId

  while (job.bindings.length > 0) {
    const draft = job.bindings[0]
    const cardId = draft.cardId ?? thoughtId
    const alreadyThere = job.uncertain && await hasBinding(cardId, draft)
    if (!alreadyThere) {
      await addBinding({
        card_id: cardId,
        start_pos: draft.startPos,
        end_pos: draft.endPos,
        selected_text: draft.selectedText,
        user_speech: draft.userSpeech,
        anchors: draft.anchors,
        ...(draft.derived && { source_card_id: thoughtId }),
      })
    }
    job.uncertain = false
    job.bindings.shift()
    await saveJobs()
  }
}

async function runFlush(): Promise<OutboxFlushResult> {
  const queue = await loadJobs()
  let sent = 0
  for (const job of [...queue]) {
    try {
      await deliver(job)
      queue.splice(queue.indexOf(job), 1)
      await saveJobs()
      sent += 1
    } catch (e) {
      job.lastError = e instanceof Error ? e.message : String(e)
      if (isDesktopUnreachable(e)) {
        // 连不上就停，后面的也不用试
        if (e.requestSent) job.uncertain = true
        await saveJobs()
        break
      }
      // 桌面端明确拒绝的只留下这一条，不挡后面的任务
      console.warn('[Outbox] 桌面端拒绝写入，留在队列里', job.lastError)
      await saveJobs()
    }
  }
  if (sent > 0) DeviceEventEmitter.emit(CONTEXT_UPDATED_EVENT)
  return { sent, remaining: queue.length }
}

let flushing: Promise<OutboxFlushResult> | null = null
let rerun = false

/** 补发队列。同一时刻只跑一轮，期间新来的请求合并成再跑一轮。不抛错，结果看返回值。 */
export function flushThoughtOutbox(): Promise<OutboxFlushResult> {
  if (flushing) {
    rerun = true
    return flushing
  }
  flushing = (async () => {
    let sent = 0
    let remaining = 0
    try {
      do {
        rerun = false
        const r = await runFlush()
        sent += r.sent
        remaining = r.remaining
      } while (rerun)
    } catch (e) {
      console.warn('[Outbox] 补发失败', e)
      remaining = jobs?.length ?? 0
    } finally {
      flushing = null
    }
    return { sent, remaining }
  })()
  return flushing
}

/**
 * 启动补发：立刻试一轮，之后每次同步成功（说明桌面端在线）和回到前台时再试。
 * App 启动时调一次，返回值用于解除监听。
 */
export function startThoughtOutbox(): () => void {
  void flushThoughtOutbox()
  const unsubscribeSync = subscribeSyncStatus((event) => {
    if (!event.syncing && event.ok) void flushThoughtOutbox()
  })
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') void flushThoughtOutbox()
  })
  return () => {
    unsubscribeSync()
    appState.remove()
  }
}

export async function getThoughtOutboxStatus(): Promise<{ pending: number; lastError: string | null }> {
  const queue = await loadJobs()
  const failed = queue.find((j) => j.lastError)
  return { pending: queue.length, lastError: failed?.lastError ?? null }
}

// ── 提交（对应 desktop App.tsx handleSend 的两条沉淀分支）──

async function enqueueAndFlush(
  cardText: string,
  sourceLabel: string | null,
  sourceCardId: string | null,
  bindings: BindingDraft[],
): Promise<boolean> {
  const queue = await loadJobs()
  const job: OutboxJob = {
    createdAt: new Date().toISOString(),
    cardText,
    sourceLabel,
    sourceCardId,
    thoughtId: null,
    bindings,
    lastError: null,
    uncertain: false,
  }
  queue.push(job)
  await saveJobs()
  await flushThoughtOutbox()
  return !queue.includes(job)
}

/** 日常聊天 → 独立想法卡 + 整卡绑定 */
export async function submitDistilledThought(speech: string, distilled: DistilledThought): Promise<OutboxSubmitResult> {
  const delivered = await enqueueAndFlush(distilled.cardText, null, null, [{
    cardId: null,
    startPos: 0,
    endPos: distilled.cardText.length,
    selectedText: distilled.cardText,
    userSpeech: speech,
    anchors: distilled.anchors,
    derived: false,
  }])
  return { delivered, highlighted: false }
}

/**
 * 对着语境卡聊天 → 想法卡（绑定语境来源：完整标题入标签，cardId 入 source_card_id 供点击跳转）
 * + 语境卡上的高亮绑定（定位得到原文片段时）+ 想法卡自身绑定。
 * target.text 是语境全文，只在这里用来定位，不进队列。
 */
export async function submitContextAnchor(
  target: { cardId: string; text: string; title: string },
  result: ContextAnchorResult,
): Promise<OutboxSubmitResult> {
  const bindings: BindingDraft[] = []
  let highlighted = false
  // 模型复制常悄悄改标点/空白，用归一化模糊定位代替裸 indexOf；
  // selected_text 取原文切片（位置坐标是原文的，不能存模型副本）
  if (result.segment) {
    const span = locateSegment(target.text, result.segment)
    if (span) {
      bindings.push({
        cardId: target.cardId,
        startPos: span.start,
        endPos: span.end,
        selectedText: target.text.slice(span.start, span.end),
        userSpeech: result.thought,
        anchors: result.anchors,
        derived: true,
      })
      highlighted = true
    } else {
      console.warn('[Anchor] 原文片段定位失败，语境卡上不建高亮（想法卡照常）。模型给的片段：', result.segment.slice(0, 120))
    }
  }
  // 想法卡本身也挂锚点（标签）
  bindings.push({
    cardId: null,
    startPos: 0,
    endPos: result.thought.length,
    selectedText: result.thought,
    userSpeech: result.thought,
    anchors: result.anchors,
    derived: false,
  })
  const delivered = await enqueueAndFlush(result.thought, `语境·${target.title}`, target.cardId, bindings)
  return { delivered, highlighted }
}
