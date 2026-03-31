// ══════════════════════════════════════════════
// Chat Panel — AI 对话面板
// ══════════════════════════════════════════════

import { useState, useRef, useEffect } from 'react'
import { Send, MessageSquare } from 'lucide-react'
import { theme } from '../theme'
import type { ChatMessage } from '../App'

interface Props {
  readonly messages: readonly ChatMessage[]
  readonly isProcessing: boolean
  readonly onSend: (text: string) => void
}

export default function ChatPanel({ messages, isProcessing, onSend }: Props) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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
      `}</style>

      {/* ── Header ── */}
      <div style={{
        padding: '12px 16px',
        borderBottom: `1px solid ${theme.divider}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          fontSize: 12, fontWeight: 700,
          fontFamily: theme.fontDisplay,
          color: theme.electricBlue, letterSpacing: 2,
          textShadow: `0 0 8px ${theme.electricBlue}60`,
        }}>
          暗影系统
        </span>
        <div style={{
          width: 5, height: 5, borderRadius: '50%',
          background: theme.expGreen,
          boxShadow: `0 0 5px ${theme.expGreen}`,
          animation: 'glowPulse 2s ease-in-out infinite',
          marginLeft: 'auto',
        }} />
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
          <Bubble key={msg.id} message={msg} />
        ))}

        {isProcessing && messages[messages.length - 1]?.role !== 'agent' && (
          <TypingDots />
        )}
      </div>

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

// ── Bubble ──

function Bubble({ message }: { message: ChatMessage }) {
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

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
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
      </div>
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
