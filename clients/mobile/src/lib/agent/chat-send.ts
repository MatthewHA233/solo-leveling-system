// ══════════════════════════════════════════════
// 发送主流程（对应 desktop App.tsx handleSend）
// 打字和语音（级联）都走这里：同一个主循环、同一个 Fairy（一个大脑）。
// 实时（实验）语音模式的回复另走 Omni WS（chat-omni.ts），不经过这里。
//
// 和桌面端的差异：
//   · 用户这句发出就落库，回复在模型结束时落库，音频到手后再补 audioPath：
//     手机进程随时可能被系统杀掉，桌面端等朗读播完才一起写，杀进程就全丢了
//   · 打断控制在取数之前就挂上：手机取数要走局域网，这段时间也要能打断
//   · 新一轮先打断上一轮并等它收尾（最多 1.5 秒），否则对话历史会缺上一轮
//   · 没有 Key 时给明确提示（只有 Claude Key 的不拦），桌面端是等接口报 401
//   · TTS 管线在 voice/tts-pipeline.ts（桌面端写在 handleSend 里）
//   · 一轮里调了工具：工具前说的话一个气泡，工具后的回复另起一个排在工具行下面。
//     桌面端续写在同一个气泡里；手机面板矮又贴着底部，续写的字在工具行上方看不到，像是说了两句就断了
// ══════════════════════════════════════════════

import { isAnthropicModel, usesTurnReminder } from '../llm/anthropic-stream'
import type { ApiRequestSnapshot, ModelCallLog } from '../llm/api'
import { contextBudget, roughTokens, turnReminderText, withSystemReminder } from '../llm/context-window'
import { runQueryLoop } from '../llm/query-loop'
import { createUserMessage, getMessageText, isAssistantMessage, userContentWithImages, type Message } from '../llm/types'
import { randomUUID } from '../llm/uuid'
import type { PickedImage } from '../chatimage'
import { explainProxyFailure } from '../network'
import { getFeatureModel, sumModelCalls } from '../models/model-audit'
import { getModelDef, modelSeesImages } from '../models/registry'
import { solevupGetActiveModelApiKey } from '../solevupdb'
import { createReplyTts, resolveFishApiKey, saveAudioFile, type ReplyTts } from '../voice'
import { waveformFromWavBase64 } from '../../components/fairy/fairy-format'
import { getDashScopeApiKey } from './agent-config'
import type { SessionMessage } from './agent-memory'
import type { CompactionContext } from './chat-compaction'
import { runThoughtDistill } from './chat-distill'
import { taskNoticeLabel, taskNoticeRow, toolTraceRow } from './chat-history'
import { drainQueue, enqueuePrompt, subscribeQueue, takeNextBatch, taskNoticeForModel, type QueuedMessage } from './message-queue'
import { startToolCall } from './tool-call-view'
import { withImageMarker } from './chat-images'
import type { ChatMessage } from '../../types'
import type { ChatCore } from './chat-core'
import type { PromptFlow } from './chat-prompt'
import { makeSessionMessage, type SessionFlow } from './chat-sessions'
import { executeAgentTool, TOOL_DEFINITIONS } from './tools'

const NO_KEY_NOTE = '未配置 API Key — 与电脑同步一次，或在「模型」里填入'
const PREVIOUS_TURN_WAIT_MS = 1500

function lastReplyText(history: readonly Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (isAssistantMessage(m)) return getMessageText(m)
  }
  return ''
}

// userTimestamp：语音那句落库的时间，发给模型的那条用同一个时间（压缩按时间在库里找分界）
/** Fairy 读到排队的那句了：去掉「排队中」，挪到对话末尾（它在历史里就是这个位置） */
function settleQueuedBubble(messages: readonly ChatMessage[], timestamp: string): ChatMessage[] {
  const hit = messages.find((m) => m.queued && m.role === 'user' && m.timestamp === timestamp)
  if (!hit) return [...messages]
  return [...messages.filter((m) => m !== hit), { ...hit, queued: false }]
}

