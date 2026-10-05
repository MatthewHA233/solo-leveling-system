// ══════════════════════════════════════════════
// 设计令牌 —— 钛合金机体（2026-09-30 定向）
//   拉丝钛板 + 黑玻璃凹槽 + 实体键 + 点阵 LED；钛白字，唯一强调色是信号橙（LED 的颜色），
//   冷色只留给 Fairy 的「系统时刻」（在听 / 在说）。材质类在 styles/titanium.css。
//   旧令牌名（electricBlue、expGreen…）保留不改，只换值：几千处引用不用动，整体色调一次统一；
//   新代码优先用下面的语义令牌（ink / paper / accent / line / system…）和 ti.*。
// ══════════════════════════════════════════════

const INK = '#0A0A09'
const PAPER = '#E4E0DA'        // 钛白
const PAPER_DIM = '#CBC6BF'
const PAPER_MUTED = '#A8A39C'
const LED = '#FF9A5C'          // 信号橙：LED 读数 / 强调
const LED_BRIGHT = '#FFB98A'
const OK = '#8FD9A0'           // 大面积用的绿（LED 指示灯用 ti.ok 更亮）
const DANGER = '#E8685A'
const SYSTEM = '#9ED8F2'       // 冷色：只用于系统时刻

export const theme = {
  // ── 语义令牌（新代码用这些）──
  ink:           INK,
  paper:         PAPER,
  paperDim:      PAPER_DIM,
  paperMuted:    PAPER_MUTED,
  accent:        LED,
  accentBright:  LED_BRIGHT,
  system:        SYSTEM,
  line:          'rgba(255,255,255,0.08)',
  lineStrong:    'rgba(255,255,255,0.16)',
  surface:       'rgba(255,255,255,0.03)',
  surfaceRaised: 'rgba(255,255,255,0.06)',
  // ── Core（旧名，值已换成钛合金色板）──
  background:    INK,
  electricBlue:  LED,            // 原主强调色 → 信号橙
  hotCyan:       LED_BRIGHT,
  flameTeal:     '#B9C4C9',      // 原 Omni 青 → 冷钢
  shadowPurple:  '#A8A29A',      // 原紫 → 钛灰
  deepPurple:    '#2E2C29',
  expGreen:      OK,
  dangerRed:     DANGER,
  warningOrange: '#F0B25A',
  textPrimary:   PAPER,
  textSecondary: PAPER_DIM,
  textMuted:     PAPER_MUTED,
  // ── Surfaces ──
  glass:         'rgba(255,255,255,0.03)',
  glassHover:    'rgba(255,255,255,0.06)',
  glassBorder:   'rgba(255,255,255,0.09)',
  panel:         'rgba(22,21,19,0.96)',
  panelDeep:     'rgba(16,15,14,0.97)',
  // ── HUD Surfaces（手绘 HUD 框已撤出常驻界面，这些只剩细线和底色的用途）──
  hudFrame:      'rgba(255,255,255,0.14)',
  hudFrameSoft:  'rgba(255,255,255,0.08)',
  hudFill:       'rgba(20,19,17,0.94)',
  hudFillDeep:   'rgba(14,13,12,0.96)',
  hudHalo:       'rgba(255,138,76,0.06)',
  divider:       'rgba(255,255,255,0.08)',
  // ── Typography ──
  // 标题/数字用科技字 Chakra Petch（中文回落雅黑）；读数用点阵 Doto；正文系统中文无衬线；
  // 衬线只留给动机云里「你自己的话」
  fontSerif:     "'Noto Serif SC', 'Songti SC', 'SimSun', serif",
  fontDisplay:   "'Chakra Petch', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
  fontTech:      "'Chakra Petch', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
  fontLed:       "'Doto', 'JetBrains Mono', monospace",
  fontBody:      "'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans SC', sans-serif",
  fontMono:      "'JetBrains Mono', 'Cascadia Mono', 'Consolas', monospace",
}

// ── 钛合金材质的颜色（与 styles/titanium.css 的 --ti-* 同值，给需要在 TS 里拼色的地方用）──
export const ti = {
  plate:     '#1A1917',
  well:      '#070706',
  text:      PAPER,
  textDim:   PAPER_DIM,
  textMuted: PAPER_MUTED,
  textFaint: '#8E8982',
  led:       '#FF8A4C',
  ledHi:     LED,
  ledOff:    '#3E3A36',
  ok:        '#9BF0A8',
  sys:       SYSTEM,
} as const

