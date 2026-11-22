// ══════════════════════════════════════════════
// 什么时候压、压完怎么接回去。desktop 与 mobile 两份逐字一致，改要两端一起改
//
//   回复结束 settle()：套上后台已写好的摘要；原图攒够一批才丢。别的不动——缓存还热，改历史就要整段重写
//          kick()  ：超门槛就在后台写摘要，主人不用等
//   发送前 beforeSend()：后台摘要在写就最多等几秒；
//                       离上一条回复超过一小时（缓存已经凉了，这次反正整段重写）：清旧工具结果、丢旧图，还超门槛就先压完再发；
//                       整段超过硬上限也必须压完再发
//   切会话 reset()：后台还没写完的作废（写完的摘要照样存进它原来的会话）
//
// 什么时候能改历史照 Claude Code 的规则（context-window.ts 文件头）。自己改了历史就告诉 cache-watch.ts，
// 免得它把这次读缓存变少当成故障。
//
// 后台写摘要期间主人可能又聊了几轮：摘要只替换当时的那段开头，之后追加的原样接在后面（applyCompaction 按 uuid 对齐）。
//
// 清掉旧工具结果、压完摘要都告诉界面，聊天底部当时的位置加一行（onToolResultsCleared / onCompacted）。
// 这两行只在界面上、不存库：清理和机械摘要只改这台设备内存里的历史，重开会话后历史从库里重建，就不作数了。
// ══════════════════════════════════════════════

import type { QueryOptions } from '../llm/api'
import { expectCacheDrop, resetCacheWatch } from '../llm/cache-watch'
import { summarizeForCompaction } from '../llm/compact'
import {
  applyCompaction,
  clearOldToolResults,
  dropOldImages,
  estimateContextTokens,
  fallbackSummaryText,
  fitSummaryInput,
  isCacheCold,
  makeCompactionResult,
  planCompaction,
  roughMessagesTokens,
  withoutSystemMessages,
  WARM_IMAGE_LIMIT,
  type ClearedToolResult,
  type CompactionResult,
  type ContextBudget,
} from '../llm/context-window'
import type { Message } from '../llm/types'

/** 连续失败几次后这个会话不再调模型写摘要，超门槛直接用机械摘要（Claude Code 也是 3 次） */
const MAX_FAILURES = 3
/** 发送时后台摘要还没写完，最多等这么久；超过就先用没压的历史发 */
const SEND_WAIT_MS = 2_500
/** 缓存凉了又超门槛时先压再发，最多等这么久；还没写完就先发，摘要写完再套上 */
const COLD_COMPACT_WAIT_MS = 45_000

export interface CompactionContext {
  readonly budget: ContextBudget
  /** 系统提示词 + 工具定义的粗估（历史里没有真实用量时加上） */
  readonly overheadTokens: number
  /** 写摘要用的请求参数：和这轮聊天同一个模型、系统提示词、工具定义 */
  readonly apiOptions: QueryOptions
  readonly agentCallUser: string
}

export interface CompactorHost {
  readonly getConversation: () => Message[]
  readonly setConversation: (history: Message[]) => void
  readonly getSessionId: () => string | null
  /** 模型写的摘要存进它所属的会话 */
  readonly persistSummary: (sessionId: string, result: CompactionResult) => void
  /**
   * 压完了（界面在分界处加一条提示，底部加一行）。sessionId 是摘要所属的会话，可能已经不是当前会话；
   * afterTokens：压完之后整段历史的体量
   */
  readonly onCompacted: (result: CompactionResult, sessionId: string | null, afterTokens: number) => void
  /**
   * 模型开始写摘要 / 写完或没写成（界面底部显示一行「正在整理」，结束时撤掉）。
   * 结束先于 onCompacted。sessionId 是发起时的会话
   */
  readonly onCompactingStart: (sessionId: string | null, beforeTokens: number) => void
  readonly onCompactingEnd: (sessionId: string | null) => void
  /** 清掉了较早的工具结果（界面底部加一行）。只发生在当前会话 */
  readonly onToolResultsCleared: (cleared: ToolResultsCleared) => void
}

export interface ToolResultsCleared {
  readonly items: readonly ClearedToolResult[]
  readonly beforeTokens: number
  readonly afterTokens: number
}

