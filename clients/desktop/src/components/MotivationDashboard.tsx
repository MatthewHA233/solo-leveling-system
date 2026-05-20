// ══════════════════════════════════════════════
// MotivationDashboard — 动机仪表盘（占位 stub，待开发）
//
//   只是给 ViewSwitcher 提供一个挂载点，让主舞台 tab 切换跑通。
//   真正的设计内容（重要/紧急动机分类、猎人评级、配额、Fairy 笔记等）后续单独提交。
// ══════════════════════════════════════════════

import { theme } from '../theme'
import { HudFrameSkeleton, CornerArt } from './hud'

const TABS_HEIGHT = 30
const FRAME_LEFT_PAD = 24

export default function MotivationDashboard() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: theme.background,
      position: 'relative',
      paddingLeft: FRAME_LEFT_PAD,
      fontFamily: theme.fontBody,
    }}>
      <div style={{
        height: TABS_HEIGHT,
        flexShrink: 0,
        display: 'flex', alignItems: 'flex-end',
        paddingLeft: 12, paddingBottom: 4,
        gap: 10,
      }}>
        <span style={{
          fontFamily: theme.fontBody,
          fontSize: 12, fontWeight: 600,
          color: theme.textPrimary,
          letterSpacing: 0.4,
          paddingLeft: 12,
        }}>
          动机仪表盘
        </span>
        <span style={{ fontSize: 11, color: theme.textMuted }}>
          待开发
        </span>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <HudFrameSkeleton />
        <CornerArt position="tl" />
        <CornerArt position="tr" />
        <CornerArt position="bl" />
        <CornerArt position="br" />
      </div>
    </div>
  )
}
