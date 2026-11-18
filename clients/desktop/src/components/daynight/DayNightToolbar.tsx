// ══════════════════════════════════════════════
// 昼夜表工具条（钛合金 × 冷光全息）
//   左：数据源（应用 / 哔哩哔哩）；右：记录 / 计划两个键 + 撤回 / 恢复
//   段选是下沉黑玻璃槽里的一排键，选中的那格凸起并亮灯；底边一道冰蓝光线收口
//   记录 / 计划是开关键：按亮 = 开始涂这一层（右边栏跟着打开），再按一下暗掉 = 退出；两个键最多亮一个
// ══════════════════════════════════════════════

import { Undo2, Redo2 } from 'lucide-react'
import Tooltip from '../Tooltip'
import IconButton from '../ui/IconButton'
import Segmented from '../ui/Segmented'
import { theme, ti } from '../../theme'
import type { RecordLayer } from '../../types'

type TrackMode = 'apps' | 'bili'

export default function DayNightToolbar({
  trackMode, onTrackModeChange, appLabel,
  recordLayer, onRecordLayerChange,
  editMode, onToggleEdit, canUndo, canRedo, onUndo, onRedo,
}: {
  trackMode: TrackMode
  onTrackModeChange?: (mode: TrackMode) => void
  appLabel: string
  recordLayer: RecordLayer
  onRecordLayerChange: (layer: RecordLayer) => void
  editMode: boolean
  onToggleEdit: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}) {
  const layers = [
    { value: 'actual', label: '记录', name: '实际记录', led: ti.ok },
    { value: 'plan', label: '计划', name: '计划安排', led: theme.warningOrange },
  ] as const
  const pressLayer = (layer: RecordLayer) => {
    if (editMode && recordLayer === layer) {
      onToggleEdit()
      return
    }
    if (recordLayer !== layer) onRecordLayerChange(layer)
    if (!editMode) onToggleEdit()
  }
  const labelStyle = { fontSize: 11, color: theme.paperMuted, letterSpacing: '0.2em', whiteSpace: 'nowrap' } as const

  return (
    <div style={{
      position: 'relative',
      display: 'flex', alignItems: 'center', gap: 10,
      height: 30, padding: '0 8px 0 12px',
      flexShrink: 0,
      background: 'linear-gradient(180deg, rgba(158,216,242,0.055), rgba(158,216,242,0))',
    }}>
      <span style={labelStyle}>数据源</span>
      <Segmented<TrackMode>
        value={trackMode}
        onChange={(m) => onTrackModeChange?.(m)}
        options={[
          { value: 'apps', label: appLabel, led: ti.sys, tip: '管道显示电脑上用过的应用' },
          { value: 'bili', label: '哔哩哔哩', led: '#FB7299', tip: '管道显示 B 站观看记录' },
        ]}
      />

      <span style={{ flex: 1 }} />

      <div className="ti-well" style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 5 }}>
        {layers.map((o) => {
          const lit = editMode && recordLayer === o.value
          return (
            <Tooltip key={o.value} content={lit ? `退出${o.name}编辑 (Ctrl+E)` : `编辑${o.name}`}>
              <button
                type="button"
                className="dn-seg"
                aria-pressed={lit}
                onClick={() => pressLayer(o.value)}
                style={{
                  height: 22, padding: '0 11px',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 12.5, fontWeight: lit ? 900 : 600, borderRadius: 4,
                  border: 'none', cursor: 'pointer',
                  color: lit ? '#140A04' : theme.paperDim,
                  background: lit
                    ? `linear-gradient(180deg, rgba(255,255,255,0.38), rgba(255,255,255,0) 65%), ${o.led}`
                    : 'transparent',
                  boxShadow: lit ? `0 0 0 1px #080807, 0 0 10px ${o.led}55` : 'none',
                }}
              >
                <span aria-hidden style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: lit ? '#140A04' : o.led,
                  opacity: lit ? 1 : 0.8,
                  animation: lit ? 'glowPulse 1.2s ease-in-out infinite' : undefined,
                }} />
                {o.label}
              </button>
            </Tooltip>
          )
        })}
      </div>

      <div className="ti-groove-v" style={{ height: 18, alignSelf: 'center' }} />

      <IconButton tip="撤回 (Ctrl+Z)" onClick={onUndo} disabled={!editMode || !canUndo} size={24}>
        <Undo2 size={13} />
      </IconButton>
      <IconButton tip="恢复 (Ctrl+Y)" onClick={onRedo} disabled={!editMode || !canRedo} size={24}>
        <Redo2 size={13} />
      </IconButton>

      <div className="ti-groove-h" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }} />
    </div>
  )
}
