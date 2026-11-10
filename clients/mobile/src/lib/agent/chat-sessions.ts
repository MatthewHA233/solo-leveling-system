// ══════════════════════════════════════════════
// 会话管理（对应 desktop App.tsx 的 session 转换、启动恢复、switchSession / newSession、选择器接线）
//
// 和桌面端的差异：
//   · 消息 id 用库里的 id（桌面端恢复时现生成随机 id），重复写入才能按 id 合并
//   · 切会话时也丢掉还没变成消息的录音和实时语音这一轮（桌面端切会话只停回复）
//   · 写库返回的 sessionId 变了 = 会话被另一台设备删除，消息改道到了新会话，这里切过去
//   · 订阅 SolevupDbChanged：同步进来的改动要反映到列表、标题和当前会话
// ══════════════════════════════════════════════

import { DeviceEventEmitter } from 'react-native'

import type { ChatMessage } from '../../types'
import { createTitleFlow, DEFAULT_SESSION_TITLE, type TitleFlow } from '../ai/session-title-flow'
import { chatImageUri, loadRestoredImages } from '../chatimage'
import type { CompactionResult } from '../llm/context-window'
import { randomUUID } from '../llm/uuid'
import { parseModelCallLog } from '../models/model-audit'
import { refreshModelCatalog } from '../models/registry'
import { solevupIsChatSessionDeleted } from '../solevupdb'
import {
  cleanupEmptyChatSessions,
  createChatSession,
  deleteChatSession,
  fetchSessionMessages,
  getRecentChatSessions,
  initChatSession,
  patchSession,
  persistMessages,
  type ChatSessionInfo,
  type SessionMessage,
} from './agent-memory'
import { parseImageMarker } from './chat-images'
import { createCompactor } from './chat-compaction'
import { compactNotice, compactSummaryRow, isCompactSummaryRow, restoreLLMHistory, rowsToLLMMessages, TOOL_TRACE_ROW, toolCallsOfTrace } from './chat-history'
import { toolCallMessage, type ChatCore } from './chat-core'

const REROUTED_NOTE = '这个会话已在另一台设备上删除，刚才的消息存到了新会话。'
const DELETED_NOTE = '这个会话已在另一台设备上删除，继续发送会存到新会话。'

// ── Session 持久化：格式转换 ──

export function sessionMessagesToChatMessages(msgs: readonly SessionMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of msgs) {
    // 压缩摘要显示成一条提示，点开能看；工具记录还原成一次调用一行
    if (isCompactSummaryRow(m) && m.content?.trim()) {
      out.push({ id: m.id ?? randomUUID(), role: 'system', content: compactNotice(), summary: m.content, timestamp: m.timestamp })
      continue
    }
    if (m.role === 'tool') {
      if (m.name === TOOL_TRACE_ROW) out.push(...toolCallsOfTrace(m).map((call) => toolCallMessage(call, m.timestamp)))
      continue
    }
    const { ids: imageIds, text: content } = parseImageMarker((m.content ?? '').trim())
    // 音频气泡：即使没有文字也要还原（content 可能是 transcript）
    const hasAudio = !!m.audioPath
    if (!content && !hasAudio && imageIds.length === 0) continue
    // 旧版手机端把界面提示也写进过库，别当成 Fairy 说的话
    const role = (m.role as string) === 'system' ? 'system' : m.role === 'user' ? 'user' : 'agent'
    // 过一遍 parseModelCallLog：桌面端写的 usage_json 字段可能不全（success 是 0/1 等）
    const usage = m.usage ? parseModelCallLog(JSON.stringify(m.usage)) : null

    out.push({
      id: m.id ?? randomUUID(),
      role,
      content,
      timestamp: m.timestamp,
      // transcript 就是 content（语音消息 content 存的是转写文本）
      ...(hasAudio
        ? { audio: { path: m.audioPath, durationMs: m.durationMs ?? undefined, ...(content ? { transcript: content } : {}) } }
        : {}),
      ...(imageIds.length > 0 ? { images: imageIds.map((id) => ({ id, uri: chatImageUri(id) })) } : {}),
      ...(usage ? { usage } : {}),
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    })
  }
  return out
}

/** 压缩提示插在保留段第一条前面，和从库里恢复时的位置一致（对齐 desktop insertCompactNotice） */
function insertCompactNotice(messages: readonly ChatMessage[], result: CompactionResult): ChatMessage[] {
  const notice: ChatMessage = {
    id: randomUUID(), role: 'system', content: compactNotice(result.kind),
    summary: result.summaryText, timestamp: result.summaryTimestamp,
  }
  const index = messages.findIndex((m) => m.timestamp > result.summaryTimestamp)
  return index < 0 ? [...messages, notice] : [...messages.slice(0, index), notice, ...messages.slice(index)]
}

