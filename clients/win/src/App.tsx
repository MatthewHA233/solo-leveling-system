// ══════════════════════════════════════════════
// Solo Agent — Windows 客户端（务实版）
// 核心：昼夜表 + AI 聊天整理
// ══════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronLeft, ChevronRight, Settings } from 'lucide-react'
import BiliIcon from './components/icons/BiliIcon'
import { fetchActivities } from './lib/chronos-api'
import { createActivity, deleteActivity, fetchManicTimeSpans, fetchBiliSpans, fetchGoals, parseGoalTags } from './lib/local-api'
import type { MtSpan, BiliSpan } from './lib/local-api'
import type { ChronosActivity } from './types'
import { theme, hud } from './theme'

// Agent
import { loadConfig, updateConfig } from './lib/agent/agent-config'
import type { AgentConfig } from './lib/agent/agent-config'
import { buildSystemPrompt, buildConversationSummary } from './lib/ai/prompt-templates'
import type { ActivityTagRecord, AppUsageRecord, BiliRecord, GoalRecord } from './lib/ai/prompt-templates'

// LLM Engine（新）
import { runQueryLoop } from './lib/llm/query-loop'
import { createUserMessage, createAssistantMessage, getMessageText, isAssistantMessage } from './lib/llm/types'
import type { Message } from './lib/llm/types'
import type { ApiRequestSnapshot } from './lib/llm/api'

// Session 持久化
import {
  initChatSession, persistMessages, patchSession,
  fetchSessionMessages, getRecentChatSessions, createChatSession, deleteChatSession,
} from './lib/agent/agent-memory'
import type { ChatSessionInfo, SessionMessage } from './lib/agent/agent-memory'
import { generateSessionTitle } from './lib/ai/session-title'

// Agent Tools
import { TOOL_DEFINITIONS, executeAgentTool } from './lib/agent/agent-tools'

// OpenAI Chat Completions tools → Realtime API flat tools
// Chat 格式: { type: 'function', function: { name, description, parameters } }
// Realtime 格式: { type: 'function', name, description, parameters }
function toRealtimeTools(tools: typeof TOOL_DEFINITIONS) {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }))
}

// Voice
import { createVoiceService } from './lib/voice'
import type { VoiceService } from './lib/voice'
import { createFishTTSTauri } from './lib/voice/fish-tts-tauri'
import { pcm16ChunksToWavBlob } from './lib/voice/voice-recorder'

// UI
import DayNightChart from './components/DayNightChart'
import ChatPanel from './components/ChatPanel'
import SessionPicker from './components/SessionPicker'
import SettingsPanel from './components/SettingsPanel'
import DatePickerPopover from './components/DatePickerPopover'
import SpanDetailPanel from './components/SpanDetailPanel'
import AppHoverPanel from './components/AppHoverPanel'
import BiliVideoPanel from './components/BiliVideoPanel'
import BiliHistoryDialog from './components/BiliHistoryDialog'
import { useBiliHistory } from './lib/bilibili/useHistory'
import { dbBiliItemToActivity } from './lib/bilibili/api'
import { linkBiliToEvent, mergeActivities } from './lib/local-api'
import type { FairyState } from './components/FairyHUD'
import { HudFrame, HudCommandStrip, DataRibbon, NeonRule } from './components/hud'
import { CloseConfirmModal } from './components/CloseConfirmModal'
import Tooltip from './components/Tooltip'
import { usePresenceDetection } from './hooks/usePresenceDetection'
import { useDataDays, hasDataOrIsToday } from './hooks/useDataDays'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import soloLevelingLogo from './assets/SOLO LEVELING SYSTEM.png'

export interface OmniDebugItem {
  type: 'text' | 'audio'
  ts: string
  content?: string       // text 类型
  wavBase64?: string     // audio 类型
  durationMs?: number    // audio 类型
}

export interface OmniDebugInfo {
  systemPrompt: string
  model: string
  voice: string
  ts: string
  items: OmniDebugItem[]
}

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'agent' | 'system'
  readonly content: string
  readonly timestamp: string
  readonly audioUrl?: string             // 语音消息的 blob URL（可播放）
  readonly durationMs?: number           // 录音时长（毫秒）
  readonly transcript?: string           // ASR 转写文本（语音消息专用）
  readonly debugSnapshots?: ApiRequestSnapshot[]  // 本轮发给 AI 的请求快照（普通模式）
  readonly omniDebugInfo?: OmniDebugInfo          // 本轮发给 Omni 的上下文快照
}

// ── Session 持久化：格式转换 ──

function sessionMessagesToChatMessages(msgs: readonly SessionMessage[], audioDir = ''): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of msgs) {
    if (m.role === 'tool') continue
    const content = (m.content ?? '').trim()
    // 音频气泡：即使没有文字也要还原（content 可能是 transcript）
    const hasAudio = !!(m.audioPath && audioDir)
    if (!content && !hasAudio) continue

    const audioUrl = hasAudio
      ? convertFileSrc(`${audioDir}/${m.audioPath}`)
      : undefined

    out.push({
      id: crypto.randomUUID(),
      role: m.role === 'user' ? 'user' : 'agent',
      content,
      timestamp: m.timestamp,
      ...(audioUrl ? { audioUrl, durationMs: m.durationMs ?? undefined } : {}),
      // transcript 就是 content（语音消息 content 存的是转写文本）
      ...(audioUrl && content ? { transcript: content } : {}),
    })
  }
  return out
}

function sessionMessagesToLLMHistory(msgs: readonly SessionMessage[]): Message[] {
  const out: Message[] = []
  for (const m of msgs) {
    if (m.role === 'tool') continue
    const content = (m.content ?? '').trim()
    if (!content) continue
    if (m.role === 'user') {
      out.push(createUserMessage(content))
    } else if (m.role === 'assistant') {
      out.push(createAssistantMessage(content))
    }
  }
  return out
}

