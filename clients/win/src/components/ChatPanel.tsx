// ══════════════════════════════════════════════
// Chat Panel — AI 对话面板
// ══════════════════════════════════════════════

import { useRef, useEffect, useState } from 'react'
import { Send, MessageSquare, Camera, Volume2, VolumeX, Bug, Radio, History } from 'lucide-react'
import { theme } from '../theme'
import type { ChatMessage, OmniDebugInfo } from '../App'
import type { ApiRequestSnapshot } from '../lib/llm/api'
import DebugRequestModal from './DebugRequestModal'
import OmniDebugModal from './OmniDebugModal'
import { HudFrame } from './hud'
import Tooltip from './Tooltip'

// 气泡倒角 clip-path（尖角留"尾巴"侧用于指向发送者）
// 用户：右下为尾，其余三角 8px 斜切
const bubbleClipUser = `polygon(
  8px 0,
  calc(100% - 8px) 0,
  100% 8px,
  100% 100%,
  8px 100%,
  0 calc(100% - 8px),
  0 8px
)`
// AI：左下为尾
const bubbleClipAgent = `polygon(
  8px 0,
  calc(100% - 8px) 0,
  100% 8px,
  100% calc(100% - 8px),
  calc(100% - 8px) 100%,
  0 100%,
  0 8px
)`
// 输入框 / 按钮通用 4px 八角切角
const clip4 = `polygon(
  4px 0, calc(100% - 4px) 0,
  100% 4px, 100% calc(100% - 4px),
  calc(100% - 4px) 100%, 4px 100%,
  0 calc(100% - 4px), 0 4px
)`

interface Props {
  readonly messages: readonly ChatMessage[]
  readonly isProcessing: boolean
  readonly onSend: (text: string) => void
  readonly cameraReady?: boolean
  readonly cameraPresent?: boolean
  readonly cameraWindowOpen?: boolean
  readonly onToggleCamera?: () => void
  readonly ttsEnabled?: boolean
  readonly onToggleTts?: () => void
  readonly onOpenSessions?: () => void
  readonly sessionsOpen?: boolean
}

