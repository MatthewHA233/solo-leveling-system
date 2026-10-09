// ══════════════════════════════════════════════
// 机体板 —— 钛板本身切成手绘 HUD 外框那种轮廓（不是圆角板里再画一根线）
//
// 从手绘框（HudFrameSkeleton / CornerArt / ChartHeaderFrame）继承的：
//   · 45° 是唯一的转角语法：四角切角，顶边遇标题抬成凸台、中段下沉、遇读数抬成塔楼——板和内容咬合
//   · 橙色点睛，但做成实物：阳极氧化铝的护角件 / 拱心石铭牌（有厚度、拉丝、螺丝），不发光
//   · 关节处的刻痕：下沉段两肩各三道斜槽，左右镜像
// 构图：橙色件只按中轴对称摆——顶部中轴一块拱心石 + 底部两角一对护角（稳稳的三角），不做斜对角
// 分主次：只有主角面板用 notch / 橙色件 / 刻痕；顶栏、侧栏只是安静的切角钛板
// 钛合金语言贯彻到底：边缘是切削倒角（外沿一道亮、紧贴一道暗），不画发光线、不用渐变蓝线
// ══════════════════════════════════════════════

import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

type Pt = readonly [number, number]

interface Notch {
  readonly tabRight: number
  readonly towerLeft: number
  readonly depth: number
}

interface Geometry {
  readonly w: number
  readonly h: number
  readonly pts: readonly Pt[]
  readonly notch: Notch | null
}

interface Props {
  readonly children: ReactNode
  /** 顶边按 data-chassis-tab / data-chassis-tower 抬出凸台、塔楼，中段下沉（只给主角面板） */
  readonly notch?: boolean
  /** 中段下沉深度 */
  readonly dipDepth?: number
  /** 四角切角大小 */
  readonly cut?: number
  /** 标题 / 读数与肩部的留白 */
  readonly anchorPad?: number
  /** 橙色阳极氧化件：none = 安静钛板；symmetric = 顶部中轴拱心石 + 底部两角护角 */
  readonly accents?: 'none' | 'symmetric'
  /** 下沉段两肩刻斜槽（左右镜像） */
  readonly ornaments?: boolean
  /** 板本身（被切成轮廓的那层）的 class / style：材质、内边距、布局都放这里 */
  readonly className?: string
  readonly style?: CSSProperties
  /** 外层（不裁切）的尺寸 / flex 设置 */
  readonly outerStyle?: CSSProperties
  /** 需要伸出轮廓之外的东西（例如拖拽手柄），放在不裁切的外层 */
  readonly outside?: ReactNode
}

const ANCHOR_SELECTOR = '[data-chassis-tab], [data-chassis-tower]'

/** 这批 DOM 变化碰没碰到凸台 / 塔楼锚点（板里装着编辑器、聊天流式输出，绝大多数变化和锚点无关） */
function touchesAnchors(records: readonly MutationRecord[]): boolean {
  const isAnchorish = (n: Node) => n instanceof Element && (n.matches(ANCHOR_SELECTOR) || n.querySelector(ANCHOR_SELECTOR) !== null)
  return records.some((r) => {
    if (r.type === 'attributes') {
      return r.attributeName === 'data-chassis-tab' || r.attributeName === 'data-chassis-tower'
        || (r.target instanceof Element && r.target.matches(ANCHOR_SELECTOR))
    }
    const host = r.target instanceof Element ? r.target : r.target.parentElement
    if (host?.closest(ANCHOR_SELECTOR)) return true
    return Array.from(r.addedNodes).some(isAnchorish) || Array.from(r.removedNodes).some(isAnchorish)
  })
}

function anchorBox(container: HTMLElement, selector: string): { left: number; right: number } | null {
  // 只认"自己这块板"里的锚点：嵌套的机体板里的锚点不算
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(selector))
  const el = candidates.find((c) => c.closest('[data-chassis]') === container)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  const cr = container.getBoundingClientRect()
  return { left: r.left - cr.left, right: r.right - cr.left }
}

function buildOutline(w: number, h: number, cut: number, notch: Notch | null): Pt[] {
  const top: Pt[] = notch
    ? [
        [notch.tabRight, 0],
        [notch.tabRight + notch.depth, notch.depth],
        [notch.towerLeft - notch.depth, notch.depth],
        [notch.towerLeft, 0],
      ]
    : []
  return [
    [0, cut], [cut, 0],
    ...top,
    [w - cut, 0], [w, cut],
    [w, h - cut], [w - cut, h],
    [cut, h], [0, h - cut],
  ]
}

