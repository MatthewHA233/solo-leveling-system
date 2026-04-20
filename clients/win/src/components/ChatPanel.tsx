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
}

export default function ChatPanel({ messages, isProcessing, onSend, cameraReady, cameraPresent, cameraWindowOpen, onToggleCamera, ttsEnabled, onToggleTts, onOpenSessions }: Props) {
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
    }}>
      <style>{`
        .chat-textarea::placeholder { color: ${theme.textMuted}; }
        .chat-textarea:focus { outline: none; }
        .send-btn:hover:not(:disabled) { background: ${theme.electricBlue} !important; color: #000 !important; }
        .chat-input-wrap:focus-within { border-color: ${theme.electricBlue}44 !important; box-shadow: 0 0 0 2px ${theme.electricBlue}12; }
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
        padding: '8px 12px',
        borderBottom: `1px solid ${theme.divider}`,
        display: 'flex', alignItems: 'center', gap: 8,
        position: 'relative',   // CameraPreview 定位锚点
      }}>
        <span style={{
          fontSize: 12, fontWeight: 700,
          fontFamily: theme.fontDisplay,
          color: theme.electricBlue, letterSpacing: 2,
          textShadow: `0 0 8px ${theme.electricBlue}60`,
        }}>
          暗影系统
        </span>

        {/* 右侧按钮组 */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          {/* 历史会话 */}
          {onOpenSessions && (
            <button
              onClick={onOpenSessions}
              title="历史会话"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                display: 'flex', alignItems: 'center',
                color: 'rgba(255,255,255,0.35)',
                transition: 'color 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = theme.electricBlue)}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.35)')}
            >
              <History size={13} />
            </button>
          )}
          {/* TTS 开关 */}
          {onToggleTts && (
            <button
              onClick={onToggleTts}
              title={ttsEnabled ? '关闭语音朗读' : '开启语音朗读'}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                display: 'flex', alignItems: 'center',
                color: ttsEnabled ? '#4ADE80' : 'rgba(255,255,255,0.2)',
                transition: 'color 0.3s',
              }}
            >
              {ttsEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </button>
          )}
          {onToggleCamera && (
            <button
              onClick={onToggleCamera}
              title={cameraWindowOpen ? '关闭摄像头预览' : cameraPresent ? '检测到人脸 · 点击预览' : '点击打开摄像头预览'}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                display: 'flex', alignItems: 'center',
                color: cameraWindowOpen ? '#4ADE80' : cameraReady ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.2)',
                transition: 'color 0.3s',
              }}
            >
              <Camera size={13} />
            </button>
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
            height: '100%', gap: 10, padding: '0 20px',
          }}>
            <MessageSquare size={28} style={{
              color: theme.electricBlue,
              filter: `drop-shadow(0 0 8px ${theme.electricBlue}60)`,
              opacity: 0.5,
            }} />
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
        padding: '10px 14px',
        borderTop: `1px solid ${theme.divider}`,
      }}>
        <div className="chat-input-wrap" style={{
          display: 'flex', alignItems: 'flex-end', gap: 8,
          background: 'rgba(255,255,255,0.04)',
          border: `1px solid ${theme.glassBorder}`,
          borderRadius: 8, padding: '8px 12px',
          transition: 'border-color 0.2s, box-shadow 0.2s',
        }}>
          <textarea
            ref={inputRef}
            className="chat-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息...  Enter 发送"
            rows={1}
            style={{
              flex: 1, background: 'transparent', border: 'none',
              color: theme.textPrimary,
              fontFamily: theme.fontBody,
              fontSize: 13, outline: 'none', resize: 'none',
              lineHeight: 1.5, maxHeight: 100, overflowY: 'auto',
            }}
          />
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!input.trim() || isProcessing}
            style={{
              background: input.trim() && !isProcessing
                ? `${theme.electricBlue}22`
                : 'rgba(255,255,255,0.05)',
              border: `1px solid ${input.trim() && !isProcessing ? theme.electricBlue + '60' : 'transparent'}`,
              borderRadius: 6,
              color: input.trim() && !isProcessing ? theme.electricBlue : theme.textMuted,
              width: 32, height: 32,
              cursor: input.trim() && !isProcessing ? 'pointer' : 'default',
              transition: 'all 0.15s ease',
              flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Send size={13} />
          </button>
        </div>
      </div>
    </div>
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
      background: `linear-gradient(135deg, ${theme.electricBlue}f0, ${theme.electricBlue}b8)`,
      borderRadius: '18px 18px 4px 18px',
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
        maxWidth: '88%',
        padding: '9px 13px',
        borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
        fontSize: 13,
        fontFamily: theme.fontBody,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        ...(isUser
          ? {
              background: `linear-gradient(135deg, ${theme.electricBlue}e0, ${theme.electricBlue}b0)`,
              color: '#001820',
              fontWeight: 500,
            }
          : {
              background: 'rgba(255,255,255,0.05)',
              border: `1px solid ${theme.glassBorder}`,
              color: theme.textPrimary,
            }),
      }}>
        {message.content}
        {!isUser && message.audioUrl && (
          <div style={{ marginTop: 6 }}>
            <AudioBubble audioUrl={message.audioUrl} />
          </div>
        )}
      </div>
      {/* Debug 按钮（普通模式）：有快照时显示 */}
      {!isUser && onDebug && (
        <button
          onClick={onDebug}
          title="查看本轮 AI 请求"
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
      )}
      {/* Omni Debug 按钮：Omni 回复气泡上显示 */}
      {!isUser && onOmniDebug && (
        <button
          onClick={onOmniDebug}
          title="查看本轮 Omni 上下文"
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
      )}
    </div>
  )
}

// ── Typing Dots ──

function TypingDots() {
  return (
    <div style={{ display: 'flex', gap: 5, padding: '6px 4px', alignItems: 'center' }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 5, height: 5, borderRadius: '50%',
            background: theme.electricBlue,
            animation: `typingPulse 1s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </div>
  )
}
