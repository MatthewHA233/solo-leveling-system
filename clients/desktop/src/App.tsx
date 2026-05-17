// ══════════════════════════════════════════════
// Solo Agent — Desktop 客户端（务实版）
// 核心：昼夜表 + AI 聊天整理
// ══════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react'
import { Boxes, ChevronLeft, ChevronRight, Link2, Settings } from 'lucide-react'
import BiliIcon from './components/icons/BiliIcon'
import {
  fetchPerceptionSpans, fetchBiliSpans, fetchGoals, parseGoalTags,
  fetchActivityPalette, fetchActivityBlocks, paintActivityBlocks, eraseActivityBlocks,
  fetchPlanNodes, fetchPlannedBlocks, paintPlannedBlocks, erasePlannedBlocks,
  fetchSyncLinks, fetchSyncPeers,
} from './lib/local-api'
import type { PerceptionSpan, BiliSpan, ModelCallLog, LinkedDevice, SyncPeer } from './lib/local-api'
import type { ActivityBlock, ActivityPalette, PlanNode, PlannedBlock, RecordLayer } from './types'
import { theme, hud } from './theme'

// Agent
import { getDashScopeApiKey, getOmniApiKey, loadConfig, updateConfig } from './lib/agent/agent-config'
import type { AgentConfig } from './lib/agent/agent-config'
import { getFeatureModel, logModelUsage, realtimeUsageToDashScope, type RealtimeUsage } from './lib/model-audit'
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
  cleanupEmptyChatSessions,
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
import DatePickerPopover, { invalidateActivityRangeCache } from './components/DatePickerPopover'
import SpanDetailPanel from './components/SpanDetailPanel'
import AppHoverPanel from './components/AppHoverPanel'
import BiliVideoPanel from './components/BiliVideoPanel'
import BiliHistoryDialog from './components/BiliHistoryDialog'
import ModelDialog from './components/ModelDialog'
import SyncPeerDialog from './components/SyncPeerDialog'
import { useBiliHistory } from './lib/bilibili/useHistory'
import ActivityTagPalette from './components/ActivityTagPalette'
import PlanNodePalette from './components/PlanNodePalette'
import ActivityToast from './components/ActivityToast'
import type { FairyState } from './components/FairyHUD'
import { HudFrame, NeonRule } from './components/hud'
import { CloseConfirmModal } from './components/CloseConfirmModal'
import Tooltip from './components/Tooltip'
import { usePresenceDetection } from './hooks/usePresenceDetection'
import { useDataDays, hasDataOrIsToday } from './hooks/useDataDays'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import appIcon from './assets/app-icon.png'

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
  readonly usage?: ModelCallLog                   // 该 AI 回复对应的模型调用审计快照
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
      ...(m.usage ? { usage: m.usage } : {}),
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

const ACTIVITY_BLOCK_MINUTES = 5

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

