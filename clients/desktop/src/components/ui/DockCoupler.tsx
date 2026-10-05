// ══════════════════════════════════════════════
// 联结卡扣：侧抽屉（历史会话）和右侧通讯栏之间的一对钛合金锁栓
//   抽屉从通讯栏背后滑出 → 两颗橙色锁栓越过接缝插进抽屉边上的锁槽 → 指示灯亮；
//   收起时倒放：先退栓灭灯，再把抽屉收回去。两块板看起来是锁在一起的一台机器。
// 动画都在 styles/titanium.css 的「联结卡扣」一节，这里只摆零件
// ══════════════════════════════════════════════

import { useEffect, useLayoutEffect, useState } from 'react'

export type DockPhase = 'open' | 'closing'

/** 接缝位置（视口坐标）：抽屉贴着它的左边，卡扣骑在它上面 */
export interface DockAnchor {
  readonly seamX: number
  readonly top: number
  readonly height: number
}

/** 收起动画总时长：退栓 + 抽屉缩回，过后才卸载 */
export const DOCK_EXIT_MS = 380

/** 打开立即挂载；关闭先进 closing 播完收起动画再卸载 */
export function useDockPresence(open: boolean): { mounted: boolean; phase: DockPhase } {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) { setMounted(true); return }
    if (!mounted) return
    const t = window.setTimeout(() => setMounted(false), DOCK_EXIT_MS)
    return () => window.clearTimeout(t)
  }, [open, mounted])
  return { mounted: open || mounted, phase: open ? 'open' : 'closing' }
}

/** 量出宿主面板的左边缘（拖拽改宽、窗口缩放都跟着走） */
export function useDockAnchor(selector: string): DockAnchor | null {
  const [anchor, setAnchor] = useState<DockAnchor | null>(null)
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      const next = { seamX: Math.round(r.left), top: Math.round(r.top), height: Math.round(r.height) }
      setAnchor((prev) => (prev && prev.seamX === next.seamX && prev.top === next.top && prev.height === next.height ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [selector])
  return anchor
}

/** 卡扣容器相对接缝往左伸出的宽度（锁槽落在抽屉这一侧） */
const REACH = 20
/** 两颗锁栓的高度位置：上下对称，避开通讯栏侧脊顶部的铭文和底部的灯柱 */
const LATCH_AT = [0.3, 0.7] as const

export default function DockCoupler({ anchor, phase }: { anchor: DockAnchor; phase: DockPhase }) {
  return (
    <div
      aria-hidden
      className="dock-coupler"
      data-phase={phase}
      style={{
        position: 'fixed',
        left: anchor.seamX - REACH,
        top: anchor.top,
        width: REACH + 24,
        height: anchor.height,
        pointerEvents: 'none',
        zIndex: 101,
      }}
    >
      {LATCH_AT.map((at, i) => (
        <Latch key={at} y={Math.round(anchor.height * at)} order={i} />
      ))}
    </div>
  )
}

/**
 * 一颗锁栓（以接缝 x = REACH 为界）：
 *   左：抽屉边上的下沉锁槽
 *   右：骑在通讯栏侧脊上的钛合金栓座（两颗螺丝 + 指示灯）
 *   中：阳极氧化橙的栓舌，锁定时从栓座里推出、越过接缝插进锁槽
 */
function Latch({ y, order }: { y: number; order: number }) {
  return (
    <div
      className="dock-latch"
      style={{ position: 'absolute', left: 0, top: y - 16, width: REACH + 24, height: 32, ['--latch-i' as string]: order }}
    >
      <span className="dock-latch-slot" style={{ left: REACH - 14, top: 11 }} />
      <span className="dock-latch-housing" style={{ left: REACH, top: 0 }}>
        <span className="dock-latch-screw" style={{ left: 7, top: 3 }} />
        <span className="dock-latch-screw" style={{ left: 7, bottom: 3 }} />
        <span className="dock-latch-led" />
      </span>
      <span className="dock-latch-bolt" style={{ left: REACH + 1, top: 13 }}>
        <span className="dock-latch-flash" />
      </span>
    </div>
  )
}
