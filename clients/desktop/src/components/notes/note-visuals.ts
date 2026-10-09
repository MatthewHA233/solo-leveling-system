// ══════════════════════════════════════════════
// 笔记的视觉素材：页面图标（emoji 分组）、封面预设、提示框色调
//   封面存成 preset:{key}（预设）或 note-asset://{文件}（上传的图）；颜色都是钛合金色板里的「宝石色」，深而浓
// ══════════════════════════════════════════════

import { resolveNoteAssetUrl } from '../../lib/notes-api'

export interface EmojiGroup {
  readonly label: string
  readonly items: readonly string[]
}

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    label: '常用',
    items: ['📄', '📝', '📌', '📎', '📚', '📖', '🗂️', '🗃️', '📁', '📊', '📈', '🧠', '💡', '🎯', '🔥', '⚡', '🚀', '🛠️', '⚙️', '🔧', '🧪', '🔬', '🧭', '🗺️', '⏳', '⏰', '📅', '✅', '☑️', '❗', '❓', '💬', '🔒', '🔑', '🏷️', '🎨', '🎬', '🎧', '🎮', '🧩'],
  },
  {
    label: '人与心情',
    items: ['😀', '😄', '😊', '🙂', '😎', '🤔', '😴', '😤', '😭', '🥳', '🤯', '😌', '🙏', '👍', '👀', '💪', '🧘', '🏃', '✍️', '🫡'],
  },
  {
    label: '自然',
    items: ['🌱', '🌿', '🍀', '🌳', '🌲', '🌵', '🌸', '🌻', '🍁', '🌊', '🌙', '☀️', '⭐', '🌟', '☁️', '🌧️', '❄️', '🌈', '🔭', '🪐'],
  },
  {
    label: '生活',
    items: ['☕', '🍵', '🍜', '🍎', '🍰', '🏠', '🏢', '🏫', '🏥', '🚗', '✈️', '🚲', '💰', '💳', '🛒', '🎁', '📦', '🧾', '💊', '🏋️'],
  },
  {
    label: '符号',
    items: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '⬛', '🟧', '🟩', '🟦', '🟪', '🔶', '🔷', '⭕', '❌', '➕', '♻️', '🔺'],
  },
]

const ALL_EMOJI = EMOJI_GROUPS.flatMap((g) => g.items)

export function randomEmoji(): string {
  return ALL_EMOJI[Math.floor(Math.random() * ALL_EMOJI.length)] ?? '📄'
}

// ── 封面 ──

export interface CoverPreset {
  readonly key: string
  readonly label: string
  readonly css: string
}

export const COVER_PRESETS: readonly CoverPreset[] = [
  { key: 'ember', label: '余烬', css: 'radial-gradient(120% 160% at 88% 0%, #FF9A5C 0%, #B4471C 30%, #2A140B 68%, #0E0907 100%)' },
  { key: 'titanium', label: '钛板', css: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 3px), linear-gradient(115deg, #3A3733 0%, #1E1D1B 42%, #4A4640 68%, #1C1B19 100%)' },
  { key: 'glacier', label: '冰川', css: 'radial-gradient(120% 160% at 15% 0%, #9ED8F2 0%, #2E6C86 30%, #0F222C 70%, #070B0E 100%)' },
  { key: 'moss', label: '苔原', css: 'radial-gradient(120% 160% at 80% 10%, #8FD9A0 0%, #2F6B3E 32%, #10241A 70%, #070C09 100%)' },
  { key: 'dusk', label: '暮紫', css: 'radial-gradient(120% 160% at 20% 100%, #C9A6F0 0%, #5B3C86 32%, #1C1428 70%, #0A080E 100%)' },
  { key: 'sand', label: '砂岩', css: 'linear-gradient(160deg, #F0C27A 0%, #8A5E2C 38%, #2C1F12 75%, #120D08 100%)' },
  { key: 'signal', label: '警示', css: 'repeating-linear-gradient(135deg, #FF8A4C 0 16px, #141311 16px 32px)' },
  { key: 'ink', label: '墨夜', css: 'radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px) 0 0 / 18px 18px, linear-gradient(180deg, #161514, #0A0A09)' },
]

/** 封面值 → CSS background；没有封面返回 null */
export function coverBackground(cover: string | null): string | null {
  if (!cover) return null
  if (cover.startsWith('preset:')) {
    return COVER_PRESETS.find((p) => p.key === cover.slice(7))?.css ?? COVER_PRESETS[0].css
  }
  return `center / cover no-repeat url("${resolveNoteAssetUrl(cover).replace(/"/g, '%22')}")`
}

// ── 提示框色调 ──

export const CALLOUT_TONES = ['amber', 'steel', 'green', 'blue', 'red'] as const
export type CalloutTone = (typeof CALLOUT_TONES)[number]

export const CALLOUT_TONE_LABEL: Record<CalloutTone, string> = {
  amber: '琥珀', steel: '钛灰', green: '苔绿', blue: '冰蓝', red: '警红',
}

export const CALLOUT_TONE_COLOR: Record<CalloutTone, string> = {
  amber: '#FF9A5C', steel: '#B9C4C9', green: '#8FD9A0', blue: '#9ED8F2', red: '#E8685A',
}