export default function ChatPanel({ messages, isProcessing, onSend, cameraReady, cameraPresent, cameraWindowOpen, onToggleCamera, ttsEnabled, onToggleTts, onOpenSessions, sessionsOpen }: Props) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [activeDebugSnaps, setActiveDebugSnaps] = useState<ApiRequestSnapshot[] | null>(null)
  const [activeOmniDebug, setActiveOmniDebug] = useState<OmniDebugInfo | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, messages[messages.length - 1]?.content])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed || isProcessing) return
    onSend(trimmed)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', fontFamily: theme.fontBody,
      position: 'relative',
      padding: '4px 4px',
    }}>
      {/* 外层 HUD 装饰（断续边线 + 顶/底握手 + 侧接口 + 异形四角） */}
      <HudFrame
        color={theme.electricBlue}
        accent={theme.warningOrange}
        topLabel="CHAT · SHADOW"
        bottomLabel="INPUT"
        showNotchTop
        showNotchBottom
        notchWidth={60}
        notchDepth={7}
        cornerSize={16}
      />
      <style>{`
        .chat-textarea::placeholder { color: ${theme.textMuted}; font-family: ${theme.fontMono}; letter-spacing: 0.5px; font-size: 12px; }
        .chat-textarea:focus { outline: none; }
        .send-btn:hover:not(:disabled) {
          background: radial-gradient(circle at 35% 35%, ${theme.electricBlue}88 0%, ${theme.electricBlue}33 70%) !important;
          color: #001820 !important;
          border-color: ${theme.electricBlue} !important;
          box-shadow: 0 0 12px ${theme.electricBlue}AA, inset 0 0 6px rgba(255,255,255,0.25) !important;
          transform: scale(1.06);
        }
        .chat-input-wrap:focus-within {
          border-color: ${theme.electricBlue}66 !important;
          box-shadow: inset 0 0 16px ${theme.electricBlue}14, 0 0 0 1px ${theme.electricBlue}22 !important;
        }
        .hud-icon-btn:hover { border-color: ${theme.electricBlue}66 !important; background: ${theme.electricBlue}14 !important; }
        .hud-icon-btn:hover .hud-icon-inner { color: ${theme.electricBlue} !important; }
        @keyframes audioPulse {
          0%,100% { transform: scale(1);   opacity: 0.7; }
          50%      { transform: scale(1.18); opacity: 0.3; }
        }
        @keyframes camPresent {
          0%,100% { opacity: 1;   box-shadow: 0 0 0 2px #4ADE8066, 0 0 6px #4ADE80; }
          50%      { opacity: 0.5; box-shadow: 0 0 0 4px #4ADE8022, 0 0 10px #4ADE80; }
        }
        @keyframes camReady {
          0%,100% { opacity: 0.4; }
          50%      { opacity: 0.2; }
        }
      `}</style>

      {/* ── Header ── */}
      <div style={{
        padding: '14px 18px 10px',
        borderBottom: `1px solid ${theme.hudFrameSoft}`,
        display: 'flex', alignItems: 'center', gap: 8,
        position: 'relative',   // CameraPreview 定位锚点
        background: `linear-gradient(90deg, ${theme.electricBlue}08 0%, transparent 100%)`,
      }}>
        {/* 历史会话开关：科幻电源按钮（LED 指示 + 接线） */}
        {onOpenSessions && (
          <HistoryToggle on={!!sessionsOpen} onClick={onOpenSessions} />
        )}
        <span style={{
          fontSize: 12, fontWeight: 700,
          fontFamily: theme.fontDisplay,
          color: theme.electricBlue, letterSpacing: 2.5,
          textShadow: `0 0 10px ${theme.electricBlue}AA, 0 0 20px ${theme.electricBlue}44`,
        }}>
          暗影系统
        </span>
        {/* 状态徽章：ONLINE（切角） */}
        <span style={{
          fontSize: 8.5, fontWeight: 700,
          letterSpacing: 1.6,
          color: theme.expGreen,
          padding: '2px 7px',
          border: `1px solid ${theme.expGreen}55`,
          clipPath: clip4,
          background: `${theme.expGreen}14`,
          fontFamily: theme.fontMono,
          textShadow: `0 0 6px ${theme.expGreen}88`,
        }}>
          ONLINE
        </span>

        {/* 右侧按钮组 */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* TTS 开关 */}
          {onToggleTts && (
            <HudIconBtn
              onClick={onToggleTts}
              title={ttsEnabled ? '关闭语音朗读' : '开启语音朗读'}
              active={ttsEnabled}
              activeColor={theme.expGreen}
            >
              {ttsEnabled ? <Volume2 size={11} /> : <VolumeX size={11} />}
            </HudIconBtn>
          )}
          {onToggleCamera && (
            <HudIconBtn
              onClick={onToggleCamera}
              title={cameraWindowOpen ? '关闭预览' : cameraPresent ? '已检测人脸' : '打开预览'}
              active={cameraWindowOpen}
              activeColor={theme.expGreen}
              dim={!cameraReady}
            >
              <Camera size={11} />
            </HudIconBtn>
          )}
          <div style={{
            width: 5, height: 5, borderRadius: '50%',
            background: theme.expGreen,
            boxShadow: `0 0 5px ${theme.expGreen}`,
            animation: 'glowPulse 2s ease-in-out infinite',
          }} />
        </div>
      </div>

      {/* ── Messages ── */}
      <div
        ref={scrollRef}
        style={{
          flex: 1, overflowY: 'auto',
          padding: '14px 14px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        {messages.length === 0 && (
          <div style={{
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            height: '100%', gap: 12, padding: '0 20px',
          }}>
            <MessageSquare size={28} style={{
              color: theme.electricBlue,
              filter: `drop-shadow(0 0 8px ${theme.electricBlue}60)`,
              opacity: 0.5,
            }} />
            <div style={{
              fontSize: 9.5, fontFamily: theme.fontMono, fontWeight: 700,
              letterSpacing: 2.5,
              color: theme.electricBlue, opacity: 0.65,
              textShadow: `0 0 6px ${theme.electricBlue}99`,
            }}>
              ─ STAND BY FOR INPUT ─
            </div>
            <div style={{
              fontSize: 12, color: theme.textSecondary,
              textAlign: 'center', lineHeight: 1.7,
            }}>
              对暗影系统说点什么
            </div>
            <div style={{
              fontSize: 11, color: theme.textMuted,
              textAlign: 'center', lineHeight: 1.6,
            }}>
              帮你分析今日活动<br />整理目标与进展
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <Bubble
            key={msg.id}
            message={msg}
            onDebug={msg.debugSnapshots ? () => setActiveDebugSnaps(msg.debugSnapshots!) : undefined}
            onOmniDebug={msg.omniDebugInfo ? () => setActiveOmniDebug(msg.omniDebugInfo!) : undefined}
          />
        ))}

        {isProcessing && messages[messages.length - 1]?.role !== 'agent' && (
          <TypingDots />
        )}
      </div>

      {/* ── Debug Modals ── */}
      {activeDebugSnaps && (
        <DebugRequestModal
          snapshots={activeDebugSnaps}
          onClose={() => setActiveDebugSnaps(null)}
        />
      )}
      {activeOmniDebug && (
        <OmniDebugModal
          info={activeOmniDebug}
          onClose={() => setActiveOmniDebug(null)}
        />
      )}

      {/* ── Input ── */}
      <div style={{
        padding: '10px 18px 14px',
        borderTop: `1px solid ${theme.hudFrameSoft}`,
        position: 'relative',
        background: `linear-gradient(180deg, transparent 0%, ${theme.electricBlue}06 100%)`,
      }}>
        <div className="chat-input-wrap" style={{
          position: 'relative',
          background: 'rgba(0,12,28,0.6)',
          border: `1px solid ${theme.hudFrameSoft}`,
          clipPath: clip4,
          padding: '10px 12px',
          transition: 'border-color 0.2s, box-shadow 0.2s',
          boxShadow: `inset 0 0 12px rgba(0,229,255,0.04)`,
        }}>
          <textarea
            ref={inputRef}
            className="chat-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息..."
            rows={3}
            style={{
              width: '100%', background: 'transparent', border: 'none',
              color: theme.textPrimary,
              fontFamily: theme.fontBody,
              fontSize: 13, outline: 'none', resize: 'none',
              lineHeight: 1.5, minHeight: 64, maxHeight: 200, overflowY: 'auto',
              // 右下留出圆形按钮空间
              paddingRight: 34, paddingBottom: 2,
            }}
          />
          {/* 浮动 send：圆形小按钮，钉在右下角内侧 */}
          <Tooltip content="发送 (Enter)" wrapStyle={{ position: 'absolute', right: 14, bottom: 10 }}>
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!input.trim() || isProcessing}
            style={{
              background: input.trim() && !isProcessing
                ? `radial-gradient(circle at 35% 35%, ${theme.electricBlue}55 0%, ${theme.electricBlue}1A 70%)`
                : 'rgba(255,255,255,0.04)',
              border: `1px solid ${input.trim() && !isProcessing ? theme.electricBlue + '88' : theme.hudFrameSoft}`,
              borderRadius: '50%',
              padding: 0,
              width: 24, height: 24,
              color: input.trim() && !isProcessing ? theme.electricBlue : theme.textMuted,
              boxShadow: input.trim() && !isProcessing
                ? `0 0 8px ${theme.electricBlue}55, inset 0 0 4px ${theme.electricBlue}33`
                : undefined,
              opacity: input.trim() && !isProcessing ? 1 : 0.55,
              cursor: input.trim() && !isProcessing ? 'pointer' : 'default',
              transition: 'all 0.15s ease',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Send size={11} style={{ marginLeft: -1 }} />
          </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

// ── HUD Icon Button（切角 + 边框 + hover cyan） ──

// 历史会话开关：断裂 HUD 边框（四角 L 标 + 上下刻度段 + 右侧插头尖），点亮时整体发光 + 拉出信号线
function HistoryToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  const c = theme.electricBlue
  const dim = on ? 1 : 0.5
  return (
    <Tooltip content={on ? '收起历史会话' : '打开历史会话'}>
    <button
      className="hud-history-toggle"
      data-on={on ? '1' : '0'}
      onClick={onClick}
      style={{
        position: 'relative',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 14px 5px 10px',
        background: on
          ? `linear-gradient(90deg, ${c}22 0%, ${c}08 100%)`
          : 'transparent',
        border: 'none',
        color: on ? c : theme.textSecondary,
        fontSize: 10.5, fontFamily: theme.fontMono,
        fontWeight: 700, letterSpacing: 1.6,
        cursor: 'pointer',
        textShadow: on ? `0 0 5px ${c}` : undefined,
        transition: 'color 0.15s, background 0.15s',
        lineHeight: 1,
      }}
    >
      {/* HUD 式断裂边框：4 角 L + 上下刻度段 + 右侧三角插头 */}
      <svg
        width="100%" height="100%"
        preserveAspectRatio="none"
        style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          overflow: 'visible',
          filter: on ? `drop-shadow(0 0 4px ${c}BB)` : undefined,
        }}
        viewBox="0 0 100 100"
      >
        {/* 4 角 L */}
        <polyline points="0,14 0,0 14,0"   stroke={c} strokeWidth="2" fill="none" opacity={dim} />
        <polyline points="86,0 100,0 100,14" stroke={c} strokeWidth="2" fill="none" opacity={dim} />
        <polyline points="100,86 100,100 86,100" stroke={c} strokeWidth="2" fill="none" opacity={dim} />
        <polyline points="14,100 0,100 0,86" stroke={c} strokeWidth="2" fill="none" opacity={dim} />
        {/* 上下边中段短线（刻度）*/}
        <line x1="35" y1="0" x2="65" y2="0"     stroke={c} strokeWidth="1" opacity={dim * 0.6} />
        <line x1="35" y1="100" x2="65" y2="100" stroke={c} strokeWidth="1" opacity={dim * 0.6} />
        {/* 上下边细刻度 tick */}
        <line x1="25" y1="0" x2="25" y2="4"   stroke={c} strokeWidth="1" opacity={dim * 0.8} />
        <line x1="75" y1="0" x2="75" y2="4"   stroke={c} strokeWidth="1" opacity={dim * 0.8} />
        <line x1="25" y1="96" x2="25" y2="100" stroke={c} strokeWidth="1" opacity={dim * 0.8} />
        <line x1="75" y1="96" x2="75" y2="100" stroke={c} strokeWidth="1" opacity={dim * 0.8} />
      </svg>

      <History size={11} style={{ position: 'relative' }} />
      <span style={{ position: 'relative' }}>历史</span>

      {/* 点亮时的信号线：从按钮右端延伸，与面板视觉相连 */}
      {on && (
        <span style={{
          position: 'absolute',
          right: -7, top: 'calc(50% - 0.5px)',
          width: 7, height: 1,
          background: c,
          boxShadow: `0 0 4px ${c}, 0 0 8px ${c}88`,
          pointerEvents: 'none',
        }} />
      )}
    </button>
    </Tooltip>
  )
}

