export const theme = {
  background: '#0a0a0f',
  electricBlue: '#00b4ff',
  shadowPurple: '#9b59b6',
  expGreen: '#00ff88',
  textPrimary: '#e8e8f0',
  textSecondary: '#666688',
}

export const categoryColors: Record<string, string> = {
  coding:        '#00b4ff',  // electricBlue
  writing:       '#9b59b6',  // shadowPurple
  learning:      '#00ff88',  // expGreen
  browsing:      '#f39c12',  // orange
  design:        '#2ecc71',  // mint
  research:      '#f1c40f',  // yellow
  communication: '#1abc9c',  // teal
  reading:       '#9b7653',  // brown
  meeting:       '#7f8c8d',  // gray
  media:         '#e91e8c',  // pink
  social:        '#00ffff',  // cyan
  idle:          '#666688',  // textSecondary
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