/** 这一轮是谁发起的（默认 = 主人刚打的字或说的话） */
export interface TurnSource {
  /** 主人的话排过队：气泡和落库在入队时已经做了 */
  readonly preShown?: boolean
  /** 这一轮由后台通知发起 */
  readonly notices?: readonly QueuedMessage[]
}

export type HandleSend = (
  text: string, fromVoice?: boolean, images?: readonly PickedImage[], userTimestamp?: string, turn?: TurnSource,
) => Promise<void>

export interface QueueFlow {
  /** 主人打字发送：模型正在回复就排队，否则直接起一轮 */
  readonly submitTyped: (text: string, images?: readonly PickedImage[]) => Promise<void>
}

/**
 * 消息队列接到发送流程上（规则见 message-queue.ts，和 desktop App.tsx 的 submitTyped / pumpQueue 一致）。
 * 回复已经出完、只是还在朗读时不排队：handleSend 会停掉朗读起新的一轮。
 */
export function createQueueFlow(core: ChatCore, sessions: SessionFlow, handleSend: HandleSend): QueueFlow {
  const submitTyped: QueueFlow['submitTyped'] = (text, images = []) => {
    if (!text.trim() && images.length === 0) return Promise.resolve()
    if (core.busyTurn === 0) return handleSend(text, false, images)
    const sentAt = new Date().toISOString()
    const userRow = { ...makeSessionMessage('user', withImageMarker(text.trim(), images.map((i) => i.id))), timestamp: sentAt }
    sessions.titleFlow.onUserMessage(text || '发了图片')
    core.setMessages((prev) => [...prev, {
      id: userRow.id!, role: 'user', content: text, timestamp: sentAt, queued: true,
      ...(images.length > 0 ? { images: images.map(({ id, uri }) => ({ id, uri })) } : {}),
    }])
    sessions.persistRows(core.sessionId, [userRow]).catch((e) => console.warn('[Chat] 用户消息写入失败', e))
    enqueuePrompt(text.trim(), sentAt, images)
    return Promise.resolve()
  }

  // 空闲时取队列起新的一轮：主人排着的话先说，后台通知排在后面
  const pump = () => {
    if (core.busyTurn !== 0 || core.isProcessing) return
    const batch = takeNextBatch()
    if (batch.length === 0) return
    if (batch[0].mode === 'task-notification') {
      void handleSend(taskNoticeForModel(batch.map((q) => q.text).join('\n')), false, [], undefined, { notices: batch })
    } else {
      core.setMessages((prev) => batch.reduce((list, q) => settleQueuedBubble(list, q.timestamp), [...prev]))
      const images = batch.flatMap((q) => (q.images ?? []) as PickedImage[])
      void handleSend(batch.map((q) => q.text).join('\n\n'), false, images, batch[0].timestamp, { preShown: true })
    }
  }
  core.onTurnIdle = pump
  subscribeQueue(pump)

  return { submitTyped }
}