function HudIconBtn({
  onClick, title, active, activeColor, dim, children,
}: {
  onClick: () => void
  title: string
  active?: boolean
  activeColor?: string
  dim?: boolean
  children: React.ReactNode
}) {
  const base = active
    ? (activeColor ?? theme.electricBlue)
    : dim ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.45)'
  return (
    <Tooltip content={title}>
      <button
        className="hud-icon-btn"
        onClick={onClick}
        style={{
          background: active ? `${activeColor ?? theme.electricBlue}14` : 'rgba(0,229,255,0.03)',
          border: `1px solid ${active ? (activeColor ?? theme.electricBlue) + '66' : theme.hudFrameSoft}`,
          clipPath: clip4,
          padding: '4px 5px',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.15s, border-color 0.15s',
        }}
      >
        <span className="hud-icon-inner" style={{
          color: base,
          display: 'flex', alignItems: 'center',
          textShadow: active ? `0 0 6px ${activeColor ?? theme.electricBlue}` : undefined,
          transition: 'color 0.15s',
        }}>
          {children}
        </span>
      </button>
    </Tooltip>
  )
}

// ── Audio Bubble（Telegram 风格）──

const WAVEFORM_BARS = 40
const BTN = 42
const RING_R = 18
const RING_CIRC = 2 * Math.PI * RING_R

