export const theme = {
  // ── Core ──
  background:    '#050505',
  electricBlue:  '#00E5FF',
  hotCyan:       '#7DF9FF',
  flameTeal:     '#00FFE0',
  shadowPurple:  '#7000FF',
  deepPurple:    '#3D0B9E',
  expGreen:      '#00FF88',
  dangerRed:     '#FF4444',
  warningOrange: '#FF9933',
  textPrimary:   '#E0F0FF',
  textSecondary: '#8AABB0',
  textMuted:     '#506070',
  // ── Surfaces ──
  glass:         'rgba(255,255,255,0.04)',
  glassHover:    'rgba(0,229,255,0.06)',
  glassBorder:   'rgba(0,229,255,0.12)',
  panel:         'rgba(2, 8, 18, 0.9)',
  panelDeep:     'rgba(4, 10, 26, 0.92)',
  // ── HUD Surfaces ──
  hudFrame:      'rgba(0,229,255,0.35)',       // 主框线（显眼）
  hudFrameSoft:  'rgba(0,229,255,0.18)',       // 次级框线
  hudFill:       'rgba(2, 8, 24, 0.82)',       // HUD 面板底色
  hudFillDeep:   'rgba(6, 4, 30, 0.9)',        // HUD 面板底色（紫调）
  hudHalo:       'rgba(0,229,255,0.12)',       // 外发光
  // ── Neon Divider ──
  divider:       'rgba(0,229,255,0.12)',
  // ── Typography ──
  fontDisplay:   "'Orbitron', sans-serif",
  fontBody:      "'Exo 2', sans-serif",
  fontMono:      "'JetBrains Mono', 'Courier New', monospace",
}

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
  scanlines: `repeating-linear-gradient(
    0deg,
    transparent 0px, transparent 2px,
    rgba(0,229,255,0.035) 2px, rgba(0,229,255,0.035) 3px
  )`,
  // 主 HUD 背景（深紫→黑渐变 + 点阵）
  backdrop: `
    radial-gradient(ellipse at 20% 0%, rgba(112, 0, 255, 0.18) 0%, transparent 55%),
    radial-gradient(ellipse at 80% 100%, rgba(0, 229, 255, 0.10) 0%, transparent 60%),
    linear-gradient(180deg, #070312 0%, #04060E 55%, #020307 100%)
  `,
  // 栅格点阵（低透明，仅背景用）
  grid: `
    linear-gradient(rgba(0,229,255,0.035) 1px, transparent 1px) 0 0 / 32px 32px,
    linear-gradient(90deg, rgba(0,229,255,0.035) 1px, transparent 1px) 0 0 / 32px 32px
  `,
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
