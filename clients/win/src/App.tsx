// ══════════════════════════════════════════════
// Solo Agent — Windows 客户端（务实版）
// 核心：昼夜表 + AI 聊天整理
// ══════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Settings, Tv2, Mic } from 'lucide-react'
import { fetchActivities } from './lib/chronos-api'
import { createActivity, updateActivity, deleteActivity, fetchManicTimeSpans, fetchBiliSpans, fetchGoals, parseGoalTags } from './lib/local-api'
import type { MtSpan, BiliSpan } from './lib/local-api'
import type { ChronosActivity } from './types'
import { theme } from './theme'

// Agent
import { loadConfig, updateConfig } from './lib/agent/agent-config'
import type { AgentConfig } from './lib/agent/agent-config'
import { buildSystemPrompt } from './lib/ai/prompt-templates'
import type { ActivityTagRecord, AppUsageRecord, BiliRecord, GoalRecord } from './lib/ai/prompt-templates'

// LLM Engine（新）
import { runQueryLoop } from './lib/llm/query-loop'
import { createUserMessage, getMessageText, isAssistantMessage } from './lib/llm/types'
import type { Message } from './lib/llm/types'
import type { ApiRequestSnapshot } from './lib/llm/api'

// Agent Tools
import { TOOL_DEFINITIONS, executeAgentTool } from './lib/agent/agent-tools'

// Voice
import { createVoiceService } from './lib/voice'
import type { VoiceService } from './lib/voice'
import { createFishTTSTauri } from './lib/voice/fish-tts-tauri'

