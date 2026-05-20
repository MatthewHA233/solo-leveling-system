// ══════════════════════════════════════════════
// ChartHeaderFrame — 昼夜表"外延边线"
//
// 几何（与内部 HudFrame 切角对称化）：
//   · 长竖线距 chart pane 右边线 OFFSET px
//   · 顶部横线距 chart pane 顶 OFFSET px
//   · 右上 45° 斜线：从 (chartRight, top) 斜到 (chartRight+OFFSET, chartPaneTop)
//     —— 形成 OFFSET × OFFSET 的对称切角，跟内部 18×18 切角呼应
//
// 一根连续路径：内框左竖线 ↑ → 圆角 → 横线左段 → 凹陷 → 横线右段 → 45° 斜下 → 长竖线 → 底部
// chart pane 内部完全不动
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { theme } from '../../theme'

interface Props {
  /** tab 区高度（svg 容器顶 → chart pane 顶的距离） */
  readonly mainHeight?: number
  /** 长竖线距 chart pane 右边线偏移 px */
  readonly rightOffset?: number
  /** 凹陷左段横线距 chart pane 顶偏移 px（高位） */
  readonly topOffsetLeft?: number
  /** 凹陷右段横线距 chart pane 顶偏移 px（低位） */
  readonly topOffsetRight?: number
  /** 右上 45° 斜线长度（dx=dy=slopeLen） */
  readonly slopeLen?: number
  /** 横线③（右段）的固定长度 px。控制凹陷整体"靠右"的程度，小 → 凹陷越靠右 */
  readonly rightSegLen?: number
  /** 凹陷开口宽度 px（左拐点到右拐点距离） */
  readonly notchWidth?: number
  /** 父容器 paddingRight 总量 */
  readonly paddingRightFull?: number
  readonly color?: string
  /** A 点距 ⑤ 计划安排按钮底部 px（凹陷自顶部固定起点，BC 段长度自适应容器高度） */
  readonly aOffsetFromLayerBtn?: number
}

