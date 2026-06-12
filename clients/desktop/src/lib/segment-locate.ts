// ══════════════════════════════════════════════
// 片段定位 — 在语境原文里定位 AI「复制」的片段
//
//   anchor-to-context 要求模型逐字复制原文片段，但小模型常悄悄改标点/空白，
//   indexOf 精确匹配一碰就碎（锚点高亮因此建不成）。这里做归一化模糊定位：
//   ① 精确 indexOf
//   ② 忽略空白+标点后匹配（位置映射回原文）
//   ③ 前缀回退：片段开头一截能对上也算（模型常在片段尾部自由发挥）
//   返回区间是【原文】里的位置；selected_text 应取原文切片，不要用模型副本。
// ══════════════════════════════════════════════

export interface SegmentSpan {
  start: number
  end: number
}

// 归一化时丢弃的字符：空白 + 中英常见标点（模型复制时最爱动的部分）
const IGNORED = /[\s,，.。!！?？;；:：、"“”'‘’「」『』()（）【】[\]《》〈〉—–\-~～·…|]/

function normalize(text: string): { str: string; map: number[] } {
  let str = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (IGNORED.test(ch)) continue
    str += ch
    map.push(i)
  }
  return { str, map }
}

/** 在 haystack 里定位 needle，返回原文坐标区间；定位失败返回 null */
export function locateSegment(haystack: string, needle: string): SegmentSpan | null {
  const seg = needle.trim()
  if (!seg) return null

  // ① 精确匹配
  const exact = haystack.indexOf(seg)
  if (exact >= 0) return { start: exact, end: exact + seg.length }

  // ② 归一化匹配
  const h = normalize(haystack)
  const n = normalize(seg)
  if (n.str.length < 6) return null // 归一化后太短，误中率高，不冒险
  let idx = h.str.indexOf(n.str)
  let matchedLen = n.str.length

  // ③ 前缀回退：整段对不上就试开头一截，区间仍按完整片段长度铺（不越界）
  if (idx < 0) {
    for (const len of [24, 16, 10]) {
      if (n.str.length <= len) continue
      idx = h.str.indexOf(n.str.slice(0, len))
      if (idx >= 0) {
        matchedLen = Math.min(n.str.length, h.str.length - idx)
        break
      }
    }
  }
  if (idx < 0) return null

  return { start: h.map[idx], end: h.map[idx + matchedLen - 1] + 1 }
}
