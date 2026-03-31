// ══════════════════════════════════════════════
// Solo Agent — Windows 客户端（务实版）
// 核心：昼夜表 + AI 聊天整理
// ══════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Settings } from 'lucide-react'
import { fetchActivities } from './lib/chronos-api'
import { createActivity, updateActivity, deleteActivity } from './lib/local-api'
import type { ChronosActivity } from './types'
import { theme } from './theme'

// Agent
import { loadConfig, updateConfig } from './lib/agent/agent-config'
import type { AgentConfig } from './lib/agent/agent-config'
import { loadMemory, saveMemory } from './lib/agent/agent-memory'
import type { AgentMemoryState } from './lib/agent/agent-memory'
import { runAgentLoop } from './lib/agent/agent-loop'
import type { ToolContext } from './lib/agent/agent-tools'

// Voice
import { createVoiceService } from './lib/voice'
import type { VoiceService } from './lib/voice'

// UI
import DayNightChart from './components/DayNightChart'
import ChatPanel from './components/ChatPanel'
import SettingsPanel from './components/SettingsPanel'
import ActivityFormPanel from './components/ActivityFormPanel'
import FairyHUD from './components/FairyHUD'
import type { FairyState } from './components/FairyHUD'
import { NeonDivider, NeonBadge, MagneticButton } from './components/NeonUI'

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'agent' | 'system'
  readonly content: string
  readonly timestamp: string
}

