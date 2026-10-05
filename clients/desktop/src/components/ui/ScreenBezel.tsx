// ══════════════════════════════════════════════
// 主面板：一圈钛板把一个视图嵌成一块黑玻璃屏（每个视图各一块，App 里叠成一摞做空间位移）
//   钛板切成手绘框那种轮廓：视图名处凸台、中段下沉、读数处塔楼（见 ChassisPlate）
//   框顶一行铭文：左 = 冰蓝菱形灯 + 视图名；右 = 散热格栅 + 此刻时间（冰蓝 LED）——左右同色对称
//   屏是冷光投影面（.ti-holo-screen：顶沿冰蓝光 + 刻度 + 蜂巢微纹）
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'
import type { MainViewMode } from '../ViewSwitcher'
import ChassisPlate from './ChassisPlate'

const NAMES: Record<MainViewMode, string> = {
  motivation: '协议志',
  motivation_static: '协议志 · 静态示范',
  daynight: '昼夜表',
  torrent: '洪流域',
  torrent_static: '洪流域 · 静态示范',
  focus: '专注锁',
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时间读数：15 秒刷一次，只重渲染自己 */
function LedClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="ti-led" style={{ fontSize: 14, color: 'var(--ti-ice-hi)', textShadow: '0 0 7px rgba(150,215,245,0.6)' }}>
      {pad2(now.getHours())}:{pad2(now.getMinutes())}
    </span>
  )
}

export default function ScreenBezel({ view, children }: {
  view: MainViewMode
  children: React.ReactNode
}) {
  return (
    <ChassisPlate
      notch
      dipDepth={10}
      accents="symmetric"
      ornaments
      className="ti-plate"
      outerStyle={{ flex: 1, minWidth: 0 }}
      // 屏幕外圈唇边占 2px：板的内边距各让出 2px，屏幕尺寸不变（昼夜表按高度排布，不能动它的可用高度）
      style={{ display: 'flex', flexDirection: 'column', padding: '24px 5px 5px' }}
    >
      <div style={{
        position: 'absolute', top: 0, left: 16, right: 16, height: 26,
        display: 'flex', alignItems: 'center', gap: 10,
        pointerEvents: 'none', userSelect: 'none', zIndex: 2,
      }}>
        <span data-chassis-tab style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ti-diamond" aria-hidden />
          <span style={{ fontSize: 14, fontWeight: 900, fontStyle: 'italic', letterSpacing: '0.12em', color: 'var(--ti-text)' }}>{NAMES[view]}</span>
        </span>
        <span style={{ flex: 1 }} />
        <span data-chassis-tower style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ti-vents" aria-hidden style={{ width: 38 }} />
          <span className="ti-well" style={{ display: 'inline-flex', alignItems: 'center', height: 19, padding: '0 7px', borderRadius: 4 }}>
            <LedClock />
          </span>
        </span>
      </div>
      <div className="ti-screen-rim" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div className="ti-screen ti-holo-screen" style={{ flex: 1, minHeight: 0 }}>
          <div style={{ position: 'absolute', inset: 0 }}>{children}</div>
        </div>
      </div>
    </ChassisPlate>
  )
}