/** 尺寸量到之前：纯 CSS 的四角切角（不带凹段） */
function chamferCss(cut: number): string {
  return `polygon(${cut}px 0, calc(100% - ${cut}px) 0, 100% ${cut}px, 100% calc(100% - ${cut}px), calc(100% - ${cut}px) 100%, ${cut}px 100%, 0 calc(100% - ${cut}px), 0 ${cut}px)`
}

export default function ChassisPlate({
  children, notch = false, dipDepth = 10, cut = 12, anchorPad = 12,
  accents = 'none', ornaments = false, className, style, outerStyle, outside,
}: Props) {
  const plateRef = useRef<HTMLDivElement>(null)
  const [geo, setGeo] = useState<Geometry | null>(null)

  useEffect(() => {
    const plate = plateRef.current
    if (!plate) return
    const measure = () => {
      const w = Math.round(plate.offsetWidth)
      const h = Math.round(plate.offsetHeight)
      if (w === 0 || h === 0) return
      let n: Notch | null = null
      if (notch) {
        const tab = anchorBox(plate, '[data-chassis-tab]')
        const tower = anchorBox(plate, '[data-chassis-tower]')
        const tabRight = Math.round(Math.max(cut + 8, tab ? tab.right + anchorPad : w * 0.34))
        const towerLeft = Math.round(Math.min(w - cut - 8, tower ? tower.left - anchorPad : w * 0.62))
        // 中段放不下两道 45° 斜肩就不下沉（窄面板不硬凑）
        if (towerLeft - tabRight > dipDepth * 2 + 24) n = { tabRight, towerLeft, depth: dipDepth }
      }
      const pts = buildOutline(w, h, cut, n)
      setGeo((prev) => (prev && prev.w === w && prev.h === h && JSON.stringify(prev.pts) === JSON.stringify(pts)
        ? prev
        : { w, h, pts, notch: n }))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(plate)
    measure()
    // 没有凸台的板（顶栏、侧栏）用不着锚点：尺寸变化交给上面的 ResizeObserver 就够了
    if (!notch) return () => ro.disconnect()

    const watchAnchors = () => plate.querySelectorAll(ANCHOR_SELECTOR).forEach((el) => ro.observe(el))
    watchAnchors()
    // 锚点会随内容换（改名、切视图、面板换内容）：子树变化后重新挂观察、重新量。
    // 板里装着整块视图（笔记编辑器、聊天流式输出……），之前每一次 DOM 变化都全树搜锚点 + 强制排版，
    // 打一个字就来一遍；现在只认碰到锚点的变化，同一帧里的多次变化合并成一次
    let frame = 0
    const mo = new MutationObserver((records) => {
      if (frame || !touchesAnchors(records)) return
      frame = requestAnimationFrame(() => {
        frame = 0
        watchAnchors()
        measure()
      })
    })
    mo.observe(plate, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'class', 'data-chassis-tab', 'data-chassis-tower'],
    })
    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(frame) }
  }, [notch, dipDepth, cut, anchorPad])

  const clipPath = geo
    ? `polygon(${geo.pts.map(([x, y]) => `${x}px ${y}px`).join(', ')})`
    : chamferCss(cut)

  return (
    <div style={{ position: 'relative', display: 'flex', minWidth: 0, minHeight: 0, ...outerStyle }}>
      {/* 投影：跟着轮廓走（静态 SVG，不随内容重绘） */}
      {geo && (
        <svg
          aria-hidden
          width={geo.w}
          height={geo.h}
          style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', filter: 'blur(9px)', transform: 'translateY(8px)' }}
        >
          <polygon points={geo.pts.map((p) => p.join(',')).join(' ')} fill="rgba(0,0,0,0.6)" />
        </svg>
      )}

      <div
        ref={plateRef}
        data-chassis=""
        className={className}
        style={{
          position: 'relative', flex: 1, minWidth: 0, minHeight: 0,
          borderRadius: 0,
          clipPath,
          ...style,
        }}
      >
        {children}
        {geo && <ChassisEdgeLayer geo={geo} cut={cut} accents={accents} ornaments={ornaments} />}
      </div>

      {outside}
    </div>
  )
}

