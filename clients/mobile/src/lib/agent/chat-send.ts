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
// ══════════════════════════════════════════════

import { isAnthropicModel } from '../llm/anthropic-stream'
import type { ApiRequestSnapshot, ModelCallLog } from '../llm/api'
import { compactHistory, withSystemReminder } from '../llm/context-window'
import { runQueryLoop } from '../llm/query-loop'
import { createUserMessage, getMessageText, isAssistantMessage, type Message } from '../llm/types'
import { randomUUID } from '../llm/uuid'
import { getFeatureModel } from '../models/model-audit'
import { solevupGetActiveModelApiKey } from '../solevupdb'
import { createReplyTts, resolveFishApiKey, saveAudioFile, type ReplyTts } from '../voice'
import { waveformFromWavBase64 } from '../../components/fairy/fairy-format'
import { getDashScopeApiKey } from './agent-config'
import type { SessionMessage } from './agent-memory'
import { runThoughtDistill } from './chat-distill'
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

export type HandleSend = (text: string, fromVoice?: boolean) => Promise<void>

export function createSendFlow(core: ChatCore, sessions: SessionFlow, prompt: PromptFlow): HandleSend {
  return async function handleSend(text, fromVoice = false) {
    if (!text.trim()) return

    // 发送中再发送：先停掉上一轮
    core.replyControl?.interrupt()
    core.replyControl = null
    const previousTurn = core.turnSettled
    let settle: () => void = () => {}
    core.turnSettled = new Promise((resolve) => { settle = resolve })

    // 语音那句在转写定稿时已经数过（onTranscript），这里只数打字
    if (!fromVoice) sessions.titleFlow.onUserMessage(text)

    const turnSid = core.sessionId

    // 文字输入：添加用户气泡并落库（语音输入的气泡和落库在 chat-voice 的 onUserAudio / onTranscript）
    if (!fromVoice) {
      const userRow = makeSessionMessage('user', text.trim())
      core.setMessages((prev) => [...prev, {
        id: userRow.id!, role: 'user', content: text, timestamp: userRow.timestamp,
      }])
      sessions.persistRows(turnSid, [userRow]).catch((e) => console.warn('[Chat] 用户消息写入失败', e))
    }

    // 本轮回复的轮次号：被打断的轮次收尾时不再动 Fairy 状态和「处理中」标志，免得盖掉新一轮
    const turnId = ++core.replyTurn
    let interrupted = false
    const ownsUi = () => core.replyTurn === turnId && !interrupted
    core.setProcessing(true)
    core.emitFairy('thinking')

    // ── 打断：主人开口、再次发送、切会话时停掉本轮的生成与朗读 ──
    const abort = new AbortController()
    let tts: ReplyTts | null = null
    core.replyControl = {
      interrupt: () => {
        if (interrupted) return
        interrupted = true
        abort.abort()
        tts?.interrupt()
        core.setProcessing(false)
      },
    }

    const agentMsgId = randomUUID()
    let agentTimestamp = ''
    const userMsg = createUserMessage(text)
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
        const fishApiKey = await resolveFishApiKey(config.fishApiKey).catch(() => null)
        if (fishApiKey && !interrupted) {
          try {
            tts = createReplyTts({ apiKey: fishApiKey, referenceId: config.fishReferenceId, model: config.fishModel })
          } catch (e) {
            console.warn('[Chat] TTS 不可用', e)
          }
        }
      }

      // 本轮实时背景只附在发给模型的这条消息上；存进历史的是不带背景的原话，让前缀跨轮不变
      const { staticPrompt, dynamicContext } = core.promptParts
      const apiUserMsg = { ...userMsg, message: { ...userMsg.message, content: withSystemReminder(text, dynamicContext) } }

      // 被打断的旧轮可能比新轮晚走到这里（取数慢、新轮等超时先走了）：不能把归属改回去，否则新轮的历史写不进来
      core.conversationOwner = Math.max(core.conversationOwner, turnId)
      const sentHistory = [...core.conversation, apiUserMsg]
      const newHistory = await runQueryLoop({
        messages: sentHistory,
        systemPrompt: staticPrompt || systemPrompt,
        apiOptions: {
          apiKey: dashscopeApiKey,
          apiBase: config.openaiApiBase,
          model: chatModel,
          feature: 'fairy_chat',
          maxTokens: 8000,
          tools: TOOL_DEFINITIONS,
          signal: abort.signal,
          onRequestSnapshot: (snap) => capturedSnapshots.push(snap),
          onUsageLogged: (call) => {
            capturedUsage = call
            core.patchMessage(agentMsgId, (m) => ({ ...m, usage: call }))
            // 用量可能比回复入库晚到：入库后再补上
            if (assistantRow) {
              assistantRow = { ...assistantRow, usage: call }
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
            // 工具调用开始：立即把积压的文字刷给 TTS（否则工具执行期间静音）
            tts?.push('', true)
            if (ownsUi()) core.emitFairy('thinking')
            let argsPreview = ''
            try { argsPreview = JSON.stringify(JSON.parse(event.call.arguments), null, 0) } catch { argsPreview = event.call.arguments }
            core.addSystemNote(`⚙ ${event.call.name}(${argsPreview})`, `tool-${event.call.id}`)
          } else if (event.type === 'toolCallDone') {
            // 工具完成：把结果追加到对应的系统消息气泡里
            if (ownsUi()) core.emitFairy('thinking')
            const resultPreview = event.result.length > 300 ? event.result.slice(0, 300) + '…' : event.result
            core.patchMessage(`tool-${event.call.id}`, (m) => ({ ...m, content: m.content + `\n→ ${resultPreview}` }))
          } else if (event.type === 'error') {
            if (interrupted) return // 主人打断导致的中止，不算错误
            // API 错误（工具调用后的第二次请求失败是常见原因）→ 直接显示给用户
            core.addSystemNote(`错误：${event.message}`)
          }
        },
        executeTool: (call) => executeAgentTool(call.name, call.arguments),
      })

      // 工具调用与结果留在历史里（下一轮还能引用刚查到的数据）；体量超高水位时才按整轮分批压缩
      // 切走了，或新一轮等不及已经读走了历史：这段历史不属于现在的对话，不能盖上去
      // （新一轮还在等上一轮收尾时要写，它读到的历史才有上一轮）
      if (core.conversationOwner === turnId && sessions.follow(turnSid) === core.sessionId) {
        core.setConversation(compactHistory(newHistory.map((m) => (m === apiUserMsg ? userMsg : m))))
      }
      if (interrupted) {
        core.patchMessage(agentMsgId, (m) => (m.content ? { ...m, content: `${m.content}……（被打断）` } : m))
      }

      // 把本轮快照 patch 到对应 agent 气泡
      if (capturedSnapshots.length > 0) {
        core.patchMessage(agentMsgId, (m) => ({ ...m, debugSnapshots: [...capturedSnapshots] }))
      }

      // 只看本轮新增的部分：接口报错时本轮没有 assistant，扫整段历史会取到上一轮的回复，再存一遍
      const replyText = lastReplyText(newHistory.slice(sentHistory.length))

      // ── 想法沉淀（后台，不阻塞回复）──
      if (text.trim()) void runThoughtDistill(core, text.trim())

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
      if (ownsUi()) core.setProcessing(false)
      settle()
      sessions.flushDbSync()
    }
  }
}
