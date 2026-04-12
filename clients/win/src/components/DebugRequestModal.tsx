// ══════════════════════════════════════════════
// DebugRequestModal — 查看每轮发给 AI 的完整 payload
// 单页阅读视图，无标签页
// ══════════════════════════════════════════════

import { useState } from 'react'
import { X, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react'
import type { ApiRequestSnapshot } from '../lib/llm/api'

interface Props {
  snapshots: ApiRequestSnapshot[]
  onClose: () => void
}

// ── 格式化工具 ──

/** 尝试格式化 JSON 字符串，失败原样返回 */
function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

// ── 角色配置 ──

const ROLE_CFG: Record<string, { label: string; color: string }> = {
  system:    { label: 'SYSTEM',    color: '#a78bfa' },
  user:      { label: 'USER',      color: '#7ecaff' },
  assistant: { label: 'ASSISTANT', color: '#34d399' },
  tool:      { label: 'TOOL',      color: '#fbbf24' },
}
const getRoleCfg = (role: string) =>
  ROLE_CFG[role] ?? { label: role.toUpperCase(), color: '#9ca3af' }

// ── 工具调用卡片 ──

interface ToolCallRaw {
  id?: string
  function?: { name?: string; arguments?: string }
}

function ToolCallCard({ tc }: { tc: ToolCallRaw }) {
  const name = tc.function?.name ?? '(unknown)'
  const args = prettyJson(tc.function?.arguments ?? '{}')
  return (
    <div style={{
      borderRadius: 4,
      border: '1px solid rgba(251,191,36,0.25)',
      background: 'rgba(251,191,36,0.05)',
      padding: '7px 10px',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', marginBottom: 5, letterSpacing: 0.5 }}>
        ƒ {name}
        {tc.id && <span style={{ color: '#6b7280', fontWeight: 400, marginLeft: 8, fontSize: 10 }}>{tc.id}</span>}
      </div>
      <pre style={preStyle('#d97706')}>{args}</pre>
    </div>
  )
}

// ── 公用 pre 样式（宽度受控） ──

const preStyle = (color = '#d1d5db'): React.CSSProperties => ({
  margin: 0,
  fontSize: 11.5,
  lineHeight: 1.65,
  color,
  fontFamily: 'Consolas, "Courier New", monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
  // 关键：pre 在 flex/block 容器里必须有 width:100% 才不会溢出
  width: '100%',
  boxSizing: 'border-box' as const,
})

// ── 单条消息块 ──

function MessageBlock({
  msg, index,
}: {
  msg: ApiRequestSnapshot['messages'][number]
  index: number
}) {
  const isSystem = msg.role === 'system'
  const [open, setOpen] = useState(!isSystem)   // system 默认折叠
  const cfg = getRoleCfg(msg.role)

  const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  const text = msg.content ?? ''

  // 折叠时的预览文字
  const preview = hasToolCalls
    ? `[工具调用 × ${(msg.tool_calls as unknown[]).length}]`
    : text.slice(0, 100).replace(/\n+/g, ' ↵ ')

  return (
    <div style={{
      borderRadius: 6,
      border: `1px solid ${cfg.color}28`,
      background: `${cfg.color}08`,
      // 宽度受控：不能用 flex item 的默认 min-width:auto
      width: '100%',
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}>
      {/* 消息头（点击展开/折叠） */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px',
          cursor: 'pointer', userSelect: 'none',
          borderBottom: open ? `1px solid ${cfg.color}18` : 'none',
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, color: cfg.color, letterSpacing: 0.8, flexShrink: 0 }}>
          [{index}] {cfg.label}
        </span>
        {msg.tool_call_id && (
          <span style={{ fontSize: 10, color: '#6b7280', flexShrink: 0 }}>
            ← {msg.tool_call_id.slice(0, 24)}
          </span>
        )}
        {!open && (
          <span style={{
            fontSize: 10, color: '#6b7280',
            flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {preview}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: '#4b5563', flexShrink: 0 }}>
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </div>

      {/* 消息内容 */}
      {open && (
        <div style={{ padding: '10px 10px', display: 'flex', flexDirection: 'column', gap: 8, width: '100%', boxSizing: 'border-box' }}>
          {text && <pre style={preStyle()}>{text}</pre>}
          {hasToolCalls && (msg.tool_calls as ToolCallRaw[]).map((tc, i) => (
            <ToolCallCard key={i} tc={tc} />
          ))}
          {!text && !hasToolCalls && (
            <span style={{ fontSize: 11, color: '#4b5563', fontStyle: 'italic' }}>(空)</span>
          )}
        </div>
      )}
    </div>
  )
}

// ── 主组件 ──

export default function DebugRequestModal({ snapshots, onClose }: Props) {
  const [activeIdx, setActiveIdx] = useState(0)
  if (snapshots.length === 0) return null

  const snap = snapshots[Math.min(activeIdx, snapshots.length - 1)]
  const systemMsg = snap.messages.find(m => m.role === 'system')
  const otherMsgs = snap.messages.filter(m => m.role !== 'system')

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#0c0c0c',
          border: '1px solid #242424',
          borderRadius: 10,
          width: '82vw', maxWidth: 860,
          height: '80vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 80px rgba(0,0,0,0.8)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderBottom: '1px solid #1c1c1c', flexShrink: 0 }}>
          <span style={{ color: '#34d399', fontWeight: 700, fontSize: 11, letterSpacing: 0.8 }}>AI 请求内容</span>
          <span style={{ fontSize: 10, color: '#4b5563' }}>{snap.model}</span>
          <span style={{ fontSize: 10, color: '#374151' }}>max_tokens {snap.maxTokens}</span>
          <span style={{ fontSize: 10, color: '#374151' }}>{snap.messages.length} 条消息</span>
          {snap.tools && <span style={{ fontSize: 10, color: '#374151' }}>{snap.tools.length} 个工具</span>}
          <span style={{ fontSize: 10, color: '#1f2937' }}>{snap.timestamp.slice(11, 19)}</span>
          <div style={{ flex: 1 }} />
          {snapshots.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button style={navBtnStyle} onClick={() => setActiveIdx(i => Math.max(0, i - 1))} disabled={activeIdx === 0}>
                <ChevronLeft size={12} />
              </button>
              <span style={{ fontSize: 10, color: '#6b7280', minWidth: 68, textAlign: 'center' }}>
                第 {activeIdx + 1}/{snapshots.length} 次调用
              </span>
              <button style={navBtnStyle} onClick={() => setActiveIdx(i => Math.min(snapshots.length - 1, i + 1))} disabled={activeIdx === snapshots.length - 1}>
                <ChevronRight size={12} />
              </button>
            </div>
          )}
          <button style={navBtnStyle} onClick={onClose}><X size={14} /></button>
        </div>

        {/* 说明 */}
        <div style={{ padding: '4px 14px', fontSize: 10, color: '#374151', borderBottom: '1px solid #161616', flexShrink: 0 }}>
          OpenAI 格式 → 换行符已还原为真实换行，工具调用参数已格式化，点击消息头可折叠
        </div>

        {/* 消息列表：用 block 布局避免 flex min-width 溢出问题 */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '12px 14px' }}>
          {systemMsg && (
            <div style={{ marginBottom: 8 }}>
              <MessageBlock msg={systemMsg} index={0} />
            </div>
          )}
          {otherMsgs.map((msg, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <MessageBlock msg={msg} index={systemMsg ? i + 1 : i} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const navBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#6b7280',
  cursor: 'pointer', padding: 2, lineHeight: 1,
  display: 'flex', alignItems: 'center',
}
