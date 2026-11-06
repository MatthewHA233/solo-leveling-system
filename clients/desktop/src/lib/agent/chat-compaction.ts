// ══════════════════════════════════════════════
// 什么时候压、压完怎么接回去。desktop 与 mobile 两份逐字一致，改要两端一起改
//
//   回复结束 settle()：套上后台已写好的摘要，只留最近几张原图；超门槛先清旧工具结果（同步，不调模型）
//          kick()  ：还超就在后台写摘要，主人不用等
//   发送前 beforeSend()：后台摘要在写就最多等几秒；整段超过硬上限就必须压完再发
//   切会话 reset()：后台还没写完的作废（写完的摘要照样存进它原来的会话）
//
// 后台写摘要期间主人可能又聊了几轮：摘要只替换当时的那段开头，之后追加的原样接在后面（applyCompaction 按 uuid 对齐）。
// ══════════════════════════════════════════════

import type { QueryOptions } from '../llm/api'
import { summarizeForCompaction } from '../llm/compact'
import {
  applyCompaction,
  clearOldToolResults,
  dropOldImages,
  estimateContextTokens,
  fallbackSummaryText,
  fitSummaryInput,
  makeCompactionResult,
  planCompaction,
  roughMessagesTokens,
  withoutSystemMessages,
  type CompactionResult,
  type ContextBudget,
} from '../llm/context-window'
import type { Message } from '../llm/types'

/** 连续失败几次后这个会话不再调模型写摘要，超门槛直接用机械摘要（Claude Code 也是 3 次） */
const MAX_FAILURES = 3
/** 发送时后台摘要还没写完，最多等这么久；超过就先用没压的历史发 */
const SEND_WAIT_MS = 2_500

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
  /** 压完了（界面加一条提示）。sessionId 是摘要所属的会话，可能已经不是当前会话 */
  readonly onCompacted: (result: CompactionResult, sessionId: string | null) => void
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
        try {
          // 交给模型的最多到门槛那么大（老会话第一次压缩时开头可能很长）
          const input = fitSummaryInput(plan.head, ctx.budget.trigger)
          const text = await summarizeForCompaction(input, ctx.apiOptions, ctx.agentCallUser)
          if (gen === generation) failures = 0
          result = makeCompactionResult(plan, text, 'model', beforeTokens)
        } catch (e) {
          if (gen === generation) failures += 1
          console.warn('[Compact] 写摘要失败', e)
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
      const applied = applyCompaction(host.getConversation(), result)
      if (applied) host.setConversation(applied)
      host.onCompacted(result, sessionId)
      return result
    }
    const promise = run().finally(() => {
      if (pending === promise) pending = null
    })
    pending = promise
    return promise
  }

  return {
    settle(history, ctx) {
      let next = withoutSystemMessages(history)
      if (latest) next = applyCompaction(next, latest) ?? next
      // 原图每次请求都要重发，不管超没超门槛都只留最近几张（只换内容不换 uuid，后台摘要照样对得上）
      next = dropOldImages(next).messages
      // 后台摘要在写：先别动开头，否则它写完对不上
      if (!ctx || pending || !overTrigger(next, ctx)) return next
      return clearOldToolResults(next).messages
    },

    kick(ctx) {
      if (pending) return
      const history = host.getConversation()
      if (overTrigger(history, ctx)) void compact(history, ctx, false)
    },

    async beforeSend(ctx, incoming) {
      if (pending) await Promise.race([pending, sleep(SEND_WAIT_MS)])
      const size = () => estimateContextTokens(host.getConversation(), ctx.overheadTokens) + roughMessagesTokens([incoming])
      if (size() <= ctx.budget.hardLimit) return
      if (pending) await pending
      if (size() <= ctx.budget.hardLimit) return
      const cleared = clearOldToolResults(host.getConversation())
      if (cleared.cleared > 0) host.setConversation(cleared.messages)
      if (size() <= ctx.budget.hardLimit) return
      await compact(host.getConversation(), ctx, true)
    },

    reset() {
      generation += 1
      pending = null
      latest = null
      failures = 0
    },

    isCompacting: () => pending !== null,
  }
}
