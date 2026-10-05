// ══════════════════════════════════════════════
// 调色：把任意标签色"调音"到同一套明度 / 彩度上
//
// 五颜六色本身不廉价，廉价的是每个颜色明暗、艳度各不相同（荧光绿、正粉、亮黄抢成一团）。
// 这里在 OKLCH（感知均匀色彩空间）里保留色相——你一眼还认得出是哪一类——
// 但把明度统一、彩度收进一个窄区间：同样的 L/C 在人眼里亮度和艳度真的一样，
// 放在一起就像一套设计过的色板。灰色（原本就没什么彩度）保持中性。
// ══════════════════════════════════════════════

export interface ToneOptions {
  /** 目标明度（OKLCH L，0–1）；深色背景上 0.72–0.8 最耐看 */
  readonly lightness: number
  /** 彩度上限：压住荧光色 */
  readonly maxChroma: number
  /** 彩度下限：灰扑扑的颜色也抬一点，免得和中性灰混淆 */
  readonly minChroma: number
}

/** 标签色块：柔和、等亮 */
export const TAG_TONE: ToneOptions = { lightness: 0.77, maxChroma: 0.115, minChroma: 0.065 }
/** 细管道（应用 / B站轨）：更细所以更亮一点、更艳一点 */
export const PIPE_TONE: ToneOptions = { lightness: 0.8, maxChroma: 0.14, minChroma: 0.08 }

/** 原色彩度低于它就当作"本来就是灰"，保持中性 */
const NEUTRAL_CHROMA = 0.025

type Vec3 = [number, number, number]

function srgbToLinear(c255: number): number {
  const c = c255 / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
}

function parseHex(hex: string): Vec3 | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split('').map((ch) => ch + ch).join('') : m[1]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function linearRgbToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToLinearRgb([L, a, b]: Vec3): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function inGamut([r, g, b]: Vec3): boolean {
  const eps = 1e-4
  return r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps
}

/** OKLCH → hex；超出 sRGB 色域时保持明度和色相、二分降彩度 */
function oklchToHex(L: number, C: number, H: number): string {
  const toLab = (c: number): Vec3 => [L, c * Math.cos(H), c * Math.sin(H)]
  let rgb = oklabToLinearRgb(toLab(C))
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = C
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklabToLinearRgb(toLab(mid)))) lo = mid
      else hi = mid
    }
    rgb = oklabToLinearRgb(toLab(lo))
  }
  return `#${rgb.map((c) => linearToSrgb(c).toString(16).padStart(2, '0')).join('')}`
}

const cache = new Map<string, string>()

/** 调音：保留色相，统一明度、收窄彩度。非法色值原样返回。 */
export function tone(hex: string, opts: ToneOptions = TAG_TONE): string {
  const key = `${hex}|${opts.lightness}|${opts.maxChroma}|${opts.minChroma}`
  const hit = cache.get(key)
  if (hit) return hit
  const rgb = parseHex(hex)
  if (!rgb) return hex
  const [, a, b] = linearRgbToOklab(rgb.map(srgbToLinear) as Vec3)
  const chroma = Math.hypot(a, b)
  const hue = Math.atan2(b, a)
  const targetC = chroma < NEUTRAL_CHROMA
    ? chroma * 0.6
    : Math.min(opts.maxChroma, Math.max(opts.minChroma, chroma * 0.55))
  const out = oklchToHex(opts.lightness, targetC, hue)
  cache.set(key, out)
  return out
}

/** 把颜色往白色混一点（色块上的文字：带一丝本色的亮白） */
export function tintWhite(hex: string, amount = 0.72): string {
  const rgb = parseHex(hex)
  if (!rgb) return '#F4F1EC'
  const mixed = rgb.map((c) => Math.round(c + (255 - c) * amount))
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}