// UI
import DayNightChart from './components/DayNightChart'
import ChatPanel from './components/ChatPanel'
import SettingsPanel from './components/SettingsPanel'
import SpanDetailPanel from './components/SpanDetailPanel'
import AppHoverPanel from './components/AppHoverPanel'
import BiliVideoPanel from './components/BiliVideoPanel'
import BiliHistoryMonitor from './components/BiliHistoryMonitor'
import { useBiliHistory } from './lib/bilibili/useHistory'
import { dbBiliItemToActivity } from './lib/bilibili/api'
import { linkBiliToEvent, mergeActivities } from './lib/local-api'
import type { DbBiliItem } from './lib/local-api'
import FairyHUD from './components/FairyHUD'
import type { FairyState } from './components/FairyHUD'
import { NeonDivider, NeonBadge, MagneticButton } from './components/NeonUI'
import { usePresenceDetection } from './hooks/usePresenceDetection'

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'agent' | 'system'
  readonly content: string
  readonly timestamp: string
  readonly audioUrl?: string             // 语音消息的 blob URL（可播放）
  readonly durationMs?: number           // 录音时长（毫秒）
  readonly transcript?: string           // ASR 转写文本（语音消息专用）
  readonly debugSnapshots?: ApiRequestSnapshot[]  // 本轮发给 AI 的请求快照
}

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
  const [isExpanded, setIsExpanded] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showBili, setShowBili] = useState(false)


  // ── Activity Editor ──
  type EditMode =
    | { type: 'add' }
    | { type: 'edit'; activity: ChronosActivity }
    | null
  const [editMode, setEditMode] = useState<EditMode>(null)
  // 图表常驻高亮选区
  const [chartSelection, setChartSelection] = useState<{ startMinute: number; endMinute: number } | null>(null)
  // 推送给表单的时间（框选/右键/快速时长）
  const [pushedTime, setPushedTime] = useState<{ start: number; end: number } | null>(null)
  const [pushedVersion, setPushedVersion] = useState(0)

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

  // ── Presence Detection ──
  const { presence, videoRef } = usePresenceDetection(config.overlayEnabled)

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
  const [fairyState, setFairyState] = useState<FairyState>('idle')
  const [fairyVisible, setFairyVisible] = useState(false)
  const altDownTimeRef = useRef<number>(0)
  const pressingRef = useRef(false)
  const fairyStateRef = useRef<FairyState>('idle')
  const voiceServiceRef = useRef<VoiceService | null>(null)
  const LONG_PRESS_MS = 600

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

  // 同步 fairyState 到 ref，供事件回调读取
  useEffect(() => { fairyStateRef.current = fairyState }, [fairyState])

  // ── Voice Service（懒初始化）──
  const getVoiceService = useCallback(() => {
    if (voiceServiceRef.current) return voiceServiceRef.current

    const svc = createVoiceService(
      () => config,
      () => {
        if (activities.length === 0) return '今日暂无活动数据'
        return activities.slice(-5).map((a) =>
          `${Math.floor(a.startMinute / 60)}:${String(a.startMinute % 60).padStart(2, '0')}-${Math.floor(a.endMinute / 60)}:${String(a.endMinute % 60).padStart(2, '0')} [${a.category}] ${a.title}`
        ).join('\n')
      },
      {
        onPhaseChange: (phase) => {
          const mapped: FairyState = phase
          setFairyState(mapped)
          fairyStateRef.current = mapped
          if (phase === 'idle') {
            setTimeout(() => setFairyVisible(false), 700)
          }
        },
        onUserAudio: (wavBase64, durationMs, sessionMsgId) => {
          // 把录音转成 blob URL，作为用户语音气泡显示
          // 使用 sessionMsgId 作为消息 ID，以便 onTranscript 能找到并更新
          const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
          const blob = new Blob([bytes], { type: 'audio/wav' })
          const audioUrl = URL.createObjectURL(blob)
          setChatMessages((prev) => [...prev, {
            id: sessionMsgId, role: 'user' as const,
            content: '', audioUrl, durationMs,
            timestamp: new Date().toISOString(),
          }])
        },
        onTranscript: (text, sessionMsgId) => {
          // ASR 转写完成：1) 更新音频气泡的 transcript；2) 触发 LLM 回复
          setChatMessages((prev) =>
            prev.map((m) => m.id === sessionMsgId ? { ...m, transcript: text } : m)
          )
          // 语音输入也走同一条 handleSend 链路
          handleSend(text)
        },
        onAudioLevel: () => {
          // FairyHUD 自己通过 analyser 获取，这里暂不处理
        },
        onError: (message) => {
          setChatMessages((prev) => [...prev, {
            id: crypto.randomUUID(), role: 'system' as const,
            content: message, timestamp: new Date().toISOString(),
          }])
          setFairyState('idle')
          fairyStateRef.current = 'idle'
          setFairyVisible(false)
        },
      },
    )
    voiceServiceRef.current = svc
    return svc
  }, [config, activities])

  // ── Right Alt Long-Press → Voice Chat（全局热键，无需窗口聚焦）──
  useEffect(() => {
    let unlistenDown: (() => void) | null = null
    let unlistenUp:   (() => void) | null = null

    const onDown = () => {
      if (pressingRef.current) return
      pressingRef.current = true
      altDownTimeRef.current = Date.now()

      setTimeout(() => {
        if (pressingRef.current && Date.now() - altDownTimeRef.current >= LONG_PRESS_MS) {
          setFairyVisible(true)
          const svc = getVoiceService()
          svc.startRecording()
        }
      }, LONG_PRESS_MS)
    }

    const onUp = () => {
      if (!pressingRef.current) return
      pressingRef.current = false
      const holdDuration = Date.now() - altDownTimeRef.current

      if (holdDuration >= LONG_PRESS_MS && fairyStateRef.current === 'listening') {
        const svc = getVoiceService()
        svc.stopAndProcess()
      } else {
        const svc = voiceServiceRef.current
        if (svc) svc.cancel()
        setFairyState('idle')
        fairyStateRef.current = 'idle'
        setFairyVisible(false)
      }
    }

    import('@tauri-apps/api/event').then(({ listen }) => {
      Promise.all([
        listen('ralt-keydown', onDown),
        listen('ralt-keyup',   onUp),
      ]).then(([u1, u2]) => {
        unlistenDown = u1
        unlistenUp   = u2
      })
    })

    return () => {
      unlistenDown?.()
      unlistenUp?.()
    }
  }, [getVoiceService])

  // ── Date Navigation ──
  const clearSelectionAndForm = () => {
    setChartSelection(null)
    setEditMode(null)
    setPushedTime(null)
  }

  const prevDay = () => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() - 1)
    setSelectedDate(d)
    clearSelectionAndForm()
  }
  const nextDay = () => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + 1)
    setSelectedDate(d)
    clearSelectionAndForm()
  }
  const goToday = () => {
    setSelectedDate(new Date())
    clearSelectionAndForm()
  }

  const handleConfigUpdate = useCallback((updates: Partial<AgentConfig>) => {
    setConfig((prev) => updateConfig(prev, updates))
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

  const handleActivitySave = useCallback(async (activity: Omit<ChronosActivity, 'id'>) => {
    if (editMode?.type === 'add') {
      await createActivity(selectedDate, activity)  // 普通新建，不需要 eventIds
    } else if (editMode?.type === 'edit') {
      await updateActivity(editMode.activity.id, activity)
    }
    refreshActivities()
    setEditMode(null)
    setChartSelection(null)
  }, [editMode, selectedDate, refreshActivities])

  const handleActivityDelete = useCallback(async () => {
    if (editMode?.type !== 'edit') return
    await deleteActivity(editMode.activity.id)
    refreshActivities()
    setEditMode(null)
    setChartSelection(null)
  }, [editMode, refreshActivities])

  const handleTimeSelect = useCallback((start: number, end: number) => {
    setShowSettings(false)
    setShowBili(false)
    setChartSelection({ startMinute: start, endMinute: end })
    setPushedTime({ start, end })
    setPushedVersion((v) => v + 1)
    // 如果表单未打开则打开（不传时间，靠 pushedTime 同步）
    setEditMode((prev) => prev === null ? { type: 'add' } : prev)
  }, [])

  const handleClearSelection = useCallback(() => {
    setChartSelection(null)
    setPushedTime(null)
    setPushedVersion((v) => v + 1)
  }, [])

  const handleActivityResize = useCallback(async (id: string, newStart: number, newEnd: number) => {
    const activity = activities.find((a) => a.id === id)
    if (!activity) return
    await updateActivity(id, { ...activity, startMinute: newStart, endMinute: newEnd })
    refreshActivities()
  }, [activities, refreshActivities])

  // 手动从 BiliHistoryMonitor 加入活动（多选）
  const handleAddBiliToActivity = useCallback(async (items: DbBiliItem[]) => {
    const toLocalDateStr = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    const affectedDates = new Map<string, Date>()

    // 只处理真正未入档的视频，跳过已有 event_id 的
    const unlinked = items.filter((i) => i.event_id === null)
    for (const item of unlinked) {
      try {
        const { bvid, date, activity } = dbBiliItemToActivity(item)
        const { eventIds } = await createActivity(date, activity)
        affectedDates.set(toLocalDateStr(date), date)
        if (eventIds[0]) await linkBiliToEvent([bvid], eventIds[0]).catch(() => {})
      } catch { /* ignore */ }
    }
    for (const date of affectedDates.values()) {
      await mergeOverlappingBili(date).catch(() => {})
    }
    if (affectedDates.has(toLocalDateStr(selectedDate))) refreshActivities()
  }, [selectedDate, refreshActivities])

  const handleDeleteMinuteRange = useCallback(async (startMin: number, endMin: number) => {
    const toDelete = activities.filter((a) => a.startMinute < endMin && a.endMinute > startMin)
    await Promise.all(toDelete.map((a) => deleteActivity(a.id)))
    refreshActivities()
  }, [activities, refreshActivities])

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

    // D2 + D4 — 并行查询目标和近期活动
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const today = new Date()

    const toHHmm = (datetimeStr: string) =>
      datetimeStr.slice(11, 16)  // "2026-04-09 14:32:00" → "14:32"

    const [goalsRes, mtSpans, biliSpans] = await Promise.allSettled([
      fetchGoals('active'),
      fetchManicTimeSpans(today),
      fetchBiliSpans(today),
    ])

    const goals: GoalRecord[] = goalsRes.status === 'fulfilled'
      ? goalsRes.value.map(g => ({ title: g.title, tags: parseGoalTags(g) }))
      : []

    const mtData = mtSpans.status === 'fulfilled' ? mtSpans.value : []

    const activityTags: ActivityTagRecord[] = mtData
      .filter(s => s.track === 'tags' && new Date(s.end_at).getTime() >= oneHourAgo)
      .map(s => ({
        startTime: toHHmm(s.start_at),
        endTime: toHHmm(s.end_at),
        tag: s.title,
        subTag: s.group_name ?? undefined,
      }))

    const appUsage: AppUsageRecord[] = mtData
      .filter(s => s.track === 'apps' && new Date(s.end_at).getTime() >= oneHourAgo)
      .map(s => ({
        startTime: toHHmm(s.start_at),
        endTime: toHHmm(s.end_at),
        appName: s.title,
        windowTitle: s.group_name ?? '',
      }))

    const biliHistory: BiliRecord[] = biliSpans.status === 'fulfilled'
      ? biliSpans.value
          .filter(s => new Date(s.start_at).getTime() >= oneHourAgo)
          .map(s => ({
            time: toHHmm(s.start_at),
            title: s.title,
            url: `https://www.bilibili.com/video/${s.bvid}`,
          }))
      : []

    const systemPrompt = buildSystemPrompt(
      config.agentName, config.agentPersona, config.agentCallUser,
      config.mainQuest,
      { goals, activityTags, appUsage, biliHistory, presence },
    )

    const agentMsgId = crypto.randomUUID()
    const userMsg = createUserMessage(text)
    const capturedSnapshots: ApiRequestSnapshot[] = []

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

      // ── TTS：AI 回复完成后朗读 ──
      console.log('[TTS] ttsEnabled=', config.ttsEnabled, 'fishApiKey=', !!config.fishApiKey)
      if (config.ttsEnabled && config.fishApiKey) {
        // 取本次 AI 回复的完整文本
        const replyText = (() => {
          for (let i = newHistory.length - 1; i >= 0; i--) {
            const m = newHistory[i]
            if (isAssistantMessage(m)) return getMessageText(m)
          }
          return ''
        })()

        console.log('[TTS] newHistory tail:', JSON.stringify(newHistory.slice(-2).map(m => ({ type: m.type, keys: Object.keys(m) }))))
        console.log('[TTS] replyText length=', replyText.length, replyText.slice(0, 50))
        if (replyText.trim()) {
          setFairyState('speaking')
          setFairyVisible(true)
          const stopFairy = () => {
            setFairyState('idle')
            setTimeout(() => setFairyVisible(false), 700)
          }
          try {
            await new Promise<void>((resolve, reject) => {
              // PCM 队列播放器（16-bit signed, 24000Hz, mono）
              const audioCtx = new AudioContext({ sampleRate: 24000 })
              let nextStartTime = audioCtx.currentTime

              const playChunk = (pcm: Uint8Array) => {
                const samples = pcm.length / 2
                const buf = audioCtx.createBuffer(1, samples, 24000)
                const ch = buf.getChannelData(0)
                const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
                for (let i = 0; i < samples; i++) {
                  ch[i] = view.getInt16(i * 2, true) / 32768
                }
                const src = audioCtx.createBufferSource()
                src.buffer = buf
                src.connect(audioCtx.destination)
                // 紧接上一块播放，避免漂移
                const startAt = Math.max(nextStartTime, audioCtx.currentTime + 0.005)
                src.start(startAt)
                nextStartTime = startAt + buf.duration
              }

              // 超时保底：30s 内没完成就强制 resolve
              const timeout = setTimeout(() => {
                audioCtx.close()
                resolve()
              }, 30_000)

              const tts = createFishTTSTauri(
                {
                  apiKey: config.fishApiKey!,
                  referenceId: config.fishReferenceId,
                  model: config.fishModel,
                },
                playChunk,
                () => { clearTimeout(timeout); audioCtx.close(); resolve() },
              )
              tts.connect()
                .then(() => tts.sendText(replyText))
                .then(() => tts.flush())
                .catch(e => { clearTimeout(timeout); audioCtx.close(); reject(e) })
            })
          } catch {
            // TTS 失败不影响主流程
          } finally {
            stopFairy()  // 无论成功/失败/超时都重置 Fairy 状态
          }
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
  }, [activities, config, chatMessages])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', background: theme.background,
      color: theme.textPrimary,
      fontFamily: theme.fontBody,
      overflow: 'hidden',
    }}>
      {/* ── 隐藏摄像头（presence detection） ── */}
      <video
        ref={videoRef}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        muted
        playsInline
      />

      {/* ── Top Bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px', height: 36, flexShrink: 0,
        background: 'rgba(0,10,20,0.7)',
        borderBottom: `1px solid ${theme.divider}`,
        position: 'relative',
      }}>
        {/* Logo */}
        <span style={{
          fontSize: 13, fontWeight: 700,
          fontFamily: theme.fontDisplay,
          color: theme.electricBlue,
          letterSpacing: 3,
          textShadow: `0 0 8px ${theme.electricBlue}80, 0 0 20px ${theme.electricBlue}30`,
        }}>
          SOLO LEVELING SYSTEM
        </span>

        <NeonDivider vertical />

        {/* Date Nav */}
        <button onClick={prevDay} style={navBtn} title="前一天">
          <ChevronLeft size={14} />
        </button>
        <span style={{
          fontSize: 12, fontWeight: 600,
          fontFamily: theme.fontMono,
          color: theme.textPrimary, letterSpacing: 1,
          minWidth: 88, textAlign: 'center',
        }}>
          {selectedDate.toLocaleDateString('zh-CN', {
            month: '2-digit', day: '2-digit', weekday: 'short',
          })}
        </span>
        <button onClick={nextDay} style={navBtn} title="后一天">
          <ChevronRight size={14} />
        </button>
        <button onClick={goToday} style={{
          ...navBtn,
          fontFamily: theme.fontBody,
          fontSize: 12, fontWeight: 600,
          color: theme.electricBlue,
          padding: '3px 8px',
          border: `1px solid ${theme.electricBlue}30`,
          borderRadius: 3,
        }}>
          今日
        </button>

        {/* DB Status dot */}
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: dbStatus === 'live' ? theme.expGreen : dbStatus === 'error' ? theme.dangerRed : theme.textSecondary,
          boxShadow: dbStatus === 'live' ? `0 0 6px ${theme.expGreen}` : undefined,
          animation: dbStatus === 'loading' ? 'glowPulse 1.2s ease-in-out infinite' : undefined,
          flexShrink: 0,
        }} title={dbStatus === 'loading' ? '同步中' : dbStatus === 'live' ? '已连接' : '连接错误'} />

        <NeonDivider vertical />

        {/* Chart expand/collapse */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            ...navBtn,
            color: isExpanded ? theme.electricBlue : theme.textSecondary,
            padding: '3px 5px',
            border: `1px solid ${isExpanded ? theme.electricBlue + '40' : 'transparent'}`,
            borderRadius: 3,
          }}
          title={isExpanded ? '收缩昼夜表' : '展开昼夜表'}
        >
          {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>

        <div style={{ flex: 1 }} />

        {/* Voice hint */}
        <button style={{ ...navBtn, color: theme.textMuted, padding: '2px 4px' }} title="长按右 Alt 呼唤语音助手">
          <Mic size={13} />
        </button>

        <NeonDivider vertical />

        {/* B站历史 */}
        <button
          onClick={() => { setShowBili(!showBili); if (!showBili) setShowSettings(false) }}
          style={{
            ...navBtn,
            color: showBili ? theme.electricBlue : theme.textSecondary,
            textShadow: showBili ? `0 0 6px ${theme.electricBlue}` : undefined,
          }}
          title="B站历史记录"
        >
          <Tv2 size={14} />
        </button>

        {/* Settings */}
        <button
          onClick={() => { setShowSettings(!showSettings); if (!showSettings) setShowBili(false) }}
          style={{
            ...navBtn,
            fontSize: 15,
            color: showSettings ? theme.electricBlue : theme.textSecondary,
            textShadow: showSettings ? `0 0 6px ${theme.electricBlue}` : undefined,
          }}
          title="设置"
        >
          <Settings size={14} />
        </button>
      </div>

      {/* ── Main: Chart + Right Panel ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Chart */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <DayNightChart
            activities={activities}
            mtSpans={mtSpans}
            biliSpans={biliSpans}
            isExpanded={isExpanded}
            selectedDate={selectedDate}
            selection={chartSelection}
            onSpanClick={() => {}}
            onSpanHover={setHoveredTagSpan}
            onAppSpanHover={setHoveredAppSpan}
            onBiliSpanHover={setHoveredBiliSpan}
            trackMode={trackMode}
            onTrackModeChange={setTrackMode}
            pinnedPos={pinnedPos}
            onPinPos={setPinnedPos}
            onTimeSelect={handleTimeSelect}
            onClearSelection={handleClearSelection}
            onActivityResize={handleActivityResize}
            onDeleteMinuteRange={handleDeleteMinuteRange}
          />
        </div>

        {/* Right Panel: Chat or Settings */}
        <div style={{
          width: 340,
          borderLeft: `1px solid ${theme.divider}`,
          display: 'flex', flexDirection: 'column',
          background: 'rgba(2,6,14,0.6)',
        }}>
          {/* 右侧栏内容：Settings / Bili 优先；否则面板覆盖 Chat */}
          {showSettings ? (
            <SettingsPanel
              config={config}
              onUpdate={handleConfigUpdate}
              onClose={() => setShowSettings(false)}
            />
          ) : showBili ? (
            <BiliHistoryMonitor
              dbStatus={dbStatus}
              isLoading={biliLoading}
              error={biliError}
              lastUpdated={biliLastUpdated}
              countdown={biliCountdown}
              intervalSeconds={biliIntervalSec}
              isPaused={biliPaused}
              windowClosed={biliWinClosed}
              cursor={biliCursor}
              hasMoreRemote={biliHasMoreRemote}
              onLoadOlderHistory={biliLoadOlder}
              onPause={pauseBili}
              onResume={resumeBili}
              onRefresh={refreshBili}
              onSetInterval={setBiliInterval}
              onAddToActivity={handleAddBiliToActivity}
              onClose={() => setShowBili(false)}
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
                  />
                </div>
                {hasDetail && (
                  <div style={{ height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                    {tagSpan && <SpanDetailPanel span={tagSpan} />}
                    {appSpan && <AppHoverPanel span={appSpan} date={selectedDate} />}
                    {biliSpan && <BiliVideoPanel span={biliSpan} />}
                    <div style={{ flex: 1 }} />
                  </div>
                )}
              </>
            )
          })()}
        </div>
      </div>

      {/* ── Fairy Voice HUD Overlay ── */}
      <FairyHUD state={fairyState} visible={fairyVisible} />

    </div>
  )
}

const navBtn: React.CSSProperties = {
  background: 'transparent', border: 'none',
  color: theme.textSecondary, cursor: 'pointer',
  fontSize: 16, padding: '2px 4px', lineHeight: 1,
  fontFamily: theme.fontBody,
  transition: 'color 0.15s',
}
