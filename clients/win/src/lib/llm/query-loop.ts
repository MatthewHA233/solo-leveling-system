// ══════════════════════════════════════════════
// queryLoop — 对话主循环
// 精简移植自 Claude Code query.ts
//
// 原版：1729行，含 tools/compact/stop_hooks/taskBudget/permission
// 我们的版本：核心 ReAct 循环 + transition 无限循环防护
//
// 关键移植点（来自原版 queryLoop）：
// 1. State 类型含 transition 字段（不是输出，是为什么继续循环的原因）
// 2. taskBudget 是 loop-local 变量不在 State 上（避免状态空间爆炸）
//    → 我们简化版无 taskBudget，但保留此设计理念（maxIterations 同理）
// 3. 每个 continue 前更新 transition，下一轮检查是否重复
// ══════════════════════════════════════════════

import { queryModel } from './api'
import { withRetry } from './retry'
import {
  createUserMessage,
  createSystemMessage,
  getMessageText,
} from './types'
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ContentBlock,
  StopReason,
} from './types'
import type { QueryOptions } from './api'

// ── 工具调用接口（与 OpenAI 格式对齐） ──

export interface ToolCall {
  id: string
  name: string
  arguments: string   // JSON string
}

export interface ToolResult {
  toolCallId: string
  name: string
  result: string
}

// ── 事件（供 UI 消费） ──

export type QueryEvent =
  | { type: 'textDelta'; delta: string; messageId: string }
  | { type: 'toolCallStarted'; call: ToolCall }
  | { type: 'toolCallDone'; call: ToolCall; result: string }
  | { type: 'turnComplete'; stopReason: StopReason }
  | { type: 'error'; message: string }

// ── 查询参数 ──

export interface QueryParams {
  messages: Message[]
  systemPrompt?: string
  apiOptions: QueryOptions
  maxIterations?: number    // 默认 8（对应 agent-loop.ts 的 maxIterations）
  onEvent?: (event: QueryEvent) => void
  executeTool?: (call: ToolCall) => Promise<string>
}

// ── queryLoop 内部 State ──
//
// 注意：transition 字段是防无限循环机制，不是输出字段
// 类比 Claude Code query.ts:
//   "Why the previous iteration continued. Undefined on first iteration."
//   "Lets tests assert recovery paths fired without inspecting message contents."

type TransitionReason = 'initial' | 'next_turn' | 'completed'

type Continue = { reason: TransitionReason }

type State = {
  readonly messages: Message[]
  readonly transition: Continue | undefined
  readonly turnCount: number
}

// ── 主函数 ──

/**
 * 运行对话主循环，返回更新后的消息列表。
 *
 * Loop 结构（对应 Claude Code queryLoop while(true)）：
 *   1. API 调用 → stream 消费（文本 + 工具调用）
 *   2. 保存 AssistantMessage
 *   3. 无工具调用 → 退出
 *   4. 执行工具 → 保存 tool result 消息
 *   5. 更新 state（transition = 'next_turn'） → continue
 *
 * 无限循环防护：
 *   - maxIterations 硬限制（原版 maxTurns 参数）
 *   - transition 检查（原版 collapse_drain_retry 检测）
 *     → 连续2次同一 reason 且不是 next_turn，中止
 */
