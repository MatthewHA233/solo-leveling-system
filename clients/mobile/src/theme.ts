// ══════════════════════════════════════════════
// 视觉主题 — 浅色、克制、留白
// ══════════════════════════════════════════════

import { Platform } from 'react-native'

export const theme = {
  bg:        '#F4F4F1',   // 页面底色（暖白）
  surface:   '#FFFFFF',   // 卡面 / 弹层 / 时间轴底
  sunk:      '#EEEDE9',   // 输入框 / 凹陷底
  line:      '#E7E6E1',   // 分隔线 / 小时线
  lineSoft:  '#F0EFEB',   // 更弱的线
  ink:       '#23242A',   // 主文字
  inkSoft:   '#74757C',   // 次要文字
  inkFaint:  '#AEAFB4',   // 弱文字（小时号 / placeholder）
  accent:    '#3E63DD',   // 主强调（今日 / 选中 / 发送）
  accentSoft:'#E9EDFB',
  danger:    '#E5484D',
}

export const fonts = {
  mono: (Platform.select({ ios: 'Menlo', android: 'monospace' }) ?? 'monospace') as string,
}

/** hex → rgba(...)，alpha 0..1 */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

// ── 活动分类配色（中等饱和，浅底上可读，块内配白字）──
export const categoryColors: Record<string, string> = {
  coding:        '#4C86E0',
  learning:      '#3FA86A',
  reading:       '#BE8A4A',
  writing:       '#8A63C9',
  media:         '#D26591',
  communication: '#3DA7A0',
  research:      '#C99A33',
  design:        '#46A86B',
  browsing:      '#D98A3D',
  meeting:       '#7E8590',
  social:        '#3FA0C2',
  idle:          '#AEB0B6',
}

export function getCategoryColor(cat: string): string {
  return categoryColors[cat] ?? theme.inkSoft
}