export function createSendFlow(core: ChatCore, sessions: SessionFlow, prompt: PromptFlow): HandleSend {
  return async function handleSend(text, fromVoice = false, images = [], userTimestamp, turn = {}) {
    if (!text.trim() && images.length === 0) return
    // 主人刚打的字：要显示气泡、落库、计进标题。排过队的话已经做过了；通知不是主人说的
    const typed = !fromVoice && !turn.preShown && !turn.notices
    // 主人这句的时间：气泡、落库的那行、发给模型的那条用同一个
    const sentAt = userTimestamp ?? new Date().toISOString()

    // 发送中再发送：先停掉上一轮
    core.replyControl?.interrupt()
    core.replyControl = null
    const previousTurn = core.turnSettled
    let settle: () => void = () => {}
    core.turnSettled = new Promise((resolve) => { settle = resolve })

    // 语音那句在转写定稿时已经数过（onTranscript），这里只数打字
    if (typed) sessions.titleFlow.onUserMessage(text || '发了图片')

    const turnSid = core.sessionId

    // 后台通知：显示成一行提示并落库
    const showNotice = (q: QueuedMessage) => {
      core.addSystemNote(taskNoticeLabel(q.text))
      const row = { ...taskNoticeRow(q.text, new Date().toISOString()), id: randomUUID() }
      sessions.persistRows(turnSid, [row]).catch((e) => console.warn('[Chat] 后台通知写入失败', e))
    }
    for (const q of turn.notices ?? []) showNotice(q)

    // 文字输入：添加用户气泡并落库（语音输入的气泡和落库在 chat-voice 的 onUserAudio / onTranscript）
    if (typed) {
      const userRow = { ...makeSessionMessage('user', withImageMarker(text.trim(), images.map((i) => i.id))), timestamp: sentAt }
      core.setMessages((prev) => [...prev, {
        id: userRow.id!, role: 'user', content: text, timestamp: userRow.timestamp,
        ...(images.length > 0 ? { images: images.map(({ id, uri }) => ({ id, uri })) } : {}),
      }])
      sessions.persistRows(turnSid, [userRow]).catch((e) => console.warn('[Chat] 用户消息写入失败', e))
    }

    // 本轮回复的轮次号：被打断的轮次收尾时不再动 Fairy 状态和「处理中」标志，免得盖掉新一轮
    const turnId = ++core.replyTurn
    let interrupted = false
    const ownsUi = () => core.replyTurn === turnId && !interrupted
    core.busyTurn = turnId
    const releaseBusy = () => { if (core.busyTurn === turnId) core.busyTurn = 0 }
    core.setProcessing(true)
    core.emitFairy('thinking')

    // ── 打断：主人开口、再次发送、切会话时停掉本轮的生成与朗读 ──
    const abort = new AbortController()
    let tts: ReplyTts | null = null
    core.replyControl = {
      interrupt: () => {
        if (interrupted) return
        interrupted = true
        releaseBusy()
        abort.abort()
        tts?.interrupt()
        core.setProcessing(false)
      },
    }

    const agentMsgId = randomUUID()
    /** 工具前那段话换下来的 id：最后一段没有字时，快照挂到它上面 */
    let earlierSegmentId: string | null = null
    const lastSegmentId = () => (core.messages.some((m) => m.id === agentMsgId) ? agentMsgId : earlierSegmentId ?? agentMsgId)
    let agentTimestamp = ''
    const imageBlocks = images.map((i) => i.block)
    const userMsg = createUserMessage(text, { images: imageBlocks, timestamp: sentAt })
    const capturedSnapshots: ApiRequestSnapshot[] = []
    let capturedUsage: ModelCallLog | null = null
    let capturedReasoning = ''   // 思考模型的推演流（随消息一起持久化，回看用）
    let assistantRow: SessionMessage | null = null

    const bubbleTimestamp = () => {
      if (!agentTimestamp) agentTimestamp = new Date().toISOString()
      return agentTimestamp
    }

    try {
      // 上一轮还在收尾（工具没跑完等）就等一下，超时也继续：那一轮的内容已入库，只是这轮历史里没有
      await Promise.race([
        previousTurn,
        new Promise<void>((resolve) => setTimeout(resolve, PREVIOUS_TURN_WAIT_MS)),
      ])
      const config = await core.refreshConfig()

      // D2 + D4 — 刷新提示词各段（静态段 + 本轮实时背景，缓存在 promptParts）
      const systemPrompt = await prompt.refreshSystemPrompt(text)

      const chatModel = await getFeatureModel('fairy_chat', config.openaiCardModel || 'qwen3.6-flash')
      const synced = await solevupGetActiveModelApiKey().catch(() => null)
      const dashscopeApiKey = synced?.apiKey || getDashScopeApiKey(config) || ''
      if (!dashscopeApiKey && !isAnthropicModel(chatModel)) {
        core.addSystemNote(NO_KEY_NOTE)
        if (ownsUi()) core.emitFairy('idle')
        return
      }

      // ── TTS 流式管线（与 LLM 并行启动）──
      // 用语音问的，就用语音答；打字的按「语音播报」开关
      if ((config.ttsEnabled || fromVoice) && !interrupted) {
        const fishApiKey = await resolveFishApiKey()
        if (fishApiKey && !interrupted) {
          try {
            tts = createReplyTts(
              { apiKey: fishApiKey, referenceId: config.fishReferenceId, model: config.fishModel },
              (reason) => core.addSystemNote(`语音播报连不上，这轮只有文字：${explainProxyFailure(reason) ?? reason}`),
            )
          } catch (e) {
            console.warn('[Chat] TTS 不可用', e)
          }
        }
      }

      // 本轮实时背景。Claude 的新模型：单独发成只在当轮有效的 system 消息（turnReminder），留在历史里不删，缓存前缀一直不变。
      // 别的模型：拼在发给模型的这条消息前面，存进历史的是不带背景的原话
      const { staticPrompt, dynamicContext } = core.promptParts
      const turnReminder = usesTurnReminder(chatModel) ? turnReminderText(dynamicContext) : undefined
      const apiUserMsg = turnReminder
        ? { ...userMsg, turnReminder }
        : {
            ...userMsg,
            message: { ...userMsg.message, content: userContentWithImages(withSystemReminder(text, dynamicContext), imageBlocks) },
          }

      // 压缩用的参数：门槛按这个模型算；写摘要和这轮聊天同一个模型、系统提示词、工具定义（好吃缓存）
      const chatSystemPrompt = staticPrompt || systemPrompt
      core.contextBudget = contextBudget(getModelDef(chatModel))
      core.contextOverhead = roughTokens(chatSystemPrompt) + roughTokens(JSON.stringify(TOOL_DEFINITIONS))
      const compactCtx: CompactionContext = {
        budget: core.contextBudget,
        overheadTokens: core.contextOverhead,
        apiOptions: {
          apiKey: dashscopeApiKey,
          apiBase: config.openaiApiBase,
          model: chatModel,
          systemPrompt: chatSystemPrompt,
          hideImages: !modelSeesImages(chatModel),
          feature: 'fairy_chat',
          tools: TOOL_DEFINITIONS,
        },
        agentCallUser: config.agentCallUser,
      }
      // 整段已经超过硬上限就先压完再发；后台摘要还在写就等它几秒（切走了就不动别的会话的历史）
      if (sessions.follow(turnSid) === core.sessionId) await core.compactor?.beforeSend(compactCtx, apiUserMsg)

      // 被打断的旧轮可能比新轮晚走到这里（取数慢、新轮等超时先走了）：不能把归属改回去，否则新轮的历史写不进来
      core.conversationOwner = Math.max(core.conversationOwner, turnId)
      const sentHistory = [...core.conversation, apiUserMsg]
      const newHistory = await runQueryLoop({
        messages: sentHistory,
        systemPrompt: chatSystemPrompt,
        turnReminder,
        apiOptions: {
          apiKey: dashscopeApiKey,
          apiBase: config.openaiApiBase,
          model: chatModel,
          hideImages: !modelSeesImages(chatModel),
          feature: 'fairy_chat',
          maxTokens: 8000,
          tools: TOOL_DEFINITIONS,
          signal: abort.signal,
          onRequestSnapshot: (snap) => capturedSnapshots.push(snap),
          onUsageLogged: (call) => {
            // 一句话可能发好几次请求：气泡上显示这一轮的合计
            const turnUsage = sumModelCalls(capturedUsage, call)
            capturedUsage = turnUsage
            core.patchMessage(agentMsgId, (m) => ({ ...m, usage: turnUsage }))
            // 用量可能比回复入库晚到：入库后再补上
            if (assistantRow) {
              assistantRow = { ...assistantRow, usage: turnUsage }
              sessions.persistRows(turnSid, [assistantRow]).catch(() => {})
            }
          },
        },
        maxIterations: 8,
        onEvent: (event) => {
          if (event.type !== 'textDelta' && event.type !== 'reasoningDelta') console.log('[QueryLoop]', event.type)
          if (event.type === 'reasoningDelta') {
            // 思考流：累积到气泡的 reasoning 字段（不进 TTS、不进对话历史，但随消息持久化）
            capturedReasoning += event.delta
            core.upsertStreaming(
              agentMsgId,
              (m) => ({ ...m, reasoning: (m.reasoning ?? '') + event.delta }),
              () => ({
                id: agentMsgId, role: 'agent', streaming: true,
                content: '', reasoning: event.delta, timestamp: bubbleTimestamp(),
              }),
            )
          } else if (event.type === 'textDelta') {
            core.upsertStreaming(
              agentMsgId,
              (m) => ({ ...m, content: m.content + event.delta }),
              () => ({
                id: agentMsgId, role: 'agent', streaming: true,
                content: event.delta, timestamp: bubbleTimestamp(),
              }),
            )
            tts?.push(event.delta)
          } else if (event.type === 'toolCallStarted') {
            // 工具前说的话自成一条，之后的回复另起一条排在工具行下面（agentMsgId 留给最后那段，落库、补录音都认它）
            if (core.messages.some((m) => m.id === agentMsgId)) {
              const doneId = randomUUID()
              earlierSegmentId = doneId
              agentTimestamp = '' // 后一段按它开口的时间算，跳转按时间找气泡时不会和前一段撞上
              core.setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, id: doneId, streaming: false } : m)))
            }
            // 工具调用开始：立即把积压的文字刷给 TTS（否则工具执行期间静音）
            tts?.push('', true)
            if (ownsUi()) core.emitFairy('thinking')
            core.addToolCall(startToolCall(event.call.id, event.call.name, event.call.arguments))
          } else if (event.type === 'toolCallDone') {
            // 工具完成：结果记到对应的那一行上
            if (ownsUi()) core.emitFairy('thinking')
            core.finishToolCall(event.call.id, event.result)
          } else if (event.type === 'error') {
            if (interrupted) return // 主人打断导致的中止，不算错误
            // API 错误（工具调用后的第二次请求失败是常见原因）→ 直接显示给用户
            core.addSystemNote(`错误：${event.message}`)
          }
        },
        executeTool: (call) => executeAgentTool(call.name, call.arguments),
        // 每批工具跑完取一次队列：主人中途说的话（已经显示、存好）和后台通知接进这一轮
        drainQueued: () => {
          if (interrupted || sessions.follow(turnSid) !== core.sessionId) return []
          return drainQueue().map((q) => {
            if (q.mode === 'task-notification') {
              showNotice(q)
              return createUserMessage(taskNoticeForModel(q.text), { timestamp: q.timestamp })
            }
            core.setMessages((prev) => settleQueuedBubble(prev, q.timestamp))
            const queuedImages = (q.images ?? []) as readonly PickedImage[]
            return createUserMessage(q.text, { images: queuedImages.map((i) => i.block), timestamp: q.timestamp })
          })
        },
      })
      // 模型这一轮说完了：之后主人再发的话不再排队（朗读可能还要很久）
      releaseBusy()

      // 工具调用与结果留在历史里（下一轮还能引用刚查到的数据）；超门槛时先清旧工具结果，还超就在后台写摘要
      // 切走了，或新一轮等不及已经读走了历史：这段历史不属于现在的对话，不能盖上去
      // （新一轮还在等上一轮收尾时要写，它读到的历史才有上一轮）
      if (core.conversationOwner === turnId && sessions.follow(turnSid) === core.sessionId) {
        // 背景拼在话里的那种要换回原话；发成背景消息的原样留着（删了就是改历史）
        const settled = newHistory.map((m) => (m === apiUserMsg && !turnReminder ? userMsg : m))
        core.setConversation(core.compactor ? core.compactor.settle(settled, compactCtx) : settled)
        core.compactor?.kick(compactCtx)
      }

      // 工具记录落库（时间排在主人这句后面、回复前面）：切会话、重启后还在
      const traceRow = toolTraceRow(newHistory.slice(sentHistory.length), sentAt)
      if (traceRow) {
        sessions.persistRows(turnSid, [{ ...traceRow, id: randomUUID() }]).catch((e) => console.warn('[Chat] 工具记录写入失败', e))
      }
      if (interrupted) {
        core.patchMessage(lastSegmentId(), (m) => (m.content ? { ...m, content: `${m.content}……（被打断）` } : m))
      }

      // 把本轮快照 patch 到对应 agent 气泡
      if (capturedSnapshots.length > 0) {
        core.patchMessage(lastSegmentId(), (m) => ({ ...m, debugSnapshots: [...capturedSnapshots] }))
      }

      // 只看本轮新增的部分：接口报错时本轮没有 assistant，扫整段历史会取到上一轮的回复，再存一遍
      const replyText = lastReplyText(newHistory.slice(sentHistory.length))

      // ── 想法沉淀（后台，不阻塞回复）──
      if (text.trim() && !turn.notices) void runThoughtDistill(core, text.trim())

      // ── 回复落库（只存最终 assistant）；音频到手后按同一个 id 补 audioPath ──
      if (replyText.trim()) {
        assistantRow = {
          ...makeSessionMessage('assistant', replyText.trim()),
          id: agentMsgId,
          timestamp: bubbleTimestamp(),
          reasoning: capturedReasoning || null,
          ...(capturedUsage ? { usage: capturedUsage } : {}),
        }
        sessions.persistRows(turnSid, [assistantRow]).catch((e) => console.warn('[Chat] 回复写入失败', e))
      }

      // ── TTS：LLM 完成后 flush，等待音频播完，整段落盘 ──
      if (tts) {
        if (replyText.trim() && !interrupted) {
          if (ownsUi()) core.emitFairy('speaking')
          try {
            const wav = await tts.finish()
            if (wav) {
              const sid = sessions.follow(turnSid)
              let audioPath: string | null = null
              if (sid) {
                // 落盘失败不阻塞
                audioPath = await saveAudioFile(sid, wav.wavBase64, new Date().toISOString()).catch(() => null)
              }
              core.patchMessage(agentMsgId, (m) => ({
                ...m,
                audio: { path: audioPath, durationMs: wav.durationMs, waveform: waveformFromWavBase64(wav.wavBase64) },
              }))
              if (audioPath && assistantRow) {
                assistantRow = { ...assistantRow, audioPath, durationMs: wav.durationMs }
                sessions.persistRows(turnSid, [assistantRow]).catch((e) => console.warn('[Chat] 回复音频写入失败', e))
              }
            }
          } catch {
            // TTS 失败不影响主流程
          } finally {
            if (ownsUi()) core.emitFairy('idle')
          }
        } else {
          tts.abandon()
          if (ownsUi()) core.emitFairy('idle')
        }
      } else if (ownsUi()) {
        core.emitFairy('idle')
      }
    } catch (err) {
      tts?.abandon()
      if (!interrupted) {
        core.addSystemNote(`错误: ${err instanceof Error ? err.message : String(err)}`)
        if (ownsUi()) core.emitFairy('idle')
      }
    } finally {
      core.patchMessage(agentMsgId, (m) => (m.streaming ? { ...m, streaming: false } : m))
      if (core.replyTurn === turnId) core.replyControl = null
      releaseBusy()
      if (ownsUi()) core.setProcessing(false)
      settle()
      sessions.flushDbSync()
      core.onTurnIdle?.()
    }
  }
}
