// 梦想记事本的手感素材：纸色、纸纹、蜡笔痕（荧光涂抹 / 划线 / 圈，横写竖写各一套）、坐标十字、印章磨损、竹枝。
// 都是内联 SVG：蜡笔颗粒 = 噪声挖掉一部分颜料，再用低频噪声把笔画边缘推毛。挂在开局根节点上，样式表里用 var() 取

import type { CSSProperties } from 'react'

/** 便利贴纸色：按顺序轮着贴 */
export const PAPERS: readonly string[] = ['#EEDC98', '#F0C7B9', '#CDE2C3', '#C7DAEA', '#E8D2AE']
/** 七夕短笺的五色：青、赤、黄、白、紫 */
export const STRIP_PAPERS: readonly string[] = ['#CBDDBF', '#EDC2B2', '#EEDC98', '#F0ECE2', '#D6CBE4']

const HIGHLIGHT_INK = '#FF7429'
const PEN_INK = '#B8322A'
const BLUE_INK = '#2C4F86'
const BAMBOO = '#7F9257'

const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`

/** 同一段话每次的角度、高低都一样（不随刷新乱跳） */
export function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** 按种子给一个 [-range, range] 的小抖动 */
export const jitter = (seed: number, range: number, shift = 0) => (((seed >>> shift) % 1000) / 1000) * range * 2 - range

/** 蜡笔颗粒：颜料按噪声剥落、边缘发毛；grain 是颗粒的走向（横写横着拉、竖写竖着拉） */
const crayon = (grain: string) => `<filter id='c' x='-30%' y='-30%' width='160%' height='160%'>
<feTurbulence type='fractalNoise' baseFrequency='${grain}' numOctaves='2' seed='7' result='n'/>
<feColorMatrix in='n' type='matrix' values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.1 1.7' result='a'/>
<feComposite in='SourceGraphic' in2='a' operator='in' result='g'/>
<feTurbulence type='fractalNoise' baseFrequency='0.05' numOctaves='2' seed='3' result='w'/>
<feDisplacementMap in='g' in2='w' scale='3'/>
</filter>`
const H = crayon('1.1 0.5')
const V = crayon('0.5 1.1')

/** 荧光涂抹：两遍来回涂，两头毛糙 */
const HIGHLIGHT = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 40' preserveAspectRatio='none'>${H}
<g filter='url(#c)' fill='${HIGHLIGHT_INK}'>
<path fill-opacity='0.6' d='M3 11 C40 6 92 10 132 7 S186 8 197 10 L195 31 C158 35 108 31 68 34 S18 32 5 30 Z'/>
<path fill-opacity='0.4' d='M9 15 C62 12 122 15 191 13 L189 27 C128 29 70 26 10 28 Z'/>
</g></svg>`
const HIGHLIGHT_V = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 200' preserveAspectRatio='none'>${V}
<g filter='url(#c)' fill='${HIGHLIGHT_INK}'>
<path fill-opacity='0.6' d='M5 3 C2 40 5 92 3 132 S4 186 6 197 L35 195 C38 158 35 108 37 68 S36 18 34 5 Z'/>
<path fill-opacity='0.4' d='M10 9 C8 62 10 122 9 191 L31 189 C33 128 30 70 32 10 Z'/>
</g></svg>`

/** 划线：手抖的一笔（竖写时画在字的右边） */
const UNDERLINE = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 12' preserveAspectRatio='none'>${H}
<path filter='url(#c)' d='M2 7 C40 4 82 9 122 6 S178 5 198 8' fill='none' stroke='${PEN_INK}' stroke-opacity='0.85' stroke-width='2.8' stroke-linecap='round'/></svg>`
const SIDELINE = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 200' preserveAspectRatio='none'>${V}
<path filter='url(#c)' d='M7 2 C4 40 9 82 6 122 S5 178 8 198' fill='none' stroke='${PEN_INK}' stroke-opacity='0.85' stroke-width='2.8' stroke-linecap='round'/></svg>`

/** 圈：没闭合、尾巴甩出去的一圈 */
const CIRCLE = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 60' preserveAspectRatio='none'>${H}
<path filter='url(#c)' d='M16 36 C9 17 42 6 70 7 C99 8 117 21 112 35 C107 49 79 55 55 54 C29 53 7 45 12 30 C15 21 26 15 37 12' fill='none' stroke='${PEN_INK}' stroke-opacity='0.85' stroke-width='2.4' stroke-linecap='round'/></svg>`

/** 坐标：钢笔画的一个小十字准星 */
const CROSS = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>${H}
<g filter='url(#c)' fill='none' stroke='${BLUE_INK}' stroke-width='1.7' stroke-linecap='round'>
<path d='M12.4 6.2 C15.8 6 18.2 8.6 17.9 12.1 C17.6 15.6 15 18 11.7 17.8 C8.4 17.6 6 15.1 6.2 11.8 C6.4 8.9 8.4 6.8 10.6 6.4'/>
<path d='M12 1.8 L12.2 9.4 M12.1 14.6 L11.9 22.2 M1.8 12.1 L9.4 11.9 M14.6 12 L22.2 12.2'/>
</g></svg>`

/** 竹枝：一笔拖过去，三个竹节 */
const BAMBOO_POLE = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 24' preserveAspectRatio='none'>${H}
<g filter='url(#c)' stroke='${BAMBOO}' stroke-linecap='round' fill='none'>
<path stroke-width='7' d='M4 13 C120 9 260 14 400 11 S560 12 596 9'/>
<path stroke-width='2' stroke-opacity='0.8' d='M150 6 L151 19 M330 6 L329 19 M500 5 L501 18'/>
</g></svg>`

/** 纸纹：很淡的纤维噪点 */
const PAPER_GRAIN = `<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='p'>
<feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/>
<feColorMatrix values='0 0 0 0 0.32  0 0 0 0 0.27  0 0 0 0 0.2  0 0 0 0.1 0'/></filter>
<rect width='100%' height='100%' filter='url(#p)'/></svg>`

/** 印章磨损：当遮罩用，盖出来的红有一块没一块 */
const STAMP_WEAR = `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='w'>
<feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='11' stitchTiles='stitch'/>
<feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.6 2.2'/></filter>
<rect width='100%' height='100%' filter='url(#w)'/></svg>`

/** 挂在开局根节点上 */
export const INK_VARS = {
  '--ink-hl': svgUrl(HIGHLIGHT),
  '--ink-hl-v': svgUrl(HIGHLIGHT_V),
  '--ink-ul': svgUrl(UNDERLINE),
  '--ink-side': svgUrl(SIDELINE),
  '--ink-circle': svgUrl(CIRCLE),
  '--ink-cross': svgUrl(CROSS),
  '--ink-bamboo': svgUrl(BAMBOO_POLE),
  '--ink-grain': svgUrl(PAPER_GRAIN),
  '--ink-wear': svgUrl(STAMP_WEAR),
} as CSSProperties