function AudioBubble({ audioUrl, durationMs }: { audioUrl: string; durationMs?: number }) {
  const [playing, setPlaying]   = useState(false)
  const [progress, setProgress] = useState(0)          // 0–1，rAF 驱动
  const [duration, setDuration] = useState(            // 从 audio 元素取真实时长
    durationMs != null ? durationMs / 1000 : 0
  )
  const [waveform, setWaveform] = useState<number[]>([])
  const audioRef = useRef<HTMLAudioElement>(null)
  const rafRef   = useRef<number>(0)

  // rAF 驱动进度（丝滑 60fps）
  useEffect(() => {
    if (!playing) { cancelAnimationFrame(rafRef.current); return }
    const tick = () => {
      const el = audioRef.current
      if (el && el.duration > 0)
        setProgress(el.currentTime / el.duration)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing])

  // 真实时长（onLoadedMetadata）
  const handleMeta = () => {
    const el = audioRef.current
    if (el && isFinite(el.duration) && el.duration > 0)
      setDuration(el.duration)
  }

  // 解码真实波形（RMS 采样，更贴近听感）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const buf   = await (await fetch(audioUrl)).arrayBuffer()
        const ctx   = new AudioContext()
        const decoded = await ctx.decodeAudioData(buf)
        await ctx.close()
        if (cancelled) return
        const data  = decoded.getChannelData(0)
        const block = Math.floor(data.length / WAVEFORM_BARS)
        const rms   = Array.from({ length: WAVEFORM_BARS }, (_, i) => {
          let sum = 0
          const off = i * block
          for (let j = 0; j < block; j++) sum += data[off + j] ** 2
          return Math.sqrt(sum / block)
        })
        const maxRms = Math.max(...rms, 0.001)
        setWaveform(rms.map((v) => v / maxRms))
      } catch {
        if (!cancelled)
          setWaveform(Array.from({ length: WAVEFORM_BARS }, () => 0.25 + Math.random() * 0.75))
      }
    })()
    return () => { cancelled = true }
  }, [audioUrl])

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) { el.pause(); setPlaying(false) }
    else         { el.play();  setPlaying(true)  }
  }

  const fmtSec = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  const bars       = waveform.length > 0 ? waveform : Array.from({ length: WAVEFORM_BARS }, () => 0.3)
  const playedBars = Math.round(progress * WAVEFORM_BARS)
  const ringFilled = progress * RING_CIRC

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 14px',
      minWidth: 230, maxWidth: 290,
      background: `linear-gradient(135deg, ${theme.electricBlue}F0 0%, ${theme.electricBlue}B8 100%)`,
      clipPath: bubbleClipUser,
      boxShadow: `0 0 14px ${theme.electricBlue}55`,
    }}>
      <audio
        ref={audioRef}
        src={audioUrl}
        onLoadedMetadata={handleMeta}
        onEnded={() => { setPlaying(false); setProgress(0) }}
      />

      {/* ── 圆形按钮 + SVG 进度环 ── */}
      <div style={{ position: 'relative', width: BTN, height: BTN, flexShrink: 0 }}>
        {/* pulse 光晕（播放中） */}
        {playing && (
          <div style={{
            position: 'absolute', inset: -4,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.12)',
            animation: 'audioPulse 1.4s ease-in-out infinite',
          }} />
        )}

        {/* SVG 进度环（无 CSS transition，rAF 直接驱动已够丝滑） */}
        <svg
          width={BTN} height={BTN}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
        >
          <circle cx={BTN/2} cy={BTN/2} r={RING_R}
            fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="2.5" />
          <circle cx={BTN/2} cy={BTN/2} r={RING_R}
            fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${ringFilled} ${RING_CIRC}`}
            transform={`rotate(-90 ${BTN/2} ${BTN/2})`}
          />
        </svg>

        {/* 按钮主体 */}
        <button
          onClick={toggle}
          style={{
            position: 'absolute', inset: 4,
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.28)',
            border: 'none', color: '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, paddingLeft: playing ? 0 : 2,
          }}
        >
          {playing ? '⏸' : '▶'}
        </button>
      </div>

      {/* ── 波形 + 时间 ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 32 }}>
          {bars.map((amp, i) => {
            const played  = i < playedBars
            const current = i === playedBars && playing
            return (
              <div key={i} style={{
                flex: 1, borderRadius: 3,
                height: `${Math.max(14, amp * 100)}%`,
                background: played ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.30)',
                transform: current ? 'scaleY(1.2)' : 'scaleY(1)',
                transformOrigin: 'center',
              }} />
            )
          })}
        </div>

        <div style={{
          fontSize: 10, fontWeight: 600,
          color: 'rgba(255,255,255,0.72)',
          fontFamily: theme.fontBody, letterSpacing: 0.3,
        }}>
          {playing ? fmtSec(progress * duration) : fmtSec(duration)}
        </div>
      </div>
    </div>
  )
}

// ── Bubble ──

function Bubble({ message, onDebug, onOmniDebug }: { message: ChatMessage; onDebug?: () => void; onOmniDebug?: () => void }) {
  if (message.role === 'system') {
    return (
      <div style={{
        textAlign: 'center', fontSize: 11,
        color: theme.textMuted, padding: '4px 0',
        fontFamily: theme.fontBody,
      }}>
        — {message.content} —
      </div>
    )
  }

  const isUser = message.role === 'user'

  // 语音消息 → 音频气泡 + ASR 转写文字（气泡下方）
  if (isUser && message.audioUrl) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, animation: 'fadeSlideIn 0.2s ease' }}>
        <AudioBubble audioUrl={message.audioUrl} durationMs={message.durationMs} />
        {message.transcript && (
          <div style={{
            maxWidth: 290,
            fontSize: 11.5,
            color: theme.textSecondary,
            padding: '3px 10px',
            fontFamily: theme.fontBody,
            lineHeight: 1.5,
            textAlign: 'right',
            fontStyle: 'italic',
          }}>
            {message.transcript}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      alignItems: 'flex-end',
      gap: 4,
      animation: 'fadeSlideIn 0.2s ease',
    }}>
      <div style={{
        position: 'relative',
        maxWidth: '88%',
        padding: isUser ? '9px 14px' : '9px 14px 9px 16px',
        clipPath: isUser ? bubbleClipUser : bubbleClipAgent,
        fontSize: 13,
        fontFamily: theme.fontBody,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        ...(isUser
          ? {
              background: `linear-gradient(135deg, ${theme.electricBlue}E6 0%, ${theme.electricBlue}B0 60%, ${theme.electricBlue}88 100%)`,
              color: '#001820',
              fontWeight: 500,
              boxShadow: `0 0 12px ${theme.electricBlue}55`,
            }
          : {
              background: `linear-gradient(135deg, rgba(8,16,32,0.92) 0%, rgba(4,10,24,0.88) 100%)`,
              color: theme.textPrimary,
              boxShadow: `inset 0 0 10px ${theme.electricBlue}14, 0 0 8px rgba(0,229,255,0.10)`,
            }),
      }}>
        {/* AI 气泡：左侧发光指示条（代表信号源） */}
        {!isUser && (
          <span aria-hidden style={{
            position: 'absolute',
            left: 0, top: 6, bottom: 6,
            width: 2,
            background: theme.electricBlue,
            boxShadow: `0 0 6px ${theme.electricBlue}`,
            opacity: 0.75,
          }} />
        )}
        {message.content}
        {!isUser && message.audioUrl && (
          <div style={{ marginTop: 6 }}>
            <AudioBubble audioUrl={message.audioUrl} />
          </div>
        )}
      </div>
      {/* Debug 按钮（普通模式）：有快照时显示 */}
      {!isUser && onDebug && (
        <Tooltip content="查看本轮 AI 请求">
        <button
          onClick={onDebug}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.15)', padding: 2,
            display: 'flex', alignItems: 'center',
            flexShrink: 0,
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.5)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.15)')}
        >
          <Bug size={11} />
        </button>
        </Tooltip>
      )}
      {/* Omni Debug 按钮：Omni 回复气泡上显示 */}
      {!isUser && onOmniDebug && (
        <Tooltip content="查看本轮 Omni 上下文">
        <button
          onClick={onOmniDebug}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(167,139,250,0.25)', padding: 2,
            display: 'flex', alignItems: 'center',
            flexShrink: 0,
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(167,139,250,0.7)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(167,139,250,0.25)')}
        >
          <Radio size={11} />
        </button>
        </Tooltip>
      )}
    </div>
  )
}

// ── Typing Dots ──

function TypingDots() {
  return (
    <div style={{
      display: 'inline-flex', gap: 6, padding: '6px 12px',
      alignItems: 'center',
      alignSelf: 'flex-start',
      background: 'rgba(4,10,24,0.7)',
      border: `1px solid ${theme.hudFrameSoft}`,
      clipPath: bubbleClipAgent,
      fontFamily: theme.fontMono,
      fontSize: 9,
      letterSpacing: 1.8,
      fontWeight: 700,
      color: theme.electricBlue,
      textShadow: `0 0 5px ${theme.electricBlue}99`,
    }}>
      <span style={{ opacity: 0.7 }}>RECV</span>
      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 5, height: 5,
              background: theme.electricBlue,
              boxShadow: `0 0 6px ${theme.electricBlue}`,
              animation: `typingPulse 1s ease-in-out ${i * 0.18}s infinite`,
              transform: 'rotate(45deg)',
            }}
          />
        ))}
      </span>
    </div>
  )
}
