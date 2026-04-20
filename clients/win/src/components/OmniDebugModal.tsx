// ══════════════════════════════════════════════
// OmniDebugModal — 查看发给 Omni 实时会话的上下文
// ══════════════════════════════════════════════

import { useState } from 'react'
import { X, ChevronDown, ChevronUp } from 'lucide-react'
import type { OmniDebugInfo } from '../App'
import { theme, hud } from '../theme'
import { HudFrame } from './hud'

interface Props {
  info: OmniDebugInfo
  onClose: () => void
}

const preStyle: React.CSSProperties = {
  margin: 0, fontSize: 11.5, lineHeight: 1.65,
  color: '#d1d5db',
  fontFamily: 'Consolas, "Courier New", monospace',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word',
  width: '100%', boxSizing: 'border-box',
}

const btnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#6b7280',
  cursor: 'pointer', padding: 2, lineHeight: 1,
  display: 'flex', alignItems: 'center',
}

function CollapsibleSection({
  label, color, defaultOpen, preview, children,
}: {
  label: string
  color: string
  defaultOpen?: boolean
  preview?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div style={{
      borderRadius: 6,
      border: `1px solid ${color}28`,
      background: `${color}08`,
      overflow: 'hidden',
      marginBottom: 10,
    }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: 0.8 }}>{label}</span>
        {!open && preview && (
          <span style={{ fontSize: 10, color: '#4b5563', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {preview}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: '#4b5563' }}>
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </div>
      {open && (
        <div style={{ padding: '0 10px 10px', width: '100%', boxSizing: 'border-box' }}>
          {children}
        </div>
      )}
    </div>
  )
}

export default function OmniDebugModal({ info, onClose }: Props) {
  const accent = '#a78bfa'
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'radial-gradient(ellipse at center, rgba(8,0,24,0.65) 0%, rgba(0,0,0,0.85) 100%)',
        backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      {/* HUD 外框 */}
      <div
        style={{
          position: 'relative',
          padding: 1,
          width: '82vw', maxWidth: 860,
          height: '80vh',
          background: `linear-gradient(135deg, ${accent}AA 0%, ${theme.shadowPurple}77 50%, ${accent}44 100%)`,
          clipPath: hud.chamfer12, WebkitClipPath: hud.chamfer12,
          boxShadow: `0 24px 80px rgba(0,0,0,0.8), 0 0 30px ${accent}33`,
        }}
        onClick={e => e.stopPropagation()}
      >
      <div
        style={{
          position: 'relative',
          width: '100%', height: '100%',
          background: theme.hudFillDeep,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          clipPath: hud.chamfer12, WebkitClipPath: hud.chamfer12,
        }}
      >
        <div className="hud-scanlines" />
        <HudFrame
          color={accent}
          accent={theme.dangerRed}
          topLabel="OMNI-CTX"
          bottomLabel={info.model.toUpperCase().slice(0, 14)}
          showNotchTop
          showNotchBottom
          showConnectors
          notchWidth={64}
          notchDepth={7}
          cornerSize={14}
        />
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 18px', borderBottom: `1px solid ${accent}33`,
          background: `linear-gradient(90deg, ${accent}10 0%, transparent 100%)`,
          flexShrink: 0,
        }}>
          <span style={{
            color: accent, fontWeight: 700, fontSize: 12,
            letterSpacing: 2, fontFamily: theme.fontDisplay,
            textShadow: `0 0 10px ${accent}AA, 0 0 20px ${accent}44`,
          }}>OMNI 上下文调试</span>
          <span style={{ fontSize: 10, color: '#6b7280' }}>{info.model}</span>
          {info.voice && <span style={{ fontSize: 10, color: '#374151' }}>音色 {info.voice}</span>}
          <span style={{ fontSize: 10, color: '#1f2937' }}>{info.ts.slice(11, 19)}</span>
          <div style={{ flex: 1 }} />
          <button style={btnStyle} onClick={onClose}><X size={14} /></button>
        </div>

        <div style={{ padding: '4px 14px', fontSize: 10, color: '#374151', borderBottom: '1px solid #161616', flexShrink: 0 }}>
          每次发起对话时捕获 · Instructions = session.update 的 instructions 字段
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '12px 14px' }}>

          {/* Instructions */}
          <CollapsibleSection
            label="INSTRUCTIONS"
            color="#a78bfa"
            preview={info.systemPrompt.slice(0, 100).replace(/\n+/g, ' ↵ ')}
          >
            <pre style={preStyle}>{info.systemPrompt}</pre>
          </CollapsibleSection>

          {/* Sent Items */}
          <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 700, letterSpacing: 0.8, marginBottom: 8 }}>
            本轮发送给 AI（{info.items.length} 条）
          </div>

          {info.items.length === 0 && (
            <span style={{ fontSize: 11, color: '#374151', fontStyle: 'italic' }}>（无）</span>
          )}

          {info.items.map((item, i) => (
            <div key={i} style={{
              borderRadius: 6,
              border: '1px solid rgba(126,202,255,0.2)',
              background: 'rgba(126,202,255,0.04)',
              padding: '8px 10px',
              marginBottom: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#7ecaff', letterSpacing: 0.8 }}>
                  {item.type === 'text' ? 'TEXT' : 'AUDIO'}
                </span>
                <span style={{ fontSize: 10, color: '#374151' }}>{item.ts.slice(11, 19)}</span>
                {item.type === 'audio' && item.durationMs !== undefined && (
                  <span style={{ fontSize: 10, color: '#6b7280' }}>{(item.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
              {item.type === 'text' && (
                <pre style={preStyle}>{item.content}</pre>
              )}
              {item.type === 'audio' && item.wavBase64 && (
                <audio
                  controls
                  src={`data:audio/wav;base64,${item.wavBase64}`}
                  style={{ width: '100%', height: 32 }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  )
}
