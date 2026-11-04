// ══════════════════════════════════════════════
// 协议志：协议（白名单锁机，开局后只放行名单里的应用 / 网站）/ 专注锁（屏蔽组：按时长屏蔽网站和应用）/
//         清单（滴答清单式的任务树）/ 动机云（动机长出行动的蓝图）
//   面板标题「协议志」已在主面板凸台上，这里只放视图切换。
//   动机云逐帧跑膜模拟，不在它那页时卸载，省 CPU / 内存。
//   专注锁不卸载、只隐藏：屏蔽组的定时到期在它里面每秒检查，卸载了就到点解不了锁。
// ══════════════════════════════════════════════

import { useState } from 'react'
import type { ActivityPalette } from '../../types'
import type { PerceptionSpan } from '../../lib/local-api'
import FocusPanel from '../FocusPanel'
import { theme, ti } from '../../theme'
import Segmented from '../ui/Segmented'
import MotiveCloud from '../motive-cloud/MotiveCloud'
import ChecklistView from './checklist/ChecklistView'
import LockView from './lock/LockView'

type ProtocolSubview = 'lock' | 'focus' | 'checklist' | 'motives'
const SUBVIEWS: readonly ProtocolSubview[] = ['lock', 'focus', 'checklist', 'motives']

const SUBVIEW_KEY = 'slu.protocol.subview'

function loadSubview(): ProtocolSubview {
  try {
    const saved = localStorage.getItem(SUBVIEW_KEY)
    return SUBVIEWS.find((v) => v === saved) ?? 'checklist'
  } catch {
    return 'checklist'
  }
}

export interface ProtocolViewProps {
  readonly palette: ActivityPalette
  readonly onPaletteChange: () => void
  readonly onPlanNodesChange?: () => void
  /** 专注锁：应用规则从昼夜表的全天应用轨道里挑 */
  readonly selectedDate: Date
  readonly perceptionSpans: PerceptionSpan[]
}

export default function ProtocolView(props: ProtocolViewProps) {
  const [subview, setSubview] = useState<ProtocolSubview>(loadSubview)

  const change = (v: ProtocolSubview) => {
    setSubview(v)
    try { localStorage.setItem(SUBVIEW_KEY, v) } catch { /* 本机存不了就算了 */ }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: theme.textPrimary, fontFamily: theme.fontBody }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 30, flexShrink: 0, padding: '0 12px',
        position: 'relative', zIndex: 2,
        background: 'linear-gradient(180deg, rgba(158,216,242,0.055), rgba(158,216,242,0))',
      }}>
        <span style={{ fontSize: 11, color: theme.textMuted, letterSpacing: '0.2em', whiteSpace: 'nowrap' }}>视图</span>
        <Segmented<ProtocolSubview>
          value={subview}
          onChange={change}
          options={[
            { value: 'lock', label: '协议', led: ti.led, tip: '每份协议一份白名单：开局后只放行名单里的应用和网站' },
            { value: 'focus', label: '专注锁', led: ti.led, tip: '屏蔽组：按时长屏蔽一批网站和应用（不开局也能用）' },
            { value: 'checklist', label: '清单', led: ti.led, tip: '任务清单：多层清单 + 无限子任务，和昼夜表的计划是同一份' },
            { value: 'motives', label: '动机云', led: ti.sys, tip: '动机长出行动方向的蓝图' },
          ]}
        />
        <div className="ti-groove-h" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {subview === 'lock' && <LockView />}
        <div style={{ position: 'absolute', inset: 0, display: subview === 'focus' ? 'flex' : 'none' }}>
          <FocusPanel selectedDate={props.selectedDate} perceptionSpans={props.perceptionSpans} />
        </div>
        {subview === 'checklist' && (
          <ChecklistView palette={props.palette} onPaletteChange={props.onPaletteChange} onPlanNodesChange={props.onPlanNodesChange} />
        )}
        {subview === 'motives' && <MotiveCloud />}
      </div>
    </div>
  )
}