/** 会话里主人说过几句（起标题的计数从这里接上） */
export function countUserMessages(messages: readonly SessionMessage[]): number {
  return messages.filter((m) => m.role === 'user' && (m.content ?? '').trim()).length
}

export function makeSessionMessage(
  role: SessionMessage['role'],
  content: string,
  audioPath?: string,
  durationMs?: number,
): SessionMessage {
  return {
    id: randomUUID(),
    role,
    content,
    toolCalls: null,
    toolCallId: null,
    name: null,
    timestamp: new Date().toISOString(),
    audioPath: audioPath ?? null,
    durationMs: durationMs ?? null,
  }
}

/** 同 id 换成新内容，新的接到后面 */
function upsertRows(buffer: readonly SessionMessage[], rows: readonly SessionMessage[]): SessionMessage[] {
  const out = [...buffer]
  for (const row of rows) {
    const index = out.findIndex((m) => m.id === row.id)
    if (index >= 0) out[index] = row
    else out.push(row)
  }
  return out
}

function timeMs(value: string): number {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : 0
}

export interface SessionFlow {
  readonly titleFlow: TitleFlow
  readonly boot: () => Promise<void>
  /** 把这几行写进 sid：还是当前会话就整表回写（native 按 id 合并），已切走的只写这几行 */
  readonly persistRows: (sid: string | null, rows: readonly SessionMessage[]) => Promise<void>
  /** sid 被改道过就跟到最新的会话 */
  readonly follow: (sid: string | null) => string | null
  readonly switchSession: (id: string, jumpToTimestamp?: string, title?: string) => Promise<void>
  readonly newSession: () => Promise<void>
  readonly deleteSession: (id: string) => Promise<void>
  /** 打开选择器前：清空白会话 + 重拉列表 */
  readonly loadForPicker: () => void
  readonly refreshSessions: (changedSessionId?: string) => void
  /** 回复收尾后调用：回复途中同步进来的内容这时才合进当前会话 */
  readonly flushDbSync: () => void
  readonly subscribeDbChanges: () => () => void
}