export default function App() {
  // ── Data ──
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [activities, setActivities] = useState<ChronosActivity[]>([])
  const [dbStatus, setDbStatus] = useState<'loading' | 'live' | 'error'>('loading')

  // ── Layout ──
  const [isExpanded, setIsExpanded] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

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

  // ── Chat ──
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [config, setConfig] = useState<AgentConfig>(loadConfig)
  const memoryRef = useRef<AgentMemoryState>(loadMemory())

  // ── Voice / Fairy ──
  const [fairyState, setFairyState] = useState<FairyState>('idle')
  const [fairyVisible, setFairyVisible] = useState(false)
  const altDownTimeRef = useRef<number>(0)
  const pressingRef = useRef(false)
  const fairyStateRef = useRef<FairyState>('idle')
  const voiceServiceRef = useRef<VoiceService | null>(null)
  const LONG_PRESS_MS = 600

  // ── Fetch Activities ──
  useEffect(() => {
    setDbStatus('loading')
    fetchActivities(selectedDate)
      .then((data) => {
        setActivities(data)
        setDbStatus('live')
      })
      .catch((err) => {
        console.error('获取活动失败:', err)
        setActivities([])
        setDbStatus('error')
      })
  }, [selectedDate])

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
        onTranscript: (text) => {
          // 语音回复也写入聊天记录
          const voiceMsgId = 'voice-reply'
          setChatMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === voiceMsgId)
            if (idx >= 0) {
              return prev.map((m) =>
                m.id === voiceMsgId ? { ...m, content: text } : m)
            }
            return [...prev, {
              id: voiceMsgId, role: 'agent' as const,
              content: text, timestamp: new Date().toISOString(),
            }]
          })
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

  // ── Right Alt Long-Press → Voice Chat ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'AltRight' && !pressingRef.current) {
        pressingRef.current = true
        altDownTimeRef.current = Date.now()
        e.preventDefault()

        setTimeout(() => {
          if (pressingRef.current && Date.now() - altDownTimeRef.current >= LONG_PRESS_MS) {
            setFairyVisible(true)
            const svc = getVoiceService()
            svc.startRecording()
          }
        }, LONG_PRESS_MS)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'AltRight' && pressingRef.current) {
        pressingRef.current = false
        const holdDuration = Date.now() - altDownTimeRef.current

        if (holdDuration >= LONG_PRESS_MS && fairyStateRef.current === 'listening') {
          // 长按松开 → 停止录音并处理
          const svc = getVoiceService()
          svc.stopAndProcess()
        } else {
          // 短按 → 取消
          const svc = voiceServiceRef.current
          if (svc) svc.cancel()
          setFairyState('idle')
          fairyStateRef.current = 'idle'
          setFairyVisible(false)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
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

  const handleActivitySave = useCallback(async (activity: Omit<ChronosActivity, 'id'>) => {
    if (editMode?.type === 'add') {
      await createActivity(selectedDate, activity)
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

  // ── Send Message ──
  const handleSend = useCallback(async (text: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(), role: 'user',
      content: text, timestamp: new Date().toISOString(),
    }
    setChatMessages((prev) => [...prev, userMsg])
    setIsProcessing(true)

    const toolContext: ToolContext = {
      getScreenContext: () => '当前环境: Windows Tauri 客户端',
      getTodayCards: () => {
        if (activities.length === 0) return '今日暂无活动数据'
        return activities.map((a) =>
          `${Math.floor(a.startMinute / 60)}:${String(a.startMinute % 60).padStart(2, '0')}-${Math.floor(a.endMinute / 60)}:${String(a.endMinute % 60).padStart(2, '0')} [${a.category}] ${a.title}`
        ).join('\n')
      },
      getGameStatus: () => '游戏模块未启用',
      getRecentActivity: (min) => `最近 ${min} 分钟暂无记录`,
      getConfig: () => ({ mainQuest: config.mainQuest, motivations: config.motivations }),
      updateMainQuest: () => {},
      reorganizeCards: async () => false,
    }

    const systemPrompt = `你是「暗影君主系统」——用户的个人 AI 助手。
你帮助用户整理和分析每日活动，管理昼夜表数据。
语气简洁、专业、略带关心。称呼用户为「主人」。
回复简短有力，不超过 3-5 句话。`

    let agentText = ''
    const agentMsgId = crypto.randomUUID()

    try {
      memoryRef.current = await runAgentLoop(
        text, systemPrompt, memoryRef.current, config, toolContext,
        (event) => {
          if (event.type === 'textDelta') {
            agentText += event.delta
            setChatMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === agentMsgId)
              if (idx >= 0) {
                return prev.map((m) =>
                  m.id === agentMsgId ? { ...m, content: agentText } : m)
              }
              return [...prev, {
                id: agentMsgId, role: 'agent' as const,
                content: agentText, timestamp: new Date().toISOString(),
              }]
            })
          } else if (event.type === 'error') {
            setChatMessages((prev) => [...prev, {
              id: crypto.randomUUID(), role: 'system' as const,
              content: event.message, timestamp: new Date().toISOString(),
            }])
          }
        },
      )
      saveMemory(memoryRef.current)
    } catch (err) {
      setChatMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'system' as const,
        content: `错误: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      }])
    }

    setIsProcessing(false)
  }, [activities, config])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', background: theme.background,
      color: theme.textPrimary,
      fontFamily: theme.fontBody,
      overflow: 'hidden',
    }}>
      {/* ── Top Bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 16px', height: 42, flexShrink: 0,
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
            fontFamily: theme.fontBody,
            fontSize: 11, fontWeight: 500,
            color: isExpanded ? theme.electricBlue : theme.textSecondary,
            padding: '3px 8px',
            border: `1px solid ${isExpanded ? theme.electricBlue + '40' : 'transparent'}`,
            borderRadius: 3,
          }}
          title={isExpanded ? '收缩昼夜表' : '展开昼夜表'}
        >
          {isExpanded
            ? <><Minimize2 size={12} style={{ verticalAlign: 'middle' }} /> 收缩</>
            : <><Maximize2 size={12} style={{ verticalAlign: 'middle' }} /> 展开</>
          }
        </button>

        <div style={{ flex: 1 }} />

        {/* Voice hint */}
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: theme.fontBody }}>
          长按右 Alt 呼唤
        </span>

        <NeonDivider vertical />

        {/* Settings */}
        <button
          onClick={() => setShowSettings(!showSettings)}
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
            isExpanded={isExpanded}
            selectedDate={selectedDate}
            selection={chartSelection}
            onActivityClick={(a) => { setShowSettings(false); setChartSelection(null); setEditMode({ type: 'edit', activity: a }) }}
            onTimeSelect={handleTimeSelect}
            onClearSelection={handleClearSelection}
          />
        </div>

        {/* Right Panel: Chat or Settings */}
        <div style={{
          width: 340,
          borderLeft: `1px solid ${theme.divider}`,
          display: 'flex', flexDirection: 'column',
          background: 'rgba(2,6,14,0.6)',
        }}>
          {showSettings ? (
            <SettingsPanel
              config={config}
              onUpdate={handleConfigUpdate}
              onClose={() => setShowSettings(false)}
            />
          ) : editMode !== null ? (
            <ActivityFormPanel
              mode={editMode.type}
              initialActivity={editMode.type === 'edit' ? editMode.activity : undefined}
              initialStartMinute={editMode.type === 'add' ? (pushedTime?.start) : undefined}
              initialEndMinute={editMode.type === 'add' ? (pushedTime?.end) : undefined}
              pushedStart={editMode.type === 'add' ? (pushedTime?.start ?? null) : undefined}
              pushedEnd={editMode.type === 'add' ? (pushedTime?.end ?? null) : undefined}
              pushedVersion={editMode.type === 'add' ? pushedVersion : 0}
              onTimeChange={(s, e) => { setChartSelection({ startMinute: s, endMinute: e }) }}
              onSave={handleActivitySave}
              onDelete={editMode.type === 'edit' ? handleActivityDelete : undefined}
              onClose={() => { setEditMode(null); setChartSelection(null) }}
            />
          ) : (
            <ChatPanel
              messages={chatMessages}
              isProcessing={isProcessing}
              onSend={handleSend}
            />
          )}
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
