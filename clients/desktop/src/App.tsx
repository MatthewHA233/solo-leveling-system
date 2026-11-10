// ══════════════════════════════════════════════
// Solo Agent — Desktop 客户端（务实版）
// 核心：昼夜表 + AI 聊天整理
// ══════════════════════════════════════════════

import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Boxes, ChevronLeft, ChevronRight, PictureInPicture2, Settings, X } from 'lucide-react'
import BiliIcon from './components/icons/BiliIcon'
import {
  fetchPerceptionSpans, fetchBiliSpans, searchBiliHistory, fetchGoals, parseGoalTags,
  fetchActivityPalette, fetchActivityBlocks, paintActivityBlocks, eraseActivityBlocks,
  fetchPlanNodes, fetchPlannedBlocks, paintPlannedBlocks, erasePlannedBlocks,
  fetchSyncLinks, fetchSyncPeers, runSyncLink, fetchSyncedSettings, saveSyncedSetting,
  addContextCard, addBinding,
} from './lib/local-api'
import type { PerceptionSpan, BiliSpan, ModelCallLog, LinkedDevice, SyncPeer } from './lib/local-api'
import { distillThought } from './lib/thought-distill'
import { anchorToContext } from './lib/anchor-to-context'
import { locateSegment } from './lib/segment-locate'
import { fetchBiliTranscriptPlain } from './lib/bili-transcript'
import type { ActivityBlock, ActivityPalette, PlanNode, PlannedBlock, RecordLayer } from './types'
import { theme, hud, ti, tiSurface, tiTitle } from './theme'

// Agent
import { DEFAULT_CONFIG, getDashScopeApiKey, loadConfig, updateConfig } from './lib/agent/agent-config'
import type { AgentConfig } from './lib/agent/agent-config'
import { configUpdatesFromSettings, seedWrites, settingWrites } from './lib/agent/synced-settings'
import { getFeatureModel, getFishApiKey, getModelDef, logModelUsage, modelSeesImages, pullAnthropicModels, realtimeUsageToDashScope, saveFishApiKey, type RealtimeUsage } from './lib/model-audit'
import { buildStaticPrompt, buildDynamicContext, buildConversationSummary } from './lib/ai/prompt-templates'
import type { ActivityTagRecord, AppUsageRecord, BiliRecord, GoalRecord } from './lib/ai/prompt-templates'
import { compactAppUsage, classifyIntent } from './lib/ai/context-intent'

// LLM Engine（新）
import { runQueryLoop } from './lib/llm/query-loop'
import { contextBudget, estimateContextTokens, roughTokens, withSystemReminder, type CompactionResult, type ContextBudget } from './lib/llm/context-window'
import { createCompactor, type CompactionContext } from './lib/agent/chat-compaction'
import { compactNotice, compactSummaryRow, isCompactSummaryRow, restoreLLMHistory, toolTraceRow } from './lib/agent/chat-history'
import { withBrowserArgs } from './lib/webview-args'
import { buildAsrContext, buildAsrVocabulary } from './lib/voice/asr-hints'
import { createUserMessage, getMessageText, isAssistantMessage, userContentWithImages } from './lib/llm/types'
import {
  CHAT_IMAGES_UPDATED, chatImageUrl, initChatImages, loadRestoredImages, parseImageMarker, withImageMarker, type PendingImage,
} from './lib/agent/chat-images'
import type { Message } from './lib/llm/types'
import type { ApiRequestSnapshot } from './lib/llm/api'

// Session 持久化
import {
  initChatSession, persistMessages, patchSession,
  fetchSessionMessages, getRecentChatSessions, createChatSession, deleteChatSession,
  cleanupEmptyChatSessions,
} from './lib/agent/agent-memory'
import type { ChatSessionInfo, SessionMessage } from './lib/agent/agent-memory'
import { createTitleFlow, DEFAULT_SESSION_TITLE, type TitleFlow } from './lib/ai/session-title-flow'

// Agent Tools
import { TOOL_DEFINITIONS, executeAgentTool } from './lib/agent/agent-tools'

// OpenAI Chat Completions tools → Realtime API flat tools
// Chat 格式: { type: 'function', function: { name, description, parameters } }
// Realtime 格式: { type: 'function', name, description, parameters }
const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 顶栏日期读数下的相对说明：今天 / 昨天 / 前天 / N 天前 / N 天后 */
function relativeDayLabel(date: Date): string {
  const DAY_MS = 86_400_000
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((startOf(new Date()) - startOf(date)) / DAY_MS)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff === 2) return '前天'
  return diff > 0 ? `${diff} 天前` : `${-diff} 天后`
}

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
import { createOmniWatchdog, OMNI_PLAYBACK_GRACE_MS, OMNI_REPLY_TIMEOUT_MS, type OmniWatchdog } from './lib/voice/omni-turn'
import { createPcm16Aligner } from './lib/voice/pcm16'

// UI
import DayNightChart from './components/DayNightChart'
import ProtocolView from './components/protocol/ProtocolView'
import { PLAN_NODES_CHANGED } from './components/protocol/checklist/use-checklist'
import ProtocolDemoPanel from './components/ProtocolDemoPanel'
import TorrentFieldPanel from './components/TorrentFieldPanel'
import TorrentFieldDemoPanel from './components/TorrentFieldDemoPanel'
import ViewSwitcher, { type MainViewMode } from './components/ViewSwitcher'
import IconButton from './components/ui/IconButton'
import WindowControls from './components/ui/WindowControls'
import './styles/topbar.css'
import ScreenBezel from './components/ui/ScreenBezel'
import ChassisPlate from './components/ui/ChassisPlate'
import ChatPanel from './components/ChatPanel'
import SessionPicker from './components/SessionPicker'
import { useDockPresence } from './components/ui/DockCoupler'
import SettingsPanel from './components/SettingsPanel'
import DatePickerPopover, { invalidateActivityRangeCache } from './components/DatePickerPopover'
import SpanDetailPanel from './components/SpanDetailPanel'
import AppHoverPanel from './components/AppHoverPanel'
import BiliVideoPanel from './components/BiliVideoPanel'
import BiliHistoryDialog from './components/BiliHistoryDialog'
import ModelDialog from './components/ModelDialog'
import BiliJobsWidget from './components/BiliJobsWidget'
import SyncPeerDialog, { type SyncLogEntry } from './components/SyncPeerDialog'
import { useBiliHistory } from './lib/bilibili/useHistory'
import ActivityTagPalette from './components/ActivityTagPalette'
import TodoListPanel from './components/TodoListPanel'
import ActivityToast from './components/ActivityToast'
import type { FairyState } from './components/FairyHUD'
import { CloseConfirmModal } from './components/CloseConfirmModal'
import Tooltip from './components/Tooltip'
import { usePresenceDetection } from './hooks/usePresenceDetection'
import { CAMERA_PRESENCE_ENABLED } from './lib/presence/feature'
import { useDataDays, hasDataOrIsToday } from './hooks/useDataDays'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'

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
  readonly reasoning?: string            // 思考模型的推理过程（流式累积，仅展示不入历史）
  readonly audioUrl?: string             // 语音消息的 blob URL（可播放）
  readonly durationMs?: number           // 录音时长（毫秒）
  readonly transcript?: string           // ASR 转写文本（语音消息专用）
  readonly debugSnapshots?: ApiRequestSnapshot[]  // 本轮发给 AI 的请求快照（普通模式）
  readonly omniDebugInfo?: OmniDebugInfo          // 本轮发给 Omni 的上下文快照
  readonly usage?: ModelCallLog                   // 该 AI 回复对应的模型调用审计快照
  readonly images?: readonly { id: string; url: string }[]  // 主人发的图片（规则见 lib/agent/chat-images.ts）
  readonly summary?: string              // 压缩提示（system）点开看到的摘要（规则见 lib/agent/chat-history.ts）
}

type FairyActionPayload =
  | { action: 'hide' }
  | { action: 'open-settings' }
  | { action: 'set-scale'; scale?: number }

type ChatMode = AgentConfig['aiMode']
type FairyChatSubmitPayload = { text?: string; mode?: ChatMode }
type ModelFeatureBindingPayload = { feature?: string; modelId?: string }
type TauriEventHandler<T> = (event: { payload: T }) => void
// userTimestamp：语音那句落库的时间，发给模型的那条用同一个时间（压缩按时间在库里找分界）
type HandleSend = (text: string, fromVoice?: boolean, modeOverride?: ChatMode, images?: readonly PendingImage[], userTimestamp?: string) => Promise<void>

function listenTauriEventStrict<T>(event: string, handler: TauriEventHandler<T>): () => void {
  let disposed = false
  let unlisten: (() => void) | null = null

  import('@tauri-apps/api/event').then(({ listen }) => {
    if (disposed) return
    listen<T>(event, handler).then((fn) => {
      if (disposed) {
        fn()
        return
      }
      unlisten = fn
    }).catch(() => {})
  }).catch(() => {})

  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}

function clampFairyScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0.8
  return Math.min(1, Math.max(0.4, n))
}

// ── Session 持久化：格式转换 ──

function sessionMessagesToChatMessages(msgs: readonly SessionMessage[], audioDir = ''): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of msgs) {
    // 压缩摘要显示成一条提示，点开能看；工具记录不显示
    if (isCompactSummaryRow(m) && m.content?.trim()) {
      out.push({ id: crypto.randomUUID(), role: 'system', content: compactNotice(), summary: m.content, timestamp: m.timestamp })
      continue
    }
    if (m.role === 'tool') continue
    const { ids: imageIds, text: content } = parseImageMarker((m.content ?? '').trim())
    // 音频气泡：即使没有文字也要还原（content 可能是 transcript）
    const hasAudio = !!(m.audioPath && audioDir)
    if (!content && !hasAudio && imageIds.length === 0) continue

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
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(imageIds.length > 0 ? { images: imageIds.map((id) => ({ id, url: chatImageUrl(id) })) } : {}),
    })
  }
  return out
}

/** 压缩提示插在保留段第一条前面，和从库里恢复时的位置一致 */
function insertCompactNotice(messages: readonly ChatMessage[], result: CompactionResult): ChatMessage[] {
  const notice: ChatMessage = {
    id: crypto.randomUUID(), role: 'system', content: compactNotice(result.kind),
    summary: result.summaryText, timestamp: result.summaryTimestamp,
  }
  const index = messages.findIndex((m) => m.timestamp > result.summaryTimestamp)
  return index < 0 ? [...messages, notice] : [...messages.slice(0, index), notice, ...messages.slice(index)]
}

