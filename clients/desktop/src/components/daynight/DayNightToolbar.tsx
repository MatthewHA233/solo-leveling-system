// ══════════════════════════════════════════════
// 昼夜表工具条（钛合金 × 冷光全息）
//   左：数据源（应用 / 哔哩哔哩）；右：记录层（实际 / 计划）+ 记录键 + 撤回 / 恢复
//   段选是下沉黑玻璃槽里的一排键，选中的那格凸起并亮灯；底边一道冰蓝光线收口
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
  const layerColor = recordLayer === 'plan' ? theme.warningOrange : ti.ok
  const layerName = recordLayer === 'plan' ? '计划安排' : '实际记录'
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

      <span style={labelStyle}>记录层</span>
      <Segmented<RecordLayer>
        value={recordLayer}
        onChange={onRecordLayerChange}
        options={[
          { value: 'actual', label: '实际', led: ti.ok, tip: '实际记录：真实做了什么' },
          { value: 'plan', label: '计划', led: theme.warningOrange, tip: '计划安排：打算做什么' },
        ]}
      />

      <div className="ti-groove-v" style={{ height: 18, alignSelf: 'center' }} />

      <Tooltip content={editMode ? `退出${layerName}编辑 (Ctrl+E)` : `编辑${layerName} (Ctrl+E)`}>
        <button
          type="button"
          className="ti-key ti-key-primary"
          aria-pressed={editMode}
          onClick={onToggleEdit}
          style={{
            height: 24, padding: '0 13px', gap: 7, fontSize: 12.5,
            // 记录中：整块换成当前记录层的语义色（实际 = 绿 / 计划 = 琥珀），一眼知道在涂哪一层
            ...(editMode ? { background: `linear-gradient(180deg, rgba(255,255,255,0.38), rgba(255,255,255,0) 65%), ${layerColor}` } : null),
          }}
        >
          <span aria-hidden style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#140A04',
            animation: editMode ? 'glowPulse 1.2s ease-in-out infinite' : undefined,
          }} />
          {editMode ? '记录中' : '记录'}
        </button>
      </Tooltip>
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