export function ChartHeaderFrame({
  mainHeight = 30,
  rightOffset = 24,
  topOffsetLeft = 24,
  topOffsetRight = 24,
  slopeLen = 14,
  rightSegLen = 90,
  notchWidth = 150,
  paddingRightFull = 24.5,
  color = '#2A9FBE',   // 比内框 #40CAE8 略深的蓝
  aOffsetFromLayerBtn = 10,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      setSize({
        w: Math.round(entry.contentRect.width),
        h: Math.round(entry.contentRect.height),
      })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute',
        top: -mainHeight,
        left: 0,
        right: -paddingRightFull,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 78,
      }}
    >
      {size.w > 0 && size.h > 0 && (() => {
        const { w, h } = size

        // chart pane 在 svg 内坐标：x = 0..(w-paddingRightFull)，y = mainHeight..h
        const xChartRight = w - paddingRightFull
        const yChartTop = mainHeight

        // 长竖线 x = chart pane 右边线 + rightOffset
        const xLineEnd = xChartRight + rightOffset

        // 横线左右段分别 y：左高右低不对称
        const yMainLeft = yChartTop - topOffsetLeft     // 凹陷左段（高位）
        const yMainRight = yChartTop - topOffsetRight   // 凹陷右段（低位，靠近 chart pane 顶）

        // 凹底 y（凹陷深度 = topOffsetLeft / 2 = 12，即凹底在左段横线下方 12px）
        const yFloor = yMainLeft + topOffsetLeft / 2

        // 右上 45° 斜线：起点 (xLineEnd - slopeLen, yMainRight)，终点 (xLineEnd, yMainRight + slopeLen)
        const xSlopeStart = xLineEnd - slopeLen
        const ySlopeEnd = yMainRight + slopeLen

        // 凹陷拐角斜投影（数字越大斜得越缓）
        const cornerLen = 10

        // 凹陷拐点：从右往左反向定位
        // 横线③长度 = rightSegLen（固定）→ 反推 xPortRightShoulder
        // 凹陷宽度 = notchWidth（固定）→ 反推 xPortLeftShoulder
        const xPortRightShoulder = xSlopeStart - rightSegLen
        const xPortLeftShoulder = xPortRightShoulder - notchWidth

        // 左上 45° 斜切（与右上对称，dx=dy=slopeLen）
        const xLeftSlopeEnd = slopeLen                 // 斜线终点 x（横线左段起点）
        const yLeftSlopeStart = yMainLeft + slopeLen   // 短竖线终点 y / 斜线起点 y

        const stroke = 1.0      // 比内框 1.2 略细
        const strokeOpacity = 0.92

        // ── 右下末端坐标（与 path 内一致，提到外面供末端装饰使用） ──
        const CHART_CORNER_CUT_LOCAL = 18
        const btn3Size = 24
        const layerBtnHeight = 32
        const layerBtnGap = 10
        const layerOffsetFromBtn3 = 20
        const yInnerCornerEndLocal = yChartTop + CHART_CORNER_CUT_LOCAL
        const yLayer1Local = yInnerCornerEndLocal + btn3Size + layerOffsetFromBtn3
        const yLayer2BottomLocal = yLayer1Local + layerBtnHeight + layerBtnGap + layerBtnHeight
        const pinchY = yLayer2BottomLocal + aOffsetFromLayerBtn
        const pinchDx = 7
        const tailSlope = 12
        const tailDx = 12
        const cYOffset = CHART_CORNER_CUT_LOCAL + 14
        // 路径末端坐标
        const endX = xLineEnd - pinchDx - tailDx          // 末端 x
        const endY = h - cYOffset + tailSlope             // 末端 y
        // path 用的关键坐标
        const ax = xLineEnd,             ay = pinchY
        const bx = xLineEnd - pinchDx,   by = pinchY + 7
        const cx = xLineEnd - pinchDx,   cy = h - cYOffset

        return (
          <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
            <defs>
              <filter id="chf-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="0.8" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <path
              d={[
                `M 0 ${yChartTop + CHART_CORNER_CUT_LOCAL}`,                      // 起点：左竖线底端接到内框左上切角的底点（与内框左竖线视觉连续）
                `L 0 ${yLeftSlopeStart}`,                                         // 短竖线到斜线起点
                `L ${xLeftSlopeEnd} ${yMainLeft}`,                                // 左上 45° 斜切（与右上对称）
                `L ${xPortLeftShoulder} ${yMainLeft}`,                            // 横线左段（高位）
                `L ${xPortLeftShoulder + cornerLen} ${yFloor}`,                   // 凹陷左拐 (短斜下)
                `L ${xPortRightShoulder - cornerLen} ${yFloor}`,                  // 凹陷水平线
                `L ${xPortRightShoulder} ${yMainRight}`,                          // 凹陷右拐 (短斜上到低位)
                `L ${xSlopeStart} ${yMainRight}`,                                 // 横线右段（低位）
                `L ${xLineEnd} ${ySlopeEnd}`,                                     // 右上 45° 斜下
                `L ${ax} ${ay}`,                                                  // A：长竖线到凹陷起点
                `L ${bx} ${by}`,                                                  // A→B：斜入凹陷
                `L ${cx} ${cy}`,                                                  // B→C：凹陷竖线下行
                `L ${endX} ${endY}`,                                              // C→末端：再斜入收尾
              ].join(' ')}
              fill="none"
              stroke={color}
              strokeOpacity={strokeOpacity}
              strokeWidth={stroke}
              strokeLinecap="butt"
              strokeLinejoin="miter"
              filter="url(#chf-glow)"
            />

            {/* B 点左上方"平行竖线群"：N 根等长竖线，每根整体沿 45° 左下→右上偏移
                构成左下→右上 45° 倾斜的平行四边形整体 */}
            {(() => {
              const groupN = 3
              const groupGap = 2.5
              const groupShift = 2.5
              const lineH = 100
              const groupSw = 1.0
              const xRightmost = cx - 4
              const yRightmostBottom = cy
              const xLeftmost = xRightmost - (groupN - 1) * groupGap
              const yLeftmostTop = (yRightmostBottom + (groupN - 1) * groupShift) - lineH
              const poleEndX = cx
              const poleEndY = yLeftmostTop - (cx - xLeftmost)

              // ── 外探拐线（从 B 下 100px 处 45° 探出 → 垂直向下 → 装饰 2 底部 / 三分中线） ──
              const sQuater = { x: cx, y: by + 100 }
              const abLen = Math.hypot(7, 7)
              const probeLen = abLen * 2 / 3
              const probeDxy = probeLen / Math.SQRT2
              const elbowX = sQuater.x + probeDxy
              const elbowY = sQuater.y + probeDxy

              // 三分天下：装饰 1 / 装饰 2 / 装饰 3 各占 1/3，gap=4px
              // 顶部 = B 点（外侧凹陷起点），底部 = 旗杆终点
              const decoFromY = by               // 起点：B 点
              const decoToY = poleEndY           // 终点：旗杆终点
              const decoGap = 4
              const decoSegH = (decoToY - decoFromY - 2 * decoGap) / 3
              const deco1Top = decoFromY
              const deco1Bot = deco1Top + decoSegH
              const deco2Top = deco1Bot + decoGap
              const deco2Bot = deco2Top + decoSegH
              const deco3Top = deco2Bot + decoGap
              const deco3Bot = decoToY

              // 外探线 E 点 = 装饰 2 底部
              const eEnd = { x: elbowX, y: deco2Bot }

              return (
                <g
                  stroke={color}
                  strokeOpacity={0.82}
                  strokeLinecap="butt"
                  filter="url(#chf-glow)"
                >
                  {Array.from({ length: groupN }, (_, i) => {
                    const xi = xRightmost - i * groupGap
                    const yBottom = yRightmostBottom + i * groupShift
                    const yTop = yBottom - lineH
                    return (
                      <line
                        key={`grp${i}`}
                        x1={xi} y1={yTop}
                        x2={xi} y2={yBottom}
                        strokeWidth={groupSw}
                      />
                    )
                  })}
                  {/* 旗杆：穿过每根竖线顶点的 45° 斜线 */}
                  <line
                    x1={xLeftmost} y1={yLeftmostTop}
                    x2={poleEndX} y2={poleEndY}
                    strokeWidth={0.7}
                  />
                  {/* 外探拐线：S → 45° 探出 → 垂直向下 → E
                      独立判断：中间垂直段 < 10px 时消失 */}
                  {(eEnd.y - elbowY) >= 10 && (
                    <polyline
                      points={[
                        `${sQuater.x},${sQuater.y}`,
                        `${elbowX},${elbowY}`,
                        `${eEnd.x},${eEnd.y}`,
                      ].join(' ')}
                      fill="none"
                      strokeWidth={1.0}
                    />
                  )}

                  {/* 内框/外框夹缝装饰 2 */}
                  {decoSegH >= 10 && (
                    <>

                      {/* 装饰 2（三分天下中间段）：嵌套 svg，等比例缩放参考稿 */}
                      {(() => {
                        const decoH = deco2Bot - deco2Top
                        if (decoH < 10) return null
                        const decoW = 20
                        const decoX = xChartRight - 1
                        const decoYTop = deco2Top
                        return (
                          <svg
                            x={decoX} y={decoYTop}
                            width={decoW} height={decoH}
                            viewBox="0 0 100 500"
                            preserveAspectRatio="none"
                            style={{ overflow: 'visible' }}
                          >
                            <defs>
                              <filter id="chf-deco-neon" x="-50%" y="-50%" width="200%" height="200%">
                                <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur1" />
                                <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur2" />
                                <feMerge>
                                  <feMergeNode in="blur2" />
                                  <feMergeNode in="blur1" />
                                  <feMergeNode in="SourceGraphic" />
                                </feMerge>
                              </filter>
                              <pattern id="chf-deco-stripe" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                                <rect width="6" height="12" fill="#0D1E2D" />
                                <rect x="6" width="6" height="12" fill="#1C3F5E" />
                              </pattern>
                              <linearGradient id="chf-deco-shadow" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#0a0f14" stopOpacity="0.9" />
                                <stop offset="15%" stopColor="#0a0f14" stopOpacity="0" />
                                <stop offset="85%" stopColor="#0a0f14" stopOpacity="0" />
                                <stop offset="100%" stopColor="#0a0f14" stopOpacity="0.9" />
                              </linearGradient>
                            </defs>

                            {/* 顶部小三角箭头（亮） */}
                            <g filter="url(#chf-deco-neon)" opacity={0.95}>
                              <polygon points="32,28 38,28 38,34" fill="#00E5FF" />
                            </g>
                            {/* 主路径（中等） */}
                            <g filter="url(#chf-deco-neon)" opacity={0.5}>
                              <path d="M38 34 L50 48 V120" stroke="#00E5FF" strokeWidth="1.2" fill="none" />
                            </g>
                            {/* 末端电池（亮一点） */}
                            <g filter="url(#chf-deco-neon)" opacity={0.85}>
                              <path d="M50 120 L46 125 V140 H54 V125 Z" stroke="#00E5FF" strokeWidth="1.2" fill="none" />
                            </g>

                            {/* 六边形容器：背景 stripe + shadow 淡，描边稍亮 */}
                            <g opacity={0.4}>
                              <polygon points="30,154 70,154 70,296 30,296" fill="url(#chf-deco-stripe)" />
                              <polygon points="30,154 70,154 70,296 30,296" fill="url(#chf-deco-shadow)" />
                            </g>
                            <g opacity={0.7}>
                              <polygon points="32,150 68,150 72,154 72,296 68,300 32,300 28,296 28,154"
                                fill="none" stroke="#00E5FF" strokeWidth="1.2" filter="url(#chf-deco-neon)" />
                            </g>

                            {/* 第一根 cyan 短横（亮） */}
                            <g filter="url(#chf-deco-neon)" opacity={1}>
                              <rect x="45" y="315" width="10" height="4" fill="#00E5FF" />
                            </g>
                            {/* 4 根 orange 短横（0.8） */}
                            <g filter="url(#chf-deco-neon)" opacity={0.8}>
                              <rect x="45" y="325" width="10" height="4" fill="#FF9900" />
                              <rect x="45" y="335" width="10" height="4" fill="#FF9900" />
                              <rect x="45" y="345" width="10" height="4" fill="#FF9900" />
                              <rect x="45" y="355" width="10" height="4" fill="#FF9900" />
                            </g>
                            {/* 接口竖线 + L 折线 + 三角箭头（亮，接口） */}
                            <g filter="url(#chf-deco-neon)" opacity={0.95}>
                              <line x1="75" y1="315" x2="75" y2="385" stroke="#00E5FF" strokeWidth="1" />
                              <polyline points="50,375 50,440 35,455" fill="none" stroke="#00E5FF" strokeWidth="1.2" />
                              <polygon points="35,455 35,447 28,455" fill="#00E5FF" />
                            </g>
                          </svg>
                        )
                      })()}
                    </>
                  )}

                  {/* 装饰 1（三分天下顶段）：嵌套 svg，等比例缩放，viewBox 50×400 */}
                  {(() => {
                    const deco1X = xChartRight - 1
                    const deco1W = 20
                    const deco1H = deco1Bot - deco1Top
                    if (deco1H < 10) return null
                    return (
                      <svg
                        x={deco1X} y={deco1Top}
                        width={deco1W} height={deco1H}
                        viewBox="0 0 50 400"
                        preserveAspectRatio="none"
                        style={{ overflow: 'visible' }}
                      >
                        <defs>
                          <filter id="chf-deco1-neon" x="-50%" y="-20%" width="200%" height="140%">
                            <feGaussianBlur stdDeviation="1" result="blur1" />
                            <feGaussianBlur stdDeviation="2.5" result="blur2" />
                            <feMerge>
                              <feMergeNode in="blur2" />
                              <feMergeNode in="blur1" />
                              <feMergeNode in="SourceGraphic" />
                            </feMerge>
                          </filter>
                        </defs>
                        {/* 顶部路径（中等） */}
                        <g filter="url(#chf-deco1-neon)" opacity={0.55}>
                          <path d="M 14 12 L 18 12 L 25 22 L 25 180" fill="none" stroke="#00e5ff" strokeWidth="1.1" strokeLinecap="square" strokeLinejoin="miter" />
                          <polygon points="13,11.1 18,11.1 13,15" fill="#00e5ff" />
                        </g>
                        {/* 中段图标（电池亮） */}
                        <g filter="url(#chf-deco1-neon)" opacity={0.95}>
                          <rect x="23.5" y="183" width="3" height="6" fill="#00e5ff" />
                          <rect x="21" y="191" width="3" height="8" fill="#00e5ff" />
                          <rect x="26" y="191" width="3" height="8" fill="#00e5ff" />
                          <rect x="22.5" y="201" width="5" height="4" fill="#00e5ff" />
                          <rect x="23.5" y="207" width="3" height="3" fill="#00e5ff" />
                        </g>
                        {/* 底部 10 根能量横线：从上到下 opacity 0.3 → 1 渐变 */}
                        <g filter="url(#chf-deco1-neon)">
                          {[230, 248, 266, 284, 302, 320, 338, 356, 374, 392].map((y, i, arr) => {
                            const t = i / (arr.length - 1)
                            return (
                              <path
                                key={`bar${i}`}
                                d={`M 18 ${y} L 32 ${y}`}
                                stroke="#00e5ff"
                                strokeWidth="1.2"
                                opacity={0.3 + (1.0 - 0.3) * t}
                                fill="none"
                              />
                            )
                          })}
                        </g>
                      </svg>
                    )
                  })()}

                  {/* 装饰 3（三分天下底段）：嵌套 svg，等比例缩放 */}
                  {(() => {
                    const deco3X = xChartRight - 1
                    const deco3W = 20
                    const deco3H = deco3Bot - deco3Top
                    if (deco3H < 10) return null
                    return (
                      <svg
                        x={deco3X} y={deco3Top}
                        width={deco3W} height={deco3H}
                        viewBox="0 0 60 250"
                        preserveAspectRatio="none"
                        style={{ overflow: 'visible' }}
                      >
                        <defs>
                          <filter id="chf-deco3-neon" x="-50%" y="-20%" width="200%" height="140%">
                            <feGaussianBlur stdDeviation="1" result="blur1" />
                            <feGaussianBlur stdDeviation="2.5" result="blur2" />
                            <feMerge>
                              <feMergeNode in="blur2" />
                              <feMergeNode in="blur1" />
                              <feMergeNode in="SourceGraphic" />
                            </feMerge>
                          </filter>
                        </defs>
                        {/* 主旋钮 + 中央菱形 + 接口端子 + 导线：统一中等亮度 */}
                        <g filter="url(#chf-deco3-neon)" stroke="#00e5ff" strokeWidth="1.2" fill="none" strokeLinecap="square" opacity={0.7}>
                          <path d="M 15 25 L 15 15 L 25 15" />
                          <path d="M 35 15 L 45 15 L 45 25" />
                          <path d="M 15 35 L 15 45 L 25 45" />
                          <path d="M 45 35 L 45 45 L 35 45" />
                          <circle cx="30" cy="30" r="8" />
                          <path d="M 30 18 L 30 24" />
                          <path d="M 30 36 L 30 42" />
                          <path d="M 18 30 L 24 30" />
                          <path d="M 36 30 L 42 30" />
                          <polygon points="30,26.5 31.5,28.5 34,30 31.5,31.5 30,33.5 28.5,31.5 26,30 28.5,28.5" fill="#00e5ff" stroke="none" />
                          <rect x="27.5" y="55" width="5" height="12" rx="2" />
                          <path d="M 30 67 L 30 215" />
                        </g>
                        {/* 末端 L 折线 + 三角箭头（亮，接口） */}
                        <g filter="url(#chf-deco3-neon)" stroke="#00e5ff" strokeWidth="1.2" fill="none" strokeLinecap="square" opacity={0.95}>
                          <path d="M 30 215 L 15 235" />
                          <polygon points="15,235 17.5,236.5 13,242.5 10.5,241" stroke="#00e5ff" strokeWidth="1.2" strokeLinejoin="miter" fill="#00e5ff" />
                        </g>
                      </svg>
                    )
                  })()}

                  {/* H 点上方一列椭圆装饰：统一高度，短轴从下到上由 1×→0.5× 渐变压扁
                      跟随装饰 3 一起消失 */}
                  {decoSegH >= 10 && (() => {
                    const dotCount = 5
                    const dotGap = 6
                    const dotRy = 2.0          // 椭圆长轴（统一）
                    const rxRatioMax = 1.0     // i=0 最下：正圆
                    const rxRatioMin = 0.5     // i=N-1 最上：最扁
                    const dotX = elbowX
                    const dotBaseY = poleEndY - 10   // 最下椭圆 y
                    return Array.from({ length: dotCount }, (_, i) => {
                      // i=0 最下、正圆；i=N-1 最上、最扁
                      const t = dotCount === 1 ? 0 : i / (dotCount - 1)
                      const rxRatio = rxRatioMax + (rxRatioMin - rxRatioMax) * t
                      const rx = dotRy * rxRatio
                      const cy = dotBaseY - i * dotGap
                      return (
                        <ellipse
                          key={`hdot${i}`}
                          cx={dotX} cy={cy} rx={rx} ry={dotRy}
                          fill={color} stroke="none"
                        />
                      )
                    })
                  })()}
                </g>
              )
            })()}

            {/* 凹槽内 3 个平行四边形旗帜 + 旗杆装饰
                旗帜平行于左拐角斜线（左上→右下），靠左排列；
                每个旗帜的右斜线向下延伸到凹底形成旗杆 */}
            {(() => {
              const flagW = 5
              const flagH = 9
              // 斜率 flagH/|flagSkew| = 9/7.5 = 1.2，与左拐角斜线 (cornerLen=10, 凹深=12) 严格平行
              const flagSkew = -7.5
              const flagCount = 3
              const flagGap = 14
              const notchInnerLeft = xPortLeftShoulder + cornerLen
              const startX = notchInnerLeft + flagGap   // 左斜线到第一个旗子的间距 = 旗子之间间距
              const flagY = yMainLeft                    // 旗帜顶部对齐横线左段
              return (
                <g filter="url(#chf-glow)">
                  {Array.from({ length: flagCount }, (_, i) => {
                    const x = startX + i * (flagW + flagGap)
                    // 平行四边形 4 顶点（skew=-3：上边比下边左移 3）
                    const xLB = x, yLB = flagY + flagH        // 左下
                    const xLT = x + flagSkew, yLT = flagY     // 左上
                    const xRT = x + flagSkew + flagW, yRT = flagY      // 右上
                    const xRB = x + flagW, yRB = flagY + flagH         // 右下
                    const pts = `${xLB},${yLB} ${xLT},${yLT} ${xRT},${yRT} ${xRB},${yRB}`
                    // 旗杆：右斜线从 (xRB, yRB) 沿原方向（(xRT,yRT)→(xRB,yRB) 即下右方向）向下延伸到 y=yFloor
                    // 方向向量 = (xRB-xRT, yRB-yRT) = (-flagSkew, flagH) = (3, 6)
                    // 从 (xRB, yRB) 延长 Δy = yFloor - yRB → Δx = -flagSkew / flagH * Δy
                    const dy = yFloor - yRB
                    const poleX2 = xRB + (-flagSkew / flagH) * dy
                    return (
                      <g key={`flag${i}`}>
                        <polygon points={pts} fill={color} opacity={0.85} />
                        <line
                          x1={xRB} y1={yRB}
                          x2={poleX2} y2={yFloor}
                          stroke={color} strokeOpacity={0.85} strokeWidth={1.2}
                        />
                      </g>
                    )
                  })}
                </g>
              )
            })()}

            {/* 凹陷两侧横线下方各 N 个空心圆环（铆钉装饰）
                左侧：横线左段（yMainLeft）下方，靠近凹陷左拐点
                右侧：横线右段（yMainRight）下方，靠近凹陷右拐点 */}
            {(() => {
              const r = 1.5
              const sw = 1
              const gap = 8
              const offsetFromLine = 8      // 圆环中心距横线 px（更靠下）
              const leftCount = 4
              const rightCount = 4
              const yLeftHole = yMainLeft + offsetFromLine
              const yRightHole = yMainRight + offsetFromLine
              const xLeftEnd = xPortLeftShoulder - 5     // 最靠近左拐点的孔
              const xRightStart = xPortRightShoulder + 5 // 最靠近右拐点的孔
              return (
                <g
                  fill="none"
                  stroke={color}
                  strokeWidth={sw}
                  strokeOpacity={0.75}
                  filter="url(#chf-glow)"
                >
                  {Array.from({ length: leftCount }, (_, i) => (
                    <circle
                      key={`hL${i}`}
                      cx={xLeftEnd - (leftCount - 1 - i) * gap}
                      cy={yLeftHole}
                      r={r}
                    />
                  ))}
                  {/* 左侧 4 圆环之左：折线（水平 + 45° 斜下）
                      横段总长 50px，右侧 25px 虚线、左侧 25px 实线，斜段 10px 实线 */}
                  {(() => {
                    const xFirstHole = xLeftEnd - (leftCount - 1) * gap
                    const polyStartX = xFirstHole - gap
                    const polyStartY = yLeftHole
                    const hSegDashed = 40     // 横段右半（虚线，5 实 / 5 空）
                    const hSegSolid = 25      // 横段左半（实线）
                    const sSeg = 10           // 斜段
                    const xMid = polyStartX - hSegDashed
                    return (
                      <>
                        {/* 右半横段：虚线 */}
                        <line
                          x1={polyStartX} y1={polyStartY}
                          x2={xMid} y2={polyStartY}
                          strokeDasharray="5 5"
                        />
                        {/* 左半横段 + 斜段：实线 */}
                        <polyline
                          points={[
                            `${xMid},${polyStartY}`,
                            `${xMid - hSegSolid},${polyStartY}`,
                            `${xMid - hSegSolid - sSeg},${polyStartY + sSeg}`,
                          ].join(' ')}
                        />
                      </>
                    )
                  })()}
                  {Array.from({ length: rightCount }, (_, i) => (
                    <circle
                      key={`hR${i}`}
                      cx={xRightStart + i * gap}
                      cy={yRightHole}
                      r={r}
                    />
                  ))}
                </g>
              )
            })()}
          </svg>
        )
      })()}
    </div>
  )
}
