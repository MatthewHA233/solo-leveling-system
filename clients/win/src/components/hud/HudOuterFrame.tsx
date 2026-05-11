// ══════════════════════════════════════════════
// HudOuterFrame — 全页最外层骨架（手描自 Figma）
//   原始画布 1159 × 824，stretch 填充父容器
//   vector-effect="non-scaling-stroke" 保证拉伸时线宽不变
// ══════════════════════════════════════════════

import type { CSSProperties } from 'react'

interface HudOuterFrameProps {
  readonly skin?: string         // 主框线色（内层）
  readonly skinBright?: string   // 主框线色（外层 / 顶部，更亮）
  readonly anchor?: string       // 锚点亮点色
  readonly opacity?: number      // 整体不透明度（用于 hover/dim）
}

export function HudOuterFrame({
  skin = '#40CAE8',
  skinBright = '#44E4F5',
  anchor = '#33F8FF',
  opacity = 1,
}: HudOuterFrameProps) {
  return (
    <svg
      viewBox="0 0 1159 824"
      preserveAspectRatio="none"
      fill="none"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity,
        zIndex: 50,
      }}
    >
      {/* 全部线条统一加 non-scaling-stroke：拉伸时线宽不变 */}
      <g style={{ vectorEffect: 'non-scaling-stroke' } as CSSProperties}>
        {/* ── 底部右段：从中心到右下角 ── */}
        <path d="M1146 813H1012" stroke={skin} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
        <path d="M1156.5 821.5L1147.5 813" stroke={skin} strokeOpacity="0.1" vectorEffect="non-scaling-stroke" />

        {/* ── 底部左段：分级渐隐 ── */}
        <path d="M32.5 823.5H48" stroke={skin} strokeOpacity="0.6" vectorEffect="non-scaling-stroke" />
        <path d="M48 823.5H72" stroke={skin} strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
        <path d="M72 823.5H916.5" stroke={skin} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />

        {/* ── 左下角斜切（45°） ── */}
        <path d="M26 751L74 801.5" stroke={skin} strokeOpacity="0.6" vectorEffect="non-scaling-stroke" />
        <path d="M74.5 802L85 813" stroke={skin} strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
        <path d="M85 813L95 823" stroke={skin} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />

        {/* ── 左侧主竖线（分段景深） ── */}
        <path d="M3 727.5V784.5" stroke={skin} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
        <path d="M3 785.5V807.5L19.5 823.5H32.5" stroke={skin} strokeOpacity="0.8" vectorEffect="non-scaling-stroke" />

        {/* ── 左侧 153~256 分段刻度 ── */}
        <path d="M1 153L0.5 155.5V159" stroke={skin} strokeOpacity="0.8" vectorEffect="non-scaling-stroke" />
        <path d="M12.5 175.5V188" stroke={skin} strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
        <path d="M10 159L12.5 160.5V736.5" stroke={skin} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
        <path d="M12.5 164.5V175" stroke={skin} strokeOpacity="0.6" vectorEffect="non-scaling-stroke" />
        <path d="M3 153V152H1.5V153H3ZM3 153L9.5 158.5" stroke={skin} vectorEffect="non-scaling-stroke" />
        <path d="M9.5 158.5L12.5 160.5V165" stroke={skin} strokeOpacity="0.8" vectorEffect="non-scaling-stroke" />

        {/* ── 顶部主线（左→右） ── */}
        <path d="M969.5 0.5H19.5" stroke={skinBright} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
        <path
          d="M19.5 0.5L15.4786 4.06182C6.90704 11.6538 2 22.5551 2 34.0053V151.5"
          stroke={skinBright}
          strokeOpacity="0.2"
          vectorEffect="non-scaling-stroke"
        />

        {/* ── 左上角斜切支架 ── */}
        <path d="M2.5 68.5L25.5 45H58" stroke={skinBright} strokeOpacity="0.5" vectorEffect="non-scaling-stroke" />
        <path d="M2.5 68V99" stroke={skinBright} strokeOpacity="0.5" vectorEffect="non-scaling-stroke" />

        {/* ── 右上角支架（带斜切） ── */}
        <path d="M1144 27.5H1026L998.5 0.5H969" stroke={skinBright} strokeOpacity="0.3" vectorEffect="non-scaling-stroke" />
        <path d="M1158.5 43L1143.5 27.5" stroke={skinBright} strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
        <path d="M1158.5 818.5C1158.58 818.552 1158 823 1154.5 823" stroke={skinBright} vectorEffect="non-scaling-stroke" />
        <path d="M1158.5 59L1131 38H1101" stroke={skinBright} strokeOpacity="0.3" vectorEffect="non-scaling-stroke" />

        {/* ── 顶栏分段（中央 → 右） ── */}
        <path d="M455.5 45L462.5 38H472.5" stroke={skinBright} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
        <path d="M472.5 38H1130.5" stroke={skinBright} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
        <path d="M1158.5 43V818.5" stroke={skinBright} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
        <path d="M1154.5 823H1020.5" stroke={skinBright} vectorEffect="non-scaling-stroke" />
        <path d="M58.5 45H456" stroke={skinBright} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />

        {/* ── 左侧 (3, 255.5) 锚点亮点 ── */}
        <circle cx="3" cy="255.5" r="2" fill={anchor} />

        {/* ── 左侧 153~256 渐隐辅线 ── */}
        <path d="M0.5 153.5V256" stroke={skin} strokeOpacity="0.05" vectorEffect="non-scaling-stroke" />
        <path d="M0.5 158V164.5" stroke={skin} strokeOpacity="0.6" vectorEffect="non-scaling-stroke" />
        <path d="M0.5 164.5V174" stroke={skin} strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
        <path d="M0.5 174V182" stroke={skin} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />

        {/* ── 左侧主体段 ── */}
        <path d="M3 257.5V345" stroke={skin} strokeOpacity="0.05" vectorEffect="non-scaling-stroke" />
        <path d="M3 345V727" stroke={skin} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
        <path d="M3 727.5L26 751" stroke={skin} strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />

        {/* ── 底部右下角小台阶 ── */}
        <path d="M918 823L927.5 813H1011L1018.5 823" stroke={skin} strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
        <path d="M1152.5 818.5L1148 823" stroke={skin} vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  )
}