function makeSessionMessage(
  role: SessionMessage['role'],
  content: string,
  audioPath?: string,
  durationMs?: number,
): SessionMessage {
  return {
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

const TITLE_TRIGGER_MIN_MESSAGES = 4       // 累计到此数后，首次生成 AI 标题

// 区间合并「看B站视频」活动
// 使用 mergeActivities API：移动事件而非删重建，event_id 不变，bvid 链接天然保留
async function mergeOverlappingBili(date: Date) {
  const all = await fetchActivities(date)
  const bili = all.filter((a) => a.title === '看B站视频').sort((a, b) => a.startMinute - b.startMinute)
  if (bili.length <= 1) return

  // 找出所有需要合并的 group（overlapping）
  type Group = { survivorId: string; absorbedIds: string[]; newStart: number; newEnd: number }
  const mergeGroups: Group[] = []
  let cur = bili[0]
  let absorbed: ChronosActivity[] = []

  for (let i = 1; i < bili.length; i++) {
    const next = bili[i]
    if (next.startMinute <= cur.endMinute + 1) {
      absorbed.push(next)
      cur = { ...cur, endMinute: Math.max(cur.endMinute, next.endMinute) }
    } else {
      if (absorbed.length > 0) {
        mergeGroups.push({
          survivorId: cur.id,
          absorbedIds: absorbed.map((a) => a.id),
          newStart: cur.startMinute,
          newEnd: cur.endMinute,
        })
      }
      cur = next
      absorbed = []
    }
  }
  if (absorbed.length > 0) {
    mergeGroups.push({
      survivorId: cur.id,
      absorbedIds: absorbed.map((a) => a.id),
      newStart: cur.startMinute,
      newEnd: cur.endMinute,
    })
  }

  for (const g of mergeGroups) {
    await mergeActivities(g.survivorId, g.absorbedIds, g.newStart, g.newEnd).catch(() => {})
  }
}

export default function App() {
  // ── Data ──
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const dateAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [activities, setActivities] = useState<ChronosActivity[]>([])
  const [mtSpans, setMtSpans] = useState<MtSpan[]>([])
  const [biliSpans, setBiliSpans] = useState<BiliSpan[]>([])
  // 悬浮预览（hover 触发）
  const [hoveredTagSpan, setHoveredTagSpan] = useState<MtSpan | null>(null)
  const [hoveredAppSpan, setHoveredAppSpan] = useState<MtSpan | null>(null)
  const [hoveredBiliSpan, setHoveredBiliSpan] = useState<BiliSpan | null>(null)
  // 管线轨道模式
  const [trackMode, setTrackMode] = useState<'apps' | 'bili'>('apps')
  // 固定横线位置
  const [pinnedPos, setPinnedPos] = useState<{ col: number; y: number; minute: number } | null>(null)
  const [dbStatus, setDbStatus] = useState<'loading' | 'live' | 'error'>('loading')

  // ── Layout ──
  const [showSettings, setShowSettings] = useState(false)
  const [showBili, setShowBili] = useState(false)


  // ── Activity Editor ──

  // ── Bilibili 后台持久监控 ──
  const [config, setConfig] = useState<AgentConfig>(loadConfig)

  const {
    newItems: biliNewItems,
    isLoading: biliLoading, error: biliError,
    lastUpdated: biliLastUpdated, countdown: biliCountdown,
    intervalSeconds: biliIntervalSec, isPaused: biliPaused,
    windowClosed: biliWinClosed, cursor: biliCursor, hasMoreRemote: biliHasMoreRemote,
    pause: pauseBili, resume: resumeBili,
    refresh: refreshBili, loadOlderHistory: biliLoadOlder, clearNew: clearBiliNew,
    setIntervalSeconds: setBiliInterval,
  } = useBiliHistory({ intervalSeconds: config.biliIntervalSeconds })

  // ── Chat ──
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  // LLM 对话历史（新类型系统），与 UI 展示的 chatMessages 分离
  const conversationRef = useRef<Message[]>([])

  // ── Session 持久化 ──
  const sessionIdRef = useRef<string | null>(null)
  const sessionTitleRef = useRef<string>('新会话')       // 现存标题，用于决定是否触发 AI 重命名
  const persistedBufferRef = useRef<SessionMessage[]>([])  // 已持久化的历史（用于 title 生成的上下文窗口）
  const lastOmniUserInputRef = useRef<string>('')        // Omni 本轮用户输入（文字 or 转写）
  const audioDirRef = useRef<string>('')                 // 音频根目录（Rust data_local/solo-agent/audio）
  const pendingAudioRef = useRef<Map<string, { audioPath: string; durationMs: number }>>(new Map())
  const [sessions, setSessions] = useState<readonly ChatSessionInfo[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  // ── Presence Detection ──
  const { presence, videoRef } = usePresenceDetection(config.overlayEnabled)

  // 预热 mic 权限：防止首次长按 Alt 时弹出权限弹窗导致无反应
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => stream.getTracks().forEach(t => t.stop()))
      .catch(() => {})
  }, [])

  // 将人脸框数据实时发送到摄像头子窗口
  useEffect(() => {
    import('@tauri-apps/api/event').then(({ emitTo }) => {
      emitTo('camera-preview', 'face-data', { faces: presence.faces }).catch(() => {
        // 子窗口未开启时静默忽略
      })
    })
  }, [presence.faces])

  // 摄像头子窗口开关
  const cameraWinRef = useRef<import('@tauri-apps/api/webviewWindow').WebviewWindow | null>(null)
  const [cameraWindowOpen, setCameraWindowOpen] = useState(false)
  const toggleCameraWindow = useCallback(async () => {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    // 已有窗口 → 关闭
    if (cameraWinRef.current) {
      try { await cameraWinRef.current.close() } catch {}
      cameraWinRef.current = null
      setCameraWindowOpen(false)
      return
    }
    const url = window.location.href.replace(/#.*$/, '') + '#camera'
    let win: import('@tauri-apps/api/webviewWindow').WebviewWindow
    try {
      win = new WebviewWindow('camera-preview', {
        url,
        title: 'Camera Preview',
        width: 240,
        height: 220,
        alwaysOnTop: true,
        decorations: false,
        resizable: false,
        skipTaskbar: true,
      })
    } catch (e) {
      console.error('[camera] WebviewWindow create failed:', e)
      return
    }
    win.once('tauri://error', (e) => console.error('[camera] window error:', e))
    cameraWinRef.current = win
    setCameraWindowOpen(true)
    win.once('destroyed', () => { cameraWinRef.current = null; setCameraWindowOpen(false) })
  }, [])

  // ── Voice / Fairy ──
  const altDownTimeRef = useRef<number>(0)
  const pressingRef = useRef(false)
  const fairyStateRef = useRef<FairyState>('idle')
  const voiceServiceRef = useRef<VoiceService | null>(null)
  const configRef = useRef(config)
  const systemPromptRef = useRef<string>('')
  const chatMessagesRef = useRef<ChatMessage[]>([])
  // 同步 ref，供 refreshSystemPrompt 读取最新值（避免 useCallback 闭包过期）
  useEffect(() => { chatMessagesRef.current = chatMessages }, [chatMessages])
  const LONG_PRESS_MS = 600

  // ── 启动：获取音频目录 + 恢复最近会话（<4h）或创建新会话 ──
  useEffect(() => {
    (async () => {
      try {
        // 先拿音频根目录（后续 save_audio_file / asset URL 都依赖它）
        const audioDir = await invoke<string>('get_audio_dir')
        audioDirRef.current = audioDir

        const { sessionId, state } = await initChatSession()
        sessionIdRef.current = sessionId
        persistedBufferRef.current = [...state.messages]

        // 恢复最近一次的 session title（用于决定是否要 AI 重命名）
        const recent = await getRecentChatSessions(1)
        if (recent[0]?.id === sessionId) sessionTitleRef.current = recent[0].title || '新会话'

        if (state.messages.length > 0) {
          setChatMessages(sessionMessagesToChatMessages(state.messages, audioDir))
          conversationRef.current = sessionMessagesToLLMHistory(state.messages).slice(-12)
        }
      } catch {
        // 后端不可用：静默降级（不影响功能，不持久化）
      }
    })()
  }, [])

  const fairyWinRef = useRef<import('@tauri-apps/api/webviewWindow').WebviewWindow | null>(null)

  useEffect(() => {
    let cancelled = false
    const init = async () => {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      if (cancelled) return
      const url = window.location.href.replace(/#.*$/, '') + '#fairy'
      try {
        const win = new WebviewWindow('fairy-window', {
          url,
          title: 'Fairy',
          width: 280,
          height: 280,
          alwaysOnTop: true,
          decorations: false,
          resizable: true,
          maximizable: false,   // 禁用 Aero Snap 最大化（拖到屏幕边缘）
          minimizable: false,
          skipTaskbar: true,
          transparent: true,
          shadow: false,
        })
        fairyWinRef.current = win
        win.once('destroyed', () => { fairyWinRef.current = null })
      } catch (e) {
        console.error('[fairy] window init failed:', e)
      }
    }
    init()
    return () => {
      cancelled = true
      fairyWinRef.current?.close().catch(() => {})
      fairyWinRef.current = null
    }
  }, [])

  const emitFairy = useCallback((state: FairyState, text = '') => {
    fairyStateRef.current = state
    import('@tauri-apps/api/event').then(({ emitTo }) => {
      emitTo('fairy-window', 'fairy-state', { state, text }).catch(() => {})
    })
  }, [])

  // fairy window listener 就绪时重发当前状态，修复启动后前几次 Alt 无反应
  useEffect(() => {
    let unlisten: (() => void) | null = null
    import('@tauri-apps/api/event').then(({ listen: listenEvent }) => {
      listenEvent('fairy-window-ready', () => {
        emitFairy(fairyStateRef.current)
      }).then(fn => { unlisten = fn })
    })
    return () => { unlisten?.() }
  }, [emitFairy])

  // ── Fetch Activities + ManicTime Spans ──
  const isToday = useCallback((date: Date) => {
    const now = new Date()
    return date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
  }, [])

  const refreshMtSpans = useCallback(() => {
    fetchManicTimeSpans(selectedDate)
      .then(setMtSpans)
      .catch(() => {})
    fetchBiliSpans(selectedDate)
      .then(setBiliSpans)
      .catch(() => {})
  }, [selectedDate])

  useEffect(() => {
    setDbStatus('loading')
    fetchActivities(selectedDate)
      .then((data) => { setActivities(data); setDbStatus('live') })
      .catch((err) => { console.error('获取活动失败:', err); setActivities([]); setDbStatus('error') })
    refreshMtSpans()
  }, [selectedDate])

  // 今天的数据实时轮询（15 秒）
  useEffect(() => {
    if (!isToday(selectedDate)) return
    const timer = setInterval(refreshMtSpans, 15000)
    return () => clearInterval(timer)
  }, [selectedDate, refreshMtSpans, isToday])

  // ── Voice Service（懒初始化）──
  const getVoiceService = useCallback(() => {
    if (voiceServiceRef.current) return voiceServiceRef.current

    const svc = createVoiceService(
      () => configRef.current,
      () => systemPromptRef.current,
      {
        onPhaseChange: (phase) => {
          emitFairy(phase as FairyState)
        },
        onUserAudio: (wavBase64, durationMs, sessionMsgId) => {
          // 把录音转成 blob URL，作为用户语音气泡显示
          // 使用 sessionMsgId 作为消息 ID，以便 onTranscript 能找到并更新
          const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
          const blob = new Blob([bytes], { type: 'audio/wav' })
          const audioUrl = URL.createObjectURL(blob)
          const msgTimestamp = new Date().toISOString()
          setChatMessages((prev) => [...prev, {
            id: sessionMsgId, role: 'user' as const,
            content: '', audioUrl, durationMs,
            timestamp: msgTimestamp,
          }])

          // 异步保存到磁盘，存入 pendingAudio Map，等转写或发送时一并写 DB
          if (sessionIdRef.current) {
            const wavBytes = Uint8Array.from(atob(wavBase64), c => c.charCodeAt(0))
            invoke<string>('save_audio_file', {
              sessionId: sessionIdRef.current,
              wavBytes,
              timestamp: msgTimestamp,
            }).then((audioPath) => {
              pendingAudioRef.current.set(sessionMsgId, { audioPath, durationMs })
            }).catch(() => {})
          }
          // Omni 模式：把音频 item 追加到已有快照（Alt 按下时已创建快照）
          if (configRef.current.aiMode === 'omni') {
            const audioItem: OmniDebugItem = { type: 'audio', wavBase64, durationMs, ts: new Date().toISOString() }
            if (omniDebugInfoRef.current) {
              omniDebugInfoRef.current = {
                ...omniDebugInfoRef.current,
                items: [...omniDebugInfoRef.current.items, audioItem],
              }
            } else {
              const cfg = configRef.current
              omniDebugInfoRef.current = {
                systemPrompt: systemPromptRef.current,
                model: cfg.omniModel,
                voice: cfg.omniVoice || 'Tina',
                ts: new Date().toISOString(),
                items: [audioItem],
              }
            }
          }
        },
        onTranscript: (text, sessionMsgId) => {
          // 更新用户气泡的转写文字
          setChatMessages((prev) =>
            prev.map((m) => m.id === sessionMsgId ? { ...m, transcript: text } : m)
          )

          // 语音消息持久化：转写完成时将用户语音消息写入 DB（含 audioPath）
          if (sessionIdRef.current) {
            const pending = pendingAudioRef.current.get(sessionMsgId)
            if (pending) {
              pendingAudioRef.current.delete(sessionMsgId)
              const voiceMsg = makeSessionMessage('user', text, pending.audioPath, pending.durationMs)
              persistedBufferRef.current = [...persistedBufferRef.current, voiceMsg]
              persistMessages(sessionIdRef.current, [voiceMsg]).catch(() => {})
            }
          }

          // Omni 模式：音频已经走 WS，工具调用走 omni://tool_call 事件，不回落 handleSend
          if (configRef.current.aiMode === 'omni') {
            lastOmniUserInputRef.current = text   // 供 audio_done 持久化使用
          } else {
            handleSend(text)
          }
        },
        onAudioLevel: () => {
          // FairyHUD 自己通过 analyser 获取，这里暂不处理
        },
        onError: (message) => {
          setChatMessages((prev) => [...prev, {
            id: crypto.randomUUID(), role: 'system' as const,
            content: message, timestamp: new Date().toISOString(),
          }])
          emitFairy('idle')
        },
      },
      () => toRealtimeTools(TOOL_DEFINITIONS),
    )
    voiceServiceRef.current = svc
    return svc
  }, [activities, emitFairy])

  // ── Omni 全模态模式：监听 AI 回复事件 ──
  const omniAudioCtxRef = useRef<AudioContext | null>(null)
  const omniNextStartRef = useRef<number>(0)
  const omniLastSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const omniLastSourceEndedRef = useRef<boolean>(true)
  const omniTextAccRef = useRef<string>('')
  const omniAiPcmChunksRef = useRef<Uint8Array[]>([])
  const omniAgentMsgIdRef = useRef<string | null>(null)   // 当前 AI 回复气泡的消息 ID
  const omniDebugInfoRef = useRef<OmniDebugInfo | null>(null)  // 本轮 Omni 上下文快照（随气泡写入）
  const refreshSystemPromptRef = useRef<() => Promise<string>>(() => Promise.resolve(''))

  useEffect(() => {
    if (config.aiMode !== 'omni') return

    const playOmniPcm = (b64: string) => {
      if (!omniAudioCtxRef.current) {
        omniAudioCtxRef.current = new AudioContext({ sampleRate: 24000 })
        omniNextStartRef.current = omniAudioCtxRef.current.currentTime
      }
      const ctx = omniAudioCtxRef.current
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const samples = bytes.length / 2
      if (samples === 0) return
      const buf = ctx.createBuffer(1, samples, 24000)
      const ch = buf.getChannelData(0)
      const view = new DataView(bytes.buffer)
      for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const startAt = Math.max(omniNextStartRef.current, ctx.currentTime + 0.005)
      src.start(startAt)
      omniNextStartRef.current = startAt + buf.duration
      // 用真实 onended 事件判断播放完成（绕开 sample rate / 调度误差）
      omniLastSourceRef.current = src
      omniLastSourceEndedRef.current = false
      src.onended = () => {
        if (omniLastSourceRef.current === src) {
          omniLastSourceEndedRef.current = true
          console.log('[FairyDbg] last src onended', { ctxNow: ctx.currentTime.toFixed(3), queueEnd: omniNextStartRef.current.toFixed(3) })
        }
      }
    }

    // StrictMode-safe 监听器注册：同步标记 disposed + 收集 unlisten，
    // 避免 unmount/remount 竞态下 mount 1 的监听器残留导致事件翻倍（文字叠字、音频回音、tool_call 双发 → "active response" 错误）
    let disposed = false
    const unlisteners: Array<() => void> = []

    const registerListen = <T,>(event: string, handler: (e: { payload: T }) => void) => {
      import('@tauri-apps/api/event').then(({ listen }) => {
        if (disposed) return
        listen<T>(event, handler).then((u) => {
          if (disposed) { u(); return }
          unlisteners.push(u)
        })
      })
    }

    registerListen<{ text: string }>('omni://text_chunk', ({ payload }) => {
          omniTextAccRef.current += payload.text
          emitFairy('speaking', omniTextAccRef.current)

          // 第一条 text.delta：立刻建气泡（附带本轮 debug 快照）
          if (!omniAgentMsgIdRef.current) {
            const id = crypto.randomUUID()
            omniAgentMsgIdRef.current = id
            // 确保 debug 快照存在；若 ref 为空则就地补建（兜底）
            if (!omniDebugInfoRef.current) {
              const cfg = configRef.current
              omniDebugInfoRef.current = {
                systemPrompt: systemPromptRef.current,
                model: cfg.omniModel,
                voice: cfg.omniVoice || 'Tina',
                ts: new Date().toISOString(),
                items: [],
              }
            }
            const debugSnap = omniDebugInfoRef.current
            setChatMessages((prev) => [...prev, {
              id, role: 'agent' as const,
              content: omniTextAccRef.current,
              timestamp: new Date().toISOString(),
              omniDebugInfo: debugSnap,
            }])
          } else {
            // 后续 delta：实时更新文字
            const id = omniAgentMsgIdRef.current
            setChatMessages((prev) =>
              prev.map((m) => m.id === id ? { ...m, content: omniTextAccRef.current } : m)
            )
          }
    })

    registerListen<{ data: string }>('omni://audio_chunk', ({ payload }) => {
      const pcm = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0))
      omniAiPcmChunksRef.current.push(pcm)
      playOmniPcm(payload.data)
      const ctx = omniAudioCtxRef.current
      if (ctx) {
        console.log('[FairyDbg] audio_chunk', {
          bytes: pcm.length,
          ctxNow: ctx.currentTime.toFixed(3),
          queueEnd: omniNextStartRef.current.toFixed(3),
          remain: (omniNextStartRef.current - ctx.currentTime).toFixed(3),
        })
      }
    })

    // Omni 原生工具调用：WS 端触发 → 前端执行 → omni_tool_result 回传
    registerListen<{ call_id: string; name: string; arguments: string }>('omni://tool_call', async ({ payload }) => {
          console.log('[Omni] tool_call', payload.name, payload.arguments)
          emitFairy('thinking')
          let argsPreview = payload.arguments
          try { argsPreview = JSON.stringify(JSON.parse(payload.arguments), null, 0) } catch {}
          const toolMsgId = `tool-${payload.call_id}`
          setChatMessages((prev) => [...prev, {
            id: toolMsgId, role: 'system' as const,
            content: `⚙ ${payload.name}(${argsPreview})`,
            timestamp: new Date().toISOString(),
          }])
          let result: string
          try {
            result = await executeAgentTool(payload.name, payload.arguments)
          } catch (err) {
            result = `工具执行失败：${err instanceof Error ? err.message : String(err)}`
          }
          const preview = result.length > 300 ? result.slice(0, 300) + '…' : result
          setChatMessages((prev) => prev.map((m) =>
            m.id === toolMsgId ? { ...m, content: m.content + `\n→ ${preview}` } : m
          ))
          try {
            await invoke('omni_tool_result', { callId: payload.call_id, output: result })
          } catch (err) {
            console.error('[Omni] omni_tool_result failed', err)
          }
    })

    registerListen<{ status: string; message?: string }>('omni://status', ({ payload }) => {
          if (payload.status === 'audio_done') {
            const chunks = omniAiPcmChunksRef.current
            omniAiPcmChunksRef.current = []
            omniTextAccRef.current = ''
            const msgId = omniAgentMsgIdRef.current
            omniAgentMsgIdRef.current = null

            const wavBlob = chunks.length > 0 ? pcm16ChunksToWavBlob(chunks, 24000) : null
            const audioUrl = wavBlob ? URL.createObjectURL(wavBlob) : undefined

            const debugSnap = omniDebugInfoRef.current ?? undefined
            const aiMsgTimestamp = new Date().toISOString()

            if (msgId) {
              // 给已有气泡追加音频 + debug 快照（兜底：text_chunk 时若 ref 还为空则在此补上）
              setChatMessages((prev) =>
                prev.map((m) => m.id === msgId
                  ? { ...m, ...(audioUrl ? { audioUrl } : {}), ...(debugSnap && !m.omniDebugInfo ? { omniDebugInfo: debugSnap } : {}) }
                  : m
                )
              )
            } else if (audioUrl) {
              // 极少情况：没有文字但有音频，建新气泡
              setChatMessages((prev) => [...prev, {
                id: crypto.randomUUID(), role: 'agent' as const,
                content: '', audioUrl, timestamp: aiMsgTimestamp,
                ...(debugSnap ? { omniDebugInfo: debugSnap } : {}),
              }])
            }
            setIsProcessing(false)
            const ctxAtDone = omniAudioCtxRef.current
            console.log('[FairyDbg] audio_done', {
              ctxNow: ctxAtDone?.currentTime.toFixed(3),
              queueEnd: omniNextStartRef.current.toFixed(3),
              lastEnded: omniLastSourceEndedRef.current,
            })
            // 用真实 onended 事件等候：如果 audio_done 后还有迟到 chunk，会更新 lastSource，此处也能等到
            let pollCount = 0
            const waitAudioEnded = () => {
              pollCount++
              if (omniLastSourceEndedRef.current) {
                const ctx = omniAudioCtxRef.current
                console.log('[FairyDbg] idle (onended)', { polls: pollCount, ctxNow: ctx?.currentTime.toFixed(3) })
                emitFairy('idle')
              } else {
                if (pollCount === 1 || pollCount % 10 === 0) {
                  const ctx = omniAudioCtxRef.current
                  console.log('[FairyDbg] waiting onended', { n: pollCount, ctxNow: ctx?.currentTime.toFixed(3), queueEnd: omniNextStartRef.current.toFixed(3) })
                }
                window.setTimeout(waitAudioEnded, 100)
              }
            }
            waitAudioEnded()
            // 对话完成后刷新 system prompt，确保下一次 session 的 instructions 包含本轮对话
            refreshSystemPromptRef.current().catch(() => {})

            // ── Omni 持久化：保存本轮 user input + assistant 回复 ──
            if (sessionIdRef.current) {
              const sid = sessionIdRef.current
              const cfg = configRef.current
              const newPairs: SessionMessage[] = []
              const userInput = lastOmniUserInputRef.current.trim()
              const aiText = (msgId
                ? chatMessagesRef.current.find((m) => m.id === msgId)?.content ?? ''
                : ''
              ).trim()
              if (userInput) newPairs.push(makeSessionMessage('user', userInput))

              // AI 音频落盘后再写 DB
              const persistAiMsg = async () => {
                let aiAudioPath: string | undefined
                if (wavBlob && sid) {
                  try {
                    const buf = await wavBlob.arrayBuffer()
                    const wavBytes = new Uint8Array(buf)
                    aiAudioPath = await invoke<string>('save_audio_file', {
                      sessionId: sid,
                      wavBytes,
                      timestamp: aiMsgTimestamp,
                    })
                  } catch { /* 落盘失败不阻塞 */ }
                }
                if (aiText || aiAudioPath) {
                  newPairs.push(makeSessionMessage('assistant', aiText, aiAudioPath))
                }
              }
              persistAiMsg().then(() => {
                if (newPairs.length > 0) {
                  persistedBufferRef.current = [...persistedBufferRef.current, ...newPairs]
                  persistMessages(sid, newPairs).catch(() => {})
                  if (
                    persistedBufferRef.current.length >= TITLE_TRIGGER_MIN_MESSAGES &&
                    (sessionTitleRef.current === '新会话' || sessionTitleRef.current === '')
                  ) {
                    generateSessionTitle(persistedBufferRef.current, cfg)
                      .then((title) => {
                        if (!title) return
                        sessionTitleRef.current = title
                        patchSession(sid, { title }).catch(() => {})
                      })
                      .catch(() => {})
                  }
                }
              }).catch(() => {})
              lastOmniUserInputRef.current = ''
            }
          } else if (payload.status === 'error') {
            omniAiPcmChunksRef.current = []
            omniTextAccRef.current = ''
            omniAgentMsgIdRef.current = null
            setChatMessages((prev) => [...prev, {
              id: crypto.randomUUID(), role: 'system' as const,
              content: `Omni 错误: ${payload.message ?? '未知'}`,
              timestamp: new Date().toISOString(),
            }])
          }
    })

    // omni://user_transcript 由 voice-service 内部消费（调 onTranscript 更新气泡），此处无需重复处理

    return () => {
      disposed = true
      unlisteners.forEach((fn) => fn())
    }
  }, [config.aiMode, emitFairy])

  // ── Right Alt Long-Press → Voice Chat（全局热键，无需窗口聚焦）──
  useEffect(() => {
    let unlistenDown: (() => void) | null = null
    let unlistenUp:   (() => void) | null = null

    let lastDownMs = 0
    const onDown = () => {
      if (pressingRef.current) return
      // 两路（DOM + Rust）可能在同一帧触发，去重
      const now = Date.now()
      if (now - lastDownMs < 50) return
      lastDownMs = now
      pressingRef.current = true
      console.log('[RAlt] keydown received')
      altDownTimeRef.current = Date.now()

      setTimeout(() => {
        if (pressingRef.current && Date.now() - altDownTimeRef.current >= LONG_PRESS_MS) {
          emitFairy('listening')  // 立即给视觉反馈，不等 mic 权限
          // Omni 语音模式：提前刷 system prompt 并写 debug 快照（onUserAudio 无法知道 systemPrompt）
          if (configRef.current.aiMode === 'omni') {
            refreshSystemPrompt().then((sp) => {
              const cfg = configRef.current
              omniDebugInfoRef.current = {
                systemPrompt: sp,
                model: cfg.omniModel,
                voice: cfg.omniVoice || 'Tina',
                ts: new Date().toISOString(),
                items: [],   // audio item 由 onUserAudio 追加
              }
            })
          }
          const svc = getVoiceService()
          svc.startRecording()
        }
      }, LONG_PRESS_MS)
    }

    let lastUpMs = 0
    const onUp = () => {
      if (!pressingRef.current) return
      const now = Date.now()
      if (now - lastUpMs < 50) return
      lastUpMs = now
      pressingRef.current = false
      const holdDuration = Date.now() - altDownTimeRef.current

      if (holdDuration >= LONG_PRESS_MS && fairyStateRef.current === 'listening') {
        const svc = getVoiceService()
        svc.stopAndProcess()
      } else {
        const svc = voiceServiceRef.current
        if (svc) svc.cancel()
        emitFairy('idle')
      }
    }

    // 打断键：RAlt 按住时按 RCtrl → 取消录音/请求
    const onCancel = () => {
      if (!pressingRef.current) return
      console.log('[RAlt] cancel via RCtrl')
      pressingRef.current = false
      const svc = voiceServiceRef.current
      if (svc) svc.cancel()
      try { invoke('omni_stop') } catch {}
      emitFairy('idle')
    }

    // DOM 监听：Solo 窗口聚焦时 WebView2 拦截了 Alt 的系统键路由，
    // Rust WH_KEYBOARD_LL 事件无法送达，用 DOM keydown/keyup 补位
    const onDomDown = (e: KeyboardEvent) => {
      if (e.code === 'AltRight') { e.preventDefault(); onDown() }
      else if (e.code === 'ControlRight' && pressingRef.current) { e.preventDefault(); onCancel() }
    }
    const onDomUp   = (e: KeyboardEvent) => { if (e.code === 'AltRight') { e.preventDefault(); onUp()   } }
    window.addEventListener('keydown', onDomDown)
    window.addEventListener('keyup',   onDomUp)

    let unlistenCancel: (() => void) | null = null
    import('@tauri-apps/api/event').then(({ listen }) => {
      Promise.all([
        listen('ralt-keydown', onDown),
        listen('ralt-keyup',   onUp),
        listen('voice-cancel', onCancel),
      ]).then(([u1, u2, u3]) => {
        unlistenDown = u1
        unlistenUp   = u2
        unlistenCancel = u3
      })
    })

    return () => {
      window.removeEventListener('keydown', onDomDown)
      window.removeEventListener('keyup',   onDomUp)
      unlistenDown?.()
      unlistenUp?.()
      unlistenCancel?.()
    }
  }, [getVoiceService, emitFairy])

  // ── Date Navigation ──

  // 围绕当前选中日 ±14 天预取"有数据"的日期集合，用于前/后日按钮置灰
  const dataDays = useDataDays(selectedDate, 'all')
  const prevDate = (() => { const d = new Date(selectedDate); d.setDate(d.getDate() - 1); return d })()
  const nextDate = (() => { const d = new Date(selectedDate); d.setDate(d.getDate() + 1); return d })()
  const prevHasData = hasDataOrIsToday(prevDate, dataDays)
  const nextHasData = hasDataOrIsToday(nextDate, dataDays)

  const prevDay = () => {
    if (!prevHasData) return
    setSelectedDate(prevDate)
  }
  const nextDay = () => {
    if (!nextHasData) return
    setSelectedDate(nextDate)
  }
  const goToday = () => {
    setSelectedDate(new Date())
  }

  const handleConfigUpdate = useCallback((updates: Partial<AgentConfig>) => {
    setConfig((prev) => {
      const next = updateConfig(prev, updates)
      configRef.current = next
      return next
    })
  }, [])

  const refreshActivities = useCallback(() => {
    fetchActivities(selectedDate)
      .then(setActivities)
      .catch(() => {})
  }, [selectedDate])

  // ── Bilibili 新视频自动写入昼夜表 ──
  useEffect(() => {
    if (!config.biliAutoCreate || biliNewItems.length === 0) return

    const toLocalDateStr = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    const sync = async () => {
      const affectedDates = new Map<string, Date>()

      for (const item of biliNewItems) {
        try {
          const { bvid, date, activity } = dbBiliItemToActivity(item)
          const { eventIds } = await createActivity(date, activity)
          affectedDates.set(toLocalDateStr(date), date)
          if (eventIds[0]) await linkBiliToEvent([bvid], eventIds[0]).catch(() => {})
        } catch (err) {
          console.error('[Bili] 活动写入失败:', err)
        }
      }
      for (const date of affectedDates.values()) {
        try {
          await mergeOverlappingBili(date)
        } catch (err) {
          console.error('[Bili] 合并失败:', err)
        }
      }
      if (affectedDates.has(toLocalDateStr(selectedDate))) {
        refreshActivities()
      }
      clearBiliNew()
    }
    sync()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biliNewItems])

  const handleDeleteMinuteRange = useCallback(async (startMin: number, endMin: number) => {
    const toDelete = activities.filter((a) => a.startMinute < endMin && a.endMinute > startMin)
    await Promise.all(toDelete.map((a) => deleteActivity(a.id)))
    refreshActivities()
  }, [activities, refreshActivities])

  // ── System Prompt Builder（两套协议共用） ──
  const refreshSystemPrompt = useCallback(async () => {
    const cfg = configRef.current
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const today = new Date()
    const toHHmm = (s: string) => s.slice(11, 16)

    const [goalsRes, mtSpans, biliSpans] = await Promise.allSettled([
      fetchGoals('active'),
      fetchManicTimeSpans(today),
      fetchBiliSpans(today),
    ])

    const goals: GoalRecord[] = goalsRes.status === 'fulfilled'
      ? goalsRes.value.map((g) => ({ title: g.title, tags: parseGoalTags(g) }))
      : []
    const mtData = mtSpans.status === 'fulfilled' ? mtSpans.value : []

    const activityTags: ActivityTagRecord[] = mtData
      .filter((s) => s.track === 'tags' && new Date(s.end_at).getTime() >= oneHourAgo)
      .map((s) => ({ startTime: toHHmm(s.start_at), endTime: toHHmm(s.end_at), tag: s.title, subTag: s.group_name ?? undefined }))

    const appUsage: AppUsageRecord[] = mtData
      .filter((s) => s.track === 'apps' && new Date(s.end_at).getTime() >= oneHourAgo)
      .map((s) => ({ startTime: toHHmm(s.start_at), endTime: toHHmm(s.end_at), appName: s.title, windowTitle: s.group_name ?? '' }))

    const biliHistory: BiliRecord[] = biliSpans.status === 'fulfilled'
      ? biliSpans.value
          .filter((s) => new Date(s.start_at).getTime() >= oneHourAgo)
          .map((s) => ({ time: toHHmm(s.start_at), title: s.title, url: `https://www.bilibili.com/video/${s.bvid}` }))
      : []

    const base = buildSystemPrompt(
      cfg.agentName, cfg.agentPersona, cfg.agentCallUser,
      cfg.mainQuest,
      { goals, activityTags, appUsage, biliHistory, presence },
    )
    const history = buildConversationSummary(
      chatMessagesRef.current.map((m) => ({ role: m.role, content: m.content || m.transcript || '' }))
    )
    systemPromptRef.current = history ? `${base}\n\n${history}` : base
    return systemPromptRef.current
  }, [presence])
  refreshSystemPromptRef.current = refreshSystemPrompt

  // ── System Prompt 预热 + 定时刷新（每分钟，供 Omni 模式热读）──
  useEffect(() => {
    refreshSystemPrompt().catch(() => {})
    const timer = setInterval(() => refreshSystemPrompt().catch(() => {}), 60_000)
    return () => clearInterval(timer)
  }, [refreshSystemPrompt])

  // ── Send Message ──
  const handleSend = useCallback(async (text: string) => {
    if (!text.trim()) return

    // 文字输入：添加用户气泡（语音输入的气泡在 onUserAudio 已添加，不重复）
    const isVoiceInput = chatMessages.some(
      (m) => m.role === 'user' && m.transcript === text,
    )
    if (!isVoiceInput) {
      setChatMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'user' as const,
        content: text, timestamp: new Date().toISOString(),
      }])
    }

    setIsProcessing(true)
    // 文字输入也要立即显示思考动画
    if (!isVoiceInput) emitFairy('thinking')

    // D2 + D4 — 构建 system prompt（两套协议共用，结果缓存在 systemPromptRef）
    const systemPrompt = await refreshSystemPrompt()

    // ── Omni 全模态：文字输入直接走 WS，返回音频+文本，不走独立 LLM ──
    if (configRef.current.aiMode === 'omni') {
      const cfg = configRef.current
      const omniApiKey = cfg.omniApiKey || cfg.openaiApiKey
      if (!omniApiKey) {
        setChatMessages((prev) => [...prev, {
          id: crypto.randomUUID(), role: 'system' as const,
          content: 'Omni 模式未配置 API Key', timestamp: new Date().toISOString(),
        }])
        setIsProcessing(false)
        return
      }
      // 记录 debug 快照（text_chunk 建气泡时写入 ChatMessage）
      omniDebugInfoRef.current = {
        systemPrompt,
        model: cfg.omniModel,
        voice: cfg.omniVoice || 'Tina',
        ts: new Date().toISOString(),
        items: [{ type: 'text', content: text, ts: new Date().toISOString() }],
      }
      try {
        await invoke('omni_connect', {
          apiKey: omniApiKey, model: cfg.omniModel,
          voice: cfg.omniVoice || '', systemPrompt,
          tools: toRealtimeTools(TOOL_DEFINITIONS),
        })
        lastOmniUserInputRef.current = text
        await invoke('omni_send_text', { text })
        // 后续由 omni://text_chunk / omni://audio_chunk / omni://status(audio_done) 处理
        // setIsProcessing(false) 在 audio_done handler 里触发
      } catch (err) {
        setChatMessages((prev) => [...prev, {
          id: crypto.randomUUID(), role: 'system' as const,
          content: `Omni 错误: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        }])
        setIsProcessing(false)
      }
      return
    }

    const agentMsgId = crypto.randomUUID()
    const userMsg = createUserMessage(text)
    const capturedSnapshots: ApiRequestSnapshot[] = []

    // ── TTS 流式管线（与 LLM 并行启动）──
    type TtsState = {
      client: ReturnType<typeof createFishTTSTauri>
      audioCtx: AudioContext
      nextStartTime: number
      connected: boolean
      pending: string[]
      finishResolve: (() => void) | null
      timeout: ReturnType<typeof setTimeout> | null
    }
    let tts: TtsState | null = null

    if (config.ttsEnabled && config.fishApiKey) {
      const audioCtx = new AudioContext({ sampleRate: 24000 })
      const state: TtsState = {
        client: null as any,
        audioCtx,
        nextStartTime: audioCtx.currentTime,
        connected: false,
        pending: [],
        finishResolve: null,
        timeout: null,
      }
      state.client = createFishTTSTauri(
        { apiKey: config.fishApiKey, referenceId: config.fishReferenceId, model: config.fishModel },
        (pcm) => {
          const samples = pcm.length / 2
          const buf = audioCtx.createBuffer(1, samples, 24000)
          const ch = buf.getChannelData(0)
          const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
          for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768
          const src = audioCtx.createBufferSource()
          src.buffer = buf
          src.connect(audioCtx.destination)
          const startAt = Math.max(state.nextStartTime, audioCtx.currentTime + 0.005)
          src.start(startAt)
          state.nextStartTime = startAt + buf.duration
        },
        () => { state.finishResolve?.() },
      )
      // 提前建连接（不 await，LLM 跑的同时握手）
      state.client.connect().then(() => {
        state.connected = true
        for (const s of state.pending) state.client.sendText(s).catch(() => {})
        state.pending = []
      }).catch(() => {})
      tts = state
    }

    // 句子缓冲：LLM 流式时按标点切句实时送 TTS
    let sentBuf = ''
    const SENT_RE = /[。！？!?.…]+/
    const pushToTts = (chunk: string, force = false) => {
      if (!tts) return
      sentBuf += chunk
      if (!force && (!SENT_RE.test(sentBuf) || sentBuf.length < 6)) return
      const sentence = sentBuf.trim()
      sentBuf = ''
      if (!sentence) return
      if (tts.connected) {
        tts.client.sendText(sentence).catch(() => {})
      } else {
        tts.pending.push(sentence)
      }
    }

    try {
      const newHistory = await runQueryLoop({
        messages: [...conversationRef.current.slice(-20), userMsg],
        systemPrompt,
        apiOptions: {
          apiKey: config.openaiApiKey ?? '',
          apiBase: config.openaiApiBase,
          model: config.openaiCardModel,
          maxTokens: 8000,
          tools: TOOL_DEFINITIONS,
          onRequestSnapshot: (snap) => capturedSnapshots.push(snap),
        },
        maxIterations: 8,
        onEvent: (event) => {
          if (event.type !== 'textDelta') console.log('[QueryLoop]', event.type, event)
          if (event.type === 'textDelta') {
            setChatMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === agentMsgId)
              if (idx >= 0) {
                return prev.map((m) =>
                  m.id === agentMsgId
                    ? { ...m, content: m.content + event.delta }
                    : m
                )
              }
              return [...prev, {
                id: agentMsgId, role: 'agent' as const,
                content: event.delta, timestamp: new Date().toISOString(),
              }]
            })
            pushToTts(event.delta)
          } else if (event.type === 'toolCallStarted') {
            // 工具调用开始：立即把 sentBuf 里积压的文字刷给 TTS（否则工具执行期间静音）
            pushToTts('', true)
            emitFairy('thinking')
            let argsPreview = ''
            try { argsPreview = JSON.stringify(JSON.parse(event.call.arguments), null, 0) } catch { argsPreview = event.call.arguments }
            setChatMessages((prev) => [...prev, {
              id: `tool-${event.call.id}`, role: 'system' as const,
              content: `⚙ ${event.call.name}(${argsPreview})`,
              timestamp: new Date().toISOString(),
            }])
          } else if (event.type === 'toolCallDone') {
            // 工具完成：把结果追加到对应的系统消息气泡里
            emitFairy('thinking')
            const resultPreview = event.result.length > 300 ? event.result.slice(0, 300) + '…' : event.result
            setChatMessages((prev) => prev.map((m) =>
              m.id === `tool-${event.call.id}`
                ? { ...m, content: m.content + `\n→ ${resultPreview}` }
                : m
            ))
          } else if (event.type === 'error') {
            // API 错误（工具调用后的第二次请求失败是常见原因）→ 直接显示给用户
            setChatMessages((prev) => [...prev, {
              id: crypto.randomUUID(), role: 'system' as const,
              content: `错误：${event.message}`,
              timestamp: new Date().toISOString(),
            }])
          }
        },
        executeTool: (call) => executeAgentTool(call.name, call.arguments),
      })
      // 只保留 user + 最终 assistant 文本消息，丢弃工具调用/结果链，防止 context 爆炸
      // 取最后一条 assistant（最终回复）+ 所有 human turn（无工具结果的 user 消息）
      const compactHistory = newHistory.filter((m) => {
        if (m.type === 'user') return !('toolUseResult' in m && m.toolUseResult !== undefined)
        if (m.type === 'assistant') {
          // 只保留纯文本 assistant 消息（过滤含 tool_use blocks 的中间轮）
          return isAssistantMessage(m) &&
            m.message.content.every((b: any) => b.type === 'text')
        }
        return false
      })
      conversationRef.current = compactHistory.slice(-12) // 最多保留 6 轮对话

      // ── 持久化本轮对话 ──
      if (sessionIdRef.current) {
        const sid = sessionIdRef.current
        const cfg = configRef.current
        // 从 newHistory 提取最终的 user + assistant 文本（去工具链）
        const newPairs: SessionMessage[] = []
        for (const m of newHistory) {
          if (m.type === 'user' && !m.isMeta && m.toolUseResult === undefined) {
            const content = typeof m.message.content === 'string'
              ? m.message.content
              : m.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
            if (content.trim()) newPairs.push(makeSessionMessage('user', content.trim()))
          } else if (isAssistantMessage(m) && m.message.content.every((b: any) => b.type === 'text')) {
            const text = getMessageText(m)
            if (text.trim()) newPairs.push(makeSessionMessage('assistant', text.trim()))
          }
        }
        // 只追加真正新增的消息（去掉和 persistedBufferRef 已有内容重叠的部分）
        const alreadyCount = persistedBufferRef.current.length
        const deduplicated = newPairs.slice(alreadyCount)
        if (deduplicated.length > 0) {
          persistedBufferRef.current = [...persistedBufferRef.current, ...deduplicated]
          persistMessages(sid, deduplicated).catch(() => {})
        }

        // AI 标题：消息数达到阈值且标题仍为默认时才触发（fire-and-forget）
        if (
          persistedBufferRef.current.length >= TITLE_TRIGGER_MIN_MESSAGES &&
          (sessionTitleRef.current === '新会话' || sessionTitleRef.current === '')
        ) {
          generateSessionTitle(persistedBufferRef.current, cfg)
            .then((title) => {
              if (!title) return
              sessionTitleRef.current = title
              patchSession(sid, { title }).catch(() => {})
            })
            .catch(() => {})
        }
      }

      // 把本轮快照 patch 到对应 agent 气泡
      if (capturedSnapshots.length > 0) {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === agentMsgId
              ? { ...m, debugSnapshots: [...capturedSnapshots] }
              : m
          )
        )
      }

      // ── TTS：LLM 完成后 flush 剩余句子，等待音频播完 ──
      if (tts) {
        const replyText = (() => {
          for (let i = newHistory.length - 1; i >= 0; i--) {
            const m = newHistory[i]
            if (isAssistantMessage(m)) return getMessageText(m)
          }
          return ''
        })()

        if (replyText.trim()) {
          emitFairy('speaking', replyText)
          try {
            pushToTts('', true)  // flush 缓冲区剩余文字
            // 确保连接就绪后 flush
            const waitConnected = new Promise<void>((res) => {
              if (tts!.connected) { res(); return }
              const poll = setInterval(() => {
                if (tts!.connected) { clearInterval(poll); res() }
              }, 50)
              setTimeout(() => { clearInterval(poll); res() }, 5000)
            })
            await waitConnected
            await tts.client.flush()
            // 轮询 WebAudio 时间轴：不依赖 WS 关闭事件，音频真正播完立即结束
            await new Promise<void>((resolve) => {
              const s = tts!
              s.finishResolve = resolve  // fish-tts-finish 仍可提前触发
              s.timeout = setTimeout(resolve, 60_000)  // 60s 兜底
              const poll = setInterval(() => {
                // nextStartTime 是最后一帧排队结束的时刻
                // currentTime > nextStartTime + 0.2s 表示所有音频已播完
                if (s.audioCtx.currentTime >= s.nextStartTime + 0.2) {
                  clearInterval(poll)
                  resolve()
                }
              }, 200)
            })
          } catch {
            // TTS 失败不影响主流程
          } finally {
            if (tts.timeout) clearTimeout(tts.timeout)
            tts.audioCtx.close()
            emitFairy('idle')
          }
        } else {
          tts.audioCtx.close()
          emitFairy('idle')
        }
      } else {
        emitFairy('idle')
      }
    } catch (err) {
      setChatMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'system' as const,
        content: `错误: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      }])
    }

    setIsProcessing(false)
  }, [activities, config, chatMessages])

  // ── 切换 / 新建会话 ──
  const switchSession = useCallback(async (sessionId: string) => {
    if (sessionId === sessionIdRef.current) return
    try {
      const msgs = await fetchSessionMessages(sessionId)
      sessionIdRef.current = sessionId
      persistedBufferRef.current = [...msgs]
      const info = sessions.find((s) => s.id === sessionId)
      sessionTitleRef.current = info?.title || '新会话'
      conversationRef.current = sessionMessagesToLLMHistory(msgs).slice(-12)
      setChatMessages(sessionMessagesToChatMessages(msgs, audioDirRef.current))
    } catch {
      // 加载失败静默忽略
    }
  }, [sessions])

  const newSession = useCallback(async () => {
    try {
      const s = await createChatSession()
      sessionIdRef.current = s.id
      sessionTitleRef.current = '新会话'
      persistedBufferRef.current = []
      conversationRef.current = []
      setChatMessages([])
      setSessions((prev) => [s, ...prev])
    } catch {
      // 无网络时降级
      sessionIdRef.current = null
      sessionTitleRef.current = '新会话'
      persistedBufferRef.current = []
      conversationRef.current = []
      setChatMessages([])
    }
  }, [])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh',
      background: hud.backdrop,
      color: theme.textPrimary,
      fontFamily: theme.fontBody,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* 全局 HUD 背景栅格（遮罩成椭圆渐隐） */}
      <div className="hud-grid-bg" style={{ zIndex: 0 }} />
      {/* ── 隐藏摄像头（presence detection） ── */}
      <video
        ref={videoRef}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        muted
        playsInline
      />

      {/* ── Top Bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 40px', height: 60, flexShrink: 0,
        background: `linear-gradient(180deg, rgba(4,10,26,0.85) 0%, rgba(2,6,18,0.75) 100%)`,
        boxShadow: `0 2px 22px rgba(0,229,255,0.10)`,
        position: 'relative',
        overflow: 'visible',
        zIndex: 2,
      }}>
        {/* 顶栏专用 HUD 装饰（斜切端头 + 中央凸起桥 + 底部握手凹陷） */}
        <HudCommandStrip
          color={theme.electricBlue}
          accent={theme.warningOrange}
          centerLabel="SOLO LEVELING SYSTEM · CORE"
          leftBadge="SLS-01"
          rightBadge="v0.1"
        />

        {/* Logo */}
        <img
          src={soloLevelingLogo}
          alt="SOLO LEVELING SYSTEM"
          draggable={false}
          onContextMenu={(e) => {
            e.preventDefault()
            navigator.clipboard.writeText('SOLO LEVELING SYSTEM').catch(() => {})
          }}
          style={{
            height: 40,
            objectFit: 'contain',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            filter: `
              drop-shadow(0 0 8px ${theme.electricBlue}AA)
              drop-shadow(0 0 16px ${theme.shadowPurple}55)
            `,
            cursor: 'default',
          }}
        />

        <NeonRule vertical intensity="soft" style={{ height: 28, margin: '0 4px' }} />

        {/* 日期导航区 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Tooltip content={prevHasData ? '前一天' : '前一天无数据'}>
          <button
            onClick={prevDay}
            disabled={!prevHasData}
            style={{
              ...navBtn,
              opacity: prevHasData ? 1 : 0.3,
              cursor: prevHasData ? 'pointer' : 'not-allowed',
            }}
          >
            <ChevronLeft size={12} />
          </button>
          </Tooltip>
          <Tooltip content="选择日期">
          <button
            ref={dateAnchorRef}
            onClick={() => setDatePickerOpen((v) => !v)}
            style={{
              background: datePickerOpen ? `${theme.electricBlue}10` : 'transparent',
              border: `1px solid ${datePickerOpen ? `${theme.electricBlue}55` : 'transparent'}`,
              borderRadius: 4,
              padding: '2px 6px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => { if (!datePickerOpen) e.currentTarget.style.background = theme.glassHover }}
            onMouseLeave={(e) => { if (!datePickerOpen) e.currentTarget.style.background = 'transparent' }}
          >
            <DataRibbon
              label="DATE"
              value={selectedDate.toLocaleDateString('zh-CN', {
                month: '2-digit', day: '2-digit', weekday: 'short',
              })}
              style={{ minWidth: 88, alignItems: 'center', textAlign: 'center' }}
            />
          </button>
          </Tooltip>
          <Tooltip content={nextHasData ? '后一天' : '后一天无数据'}>
          <button
            onClick={nextDay}
            disabled={!nextHasData}
            style={{
              ...navBtn,
              opacity: nextHasData ? 1 : 0.3,
              cursor: nextHasData ? 'pointer' : 'not-allowed',
            }}
          >
            <ChevronRight size={12} />
          </button>
          </Tooltip>
          <button onClick={goToday} style={{
            ...navBtn,
            color: theme.electricBlue,
            padding: '5px 11px',
            border: `1px solid ${theme.electricBlue}55`,
            background: `${theme.electricBlue}0E`,
            textShadow: `0 0 6px ${theme.electricBlue}AA`,
            letterSpacing: 1.8,
          }}>
            NOW
          </button>
        </div>

        <NeonRule vertical intensity="soft" style={{ height: 28, margin: '0 4px' }} />

        {/* DB 状态读数 */}
        <DataRibbon
          label="DB"
          color={dbStatus === 'live' ? theme.expGreen : dbStatus === 'error' ? theme.dangerRed : theme.textSecondary}
          flicker={dbStatus === 'loading'}
          value={
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: dbStatus === 'live' ? theme.expGreen : dbStatus === 'error' ? theme.dangerRed : theme.textSecondary,
                boxShadow: dbStatus === 'live' ? `0 0 6px ${theme.expGreen}` : undefined,
              }} />
              {dbStatus === 'live' ? 'ONLINE' : dbStatus === 'error' ? 'ERROR' : 'SYNC'}
            </span>
          }
        />

        <NeonRule vertical intensity="soft" style={{ height: 28, margin: '0 4px' }} />

        <div style={{ flex: 1 }} />

        {/* B站历史 */}
        <Tooltip content="B站历史记录">
        <button
          onClick={() => { setShowBili(!showBili); if (!showBili) setShowSettings(false) }}
          style={{
            ...navBtn,
            color: showBili ? theme.electricBlue : theme.textSecondary,
            border: `1px solid ${showBili ? theme.electricBlue + '66' : theme.hudFrameSoft}`,
            background: showBili ? `${theme.electricBlue}10` : 'rgba(0,229,255,0.04)',
            textShadow: showBili ? `0 0 6px ${theme.electricBlue}AA` : undefined,
          }}
        >
          <BiliIcon size={14} />
        </button>
        </Tooltip>

        {/* Settings */}
        <Tooltip content="设置">
        <button
          onClick={() => { setShowSettings(!showSettings); if (!showSettings) setShowBili(false) }}
          style={{
            ...navBtn,
            color: showSettings ? theme.electricBlue : theme.textSecondary,
            border: `1px solid ${showSettings ? theme.electricBlue + '66' : theme.hudFrameSoft}`,
            background: showSettings ? `${theme.electricBlue}10` : 'rgba(0,229,255,0.04)',
            textShadow: showSettings ? `0 0 6px ${theme.electricBlue}AA` : undefined,
          }}
        >
          <Settings size={12} />
        </button>
        </Tooltip>
      </div>

      {/* ── Main: Chart + Right Panel ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Chart */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <DayNightChart
            activities={activities}
            mtSpans={mtSpans}
            biliSpans={biliSpans}
            selectedDate={selectedDate}
            onSpanClick={() => {}}
            onSpanHover={setHoveredTagSpan}
            onAppSpanHover={setHoveredAppSpan}
            onBiliSpanHover={setHoveredBiliSpan}
            trackMode={trackMode}
            onTrackModeChange={setTrackMode}
            pinnedPos={pinnedPos}
            onPinPos={setPinnedPos}
            onDeleteMinuteRange={handleDeleteMinuteRange}
          />
        </div>

        {/* Right Panel: Chat or Settings */}
        <div style={{
          width: 340,
          borderLeft: `1px solid ${theme.hudFrameSoft}`,
          display: 'flex', flexDirection: 'column',
          background: `linear-gradient(180deg, rgba(4,10,26,0.72) 0%, rgba(2,6,14,0.82) 100%)`,
          boxShadow: `inset 1px 0 0 ${theme.electricBlue}18, inset 0 0 40px rgba(0,229,255,0.03)`,
          position: 'relative',
        }}>
          {/* 右侧栏内容：Settings / Bili 优先；否则面板覆盖 Chat */}
          {showSettings ? (
            <SettingsPanel
              config={config}
              onUpdate={handleConfigUpdate}
              onClose={() => setShowSettings(false)}
            />
          ) : (() => {
            // 固定时用 pinnedPos.minute 查对应 span，否则用 hover span
            const pm = pinnedPos?.minute ?? null
            const dtToMin = (dt: string) => { const [h,m] = (dt.split(' ')[1]??'').split(':').map(Number); return h*60+m }
            const pinnedTagSpan = pm != null
              ? mtSpans.find((s) => s.track === 'tags' && pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            // 按当前轨道模式只查对应管线 span
            const pinnedAppSpan = pm != null && trackMode === 'apps'
              ? mtSpans.find((s) => s.track === 'apps' && pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            const pinnedBili = pm != null && trackMode === 'bili'
              ? biliSpans.find((s) => pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            const tagSpan = pinnedTagSpan ?? hoveredTagSpan
            const appSpan = trackMode === 'apps' ? (pinnedAppSpan ?? hoveredAppSpan) : null
            const biliSpan = trackMode === 'bili' ? (pinnedBili ?? hoveredBiliSpan) : null

            const hasDetail = !!(tagSpan || appSpan || biliSpan)
            return (
              <>
                {/* 始终挂载 ChatPanel，避免卸载导致摄像头预览状态丢失 */}
                <div style={{ display: hasDetail ? 'none' : 'flex', flexDirection: 'column', height: '100%' }}>
                  <ChatPanel
                    messages={chatMessages}
                    isProcessing={isProcessing}
                    onSend={handleSend}
                    cameraReady={presence.ready}
                    cameraPresent={presence.state === 'present'}
                    cameraWindowOpen={cameraWindowOpen}
                    onToggleCamera={toggleCameraWindow}
                    ttsEnabled={config.ttsEnabled}
                    onToggleTts={() => handleConfigUpdate({ ttsEnabled: !config.ttsEnabled })}
                    sessionsOpen={pickerOpen}
                    onOpenSessions={() => {
                      if (pickerOpen) {
                        setPickerOpen(false)
                      } else {
                        getRecentChatSessions(50)
                          .then((s) => setSessions(s))
                          .catch(() => {})
                        setPickerOpen(true)
                      }
                    }}
                  />
                </div>
                {hasDetail && (
                  <div style={{
                    height: '100%', position: 'relative',
                    padding: '4px 4px',
                    fontFamily: theme.fontBody,
                  }}>
                    <HudFrame
                      color={theme.electricBlue}
                      accent={theme.warningOrange}
                      topLabel="DETAIL · SCAN"
                      showNotchTop
                      showNotchBottom={false}
                      notchWidth={70}
                      notchDepth={7}
                      cornerSize={16}
                    />
                    <div style={{
                      height: '100%', overflow: 'auto',
                      display: 'flex', flexDirection: 'column',
                      padding: '8px 4px',
                    }}>
                      {tagSpan && <SpanDetailPanel span={tagSpan} />}
                      {appSpan && <AppHoverPanel span={appSpan} date={selectedDate} />}
                      {biliSpan && <BiliVideoPanel span={biliSpan} />}
                      <div style={{ flex: 1 }} />
                    </div>
                  </div>
                )}
              </>
            )
          })()}
        </div>
      </div>

      {/* ── Session Picker（侧栏，停靠在聊天面板左侧，不遮挡聊天窗口）── */}
      {pickerOpen && (
        <SessionPicker
          sessions={sessions}
          currentSessionId={sessionIdRef.current}
          dockRight={340}
          onSelect={(id) => { switchSession(id) }}
          onNewSession={() => { newSession() }}
          onDelete={async (id) => {
            try { await deleteChatSession(id) } catch {}
            setSessions((prev) => {
              const remaining = prev.filter((s) => s.id !== id)
              if (sessionIdRef.current === id) {
                if (remaining.length > 0) {
                  switchSession(remaining[0].id)
                } else {
                  newSession()
                }
              }
              return remaining
            })
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      <CloseConfirmModal />

      {datePickerOpen && (
        <DatePickerPopover
          anchorRef={dateAnchorRef}
          value={selectedDate}
          onChange={(d) => setSelectedDate(d)}
          onClose={() => setDatePickerOpen(false)}
        />
      )}

      <BiliHistoryDialog
        open={showBili}
        initialDate={selectedDate}
        isLoading={biliLoading}
        error={biliError}
        lastUpdated={biliLastUpdated}
        countdown={biliCountdown}
        intervalSeconds={biliIntervalSec}
        isPaused={biliPaused}
        windowClosed={biliWinClosed}
        cursor={biliCursor}
        hasMoreRemote={biliHasMoreRemote}
        onPause={pauseBili}
        onResume={resumeBili}
        onRefresh={refreshBili}
        onSetInterval={setBiliInterval}
        onClose={() => setShowBili(false)}
      />
    </div>
  )
}

// 顶栏 HUD 风格按钮：切角方框 + mono 排版 + cyan 边框
const navBtn: React.CSSProperties = {
  background: 'rgba(0,229,255,0.04)',
  border: `1px solid ${theme.hudFrameSoft}`,
  color: theme.textSecondary,
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: theme.fontMono,
  fontWeight: 700,
  letterSpacing: 1,
  padding: '5px 7px',
  lineHeight: 1,
  clipPath: 'polygon(4px 0, calc(100% - 4px) 0, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0 calc(100% - 4px), 0 4px)',
  transition: 'color 0.15s, background 0.15s, border-color 0.15s',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 26,
  minHeight: 24,
}