// ── 橙色阳极氧化件（护角 / 拱心石）共用的材质定义 ──

const CAP_T = 5
const CAP_ARM = 18
const TAN_22 = Math.SQRT2 - 1   // 45° 切角向内偏移 t 时，拐点沿边多走 t·tan(22.5°)

function AnodizedDefs() {
  return (
    <defs>
      {/* 阳极氧化橙：光从左上来，受光处亮、背光处沉 */}
      <linearGradient id="anod-fill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#FFB27E" />
        <stop offset="0.35" stopColor="#F07A3C" />
        <stop offset="1" stopColor="#A9471E" />
      </linearGradient>
      {/* 细拉丝：沿 45° 的极细亮线 */}
      <pattern id="anod-brush" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="3" height="0.6" fill="rgba(255,255,255,0.16)" />
      </pattern>
      {/* 倒角亮边：光从上方来，上沿最亮、往下渐暗（按整块板的包围盒走） */}
      <linearGradient id="bevel-hi" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="rgba(255,255,255,0.46)" />
        <stop offset="0.35" stopColor="rgba(255,255,255,0.2)" />
        <stop offset="1" stopColor="rgba(255,255,255,0.1)" />
      </linearGradient>
    </defs>
  )
}

function Screw({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={1.5} fill="#5A2410" />
      <circle cx={x} cy={y} r={1.5} fill="none" stroke="rgba(255,220,190,0.45)" strokeWidth={0.5} />
    </g>
  )
}

/** 底部护角：厚 T 的 L 形条沿 45° 切角走，两端斜切，一臂一颗螺丝。corner 决定镜像到左下还是右下 */
function BaseCap({ corner, w, h, cut }: { corner: 'bl' | 'br'; w: number; h: number; cut: number }) {
  const t = CAP_T
  const k = t * TAN_22
  const end = cut + CAP_ARM
  // 先按左上角写几何，再映射到左下 / 右下（y 翻转；右下再 x 翻转）
  const map = ([x, y]: Pt): Pt => (corner === 'bl' ? [x, h - y] : [w - x, h - y])
  const local: Pt[] = [
    [0, end], [0, cut], [cut, 0], [end, 0],                       // 外沿
    [end - t, t], [cut + k, t], [t, cut + k], [t, end - t],       // 内沿（两端 45° 斜切）
  ]
  const pts = local.map(map)
  const shape = pts.map((p) => p.join(',')).join(' ')
  const outer = pts.slice(0, 4).map((p) => p.join(',')).join(' ')
  const inner = pts.slice(4).map((p) => p.join(',')).join(' ')
  const screws = ([[t / 2 + 0.2, cut + CAP_ARM * 0.62], [cut + CAP_ARM * 0.62, t / 2 + 0.2]] as Pt[]).map(map)
  return (
    <g>
      <polygon points={shape} fill="url(#anod-fill)" />
      <polygon points={shape} fill="url(#anod-brush)" />
      <polyline points={inner} fill="none" stroke="rgba(40,12,0,0.7)" strokeWidth={0.9} />
      <polyline points={outer} fill="none" stroke="rgba(255,230,210,0.42)" strokeWidth={1.2} />
      {screws.map(([x, y], i) => <Screw key={i} x={x} y={y} />)}
    </g>
  )
}

/** 顶部中轴拱心石：挂在顶边正中的梯形铭牌（上宽下窄），两颗螺丝 */
function Keystone({ cx, top }: { cx: number; top: number }) {
  const wTop = 44
  const wBottom = 32
  const hgt = 7
  const shape = [
    [cx - wTop / 2, top], [cx + wTop / 2, top],
    [cx + wBottom / 2, top + hgt], [cx - wBottom / 2, top + hgt],
  ].map((p) => p.join(',')).join(' ')
  return (
    <g>
      <polygon points={shape} fill="url(#anod-fill)" />
      <polygon points={shape} fill="url(#anod-brush)" />
      <polyline
        points={`${cx - wBottom / 2},${top + hgt} ${cx + wBottom / 2},${top + hgt}`}
        fill="none" stroke="rgba(40,12,0,0.75)" strokeWidth={1}
      />
      <Screw x={cx - wBottom / 2 + 4} y={top + 3.2} />
      <Screw x={cx + wBottom / 2 - 4} y={top + 3.2} />
    </g>
  )
}