/** 会话里主人说过几句（起标题的计数从这里接上） */
function countUserMessages(messages: readonly SessionMessage[]): number {
  return messages.filter((m) => m.role === 'user' && (m.content ?? '').trim()).length
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

// 主舞台的视图常驻（叠成一摞做切换动画），App 顶层任何状态一变（Fairy 回复的每一段字、15 秒一次的刷新……）
// 都会把它们全部重算一遍，开发模式下单次要半秒多。按 props 记忆：props 没变的视图直接跳过。
// 传给它们的回调要用 useCallback 稳住，不然每次都是新函数、记忆就白做了
const StageDayNightChart = memo(DayNightChart)
const StageProtocolView = memo(ProtocolView)
const StageProtocolDemoPanel = memo(ProtocolDemoPanel)
const StageTorrentFieldPanel = memo(TorrentFieldPanel)
const StageTorrentFieldDemoPanel = memo(TorrentFieldDemoPanel)
// 右侧聊天栏也一直挂着（看详情时只是藏起来），同样按 props 记忆
const StageChatPanel = memo(ChatPanel)
const NOOP = () => {}

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
  const [, setDbStatus] = useState<'loading' | 'live' | 'error'>('loading')

  // ── Layout ──
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>(undefined)
  const [settingsInitialSectionTick, setSettingsInitialSectionTick] = useState(0)
  const [showBili, setShowBili] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const [showSync, setShowSync] = useState(false)

  // 主舞台视图模式：协议志（默认首屏）/ 昼夜表 / 洪流域
  const [mainView, setMainView] = useState<MainViewMode>('motivation')
  // tab 行 hover 状态 — 平时两卡完全重叠；hover 时背后卡向上滑出露顶（Aceternity tabs 行为）
  const [tabsHovering, setTabsHovering] = useState(false)

  // 离开昼夜表时，把昼夜表的本地交互状态都退掉（编辑画笔 / 选中 / hover / pin 详情）
  // 避免切走后还残留"我在编辑那个标签"或"在 hover 某段"的鬼魂状态
  useEffect(() => {
    if (mainView === 'daynight') return
    setEditMode(false)
    setSelectedTagId(null)
    setSelectedPlanNodeId(null)
    setPinnedPos(null)
    setHoveredTagSpan(null)
    setHoveredAppSpan(null)
    setHoveredAppMinute(null)
    setHoveredBiliSpan(null)
  }, [mainView])

  // 右侧栏可拖拽宽度（持久化到 localStorage）
  const RIGHT_PANEL_MIN = 260
  const RIGHT_PANEL_MAX = 820
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('slu.rightPanelWidth') : null
    const n = stored ? Number(stored) : NaN
    return Number.isFinite(n) && n >= RIGHT_PANEL_MIN && n <= RIGHT_PANEL_MAX ? n : 340
  })
  useEffect(() => {
    try { localStorage.setItem('slu.rightPanelWidth', String(rightPanelWidth)) } catch {}
  }, [rightPanelWidth])
  const resizingRef = useRef(false)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      const w = window.innerWidth - e.clientX
      const clamped = Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, w))
      setRightPanelWidth(clamped)
    }
    const onUp = () => {
      if (resizingRef.current) {
        resizingRef.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])
  const [syncAnchorRect, setSyncAnchorRect] = useState<DOMRect | null>(null)
  const syncTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [linkedDevices, setLinkedDevices] = useState<LinkedDevice[]>([])
  const [discoveredPeers, setDiscoveredPeers] = useState<SyncPeer[]>([])
  const [syncingDeviceIds, setSyncingDeviceIds] = useState<ReadonlySet<string>>(() => new Set())
  // 下次自动同步的时刻：一分钟才变一次（别每秒 set 倒计时——会让整个 App 每秒重渲染）
  const [nextAutoSyncAt, setNextAutoSyncAt] = useState<number>(() => Date.now() + 60_000)
  // 同步日志：最近 20 条事件（启动/完成/错误/本地操作反馈），LAN 浮层日志面板展示
  // 去重：5 秒内相同 text 不重复入库，避免离线重试刷屏
  const [syncLog, setSyncLog] = useState<readonly SyncLogEntry[]>([])
  const pushSyncLog = useCallback((entry: Omit<SyncLogEntry, 'ts'>) => {
    const now = Date.now()
    setSyncLog((prev) => {
      // 查 5 秒内所有条目：离线重试时「开始」和「失败」交替出现，只比最新一条拦不住
      if (prev.some((e) => e.text === entry.text && now - e.ts < 5000)) {
        return prev
      }
      const next: SyncLogEntry = { ...entry, ts: now }
      return [next, ...prev].slice(0, 20)
    })
  }, [])

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

  // 语境库 B 站卡点击封面/标题 → 直达 B 站历史详情+转录面板。
  // 卡上只有 bvid：先搜历史拿 view_at 定位观看日，再取当日 spans 找完整 BiliSpan
  useEffect(() => {
    const onOpenDetail = (e: Event) => {
      const d = (e as CustomEvent).detail as { bvid?: string } | undefined
      const bvid = d?.bvid
      if (!bvid) return
      void (async () => {
        try {
          const hits = await searchBiliHistory(bvid, 5)
          const hit = hits.find((h) => h.bvid === bvid)
          if (!hit) {
            console.warn('[BiliDetail] B 站历史里找不到该视频：', bvid)
            return
          }
          const spans = await fetchBiliSpans(new Date(hit.view_at * 1000))
          const span = spans.find((s) => s.bvid === bvid)
          if (!span) {
            console.warn('[BiliDetail] 观看日 spans 里找不到该视频：', bvid)
            return
          }
          requestBiliHistoryDetail(span, 'transcribe')
        } catch (err) {
          console.error('[BiliDetail] 打开详情失败', err)
        }
      })()
    }
    window.addEventListener('solevup:open-bili-detail', onOpenDetail)
    return () => window.removeEventListener('solevup:open-bili-detail', onOpenDetail)
  }, [requestBiliHistoryDetail])


  // ── Activity Editor ──

  // ── Bilibili 后台持久监控 ──
  const [config, setConfig] = useState<AgentConfig>(loadConfig)

  const {
    isLoading: biliLoading, error: biliError,
    lastUpdated: biliLastUpdated, nextSyncAt: biliNextSyncAt,
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
  // 回复轮次与打断控制：主人按右 Alt 开口时，停掉正在进行的生成与朗读
  const replyTurnRef = useRef(0)
  const replyControlRef = useRef<{ interrupt: () => void } | null>(null)
  const handleSendRef = useRef<HandleSend | null>(null)
  const takeVoiceImagesRef = useRef<() => readonly PendingImage[]>(() => [])
  // 当前对话绑定的语境卡（语境库里展开转录的那张）；聊天锚定到它
  const activeContextRef = useRef<{ cardId: string; text: string; title: string } | null>(null)
  // 主人在洪流域鼠标锁定的卡片（粘性悬浮）；注入 system prompt，说"这张卡片"时 AI 立刻知道
  const focusedCardRef = useRef<{
    cardId: string
    kind: 'thought' | 'bili_transcript'
    title: string | null
    text: string
    sourceLabel: string | null
    refPath: string | null   // B 站卡的转录文件路径（注视即锚定）
    linkBroken: boolean      // 想法卡断链/损坏（指向视频但锚点没回填到视频）
  } | null>(null)
  // 同步一份 state 给 ChatPanel 显示"注视中"提示条
  const [gazeTarget, setGazeTarget] = useState<{
    kind: 'thought' | 'bili_transcript'
    title: string | null
    text: string
  } | null>(null)
  // 本会话最近注视过的 B 站语境（解锁/切页不丢）：沉淀时的兜底锚定目标。
  // 误挂风险由锚定器的相关性闸门兜住——想法与该语境无关时会判 worth:false 回落独立沉淀
  const lastBiliContextRef = useRef<{ cardId: string; title: string | null; refPath: string | null } | null>(null)

  // ── Session 持久化 ──
  const sessionIdRef = useRef<string | null>(null)
  const sessionTitleRef = useRef<string>('新会话')       // 现存标题，用于决定是否触发 AI 重命名
  const [sessionTitle, setSessionTitle] = useState('新会话') // 同一份标题给通讯栏显示
  /** 标题只从这里改：ref（逻辑判断用）和 state（界面显示用）一起走 */
  const applySessionTitle = useCallback((title: string) => {
    sessionTitleRef.current = title
    setSessionTitle(title)
  }, [])
  // 自动起标题的节奏：主人第 1 句立刻起、第 3 句拿整段对话再起（见 lib/ai/session-title-flow.ts）
  const titleFlowRef = useRef<TitleFlow | null>(null)
  if (!titleFlowRef.current) {
    titleFlowRef.current = createTitleFlow({
      getConfig: () => configRef.current,
      getMessages: () => persistedBufferRef.current.map((m) => (m.content ? { ...m, content: parseImageMarker(m.content).text } : m)),
      apply: (sid, title) => {
        patchSession(sid, { title }).catch(() => {})
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, title } : s)))
        if (sid === sessionIdRef.current) applySessionTitle(title)
      },
    })
  }
  const titleFlow = titleFlowRef.current
  const persistedBufferRef = useRef<SessionMessage[]>([])  // 已持久化的历史（用于 title 生成的上下文窗口）
  const lastOmniUserInputRef = useRef<string>('')        // Omni 本轮用户输入（文字 or 转写）
  const audioDirRef = useRef<string>('')                 // 音频根目录（Rust data_local/solevup/audio）
  // 上下文压缩（规则见 lib/agent/chat-compaction.ts）：门槛按当前聊天模型算，每轮发送时刷新
  const contextBudgetRef = useRef<ContextBudget>(contextBudget(null))
  const contextOverheadRef = useRef(0)
  const compactorRef = useRef<ReturnType<typeof createCompactor> | null>(null)
  if (!compactorRef.current) {
    compactorRef.current = createCompactor({
      getConversation: () => conversationRef.current,
      setConversation: (history) => { conversationRef.current = history },
      getSessionId: () => sessionIdRef.current,
      persistSummary: (sid, result) => {
        const row = compactSummaryRow(result)
        if (sessionIdRef.current === sid) persistedBufferRef.current = [...persistedBufferRef.current, row]
        persistMessages(sid, [row]).catch((e) => console.warn('[Compact] 摘要写入失败', e))
      },
      onCompacted: (result, sid) => {
        if (sid !== sessionIdRef.current) return
        setChatMessages((prev) => insertCompactNotice(prev, result))
      },
    })
  }
  const compactor = compactorRef.current
  // 语音气泡录音的落盘任务（消息 id → 落盘结果）：定稿文本可能比落盘先到，持久化前要等它
  const audioSaveRef = useRef<Map<string, Promise<{ audioPath: string; durationMs: number } | null>>>(new Map())
  // 语音消息的录音时刻：入库用它当时间戳，保证用户语音排在 AI 回复前面（转写晚到 / 兜底入库时也不乱序）
  const voiceRecordedAtRef = useRef<Map<string, string>>(new Map())
  // 语音识别热词（refreshSystemPrompt 顺手更新：目标、常用应用名）
  const asrVocabularyRef = useRef<string[]>(buildAsrVocabulary({}))
  const blobAudioUrlsRef = useRef<Set<string>>(new Set())

  const trackBlobAudioUrl = useCallback((url: string) => {
    if (url.startsWith('blob:')) blobAudioUrlsRef.current.add(url)
    return url
  }, [])

  const revokeTrackedBlobAudioUrls = useCallback(() => {
    for (const url of blobAudioUrlsRef.current) URL.revokeObjectURL(url)
    blobAudioUrlsRef.current.clear()
  }, [])

  const replaceBlobAudioUrlWithFile = useCallback((messageId: string, blobUrl: string | undefined, audioPath: string) => {
    if (!blobUrl?.startsWith('blob:') || !audioDirRef.current) return
    const fileUrl = convertFileSrc(`${audioDirRef.current}/${audioPath}`)
    setChatMessages((prev) =>
      prev.map((m) => m.id === messageId && m.audioUrl === blobUrl ? { ...m, audioUrl: fileUrl } : m)
    )
    URL.revokeObjectURL(blobUrl)
    blobAudioUrlsRef.current.delete(blobUrl)
  }, [])

  useEffect(() => revokeTrackedBlobAudioUrls, [revokeTrackedBlobAudioUrls])
  const [sessions, setSessions] = useState<readonly ChatSessionInfo[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerDock = useDockPresence(pickerOpen)

  // ── Presence Detection ──
  // 摄像头整套暂时关掉（见 lib/presence/feature.ts）
  const { presence, videoRef } = usePresenceDetection(CAMERA_PRESENCE_ENABLED && config.overlayEnabled)
  // 系统提示词只在重算时读一下当前在场状态：检测每帧都在更新它，绑进依赖会让提示词每秒重算好几遍
  const presenceRef = useRef(presence)
  presenceRef.current = presence

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
        // 只有「本应用 exe 那条还没写过」才算第一次开启、需要提示重启。
        // WebView2 自动更新导致的新版本路径由 Rust 在建窗口前补写（gpu_pref::refresh_on_startup），不打扰用户
        const firstTimeEnable = !before.self_exe_pref_set
        await invoke('set_gpu_pref_high_performance', { enable: config.useDiscreteGpu })

        // 标记当前会话是否处于"等重启"状态：开关开但还没切到独显
        const onDiscrete = detectCurrentGpuIsDiscrete()
        if (config.useDiscreteGpu && !onDiscrete) {
          window.sessionStorage.setItem('solo:gpuPendingRestart', '1')
        } else {
          window.sessionStorage.removeItem('solo:gpuPendingRestart')
        }

        if (config.useDiscreteGpu && firstTimeEnable) {
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
    if (!CAMERA_PRESENCE_ENABLED) return
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
    const options = await withBrowserArgs({
      url,
      title: 'Camera Preview',
      width: 240,
      height: 220,
      alwaysOnTop: true,
      decorations: false,
      resizable: false,
      skipTaskbar: true,
    })
    let win: import('@tauri-apps/api/webviewWindow').WebviewWindow
    try {
      win = new WebviewWindow('camera-preview', options)
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
  // 同一状态的 React 版：聊天栏据此显示「正在听」
  const [fairyUiState, setFairyUiState] = useState<FairyState>('idle')
  const voiceServiceRef = useRef<VoiceService | null>(null)
  const configRef = useRef(config)
  // 同步进来的设置只更新配置，不写回同步表（规则见 synced-settings.ts）
  const applySyncedSettings = useCallback(async () => {
    const updates = configUpdatesFromSettings(await fetchSyncedSettings(), configRef.current)
    if (Object.keys(updates).length === 0) return
    setConfig((prev) => {
      const next = updateConfig(prev, updates)
      configRef.current = next
      return next
    })
  }, [])
  const systemPromptRef = useRef<string>('')
  // 文字模式用：静态段作系统提示词（跨轮不变，吃得到前缀缓存），动态段作本轮 <system-reminder>
  const promptPartsRef = useRef<{ staticPrompt: string; dynamicContext: string }>({ staticPrompt: '', dynamicContext: '' })
  const chatMessagesRef = useRef<ChatMessage[]>([])
  const omniUserInputPersistedRef = useRef(false)
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
        // 恢复会话时要拼图片地址，也先拿目录
        await initChatImages().catch(() => {})

        const { sessionId, state } = await initChatSession()
        sessionIdRef.current = sessionId
        persistedBufferRef.current = [...state.messages]

        // 恢复最近一次的 session title（用于决定是否要 AI 重命名）
        const recent = await getRecentChatSessions(1)
        const restoredTitle = recent[0]?.id === sessionId ? (recent[0].title || DEFAULT_SESSION_TITLE) : DEFAULT_SESSION_TITLE
        applySessionTitle(restoredTitle)
        titleFlow.reset(sessionId, restoredTitle, countUserMessages(state.messages))

        if (state.messages.length > 0) {
          setChatMessages(sessionMessagesToChatMessages(state.messages, audioDir))
          conversationRef.current = restoreLLMHistory(state.messages, await loadRestoredImages(state.messages))
        }
      } catch {
        // 后端不可用：静默降级（不影响功能，不持久化）
      }
    })()
  }, [])

  const fairyWinRef = useRef<import('@tauri-apps/api/webviewWindow').WebviewWindow | null>(null)

  useEffect(() => {
    if (!config.fairyWindowEnabled) {
      fairyWinRef.current?.close().catch(() => {})
      fairyWinRef.current = null
      return
    }

    let cancelled = false
    const init = async () => {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      if (cancelled) return
      const url = window.location.href.replace(/#.*$/, '') + '#fairy'
      const initialSize = Math.round(280 * clampFairyScale(config.fairyWindowScale))
      const options = await withBrowserArgs({
        url,
        title: 'Fairy',
        width: initialSize,
        height: initialSize,
        alwaysOnTop: true,
        decorations: false,
        resizable: true,
        maximizable: false,   // 禁用 Aero Snap 最大化（拖到屏幕边缘）
        minimizable: false,
        skipTaskbar: true,
        transparent: true,
        shadow: false,
      })
      if (cancelled) return
      try {
        const win = new WebviewWindow('fairy-window', options)
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
  }, [config.fairyWindowEnabled])

  const emitFairyConfig = useCallback((scale: number, aiMode: ChatMode) => {
    import('@tauri-apps/api/event').then(({ emitTo }) => {
      emitTo('fairy-window', 'fairy-config', {
        scale: clampFairyScale(scale),
        aiMode,
      }).catch(() => {})
    })
  }, [])

  useEffect(() => {
    if (!config.fairyWindowEnabled) return
    emitFairyConfig(config.fairyWindowScale, config.aiMode)
  }, [config.aiMode, config.fairyWindowEnabled, config.fairyWindowScale, emitFairyConfig])

  const emitFairy = useCallback((state: FairyState, text = '') => {
    fairyStateRef.current = state
    setFairyUiState(state)
    import('@tauri-apps/api/event').then(({ emitTo }) => {
      emitTo('fairy-window', 'fairy-state', { state, text }).catch(() => {})
    })
  }, [])

  // fairy window listener 就绪时重发当前状态，修复启动后前几次 Alt 无反应
  useEffect(() => {
    return listenTauriEventStrict<unknown>('fairy-window-ready', () => {
        emitFairy(fairyStateRef.current)
        emitFairyConfig(configRef.current.fairyWindowScale, configRef.current.aiMode)
    })
  }, [emitFairy, emitFairyConfig])

  // ── Fetch Activities + Perception Spans ──
  const isToday = useCallback((date: Date) => {
    const now = new Date()
    return date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
  }, [])
  const protocolViewLabel = '协议志'
  // 上下文占用（聊天栏 CTX 段码条）：当前历史的 token / 压缩门槛，过线后较早的对话会被压缩
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const contextRatio = useMemo(() => estimateContextTokens(conversationRef.current, contextOverheadRef.current) / contextBudgetRef.current.trigger, [chatMessages])


  // 今天每 15 秒轮询一次：数据没变就保留原数组——换成新数组会让整个 App 重渲染一遍（开发模式下约半秒，界面一顿一顿的）
  const refreshPerceptionSpans = useCallback(() => {
    fetchPerceptionSpans(selectedDate)
      .then((next) => setPerceptionSpans((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)))
      .catch(() => {})
    fetchBiliSpans(selectedDate)
      .then((next) => setBiliSpans((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)))
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

  // 启动时从 models.dev 更新一次 Anthropic 的模型清单和价目；失败不打扰，模型库里可以手动再拉
  useEffect(() => {
    pullAnthropicModels()
      .then((count) => console.log(`[Models] Anthropic 模型清单已更新，共 ${count} 个`))
      .catch((e) => console.warn('[Models] 更新 Anthropic 模型清单失败:', e))
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

  // 主舞台视图的回调（稳定引用，见文件顶部 Stage* 的说明）
  const handlePlanNodesChange = useCallback(() => { refreshPlanNodes() }, [refreshPlanNodes])
  const toggleEditMode = useCallback(() => setEditMode((m) => !m), [])
  const handleAppSpanHover = useCallback((span: PerceptionSpan | null, minute?: number | null) => {
    setHoveredAppSpan(span)
    setHoveredAppMinute(minute ?? null)
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
  // 注意：listen() 是异步注册，必须用 cancelled flag 防止 StrictMode 重挂载时
  //       cleanup 先于注册完成，导致 listener 双重注册触发重复事件
  useEffect(() => {
    let cancelled = false
    let unlisteners: Array<() => void> = []
    const linkAliasOf = (deviceId: string | undefined): string | undefined => {
      if (!deviceId) return undefined
      return linkedDevicesRef.current.find((l) => l.device_id === deviceId)?.alias
    }
    ;(async () => {
      const { listen } = await import('@tauri-apps/api/event')
      if (cancelled) return
      // 拆解 SyncImportResult / SyncRoundResult 成简洁中文行
      const fmtImport = (r: { activity_categories?: number; activity_tags?: number; activity_blocks?: number; plan_nodes?: number; planned_blocks?: number; model_call_log?: number; model_api_keys?: number; model_free_quota?: number; feature_bindings?: number; model_registry?: number; chat_sessions?: number; chat_messages?: number; settings?: number; chat_images?: number; skipped?: number } | null | undefined): string => {
        if (!r) return '0 条'
        const parts: string[] = []
        if (r.activity_categories) parts.push(`分类×${r.activity_categories}`)
        if (r.activity_tags) parts.push(`标签×${r.activity_tags}`)
        if (r.activity_blocks) parts.push(`实际块×${r.activity_blocks}`)
        if (r.plan_nodes) parts.push(`计划节点×${r.plan_nodes}`)
        if (r.planned_blocks) parts.push(`计划块×${r.planned_blocks}`)
        if (r.model_call_log) parts.push(`用量日志×${r.model_call_log}`)
        if (r.model_api_keys) parts.push(`API key×${r.model_api_keys}`)
        if (r.model_free_quota) parts.push(`免费额度×${r.model_free_quota}`)
        if (r.feature_bindings) parts.push(`功能绑定×${r.feature_bindings}`)
        if (r.model_registry) parts.push(`模型库×${r.model_registry}`)
        if (r.chat_sessions) parts.push(`聊天会话×${r.chat_sessions}`)
        if (r.chat_messages) parts.push(`聊天消息×${r.chat_messages}`)
        if (r.settings) parts.push(`设置×${r.settings}`)
        if (r.chat_images) parts.push(`聊天图片×${r.chat_images}`)
        if (parts.length === 0) return r.skipped ? `0 条（跳过 ${r.skipped}）` : '0 条'
        const skipNote = r.skipped ? ` · 跳过 ${r.skipped}` : ''
        return parts.join(' + ') + skipNote
      }
      const us = await Promise.all([
        listen<{ from_device_id?: string; changed?: number; result?: any }>('sync:imported', (e) => {
          const alias = linkAliasOf(e.payload?.from_device_id) ?? '对端'
          const detail = fmtImport(e.payload?.result)
          pushSyncLog({
            kind: 'sync',
            alias,
            text: `← ${alias} 推过来 ${detail}`,
          })
          if (e.payload?.result?.settings > 0) {
            applySyncedSettings().catch((err) => console.warn('[Sync] 读取同步设置失败', err))
          }
          // 触发刷新；每个 fetch 完成后再各打一行确认本地真实落库行数
          const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
          Promise.all([
            fetchActivityPalette().then((p) => {
              setActivityPalette(p)
              return `标签库 ${p.categories.length} 分类 / ${p.tags.length} 标签`
            }),
            fetchActivityBlocks(selectedDate).then((b) => {
              setActivityBlocks(b)
              // AUDIT-001: 同步进来的新 blocks 会覆盖当前 state，旧 undo 快照
              // 是基于旧 state 拍的，按它撤回会把同步进来的数据覆盖丢失。
              // 同日同步刷新等同"换了一份当日 blocks"，清栈避免误覆盖。
              setUndoStack([])
              setRedoStack([])
              return `${dateStr} 实际块 ${b.length}`
            }),
            fetchPlannedBlocks(selectedDate).then((b) => {
              setPlannedBlocks(b)
              setPlanUndoStack([])
              setPlanRedoStack([])
              return `计划块 ${b.length}`
            }),
            // AUDIT-033: 同步拉进来的 plan_nodes 必须回写 state，否则右侧计划树
            // 滞后于昼夜表计划块（昼夜表已 setPlannedBlocks 但 TodoListPanel 仍
            // 拿旧 planNodes）。逻辑跟 refreshPlanNodes() 对齐：setPlanNodes +
            // 校正 selectedPlanNodeId（如被同步删了就清空选中）
            selectedProjectTagId != null
              ? fetchPlanNodes(selectedProjectTagId).then((nodes) => {
                  setPlanNodes(nodes)
                  setSelectedPlanNodeId((id) =>
                    id != null && nodes.some((node) => node.id === id) ? id : null,
                  )
                  return `计划节点 ${nodes.length}`
                })
              : Promise.resolve('计划节点 -'),
          ]).then((lines) => {
            invalidateActivityRangeCache(selectedDate)
            pushSyncLog({ kind: 'info', alias, text: `🔄 已重渲染: ${lines.join(' · ')}` })
          }).catch((err) => {
            pushSyncLog({ kind: 'error', alias, text: `🔄 重渲染失败: ${err}` })
          })
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
          const alias = linkAliasOf(id) ?? id
          pushSyncLog({ kind: 'info', alias, text: `→ 开始与 ${alias} 同步` })
        }),
        listen<{
          device_id: string
          ok?: boolean
          error?: string | null
          result?: { pulled?: any; pushed?: any } | null
        }>('sync:finished', (e) => {
          const id = e.payload?.device_id
          if (id) {
            setSyncingDeviceIds((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
          }
          fetchSyncLinks().then(setLinkedDevices).catch(() => {})
          const alias = linkAliasOf(id) ?? id ?? '设备'
          if (e.payload?.ok) {
            const r = e.payload?.result
            const pullDetail = fmtImport(r?.pulled)
            const pushDetail = fmtImport(r?.pushed)
            pushSyncLog({
              kind: 'sync',
              alias,
              text: `✓ ${alias} 同步完成 · 拉 [${pullDetail}] / 推 [${pushDetail}]`,
            })
            // 拉过来的 row 数 > 0 才触发重渲染（避免空 pull 也刷新打扰）。
            // 之前缺这段：sync:finished 只刷设备列表，本端是发起方时
            // pull 到的对端数据要等下次手动 fetch 才显示，体验不对。
            const pulled = r?.pulled
            if ((pulled?.settings ?? 0) > 0) {
              applySyncedSettings().catch((err) => console.warn('[Sync] 读取同步设置失败', err))
            }
            if ((pulled?.chat_images ?? 0) > 0) window.dispatchEvent(new Event(CHAT_IMAGES_UPDATED))
            // AUDIT-035：pulledCount 也必须包含模型 4 表，否则纯模型同步时
            // pulledCount=0，下面的重渲染分支永远不会触发，前端永远拿不到新模型设置
            const pulledCount =
              (pulled?.activity_categories ?? 0) +
              (pulled?.activity_tags ?? 0) +
              (pulled?.activity_blocks ?? 0) +
              (pulled?.plan_nodes ?? 0) +
              (pulled?.planned_blocks ?? 0) +
              (pulled?.model_api_keys ?? 0) +
              (pulled?.model_call_log ?? 0) +
              (pulled?.model_free_quota ?? 0) +
              (pulled?.feature_bindings ?? 0) +
              (pulled?.model_registry ?? 0)
            if (pulledCount > 0) {
              const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
              Promise.all([
                fetchActivityPalette().then((p) => {
                  setActivityPalette(p)
                  return `标签库 ${p.categories.length} 分类 / ${p.tags.length} 标签`
                }),
                fetchActivityBlocks(selectedDate).then((b) => {
                  setActivityBlocks(b)
                  // AUDIT-001: 同上 sync:imported 分支 —— pull 进来的新 blocks
                  // 覆盖当前 state，旧 undo 快照按它撤回会把同步进来的数据覆盖丢失
                  setUndoStack([])
                  setRedoStack([])
                  return `${dateStr} 实际块 ${b.length}`
                }),
                fetchPlannedBlocks(selectedDate).then((b) => {
                  setPlannedBlocks(b)
                  setPlanUndoStack([])
                  setPlanRedoStack([])
                  return `计划块 ${b.length}`
                }),
                // AUDIT-033: 同 sync:imported 分支，pull 完后必须 setPlanNodes
                // 让 TodoListPanel 跟上同步结果，并校正 selectedPlanNodeId
                selectedProjectTagId != null
                  ? fetchPlanNodes(selectedProjectTagId).then((nodes) => {
                      setPlanNodes(nodes)
                      setSelectedPlanNodeId((id) =>
                        id != null && nodes.some((node) => node.id === id) ? id : null,
                      )
                      return `计划节点 ${nodes.length}`
                    })
                  : Promise.resolve('计划节点 -'),
              ]).then((lines) => {
                invalidateActivityRangeCache(selectedDate)
                pushSyncLog({ kind: 'info', alias, text: `🔄 已重渲染: ${lines.join(' · ')}` })
              }).catch((err) => {
                pushSyncLog({ kind: 'error', alias, text: `🔄 重渲染失败: ${err}` })
              })
            }
          } else {
            pushSyncLog({ kind: 'error', alias, text: `✗ ${alias} 同步失败: ${e.payload?.error ?? '未知错误'}` })
          }
        }),
      ])
      if (cancelled) {
        us.forEach((u) => u())
        return
      }
      unlisteners = us
    })().catch(() => {})
    return () => {
      cancelled = true
      unlisteners.forEach((u) => u())
    }
  }, [refreshActivityPalette, refreshActivityBlocks, refreshPlannedBlocks, refreshPlanNodes, selectedDate, pushSyncLog, applySyncedSettings])

  // 定时刷新 discovered peers（每 5 秒）—— 顶栏判断 linked 设备在线/离线
  useEffect(() => {
    const timer = setInterval(() => {
      // 比较时去掉 last_seen_at：对端在线时它每轮都变，整份比较永远不等，会每 5 秒重渲染整个 App
      const stable = (list: readonly SyncPeer[]) => JSON.stringify(list.map((p) => ({ ...p, last_seen_at: '' })))
      fetchSyncPeers()
        .then((next) => setDiscoveredPeers((prev) => (stable(prev) === stable(next) ? prev : next)))
        .catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [])

  // 自动同步：每 60 秒对所有在线 linked 设备触发一次双向同步
  const AUTO_SYNC_INTERVAL_S = 60
  const linkedDevicesRef = useRef(linkedDevices)
  const discoveredPeersRef = useRef(discoveredPeers)
  const syncingIdsRef = useRef(syncingDeviceIds)
  useEffect(() => { linkedDevicesRef.current = linkedDevices }, [linkedDevices])
  useEffect(() => { discoveredPeersRef.current = discoveredPeers }, [discoveredPeers])
  useEffect(() => { syncingIdsRef.current = syncingDeviceIds }, [syncingDeviceIds])

  useEffect(() => {
    const triggerAutoSync = () => {
      const onlineIds = new Set(discoveredPeersRef.current.map((p) => p.device_id))
      const syncingNow = syncingIdsRef.current
      for (const link of linkedDevicesRef.current) {
        if (!onlineIds.has(link.device_id)) continue
        if (syncingNow.has(link.device_id)) continue
        runSyncLink(link.device_id).catch((err) => {
          console.warn('[AutoSync] failed for', link.alias, err)
        })
      }
    }
    setNextAutoSyncAt(Date.now() + AUTO_SYNC_INTERVAL_S * 1000)
    const tick = setInterval(() => {
      triggerAutoSync()
      setNextAutoSyncAt(Date.now() + AUTO_SYNC_INTERVAL_S * 1000)
    }, AUTO_SYNC_INTERVAL_S * 1000)
    return () => clearInterval(tick)
  }, [])

  // 切换日期 → 清空撤回栈（栈是当日 blocks 的快照，跨日 apply 会写错日期）
  // 注意：editMode 不再触发清空，让"完成 → 再编辑"也能继续撤回最近的操作
  useEffect(() => {
    setUndoStack([])
    setRedoStack([])
    setPlanUndoStack([])
    setPlanRedoStack([])
  }, [selectedDate])

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
        setPlanRedoStack((redoPrev) => [...redoPrev.slice(-29), current])
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
      setRedoStack((redoPrev) => [...redoPrev.slice(-29), current])
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
        setPlanUndoStack((undoPrev) => [...undoPrev.slice(-29), current])
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
      setUndoStack((undoPrev) => [...undoPrev.slice(-29), current])
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
    /** 来自 dragRef 的 layer 戳；优先用它，避免拖拽中途切层时写到错层 */
    layer: RecordLayer
    rangeStartMin: number
    rangeEndMin: number
  }) => {
    if (spec.paintMinutes.length === 0 && spec.eraseMinutes.length === 0) return

    const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
    const nowIso = new Date().toISOString()

    if (spec.layer === 'plan') {
      const snapshot = plannedBlocks
      setPlanUndoStack((prev) => [...prev.slice(-29), snapshot])
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
    setUndoStack((prev) => [...prev.slice(-29), snapshot])
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
  }, [selectedDate, activityBlocks, plannedBlocks, planNodes, activityPalette, refreshActivityBlocks, refreshPlannedBlocks, refreshActivityPalette])

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
        onPartialTranscript: (text, sessionMsgId) => {
          // 边说边出字：先以文字气泡出现，录音到手后变成语音气泡（同一条消息 id）
          setChatMessages((prev) => prev.some((m) => m.id === sessionMsgId)
            ? prev.map((m) => m.id === sessionMsgId ? { ...m, content: m.audioUrl ? m.content : text, transcript: text } : m)
            : [...prev, {
                id: sessionMsgId, role: 'user' as const,
                content: text, transcript: text, timestamp: new Date().toISOString(),
              }])
        },
        onAsrResult: (r, startedAt) => {
          const u = r.usage
          void logModelUsage({
            feature: 'fairy_voice_asr',
            modelId: r.model,
            startedAt,
            durationMs: r.timings.totalMs,
            usage: u ? {
              prompt_tokens: u.input_tokens,
              completion_tokens: u.output_tokens,
              total_tokens: u.input_tokens + u.output_tokens,
              prompt_tokens_details: { audio_tokens: u.input_tokens },
            } : null,
            success: r.text.trim().length > 0,
            errorMessage: r.text.trim() ? null : (r.hadSpeech ? '有声音但没识别出文字' : '没有录到声音'),
            metadata: {
              timings: r.timings, attempts: r.attempts, fallback: r.fallback,
              device: r.device, audioMs: r.durationMs, hadSpeech: r.hadSpeech,
              glitches: r.glitches, captureRestarts: r.captureRestarts,
            },
          })
        },
        onUserAudio: (wavBase64, durationMs, sessionMsgId) => {
          // 把录音转成 blob URL，作为用户语音气泡显示；边说边出字时气泡已存在，就地补上音频
          const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
          const blob = new Blob([bytes], { type: 'audio/wav' })
          const audioUrl = trackBlobAudioUrl(URL.createObjectURL(blob))
          const msgTimestamp = new Date().toISOString()
          voiceRecordedAtRef.current.set(sessionMsgId, msgTimestamp)
          setChatMessages((prev) => prev.some((m) => m.id === sessionMsgId)
            ? prev.map((m) => m.id === sessionMsgId ? { ...m, content: '', audioUrl, durationMs } : m)
            : [...prev, {
                id: sessionMsgId, role: 'user' as const,
                content: '', audioUrl, durationMs,
                timestamp: msgTimestamp,
              }])

          // 异步落盘；onTranscript 持久化前会等它
          const sid = sessionIdRef.current
          if (sid) {
            audioSaveRef.current.set(sessionMsgId, invoke<string>('save_audio_file', {
              sessionId: sid,
              wavBytes: bytes,
              timestamp: msgTimestamp,
            }).then((audioPath) => {
              replaceBlobAudioUrlWithFile(sessionMsgId, audioUrl, audioPath)
              return { audioPath, durationMs }
            }).catch((e) => {
              console.warn('[Voice] 录音落盘失败，消息仍会保存文字', e)
              return null
            }))
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
          const isOmniMode = configRef.current.aiMode === 'omni'
          if (isOmniMode) omniUserInputPersistedRef.current = false
          // 起标题按「主人说了几句」数；没转写出文字的那句不算
          if (text.trim()) titleFlowRef.current?.onUserMessage(text)
          // 待发的图片跟这句语音一起发。实时语音发不了图，留在输入框
          const images = !isOmniMode && text.trim() ? takeVoiceImagesRef.current() : []
          const bubbleImages = images.map(({ id, url }) => ({ id, url }))
          // 更新用户气泡的转写文字
          setChatMessages((prev) =>
            prev.map((m) => m.id === sessionMsgId
              ? { ...m, transcript: text, ...(bubbleImages.length > 0 ? { images: bubbleImages } : {}) }
              : m)
          )

          // 语音消息持久化：等录音落盘拿到 audioPath（落盘失败也照样存文字，别丢主人说的话）
          // 这句落库的时间，发给模型的那条也用它（压缩按时间在库里找分界）
          let voiceTimestamp = new Date().toISOString()
          const sid = sessionIdRef.current
          if (sid) {
            const saving = audioSaveRef.current.get(sessionMsgId) ?? Promise.resolve(null)
            audioSaveRef.current.delete(sessionMsgId)
            const recordedAt = voiceRecordedAtRef.current.get(sessionMsgId)
            voiceRecordedAtRef.current.delete(sessionMsgId)
            voiceTimestamp = recordedAt ?? voiceTimestamp
            if (isOmniMode) omniUserInputPersistedRef.current = true
            void saving.then((saved) => {
              const voiceMsg = {
                ...makeSessionMessage('user', withImageMarker(text, images.map((i) => i.id)), saved?.audioPath, saved?.durationMs),
                timestamp: voiceTimestamp,
              }
              persistedBufferRef.current = [...persistedBufferRef.current, voiceMsg]
              return persistMessages(sid, [voiceMsg])
            }).catch((e) => console.warn('[Voice] 语音消息持久化失败', e))
          }

          // Omni 模式：音频已经走 WS，工具调用走 omni://tool_call 事件，不回落 handleSend
          if (isOmniMode) {
            lastOmniUserInputRef.current = text   // 供 audio_done 持久化使用
          } else {
            handleSend(text, true, undefined, images, voiceTimestamp)
          }
        },
        onOmniCommitted: () => omniReplyWatchdogRef.current?.arm(),
        onAudioLevel: () => {
          // 音量走 voice://level 事件直接广播给 Fairy 悬浮窗，这里不用处理
        },
        onError: (message) => {
          omniUsageStartedAtRef.current = 0
          setChatMessages((prev) => [...prev, {
            id: crypto.randomUUID(), role: 'system' as const,
            content: message, timestamp: new Date().toISOString(),
          }])
          emitFairy('idle')
        },
      },
      () => toRealtimeTools(TOOL_DEFINITIONS),
      () => ({ vocabulary: asrVocabularyRef.current, context: buildAsrContext(conversationRef.current) }),
    )
    voiceServiceRef.current = svc
    return svc
  }, [emitFairy, replaceBlobAudioUrlWithFile, trackBlobAudioUrl])

  // ── Omni 全模态模式：监听 AI 回复事件 ──
  const omniAudioCtxRef = useRef<AudioContext | null>(null)
  const omniNextStartRef = useRef<number>(0)
  const omniLastSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const omniLastSourceEndedRef = useRef<boolean>(true)
  const omniPlayingSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set())  // 排队中的音频块，打断时一起停
  const omniAlignPcmRef = useRef(createPcm16Aligner())
  const omniTextAccRef = useRef<string>('')
  const omniAiPcmChunksRef = useRef<Uint8Array[]>([])
  const omniAgentMsgIdRef = useRef<string | null>(null)   // 当前 AI 回复气泡的消息 ID
  const omniDebugInfoRef = useRef<OmniDebugInfo | null>(null)  // 本轮 Omni 上下文快照（随气泡写入）
  const omniLastUsageRef = useRef<ModelCallLog | null>(null)   // 本轮 Omni 模型审计快照（随气泡持久化）
  const omniUsageStartedAtRef = useRef<number>(0)         // 本轮 Omni 调用起点，独立于 RAlt 按压时间
  const omniAwaitingConnectionRef = useRef(false)         // 主人开口后、新连接就绪前：收到的都是被打断那一轮的，丢掉
  const omniIdleWaitRef = useRef(0)                       // 等播完期间主人又开口 / 切走：旧的等待作废
  const omniTurnEpochRef = useRef(0)                      // 这一轮作废就加一：旧一轮的工具跑完后，结果不能发给新连接
  const omniToolsRunningRef = useRef(0)
  const omniReplyWatchdogRef = useRef<OmniWatchdog | null>(null)
  const omniPressStartRef = useRef<() => void>(() => {})  // 只有实时模式才挂上
  const refreshSystemPromptRef = useRef<() => Promise<string>>(() => Promise.resolve(''))

  useEffect(() => {
    if (config.aiMode !== 'omni') return

    const playOmniPcm = (chunk: Uint8Array) => {
      if (!omniAudioCtxRef.current) {
        omniAudioCtxRef.current = new AudioContext({ sampleRate: 24000 })
        omniNextStartRef.current = omniAudioCtxRef.current.currentTime
      }
      const ctx = omniAudioCtxRef.current
      const bytes = omniAlignPcmRef.current(chunk)
      const samples = bytes.length / 2
      if (samples === 0) return
      const buf = ctx.createBuffer(1, samples, 24000)
      const ch = buf.getChannelData(0)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
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
      omniPlayingSourcesRef.current.add(src)
      src.onended = () => {
        omniPlayingSourcesRef.current.delete(src)
        if (omniLastSourceRef.current === src) {
          omniLastSourceEndedRef.current = true
          console.log('[FairyDbg] last src onended', { ctxNow: ctx.currentTime.toFixed(3), queueEnd: omniNextStartRef.current.toFixed(3) })
        }
      }
    }

    const stopOmniPlayback = () => {
      omniPlayingSourcesRef.current.forEach((src) => src.stop())
      omniPlayingSourcesRef.current.clear()
      omniNextStartRef.current = 0
      omniLastSourceRef.current = null
      omniLastSourceEndedRef.current = true
      omniAlignPcmRef.current = createPcm16Aligner()
    }

    // 这一轮等不到 audio_done 了（主人开口打断 / 切走实时模式 / 断线 / 超时）：
    // 给气泡收尾、把已有的文字落库；不清掉的话下一轮的文字会接到这个旧气泡上
    const closeOmniTurn = (mark: string) => {
      const msgId = omniAgentMsgIdRef.current
      const partial = omniTextAccRef.current.trim()
      omniTextAccRef.current = ''
      omniAgentMsgIdRef.current = null
      omniAiPcmChunksRef.current = []
      if (!msgId) return
      setChatMessages((prev) =>
        prev.map((m) => m.id === msgId && m.content ? { ...m, content: `${m.content}……（${mark}）` } : m)
      )
      const sid = sessionIdRef.current
      if (sid && partial) {
        const bubble = chatMessagesRef.current.find((m) => m.id === msgId)
        const row = {
          ...makeSessionMessage('assistant', partial),
          ...(bubble ? { timestamp: bubble.timestamp } : null),
        }
        persistedBufferRef.current = [...persistedBufferRef.current, row]
        persistMessages(sid, [row]).catch((e) => console.warn('[Omni] 没说完的回复写入失败', e))
      }
    }

    // 这一轮不要了：等播完、等回复都作废，还在跑的工具跑完也不回传
    const abandonOmniTurn = () => {
      omniIdleWaitRef.current += 1
      omniTurnEpochRef.current += 1
      omniToolsRunningRef.current = 0
      omniReplyWatchdogRef.current?.disarm()
    }

    const watchdog = createOmniWatchdog(OMNI_REPLY_TIMEOUT_MS, () => omniToolsRunningRef.current > 0, () => {
      abandonOmniTurn()
      closeOmniTurn('没说完')
      lastOmniUserInputRef.current = ''
      omniUserInputPersistedRef.current = false
      setChatMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'system' as const,
        content: `Omni 超过 ${OMNI_REPLY_TIMEOUT_MS / 1000} 秒没有回应，这一轮先结束了`,
        timestamp: new Date().toISOString(),
      }])
      voiceServiceRef.current?.cancel()  // 断开连接、语音服务回到 idle
      emitFairy('idle')
    })
    omniReplyWatchdogRef.current = watchdog

    omniPressStartRef.current = () => {
      abandonOmniTurn()
      omniDebugInfoRef.current = null
      closeOmniTurn('被打断')
      stopOmniPlayback()
      omniAwaitingConnectionRef.current = true
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
          if (omniAwaitingConnectionRef.current) return
          watchdog.touch()
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
      if (omniAwaitingConnectionRef.current) return
      watchdog.touch()
      const pcm = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0))
      omniAiPcmChunksRef.current.push(pcm)
      playOmniPcm(pcm)
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
          if (omniAwaitingConnectionRef.current) return
          const epoch = omniTurnEpochRef.current
          omniToolsRunningRef.current += 1
          watchdog.arm()
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
          // 工具跑的时候这一轮已经作废（连接换过了）：这个 call_id 新连接不认识
          if (epoch !== omniTurnEpochRef.current) return
          omniToolsRunningRef.current -= 1
          watchdog.arm()
          try {
            await invoke('omni_tool_result', { callId: payload.call_id, output: result })
          } catch (err) {
            console.error('[Omni] omni_tool_result failed', err)
          }
    })

    // Omni Realtime 一轮结束携带 usage：写入审计 + 立即贴到当前 agent 气泡
    registerListen<{ model: string; usage: RealtimeUsage }>('omni://usage', ({ payload }) => {
      const startedMs = omniUsageStartedAtRef.current || Date.now()
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
      }).finally(() => {
        if (omniUsageStartedAtRef.current === startedMs) omniUsageStartedAtRef.current = 0
      })
    })

    registerListen<{ status: string; message?: string }>('omni://status', ({ payload }) => {
          if (payload.status === 'connected') {
            omniAwaitingConnectionRef.current = false
          } else if (payload.status === 'audio_done') {
            if (omniAwaitingConnectionRef.current) return
            watchdog.disarm()
            const chunks = omniAiPcmChunksRef.current
            omniAiPcmChunksRef.current = []
            omniAlignPcmRef.current = createPcm16Aligner()
            omniTextAccRef.current = ''
            const msgId = omniAgentMsgIdRef.current
            omniAgentMsgIdRef.current = null

            const wavBlob = chunks.length > 0 ? pcm16ChunksToWavBlob(chunks, 24000) : null
            const audioUrl = wavBlob ? trackBlobAudioUrl(URL.createObjectURL(wavBlob)) : undefined

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
            // AudioContext 被挂起时 onended 不会来：排队的音频播完再多等一会儿就不等了
            const idleWait = ++omniIdleWaitRef.current
            const queuedMs = ctxAtDone ? Math.max(0, omniNextStartRef.current - ctxAtDone.currentTime) * 1000 : 0
            const idleDeadline = Date.now() + queuedMs + OMNI_PLAYBACK_GRACE_MS
            let pollCount = 0
            const waitAudioEnded = () => {
              // 等播完期间主人又开口：不再发 idle，否则把「在听」盖掉
              if (idleWait !== omniIdleWaitRef.current) return
              pollCount++
              if (omniLastSourceEndedRef.current || Date.now() >= idleDeadline) {
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
              const newPairs: SessionMessage[] = []
              const userInput = lastOmniUserInputRef.current.trim()
              const aiText = (msgId
                ? chatMessagesRef.current.find((m) => m.id === msgId)?.content ?? ''
                : ''
              ).trim()
              if (userInput && !omniUserInputPersistedRef.current) {
                newPairs.push(makeSessionMessage('user', userInput))
              }

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
                    if (msgId) replaceBlobAudioUrlWithFile(msgId, audioUrl, aiAudioPath)
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
              persistAiMsg()
                .then(() => {
                  if (newPairs.length > 0) {
                    persistedBufferRef.current = [...persistedBufferRef.current, ...newPairs]
                    persistMessages(sid, newPairs).catch(() => {})
                  }
                })
                .catch(() => {})
                .finally(() => {
                  // 主人已经开始下一句：这里存的是新一轮的输入，不能清
                  if (lastOmniUserInputRef.current.trim() === userInput) {
                    lastOmniUserInputRef.current = ''
                    omniUserInputPersistedRef.current = false
                  }
                })
            }
          } else if (payload.status === 'error') {
            watchdog.disarm()
            omniIdleWaitRef.current += 1
            closeOmniTurn('没说完')
            lastOmniUserInputRef.current = ''
            omniUserInputPersistedRef.current = false
            setChatMessages((prev) => [...prev, {
              id: crypto.randomUUID(), role: 'system' as const,
              content: `Omni 错误: ${payload.message ?? '未知'}`,
              timestamp: new Date().toISOString(),
            }])
            emitFairy('idle')  // 这一轮不会再有 audio_done，不回 idle 就一直停在思考
          } else if (payload.status === 'disconnected') {
            // 没有回复在进行（等播完、录音中、回复早结束了）：这是正常的换连接或服务端清理空闲连接，
            // 这时可能正在打字走常规模型，不能动它的状态
            if (!watchdog.isArmed()) return
            watchdog.disarm()
            closeOmniTurn('没说完')
            lastOmniUserInputRef.current = ''
            omniUserInputPersistedRef.current = false
            setChatMessages((prev) => [...prev, {
              id: crypto.randomUUID(), role: 'system' as const,
              content: 'Omni 连接断开了，这一轮没有说完',
              timestamp: new Date().toISOString(),
            }])
            emitFairy('idle')
          }
    })

    // omni://user_transcript 由 voice-service 内部消费（调 onTranscript 更新气泡），此处无需重复处理

    return () => {
      disposed = true
      unlisteners.forEach((fn) => fn())
      // 回复途中切走实时模式：再也收不到 audio_done，气泡和 Fairy 都会停在半路。连接也停掉，别继续播
      abandonOmniTurn()
      closeOmniTurn('被打断')
      stopOmniPlayback()
      omniPressStartRef.current = () => {}
      omniReplyWatchdogRef.current = null
      omniAwaitingConnectionRef.current = false
      invoke('omni_stop').catch(() => {})
      if (fairyStateRef.current !== 'listening' && !replyControlRef.current) emitFairy('idle')
    }
  }, [config.aiMode, emitFairy])

  // ── Right Alt Long-Press → Voice Chat（全局热键，无需窗口聚焦）──
  useEffect(() => {
    let lastDownMs = 0
    // 松手后先等一小段时间再真正结束录音：蓝牙键盘可能发出假的 keyup，窗口内又按下就视为同一次按住
    let releaseTimer: ReturnType<typeof setTimeout> | null = null
    const RELEASE_DEBOUNCE_MS = 600
    const onDown = () => {
      if (releaseTimer) {
        clearTimeout(releaseTimer)
        releaseTimer = null
        return
      }
      if (pressingRef.current) return
      // 两路（DOM + Rust）可能在同一帧触发，去重
      const now = Date.now()
      if (now - lastDownMs < 50) return
      lastDownMs = now
      pressingRef.current = true
      console.log('[RAlt] keydown received')
      altDownTimeRef.current = Date.now()
      // Fairy 正在想或正在说：主人一开口就停下（打断），轻按一下右 Alt 也能让她闭嘴
      replyControlRef.current?.interrupt()
      replyControlRef.current = null
      omniPressStartRef.current()
      // 按下就开始录音、连识别服务，长按阈值只用于松手时区分误触；
      // 不满 LONG_PRESS_MS 就松开时，onUp 的 cancel() 会把它们一并关掉
      getVoiceService().startRecording()

      setTimeout(() => {
        if (pressingRef.current && Date.now() - altDownTimeRef.current >= LONG_PRESS_MS) {
          emitFairy('listening')  // 立即给视觉反馈，不等 mic 权限
          // Omni 语音模式：提前刷 system prompt 并写 debug 快照（onUserAudio 无法知道 systemPrompt）
          if (configRef.current.aiMode === 'omni') {
            omniUsageStartedAtRef.current = Date.now()
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
        }
      }, LONG_PRESS_MS)
    }

    let lastUpMs = 0
    // releasedAt 取松开的时刻，去抖等待不计入按住时长
    const finishRelease = (releasedAt: number) => {
      releaseTimer = null
      pressingRef.current = false
      const holdDuration = releasedAt - altDownTimeRef.current

      if (holdDuration >= LONG_PRESS_MS && fairyStateRef.current === 'listening') {
        const svc = getVoiceService()
        svc.stopAndProcess()
      } else if (holdDuration >= LONG_PRESS_MS && voiceServiceRef.current?.getPhase() === 'thinking') {
        // 录音已经自己结束（满 90 秒 / 麦克风中断）并交给了回复，松手时别把它取消掉
      } else {
        const svc = voiceServiceRef.current
        if (svc) svc.cancel()
        omniUsageStartedAtRef.current = 0
        emitFairy('idle')
      }
    }
    const onUp = () => {
      if (!pressingRef.current || releaseTimer) return
      const now = Date.now()
      if (now - lastUpMs < 50) return
      lastUpMs = now
      const releasedAt = Date.now()
      releaseTimer = setTimeout(() => finishRelease(releasedAt), RELEASE_DEBOUNCE_MS)
    }

    // 打断键：RAlt 按住时按 RCtrl → 取消录音/请求
    const onCancel = () => {
      if (!pressingRef.current) return
      console.log('[RAlt] cancel via RCtrl')
      if (releaseTimer) {
        clearTimeout(releaseTimer)
        releaseTimer = null
      }
      pressingRef.current = false
      replyControlRef.current?.interrupt()
      replyControlRef.current = null
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

    let disposed = false
    const eventUnlisteners: Array<() => void> = []
    import('@tauri-apps/api/event').then(({ listen }) => {
      if (disposed) return
      Promise.all([
        listen('ralt-keydown', onDown),
        listen('ralt-keyup',   onUp),
        listen('voice-cancel', onCancel),
      ]).then(([u1, u2, u3]) => {
        if (disposed) {
          u1()
          u2()
          u3()
          return
        }
        eventUnlisteners.push(u1, u2, u3)
      }).catch(() => {})
    })

    return () => {
      disposed = true
      window.removeEventListener('keydown', onDomDown)
      window.removeEventListener('keyup',   onDomUp)
      if (releaseTimer) clearTimeout(releaseTimer)
      releaseTimer = null
      eventUnlisteners.forEach((fn) => fn())
      eventUnlisteners.length = 0
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
    for (const { key, value } of settingWrites(configRef.current, updates)) {
      saveSyncedSetting(key, value).catch((e) => console.warn('[Sync] 保存同步设置失败', e))
    }
    setConfig((prev) => {
      const next = updateConfig(prev, updates)
      configRef.current = next
      return next
    })
  }, [])

  // Fish 音色和模型：用户改过默认值就写种子，再用同步表里的值
  useEffect(() => {
    void (async () => {
      const rows = await fetchSyncedSettings()
      await Promise.all(seedWrites(rows, configRef.current, DEFAULT_CONFIG).map((w) => saveSyncedSetting(w.key, w.value, true)))
      await applySyncedSettings()
    })().catch((e) => console.warn('[Sync] 读取同步设置失败', e))
  }, [applySyncedSettings])

  // 旧版 Fish Key 存在配置里，不同步：搬进 Key 库，手机才拿得到
  useEffect(() => {
    if (!config.fishApiKey) return
    saveFishApiKey(config.fishApiKey)
      .then(() => handleConfigUpdate({ fishApiKey: null }))
      .catch((e) => console.error('[Config] 迁移 Fish Key 失败', e))
  }, [config.fishApiKey, handleConfigUpdate])

  const toggleFairyWindow = useCallback(() => {
    handleConfigUpdate({ fairyWindowEnabled: !configRef.current.fairyWindowEnabled })
  }, [closeBiliDialog, handleConfigUpdate])

  useEffect(() => {
    return listenTauriEventStrict<FairyActionPayload>('fairy-action', (e) => {
      const payload = e.payload
      if (payload.action === 'hide') {
        handleConfigUpdate({ fairyWindowEnabled: false })
        return
      }

      if (payload.action === 'open-settings') {
        setSettingsInitialSection('fairy')
        setSettingsInitialSectionTick((v) => v + 1)
        setShowSettings(true)
        closeBiliDialog()
        setShowModels(false)
        import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
          getCurrentWindow().setFocus().catch(() => {})
        })
        return
      }

      if (payload.action === 'set-scale') {
        handleConfigUpdate({ fairyWindowScale: clampFairyScale(payload.scale) })
        return
      }
    })
  }, [handleConfigUpdate])

  useEffect(() => {
    return listenTauriEventStrict<ModelFeatureBindingPayload>('model-feature-binding-updated', (e) => {
      const { feature, modelId } = e.payload ?? {}
      if (!feature || !modelId) return
      window.dispatchEvent(new CustomEvent('model-feature-binding-updated', {
        detail: { feature, modelId },
      }))
    })
  }, [])

  // ── System Prompt Builder（两套协议共用） ──
  const refreshSystemPrompt = useCallback(async (userText?: string) => {
    const cfg = configRef.current
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const today = new Date()
    const toHHmm = (s: string) => s.slice(11, 16)

    // 意图驱动：有 userText 按意图裁剪上下文段；无（定时/Omni 热读）则全量
    const intent = userText ? classifyIntent(userText) : null
    const wantActivity = !intent || intent.activity
    const wantBili = !intent || intent.bili
    const wantGoals = !intent || intent.goals

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

    const appUsageRaw: AppUsageRecord[] = perceptionData
      .filter((s) => s.track === 'apps' && new Date(s.end_at).getTime() >= oneHourAgo)
      .map((s) => ({ startTime: toHHmm(s.start_at), endTime: toHHmm(s.end_at), appName: s.title, windowTitle: s.group_name ?? '' }))
    // 瘦身：去终端 spinner 噪音、合并连续同进程段、限量
    const appUsage = compactAppUsage(appUsageRaw)

    const biliHistory: BiliRecord[] = biliSpans.status === 'fulfilled'
      ? biliSpans.value
          .filter((s) => new Date(s.start_at).getTime() >= oneHourAgo)
          .map((s) => ({ time: toHHmm(s.start_at), title: s.title, url: `https://www.bilibili.com/video/${s.bvid}` }))
      : []

    const staticPrompt = buildStaticPrompt(cfg.agentName, cfg.agentPersona, cfg.agentCallUser, cfg.mainQuest)
    // 按意图选择性注入；传 undefined 的段 buildDynamicContext 会自动跳过
    const dynamicContext = buildDynamicContext({
      goals: wantGoals ? goals : undefined,
      activityTags: wantActivity ? activityTags : undefined,
      appUsage: wantActivity ? appUsage : undefined,
      biliHistory: wantBili ? biliHistory : undefined,
      presence: presenceRef.current,
      // 锁定卡不走意图裁剪：体量小且主人随时可能说"这张卡片"
      focusedCard: focusedCardRef.current ?? undefined,
    })
    promptPartsRef.current = { staticPrompt, dynamicContext }
    asrVocabularyRef.current = buildAsrVocabulary({
      agentName: cfg.agentName,
      goalTitles: goals.map((g) => g.title),
      appNames: appUsage.map((a) => a.appName),
    })
    // Omni 实时会话每次都是新连接，要靠 instructions 带上动态背景和最近对话摘要；
    // 文字模式不用它（历史就在消息里），只用 promptPartsRef
    const history = buildConversationSummary(
      chatMessagesRef.current.map((m) => ({ role: m.role, content: m.content || m.transcript || '' }))
    )
    const base = `${staticPrompt}\n\n${dynamicContext}`
    systemPromptRef.current = history ? `${base}\n\n${history}` : base
    return systemPromptRef.current
  }, [activityPalette])
  refreshSystemPromptRef.current = refreshSystemPrompt

  // ── System Prompt 预热 + 定时刷新（每分钟，供 Omni 模式热读）──
  useEffect(() => {
    refreshSystemPrompt().catch(() => {})
    const timer = setInterval(() => refreshSystemPrompt().catch(() => {}), 60_000)
    return () => clearInterval(timer)
  }, [refreshSystemPrompt])

  // ── 监听语境库「展开转录的那张」→ 绑定为当前对话语境卡 ──
  useEffect(() => {
    const onActive = (e: Event) => {
      const d = (e as CustomEvent).detail as { cardId: string; text?: string; title?: string; clear?: boolean }
      if (d.clear) {
        if (activeContextRef.current?.cardId === d.cardId) activeContextRef.current = null
      } else if (d.text) {
        activeContextRef.current = { cardId: d.cardId, text: d.text, title: d.title ?? '语境卡' }
      }
    }
    window.addEventListener('solevup:active-context', onActive)
    return () => window.removeEventListener('solevup:active-context', onActive)
  }, [])

  // ── 监听洪流域「鼠标锁定的卡片」→ 注入聊天上下文 ──
  useEffect(() => {
    const onFocus = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        cardId?: string
        kind?: 'thought' | 'bili_transcript'
        title?: string | null
        text?: string
        sourceLabel?: string | null
        refPath?: string | null
        linkBroken?: boolean
        clear?: boolean
      }
      if (d.clear) {
        focusedCardRef.current = null
        setGazeTarget(null)
      } else if (d.cardId && d.kind && typeof d.text === 'string') {
        focusedCardRef.current = {
          cardId: d.cardId,
          kind: d.kind,
          title: d.title ?? null,
          text: d.text,
          sourceLabel: d.sourceLabel ?? null,
          refPath: d.refPath ?? null,
          linkBroken: d.linkBroken ?? false,
        }
        setGazeTarget({ kind: d.kind, title: d.title ?? null, text: d.text })
        // B 站卡的 text 只是 150 字摘要：后台拉全文转录替换，
        // D6 注入全文 Fairy 才答得了视频内容（fetch 有记忆化，不重复读盘）
        if (d.kind === 'bili_transcript' && d.refPath) {
          // 记住最近注视的 B 站语境（解锁不丢），沉淀时兜底锚定
          lastBiliContextRef.current = { cardId: d.cardId, title: d.title ?? null, refPath: d.refPath }
          const cardId = d.cardId
          void fetchBiliTranscriptPlain(d.refPath).then((full) => {
            if (full && focusedCardRef.current?.cardId === cardId) {
              focusedCardRef.current = { ...focusedCardRef.current, text: full }
            }
          })
        }
      }
    }
    window.addEventListener('solevup:card-focus', onFocus)
    return () => window.removeEventListener('solevup:card-focus', onFocus)
  }, [])

  // ── Send Message ──
  // 打字和语音（级联）都走这里：同一个主循环、同一个 Fairy（一个大脑）。
  // 实时（实验）语音模式的回复另走 Omni WS，不经过这里。
  const handleSend = useCallback(async (text: string, fromVoice = false, _modeOverride?: ChatMode, images: readonly PendingImage[] = [], userTimestamp?: string) => {
    if (!text.trim() && images.length === 0) return
    // 主人这句的时间：气泡、发给模型的那条、落库的那行用同一个（压缩按时间在库里找分界）
    const sentAt = userTimestamp ?? new Date().toISOString()
    // 这一轮属于发起时的会话：切走之后，迟到的回复写回原会话，不能进新会话，也不能盖掉新会话的历史
    const turnSessionId = sessionIdRef.current
    // 语音那句在转写定稿时已经数过（onTranscript），这里只数打字
    if (!fromVoice) titleFlowRef.current?.onUserMessage(text || '发了图片')

    // 文字输入：添加用户气泡（语音输入的气泡在 onUserAudio 已添加，不重复）
    if (!fromVoice) {
      setChatMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'user' as const,
        content: text, timestamp: sentAt,
        ...(images.length > 0 ? { images: images.map(({ id, url }) => ({ id, url })) } : {}),
      }])
    }

    // 本轮回复的轮次号：被打断的轮次收尾时不再动 Fairy 状态和「处理中」标志，免得盖掉新一轮
    const turnId = ++replyTurnRef.current
    let interrupted = false
    const ownsUi = () => replyTurnRef.current === turnId && !interrupted
    setIsProcessing(true)
    emitFairy('thinking')

    // D2 + D4 — 刷新提示词各段（静态段 + 本轮实时背景，缓存在 promptPartsRef）
    const systemPrompt = await refreshSystemPrompt(text)

    const agentMsgId = crypto.randomUUID()
    const imageBlocks = images.map((i) => i.block)
    const userMsg = createUserMessage(text, { images: imageBlocks, timestamp: sentAt })
    // Fairy 气泡出现的时间，回复落库用同一个（时间顺序要排在主人这句和工具记录后面）
    let agentTimestamp = ''
    const bubbleTimestamp = () => agentTimestamp || (agentTimestamp = new Date().toISOString())
    const capturedSnapshots: ApiRequestSnapshot[] = []
    let capturedUsage: ModelCallLog | null = null
    let capturedReasoning = ''   // 思考模型的推演流（随消息一起持久化，回看用）

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

    // 用语音问的，就用语音答；打字的按「语音播报」开关
    const fishApiKey = config.ttsEnabled || fromVoice ? await getFishApiKey().catch(() => null) : null
    if (fishApiKey) {
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
      const alignFishPcm = createPcm16Aligner()
      state.client = createFishTTSTauri(
        { apiKey: fishApiKey, referenceId: config.fishReferenceId, model: config.fishModel },
        (pcm) => {
          state.pcmChunks.push(pcm)
          const aligned = alignFishPcm(pcm)
          const samples = aligned.length / 2
          if (samples === 0) return
          const buf = audioCtx.createBuffer(1, samples, 24000)
          const ch = buf.getChannelData(0)
          const view = new DataView(aligned.buffer, aligned.byteOffset, aligned.byteLength)
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

    // ── 打断：按下右 Alt 时停掉本轮的生成与朗读（主人开口说话优先）──
    const abort = new AbortController()
    replyControlRef.current = {
      interrupt: () => {
        if (interrupted) return
        interrupted = true
        abort.abort()
        const t = tts
        if (t) {
          t.client.stop().catch(() => {})
          if (t.audioCtx.state !== 'closed') void t.audioCtx.close()
          t.finishResolve?.()
        }
        setIsProcessing(false)
      },
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
    const hideImages = !(await modelSeesImages(chatModel))
    const dashscopeApiKey = getDashScopeApiKey(config) ?? ''

    // 本轮实时背景只附在发给模型的这条消息上；存进历史的是不带背景的原话，让前缀跨轮不变
    const { staticPrompt, dynamicContext } = promptPartsRef.current
    const apiUserMsg = {
      ...userMsg,
      message: { ...userMsg.message, content: userContentWithImages(withSystemReminder(text, dynamicContext), imageBlocks) },
    }

    // 压缩用的参数：门槛按这个模型算；写摘要和这轮聊天同一个模型、系统提示词、工具定义（好吃缓存）
    const chatSystemPrompt = staticPrompt || systemPrompt
    contextBudgetRef.current = contextBudget(await getModelDef(chatModel))
    contextOverheadRef.current = roughTokens(chatSystemPrompt) + roughTokens(JSON.stringify(TOOL_DEFINITIONS))
    const compactCtx: CompactionContext = {
      budget: contextBudgetRef.current,
      overheadTokens: contextOverheadRef.current,
      apiOptions: {
        apiKey: dashscopeApiKey,
        apiBase: config.openaiApiBase,
        model: chatModel,
        systemPrompt: chatSystemPrompt,
        hideImages,
        feature: 'fairy_chat',
        tools: TOOL_DEFINITIONS,
      },
      agentCallUser: config.agentCallUser,
    }

    try {
      // 整段已经超过硬上限就先压完再发；后台摘要还在写就等它几秒
      if (sessionIdRef.current === turnSessionId) await compactor.beforeSend(compactCtx, apiUserMsg)
      const newHistory = await runQueryLoop({
        messages: [...conversationRef.current, apiUserMsg],
        systemPrompt: staticPrompt || systemPrompt,
        apiOptions: {
          apiKey: dashscopeApiKey,
          apiBase: config.openaiApiBase,
          model: chatModel,
          hideImages,
          feature: 'fairy_chat',
          maxTokens: 8000,
          tools: TOOL_DEFINITIONS,
          signal: abort.signal,
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
          if (event.type !== 'textDelta' && event.type !== 'reasoningDelta') console.log('[QueryLoop]', event.type, event)
          if (event.type === 'reasoningDelta') {
            // 思考流：累积到气泡的 reasoning 字段（不进 TTS、不进对话历史，但随消息持久化）
            capturedReasoning += event.delta
            setChatMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === agentMsgId)
              if (idx >= 0) {
                return prev.map((m) =>
                  m.id === agentMsgId
                    ? { ...m, reasoning: (m.reasoning ?? '') + event.delta }
                    : m
                )
              }
              return [...prev, {
                id: agentMsgId, role: 'agent' as const,
                content: '', reasoning: event.delta, timestamp: bubbleTimestamp(),
              }]
            })
          } else if (event.type === 'textDelta') {
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
                content: event.delta, timestamp: bubbleTimestamp(),
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
            if (interrupted) return // 主人打断导致的中止，不算错误
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
      // 工具调用与结果留在历史里（下一轮还能引用刚查到的数据）；超门槛时先清旧工具结果，还超就在后台写摘要
      if (sessionIdRef.current === turnSessionId) {
        conversationRef.current = compactor.settle(newHistory.map((m) => (m === apiUserMsg ? userMsg : m)), compactCtx)
        compactor.kick(compactCtx)
      }
      if (interrupted) {
        setChatMessages((prev) => prev.map((m) =>
          m.id === agentMsgId && m.content ? { ...m, content: `${m.content}……（被打断）` } : m))
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

      // 只看本轮新增的部分：接口报错时本轮没有 assistant，扫整段历史会取到上一轮的回复，再存一遍
      const replyText = (() => {
        for (let i = newHistory.length - 1; i >= 0 && newHistory[i] !== apiUserMsg; i--) {
          const m = newHistory[i]
          if (isAssistantMessage(m)) return getMessageText(m)
        }
        return ''
      })()

      // ── 想法沉淀（后台，不阻塞回复）──
      //   绑定了语境卡（展开转录的那张）→ 锚定到语境卡 + 生成绑定语境的想法卡
      //   没绑定（日常聊天）→ 生成独立想法卡
      if (text.trim()) {
        const speech = text.trim()
        const active = activeContextRef.current
        const focused = focusedCardRef.current
        void (async () => {
          try {
            // 锚定目标三级链：展开转录 > 当前注视的 B 站卡 > 本会话最近注视过的 B 站卡。
            // 最后一级解决"聊着聊着切走了锁定但想法明明源于语境"的常见场景；
            // 误挂由锚定器的相关性闸门兜住（无关 → null → 回落独立沉淀）
            let target = active
            if (!target && focused?.kind === 'bili_transcript') {
              const fullText = await fetchBiliTranscriptPlain(focused.refPath)
              if (fullText) {
                target = { cardId: focused.cardId, text: fullText, title: focused.title ?? '语境卡' }
              }
            }
            if (!target && lastBiliContextRef.current) {
              const last = lastBiliContextRef.current
              const fullText = await fetchBiliTranscriptPlain(last.refPath)
              if (fullText) {
                target = { cardId: last.cardId, text: fullText, title: last.title ?? '语境卡' }
              }
            }
            // 锚定器判"与语境无关/不值得"返回 null → 回落独立沉淀，想法不能丢
            const r = target ? await anchorToContext(target.text, speech) : null
            if (target && r) {
              // 想法卡（绑定语境来源：完整标题入标签，cardId 入 source_card_id 供点击跳转）
              const thoughtId = await addContextCard(r.thought, `语境·${target.title}`, undefined, target.cardId)
              // 语境卡上定位 AI 复制的原文片段 → 建锚点（高亮在转录上）。
              // 模型复制常悄悄改标点/空白，用归一化模糊定位代替裸 indexOf；
              // selected_text 取原文切片（位置坐标是原文的，不能存模型副本）。
              // source_card_id 指向想法卡：删想法卡时语境卡上这条同源绑定一起级联清掉
              let highlighted = false
              if (r.segment) {
                const span = locateSegment(target.text, r.segment)
                if (span) {
                  await addBinding({
                    card_id: target.cardId,
                    start_pos: span.start,
                    end_pos: span.end,
                    selected_text: target.text.slice(span.start, span.end),
                    user_speech: r.thought,
                    anchors: r.anchors,
                    source_card_id: thoughtId,
                  })
                  highlighted = true
                } else {
                  console.warn('[Anchor] 原文片段定位失败，语境卡上不建高亮（想法卡照常）。模型给的片段：', r.segment.slice(0, 120))
                }
              }
              // 想法卡本身也挂锚点（标签）
              await addBinding({
                card_id: thoughtId,
                start_pos: 0,
                end_pos: r.thought.length,
                selected_text: r.thought,
                user_speech: r.thought,
                anchors: r.anchors,
              })
              window.dispatchEvent(new CustomEvent('solevup:context-updated'))
              const kw = r.anchors.map((a) => a.keyword).join('、')
              setChatMessages((prev) => [...prev, {
                id: crypto.randomUUID(), role: 'system' as const,
                content: `📍 已锚定到语境${highlighted ? '并高亮原文' : ''}：${r.thought.slice(0, 22)}${r.thought.length > 22 ? '…' : ''}${kw ? `（锚点：${kw}）` : ''}`,
                timestamp: new Date().toISOString(),
              }])
            } else {
              const distilled = await distillThought(speech)
              if (!distilled) return
              const cardId = await addContextCard(distilled.cardText)
              await addBinding({
                card_id: cardId,
                start_pos: 0,
                end_pos: distilled.cardText.length,
                selected_text: distilled.cardText,
                user_speech: speech,
                anchors: distilled.anchors,
              })
              window.dispatchEvent(new CustomEvent('solevup:context-updated'))
              const kw = distilled.anchors.map((a) => a.keyword).join('、')
              const preview = distilled.cardText.length > 24 ? distilled.cardText.slice(0, 24) + '…' : distilled.cardText
              setChatMessages((prev) => [...prev, {
                id: crypto.randomUUID(), role: 'system' as const,
                content: `📝 已记成想法卡：${preview}${kw ? `（锚点：${kw}）` : ''}`,
                timestamp: new Date().toISOString(),
              }])
            }
          } catch (e) {
            console.error('[Distill] 沉淀失败', e)
          }
        })()
      }

      // ── 持久化本轮：user + 工具记录（切会话、重启后还在）+ 最终 assistant；时间和气泡、发给模型的那条一致 ──
      const newPairs: SessionMessage[] = []
      const userText = text.trim()
      if (!fromVoice && (userText || images.length > 0)) {
        newPairs.push({ ...makeSessionMessage('user', withImageMarker(userText, images.map((i) => i.id))), timestamp: sentAt })
      }
      const turnStart = newHistory.indexOf(apiUserMsg)
      const traceRow = turnStart >= 0 ? toolTraceRow(newHistory.slice(turnStart + 1), sentAt) : null
      if (traceRow) newPairs.push(traceRow)
      if (replyText.trim()) {
        newPairs.push({
          ...makeSessionMessage('assistant', replyText.trim()),
          timestamp: bubbleTimestamp(),
          reasoning: capturedReasoning || null,
        })
      }
      if (capturedUsage) {
        for (let i = newPairs.length - 1; i >= 0; i--) {
          if (newPairs[i].role === 'assistant') {
            newPairs[i] = { ...newPairs[i], usage: capturedUsage }
            break
          }
        }
      }

      // ── TTS：LLM 完成后 flush，等待音频；同步收集 PCM chunks 拼 WAV 落盘 ──
      let aiAudioPath: string | undefined
      let aiAudioDurationMs: number | undefined
      if (tts) {
        if (replyText.trim() && !interrupted) {
          if (ownsUi()) emitFairy('speaking', replyText)
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
              const audioUrl = trackBlobAudioUrl(URL.createObjectURL(wavBlob))
              const totalSamples = tts.pcmChunks.reduce((sum, c) => sum + c.length / 2, 0)
              aiAudioDurationMs = Math.round((totalSamples / 24000) * 1000)
              setChatMessages((prev) =>
                prev.map((m) => m.id === agentMsgId ? { ...m, audioUrl, durationMs: aiAudioDurationMs } : m)
              )
              if (turnSessionId) {
                try {
                  const wavBytes = new Uint8Array(await wavBlob.arrayBuffer())
                  aiAudioPath = await invoke<string>('save_audio_file', {
                    sessionId: turnSessionId,
                    wavBytes,
                    timestamp: new Date().toISOString(),
                  })
                  replaceBlobAudioUrlWithFile(agentMsgId, audioUrl, aiAudioPath)
                } catch { /* 落盘失败不阻塞 */ }
              }
            }
          } catch {
            // TTS 失败不影响主流程
          } finally {
            if (tts.timeout) clearTimeout(tts.timeout)
            if (tts.audioCtx.state !== 'closed') void tts.audioCtx.close() // 打断时已关过
            if (ownsUi()) emitFairy('idle')
          }
        } else {
          tts.client.stop().catch(() => {})
          if (tts.audioCtx.state !== 'closed') void tts.audioCtx.close()
          if (ownsUi()) emitFairy('idle')
        }
      } else if (ownsUi()) {
        emitFairy('idle')
      }

      // ── 持久化本轮对话（在 TTS 之后，最终 assistant 顺手带上 audioPath/durationMs）──
      if (turnSessionId) {
        const sid = turnSessionId
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
        const deduplicated = newPairs
        if (deduplicated.length > 0) {
          if (sessionIdRef.current === sid) persistedBufferRef.current = [...persistedBufferRef.current, ...deduplicated]
          persistMessages(sid, deduplicated).catch(() => {})
        }

      }
    } catch (err) {
      if (!interrupted) {
        setChatMessages((prev) => [...prev, {
          id: crypto.randomUUID(), role: 'system' as const,
          content: `错误: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        }])
        if (ownsUi()) emitFairy('idle')
      }
    }

    if (replyTurnRef.current === turnId) replyControlRef.current = null
    if (ownsUi()) setIsProcessing(false)
  }, [chatMessages, config, replaceBlobAudioUrlWithFile, trackBlobAudioUrl])

  useEffect(() => {
    handleSendRef.current = handleSend
  }, [handleSend])

  useEffect(() => {
    return listenTauriEventStrict<FairyChatSubmitPayload>('fairy-chat-submit', (e) => {
      const text = e.payload?.text?.trim()
      if (!text) return
      const mode = e.payload?.mode
      handleSendRef.current?.(
        text,
        false,
        mode === 'regular' || mode === 'omni' ? mode : undefined,
      ).catch(() => {})
    })
  }, [])

  // ── 切换 / 新建会话 ──
  const switchSession = useCallback(async (sessionId: string, jumpToTimestamp?: string, knownTitle?: string) => {
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
      const restoredImages = await loadRestoredImages(msgs)
      // 正在回复就先停掉（生成和朗读）：切走之后它不该继续出声
      if (replyControlRef.current) {
        replyControlRef.current.interrupt()
        replyControlRef.current = null
        emitFairy('idle')
      }
      sessionIdRef.current = sessionId
      persistedBufferRef.current = [...msgs]
      // 搜索能跳到 sessions（最近 50 条）之外的旧会话，查不到时用选择器带来的标题，否则下一轮会把原标题覆盖掉
      const title = knownTitle ?? sessions.find((s) => s.id === sessionId)?.title
      applySessionTitle(title || DEFAULT_SESSION_TITLE)
      titleFlow.reset(sessionId, title || DEFAULT_SESSION_TITLE, countUserMessages(msgs))
      compactor.reset()
      conversationRef.current = restoreLLMHistory(msgs, restoredImages)
      revokeTrackedBlobAudioUrls()
      setChatMessages(sessionMessagesToChatMessages(msgs, audioDirRef.current))
      performJump()
    } catch {
      // 加载失败静默忽略
    }
  }, [sessions])

  const newSession = useCallback(async () => {
    // 正在回复就先停掉（生成和朗读）：切走之后它不该继续出声
    if (replyControlRef.current) {
      replyControlRef.current.interrupt()
      replyControlRef.current = null
      emitFairy('idle')
    }
    compactor.reset()
    try {
      const s = await createChatSession()
      sessionIdRef.current = s.id
      applySessionTitle(DEFAULT_SESSION_TITLE)
      titleFlow.reset(s.id, DEFAULT_SESSION_TITLE, 0)
      persistedBufferRef.current = []
      conversationRef.current = []
      revokeTrackedBlobAudioUrls()
      setChatMessages([])
      setSessions((prev) => [s, ...prev])
    } catch {
      // 无网络时降级
      sessionIdRef.current = null
      applySessionTitle(DEFAULT_SESSION_TITLE)
      titleFlow.reset(null, DEFAULT_SESSION_TITLE, 0)
      persistedBufferRef.current = []
      conversationRef.current = []
      revokeTrackedBlobAudioUrls()
      setChatMessages([])
    }
  }, [revokeTrackedBlobAudioUrls])

  const mainPanelStyle = (mode: MainViewMode): React.CSSProperties => {
    const panelOrder: Record<MainViewMode, number> = {
      motivation: 0,
      motivation_static: 1,
      daynight: 2,
      torrent: 3,
      torrent_static: 4,
    }
    const active = mainView === mode
    const distance = Math.abs(panelOrder[mode] - panelOrder[mainView])
    const inactiveOpacity = Math.max(0.16, 0.42 - distance * 0.12)
    const inactiveScale = Math.max(0.94, 0.985 - distance * 0.015)

    return {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      transformOrigin: 'top center',
      transform: active
        ? tabsHovering ? 'translateY(24px) scale(1)' : 'translateY(0) scale(1)'
        : tabsHovering ? `translateY(${distance * 8}px) scale(${inactiveScale})` : 'translateY(0) scale(1)',
      opacity: active ? 1 : tabsHovering ? inactiveOpacity : 0,
      filter: active ? 'none' : 'brightness(0.7) saturate(0.7)',
      zIndex: active ? 3 : 1,
      pointerEvents: active ? 'auto' : 'none',
      transition: 'transform 0.55s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.35s ease, filter 0.4s ease',
    }
  }

  // 聊天栏的回调（稳定引用，StageChatPanel 才跳得过去）
  const sendFromPanel = useCallback((text: string, images: readonly PendingImage[]) => {
    void handleSend(text, false, undefined, images)
  }, [handleSend])
  const toggleAiMode = useCallback(() => {
    handleConfigUpdate({ aiMode: config.aiMode === 'omni' ? 'regular' : 'omni' })
  }, [handleConfigUpdate, config.aiMode])
  const toggleTts = useCallback(() => {
    handleConfigUpdate({ ttsEnabled: !config.ttsEnabled })
  }, [handleConfigUpdate, config.ttsEnabled])
  const toggleSessionPicker = useCallback(() => {
    if (pickerOpen) {
      setPickerOpen(false)
      return
    }
    // 顺手清理之前留下的空白会话（无任何消息），不动当前会话
    cleanupEmptyChatSessions(sessionIdRef.current)
      .catch(() => [])
      .then(() => getRecentChatSessions(50))
      .then((s) => setSessions(s))
      .catch(() => {})
    setPickerOpen(true)
  }, [pickerOpen])

  return (
    <div className="app-shell" style={{
      // 最外圈不留白：Windows 去掉系统标题栏后，外圈那 8px 深色底会变成一圈黑框；面板之间的缝（gap）保留
      display: 'flex', flexDirection: 'column',
      gap: 8, padding: 0,
      height: '100vh',
      background: hud.backdrop,
      color: theme.textPrimary,
      fontFamily: theme.fontBody,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* 全局颗粒：所有钛板共用的材质噪点（静态瓦片，不重绘） */}
      <div className="ti-grain" aria-hidden />
      {/* ── 隐藏摄像头（presence detection；整套关掉时不挂） ── */}
      {CAMERA_PRESENCE_ENABLED && (
        <video
          ref={videoRef}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          muted
          playsInline
        />
      )}

      {/* ── Top Bar ──（钛合金机体：一整块拉丝钛板；铭牌 / 视图键位 / LED 日期读数 / 链路 / 实体键） */}
      {/* 顶栏兼当窗口标题栏（Windows 去掉了系统标题栏）：整条按住都能拖窗口、空白处双击最大化（lib/window-drag） */}
      <ChassisPlate
        cut={10}
        className="ti-plate"
        outerStyle={{ height: 52, flexShrink: 0, zIndex: 2 }}
        // 当标题栏用：按住拖窗口时别把日期、链路这些字选成一片蓝
        style={{ display: 'flex', alignItems: 'stretch', userSelect: 'none', containerType: 'inline-size', containerName: 'topbar' }}
        dragRegion
      >
        {/* ── 铭牌：点阵 S + 字标 + 型号（版本号也在悬停提示里） ── */}
        <Tooltip content={`Solevup v${__APP_VERSION__}`} display="flex" wrapStyle={{ alignSelf: 'stretch' }}>
          <div className="tb-logo">
            <span
              className="ti-well ti-led"
              onContextMenu={(e) => {
                e.preventDefault()
                navigator.clipboard.writeText('Solevup').catch(() => {})
              }}
              style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, borderRadius: 6 }}
            >
              S
            </span>
            <div className="tb-wordmark">
              <div className="ti-tech" style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.24em', color: theme.paper, lineHeight: 1.1 }}>
                SOLEVUP
              </div>
              <div className="ti-label" style={{ marginTop: 3, fontSize: 8.5, letterSpacing: '0.16em' }}>v{__APP_VERSION__}</div>
            </div>
          </div>
        </Tooltip>

        <div className="ti-groove-v tb-logo-groove" style={{ margin: '12px 0' }} />

        {/* ── 视图键位（悬停时背后的视图卡向上露顶，见 mainPanelStyle） ── */}
        <div
          onMouseEnter={() => setTabsHovering(true)}
          onMouseLeave={() => setTabsHovering(false)}
          style={{ display: 'flex', alignItems: 'stretch', minWidth: 0 }}
        >
          <ViewSwitcher viewMode={mainView} onChange={setMainView} protocolLabel={protocolViewLabel} />
        </div>

        <div className="tb-drag" />

        {/* BiliJobsWidget：常驻编排 + 后端进度收集 + 进度面板（无顶栏按钮，不可见；
            面板由 B站历史弹窗工具栏入口经 solevup:toggle-bili-jobs 打开）。 */}
        <BiliJobsWidget />

        {/* ── 日期：点阵 LED 读数（点开选日期），两侧实体键翻页 ── */}
        <div className="tb-date">
          <IconButton tip={prevHasData ? '前一天' : '前一天无数据'} onClick={prevDay} disabled={!prevHasData} size={22}>
            <ChevronLeft size={12} />
          </IconButton>
          <Tooltip content="选择日期">
            <button
              ref={dateAnchorRef}
              type="button"
              className="ti-well tb-date-well"
              onClick={() => setDatePickerOpen((v) => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                height: 34,
                border: 'none', cursor: 'pointer', borderRadius: 5,
                outline: datePickerOpen ? `1px solid ${ti.led}66` : 'none',
              }}
            >
              <span className="ti-led" style={{ fontSize: 19, letterSpacing: '0.04em' }}>
                {String(selectedDate.getMonth() + 1).padStart(2, '0')}·{String(selectedDate.getDate()).padStart(2, '0')}
              </span>
              <span className="tb-date-sub" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.1, whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: 11.5, color: theme.paper }}>{WEEKDAY_ZH[selectedDate.getDay()]}</span>
                <span style={{ fontSize: 10, color: theme.paperMuted }}>{relativeDayLabel(selectedDate)}</span>
              </span>
            </button>
          </Tooltip>
          <IconButton tip={nextHasData ? '后一天' : '后一天无数据'} onClick={nextDay} disabled={!nextHasData} size={22}>
            <ChevronRight size={12} />
          </IconButton>
          {!isToday(selectedDate) && (
            <Tooltip content="回到今天">
              <button
                type="button"
                className="ti-key ti-key-primary tb-date-today"
                onClick={goToday}
                style={{ height: 24, padding: '0 10px', marginLeft: 4, fontSize: 12 }}
              >
                回今天
              </button>
            </Tooltip>
          )}
        </div>

        <div className="ti-groove-v" style={{ margin: '12px 0' }} />

        {/* ── 链路：同步设备状态（点开 SyncPeerDialog） ── */}
        {(() => {
          const onlineDeviceIds = new Set(discoveredPeers.map((p) => p.device_id))
          const hasLinks = linkedDevices.length > 0
          const anyOnline = linkedDevices.some((l) => onlineDeviceIds.has(l.device_id))
          const anySyncing = syncingDeviceIds.size > 0
          const dotClass = anySyncing ? 'ti-dot ti-dot-led' : anyOnline ? 'ti-dot ti-dot-ok' : 'ti-dot ti-dot-off'
          const summary = !hasLinks
            ? '未链接设备'
            : linkedDevices.length === 1
              ? linkedDevices[0].alias
              : `${linkedDevices[0].alias} 等 ${linkedDevices.length} 台`
          const detail = hasLinks
            ? linkedDevices.map((l) => {
                const state = syncingDeviceIds.has(l.device_id) ? '同步中' : onlineDeviceIds.has(l.device_id) ? '在线' : '离线'
                return `${l.alias}：${state}`
              }).join('；') + '（启动即自动同步）'
            : '点击建立同步链接'
          return (
            <Tooltip content={detail} display="flex" wrapStyle={{ alignSelf: 'stretch' }}>
              <button
                ref={syncTriggerRef}
                type="button"
                className="ui-icon-btn tb-sync"
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
                  display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start',
                  background: showSync ? theme.surfaceRaised : 'transparent',
                  border: 'none', cursor: 'pointer',
                  color: theme.paperDim, fontFamily: theme.fontBody,
                }}
              >
                <span className="tb-sync-title" style={{ fontSize: 10, color: theme.paperMuted, letterSpacing: '0.2em' }}>同步</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 2, fontSize: 12 }}>
                  <span
                    className={dotClass}
                    aria-hidden
                    style={{ animation: anySyncing ? 'glowPulse 1.2s ease-in-out infinite' : undefined }}
                  />
                  <span className="tb-sync-text" style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {summary}
                  </span>
                </span>
              </button>
            </Tooltip>
          )
        })()}

        <div className="ti-groove-v" style={{ margin: '12px 0' }} />

        {/* ── 实体键 ── */}
        <div className="tb-keys">
          <IconButton
            tip="B站历史记录"
            label="B站"
            active={showBili}
            size={32}
            onClick={() => {
              if (showBili) {
                closeBiliDialog()
              } else {
                setShowBili(true)
                setShowSettings(false); setShowModels(false)
              }
            }}
          >
            <BiliIcon size={15} />
          </IconButton>
          <IconButton
            tip="模型与用量"
            label="模型"
            active={showModels}
            size={32}
            onClick={() => {
              setShowModels(!showModels)
              if (!showModels) { setShowSettings(false); closeBiliDialog() }
            }}
          >
            <Boxes size={15} />
          </IconButton>
          <IconButton
            tip={config.fairyWindowEnabled ? '隐藏 Fairy 桌面窗口' : '显示 Fairy 桌面窗口'}
            label="Fairy"
            active={config.fairyWindowEnabled}
            size={32}
            onClick={toggleFairyWindow}
          >
            <PictureInPicture2 size={15} />
          </IconButton>
          <IconButton
            tip="设置"
            label="设置"
            active={showSettings}
            size={32}
            onClick={() => {
              setSettingsInitialSection(undefined)
              setShowSettings(!showSettings)
              if (!showSettings) { closeBiliDialog(); setShowModels(false) }
            }}
          >
            <Settings size={15} />
          </IconButton>
        </div>

        <div className="ti-groove-v" style={{ margin: '12px 0' }} />
        <WindowControls />
      </ChassisPlate>

      {/* ── Main: Chart + Right Panel ── */}
      <div style={{ flex: 1, display: 'flex', gap: 8, overflow: 'hidden', minHeight: 0 }}>
        {/* 主舞台：每个视图各是一整块主面板（钛板 + 光轨框 + 屏），整块 absolute 叠成一摞；
            悬停顶栏视图键位时当前面板下沉、背后的面板露出各自的光轨凸台和标题——位移的是面板本身 */}
        <div style={{ flex: 1, minWidth: 0, position: 'relative', perspective: '1400px', perspectiveOrigin: 'top center' }}>
          <div style={{ ...mainPanelStyle('daynight'), display: 'flex' }}>
            <ScreenBezel view="daynight">
                <StageDayNightChart
                  activityBlocks={activityBlocks}
                  plannedBlocks={plannedBlocks}
                  planNodes={planNodes}
                  activityPalette={activityPalette}
                  recordLayer={recordLayer}
                  onRecordLayerChange={setRecordLayer}
                  editMode={editMode}
                  selectedTagId={selectedTagId}
                  selectedPlanNodeId={selectedPlanNodeId}
                  onEditModeToggle={toggleEditMode}
                  canUndo={recordLayer === 'actual' ? undoStack.length > 0 : planUndoStack.length > 0}
                  canRedo={recordLayer === 'actual' ? redoStack.length > 0 : planRedoStack.length > 0}
                  onUndo={handleUndo}
                  onRedo={handleRedo}
                  onApplyDrag={handleApplyDrag}
                  perceptionSpans={perceptionSpans}
                  biliSpans={biliSpans}
                  selectedDate={selectedDate}
                  onSpanClick={NOOP}
                  onSpanHover={setHoveredTagSpan}
                  onAppSpanHover={handleAppSpanHover}
                  onBiliSpanHover={setHoveredBiliSpan}
                  trackMode={trackMode}
                  onTrackModeChange={setTrackMode}
                  pinnedPos={pinnedPos}
                  onPinPos={setPinnedPos}
                />
            </ScreenBezel>
          </div>
          <div style={{ ...mainPanelStyle('motivation'), display: 'flex' }}>
            <ScreenBezel view="motivation">
              {/* 协议志：协议 / 专注锁 / 清单（滴答清单式任务树，和昼夜表计划层同一份数据）/ 动机云 */}
              <StageProtocolView
                palette={activityPalette}
                onPaletteChange={refreshActivityPalette}
                onPlanNodesChange={handlePlanNodesChange}
                selectedDate={selectedDate}
                perceptionSpans={perceptionSpans}
              />
            </ScreenBezel>
          </div>
          <div style={{ ...mainPanelStyle('motivation_static'), display: 'flex' }}>
            <ScreenBezel view="motivation_static">
              <StageProtocolDemoPanel />
            </ScreenBezel>
          </div>
          <div style={{ ...mainPanelStyle('torrent'), display: 'flex' }}>
            <ScreenBezel view="torrent">
              <StageTorrentFieldPanel />
            </ScreenBezel>
          </div>
          <div style={{ ...mainPanelStyle('torrent_static'), display: 'flex' }}>
            <ScreenBezel view="torrent_static">
              <StageTorrentFieldDemoPanel />
            </ScreenBezel>
          </div>
        </div>

        {/* Right Panel: Chat or Settings；
            编辑模式时左边框跟随 recordLayer 颜色（绿 / 橙），inset 发光也对应色 */}
        {(() => {
          const rightPanelAccent = editMode
            ? (recordLayer === 'plan' ? theme.warningOrange : theme.expGreen)
            : theme.electricBlue
          return (
        <ChassisPlate
          className="right-panel-hud ti-plate"
          outerStyle={{ width: rightPanelWidth, flexShrink: 0 }}
          style={{
            display: 'flex', flexDirection: 'column',
            // CSS 变量供子级滚动条引用（动态跟随 rightPanelAccent）
            ['--rp-accent' as string]: rightPanelAccent,
          } as React.CSSProperties}
          outside={
            /* 拖拽手柄：在两块板之间的缝里（外层不裁切，才不会被轮廓切掉） */
            <div
              onMouseDown={(e) => {
                e.preventDefault()
                resizingRef.current = true
                document.body.style.cursor = 'ew-resize'
                document.body.style.userSelect = 'none'
              }}
              onDoubleClick={() => setRightPanelWidth(340)}
              style={{
                position: 'absolute',
                left: -8, top: 12, bottom: 12,
                width: 8,
                borderRadius: 4,
                cursor: 'ew-resize',
                zIndex: 80,
                background: 'transparent',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLDivElement
                el.style.background = `${ti.led}33`
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLDivElement
                el.style.background = 'transparent'
              }}
            />
          }
        >
          {/* 编辑模式：模块顶沿亮一条对应图层颜色的 LED 灯条（实际 = 绿 / 计划 = 橙） */}
          {editMode && (
            <span aria-hidden style={{
              position: 'absolute', left: 14, right: 14, top: 0, height: 2, zIndex: 82,
              background: rightPanelAccent, boxShadow: `0 0 8px ${rightPanelAccent}`,
            }} />
          )}
          {/* 注入右栏 HUD 滚动条样式：跟随 rightPanelAccent，半透明，细 */}
          <style>{`
            .right-panel-hud *::-webkit-scrollbar {
              width: 6px;
              height: 6px;
            }
            .right-panel-hud *::-webkit-scrollbar-track {
              background: transparent;
            }
            .right-panel-hud *::-webkit-scrollbar-thumb {
              background: rgba(255,255,255,0.12);
              border-radius: 3px;
            }
            .right-panel-hud *::-webkit-scrollbar-thumb:hover {
              background: ${rightPanelAccent}88;
            }
            .right-panel-hud *::-webkit-scrollbar-corner {
              background: transparent;
            }
            .right-panel-hud * {
              scrollbar-color: rgba(255,255,255,0.14) transparent;
              scrollbar-width: thin;
            }
          `}</style>

          {/* 编辑模式：右上角 X 关闭按钮（HUD 切角风格，= ① 主按钮再点击退出编辑模式） */}
          {editMode && (
            <button
              type="button"
              className="ti-key"
              aria-label="退出编辑模式"
              onClick={() => setEditMode(false)}
              style={{
                position: 'absolute',
                top: 8, right: 12,
                zIndex: 81,
                width: 22, height: 22,
                color: rightPanelAccent,
              }}
            >
              <X size={11} />
            </button>
          )}

          {/* 右侧栏内容：编辑模式 → 实际记录标签库 / 计划待办；非编辑模式 → 聊天 / 详情 */}
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
                {/* 上半：实际记录标签库 / 计划待办 */}
                <div style={{
                  flex: detail ? '1 1 42%' : '1 1 100%',
                  minHeight: 0,
                  overflow: 'hidden',
                  position: 'relative',
                }}>
                  {recordLayer === 'plan' ? (
                    <TodoListPanel
                      selectedDate={selectedDate}
                      palette={activityPalette}
                      nodes={planNodes}
                      selectedProjectTagId={selectedProjectTagId}
                      selectedPlanNodeId={selectedPlanNodeId}
                      onSelectProject={(id) => { setSelectedProjectTagId(id); setSelectedPlanNodeId(null) }}
                      onSelectNode={setSelectedPlanNodeId}
                      onNodesChange={(projectTagId) => {
                        refreshPlanNodes(projectTagId)
                        // 协议志清单是同一份数据，让它也跟着刷新
                        window.dispatchEvent(new CustomEvent(PLAN_NODES_CHANGED))
                      }}
                      onPlanBlocksMayChange={() => {
                        // AUDIT-022: 计划节点删除后端 cascade 软删 planned_blocks
                        // 刷当日计划块 + 清 undo/redo 栈防止旧快照恢复死节点
                        refreshPlannedBlocks()
                        setPlanUndoStack([])
                        setPlanRedoStack([])
                      }}
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
                    borderTop: '1px solid rgba(0,0,0,0.88)',
                  }}>
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
            const selectedDatePart = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
            const biliMinuteRange = (span: BiliSpan): [number, number] | null => {
              const startDate = span.start_at.split(' ')[0] ?? ''
              const endDate = span.end_at.split(' ')[0] ?? ''
              if (endDate < selectedDatePart || startDate > selectedDatePart) return null
              const startMin = startDate < selectedDatePart ? 0 : dtToMin(span.start_at)
              const endMin = endDate > selectedDatePart ? 1440 : dtToMin(span.end_at)
              return endMin > startMin ? [startMin, endMin] : null
            }
            const pinnedTagSpan = pm != null
              ? perceptionSpans.find((s) => s.track === 'tags' && pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            // 按当前轨道模式只查对应管线 span
            const pinnedAppSpan = pm != null && trackMode === 'apps'
              ? perceptionSpans.find((s) => s.track === 'apps' && pm >= dtToMin(s.start_at) && pm < dtToMin(s.end_at)) ?? null
              : null
            const pinnedBili = pm != null && trackMode === 'bili'
              ? biliSpans.find((s) => {
                  const range = biliMinuteRange(s)
                  return !!range && pm >= range[0] && pm < range[1]
                }) ?? null
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
                  <StageChatPanel
                    messages={chatMessages}
                    isProcessing={isProcessing}
                    onSend={sendFromPanel}
                    takeVoiceImagesRef={takeVoiceImagesRef}
                    agentName={config.agentName}
                    userCallsign={config.agentCallUser}
                    gazeTarget={gazeTarget}
                    aiMode={config.aiMode}
                    onToggleAiMode={toggleAiMode}
                    cameraReady={presence.ready}
                    cameraPresent={presence.state === 'present'}
                    cameraWindowOpen={cameraWindowOpen}
                    onToggleCamera={CAMERA_PRESENCE_ENABLED ? toggleCameraWindow : undefined}
                    ttsEnabled={config.ttsEnabled}
                    onToggleTts={toggleTts}
                    sessionsOpen={pickerOpen}
                    sessionTitle={sessionTitle}
                    fairyState={fairyUiState}
                    contextRatio={contextRatio}
                    onOpenSessions={toggleSessionPicker}
                  />
                </div>
                {hasDetail && (
                  <div style={{
                    height: '100%', position: 'relative',
                    padding: '4px 4px',
                    fontFamily: theme.fontBody,
                  }}>
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
        </ChassisPlate>
        )
        })()}
      </div>

      {/* ── Session Picker（侧栏，停靠在聊天面板左侧，不遮挡聊天窗口）── */}
      {pickerDock.mounted && (
        <SessionPicker
          phase={pickerDock.phase}
          sessions={sessions}
          currentSessionId={sessionIdRef.current}
          dockRight={rightPanelWidth}
          onSelect={(id, ts, title) => { switchSession(id, ts, title) }}
          onNewSession={() => { newSession() }}
          onDelete={async (id) => {
            try { await deleteChatSession(id) } catch {}
            const deletingCurrent = sessionIdRef.current === id
            const latestSessions = (await getRecentChatSessions(50)).filter((s) => s.id !== id)
            setSessions(latestSessions)
            if (deletingCurrent) {
              const nextSessionId = latestSessions[0]?.id ?? null
              if (nextSessionId) {
                await switchSession(nextSessionId)
              } else {
                await newSession()
              }
            }
          }}
          onClose={() => setPickerOpen(false)}
          onRefresh={(changedId) => {
            if (changedId) titleFlow.lock(changedId)
            void getRecentChatSessions(50).then((s) => {
              setSessions(s)
              // 手动重命名/重新生成的标题要同步进 ref，避免自动起名逻辑再覆盖
              const cur = s.find((x) => x.id === sessionIdRef.current)
              if (cur) applySessionTitle(cur.title || DEFAULT_SESSION_TITLE)
            }).catch(() => {})
          }}
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
        nextSyncAt={biliNextSyncAt}
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
        initialSection={settingsInitialSection}
        initialSectionTick={settingsInitialSectionTick}
        config={config}
        onUpdate={handleConfigUpdate}
        onClose={() => setShowSettings(false)}
      />

      <SyncPeerDialog
        open={showSync}
        anchorRect={syncAnchorRect}
        onClose={() => setShowSync(false)}
        nextSyncAt={nextAutoSyncAt}
        anySyncing={syncingDeviceIds.size > 0}
        syncLog={syncLog}
        appendLog={pushSyncLog}
      />

      {/* 活动记录涂块 toast（10s 自动消失） */}
      <ActivityToast toast={paintToast} onDismiss={() => setPaintToast(null)} rightPanelWidth={rightPanelWidth} />

      {/* 首次开启独显高性能 → 右上角一块钛板提示，常驻直到用户选「立即重启」或「下次再说」 */}
      {gpuToastVisible && (
        <div
          role="status"
          style={{
            position: 'fixed',
            right: 18, top: 84,
            zIndex: 99999,
            width: 330,
            padding: '14px 16px 14px',
            borderRadius: 8,
            background: tiSurface.plate,
            boxShadow: `${tiSurface.popShadow}, 0 0 0 1px rgba(255,138,76,0.35)`,
            color: theme.textPrimary,
            fontFamily: theme.fontBody,
            animation: 'gpuToastIn 0.22s cubic-bezier(.2,.8,.2,1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
            <span className="ti-dot ti-dot-led" aria-hidden />
            <span style={{ ...tiTitle, fontSize: 14 }}>已开启独显高性能</span>
          </div>
          <div className="ti-well" style={{ padding: '8px 10px', borderRadius: 5, fontSize: 12, lineHeight: 1.65, color: theme.textSecondary, marginBottom: 12 }}>
            重启应用后改用独立显卡渲染；可在 设置 → 图形性能 里关掉。
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="ti-key" onClick={() => setGpuToastVisible(false)}
              style={{ height: 28, padding: '0 12px', fontSize: 12 }}>
              下次再说
            </button>
            <button type="button" className="ti-key ti-key-primary" onClick={() => { invoke('restart_app').catch(() => {}) }}
              style={{ height: 28, padding: '0 14px', fontSize: 12 }}>
              立即重启
            </button>
          </div>
        </div>
      )}
      <style>{`@keyframes gpuToastIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}

// 顶栏 HUD 风格按钮：切角方框 + mono 排版 + cyan 边框