export function createSessionFlow(core: ChatCore, onSessionChange: () => void): SessionFlow {
  let jumpNonce = 0
  let pendingDbSync = false
  const deletedNoted = new Set<string>()

  const applySessionTitle = (title: string) => {
    core.sessionTitle = title
    core.emit()
  }

  const titleFlow = createTitleFlow({
    getConfig: () => core.config,
    getMessages: () => core.persistedBuffer.map((m) => (m.content ? { ...m, content: parseImageMarker(m.content).text } : m)),
    apply: (sid, title) => {
      patchSession(sid, { title }).catch(() => {})
      core.sessions = core.sessions.map((s) => (s.id === sid ? { ...s, title } : s))
      if (sid === core.sessionId) applySessionTitle(title)
      else core.emit()
    },
  })

  const follow = (sid: string | null): string | null => {
    let target = sid
    while (target) {
      const next = core.rerouted.get(target)
      if (!next) break
      target = next
    }
    return target
  }

  const refreshSessions = (changedSessionId?: string) => {
    if (changedSessionId) titleFlow.lock(changedSessionId)
    void getRecentChatSessions(50).then((list) => {
      core.sessions = list
      const current = list.find((s) => s.id === core.sessionId)
      if (current) applySessionTitle(current.title || DEFAULT_SESSION_TITLE)
      else core.emit()
    }).catch(() => {})
  }

  /** 会话被另一台设备删除，消息改道到了 toSid（B03 的 solevupAppendChatMessages 已经写好了） */
  const handleReroute = async (fromSid: string, toSid: string, rows: readonly SessionMessage[]) => {
    core.rerouted.set(fromSid, toSid)
    core.sessionId = toSid
    applySessionTitle(DEFAULT_SESSION_TITLE)
    titleFlow.reset(toSid, DEFAULT_SESSION_TITLE, 0)
    const lastUser = [...rows].reverse().find((m) => m.role === 'user' && (m.content ?? '').trim())
    if (lastUser?.content) titleFlow.onUserMessage(lastUser.content)
    core.addSystemNote(REROUTED_NOTE)
    refreshSessions()
    // 旧会话的行已随删除消失，缓冲换成新会话实际有的；刚写的这几行还没读到时也留着
    const stored = await fetchSessionMessages(toSid).catch(() => [] as SessionMessage[])
    if (core.sessionId !== toSid) return
    core.persistedBuffer = upsertRows(stored, rows.filter((r) => !stored.some((s) => s.id === r.id)))
  }

  const persistRows = async (sid: string | null, rows: readonly SessionMessage[]) => {
    const target = follow(sid)
    if (!target || rows.length === 0) return
    const isCurrent = target === core.sessionId
    if (isCurrent) core.persistedBuffer = upsertRows(core.persistedBuffer, rows)
    const result = await persistMessages(target, isCurrent ? core.persistedBuffer : rows)
    if (result.sessionId !== target && target === core.sessionId) {
      await handleReroute(target, result.sessionId, rows)
    }
  }

  // 上下文压缩（规则见 chat-compaction.ts）。摘要存进它所属的会话（被另一台设备删了就跟着改道）
  core.compactor = createCompactor({
    getConversation: () => core.conversation,
    setConversation: (history) => {
      core.setConversation(history)
      core.emit()
    },
    getSessionId: () => core.sessionId,
    persistSummary: (sid, result) => {
      persistRows(sid, [{ ...compactSummaryRow(result), id: randomUUID() }])
        .catch((e) => console.warn('[Compact] 摘要写入失败', e))
    },
    onCompacted: (result, sid) => {
      if (follow(sid) !== core.sessionId) return
      core.setMessages((prev) => insertCompactNotice(prev, result))
    },
  })

  /** 打断正在进行的回复和录音：切走之后它们不能再动界面和新会话的历史 */
  const stopCurrentTurn = () => {
    core.replyControl?.interrupt()
    core.replyControl = null
    onSessionChange()
    core.partialText = ''
    if (core.fairyState !== 'idle') core.emitFairy('idle')
  }

  const switchSession = async (sessionId: string, jumpToTimestamp?: string, title?: string) => {
    const performJump = () => {
      if (!jumpToTimestamp) return
      jumpNonce += 1
      core.jumpTo = { timestamp: jumpToTimestamp, nonce: jumpNonce }
      core.emit()
    }

    if (sessionId === core.sessionId) {
      performJump()
      return
    }
    try {
      const msgs = await fetchSessionMessages(sessionId)
      const restoredImages = await loadRestoredImages(msgs)
      stopCurrentTurn()
      core.sessionId = sessionId
      core.persistedBuffer = [...msgs]
      // title 来自选择器那一行：搜索能跳到 50 条列表之外的会话，sessions 里不一定有
      const info = title ?? core.sessions.find((s) => s.id === sessionId)?.title
      applySessionTitle(info || DEFAULT_SESSION_TITLE)
      titleFlow.reset(sessionId, info || DEFAULT_SESSION_TITLE, countUserMessages(msgs))
      core.compactor?.reset()
      core.setConversation(restoreLLMHistory(msgs, restoredImages))
      core.setMessages(() => sessionMessagesToChatMessages(msgs))
      performJump()
    } catch {
      // 加载失败静默忽略
    }
  }

  const newSession = async () => {
    stopCurrentTurn()
    core.compactor?.reset()
    try {
      const s = await createChatSession()
      core.sessionId = s.id
      applySessionTitle(DEFAULT_SESSION_TITLE)
      titleFlow.reset(s.id, DEFAULT_SESSION_TITLE, 0)
      core.persistedBuffer = []
      core.setConversation([])
      core.sessions = [s, ...core.sessions]
      core.setMessages(() => [])
    } catch {
      // 原生库不可用时降级：能聊，不持久化
      core.sessionId = null
      applySessionTitle(DEFAULT_SESSION_TITLE)
      titleFlow.reset(null, DEFAULT_SESSION_TITLE, 0)
      core.persistedBuffer = []
      core.setConversation([])
      core.setMessages(() => [])
    }
  }

  const deleteSession = async (id: string) => {
    try { await deleteChatSession(id) } catch {}
    const deletingCurrent = core.sessionId === id
    const latest = (await getRecentChatSessions(50).catch(() => [] as ChatSessionInfo[])).filter((s) => s.id !== id)
    core.sessions = latest
    core.emit()
    if (deletingCurrent) {
      const next = latest[0] ?? null
      if (next) await switchSession(next.id, undefined, next.title)
      else await newSession()
    }
  }

  const loadForPicker = () => {
    // 顺手清理之前留下的空白会话（无任何消息），不动当前会话
    cleanupEmptyChatSessions(core.sessionId)
      .catch(() => [])
      .then(() => getRecentChatSessions(50))
      .then((list) => {
        core.sessions = list
        core.emit()
      })
      .catch(() => {})
  }

  const boot = async () => {
    try {
      const { sessionId, state } = await initChatSession()
      core.sessionId = sessionId
      core.persistedBuffer = [...state.messages]

      // 恢复最近一次的 session title（用于决定是否要 AI 重命名）
      const recent = await getRecentChatSessions(1)
      const restoredTitle = recent[0]?.id === sessionId ? (recent[0].title || DEFAULT_SESSION_TITLE) : DEFAULT_SESSION_TITLE
      applySessionTitle(restoredTitle)
      titleFlow.reset(sessionId, restoredTitle, countUserMessages(state.messages))

      if (state.messages.length > 0) {
        core.setConversation(restoreLLMHistory(state.messages, await loadRestoredImages(state.messages)))
        core.setMessages(() => sessionMessagesToChatMessages(state.messages))
      }
    } catch {
      // 原生库不可用：静默降级（不影响功能，不持久化）
    }
  }

  /** 同步带来的新行合进当前会话；缓冲也换成库里最新的，否则下次整表回写会把别处改的内容盖回去 */
  const syncCurrentFromDb = async () => {
    const sid = core.sessionId
    if (!sid) return
    if (core.isProcessing) {
      pendingDbSync = true
      return
    }
    const rows = await fetchSessionMessages(sid)
    if (sid !== core.sessionId) return
    if (core.isProcessing) {
      pendingDbSync = true
      return
    }
    // 比缓冲里最早那行还早的不算「新」
    const earliest = core.persistedBuffer[0] ? timeMs(core.persistedBuffer[0].timestamp) : 0
    const known = new Set<string | undefined>([
      ...core.persistedBuffer.map((m) => m.id),
      ...core.messages.map((m) => m.id),
    ])
    const unseen = rows.filter((r) => !known.has(r.id) && timeMs(r.timestamp) >= earliest)
    const unwritten = core.persistedBuffer.filter((m) => !rows.some((r) => r.id === m.id))
    core.persistedBuffer = [...rows, ...unwritten]
    // 另一台设备写的压缩摘要不接到这里：这边的历史没按它压，界面提示的位置也不对，下次打开会话再显示
    const fresh = unseen.filter((r) => !isCompactSummaryRow(r))
    if (fresh.length === 0) return
    core.setConversation([...core.conversation, ...rowsToLLMMessages(fresh)])
    core.setMessages((prev) => [...prev, ...sessionMessagesToChatMessages(fresh)])
  }

  const onDbChanged = async (changed: Record<string, number | undefined>) => {
    // 导入了新的模型表：同步读取的缓存要刷新，否则计费和选择器还是旧的
    if ((changed.modelRegistry ?? 0) > 0) void refreshModelCatalog()
    if ((changed.settings ?? 0) > 0) {
      core.applySyncedSettings().catch((e) => console.warn('[Chat] 读取同步设置失败', e))
    }
    if (!changed.chatSessions && !changed.chatMessages) return
    refreshSessions()
    const sid = core.sessionId
    if (!sid) return
    // 判断删除不看列表（列表有上限）。不立刻切走：屏幕上的内容还能看，继续发送时才改道
    if (await solevupIsChatSessionDeleted(sid)) {
      if (!deletedNoted.has(sid) && sid === core.sessionId) {
        deletedNoted.add(sid)
        core.addSystemNote(DELETED_NOTE)
      }
      return
    }
    if (changed.chatMessages) await syncCurrentFromDb()
  }

  const subscribeDbChanges = () => {
    const sub = DeviceEventEmitter.addListener(
      'SolevupDbChanged',
      (e: { source?: string; changed?: Record<string, number | undefined> } | null) => {
        onDbChanged(e?.changed ?? {}).catch((err) => console.warn('[Chat] 处理同步变更失败', err))
      },
    )
    return () => sub.remove()
  }

  const flushDbSync = () => {
    if (!pendingDbSync || core.isProcessing) return
    pendingDbSync = false
    syncCurrentFromDb().catch((err) => console.warn('[Chat] 合并同步内容失败', err))
  }

  return {
    titleFlow,
    boot,
    persistRows,
    follow,
    switchSession,
    newSession,
    deleteSession,
    loadForPicker,
    refreshSessions,
    flushDbSync,
    subscribeDbChanges,
  }
}