export interface Compactor {
  readonly settle: (history: readonly Message[], ctx: CompactionContext | null) => Message[]
  readonly kick: (ctx: CompactionContext) => void
  readonly beforeSend: (ctx: CompactionContext, incoming: Message) => Promise<void>
  readonly reset: () => void
  readonly isCompacting: () => boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createCompactor(host: CompactorHost): Compactor {
  let pending: Promise<CompactionResult | null> | null = null
  let latest: CompactionResult | null = null
  let failures = 0
  let generation = 0

  const overTrigger = (history: readonly Message[], ctx: CompactionContext) =>
    estimateContextTokens(history, ctx.overheadTokens) > ctx.budget.trigger

  /** 清旧工具结果，清掉了就告诉界面。只在缓存已经凉了的时候调 */
  const clearToolResults = (history: readonly Message[], ctx: CompactionContext) => {
    const cleared = clearOldToolResults(history)
    if (cleared.cleared > 0) {
      expectCacheDrop('清了较早的工具结果')
      host.onToolResultsCleared({
        items: cleared.items,
        beforeTokens: estimateContextTokens(history, ctx.overheadTokens),
        afterTokens: estimateContextTokens(cleared.messages, ctx.overheadTokens),
      })
    }
    return cleared
  }

  /** force：已经超过硬上限，模型写不成也要用机械摘要压掉 */
  const compact = (history: readonly Message[], ctx: CompactionContext, force: boolean): Promise<CompactionResult | null> => {
    const plan = planCompaction(history, ctx.budget.keepRecent)
    if (!plan) return Promise.resolve(null)
    const sessionId = host.getSessionId()
    const gen = generation
    const beforeTokens = estimateContextTokens(history, ctx.overheadTokens)
    const run = async (): Promise<CompactionResult | null> => {
      let result: CompactionResult | null = null
      if (failures < MAX_FAILURES) {
        host.onCompactingStart(sessionId, beforeTokens)
        try {
          // 缓存还热、整段也放得下：带着完整历史发，前缀和聊天请求一样，按读取价算（Claude Code 的做法）。
          // 否则只发要整理的部分，最多到门槛那么大（老会话第一次压缩时开头可能很长）
          const shareCache = !force && !isCacheCold(history) && roughMessagesTokens(plan.head) <= ctx.budget.trigger
          const text = shareCache
            ? await summarizeForCompaction(plan.head, ctx.apiOptions, ctx.agentCallUser, plan.tail)
            : await summarizeForCompaction(fitSummaryInput(plan.head, ctx.budget.trigger), ctx.apiOptions, ctx.agentCallUser)
          if (gen === generation) failures = 0
          result = makeCompactionResult(plan, text, 'model', beforeTokens)
        } catch (e) {
          if (gen === generation) failures += 1
          console.warn('[Compact] 写摘要失败', e)
        } finally {
          host.onCompactingEnd(sessionId)
        }
      }
      if (!result && (force || failures >= MAX_FAILURES)) {
        result = makeCompactionResult(plan, fallbackSummaryText(plan.head), 'fallback', beforeTokens)
      }
      if (!result) return null
      // 会话换了也存：摘要对它原来的会话照样成立，下次切回去直接用
      if (sessionId && result.kind === 'model') host.persistSummary(sessionId, result)
      if (gen !== generation) return null
      latest = result
      expectCacheDrop('较早的轮次换成了摘要')
      const applied = applyCompaction(host.getConversation(), result)
      if (applied) host.setConversation(applied)
      host.onCompacted(result, sessionId, estimateContextTokens(host.getConversation(), ctx.overheadTokens))
      return result
    }
    const promise = run().finally(() => {
      if (pending === promise) pending = null
    })
    pending = promise
    return promise
  }

  return {
    settle(history) {
      let next = withoutSystemMessages(history)
      if (latest) next = applyCompaction(next, latest) ?? next
      // 刚回复完，缓存是热的：历史只往后接。原图每次请求都要重发，攒够一批才丢（只换内容不换 uuid，后台摘要照样对得上）
      const images = dropOldImages(next, WARM_IMAGE_LIMIT)
      if (images.dropped > 0) expectCacheDrop('丢了较早的图片')
      return images.messages
    },

    kick(ctx) {
      if (pending) return
      const history = host.getConversation()
      if (overTrigger(history, ctx)) void compact(history, ctx, false)
    },

    async beforeSend(ctx, incoming) {
      if (pending) await Promise.race([pending, sleep(SEND_WAIT_MS)])
      const size = () => estimateContextTokens(host.getConversation(), ctx.overheadTokens) + roughMessagesTokens([incoming])
      // 缓存已经凉了，这次请求反正整段按写入价重写：趁现在把要重写的变小（Claude Code 的按时间清理）。
      // 后台摘要还在写就不动，等它写完自己套上
      if (!pending && isCacheCold(host.getConversation())) {
        const images = dropOldImages(host.getConversation())
        if (images.dropped > 0) expectCacheDrop('丢了较早的图片')
        const cleared = clearToolResults(images.messages, ctx)
        if (images.dropped > 0 || cleared.cleared > 0) host.setConversation(cleared.messages)
        // 还超门槛：先压完再发。不然这次把整段按写入价发一遍，回头压缩又重写一遍
        if (size() > ctx.budget.trigger) await Promise.race([compact(host.getConversation(), ctx, false), sleep(COLD_COMPACT_WAIT_MS)])
      }
      if (size() <= ctx.budget.hardLimit) return
      if (pending) await pending
      if (size() <= ctx.budget.hardLimit) return
      await compact(host.getConversation(), ctx, true)
    },

    reset() {
      generation += 1
      pending = null
      latest = null
      failures = 0
      resetCacheWatch()
    },

    isCompacting: () => pending !== null,
  }
}