function activityBlocksToContextRecords(
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

export default function App() {
  // ── Data ──
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const dateAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [activityPalette, setActivityPalette] = useState<ActivityPalette>({ categories: [], tags: [] })
  const [activityBlocks, setActivityBlocks] = useState<ActivityBlock[]>([])
  const [plannedBlocks, setPlannedBlocks] = useState<PlannedBlock[]>([])
  const [planNodes, setPlanNodes] = useState<PlanNode[]>([])
  const [recordLayer, setRecordLayer] = useState<RecordLayer>('actual')
  const [editMode, setEditMode] = useState(false)
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null)
  const [selectedProjectTagId, setSelectedProjectTagId] = useState<number | null>(null)
  const [selectedPlanNodeId, setSelectedPlanNodeId] = useState<number | null>(null)
  const [paintToast, setPaintToast] = useState<{ id: number; startMin: number; endMin: number; path: string; color: string; mode: 'paint' | 'erase' } | null>(null)
  // 撤回 / 恢复 — 栈深 5
  const [undoStack, setUndoStack] = useState<readonly ActivityBlock[][]>([])
  const [redoStack, setRedoStack] = useState<readonly ActivityBlock[][]>([])
  const [planUndoStack, setPlanUndoStack] = useState<readonly PlannedBlock[][]>([])
  const [planRedoStack, setPlanRedoStack] = useState<readonly PlannedBlock[][]>([])
  const [perceptionSpans, setPerceptionSpans] = useState<PerceptionSpan[]>([])
  const [biliSpans, setBiliSpans] = useState<BiliSpan[]>([])
  // 悬浮预览（hover 触发）
  const [hoveredTagSpan, setHoveredTagSpan] = useState<PerceptionSpan | null>(null)
  const [hoveredAppSpan, setHoveredAppSpan] = useState<PerceptionSpan | null>(null)
  // 鼠标当前所在的整分钟（每张截图对应一分钟），用于右栏面板按光标精度切图
  const [hoveredAppMinute, setHoveredAppMinute] = useState<number | null>(null)
  const [hoveredBiliSpan, setHoveredBiliSpan] = useState<BiliSpan | null>(null)
  // 管线轨道模式
  const [trackMode, setTrackMode] = useState<'apps' | 'bili'>('apps')
  // 固定横线位置
  const [pinnedPos, setPinnedPos] = useState<{ col: number; y: number; minute: number } | null>(null)
  const [dbStatus, setDbStatus] = useState<'loading' | 'live' | 'error'>('loading')

  // ── Layout ──
  const [showSettings, setShowSettings] = useState(false)
  const [showBili, setShowBili] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const [showSync, setShowSync] = useState(false)
  const [syncAnchorRect, setSyncAnchorRect] = useState<DOMRect | null>(null)
  const syncTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [linkedDevices, setLinkedDevices] = useState<LinkedDevice[]>([])
  const [discoveredPeers, setDiscoveredPeers] = useState<SyncPeer[]>([])
  const [syncingDeviceIds, setSyncingDeviceIds] = useState<ReadonlySet<string>>(() => new Set())

  // 昼夜表右栏 BiliVideoPanel 直达 B 站历史详情用：每次点击都 bump key，
  // 触发 BiliHistoryDialog 内部 useEffect 把 date+detailSpan+detailMode 一次性灌入。
  // mode=null：单纯查看详情；'theater'：进影院；'transcribe'：开转录。
  const [pendingBiliDetail, setPendingBiliDetail] = useState<
    { key: number; span: BiliSpan; mode: 'theater' | 'transcribe' | null } | null
  >(null)
  const requestBiliHistoryDetail = useCallback(
    (span: BiliSpan, mode: 'theater' | 'transcribe' | null) => {
      setPendingBiliDetail({ key: Date.now(), span, mode })
      setShowBili(true)
      setShowSettings(false)
      setShowModels(false)
    },
    [],
  )
  const closeBiliDialog = useCallback(() => {
    setShowBili(false)
    setPendingBiliDetail(null)
  }, [])


  // ── Activity Editor ──

  // ── Bilibili 后台持久监控 ──
  const [config, setConfig] = useState<AgentConfig>(loadConfig)

  const {
    isLoading: biliLoading, error: biliError,
    lastUpdated: biliLastUpdated, countdown: biliCountdown,
    intervalSeconds: biliIntervalSec, isPaused: biliPaused,
    windowClosed: biliWinClosed, cursor: biliCursor, hasMoreRemote: biliHasMoreRemote,
    scanProgress: biliScanProgress,
    scanSnapshotBvids: biliScanSnapshotBvids,
    scanLastPage: biliScanLastPage,
    pause: pauseBili, resume: resumeBili,
    refresh: refreshBili,
    fullScan: biliFullScan,
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
  const audioDirRef = useRef<string>('')                 // 音频根目录（Rust data_local/solo-leveling-system/audio）
  const pendingAudioRef = useRef<Map<string, { audioPath: string; durationMs: number }>>(new Map())
  const [sessions, setSessions] = useState<readonly ChatSessionInfo[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  // ── Presence Detection ──
  const { presence, videoRef } = usePresenceDetection(config.overlayEnabled)

  // 预热 mic 权限：防止首次长按 Alt 时弹出权限弹窗导致无反应
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) return
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => stream.getTracks().forEach(t => t.stop()))
      .catch(() => {})
  }, [])

  // 启动时同步 Windows 图形偏好（HKCU UserGpuPreferences）+ 探测当前 GPU
  // 首次配置：5 秒小 toast 提示「已启用独显高性能，下次启动生效」
  // 当前会话已是独显但开关关掉的 / 当前会话不是独显但开关开了的：标记 pending-restart
  // 让 HudVideoPlayer 等"重活"组件看到时再单独提示用户重启
  const [gpuToastVisible, setGpuToastVisible] = useState(false)
  useEffect(() => {
    const detectCurrentGpuIsDiscrete = (): boolean => {
      try {
        const c = document.createElement('canvas')
        const gl = c.getContext('webgl') as WebGLRenderingContext | null
        const ext = gl?.getExtension('WEBGL_debug_renderer_info')
        if (!gl || !ext) return false
        const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
        // NVIDIA / AMD / Radeon → 独显；Intel → 集显
        return /NVIDIA|AMD|Radeon|GeForce/i.test(renderer)
      } catch {
        return false
      }
    }

    ;(async () => {
      try {
        const before = await invoke<{
          self_exe_pref_set: boolean
          webview2_path: string | null
          webview2_pref_set: boolean
        }>('get_gpu_pref_status')
        const wasFullyConfigured = before.self_exe_pref_set
          && (before.webview2_path === null || before.webview2_pref_set)
        await invoke('set_gpu_pref_high_performance', { enable: config.useDiscreteGpu })

        // 标记当前会话是否处于"等重启"状态：开关开但还没切到独显
        const onDiscrete = detectCurrentGpuIsDiscrete()
        if (config.useDiscreteGpu && !onDiscrete) {
          window.sessionStorage.setItem('solo:gpuPendingRestart', '1')
        } else {
          window.sessionStorage.removeItem('solo:gpuPendingRestart')
        }

        if (config.useDiscreteGpu && !wasFullyConfigured) {
          setGpuToastVisible(true)  // 常驻显示，等用户主动选择"立即重启"或"稍后"
        }
      } catch {
        // 非 Windows / 注册表权限错误时静默
      }
    })()
    // 仅启动时跑一次；后续改 toggle 由 SettingsPanel 自己直接调命令
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Fetch Activities + Perception Spans ──
  const isToday = useCallback((date: Date) => {
    const now = new Date()
    return date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
  }, [])

  const refreshPerceptionSpans = useCallback(() => {
    fetchPerceptionSpans(selectedDate)
      .then(setPerceptionSpans)
      .catch(() => {})
    fetchBiliSpans(selectedDate)
      .then(setBiliSpans)
      .catch(() => {})
  }, [selectedDate])

  useEffect(() => {
    setDbStatus('loading')
    fetchActivityBlocks(selectedDate)
      .then((data) => { setActivityBlocks(data); setDbStatus('live') })
      .catch((err) => { console.error('获取活动块失败:', err); setActivityBlocks([]); setDbStatus('error') })
    refreshPerceptionSpans()
  }, [selectedDate])

  // 日期切换时同步计划层块；实际记录沿用上面的主数据加载流程
  useEffect(() => {
    fetchPlannedBlocks(selectedDate)
      .then(setPlannedBlocks)
      .catch((err) => { console.error('[Plans] 获取计划块失败:', err); setPlannedBlocks([]) })
  }, [selectedDate])

  // 启动时拉一次标签库
  useEffect(() => {
    fetchActivityPalette().then(setActivityPalette).catch(() => {})
  }, [])

  useEffect(() => {
    if (selectedProjectTagId != null || activityPalette.tags.length === 0) return
    setSelectedProjectTagId(activityPalette.tags[0].id)
  }, [selectedProjectTagId, activityPalette.tags])

  const refreshPlanNodes = useCallback((projectTagId = selectedProjectTagId) => {
    if (projectTagId == null) {
      setPlanNodes([])
      return
    }
    fetchPlanNodes(projectTagId)
      .then((nodes) => {
        setPlanNodes(nodes)
        setSelectedPlanNodeId((id) => id != null && nodes.some((node) => node.id === id) ? id : null)
      })
      .catch((err) => { console.error('[Plans] 获取计划节点失败:', err); setPlanNodes([]) })
  }, [selectedProjectTagId])

  useEffect(() => {
    refreshPlanNodes()
  }, [refreshPlanNodes])

  // Ctrl+E 切换编辑模式
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        setEditMode((m) => !m)
      } else if (e.key === 'Escape' && editMode) {
        setEditMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editMode])

  // 退出编辑模式时清画笔；进入编辑模式时解锁右栏详情（让标签库正常占据右栏）
  useEffect(() => {
    if (editMode) {
      setPinnedPos(null)
    } else {
      setSelectedTagId(null)
      setSelectedPlanNodeId(null)
    }
  }, [editMode])

  const refreshActivityBlocks = useCallback(() => {
    fetchActivityBlocks(selectedDate).then(setActivityBlocks).catch(() => {})
  }, [selectedDate])

  const refreshPlannedBlocks = useCallback(() => {
    fetchPlannedBlocks(selectedDate).then(setPlannedBlocks).catch(() => {})
  }, [selectedDate])

  const refreshActivityPalette = useCallback(() => {
    fetchActivityPalette().then(setActivityPalette).catch(() => {})
  }, [])

  // 同步设备链接状态：进程内常驻，供顶栏徽章 + SyncPeerDialog 共用
  useEffect(() => {
    fetchSyncLinks().then(setLinkedDevices).catch(() => {})
    fetchSyncPeers().then(setDiscoveredPeers).catch(() => {})
  }, [])

  // 监听后端 sync:* 事件：
  //   - sync:imported   → 我这边被对端 push 写入了数据，全局刷新
  //   - sync:started    → 我作为发起方开始同步某 device_id（顶栏波形流动）
  //   - sync:finished   → 同步结束，从 syncing 集合移除并刷新 links
  useEffect(() => {
    const cleanups: Array<() => void> = []
    import('@tauri-apps/api/event').then(({ listen }) => {
      const promises = [
        listen<{ device_id?: string }>('sync:imported', () => {
          refreshActivityPalette()
          refreshActivityBlocks()
          refreshPlannedBlocks()
          refreshPlanNodes()
          invalidateActivityRangeCache(selectedDate)
          fetchSyncLinks().then(setLinkedDevices).catch(() => {})
        }),
        listen<{ device_id: string }>('sync:started', (e) => {
          const id = e.payload?.device_id
          if (!id) return
          setSyncingDeviceIds((prev) => {
            const next = new Set(prev)
            next.add(id)
            return next
          })
        }),
        listen<{ device_id: string }>('sync:finished', (e) => {
          const id = e.payload?.device_id
          if (id) {
            setSyncingDeviceIds((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
          }
          fetchSyncLinks().then(setLinkedDevices).catch(() => {})
        }),
      ]
      Promise.all(promises).then((unlisteners) => {
        cleanups.push(...unlisteners)
      }).catch(() => {})
    })
    return () => { cleanups.forEach((fn) => fn()) }
  }, [refreshActivityPalette, refreshActivityBlocks, refreshPlannedBlocks, refreshPlanNodes, selectedDate])

  // 定时刷新 discovered peers（每 5 秒）—— 顶栏判断 linked 设备在线/离线
  useEffect(() => {
    const timer = setInterval(() => {
      fetchSyncPeers().then(setDiscoveredPeers).catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [])

  // 切换日期 / 进出编辑模式 → 清空撤回栈（栈是当日操作的快照，跨日无意义）
  useEffect(() => {
    setUndoStack([])
    setRedoStack([])
    setPlanUndoStack([])
    setPlanRedoStack([])
  }, [selectedDate, editMode])

  /** 计算从 from 状态变到 to 状态需要的 paint/erase 操作 */
  const computeBlocksDelta = useCallback((from: ActivityBlock[], to: ActivityBlock[]) => {
    const fromMap = new Map(from.map((b) => [b.minute, b.tagId]))
    const toMap = new Map(to.map((b) => [b.minute, b.tagId]))
    const paintByTag = new Map<number, number[]>()
    const eraseMinutes: number[] = []
    for (const [m, fromTag] of fromMap) {
      const toTag = toMap.get(m)
      if (toTag === undefined) {
        eraseMinutes.push(m)
      } else if (toTag !== fromTag) {
        if (!paintByTag.has(toTag)) paintByTag.set(toTag, [])
        paintByTag.get(toTag)!.push(m)
      }
    }
    for (const [m, toTag] of toMap) {
      if (!fromMap.has(m)) {
        if (!paintByTag.has(toTag)) paintByTag.set(toTag, [])
        paintByTag.get(toTag)!.push(m)
      }
    }
    return { paintByTag, eraseMinutes }
  }, [])

  const applyBlocksDelta = useCallback(async (
    fromBlocks: ActivityBlock[],
    toBlocks: ActivityBlock[],
  ) => {
    const { paintByTag, eraseMinutes } = computeBlocksDelta(fromBlocks, toBlocks)
    const tasks: Promise<unknown>[] = []
    if (eraseMinutes.length > 0) tasks.push(eraseActivityBlocks(selectedDate, eraseMinutes))
    for (const [tagId, mins] of paintByTag) {
      if (mins.length > 0) tasks.push(paintActivityBlocks(selectedDate, mins, tagId))
    }
    await Promise.all(tasks)
    invalidateActivityRangeCache(selectedDate)
  }, [selectedDate, computeBlocksDelta])

  const applyPlannedBlocksDelta = useCallback(async (
    fromBlocks: PlannedBlock[],
    toBlocks: PlannedBlock[],
  ) => {
    const fromMap = new Map(fromBlocks.map((b) => [b.minute, b.planNodeId]))
    const toMap = new Map(toBlocks.map((b) => [b.minute, b.planNodeId]))
    const paintByNode = new Map<number, number[]>()
    const eraseMinutes: number[] = []
    for (const [m, fromNode] of fromMap) {
      const toNode = toMap.get(m)
      if (toNode === undefined) {
        eraseMinutes.push(m)
      } else if (toNode !== fromNode) {
        if (!paintByNode.has(toNode)) paintByNode.set(toNode, [])
        paintByNode.get(toNode)!.push(m)
      }
    }
    for (const [m, toNode] of toMap) {
      if (!fromMap.has(m)) {
        if (!paintByNode.has(toNode)) paintByNode.set(toNode, [])
        paintByNode.get(toNode)!.push(m)
      }
    }
    const tasks: Promise<unknown>[] = []
    if (eraseMinutes.length > 0) tasks.push(erasePlannedBlocks(selectedDate, eraseMinutes))
    for (const [planNodeId, mins] of paintByNode) {
      if (mins.length > 0) tasks.push(paintPlannedBlocks(selectedDate, mins, planNodeId))
    }
    await Promise.all(tasks)
    invalidateActivityRangeCache(selectedDate)
  }, [selectedDate])

  const handleUndo = useCallback(() => {
    if (recordLayer === 'plan') {
      setPlanUndoStack((undoPrev) => {
        if (undoPrev.length === 0) return undoPrev
        const popped = undoPrev[undoPrev.length - 1]
        const current = plannedBlocks
        setPlanRedoStack((redoPrev) => [...redoPrev.slice(-4), current])
        setPlannedBlocks(popped)
        applyPlannedBlocksDelta(current, popped)
          .then(() => refreshActivityPalette())
          .catch((e) => {
            console.error('[PlanUndo] 后端失败:', e)
            refreshPlannedBlocks()
          })
        return undoPrev.slice(0, -1)
      })
      return
    }

    setUndoStack((undoPrev) => {
      if (undoPrev.length === 0) return undoPrev
      const popped = undoPrev[undoPrev.length - 1]
      const current = activityBlocks
      setRedoStack((redoPrev) => [...redoPrev.slice(-4), current])
      setActivityBlocks(popped)
      applyBlocksDelta(current, popped)
        .then(() => refreshActivityPalette())
        .catch((e) => {
          console.error('[Undo] 后端失败:', e)
          refreshActivityBlocks()
        })
      return undoPrev.slice(0, -1)
    })
  }, [recordLayer, plannedBlocks, activityBlocks, applyPlannedBlocksDelta, applyBlocksDelta, refreshPlannedBlocks, refreshActivityBlocks, refreshActivityPalette])

  const handleRedo = useCallback(() => {
    if (recordLayer === 'plan') {
      setPlanRedoStack((redoPrev) => {
        if (redoPrev.length === 0) return redoPrev
        const popped = redoPrev[redoPrev.length - 1]
        const current = plannedBlocks
        setPlanUndoStack((undoPrev) => [...undoPrev.slice(-4), current])
        setPlannedBlocks(popped)
        applyPlannedBlocksDelta(current, popped)
          .then(() => refreshActivityPalette())
          .catch((e) => {
            console.error('[PlanRedo] 后端失败:', e)
            refreshPlannedBlocks()
          })
        return redoPrev.slice(0, -1)
      })
      return
    }

    setRedoStack((redoPrev) => {
      if (redoPrev.length === 0) return redoPrev
      const popped = redoPrev[redoPrev.length - 1]
      const current = activityBlocks
      setUndoStack((undoPrev) => [...undoPrev.slice(-4), current])
      setActivityBlocks(popped)
      applyBlocksDelta(current, popped)
        .then(() => refreshActivityPalette())
        .catch((e) => {
          console.error('[Redo] 后端失败:', e)
          refreshActivityBlocks()
        })
      return redoPrev.slice(0, -1)
    })
  }, [recordLayer, plannedBlocks, activityBlocks, applyPlannedBlocksDelta, applyBlocksDelta, refreshPlannedBlocks, refreshActivityBlocks, refreshActivityPalette])

  // 编辑模式下监听 Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
  useEffect(() => {
    if (!editMode) return
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editMode, handleUndo, handleRedo])

  /**
   * 一次拖拽提交：paint + erase 两组同时下发。
   * 乐观更新 — 立即改本地 state，后端调用失败再回滚。
   */
  const handleApplyDrag = useCallback((spec: {
    paintMinutes: number[]
    paintTagId: number | null
    eraseMinutes: number[]
    rangeStartMin: number
    rangeEndMin: number
  }) => {
    if (spec.paintMinutes.length === 0 && spec.eraseMinutes.length === 0) return

    const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
    const nowIso = new Date().toISOString()

    if (recordLayer === 'plan') {
      const snapshot = plannedBlocks
      setPlanUndoStack((prev) => [...prev.slice(-4), snapshot])
      setPlanRedoStack([])
      setPlannedBlocks((prev) => {
        const eraseSet = new Set(spec.eraseMinutes)
        const paintSet = new Set(spec.paintMinutes)
        const filtered = prev.filter((b) => !eraseSet.has(b.minute) && !paintSet.has(b.minute))
        const added = spec.paintTagId != null
          ? spec.paintMinutes.map((m) => ({
              date: dateStr,
              minute: m,
              planNodeId: spec.paintTagId!,
              note: null,
              createdAt: nowIso,
            }))
          : []
        return [...filtered, ...added].sort((a, b) => a.minute - b.minute)
      })

      let toastPath = '已清除计划'
      let toastColor = theme.textMuted
      let toastMode: 'paint' | 'erase' = 'erase'
      if (spec.paintTagId != null && spec.paintMinutes.length > 0) {
        const node = planNodes.find((n) => n.id === spec.paintTagId)
        const tag = node ? activityPalette.tags.find((t) => t.id === node.projectTagId) : null
        const cat = tag ? activityPalette.categories.find((c) => c.id === tag.categoryId) : null
        toastPath = `计划：${tag?.fullPath ?? ''}`
        toastColor = cat?.color ?? theme.warningOrange
        toastMode = 'paint'
      }
      setPaintToast({
        id: Date.now(),
        startMin: spec.rangeStartMin,
        endMin: spec.rangeEndMin,
        path: toastPath,
        color: toastColor,
        mode: toastMode,
      })

      const tasks: Promise<unknown>[] = []
      if (spec.paintMinutes.length > 0 && spec.paintTagId != null) {
        tasks.push(paintPlannedBlocks(selectedDate, spec.paintMinutes, spec.paintTagId))
      }
      if (spec.eraseMinutes.length > 0) {
        tasks.push(erasePlannedBlocks(selectedDate, spec.eraseMinutes))
      }
      Promise.all(tasks)
        .then(() => {
          invalidateActivityRangeCache(selectedDate)
          if (spec.paintTagId != null) refreshActivityPalette()
        })
        .catch((e) => {
          console.error('[ApplyPlanDrag] 后端失败，回滚:', e)
          setPlannedBlocks(snapshot)
          refreshPlannedBlocks()
        })
      return
    }

    // 1) 乐观更新本地块；同时把"操作前快照"推入 undo 栈（保留最近 5 步），并清空 redo 栈
    const snapshot = activityBlocks
    setUndoStack((prev) => [...prev.slice(-4), snapshot])
    setRedoStack([])
    setActivityBlocks((prev) => {
      const eraseSet = new Set(spec.eraseMinutes)
      const paintSet = new Set(spec.paintMinutes)
      const filtered = prev.filter((b) => !eraseSet.has(b.minute) && !paintSet.has(b.minute))
      const added = spec.paintTagId != null
        ? spec.paintMinutes.map((m) => ({
            date: dateStr,
            minute: m,
            tagId: spec.paintTagId!,
            note: null,
            createdAt: nowIso,
          }))
        : []
      return [...filtered, ...added].sort((a, b) => a.minute - b.minute)
    })

    // 2) 准备 toast：以 paint 为主，否则展示 erase
    let toastPath = '已清除'
    let toastColor = theme.textMuted
    let toastMode: 'paint' | 'erase' = 'erase'
    if (spec.paintTagId != null && spec.paintMinutes.length > 0) {
      const tag = activityPalette.tags.find((t) => t.id === spec.paintTagId)
      const cat = tag ? activityPalette.categories.find((c) => c.id === tag.categoryId) : null
      toastPath = tag?.fullPath ?? ''
      toastColor = cat?.color ?? theme.electricBlue
      toastMode = 'paint'
    }
    setPaintToast({
      id: Date.now(),
      startMin: spec.rangeStartMin,
      endMin: spec.rangeEndMin,
      path: toastPath,
      color: toastColor,
      mode: toastMode,
    })

    // 3) 后端调用 — 失败回滚 + 重新拉取
    const tasks: Promise<unknown>[] = []
    if (spec.paintMinutes.length > 0 && spec.paintTagId != null) {
      tasks.push(paintActivityBlocks(selectedDate, spec.paintMinutes, spec.paintTagId))
    }
    if (spec.eraseMinutes.length > 0) {
      tasks.push(eraseActivityBlocks(selectedDate, spec.eraseMinutes))
    }
    Promise.all(tasks)
      .then(() => {
        // 后端写入成功 — 异步刷新 palette 让 last_used_at 排序最新
        invalidateActivityRangeCache(selectedDate)
        if (spec.paintTagId != null) refreshActivityPalette()
      })
      .catch((e) => {
        console.error('[ApplyDrag] 后端失败，回滚:', e)
        setActivityBlocks(snapshot)
        refreshActivityBlocks()
      })
  }, [selectedDate, recordLayer, activityBlocks, plannedBlocks, planNodes, activityPalette, refreshActivityBlocks, refreshPlannedBlocks, refreshActivityPalette])

  // 今天的数据实时轮询（15 秒）
  useEffect(() => {
    if (!isToday(selectedDate)) return
    const timer = setInterval(refreshPerceptionSpans, 15000)
    return () => clearInterval(timer)
  }, [selectedDate, refreshPerceptionSpans, isToday])

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
            handleSend(text, true)
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
  }, [emitFairy])

  // ── Omni 全模态模式：监听 AI 回复事件 ──
  const omniAudioCtxRef = useRef<AudioContext | null>(null)
  const omniNextStartRef = useRef<number>(0)
  const omniLastSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const omniLastSourceEndedRef = useRef<boolean>(true)
  const omniTextAccRef = useRef<string>('')
  const omniAiPcmChunksRef = useRef<Uint8Array[]>([])
  const omniAgentMsgIdRef = useRef<string | null>(null)   // 当前 AI 回复气泡的消息 ID
  const omniDebugInfoRef = useRef<OmniDebugInfo | null>(null)  // 本轮 Omni 上下文快照（随气泡写入）
  const omniLastUsageRef = useRef<ModelCallLog | null>(null)   // 本轮 Omni 模型审计快照（随气泡持久化）
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

    // Omni Realtime 一轮结束携带 usage：写入审计 + 立即贴到当前 agent 气泡
    registerListen<{ model: string; usage: RealtimeUsage }>('omni://usage', ({ payload }) => {
      const startedMs = altDownTimeRef.current || Date.now()
      void logModelUsage({
        feature: 'fairy_omni_chat',
        modelId: payload.model,
        startedAt: new Date(startedMs).toISOString(),
        durationMs: Date.now() - startedMs,
        usage: realtimeUsageToDashScope(payload.usage),
        success: true,
        metadata: { source: 'omni-realtime' },
      }).then((call) => {
        if (!call) return
        omniLastUsageRef.current = call
        // 优先贴到当前在写的气泡，否则兜底到最后一条 agent 气泡
        const targetId = omniAgentMsgIdRef.current
          ?? [...chatMessagesRef.current].reverse().find((m) => m.role === 'agent')?.id
          ?? null
        if (targetId) {
          setChatMessages((prev) =>
            prev.map((m) => m.id === targetId ? { ...m, usage: call } : m)
          )
        }
      })
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

              // AI 音频落盘后再写 DB；usage 若稍晚到（最多等 1500ms）也能附上
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
                  let usage = omniLastUsageRef.current
                  if (!usage) {
                    const deadline = Date.now() + 1500
                    while (!usage && Date.now() < deadline) {
                      await new Promise((r) => setTimeout(r, 80))
                      usage = omniLastUsageRef.current
                    }
                  }
                  const aiMsg = makeSessionMessage('assistant', aiText, aiAudioPath)
                  newPairs.push(usage ? { ...aiMsg, usage } : aiMsg)
                  omniLastUsageRef.current = null
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

  // ── System Prompt Builder（两套协议共用） ──
  const refreshSystemPrompt = useCallback(async () => {
    const cfg = configRef.current
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const today = new Date()
    const toHHmm = (s: string) => s.slice(11, 16)

    const [goalsRes, perceptionSpans, activityBlocksRes, activityPaletteRes, biliSpans] = await Promise.allSettled([
      fetchGoals('active'),
      fetchPerceptionSpans(today),
      fetchActivityBlocks(today),
      fetchActivityPalette(),
      fetchBiliSpans(today),
    ] as const)

    const goals: GoalRecord[] = goalsRes.status === 'fulfilled'
      ? goalsRes.value.map((g) => ({ title: g.title, tags: parseGoalTags(g) }))
      : []
    const perceptionData = perceptionSpans.status === 'fulfilled' ? perceptionSpans.value : []

    const todayBlocks = activityBlocksRes.status === 'fulfilled' ? activityBlocksRes.value : []
    const currentPalette = activityPaletteRes.status === 'fulfilled' ? activityPaletteRes.value : activityPalette
    const activityTags = activityBlocksToContextRecords(todayBlocks, currentPalette, oneHourAgo, today)

    const appUsage: AppUsageRecord[] = perceptionData
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
  }, [presence, activityPalette])
  refreshSystemPromptRef.current = refreshSystemPrompt

  // ── System Prompt 预热 + 定时刷新（每分钟，供 Omni 模式热读）──
  useEffect(() => {
    refreshSystemPrompt().catch(() => {})
    const timer = setInterval(() => refreshSystemPrompt().catch(() => {}), 60_000)
    return () => clearInterval(timer)
  }, [refreshSystemPrompt])

  // ── Send Message ──
  const handleSend = useCallback(async (text: string, fromVoice = false) => {
    if (!text.trim()) return

    // 文字输入：添加用户气泡（语音输入的气泡在 onUserAudio 已添加，不重复）
    if (!fromVoice) {
      setChatMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'user' as const,
        content: text, timestamp: new Date().toISOString(),
      }])
    }

    setIsProcessing(true)
    // 文字输入也要立即显示思考动画
    if (!fromVoice) emitFairy('thinking')

    // D2 + D4 — 构建 system prompt（两套协议共用，结果缓存在 systemPromptRef）
    const systemPrompt = await refreshSystemPrompt()

    // ── Omni 全模态：文字输入直接走 WS，返回音频+文本，不走独立 LLM ──
    if (configRef.current.aiMode === 'omni') {
      const cfg = configRef.current
      const omniApiKey = getOmniApiKey(cfg)
      if (!omniApiKey) {
        setChatMessages((prev) => [...prev, {
          id: crypto.randomUUID(), role: 'system' as const,
          content: 'Omni 模式未配置 API Key', timestamp: new Date().toISOString(),
        }])
        setIsProcessing(false)
        return
      }
      const omniModel = await getFeatureModel('fairy_omni_chat', cfg.omniModel)
      // 记录 debug 快照（text_chunk 建气泡时写入 ChatMessage）
      omniDebugInfoRef.current = {
        systemPrompt,
        model: omniModel,
        voice: cfg.omniVoice || 'Tina',
        ts: new Date().toISOString(),
        items: [{ type: 'text', content: text, ts: new Date().toISOString() }],
      }
      try {
        await invoke('omni_connect', {
          apiKey: omniApiKey, model: omniModel,
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
    let capturedUsage: ModelCallLog | null = null

    // ── TTS 流式管线（与 LLM 并行启动）──
    type TtsState = {
      client: ReturnType<typeof createFishTTSTauri>
      audioCtx: AudioContext
      nextStartTime: number
      connected: boolean
      hasAudio: boolean
      pending: string[]
      pcmChunks: Uint8Array[]    // 收集所有 chunk，结束后拼成 WAV 落盘 + 气泡音频回放
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
        hasAudio: false,
        pending: [],
        pcmChunks: [],
        finishResolve: null,
        timeout: null,
      }
      state.client = createFishTTSTauri(
        { apiKey: config.fishApiKey, referenceId: config.fishReferenceId, model: config.fishModel },
        (pcm) => {
          state.pcmChunks.push(pcm)
          const samples = pcm.length / 2
          const buf = audioCtx.createBuffer(1, samples, 24000)
          const ch = buf.getChannelData(0)
          const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
          for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768
          const src = audioCtx.createBufferSource()
          src.buffer = buf
          src.connect(audioCtx.destination)
          // 第一段音频到来时把 nextStartTime 同步到当前播放时刻，避免播在过去
          if (!state.hasAudio) state.nextStartTime = audioCtx.currentTime + 0.005
          const startAt = Math.max(state.nextStartTime, audioCtx.currentTime + 0.005)
          src.start(startAt)
          state.nextStartTime = startAt + buf.duration
          state.hasAudio = true
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
    // 含逗号、分号、换行 → 长句中文用逗号断句也能边出边读，避免等到 LLM 结束才一次性 force-flush
    let sentBuf = ''
    const SENT_RE = /[。！？!?.…，,；;\n]+/
    const pushToTts = (chunk: string, force = false) => {
      if (!tts) return
      sentBuf += chunk
      if (!force && (!SENT_RE.test(sentBuf) || sentBuf.length < 4)) return
      const sentence = sentBuf.trim()
      sentBuf = ''
      if (!sentence) return
      if (tts.connected) {
        tts.client.sendText(sentence).catch(() => {})
      } else {
        tts.pending.push(sentence)
      }
    }

    const chatModel = await getFeatureModel('fairy_chat', config.openaiCardModel || 'qwen3.6-flash')
    const dashscopeApiKey = getDashScopeApiKey(config) ?? ''

    try {
      const newHistory = await runQueryLoop({
        messages: [...conversationRef.current.slice(-20), userMsg],
        systemPrompt,
        apiOptions: {
          apiKey: dashscopeApiKey,
          apiBase: config.openaiApiBase,
          model: chatModel,
          feature: 'fairy_chat',
          maxTokens: 8000,
          tools: TOOL_DEFINITIONS,
          onRequestSnapshot: (snap) => capturedSnapshots.push(snap),
          onUsageLogged: (call) => {
            capturedUsage = call
            setChatMessages((prev) =>
              prev.map((m) => m.id === agentMsgId ? { ...m, usage: call } : m)
            )
          },
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

      // ── 抽取本轮 user + 最终 assistant 文本，作为持久化 + TTS 的素材 ──
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
      if (capturedUsage) {
        for (let i = newPairs.length - 1; i >= 0; i--) {
          if (newPairs[i].role === 'assistant') {
            newPairs[i] = { ...newPairs[i], usage: capturedUsage }
            break
          }
        }
      }
      const replyText = (() => {
        for (let i = newHistory.length - 1; i >= 0; i--) {
          const m = newHistory[i]
          if (isAssistantMessage(m)) return getMessageText(m)
        }
        return ''
      })()

      // ── TTS：LLM 完成后 flush，等待音频；同步收集 PCM chunks 拼 WAV 落盘 ──
      let aiAudioPath: string | undefined
      let aiAudioDurationMs: number | undefined
      if (tts) {
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
                // 收到首段音频前不要退出（否则 nextStartTime 还是初始值，currentTime 早就过了它）
                if (!s.hasAudio) return
                // nextStartTime 是最后一帧排队结束的时刻
                // currentTime > nextStartTime + 0.2s 表示所有音频已播完
                if (s.audioCtx.currentTime >= s.nextStartTime + 0.2) {
                  clearInterval(poll)
                  resolve()
                }
              }, 200)
            })
            // 所有 chunks 已收齐：拼 WAV → 贴气泡音频回放 + 落盘留 audioPath
            if (tts.pcmChunks.length > 0) {
              const wavBlob = pcm16ChunksToWavBlob(tts.pcmChunks, 24000)
              const audioUrl = URL.createObjectURL(wavBlob)
              const totalSamples = tts.pcmChunks.reduce((sum, c) => sum + c.length / 2, 0)
              aiAudioDurationMs = Math.round((totalSamples / 24000) * 1000)
              setChatMessages((prev) =>
                prev.map((m) => m.id === agentMsgId ? { ...m, audioUrl, durationMs: aiAudioDurationMs } : m)
              )
              if (sessionIdRef.current) {
                try {
                  const wavBytes = new Uint8Array(await wavBlob.arrayBuffer())
                  aiAudioPath = await invoke<string>('save_audio_file', {
                    sessionId: sessionIdRef.current,
                    wavBytes,
                    timestamp: new Date().toISOString(),
                  })
                } catch { /* 落盘失败不阻塞 */ }
              }
            }
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

      // ── 持久化本轮对话（在 TTS 之后，最终 assistant 顺手带上 audioPath/durationMs）──
      if (sessionIdRef.current) {
        const sid = sessionIdRef.current
        const cfg = configRef.current
        if (aiAudioPath) {
          for (let i = newPairs.length - 1; i >= 0; i--) {
            if (newPairs[i].role === 'assistant') {
              newPairs[i] = {
                ...newPairs[i],
                audioPath: aiAudioPath,
                durationMs: aiAudioDurationMs ?? null,
              }
              break
            }
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
    } catch (err) {
      setChatMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'system' as const,
        content: `错误: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      }])
    }

    setIsProcessing(false)
  }, [config, chatMessages])

  // ── 切换 / 新建会话 ──
  const switchSession = useCallback(async (sessionId: string, jumpToTimestamp?: string) => {
    const performJump = () => {
      if (!jumpToTimestamp) return
      // 等 React commit + layout 完成（两个 rAF），再定位 + scroll + 闪
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-msg-ts="${CSS.escape(jumpToTimestamp)}"]`)
        if (!el) return
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('msg-jump-flash')
        window.setTimeout(() => el.classList.remove('msg-jump-flash'), 1800)
      }))
    }

    if (sessionId === sessionIdRef.current) {
      performJump()
      return
    }
    try {
      const msgs = await fetchSessionMessages(sessionId)
      sessionIdRef.current = sessionId
      persistedBufferRef.current = [...msgs]
      const info = sessions.find((s) => s.id === sessionId)
      sessionTitleRef.current = info?.title || '新会话'
      conversationRef.current = sessionMessagesToLLMHistory(msgs).slice(-12)
      setChatMessages(sessionMessagesToChatMessages(msgs, audioDirRef.current))
      performJump()
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

      {/* ── Top Bar ── 紧凑版（参考图风格：左字标 / 中日期+状态 / 右图标+版本） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '0 24px', height: 52, flexShrink: 0,
        background: `linear-gradient(180deg, rgba(4,10,26,0.85) 0%, rgba(2,6,18,0.55) 100%)`,
        boxShadow: `inset 0 -1px 0 ${theme.hudFrameSoft}`,
        position: 'relative',
        overflow: 'visible',
        zIndex: 2,
      }}>
        {/* ── 左：Logo 图标 + 字标 + SLS-V{version}（从 package.json 注入） ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img
            src={appIcon}
            alt="SOLO LEVELING SYSTEM"
            draggable={false}
            onContextMenu={(e) => {
              e.preventDefault()
              navigator.clipboard.writeText('SOLO LEVELING SYSTEM').catch(() => {})
            }}
            style={{
              height: 28, width: 28, objectFit: 'contain',
              userSelect: 'none', WebkitUserSelect: 'none',
              filter: `drop-shadow(0 0 6px ${theme.electricBlue}88) drop-shadow(0 0 12px ${theme.shadowPurple}55)`,
              cursor: 'default',
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1 }}>
            <span style={{
              fontFamily: theme.fontDisplay,
              fontSize: 14, fontWeight: 700,
              letterSpacing: 2.2, color: theme.textPrimary,
              textShadow: `0 0 8px ${theme.electricBlue}AA`,
              whiteSpace: 'nowrap',
            }}>
              SOLO LEVELING SYSTEM
            </span>
            <span style={{
              fontFamily: theme.fontMono,
              fontSize: 8.5, fontWeight: 700,
              letterSpacing: 2.4, color: theme.electricBlue,
              opacity: 0.6,
            }}>
              SLS-V{__APP_VERSION__.replace(/\./g, '-')}
            </span>
          </div>
        </div>

        <NeonRule vertical intensity="soft" style={{ height: 28, margin: '0 6px' }} />

        {/* ── 日期段：label + ◀ DATE ▶ + 今天 ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontFamily: theme.fontMono, fontSize: 9, fontWeight: 700,
            letterSpacing: 2, color: theme.textSecondary, opacity: 0.7,
          }}>日期</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <Tooltip content={prevHasData ? '前一天' : '前一天无数据'}>
              <button
                onClick={prevDay}
                disabled={!prevHasData}
                style={{
                  ...navBtn,
                  opacity: prevHasData ? 1 : 0.3,
                  cursor: prevHasData ? 'pointer' : 'not-allowed',
                  padding: '4px 5px',
                }}
              >
                <ChevronLeft size={11} />
              </button>
            </Tooltip>
            <Tooltip content="选择日期">
              <button
                ref={dateAnchorRef}
                onClick={() => setDatePickerOpen((v) => !v)}
                style={{
                  background: datePickerOpen ? `${theme.electricBlue}12` : 'transparent',
                  border: `1px solid ${datePickerOpen ? `${theme.electricBlue}55` : 'transparent'}`,
                  borderRadius: 3,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  fontFamily: theme.fontMono,
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: 1.3,
                  color: theme.textPrimary,
                  textShadow: `0 0 6px ${theme.electricBlue}66`,
                }}
                onMouseEnter={(e) => { if (!datePickerOpen) e.currentTarget.style.background = theme.glassHover }}
                onMouseLeave={(e) => { if (!datePickerOpen) e.currentTarget.style.background = 'transparent' }}
              >
                {selectedDate.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' })}
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
                  padding: '4px 5px',
                }}
              >
                <ChevronRight size={11} />
              </button>
            </Tooltip>
          </div>
          <button onClick={goToday} style={{
            ...navBtn,
            color: theme.electricBlue,
            padding: '4px 10px',
            border: `1px solid ${theme.electricBlue}55`,
            background: `${theme.electricBlue}0E`,
            textShadow: `0 0 6px ${theme.electricBlue}AA`,
            letterSpacing: 1.6,
            fontSize: 10.5,
          }}>
            今天
          </button>
        </div>

        <NeonRule vertical intensity="soft" style={{ height: 28, margin: '0 6px' }} />

        {/* ── 同步设备链接状态：取代 ONLINE/心跳，整块点击打开 SyncPeerDialog ── */}
        {(() => {
          const onlineDeviceIds = new Set(discoveredPeers.map((p) => p.device_id))
          const hasLinks = linkedDevices.length > 0
          const anyOnline = linkedDevices.some((l) => onlineDeviceIds.has(l.device_id))
          const anySyncing = syncingDeviceIds.size > 0
          const tintColor = anySyncing
            ? theme.expGreen
            : anyOnline
              ? theme.electricBlue
              : hasLinks
                ? theme.textSecondary
                : theme.textMuted
          const visibleLinks = linkedDevices.slice(0, 3)
          const overflow = Math.max(0, linkedDevices.length - visibleLinks.length)

          return (
            <Tooltip content={hasLinks ? `已链接 ${linkedDevices.length} 台 · 启动即自动同步` : '点击建立同步链接'}>
              <button
                ref={syncTriggerRef}
                onClick={() => {
                  setShowSync((open) => {
                    const next = !open
                    if (next) {
                      setSyncAnchorRect(syncTriggerRef.current?.getBoundingClientRect() ?? null)
                    }
                    return next
                  })
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  height: 28,
                  padding: '0 10px',
                  background: showSync ? `${tintColor}1A` : `${tintColor}08`,
                  border: `1px solid ${showSync ? `${tintColor}88` : `${tintColor}33`}`,
                  color: tintColor,
                  cursor: 'pointer',
                  fontFamily: theme.fontBody,
                  boxShadow: anySyncing ? `0 0 10px ${theme.expGreen}33` : undefined,
                }}
              >
                <Link2 size={12} />
                <span style={{
                  fontFamily: theme.fontMono, fontSize: 9, fontWeight: 700,
                  letterSpacing: 1.6, color: theme.textSecondary, opacity: 0.8,
                }}>
                  同步设备
                </span>

                {!hasLinks && (
                  <span style={{ fontSize: 11, color: theme.textMuted, fontStyle: 'italic' }}>
                    未链接
                  </span>
                )}

                {visibleLinks.map((link) => {
                  const isOnline = onlineDeviceIds.has(link.device_id)
                  const isSyncing = syncingDeviceIds.has(link.device_id)
                  const chipColor = isSyncing ? theme.expGreen : isOnline ? theme.electricBlue : theme.textMuted
                  return (
                    <span
                      key={link.device_id}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '2px 7px',
                        background: `${chipColor}14`,
                        border: `1px solid ${chipColor}55`,
                        color: chipColor,
                        fontSize: 10.5,
                        fontWeight: 600,
                        maxWidth: 90,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      <span style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: chipColor,
                        boxShadow: isOnline || isSyncing ? `0 0 5px ${chipColor}` : undefined,
                        animation: isSyncing ? 'glowPulse 1.2s ease-in-out infinite' : undefined,
                        flexShrink: 0,
                      }} />
                      {link.alias}
                    </span>
                  )
                })}

                {overflow > 0 && (
                  <span style={{
                    fontFamily: theme.fontMono,
                    fontSize: 10, color: theme.textMuted,
                  }}>+{overflow}</span>
                )}

                {/* 流动波形：anySyncing 时滚动，否则保留静态心跳 */}
                <svg width={52} height={18} viewBox="0 0 52 18" style={{ overflow: 'visible', marginLeft: 2 }}>
                  <polyline
                    className={anySyncing ? 'sync-flow' : undefined}
                    points="0,9 8,9 12,4 16,14 20,2 24,16 28,9 36,9 40,5 44,13 48,9 52,9"
                    fill="none"
                    stroke={tintColor}
                    strokeWidth={1.3}
                    strokeDasharray={anySyncing ? '4 3' : undefined}
                    style={{
                      filter: `drop-shadow(0 0 3px ${tintColor}AA)`,
                      opacity: hasLinks || anySyncing ? 1 : 0.4,
                    }}
                  />
                </svg>
              </button>
            </Tooltip>
          )
        })()}

        <div style={{ flex: 1 }} />

        {/* ── 右：图标按钮 ── */}
        <Tooltip content="B站历史记录">
          <button
            onClick={() => {
              if (showBili) {
                closeBiliDialog()
              } else {
                setShowBili(true)
                setShowSettings(false); setShowModels(false)
              }
            }}
            style={{
              ...navBtn,
              color: showBili ? theme.electricBlue : theme.textSecondary,
              border: `1px solid ${showBili ? theme.electricBlue + '66' : theme.hudFrameSoft}`,
              background: showBili ? `${theme.electricBlue}10` : 'rgba(0,229,255,0.04)',
              textShadow: showBili ? `0 0 6px ${theme.electricBlue}AA` : undefined,
            }}
          >
            <BiliIcon size={13} />
          </button>
        </Tooltip>

        <Tooltip content="模型">
          <button
            onClick={() => {
              setShowModels(!showModels)
              if (!showModels) { setShowSettings(false); closeBiliDialog() }
            }}
            style={{
              ...navBtn,
              color: showModels ? theme.electricBlue : theme.textSecondary,
              border: `1px solid ${showModels ? theme.electricBlue + '66' : theme.hudFrameSoft}`,
              background: showModels ? `${theme.electricBlue}10` : 'rgba(0,229,255,0.04)',
              textShadow: showModels ? `0 0 6px ${theme.electricBlue}AA` : undefined,
            }}
          >
            <Boxes size={12} />
          </button>
        </Tooltip>

        <Tooltip content="设置">
          <button
            onClick={() => {
              setShowSettings(!showSettings)
              if (!showSettings) { closeBiliDialog(); setShowModels(false) }
            }}
            style={{
              ...navBtn,
              color: showSettings ? theme.electricBlue : theme.textSecondary,
              border: `1px solid ${showSettings ? theme.electricBlue + '66' : theme.hudFrameSoft}`,
              background: showSettings ? `${theme.electricBlue}10` : 'rgba(0,229,255,0.04)',
              textShadow: showSettings ? `0 0 6px ${theme.electricBlue}AA` : undefined,
            }}
          >
            <Settings size={11} />
          </button>
        </Tooltip>

      </div>

      {/* ── Main: Chart + Right Panel ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Chart */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <DayNightChart
            activityBlocks={activityBlocks}
            plannedBlocks={plannedBlocks}
            planNodes={planNodes}
            activityPalette={activityPalette}
            recordLayer={recordLayer}
            onRecordLayerChange={setRecordLayer}
            editMode={editMode}
            selectedTagId={selectedTagId}
            selectedPlanNodeId={selectedPlanNodeId}
            onEditModeToggle={() => setEditMode((m) => !m)}
            canUndo={recordLayer === 'actual' ? undoStack.length > 0 : planUndoStack.length > 0}
            canRedo={recordLayer === 'actual' ? redoStack.length > 0 : planRedoStack.length > 0}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onApplyDrag={handleApplyDrag}
            perceptionSpans={perceptionSpans}
            biliSpans={biliSpans}
            selectedDate={selectedDate}
            onSpanClick={() => {}}
            onSpanHover={setHoveredTagSpan}
            onAppSpanHover={(span, minute) => { setHoveredAppSpan(span); setHoveredAppMinute(minute ?? null) }}
            onBiliSpanHover={setHoveredBiliSpan}
            trackMode={trackMode}
            onTrackModeChange={setTrackMode}
            pinnedPos={pinnedPos}
            onPinPos={setPinnedPos}
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
          {/* 右侧栏内容：编辑模式 → 标签库（+ 当前轨道详情）；非编辑模式 → 聊天 / 详情 */}
          {editMode ? (() => {
            const pm = pinnedPos?.minute ?? null
            const dtToMin = (dt: string) => { const [h,m] = (dt.split(' ')[1]??'').split(':').map(Number); return h*60+m }
            const pinnedAppSpan = pm != null && trackMode === 'apps'
              ? perceptionSpans.find((s) => s.track === 'apps' && pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            const pinnedBili = pm != null && trackMode === 'bili'
              ? biliSpans.find((s) => pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            const appSpan = trackMode === 'apps' ? (pinnedAppSpan ?? hoveredAppSpan) : null
            const biliSpan = trackMode === 'bili' ? (pinnedBili ?? hoveredBiliSpan) : null
            const appFocusMinute = trackMode === 'apps'
              ? (pm != null ? Math.floor(pm) : hoveredAppMinute)
              : null
            // 当前光标分钟是否处于 afk
            const probeMin = pm ?? hoveredAppMinute
            const isAfk = probeMin != null && perceptionSpans.some((s) => {
              if (s.track !== 'status') return false
              const status = (s.group_name ?? s.title ?? '').toLowerCase()
              if (status !== 'afk') return false
              return probeMin >= dtToMin(s.start_at) && probeMin < dtToMin(s.end_at)
            })
            const detail = trackMode === 'bili' ? biliSpan : appSpan
            return (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                {/* 上半：标签库 */}
                <div style={{
                  flex: detail ? '1 1 42%' : '1 1 100%',
                  minHeight: 0,
                  overflow: 'hidden',
                  position: 'relative',
                }}>
                  {recordLayer === 'plan' ? (
                    <PlanNodePalette
                      palette={activityPalette}
                      nodes={planNodes}
                      selectedProjectTagId={selectedProjectTagId}
                      selectedPlanNodeId={selectedPlanNodeId}
                      onSelectProject={(id) => { setSelectedProjectTagId(id); setSelectedPlanNodeId(null) }}
                      onSelectNode={setSelectedPlanNodeId}
                      onNodesChange={refreshPlanNodes}
                    />
                  ) : (
                    <ActivityTagPalette
                      palette={activityPalette}
                      selectedTagId={selectedTagId}
                      onSelectTag={setSelectedTagId}
                      onPaletteChange={refreshActivityPalette}
                    />
                  )}
                </div>
                {/* 下半：当前光标处轨道详情（apps → 应用截图 / bili → 视频面板） */}
                {detail && (
                  <div style={{
                    flex: '1 1 58%',
                    minHeight: 0,
                    position: 'relative',
                    padding: '4px 4px',
                    fontFamily: theme.fontBody,
                    background: 'rgba(2,6,14,0.45)',
                  }}>
                    <HudFrame
                      color={theme.warningOrange}
                      accent={theme.expGreen}
                      topLabel="EDIT · REF"
                      showNotchTop
                      showNotchBottom={false}
                      notchWidth={64}
                      notchDepth={7}
                      cornerSize={14}
                      intensity="soft"
                    />
                    <div style={{
                      height: '100%', overflow: 'auto',
                      padding: '8px 4px',
                    }}>
                      {trackMode === 'bili' && biliSpan ? (
                        <BiliVideoPanel
                          span={biliSpan}
                          onOpenDetail={() => requestBiliHistoryDetail(biliSpan, null)}
                          onPlayLocal={() => requestBiliHistoryDetail(biliSpan, 'theater')}
                          onToggleTranscribe={() => requestBiliHistoryDetail(biliSpan, 'transcribe')}
                        />
                      ) : appSpan ? (
                        <AppHoverPanel span={appSpan} date={selectedDate} focusMinute={appFocusMinute} isAfk={isAfk} />
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            )
          })() : (() => {
            // 固定时用 pinnedPos.minute 查对应 span，否则用 hover span
            const pm = pinnedPos?.minute ?? null
            const dtToMin = (dt: string) => { const [h,m] = (dt.split(' ')[1]??'').split(':').map(Number); return h*60+m }
            const pinnedTagSpan = pm != null
              ? perceptionSpans.find((s) => s.track === 'tags' && pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            // 按当前轨道模式只查对应管线 span
            const pinnedAppSpan = pm != null && trackMode === 'apps'
              ? perceptionSpans.find((s) => s.track === 'apps' && pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            const pinnedBili = pm != null && trackMode === 'bili'
              ? biliSpans.find((s) => pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            const tagSpan = pinnedTagSpan ?? hoveredTagSpan
            const appSpan = trackMode === 'apps' ? (pinnedAppSpan ?? hoveredAppSpan) : null
            const biliSpan = trackMode === 'bili' ? (pinnedBili ?? hoveredBiliSpan) : null
            // 优先用固定时刻；否则用 hover 整分钟；最后兜底 span 起始
            const appFocusMinute = trackMode === 'apps'
              ? (pm != null ? Math.floor(pm) : hoveredAppMinute)
              : null
            const probeMin = pm ?? hoveredAppMinute
            const isAfk = probeMin != null && perceptionSpans.some((s) => {
              if (s.track !== 'status') return false
              const status = (s.group_name ?? s.title ?? '').toLowerCase()
              if (status !== 'afk') return false
              return probeMin >= dtToMin(s.start_at) && probeMin < dtToMin(s.end_at)
            })

            const hasDetail = !!(tagSpan || appSpan || biliSpan)
            return (
              <>
                {/* 始终挂载 ChatPanel，避免卸载导致摄像头预览状态丢失 */}
                <div style={{ display: hasDetail ? 'none' : 'flex', flexDirection: 'column', height: '100%' }}>
                  <ChatPanel
                    messages={chatMessages}
                    isProcessing={isProcessing}
                    onSend={handleSend}
                    aiMode={config.aiMode}
                    onToggleAiMode={() => handleConfigUpdate({ aiMode: config.aiMode === 'omni' ? 'regular' : 'omni' })}
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
                        // 顺手清理之前留下的空白会话（无任何消息），不动当前会话
                        cleanupEmptyChatSessions(sessionIdRef.current)
                          .catch(() => [])
                          .then(() => getRecentChatSessions(50))
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
                      {appSpan && <AppHoverPanel span={appSpan} date={selectedDate} focusMinute={appFocusMinute} isAfk={isAfk} />}
                      {biliSpan && (
                        <BiliVideoPanel
                          span={biliSpan}
                          onOpenDetail={() => requestBiliHistoryDetail(biliSpan, null)}
                          onPlayLocal={() => requestBiliHistoryDetail(biliSpan, 'theater')}
                          onToggleTranscribe={() => requestBiliHistoryDetail(biliSpan, 'transcribe')}
                        />
                      )}
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
          onSelect={(id, ts) => { switchSession(id, ts) }}
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
        scanProgress={biliScanProgress}
        scanSnapshotBvids={biliScanSnapshotBvids}
        scanLastPage={biliScanLastPage}
        onPause={pauseBili}
        onResume={resumeBili}
        onRefresh={refreshBili}
        onFullScan={biliFullScan}
        onSetInterval={setBiliInterval}
        onClose={closeBiliDialog}
        pendingDetail={pendingBiliDetail}
      />

      <ModelDialog
        open={showModels}
        config={config}
        onUpdate={handleConfigUpdate}
        onClose={() => setShowModels(false)}
      />

      <SettingsPanel
        open={showSettings}
        config={config}
        onUpdate={handleConfigUpdate}
        onClose={() => setShowSettings(false)}
      />

      <SyncPeerDialog
        open={showSync}
        anchorRect={syncAnchorRect}
        onClose={() => setShowSync(false)}
      />

      {/* 活动记录涂块 toast（10s 自动消失） */}
      <ActivityToast toast={paintToast} onDismiss={() => setPaintToast(null)} />

      {/* 首次启用独显高性能 → 右上角橙色 toast，常驻直到用户选择"立即重启"或"稍后" */}
      {gpuToastVisible && (
        <div
          style={{
            position: 'fixed',
            right: 18, top: 18,
            zIndex: 99999,
            padding: '12px 14px',
            background: 'rgba(38,22,4,0.96)',
            border: `1px solid ${theme.warningOrange}AA`,
            color: theme.textPrimary,
            fontFamily: theme.fontBody,
            fontSize: 12, lineHeight: 1.5,
            boxShadow: `0 0 0 1px ${theme.warningOrange}33, 0 6px 24px rgba(0,0,0,0.55), 0 0 18px ${theme.warningOrange}44`,
            maxWidth: 340,
            animation: 'gpuToastIn 0.25s ease',
          }}
        >
          <div style={{ color: theme.warningOrange, fontWeight: 800, marginBottom: 4, letterSpacing: 0.5 }}>
            已启用独显高性能
          </div>
          <div style={{ color: theme.textSecondary, marginBottom: 10 }}>
            重启应用后会自动切换到独立显卡；可在 设置 → 图形性能 中关闭。
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button
              onClick={() => setGpuToastVisible(false)}
              style={{
                padding: '4px 12px',
                background: 'transparent',
                border: `1px solid ${theme.glassBorder}`,
                color: theme.textSecondary, cursor: 'pointer',
                fontSize: 11, fontFamily: theme.fontBody,
              }}
            >
              下次再说
            </button>
            <button
              onClick={() => { invoke('restart_app').catch(() => {}) }}
              style={{
                padding: '4px 12px',
                background: `${theme.warningOrange}22`,
                border: `1px solid ${theme.warningOrange}AA`,
                color: theme.warningOrange, cursor: 'pointer',
                fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                fontFamily: theme.fontBody,
                textShadow: `0 0 6px ${theme.warningOrange}88`,
              }}
            >
              立即重启
            </button>
          </div>
        </div>
      )}
      <style>{`@keyframes gpuToastIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
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
