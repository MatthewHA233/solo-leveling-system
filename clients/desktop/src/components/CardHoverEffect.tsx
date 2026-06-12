// ══════════════════════════════════════════════
// CardHoverEffect — 悬浮高亮垫片（机制移植自 Aceternity UI card-hover-effect）
//   · 核心机制：motion 的 layoutId 共享元素 —— 同一 layoutId 的高亮层
//     在卡片间「滑动跟随」，离开时延迟 0.2s 淡出，移入相邻卡片时自然过渡
//   · 视觉换成本项目的科幻 HUD「目标锁定框」：四角括号 + 青色微填充 + 细描边 + 柔光
//   · 原版是 Tailwind + 整列表组件；这里适配成单卡 wrapper（inline style 体系，
//     卡片种类不一，由父级持有 hovered 状态逐卡包裹）
// ══════════════════════════════════════════════

import { AnimatePresence, motion } from 'motion/react'
import type { CSSProperties, ReactNode } from 'react'
import { theme } from '../theme'

// ── 可调旋钮 ──────────────────────────────────
const CORNER_SIZE = 13      // 角括号边长
const CORNER_THICK = 1.5    // 角括号线宽
const FRAME_RADIUS = 8      // 锁定框圆角（偏小保持 HUD 棱角感）

interface Props {
  /** 当前卡是否被锁定（父级共享一个 hovered id，垫片才能跨卡滑动） */
  readonly active: boolean
  readonly onEnter: () => void
  /** 不传 = 粘性锁定：移开鼠标不熄灭，直到锁定别的卡或父级卸载 */
  readonly onLeave?: () => void
  /** 同一组卡片用同一 layoutId，垫片在组内滑动 */
  readonly layoutId: string
  /** 垫片溢出卡片边缘的内距（原版 p-2 的语义） */
  readonly pad?: number
  readonly children: ReactNode
}

/** 四角括号：HUD 目标锁定语义（只描两条边的 L 形） */
function cornerStyle(pos: 'tl' | 'tr' | 'bl' | 'br'): CSSProperties {
  const base: CSSProperties = {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderColor: `${theme.flameTeal}cc`,
    borderStyle: 'solid',
    borderWidth: 0,
    pointerEvents: 'none',
  }
  switch (pos) {
    case 'tl': return { ...base, top: -1, left: -1, borderTopWidth: CORNER_THICK, borderLeftWidth: CORNER_THICK, borderTopLeftRadius: FRAME_RADIUS }
    case 'tr': return { ...base, top: -1, right: -1, borderTopWidth: CORNER_THICK, borderRightWidth: CORNER_THICK, borderTopRightRadius: FRAME_RADIUS }
    case 'bl': return { ...base, bottom: -1, left: -1, borderBottomWidth: CORNER_THICK, borderLeftWidth: CORNER_THICK, borderBottomLeftRadius: FRAME_RADIUS }
    case 'br': return { ...base, bottom: -1, right: -1, borderBottomWidth: CORNER_THICK, borderRightWidth: CORNER_THICK, borderBottomRightRadius: FRAME_RADIUS }
  }
}

export default function CardHoverEffect({
  active,
  onEnter,
  onLeave,
  layoutId,
  pad = 6,
  children,
}: Props) {
  return (
    <div
      style={{ position: 'relative', padding: pad }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <AnimatePresence>
        {active && (
          <motion.span
            layoutId={layoutId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.15 } }}
            exit={{ opacity: 0, transition: { duration: 0.15, delay: 0.2 } }}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'block',
              borderRadius: FRAME_RADIUS,
              background: 'linear-gradient(180deg, rgba(0,229,255,0.085), rgba(0,229,255,0.025))',
              border: '1px solid rgba(0,229,255,0.20)',
              boxShadow: '0 0 16px rgba(0,229,255,0.10), inset 0 0 22px rgba(0,229,255,0.05)',
            }}
          >
            <span style={cornerStyle('tl')} />
            <span style={cornerStyle('tr')} />
            <span style={cornerStyle('bl')} />
            <span style={cornerStyle('br')} />
          </motion.span>
        )}
      </AnimatePresence>
      {/* 卡片必须抬到垫片之上（原版 z-20 的语义） */}
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  )
}
