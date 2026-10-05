// ══════════════════════════════════════════════
// OmniDebugModal — 查看发给 Omni 实时会话的上下文
// ══════════════════════════════════════════════

import { useState } from 'react'
import { X, ChevronDown, ChevronUp } from 'lucide-react'
import type { OmniDebugInfo } from '../App'
import { theme, hud, ti, tiSurface, tiTitle } from '../theme'

interface Props {
  info: OmniDebugInfo
  onClose: () => void
}

const preStyle: React.CSSProperties = {
  margin: 0, fontSize: 11.5, lineHeight: 1.65,
  color: theme.textPrimary,
  fontFamily: 'Consolas, "Courier New", monospace',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word',
  width: '100%', boxSizing: 'border-box',
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
      background: tiSurface.well,
      boxShadow: `${tiSurface.wellShadow}, inset 3px 0 0 ${color}`,
      overflow: 'hidden',
      marginBottom: 10,
    }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: 0.8 }}>{label}</span>
        {!open && preview && (
          <span style={{ fontSize: 10.5, color: theme.textMuted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {preview}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: theme.textSecondary }}>
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
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'radial-gradient(ellipse at center, rgba(12,11,9,0.65) 0%, rgba(0,0,0,0.85) 100%)',
        backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'relative',
          padding: 1,
          width: '82vw', maxWidth: 860,
          height: '80vh',
          filter: 'drop-shadow(0 24px 50px rgba(0,0,0,0.8))',
        }}
        onClick={e => e.stopPropagation()}
      >
      <div
        style={{
          position: 'relative',
          width: '100%', height: '100%',
          background: tiSurface.plate,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          clipPath: hud.chamfer12, WebkitClipPath: hud.chamfer12,
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 18px 10px',
          flexShrink: 0,
        }}>
          <span className="ti-diamond" aria-hidden />
          <span style={{ ...tiTitle, fontSize: 14 }}>Omni 上下文调试</span>
          <span style={{ fontSize: 11, color: theme.textSecondary, fontFamily: theme.fontMono }}>{info.model}</span>
          {info.voice && <span style={{ fontSize: 11, color: theme.textMuted }}>音色 {info.voice}</span>}
          <span className="ti-well" style={{ padding: '2px 7px', borderRadius: 4 }}>
            <span className="ti-led" style={{ fontSize: 11 }}>{info.ts.slice(11, 19)}</span>
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="ti-key" style={{ width: 28, height: 28 }} onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>
        <div className="ti-groove-h" style={{ margin: '0 18px', flexShrink: 0 }} />

        <div style={{ padding: '6px 18px', fontSize: 11, color: theme.textMuted, flexShrink: 0 }}>
          每次发起对话时捕获 · Instructions = session.update 的 instructions 字段
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '12px 14px' }}>

          {/* Instructions */}
          <CollapsibleSection
            label="系统指令"
            color={ti.sys}
            preview={info.systemPrompt.slice(0, 100).replace(/\n+/g, ' ↵ ')}
          >
            <pre style={preStyle}>{info.systemPrompt}</pre>
          </CollapsibleSection>

          {/* Sent Items */}
          <div className="ti-label" style={{ fontSize: 11, marginBottom: 8 }}>
            本轮发送给 AI（{info.items.length} 条）
          </div>

          {info.items.length === 0 && (
            <span style={{ fontSize: 11, color: theme.textMuted }}>（无）</span>
          )}

          {info.items.map((item, i) => (
            <div key={i} style={{
              borderRadius: 6,
              background: tiSurface.well,
              boxShadow: `${tiSurface.wellShadow}, inset 3px 0 0 ${item.type === 'text' ? ti.led : ti.sys}`,
              padding: '8px 10px 8px 13px',
              marginBottom: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: item.type === 'text' ? ti.led : ti.sys, letterSpacing: 0.8 }}>
                  {item.type === 'text' ? '文字' : '语音'}
                </span>
                <span style={{ fontSize: 10.5, color: theme.textMuted, fontFamily: theme.fontMono }}>{item.ts.slice(11, 19)}</span>
                {item.type === 'audio' && item.durationMs !== undefined && (
                  <span style={{ fontSize: 10.5, color: theme.textSecondary, fontFamily: theme.fontMono }}>{(item.durationMs / 1000).toFixed(1)}s</span>
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
