export const theme = {
  // ── Core ──
  background:    '#050505',
  electricBlue:  '#00E5FF',
  shadowPurple:  '#7000FF',
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
  // ── Neon Divider ──
  divider:       'rgba(0,229,255,0.12)',
  // ── Typography ──
  fontDisplay:   "'Orbitron', sans-serif",
  fontBody:      "'Exo 2', sans-serif",
  fontMono:      "'JetBrains Mono', 'Courier New', monospace",
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
