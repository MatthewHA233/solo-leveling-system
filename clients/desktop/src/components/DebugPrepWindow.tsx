// ══════════════════════════════════════════════
// DebugPrepWindow — PrepOverlay 调试沙箱
//
// 入口：http://localhost:5172/#debug-prep
//   - 把 overlay 放进 16:9 框里，避免它满屏
//   - 顶部按钮切 phase / 切 encoder
//   - 边写边热更新，不需要走 ffmpeg
// ══════════════════════════════════════════════

import { useState } from 'react'
import PrepOverlay, { type PrepPhase } from './PrepOverlay'

const ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libopenh264']

export default function DebugPrepWindow() {
  const [phase, setPhase] = useState<PrepPhase>('encoding')
  const [encoder, setEncoder] = useState<string | null>('h264_qsv')
  const [width, setWidth] = useState(720)

  return (
    <div style={{
      minHeight: '100vh',
      background: '#050810',
      color: '#cfd6e4',
      fontFamily: '"JetBrains Mono", monospace',
      padding: 24,
      display: 'flex', flexDirection: 'column', gap: 16,
    }}>
      <div style={{ fontSize: 13, letterSpacing: 2, color: '#7DF9FF' }}>
        DEBUG · PrepOverlay 沙箱
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>phase:</span>
        {(['probe', 'encoding', 'done', 'error'] as PrepPhase[]).map((p) => (
          <DebugBtn key={p} active={phase === p} onClick={() => setPhase(p)}>{p}</DebugBtn>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>encoder:</span>
        <DebugBtn active={encoder === null} onClick={() => setEncoder(null)}>null</DebugBtn>
        {ENCODERS.map((e) => (
          <DebugBtn key={e} active={encoder === e} onClick={() => setEncoder(e)}>{e}</DebugBtn>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>width:</span>
        <input
          type="range" min={320} max={1200} step={10}
          value={width} onChange={(e) => setWidth(Number(e.target.value))}
          style={{ width: 240 }}
        />
        <span style={{ fontSize: 11, opacity: 0.7 }}>{width}px</span>
      </div>

      <div style={{
        marginTop: 16,
        width, aspectRatio: '16 / 9',
        position: 'relative',
        background: '#000',
        border: '1px solid rgba(125,249,255,0.25)',
        boxShadow: '0 0 30px rgba(125,249,255,0.08)',
      }}>
        <PrepOverlay phase={phase} encoder={encoder} />
      </div>

      <div style={{ marginTop: 'auto', fontSize: 10, opacity: 0.5 }}>
        改 PrepOverlay.tsx → Vite 自动热更新
      </div>
    </div>
  )
}

function DebugBtn({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px',
      fontSize: 11,
      fontFamily: 'inherit',
      letterSpacing: 1,
      background: active ? 'rgba(125,249,255,0.18)' : 'rgba(125,249,255,0.04)',
      color: active ? '#7DF9FF' : '#8a93a3',
      border: `1px solid ${active ? '#7DF9FFAA' : 'rgba(125,249,255,0.2)'}`,
      cursor: 'pointer',
      borderRadius: 2,
    }}>
      {children}
    </button>
  )
}