export async function runQueryLoop(params: QueryParams): Promise<Message[]> {
  const {
    systemPrompt,
    apiOptions,
    maxIterations = 8,
    onEvent,
    executeTool,
  } = params

  // Loop-local（不在 State 上，和 taskBudget 的设计理念相同：
  // 如果放在 State 上每个不同值都是不同状态，状态空间爆炸）
  const assistantMsgId = crypto.randomUUID()

  let state: State = {
    messages: [...params.messages],
    transition: undefined,
    turnCount: 0,
  }

  while (true) {
    const { messages, transition, turnCount } = state

    // ── 硬上限（原版 maxTurns 检查） ──
    if (turnCount >= maxIterations) {
      onEvent?.({
        type: 'error',
        message: `已达到最大迭代次数（${maxIterations}）`,
      })
      break
    }

    // ── transition 无限循环防护 ──
    // 对应 Claude Code 中 transition?.reason !== 'collapse_drain_retry' 的检测
    // 我们的简化：连续2次同一 non-initial reason 且不是正常 next_turn → 中止
    if (
      transition?.reason !== undefined &&
      transition.reason !== 'next_turn' &&
      transition.reason !== 'initial'
    ) {
      onEvent?.({ type: 'error', message: `检测到异常循环：${transition.reason}` })
      break
    }

    // ── API 调用 ──
    let accText = ''
    const pendingCalls = new Map<number, { id: string; name: string; args: string }>()
    let stopReason: StopReason = 'end_turn'
    let apiError: string | null = null
    const currentMsgId = turnCount === 0 ? assistantMsgId : crypto.randomUUID()

    try {
      const stream = queryModel(messages, {
        ...apiOptions,
        systemPrompt,
        _iteration: turnCount,
      })

      // Stream 消费（对应 Claude Code 中的 for await (const part of streamResponse)）
      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'textDelta':
            accText += chunk.delta
            onEvent?.({ type: 'textDelta', delta: chunk.delta, messageId: currentMsgId })
            break

          case 'toolCallDelta': {
            const existing = pendingCalls.get(chunk.index)
            if (!existing) {
              pendingCalls.set(chunk.index, {
                id: chunk.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
                name: chunk.name ?? '',
                args: '',
              })
            }
            const entry = pendingCalls.get(chunk.index)!
            if (chunk.id) entry.id = chunk.id
            if (chunk.name) entry.name = chunk.name
            if (chunk.argsDelta) entry.args += chunk.argsDelta
            break
          }

          case 'done':
            stopReason = (chunk.stopReason as StopReason) ?? 'end_turn'
            break

          case 'error':
            apiError = chunk.message
            break
        }
      }
    } catch (err) {
      apiError = err instanceof Error ? err.message : String(err)
    }

    if (apiError) {
      onEvent?.({ type: 'error', message: apiError })
      return [...messages, createSystemMessage(apiError, 'error')]
    }

    // ── 构建 AssistantMessage ──
    const toolCalls: ToolCall[] = [...pendingCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id || `call_${crypto.randomUUID().slice(0, 8)}`,
        name: v.name,
        arguments: v.args,
      }))

    // 构建 content blocks：文本 + tool_use（OpenAI 要求 assistant 消息含 tool_use blocks）
    const contentBlocks: ContentBlock[] = []
    if (accText) contentBlocks.push({ type: 'text', text: accText })
    for (const call of toolCalls) {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(call.arguments || '{}') } catch { /* ignore */ }
      contentBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input })
    }

    const assistantMsg: AssistantMessage = {
      type: 'assistant',
      uuid: currentMsgId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
        stop_reason: stopReason as StopReason,
        usage: { input_tokens: 0, output_tokens: 0 },
        model: '',
      },
    }

    const newMessages: Message[] = [...messages, assistantMsg]

    // ── 无工具调用 → 本次对话完成 ──
    if (toolCalls.length === 0 || stopReason === 'stop_sequence') {
      onEvent?.({ type: 'turnComplete', stopReason })
      return newMessages
    }

    // ── 无工具执行器 → 也退出（不能继续循环） ──
    if (!executeTool) {
      onEvent?.({ type: 'turnComplete', stopReason })
      return newMessages
    }

    // ── 执行工具调用（对应 Claude Code toolOrchestration） ──
    const toolResultMessages: UserMessage[] = []

    for (const call of toolCalls) {
      onEvent?.({ type: 'toolCallStarted', call })

      let result: string
      try {
        result = await executeTool(call)
      } catch (err) {
        result = `工具执行错误: ${err instanceof Error ? err.message : String(err)}`
      }

      onEvent?.({ type: 'toolCallDone', call, result })

      // tool result 作为 user message（OpenAI 格式：role='tool', tool_call_id=call.id）
      const toolResultMsg: UserMessage = {
        type: 'user',
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: result,
        },
        toolUseResult: result,
        sourceToolCallId: call.id,
      }

      toolResultMessages.push(toolResultMsg)
    }

    // ── 更新 State → 下一轮（对应 Claude Code L1715-1727 的 state = next; continue） ──
    state = {
      messages: [...newMessages, ...toolResultMessages],
      transition: { reason: 'next_turn' },
      turnCount: turnCount + 1,
    }
    // 继续循环（while(true) 的 continue 是隐式的，直接进入下一轮）
  }

  return state.messages
}

// ── 便捷函数（供 App.tsx 直接调用，替换 runAgentLoop） ──

export interface SimpleQueryResult {
  messages: Message[]
  finalText: string
}

/**
 * 单次对话（无工具调用），返回最终文本。
 * 适合大多数聊天场景。
 */
export async function runSimpleQuery(
  userInput: string,
  conversationHistory: Message[],
  options: QueryOptions & { systemPrompt?: string },
  onTextDelta?: (delta: string, messageId: string) => void,
): Promise<SimpleQueryResult> {
  const userMsg = createUserMessage(userInput)
  const messages: Message[] = [...conversationHistory, userMsg]

  const result = await withRetry(
    () =>
      runQueryLoop({
        messages,
        systemPrompt: options.systemPrompt,
        apiOptions: options,
        maxIterations: 1,  // 简单聊天不需要工具循环
        onEvent: (event) => {
          if (event.type === 'textDelta' && onTextDelta) {
            onTextDelta(event.delta, event.messageId)
          }
        },
      }),
    3,  // 最多重试3次
    options.signal,
  )

  const lastAssistant = result.filter(
    (m): m is AssistantMessage => m.type === 'assistant',
  ).at(-1)

  const finalText = lastAssistant ? getMessageText(lastAssistant) : ''

  return { messages: result, finalText }
}