/** 切削倒角 + 橙色件 + 关节刻痕（画在板内，裁切会把外半边切掉，只留贴边的一道） */
function ChassisEdge({ geo, cut, accents, ornaments }: {
  geo: Geometry
  cut: number
  accents: 'none' | 'symmetric'
  ornaments: boolean
}) {
  const { w, h, pts, notch } = geo
  const d = `M ${pts.map((p) => p.join(' ')).join(' L ')} Z`
  const dipStart = notch ? notch.tabRight + notch.depth : 0
  const dipEnd = notch ? notch.towerLeft - notch.depth : 0
  return (
    <svg
      aria-hidden
      width={w}
      height={h}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 65, overflow: 'hidden' }}
    >
      <AnodizedDefs />

      {/* 倒角：先压一道暗（露出 2.5px），再压一道亮（露出 1.2px）= 外沿亮、紧贴一道暗 */}
      <path d={d} fill="none" stroke="rgba(0,0,0,0.82)" strokeWidth={5} strokeLinejoin="miter" />
      <path d={d} fill="none" stroke="url(#bevel-hi)" strokeWidth={2.4} strokeLinejoin="miter" />

      {/* 橙色件按中轴对称：顶部正中拱心石 + 底部两角护角 */}
      {accents === 'symmetric' && (
        <>
          <Keystone cx={notch ? (dipStart + dipEnd) / 2 : w / 2} top={notch ? notch.depth : 0} />
          <BaseCap corner="bl" w={w} h={h} cut={cut} />
          <BaseCap corner="br" w={w} h={h} cut={cut} />
        </>
      )}

      {/* 关节刻痕：下沉段两肩各四道斜槽（左右镜像），再各拉一道刻线导轨通向中轴拱心石，导轨起点一颗铆钉 */}
      {ornaments && notch && dipEnd - dipStart > 180 && (() => {
        const y = notch.depth + 8
        const cx = (dipStart + dipEnd) / 2
        const groove = (x1: number, y1: number, x2: number, y2: number, key: string) => (
          <g key={key}>
            {/* 槽底：深黑；槽口下唇：受光亮线（刻进去的感觉靠这一明一暗） */}
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,0.92)" strokeWidth={2.4} strokeLinecap="round" />
            <line x1={x1 + 1.3} y1={y1 + 0.6} x2={x2 + 1.3} y2={y2 + 0.6} stroke="rgba(255,255,255,0.3)" strokeWidth={1} strokeLinecap="round" />
          </g>
        )
        const rail = (x1: number, x2: number, key: string) => (
          <g key={key}>
            <line x1={x1} y1={y} x2={x2} y2={y} stroke="rgba(0,0,0,0.88)" strokeWidth={1.4} />
            <line x1={x1} y1={y + 1.3} x2={x2} y2={y + 1.3} stroke="rgba(255,255,255,0.17)" strokeWidth={0.9} />
          </g>
        )
        const rivet = (x: number, key: string) => (
          <g key={key}>
            <circle cx={x} cy={y + 0.6} r={2.1} fill="#0B0A09" />
            <circle cx={x - 0.4} cy={y + 0.2} r={1.2} fill="rgba(255,255,255,0.32)" />
          </g>
        )
        const railIn = 50
        const railOut = 34
        return (
          <g>
            {[0, 1, 2, 3].map((i) => {
              const x = dipStart + 12 + i * 5
              return groove(x + 6, y + 5, x, y - 5, `l${i}`)     // 左肩：\
            })}
            {[0, 1, 2, 3].map((i) => {
              const x = dipEnd - 12 - i * 5
              return groove(x - 6, y + 5, x, y - 5, `r${i}`)     // 右肩：/
            })}
            {cx - railOut - (dipStart + railIn) > 24 && (
              <>
                {rail(dipStart + railIn, cx - railOut, 'rl')}
                {rail(cx + railOut, dipEnd - railIn, 'rr')}
                {rivet(dipStart + railIn - 5, 'vl')}
                {rivet(dipEnd - railIn + 5, 'vr')}
              </>
            )}
          </g>
        )
      })()}
    </svg>
  )
}

/** 装饰层只跟几何和开关有关：App 每次重渲染都会带着它重画一整套 SVG（之前占重渲染时间的一成多），参数没变就跳过 */
const ChassisEdgeLayer = memo(ChassisEdge)