// ── 钛合金表面：弹窗 / 浮层直接拿来用（和 styles/titanium.css 的 .ti-plate / .ti-well 同一套）──
const BRUSHED = 'repeating-linear-gradient(90deg, rgba(255,255,255,0.014) 0 1px, transparent 1px 2px, rgba(0,0,0,0.035) 2px 3px, transparent 3px 5px)'
/** 弹窗 / 浮层的切削倒角（和主面板 ChassisPlate 同一节奏）：最外 1px 亮沿 + 紧贴一道暗沿，上沿再多一道受光 */
const EDGE_BEVEL = 'inset 0 1px 0 rgba(255,255,255,0.22), inset 0 0 0 1px rgba(255,255,255,0.1), inset 0 0 0 2.5px rgba(0,0,0,0.78), inset 0 -1px 0 rgba(0,0,0,0.85)'
export const tiSurface = {
  /** 钛板：拉丝 + 上沿受光、下沿压暗 */
  plate: `${BRUSHED}, linear-gradient(180deg, rgba(255,255,255,0.035), rgba(0,0,0,0.14)), #1A1917`,
  /** 大弹窗：上沿高光 + 下沿暗边 + 深投影 */
  plateShadow: `${EDGE_BEVEL}, 0 24px 70px rgba(0,0,0,0.75)`,
  /** 浮层 / 小弹窗 */
  popShadow: `${EDGE_BEVEL}, 0 10px 30px rgba(0,0,0,0.7)`,
  /** 黑玻璃槽（输入框、读数） */
  well: '#070706',
  wellShadow: 'inset 0 1px 4px rgba(0,0,0,0.95), inset 0 0 0 1px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.11)',
} as const

/** 弹窗标题：粗斜体钛白字（和主面板凸台上的视图名一致） */
export const tiTitle = {
  color: PAPER,
  fontSize: 15,
  fontWeight: 900,
  fontStyle: 'italic',
  letterSpacing: '0.08em',
} as const

/** 实体键（内联样式版，和 .ti-key 同一套）：亮键体 + 深色描边 + 上沿高光 */
export const tiKey = {
  border: 'none',
  borderRadius: 5,
  background: 'linear-gradient(180deg, #3A3733, #26241F)',
  boxShadow: '0 0 0 1px #080807, inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -2px 0 rgba(0,0,0,0.35), 0 3px 5px rgba(0,0,0,0.55)',
} as const

/** 输入框 / 文本框：下沉的黑玻璃槽 */
export const tiInput = {
  background: tiSurface.well,
  border: 'none',
  boxShadow: tiSurface.wellShadow,
  borderRadius: 5,
  color: PAPER,
  outline: 'none',
} as const

// ── HUD 视觉常量 ──
export const hud = {
  // 8px 切角（八角形）
  chamfer8: `polygon(
    8px 0, calc(100% - 8px) 0,
    100% 8px, 100% calc(100% - 8px),
    calc(100% - 8px) 100%, 8px 100%,
    0 calc(100% - 8px), 0 8px
  )`,
  // 12px 切角
  chamfer12: `polygon(
    12px 0, calc(100% - 12px) 0,
    100% 12px, 100% calc(100% - 12px),
    calc(100% - 12px) 100%, 12px 100%,
    0 calc(100% - 12px), 0 12px
  )`,
  // 仅顶部切角（右下直角用于底部黏合）
  chamferTop: `polygon(
    8px 0, calc(100% - 8px) 0,
    100% 8px, 100% 100%,
    0 100%, 0 8px
  )`,
  // 扫描线叠加（~45deg 静态 + 横向 1px 周期）
  // 扫描线已退役（暖调克制方向不要"屏幕感"纹理），保留键名兼容旧引用
  scanlines: 'none',
  // 主 HUD 背景：去掉了原本的紫色/cyan 径向光晕，纯中性深黑底
  //   科学仪器极简主义 — 让 HUD 描线主导视觉，背景不喧宾夺主
  backdrop: `repeating-linear-gradient(135deg, rgba(255,255,255,0.022) 0 2px, transparent 2px 9px), radial-gradient(ellipse 70% 40% at 50% -8%, rgba(255,245,230,0.05), transparent 70%), #0A0A09`,
  // 背景点阵（极淡中性白点）
  grid: `radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px) 0 0 / 28px 28px`,
}

// ── Difficulty Colors ──
export const difficultyColors: Record<string, string> = {
  E: '#7f8c8d', D: '#2ecc71', C: '#00E5FF',
  B: '#7000FF', A: '#FF9933', S: '#FF4444',
}

export const categoryColors: Record<string, string> = {
  coding:        '#00b4ff',
  writing:       '#9b59b6',
  learning:      '#00ff88',
  browsing:      '#f39c12',
  design:        '#2ecc71',
  research:      '#f1c40f',
  communication: '#1abc9c',
  reading:       '#9b7653',
  meeting:       '#7f8c8d',
  media:         '#e91e8c',
  social:        '#00ffff',
  idle:          '#666688',
}

export const categoryLabels: Record<string, string> = {
  coding: '编程', writing: '写作', learning: '学习',
  browsing: '浏览', design: '设计', research: '调研',
  communication: '沟通', reading: '阅读', meeting: '会议',
  media: '媒体', social: '社交', idle: '空闲',
}

export function getCategoryColor(cat: string): string {
  return categoryColors[cat] ?? theme.textSecondary
}

export function getCategoryLabel(cat: string): string {
  return categoryLabels[cat] ?? cat
}
