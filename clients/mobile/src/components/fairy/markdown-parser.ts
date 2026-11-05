// ══════════════════════════════════════════════
// Fairy 回复的 markdown 解析（纯函数，不依赖 React Native，可以直接用 node 跑）
//
// 支持范围以桌面端 FairyMarkdown.tsx 的配置为准：
//   · remark-gfm：表格 / 删除线（只认 ~~，见下）/ 任务勾选框 / 裸链接 / 脚注
//   · remark-breaks：单个换行就换行
//   · remark-cjk-friendly：星号贴着中文标点时也能加粗（flanking 规则照搬 micromark-extension-cjk-friendly）
//   · 原始 HTML 不执行，只当文字
//
// 桌面端用 remark，手机端不能装依赖，这里按 CommonMark 的块 / 行内算法手写。
// 流式（streaming: true）多做两件事，正文写到一半时不崩、不闪：
//   1. 最后一行如果还只是半截块标记（`-`、`##`、`1.`、`` `` ``），先不显示
//   2. 最后一段里没闭合的 **粗体** / `代码` / [链接文字](半截网址 按已闭合渲染，
//      行尾孤零零的 `**`、`~`、`[`、`&am` 也先不显示
// ══════════════════════════════════════════════

export type MdInline =
  /** literal=true：原样文字（夹带的 HTML 标签），不再扫描裸链接 */
  | { type: 'text'; text: string; literal?: boolean }
  | { type: 'strong' | 'em' | 'del'; children: MdInline[] }
  | { type: 'code'; text: string }
  /** href 为空串 = 流式时网址还没写完，渲染成链接样式但不可点 */
  | { type: 'link'; href: string; title?: string; children: MdInline[]; auto?: boolean }
  | { type: 'image'; src: string; alt: string; title?: string }
  | { type: 'break' }
  | { type: 'footnoteRef'; index: number }

export type MdAlign = 'left' | 'center' | 'right' | null

export interface MdListItem {
  /** null = 普通列表项；true/false = 任务项 */
  checked: boolean | null
  children: MdBlock[]
}

export type MdBlock =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'heading'; level: number; children: MdInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: MdBlock[] }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'hr' }
  | { type: 'table'; align: MdAlign[]; header: MdInline[][]; rows: MdInline[][][] }
  /** 原始 HTML 块：不执行，原样当文字显示 */
  | { type: 'html'; text: string }
  | { type: 'footnotes'; items: { index: number; children: MdBlock[] }[] }

export interface ParseOptions {
  /** 正文还在流式输出：放宽结尾的半截语法，见文件头 */
  streaming?: boolean
}

// 超长段落不做行内解析（防御极端输入把 JS 线程卡住）
const MAX_INLINE_LEN = 120_000
const MAX_DEPTH = 24

// ── 字符分类 ──

function buildPunctRe(): RegExp | null {
  // Hermes 不同版本对 Unicode 属性转义的支持不一：用构造函数探测，失败就退到下面的区段表
  try { return new RegExp('\\p{P}|\\p{S}', 'u') } catch { return null }
}
const PUNCT_RE = buildPunctRe()

/** Unicode 标点或符号（对应 micromark 的 unicodePunctuation） */
export function isUnicodePunct(cp: number): boolean {
  if (cp < 0x80) {
    return (cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40) || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e)
  }
  if (PUNCT_RE) return PUNCT_RE.test(String.fromCodePoint(cp))
  return (
    (cp >= 0xa1 && cp <= 0xbf && cp !== 0xaa && cp !== 0xb2 && cp !== 0xb3 && cp !== 0xb5 && cp !== 0xb9 && cp !== 0xba && cp !== 0xbc && cp !== 0xbd && cp !== 0xbe) ||
    cp === 0xd7 || cp === 0xf7 ||
    (cp >= 0x2010 && cp <= 0x2027) || (cp >= 0x2030 && cp <= 0x205e) ||
    (cp >= 0x20a0 && cp <= 0x20c0) || (cp >= 0x2190 && cp <= 0x2bff) ||
    (cp >= 0x3001 && cp <= 0x3004) || (cp >= 0x3008 && cp <= 0x3020) || cp === 0x3030 || cp === 0x303d || cp === 0x30fb ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6b) ||
    (cp >= 0xff01 && cp <= 0xff0f) || (cp >= 0xff1a && cp <= 0xff20) || (cp >= 0xff3b && cp <= 0xff40) || (cp >= 0xff5b && cp <= 0xff65) ||
    (cp >= 0xffe0 && cp <= 0xffee) || (cp >= 0x1f000 && cp <= 0x1faff)
  )
}

function isWhitespaceCode(cp: number): boolean {
  return (
    cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d || cp === 0xa0 ||
    cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f ||
    cp === 0x205f || cp === 0x3000 || cp === 0xfeff
  )
}

/**
 * CJK 字符的闭区间表（成对：起点, 终点）。
 * 由桌面端依赖 micromark-extension-cjk-friendly-util@3.0.1 的 classifyCharacter + isCjk 对全部码位跑出来再合并，
 * 对照结果逐码位一致。依赖升级、Unicode 版本变化时可能有个别码位差异，只影响星号贴这些字时能不能加粗。
 */
const CJK_RANGES: readonly number[] = [
  0x1100,0x11ff, 0x20a9,0x20a9, 0x2329,0x232a, 0x2630,0x2637, 0x268a,0x268f, 0x2e80,0x2e99,
  0x2e9b,0x2ef3, 0x2f00,0x2fd5, 0x2ff0,0x2fff, 0x3001,0x303e, 0x3041,0x3096, 0x3099,0x30ff,
  0x3105,0x312f, 0x3131,0x318e, 0x3190,0x31e5, 0x31ef,0x321e, 0x3220,0x3247, 0x3250,0xa48c,
  0xa490,0xa4c6, 0xa960,0xa97c, 0xac00,0xd7a3, 0xd7b0,0xd7c6, 0xd7cb,0xd7fb, 0xf900,0xfaff,
  0xfe10,0xfe19, 0xfe30,0xfe52, 0xfe54,0xfe66, 0xfe68,0xfe6b, 0xff01,0xffbe, 0xffc2,0xffc7,
  0xffca,0xffcf, 0xffd2,0xffd7, 0xffda,0xffdc, 0xffe0,0xffe6, 0xffe8,0xffee, 0x16fe0,0x16fe4,
  0x16ff0,0x16ff6, 0x17000,0x18cda, 0x18cff,0x18d20, 0x18d80,0x18df2, 0x18e00,0x19191, 0x191a0,0x191d2,
  0x1aff0,0x1aff3, 0x1aff5,0x1affb, 0x1affd,0x1affe, 0x1b000,0x1b128, 0x1b132,0x1b132, 0x1b150,0x1b152,
  0x1b155,0x1b155, 0x1b164,0x1b168, 0x1b170,0x1b2fb, 0x1d300,0x1d356, 0x1d360,0x1d376, 0x1f1ae,0x1f1ae,
  0x1f200,0x1f200, 0x1f202,0x1f202, 0x1f210,0x1f219, 0x1f21b,0x1f22e, 0x1f230,0x1f231, 0x1f237,0x1f237,
  0x1f23b,0x1f23b, 0x1f240,0x1f248, 0x1f260,0x1f265, 0x1f6d8,0x1f6d9, 0x1f7da,0x1f7da, 0x1fa8a,0x1fa8e,
  0x1fac8,0x1fac8, 0x1facc,0x1facd, 0x1fadd,0x1fadd, 0x1faea,0x1faeb, 0x1faef,0x1faef, 0x1faf9,0x1fafa,
  0x20000,0x2fffd, 0x30000,0x3fffd,
]

export function isCjkCode(cp: number): boolean {
  if (cp < 0x1100) return false
  let lo = 0
  let hi = CJK_RANGES.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cp < CJK_RANGES[mid * 2]) hi = mid - 1
    else if (cp > CJK_RANGES[mid * 2 + 1]) lo = mid + 1
    else return true
  }
  return false
}

function isIvsCode(cp: number): boolean { return cp >= 0xe0100 && cp <= 0xe01ef }
function isGeneralVs(cp: number): boolean { return cp >= 0xfe00 && cp <= 0xfe0e }

function codeBefore(s: string, pos: number): number {
  if (pos <= 0) return -1
  const c = s.charCodeAt(pos - 1)
  if (c >= 0xdc00 && c <= 0xdfff && pos >= 2) {
    const h = s.charCodeAt(pos - 2)
    if (h >= 0xd800 && h <= 0xdbff) return (h - 0xd800) * 0x400 + (c - 0xdc00) + 0x10000
  }
  return c
}

function codeAt(s: string, pos: number): number {
  if (pos >= s.length) return -1
  return s.codePointAt(pos) ?? -1
}

const WS = (cp: number) => cp === -1 || isWhitespaceCode(cp)
const NON_CJK_PUNCT = (cp: number) => cp !== -1 && isUnicodePunct(cp) && !isCjkCode(cp)

// ── 字符引用 ──

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  times: '×', divide: '÷', plusmn: '±', middot: '·', bull: '•', deg: '°', yen: '¥', euro: '€', pound: '£', cent: '¢',
  sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', le: '≤', ge: '≥', ne: '≠', infin: '∞',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', iexcl: '¡', iquest: '¿', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', agrave: 'à', aacute: 'á', egrave: 'è', eacute: 'é', ouml: 'ö', uuml: 'ü', auml: 'ä',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwj: '\u200d', zwnj: '\u200c', shy: '\u00ad',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', mu: 'μ', lambda: 'λ',
  check: '✓', cross: '✗', star: '☆', hearts: '♥',
}

function decodeEntity(body: string): string | null {
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X'
    const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
    if (!Number.isFinite(n)) return null
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd'
    return String.fromCodePoint(n)
  }
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : null
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/

/** 链接地址 / 标题 / 代码块语言里的反斜杠转义 + 字符引用 */
function unescapeString(s: string): string {
  if (s.indexOf('\\') < 0 && s.indexOf('&') < 0) return s
  return s.replace(/\\([!-/:-@[-`{-~])|&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, esc, ent) => {
    if (esc) return esc
    return decodeEntity(ent) ?? m
  })
}

// ── 块级：行工具 ──

function isBlank(line: string): boolean { return /^[ \t]*$/.test(line) }

function indentOf(line: string): number {
  let col = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === ' ') col++
    else if (c === '\t') col += 4 - (col % 4)
    else break
  }
  return col
}

/** 去掉前 n 列缩进；制表符跨界时把剩余部分补回空格 */
function stripIndent(line: string, n: number): string {
  let col = 0
  let i = 0
  while (i < line.length && col < n) {
    const c = line[i]
    if (c === ' ') col++
    else if (c === '\t') col += 4 - (col % 4)
    else break
    i++
  }
  return (col > n ? ' '.repeat(col - n) : '') + line.slice(i)
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const HR_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/
const QUOTE_RE = /^ {0,3}>/
const FOOTNOTE_DEF_RE = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

interface FenceMatch { indent: number; marker: string; info: string }

function matchFence(line: string): FenceMatch | null {
  const m = FENCE_RE.exec(line)
  if (!m) return null
  // 反引号围栏的信息串里不能再有反引号（否则是行内代码）
  if (m[1][0] === '`' && m[2].indexOf('`') >= 0) return null
  return { indent: indentOf(line), marker: m[1], info: m[2].trim() }
}

function isFenceClose(line: string, open: FenceMatch): boolean {
  if (indentOf(line) >= 4) return false
  const t = line.trim()
  if (t.length < open.marker.length) return false
  for (let i = 0; i < t.length; i++) if (t[i] !== open.marker[0]) return false
  return true
}

interface ListMarker {
  ordered: boolean
  /** 无序：符号本身；有序：分隔符 . 或 ) */
  delim: string
  start: number
  /** 内容相对行首的列数 */
  contentOffset: number
  rest: string
}

function matchListMarker(line: string): ListMarker | null {
  const indent = indentOf(line)
  if (indent >= 4) return null
  const body = line.slice(line.length - line.trimStart().length)
  let ordered = false
  let delim = ''
  let start = 1
  let markerLen = 0
  const c = body[0]
  if (c === '-' || c === '+' || c === '*') {
    delim = c
    markerLen = 1
  } else {
    const m = /^(\d{1,9})([.)])/.exec(body)
    if (!m) return null
    ordered = true
    delim = m[2]
    start = parseInt(m[1], 10)
    markerLen = m[0].length
  }
  const after = body.slice(markerLen)
  if (after.length > 0 && after[0] !== ' ' && after[0] !== '\t') return null
  const markerEnd = indent + markerLen
  let col = markerEnd
  let j = 0
  while (j < after.length && (after[j] === ' ' || after[j] === '\t')) {
    col += after[j] === '\t' ? 4 - (col % 4) : 1
    j++
  }
  const spaces = col - markerEnd
  if (j === after.length) return { ordered, delim, start, contentOffset: markerEnd + 1, rest: '' }
  if (spaces >= 5) return { ordered, delim, start, contentOffset: markerEnd + 1, rest: ' '.repeat(spaces - 1) + after.slice(j) }
  return { ordered, delim, start, contentOffset: col, rest: after.slice(j) }
}

const HTML_BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'
const HTML_ATTR = '(?:[ \\t]+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:[ \\t]*=[ \\t]*(?:[^ \\t"\'=<>`]+|\'[^\']*\'|"[^"]*"))?)'
const HTML_START: readonly [RegExp, RegExp | null][] = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![a-zA-Z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[ \\t]|/?>|$)`, 'i'), null],
]
const HTML_COMPLETE_TAG = new RegExp(`^ {0,3}(?:<[a-zA-Z][a-zA-Z0-9-]*${HTML_ATTR}*[ \\t]*/?>|</[a-zA-Z][a-zA-Z0-9-]*[ \\t]*>)[ \\t]*$`)

/** 这一行能否打断正在写的段落 */
function interruptsParagraph(line: string): boolean {
  if (indentOf(line) >= 4) return false
  if (matchFence(line) || ATX_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)) return true
  if (HTML_START.some(([re]) => re.test(line))) return true
  const marker = matchListMarker(line)
  // 空列表项、不从 1 开始的有序列表不能打断段落
  if (marker && marker.rest.trim() !== '' && (!marker.ordered || marker.start === 1)) return true
  return FOOTNOTE_DEF_RE.test(line)
}

/**
 * 惰性续行判定：容器里最后一行还是段落，下一行没有容器前缀也算这段的延续。
 * 只看行形状（不重新解析整个容器），足够覆盖模型实际写出来的内容。
 */
function tailIsParagraph(lines: readonly string[]): boolean {
  if (lines.length === 0) return false
  let fence: FenceMatch | null = null
  for (const l of lines) {
    if (fence) {
      if (isFenceClose(l, fence)) fence = null
    } else {
      fence = matchFence(l.replace(/^[ \t]*(?:>[ \t]?)*[ \t]*/, ''))
    }
  }
  if (fence) return false
  let last = lines[lines.length - 1]
  if (isBlank(last)) return false
  // 剥掉行首的容器前缀，再看剩下的内容
  for (let guard = 0; guard < MAX_DEPTH; guard++) {
    const q = /^ {0,3}>[ \t]?/.exec(last)
    if (q) { last = last.slice(q[0].length); continue }
    const m = matchListMarker(last)
    if (m && !HR_RE.test(last)) { last = m.rest; continue }
    break
  }
  if (isBlank(last) || indentOf(last) >= 4) return false
  if (ATX_RE.test(last) || HR_RE.test(last) || matchFence(last)) return false
  if (HTML_START.some(([re]) => re.test(last)) || HTML_COMPLETE_TAG.test(last)) return false
  return true
}

/** 惰性续行只能是段落文字：长得像 setext 下划线 / 表格分隔行时转义掉，避免递归解析时被认成块结构 */
function asLazyLine(line: string): string {
  const t = line.trimStart()
  return /^(?:=+|-+)[ \t]*$/.test(t) || TABLE_DELIM_RE.test(t) ? `\\${t}` : t
}

// ── 块级：表格 ──

function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s[0] === '|') s = s.slice(1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1]
      i++
      continue
    }
    if (c === '|') {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim() !== '' || cells.length === 0) cells.push(cur)
  return cells.map((x) => x.trim())
}

function isTableStart(lines: readonly string[], i: number): boolean {
  if (i + 1 >= lines.length) return false
  const head = lines[i]
  const delim = lines[i + 1]
  if (indentOf(head) >= 4 || isBlank(head) || !TABLE_DELIM_RE.test(delim)) return false
  // 分隔行既没有竖线也没有冒号时是 setext 标题下划线（`a\n---`），表头本身不要求有竖线
  if (!/[|:]/.test(delim)) return false
  return splitTableRow(head).length === splitTableRow(delim).length
}

function delimAlign(cell: string): MdAlign {
  const l = cell[0] === ':'
  const r = cell[cell.length - 1] === ':'
  if (l && r) return 'center'
  if (l) return 'left'
  if (r) return 'right'
  return null
}

// ── 块级：引用定义 ──

interface LinkRef { href: string; title?: string }

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase()
}

/** 解析链接目标；返回 [地址, 结束位置]，失败返回 null */
function parseLinkDestination(s: string, start: number): [string, number] | null {
  let i = start
  if (s[i] === '<') {
    i++
    while (i < s.length) {
      const c = s[i]
      if (c === '\n' || c === '<') return null
      if (c === '>') return [unescapeString(s.slice(start + 1, i)), i + 1]
      if (c === '\\') i++
      i++
    }
    return null
  }
  let depth = 0
  while (i < s.length) {
    const c = s[i]
    const code = s.charCodeAt(i)
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) { i += 2; continue }
    if (code <= 0x20 || code === 0x7f) break
    if (c === '(') {
      depth++
      if (depth > 32) return null
    } else if (c === ')') {
      if (depth === 0) break
      depth--
    }
    i++
  }
  if (depth !== 0) return null
  return [unescapeString(s.slice(start, i)), i]
}

/** 解析链接标题；返回 [标题, 结束位置] */
function parseLinkTitle(s: string, start: number): [string, number] | null {
  const open = s[start]
  const close = open === '"' ? '"' : open === "'" ? "'" : open === '(' ? ')' : ''
  if (!close) return null
  let i = start + 1
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') { i += 2; continue }
    if (c === close) return [unescapeString(s.slice(start + 1, i)), i + 1]
    if (open === '(' && c === '(') return null
    // 标题里不能有空行
    if (c === '\n' && s[i + 1] === '\n') return null
    i++
  }
  return null
}

function skipSpaces(s: string, start: number, allowNewline = true): number {
  let i = start
  let newlines = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '\n' && allowNewline && newlines === 0) { newlines++; i++; continue }
    break
  }
  return i
}

/** `[label]` 的结束位置（含 ]），失败 -1 */
function linkLabelEnd(s: string, start: number): number {
  if (s[start] !== '[') return -1
  let i = start + 1
  while (i < s.length && i - start < 1001) {
    const c = s[i]
    if (c === '\\') { i += 2; continue }
    if (c === '[') return -1
    if (c === ']') return i + 1
    i++
  }
  return -1
}

/** 从段落开头剥掉引用定义 `[label]: url "title"`，返回剩余正文 */
function stripReferenceDefs(raw: string, refs: Map<string, LinkRef>): string {
  let s = raw
  for (;;) {
    if (s[0] !== '[') return s
    const end = linkLabelEnd(s, 0)
    if (end < 0 || s[end] !== ':') return s
    const label = s.slice(1, end - 1)
    if (label.trim() === '' || label[0] === '^') return s
    let i = skipSpaces(s, end + 1)
    if (i >= s.length) return s
    const dest = parseLinkDestination(s, i)
    if (!dest) return s
    i = dest[1]
    let title: string | undefined
    const beforeTitle = i
    const afterSpace = skipSpaces(s, i)
    let lineEnd = -1
    if (afterSpace > beforeTitle && afterSpace < s.length) {
      const t = parseLinkTitle(s, afterSpace)
      if (t) {
        const rest = skipSpaces(s, t[1], false)
        if (rest >= s.length || s[rest] === '\n') {
          title = t[0]
          lineEnd = rest
        }
      }
    }
    if (lineEnd < 0) {
      const rest = skipSpaces(s, beforeTitle, false)
      if (rest < s.length && s[rest] !== '\n') return s
      lineEnd = rest
    }
    const key = normalizeLabel(label)
    if (key && !refs.has(key)) refs.set(key, { href: dest[0], title })
    s = s.slice(lineEnd + 1)
    if (s === '') return ''
  }
}

// ── 块级：主循环 ──

type RawBlock =
  | { t: 'p'; raw: string; tail?: boolean }
  | { t: 'h'; level: number; raw: string; tail?: boolean }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; children: RawBlock[] }
  | { t: 'list'; ordered: boolean; start: number; items: RawBlock[][] }
  | { t: 'hr' }
  | { t: 'table'; align: MdAlign[]; head: string[]; rows: string[][]; tail?: boolean }
  | { t: 'html'; text: string }

interface Ctx {
  refs: Map<string, LinkRef>
  footnoteDefs: Map<string, RawBlock[]>
  footnoteOrder: string[]
}

function parseRawBlocks(lines: readonly string[], ctx: Ctx, depth: number): RawBlock[] {
  const out: RawBlock[] = []
  const n = lines.length
  let i = 0
  while (i < n) {
    const line = lines[i]
    if (isBlank(line)) { i++; continue }

    // 嵌套过深：不再展开容器，当普通段落
    if (depth > MAX_DEPTH) {
      out.push({ t: 'p', raw: lines.slice(i).map((l) => l.trim()).filter(Boolean).join('\n') })
      break
    }

    // 缩进代码块
    if (indentOf(line) >= 4) {
      const buf: string[] = []
      while (i < n && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) {
        buf.push(stripIndent(lines[i], 4))
        i++
      }
      while (buf.length > 0 && isBlank(buf[buf.length - 1])) buf.pop()
      out.push({ t: 'code', lang: '', text: buf.join('\n') })
      continue
    }

    // 围栏代码块（没闭合就到容器结尾：流式时天然是一个还在长的代码块）
    const fence = matchFence(line)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < n) {
        if (isFenceClose(lines[i], fence)) { i++; break }
        buf.push(stripIndent(lines[i], fence.indent))
        i++
      }
      const lang = unescapeString(fence.info.split(/[ \t]+/)[0] ?? '')
      out.push({ t: 'code', lang, text: buf.join('\n') })
      continue
    }

    // ATX 标题
    const atx = ATX_RE.exec(line)
    if (atx) {
      const body = (atx[2] ?? '').trim().replace(/(^|[ \t]+)#+$/, '').trim()
      out.push({ t: 'h', level: atx[1].length, raw: body })
      i++
      continue
    }

    // 分隔线（优先于列表：`* * *` 不是列表）
    if (HR_RE.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }

    // 引用
    if (QUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < n) {
        const l = lines[i]
        const q = /^ {0,3}>/.exec(l)
        if (q) {
          let rest = l.slice(q[0].length)
          if (rest[0] === ' ') rest = rest.slice(1)
          else if (rest[0] === '\t') rest = '  ' + rest.slice(1)
          inner.push(rest)
          i++
          continue
        }
        if (isBlank(l) || interruptsParagraph(l) || !tailIsParagraph(inner)) break
        inner.push(asLazyLine(l))
        i++
      }
      out.push({ t: 'quote', children: parseRawBlocks(inner, ctx, depth + 1) })
      continue
    }

    // 脚注定义
    const fn = FOOTNOTE_DEF_RE.exec(line)
    if (fn) {
      const body: string[] = [fn[2]]
      i++
      let blanks = 0
      while (i < n) {
        const l = lines[i]
        if (isBlank(l)) { blanks++; i++; continue }
        if (indentOf(l) >= 4) {
          for (; blanks > 0; blanks--) body.push('')
          body.push(stripIndent(l, 4))
          i++
          continue
        }
        if (blanks === 0 && !interruptsParagraph(l) && tailIsParagraph(body)) {
          body.push(asLazyLine(l))
          i++
          continue
        }
        break
      }
      const key = normalizeLabel(fn[1])
      if (!ctx.footnoteDefs.has(key)) ctx.footnoteDefs.set(key, parseRawBlocks(body, ctx, depth + 1))
      continue
    }

    // 列表
    const first = matchListMarker(line)
    if (first) {
      const items: RawBlock[][] = []
      while (i < n) {
        const m = matchListMarker(lines[i])
        if (!m || m.ordered !== first.ordered || m.delim !== first.delim || HR_RE.test(lines[i])) break
        const body: string[] = [m.rest]
        const startedBlank = isBlank(m.rest)
        i++
        let blanks = 0
        while (i < n) {
          const l = lines[i]
          if (isBlank(l)) {
            // 以空行开始的列表项，后面紧跟第二个空行就结束
            if (startedBlank && body.length === 1) break
            blanks++
            i++
            continue
          }
          if (indentOf(l) >= m.contentOffset) {
            for (; blanks > 0; blanks--) body.push('')
            body.push(stripIndent(l, m.contentOffset))
            i++
            continue
          }
          if (blanks === 0 && !matchListMarker(l) && !interruptsParagraph(l) && tailIsParagraph(body)) {
            body.push(asLazyLine(l))
            i++
            continue
          }
          break
        }
        items.push(parseRawBlocks(body, ctx, depth + 1))
        while (i < n && isBlank(lines[i])) i++
      }
      out.push({ t: 'list', ordered: first.ordered, start: first.start, items })
      continue
    }

    // HTML 块：不执行，当文字
    const html = HTML_START.find(([re]) => re.test(line))
    if (html || HTML_COMPLETE_TAG.test(line)) {
      const endRe = html ? html[1] : null
      const buf: string[] = []
      while (i < n) {
        const l = lines[i]
        if (!endRe && isBlank(l)) break
        buf.push(l)
        i++
        if (endRe && endRe.test(l)) break
      }
      out.push({ t: 'html', text: buf.join('\n') })
      continue
    }

    // 表格
    if (isTableStart(lines, i)) {
      const head = splitTableRow(lines[i])
      const align = splitTableRow(lines[i + 1]).map(delimAlign)
      i += 2
      const rows: string[][] = []
      while (i < n && !isBlank(lines[i]) && !interruptsParagraph(lines[i]) && indentOf(lines[i]) < 4) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      out.push({ t: 'table', align, head, rows })
      continue
    }

    // 段落（可能变成 setext 标题）
    const buf: string[] = [line.trimStart()]
    i++
    let setext = 0
    while (i < n) {
      const l = lines[i]
      if (isBlank(l)) break
      const under = SETEXT_RE.exec(l)
      if (under) {
        setext = under[1][0] === '=' ? 1 : 2
        i++
        break
      }
      if (interruptsParagraph(l) || isTableStart(lines, i)) break
      buf.push(l.trimStart())
      i++
    }
    const text = stripReferenceDefs(buf.join('\n'), ctx.refs).replace(/[ \t]+$/, '')
    if (text === '') {
      // 整段都是引用定义；setext 下划线落回普通段落
      if (setext) out.push({ t: 'p', raw: lines[i - 1].trim() })
      continue
    }
    out.push(setext ? { t: 'h', level: setext, raw: text } : { t: 'p', raw: text })
  }
  return out
}

// ── 行内 ──

interface Delim { kind: 'delim'; ch: string; count: number; canOpen: boolean; canClose: boolean; afterAlnum?: boolean }
interface Bracket { kind: 'bracket'; image: boolean; active: boolean; textPos: number; bracketAfter: boolean }
type Tok = MdInline | Delim | Bracket

const isDelim = (t: Tok): t is Delim => (t as Delim).kind === 'delim'
const isBracket = (t: Tok): t is Bracket => (t as Bracket).kind === 'bracket'

function delimText(d: Delim): string { return d.ch.repeat(d.count) }

function tokToInline(t: Tok): MdInline {
  if (isDelim(t)) return { type: 'text', text: delimText(t) }
  if (isBracket(t)) return { type: 'text', text: t.image ? '![' : '[' }
  return t
}

function plainTextOf(nodes: readonly MdInline[]): string {
  let s = ''
  for (const n of nodes) {
    if (n.type === 'text' || n.type === 'code') s += n.text
    else if (n.type === 'strong' || n.type === 'em' || n.type === 'del' || n.type === 'link') s += plainTextOf(n.children)
    else if (n.type === 'image') s += n.alt
    else if (n.type === 'break') s += '\n'
  }
  return s
}

function mergeText(nodes: readonly MdInline[]): MdInline[] {
  const out: MdInline[] = []
  for (const n of nodes) {
    const last = out[out.length - 1]
    if (n.type === 'text') {
      if (n.text === '') continue
      if (last && last.type === 'text' && !last.literal && !n.literal) {
        out[out.length - 1] = { type: 'text', text: last.text + n.text }
        continue
      }
    }
    out.push(n)
  }
  return out
}

/** 行内强调的最大嵌套层数：超过就退成纯文字。正常文字到不了，防的是 `*a *a *a …` 这种输入把递归渲染撑爆栈 */
const MAX_INLINE_DEPTH = 16

function inlineDepth(nodes: readonly MdInline[]): number {
  let depth = 0
  for (const n of nodes) {
    if (n.type === 'strong' || n.type === 'em' || n.type === 'del' || n.type === 'link') {
      depth = Math.max(depth, 1 + inlineDepth(n.children))
    }
  }
  return depth
}

function wrapEmphasis(type: 'strong' | 'em' | 'del', children: MdInline[]): MdInline {
  if (inlineDepth(children) >= MAX_INLINE_DEPTH) return { type: 'text', text: plainTextOf(children) }
  return { type, children }
}

/** 匹配 * _ ~~ 定界符（CommonMark 的 process emphasis，定界符长度取当前值，和 micromark 一致） */
function resolveDelims(toks: Tok[], autoClose: boolean): MdInline[] {
  const bottoms: Record<string, Tok | undefined> = {}
  let c = 0
  while (c < toks.length) {
    const closer = toks[c]
    if (!isDelim(closer) || !closer.canClose) { c++; continue }
    const key = `${closer.ch}${closer.canOpen ? 1 : 0}${closer.count % 3}`
    const bottom = bottoms[key]
    let found = -1
    for (let o = c - 1; o >= 0; o--) {
      const t = toks[o]
      if (bottom && t === bottom) break
      if (!isDelim(t) || t.ch !== closer.ch || !t.canOpen) continue
      if (t.ch === '~') { found = o; break }
      const oddMatch = (t.canClose || closer.canOpen) && closer.count % 3 !== 0 && (t.count + closer.count) % 3 === 0
      if (!oddMatch) { found = o; break }
    }
    if (found < 0) {
      // 流式：结尾这个闭定界符配不上对，可能只是还没写完，先不显示
      if (autoClose && c === toks.length - 1) {
        toks.pop()
        break
      }
      bottoms[key] = c > 0 ? toks[c - 1] : undefined
      if (!closer.canOpen) toks[c] = tokToInline(closer)
      c++
      continue
    }
    const opener = toks[found] as Delim
    const use = opener.ch === '~' ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1
    const children = mergeText(toks.slice(found + 1, c).map(tokToInline))
    const node = wrapEmphasis(opener.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em', children)
    opener.count -= use
    closer.count -= use
    const repl: Tok[] = []
    if (opener.count > 0) repl.push(opener)
    repl.push(node)
    if (closer.count > 0) repl.push(closer)
    toks.splice(found, c - found + 1, ...repl)
    c = found + (opener.count > 0 ? 1 : 0) + 1
  }

  if (autoClose) {
    // 尾巴上孤零零的定界符（后面还没有内容）：先不显示
    while (toks.length > 0 && isDelim(toks[toks.length - 1])) toks.pop()
    // 没闭合的开定界符：把后面的内容包起来，当它已经闭合
    for (let o = toks.length - 1; o >= 0; o--) {
      const t = toks[o]
      if (!isDelim(t) || !t.canOpen) continue
      // 单星号贴在英文 / 数字中间（`5*3`）大多不是强调，不抢着渲染；** 和 ~~ 没这个歧义
      if (t.count === 1 && t.canClose && t.afterAlnum) continue
      const inner = mergeText(toks.slice(o + 1).map(tokToInline))
      let node: MdInline
      if (t.ch === '~') node = wrapEmphasis('del', inner)
      else if (t.count === 1) node = wrapEmphasis('em', inner)
      else if (t.count === 2) node = wrapEmphasis('strong', inner)
      else node = wrapEmphasis('strong', [wrapEmphasis('em', inner)])
      toks.splice(o, toks.length - o, node)
    }
  }
  return mergeText(toks.map(tokToInline))
}

function isPathTrail(s: string, start: number): boolean {
  let i = start
  while (i <= s.length) {
    if (i === s.length) return true
    const c = s[i]
    if ('!"\')*,.:;?_~'.indexOf(c) >= 0) { i++; continue }
    if (c === '&') {
      const m = /^&[a-zA-Z]+;/.exec(s.slice(i, i + 40))
      if (!m) return false
      i += m[0].length
      continue
    }
    if (c === ']') {
      const n = s[i + 1]
      if (n === undefined || n === '(' || n === '[' || isWhitespaceCode(s.charCodeAt(i + 1))) return true
      i++
      continue
    }
    return c === '<' || isWhitespaceCode(s.charCodeAt(i))
  }
  return true
}

/** GFM 裸链接的 domain + path 扫描（对应 micromark-extension-gfm-autolink-literal），返回结束位置，失败 -1 */
function scanLiteralUrl(s: string, start: number): number {
  let i = start
  let seen = false
  let usLast = false
  let usLastLast = false
  while (i < s.length) {
    const c = s[i]
    if (c === '.' || c === '_') {
      if (isPathTrail(s, i)) break
      if (c === '_') usLast = true
      else {
        usLastLast = usLast
        usLast = false
      }
      i++
      continue
    }
    const cp = codeAt(s, i)
    if (isWhitespaceCode(cp) || (c !== '-' && isUnicodePunct(cp))) break
    seen = true
    i += cp > 0xffff ? 2 : 1
  }
  if (usLastLast || usLast || !seen) return -1
  let open = 0
  let close = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '(') { open++; i++; continue }
    if (c === ')' && close < open) { close++; i++; continue }
    if ('!"&\')*,.:;<?]_~'.indexOf(c) >= 0) {
      if (isPathTrail(s, i)) break
      if (c === ')') close++
      i++
      continue
    }
    if (isWhitespaceCode(s.charCodeAt(i))) break
    i++
  }
  return i
}

const HTML_INLINE_RE = new RegExp(
  '^(?:' +
    `<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*"))?)*\\s*/?>` +
    '|</[a-zA-Z][a-zA-Z0-9-]*\\s*>' +
    '|<!---?>|<!--[\\s\\S]*?-->' +
    '|<\\?[\\s\\S]*?\\?>' +
    '|<![a-zA-Z][^>]*>' +
    '|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>' +
  ')',
)
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9.+-]{1,31}:[^<>\x00-\x20]*)>/
const EMAIL_AUTOLINK_RE = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/

interface InlineOpts {
  /** 流式的最后一段：没闭合的语法按闭合渲染 */
  autoClose?: boolean
  /** 表格单元格：行内代码里的 \| 还原成 | */
  inTable?: boolean
}

function parseInlines(raw: string, ctx: Ctx, opts: InlineOpts = {}): MdInline[] {
  if (raw.length > MAX_INLINE_LEN) return [{ type: 'text', text: raw }]
  const s = raw
  const n = s.length
  const autoClose = opts.autoClose === true
  const toks: Tok[] = []
  const brackets: Bracket[] = []
  const noCloser = new Set<number>()
  let pos = 0
  let buf = ''

  const flush = () => {
    if (buf) {
      toks.push({ type: 'text', text: buf })
      buf = ''
    }
  }

  while (pos < n) {
    const c = s[pos]

    if (c === '\n') {
      buf = buf.replace(/[ \t]+$/, '')
      flush()
      toks.push({ type: 'break' })
      pos++
      while (pos < n && (s[pos] === ' ' || s[pos] === '\t')) pos++
      continue
    }

    if (c === '\\') {
      const next = s[pos + 1]
      if (next === undefined) {
        if (!autoClose) buf += '\\'
        pos++
      } else if (next === '\n') {
        flush()
        toks.push({ type: 'break' })
        pos += 2
        while (pos < n && (s[pos] === ' ' || s[pos] === '\t')) pos++
      } else if (ASCII_PUNCT.test(next)) {
        buf += next
        pos += 2
      } else {
        buf += '\\'
        pos++
      }
      continue
    }

    if (c === '`') {
      let end = pos
      while (end < n && s[end] === '`') end++
      const size = end - pos
      let close = -1
      if (!noCloser.has(size)) {
        let k = end
        while (k < n) {
          const idx = s.indexOf('`', k)
          if (idx < 0) break
          let e = idx
          while (e < n && s[e] === '`') e++
          if (e - idx === size) { close = idx; break }
          k = e
        }
        if (close < 0) noCloser.add(size)
      }
      if (close >= 0) {
        flush()
        let text = s.slice(end, close).replace(/\n/g, ' ')
        if (text.length >= 2 && text[0] === ' ' && text[text.length - 1] === ' ' && /[^ ]/.test(text)) text = text.slice(1, -1)
        if (opts.inTable) text = text.replace(/\\([\\|])/g, '$1')
        toks.push({ type: 'code', text })
        pos = close + size
      } else if (autoClose) {
        // 没闭合的行内代码：后面的内容都算代码；后面什么都没有就先不显示反引号
        flush()
        const rest = s.slice(end).replace(/\n/g, ' ')
        if (rest) toks.push({ type: 'code', text: rest })
        pos = n
      } else {
        buf += s.slice(pos, end)
        pos = end
      }
      continue
    }

    if (c === '*' || c === '_') {
      let end = pos
      while (end < n && s[end] === c) end++
      let before = codeBefore(s, pos)
      if (before !== -1 && isGeneralVs(before)) {
        const twoBefore = codeBefore(s, pos - 1)
        if (twoBefore !== -1 && !isWhitespaceCode(twoBefore)) before = twoBefore
      }
      const after = codeAt(s, end)
      const beforeNcp = NON_CJK_PUNCT(before)
      const beforeMarker = before === 0x2a || before === 0x5f
      const beforeSpaceOrNcp = beforeNcp || WS(before) || beforeMarker
      const afterNcp = NON_CJK_PUNCT(after)
      const afterMarker = after === 0x2a || after === 0x5f
      const afterSpaceOrNcp = afterNcp || WS(after) || afterMarker
      const beforeCjkOrIvs = before !== -1 && (isCjkCode(before) || isIvsCode(before))
      const open = !afterSpaceOrNcp || (afterNcp && (beforeSpaceOrNcp || beforeCjkOrIvs)) || after === 0x7e
      const closeOk = !beforeSpaceOrNcp || (beforeNcp && (afterSpaceOrNcp || (after !== -1 && isCjkCode(after)))) || before === 0x7e
      const spaceOrPunct = (cp: number) => WS(cp) || isUnicodePunct(cp)
      flush()
      toks.push({
        kind: 'delim',
        ch: c,
        count: end - pos,
        canOpen: c === '*' ? open : open && (spaceOrPunct(before) || !closeOk),
        canClose: c === '*' ? closeOk : closeOk && (spaceOrPunct(after) || !open),
        afterAlnum: before !== -1 && before < 0x80 && /[0-9A-Za-z]/.test(String.fromCharCode(before)),
      })
      pos = end
      continue
    }

    if (c === '~') {
      let end = pos
      while (end < n && s[end] === '~') end++
      const size = end - pos
      if (size === 2) {
        // 只认 ~~：单个 ~ 在中文里太常见（3~5 天），不能当删除线
        const before = codeBefore(s, pos)
        const after = codeAt(s, end)
        const cls = (cp: number) => (WS(cp) ? 1 : isUnicodePunct(cp) ? 2 : 0)
        const b = cls(before)
        const a = cls(after)
        flush()
        toks.push({
          kind: 'delim',
          ch: '~',
          count: 2,
          canOpen: a === 0 || (a === 2 && b !== 0),
          canClose: b === 0 || (b === 2 && a !== 0),
        })
      } else if (!(autoClose && size === 1 && end === n)) {
        buf += s.slice(pos, end)
      }
      pos = end
      continue
    }

    if (c === '[' || (c === '!' && s[pos + 1] === '[')) {
      const image = c === '!'
      // 脚注引用（只有定义存在才算）
      if (!image && s[pos + 1] === '^') {
        const end = linkLabelEnd(s, pos)
        if (end > 0) {
          const key = normalizeLabel(s.slice(pos + 2, end - 1))
          if (key && !/\s/.test(s.slice(pos + 2, end - 1)) && ctx.footnoteDefs.has(key)) {
            let idx = ctx.footnoteOrder.indexOf(key)
            if (idx < 0) {
              ctx.footnoteOrder.push(key)
              idx = ctx.footnoteOrder.length - 1
            }
            flush()
            toks.push({ type: 'footnoteRef', index: idx + 1 })
            pos = end
            continue
          }
        }
      }
      flush()
      const textPos = pos + (image ? 2 : 1)
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true
      const b: Bracket = { kind: 'bracket', image, active: true, textPos, bracketAfter: false }
      brackets.push(b)
      toks.push(b)
      pos = textPos
      continue
    }

    if (c === ']') {
      flush()
      const opener = brackets[brackets.length - 1]
      if (!opener) {
        buf += ']'
        pos++
        continue
      }
      brackets.pop()
      const openerIdx = toks.lastIndexOf(opener)
      if (!opener.active) {
        toks[openerIdx] = tokToInline(opener)
        buf += ']'
        pos++
        continue
      }
      let href: string | null = null
      let title: string | undefined
      let endPos = pos + 1
      if (s[pos + 1] === '(') {
        let i = skipSpaces(s, pos + 2)
        const dest = parseLinkDestination(s, i)
        if (dest) {
          const destEnd = dest[1]
          i = skipSpaces(s, destEnd)
          let t: string | undefined
          let ok = true
          if (i > destEnd && i < n && s[i] !== ')') {
            const parsed = parseLinkTitle(s, i)
            if (parsed) {
              t = parsed[0]
              i = skipSpaces(s, parsed[1])
            } else {
              ok = false
            }
          }
          if (ok && s[i] === ')') {
            href = dest[0]
            title = t
            endPos = i + 1
          }
        }
      }
      if (href === null) {
        const labelEnd = linkLabelEnd(s, pos + 1)
        let label: string | null = null
        let consumed = pos + 1
        if (labelEnd > pos + 3) {
          label = s.slice(pos + 2, labelEnd - 1)
          consumed = labelEnd
        } else if (!opener.bracketAfter) {
          label = s.slice(opener.textPos, pos)
          if (labelEnd === pos + 3) consumed = labelEnd
        }
        if (label !== null) {
          const ref = ctx.refs.get(normalizeLabel(label))
          if (ref) {
            href = ref.href
            title = ref.title
            endPos = consumed
          }
        }
      }
      // 流式：`[文字](半截网址`、行尾的 `[文字]`
      let partial = false
      if (href === null && autoClose && !opener.image) {
        if (s[pos + 1] === '(' && s.indexOf(')', pos + 2) < 0) {
          partial = true
          href = ''
          endPos = n
        } else if (pos + 1 === n) {
          partial = true
        }
      }
      if (partial && href === null) {
        // 还不知道是不是链接：括号先不显示
        toks.splice(openerIdx, 1)
        pos++
        continue
      }
      if (href !== null) {
        const inner = toks.splice(openerIdx + 1)
        toks.pop()
        const children = resolveDelims(inner, false)
        if (opener.image) {
          toks.push({ type: 'image', src: href, alt: plainTextOf(children), title })
        } else {
          toks.push({ type: 'link', href, title, children: clearLiteral(unwrapAutoLinks(children)) })
          for (const b of brackets) if (!b.image) b.active = false
        }
        pos = endPos
        continue
      }
      if (autoClose && opener.image && (s[pos + 1] === '(' || pos + 1 === n)) {
        // 图片写到一半：整段先不显示
        toks.splice(openerIdx)
        pos = s[pos + 1] === '(' && s.indexOf(')', pos + 2) >= 0 ? pos + 1 : n
        continue
      }
      toks[openerIdx] = tokToInline(opener)
      buf += ']'
      pos++
      continue
    }

    if (c === '<') {
      const window = s.slice(pos, pos + 2000)
      const auto = AUTOLINK_RE.exec(window)
      if (auto) {
        flush()
        toks.push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1] }], auto: true })
        pos += auto[0].length
        continue
      }
      const mail = EMAIL_AUTOLINK_RE.exec(window)
      if (mail) {
        flush()
        toks.push({ type: 'link', href: `mailto:${mail[1]}`, children: [{ type: 'text', text: mail[1] }], auto: true })
        pos += mail[0].length
        continue
      }
      const tag = HTML_INLINE_RE.exec(window)
      if (tag) {
        // 不执行，只当文字（里面的定界符不解析，也不参与裸链接扫描）
        flush()
        toks.push({ type: 'text', text: tag[0], literal: true })
        pos += tag[0].length
        continue
      }
      buf += '<'
      pos++
      continue
    }

    if (c === '&') {
      const m = /^&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(s.slice(pos, pos + 40))
      if (m) {
        const decoded = decodeEntity(m[1])
        if (decoded !== null) {
          buf += decoded
          pos += m[0].length
          continue
        }
      }
      // 流式：`&am` 还可能写成 &amp;
      if (autoClose && /^&[#a-zA-Z0-9]{0,10}$/.test(s.slice(pos))) {
        pos = n
        continue
      }
      buf += '&'
      pos++
      continue
    }

    // GFM 裸链接：要在定界符之前认出来，网址里的 * _ 才不会被当成强调
    if ((c === 'h' || c === 'H' || c === 'w' || c === 'W') && brackets.length === 0) {
      const scheme = /^(?:https?:\/\/|www\.)/i.exec(s.slice(pos, pos + 8))
      if (scheme) {
        const isWww = scheme[0][0] === 'w' || scheme[0][0] === 'W'
        const before = codeBefore(s, pos)
        const prevOk = isWww
          ? before === -1 || before === 0x28 || before === 0x2a || before === 0x5f || before === 0x5b || before === 0x5d || before === 0x7e || before === 0x0a || before === 0x20 || before === 0x09
          : !(before >= 0x41 && before <= 0x5a) && !(before >= 0x61 && before <= 0x7a)
        const firstAfter = codeAt(s, pos + scheme[0].length)
        const afterOk = isWww
          ? firstAfter !== -1
          : firstAfter !== -1 && firstAfter >= 0x20 && firstAfter !== 0x7f && !isWhitespaceCode(firstAfter) && !isUnicodePunct(firstAfter)
        if (prevOk && afterOk) {
          const end = scanLiteralUrl(s, pos + scheme[0].length)
          if (end > 0) {
            const text = s.slice(pos, end)
            flush()
            toks.push({ type: 'link', href: isWww ? `http://${text}` : text, children: [{ type: 'text', text }], auto: true })
            pos = end
            continue
          }
        }
      }
    }

    // 普通文字（含代理对）
    buf += c
    pos++
  }
  flush()

  // 流式：结尾的定界符还可能在长（`**粗*` 再来一个星号才闭合）。
  // 前面没有能配对的开定界符、或开定界符比它长，都先不显示
  if (autoClose) {
    const tail = toks[toks.length - 1]
    if (tail && isDelim(tail)) {
      let opener: Delim | null = null
      for (let i = toks.length - 2; i >= 0; i--) {
        const t = toks[i]
        if (isDelim(t) && t.ch === tail.ch && t.canOpen) { opener = t; break }
      }
      if (!opener || opener.count > tail.count) toks.pop()
    }
  }

  // 流式：没写完的最后一个 `[`（括号里的内容先显示，括号本身不显示）
  if (autoClose && brackets.length > 0) {
    const last = brackets[brackets.length - 1]
    const idx = toks.lastIndexOf(last)
    if (idx >= 0) {
      if (last.image) toks.splice(idx)
      else toks.splice(idx, 1)
    }
  }

  const resolved = applyLiteralLinks(resolveDelims(toks, autoClose))
  // 流式：结尾的换行后面还没有内容时不占一行
  if (autoClose) while (resolved.length > 0 && resolved[resolved.length - 1].type === 'break') resolved.pop()
  return resolved
}

/** 链接里不再套链接：把链接文字里的裸链接还原成文字 */
function unwrapAutoLinks(nodes: readonly MdInline[]): MdInline[] {
  return mergeText(nodes.flatMap((node): MdInline[] => {
    if (node.type === 'link' && node.auto) return node.children
    if (node.type === 'strong' || node.type === 'em' || node.type === 'del') {
      return [{ ...node, children: unwrapAutoLinks(node.children) }]
    }
    return [node]
  }))
}

function clearLiteral(nodes: readonly MdInline[]): MdInline[] {
  return mergeText(nodes.map((node): MdInline => {
    if (node.type === 'text' && node.literal) return { type: 'text', text: node.text }
    if (node.type === 'strong' || node.type === 'em' || node.type === 'del') return { ...node, children: clearLiteral(node.children) }
    return node
  }))
}

// ── 词法之后的裸链接补扫（对应 mdast-util-gfm-autolink-literal 的 transform）──

const LITERAL_URL_RE = /(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/gi
const LITERAL_EMAIL_RE = /([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/g

function urlPrevOk(input: string, index: number): boolean {
  if (index === 0) return true
  const code = input.charCodeAt(index - 1)
  return isWhitespaceCode(code) || isUnicodePunct(code)
}

// 桌面端邮箱走 micromark tokenizer：前一个字符只要不是斜杠就行（正则已保证不是 atext）
function emailPrevOk(input: string, index: number): boolean {
  return index === 0 || input.charCodeAt(index - 1) !== 0x2f
}

function isCorrectDomain(domain: string): boolean {
  const parts = domain.split('.')
  const last = parts[parts.length - 1]
  const prev = parts[parts.length - 2]
  if (
    parts.length < 2 ||
    (last && (/_/.test(last) || !/[a-zA-Z\d]/.test(last))) ||
    (prev && (/_/.test(prev) || !/[a-zA-Z\d]/.test(prev)))
  ) return false
  return true
}

function splitUrl(url: string): [string, string] {
  const trail = /[!"&'),.:;<>?\]}]+$/.exec(url)
  if (!trail) return [url, '']
  let head = url.slice(0, trail.index)
  let rest = trail[0]
  let closing = rest.indexOf(')')
  const opens = head.split('(').length - 1
  let closes = head.split(')').length - 1
  while (closing !== -1 && opens > closes) {
    head += rest.slice(0, closing + 1)
    rest = rest.slice(closing + 1)
    closing = rest.indexOf(')')
    closes++
  }
  return [head, rest]
}

function replaceLiterals(text: string): MdInline[] {
  if (text.indexOf('://') < 0 && text.indexOf('www.') < 0 && text.indexOf('WWW.') < 0 && text.indexOf('@') < 0) {
    return [{ type: 'text', text }]
  }
  // 先网址、再邮箱，和桌面端 findAndReplace 的两轮一致
  const nodes: MdInline[] = []
  let cursor = 0
  LITERAL_URL_RE.lastIndex = 0
  for (let m = LITERAL_URL_RE.exec(text); m; m = LITERAL_URL_RE.exec(text)) {
    const full = m[0]
    let protocol = m[1]
    let domain = m[2]
    let prefix = ''
    if (!urlPrevOk(text, m.index)) continue
    if (/^w/i.test(protocol)) {
      domain = protocol + domain
      protocol = ''
      prefix = 'http://'
    }
    if (!isCorrectDomain(domain)) continue
    const [head, trail] = splitUrl(domain + m[3])
    if (!head) continue
    if (m.index > cursor) nodes.push({ type: 'text', text: text.slice(cursor, m.index) })
    nodes.push({ type: 'link', href: prefix + protocol + head, children: [{ type: 'text', text: protocol + head }], auto: true })
    if (trail) nodes.push({ type: 'text', text: trail })
    cursor = m.index + full.length
  }
  if (cursor < text.length) nodes.push({ type: 'text', text: text.slice(cursor) })

  const out: MdInline[] = []
  for (const node of nodes) {
    if (node.type !== 'text' || node.text.indexOf('@') < 0) {
      out.push(node)
      continue
    }
    const t = node.text
    let c = 0
    LITERAL_EMAIL_RE.lastIndex = 0
    for (let m = LITERAL_EMAIL_RE.exec(t); m; m = LITERAL_EMAIL_RE.exec(t)) {
      if (!emailPrevOk(t, m.index) || /[-\d_]$/.test(m[2])) continue
      if (m.index > c) out.push({ type: 'text', text: t.slice(c, m.index) })
      const addr = `${m[1]}@${m[2]}`
      out.push({ type: 'link', href: `mailto:${addr}`, children: [{ type: 'text', text: addr }], auto: true })
      c = m.index + m[0].length
    }
    if (c < t.length) out.push({ type: 'text', text: t.slice(c) })
  }
  return out
}

function applyLiteralLinks(nodes: readonly MdInline[]): MdInline[] {
  const out: MdInline[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.literal) out.push({ type: 'text', text: node.text })
      else out.push(...replaceLiterals(node.text))
    } else if (node.type === 'strong' || node.type === 'em' || node.type === 'del') {
      out.push({ ...node, children: applyLiteralLinks(node.children) })
    } else out.push(node)
  }
  return mergeText(out)
}

// ── 流式：结尾半截块标记的处理 ──

/** 行首的容器前缀（引用符 + 列表符）去掉后的内容 */
function stripContainerPrefix(line: string): string {
  let s = line
  for (let guard = 0; guard < MAX_DEPTH; guard++) {
    const t = s.replace(/^[ \t]*>[ \t]?/, '').replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/, '')
    if (t === s) break
    s = t
  }
  return s.trim()
}

function isPendingBlockMarker(line: string): boolean {
  // `- ` / `1. ` 这种列表符后面还没内容；任务框 `- [ ]` 也要等到有文字
  if (/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]*$/.test(line)) return true
  if (/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ \txX]?\]?[ \t]*$/.test(line)) return true
  const rest = stripContainerPrefix(line)
  if (rest === '') return true
  if (/^(?:`{1,2}|~{1,2})$/.test(rest)) return true
  if (/^#{1,6}$/.test(rest)) return true
  if (/^([-*_])(?:[ \t]*\1)*$/.test(rest)) return true
  if (/^=+$/.test(rest)) return true
  if (/^\d{1,9}[.)]?$/.test(rest)) return true
  if (rest === '>' || rest === '|') return true
  return false
}

function looksLikeTableRow(line: string): boolean {
  return indentOf(line) < 4 && line.trimStart()[0] === '|'
}

function makeDelimRow(head: string): string {
  return `|${splitTableRow(head).map(() => '---').join('|')}|`
}

function healStreamingTail(lines: string[]): string[] {
  const out = lines.slice()
  // 是否在没闭合的围栏里
  let fence: FenceMatch | null = null
  for (const l of out) {
    const body = l.replace(/^[ \t]*(?:>[ \t]?)*[ \t]*/, '')
    if (fence) {
      if (isFenceClose(body, fence)) fence = null
    } else {
      fence = matchFence(body)
    }
  }
  if (out.length === 0) return out
  // 结尾是空行：上一个块已经写完，不用处理（保留空行让段落结束）
  if (isBlank(out[out.length - 1])) return out
  const lastIdx = out.length - 1
  const last = out[lastIdx]
  if (fence) {
    // 正在写闭合围栏：`` ` `` `` `` 还不该进代码内容
    const body = stripContainerPrefix(last)
    const open: FenceMatch = fence
    if (body.length < open.marker.length && body.length > 0 && body === open.marker[0].repeat(body.length)) out.pop()
    return out
  }
  if (isPendingBlockMarker(last)) {
    out.pop()
    // 分隔行刚起头（`|`）就被藏掉了：上一行可能是表头，继续按表格处理
    if (out.length > 0 && looksLikeTableRow(out[out.length - 1]) && !looksLikeTableRow(out[out.length - 2] ?? '')) {
      out.push(makeDelimRow(out[out.length - 1]))
    }
    return out
  }

  // 表格写到一半：先按表格显示，避免竖线文字一闪
  const prev = lastIdx > 0 ? out[lastIdx - 1] : ''
  const prevIsRow = looksLikeTableRow(prev)
  const prevPrev = lastIdx > 1 ? out[lastIdx - 2] : ''
  if (prevIsRow && !TABLE_DELIM_RE.test(prev) && !looksLikeTableRow(prevPrev) && /^[ \t]*\|?[ \t:|-]*$/.test(last)) {
    // 分隔行还没写完（列数够了就保留原样，对齐方式才不丢）
    const complete = TABLE_DELIM_RE.test(last) && splitTableRow(last).length === splitTableRow(prev).length
    if (!complete) out[lastIdx] = makeDelimRow(prev)
    return out
  }
  if (looksLikeTableRow(last) && !prevIsRow && !TABLE_DELIM_RE.test(last)) {
    out.push(makeDelimRow(last))
    return out
  }
  return out
}

/** 把最后一个有文字的块标记成「还在写」 */
function markTail(blocks: RawBlock[]): void {
  const last = blocks[blocks.length - 1]
  if (!last) return
  if (last.t === 'p' || last.t === 'h' || last.t === 'table') last.tail = true
  else if (last.t === 'quote') markTail(last.children)
  else if (last.t === 'list') markTail(last.items[last.items.length - 1] ?? [])
}

// ── 组装 ──

function finalizeBlocks(raw: readonly RawBlock[], ctx: Ctx): MdBlock[] {
  const out: MdBlock[] = []
  for (const b of raw) {
    switch (b.t) {
      case 'p': {
        const children = parseInlines(b.raw, ctx, { autoClose: b.tail })
        // 流式时半截语法可能什么都不显示：不留一个空行占位
        if (children.length > 0) out.push({ type: 'paragraph', children })
        break
      }
      case 'h':
        out.push({ type: 'heading', level: b.level, children: parseInlines(b.raw, ctx, { autoClose: b.tail }) })
        break
      case 'code':
        out.push({ type: 'code', lang: b.lang, text: b.text })
        break
      case 'quote':
        out.push({ type: 'quote', children: finalizeBlocks(b.children, ctx) })
        break
      case 'hr':
        out.push({ type: 'hr' })
        break
      case 'html':
        out.push({ type: 'html', text: b.text })
        break
      case 'table': {
        const cols = b.head.length
        const lastRow = b.rows.length - 1
        const cell = (text: string, isTail: boolean) => parseInlines(text, ctx, { inTable: true, autoClose: isTail })
        const headTailCol = b.tail && lastRow < 0 ? cols - 1 : -1
        const header = b.head.map((c, i) => cell(c, i === headTailCol))
        const rows = b.rows.map((row, r) => {
          const tailCol = b.tail && r === lastRow ? Math.min(row.length, cols) - 1 : -1
          const cells: MdInline[][] = []
          for (let i = 0; i < cols; i++) cells.push(i < row.length ? cell(row[i], i === tailCol) : [])
          return cells
        })
        out.push({ type: 'table', align: b.align, header, rows })
        break
      }
      case 'list': {
        const items: MdListItem[] = b.items.map((item) => {
          let checked: boolean | null = null
          let children = item
          const head = item[0]
          if (head && head.t === 'p') {
            const m = /^\[([ \txX])\](?:[ \t]*\n[ \t]*| |\t)(?=[\s\S]*\S)/.exec(head.raw)
            if (m) {
              checked = m[1] === 'x' || m[1] === 'X'
              children = [{ ...head, raw: head.raw.slice(m[0].length) }, ...item.slice(1)]
            }
          }
          return { checked, children: finalizeBlocks(children, ctx) }
        })
        out.push({ type: 'list', ordered: b.ordered, start: b.start, items })
        break
      }
    }
  }
  return out
}

/**
 * 解析入口。任何输入都不抛错；调用方仍可以 try/catch 兜底显示纯文本。
 */
export function parseFairyMarkdown(source: string, options: ParseOptions = {}): MdBlock[] {
  const streaming = options.streaming === true
  const normalized = source.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\ufffd')
  let lines = normalized.split('\n')
  // 文末的换行只是行结束符，不是多一个空行（否则没闭合的代码块会多一行）
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (streaming) lines = healStreamingTail(lines)
  const ctx: Ctx = {
    refs: new Map(),
    footnoteDefs: new Map(),
    footnoteOrder: [],
  }
  const raw = parseRawBlocks(lines, ctx, 0)
  if (streaming && lines.length > 0 && !isBlank(lines[lines.length - 1])) markTail(raw)
  const blocks = finalizeBlocks(raw, ctx)

  // 脚注：只收被引用过的，按首次引用的顺序编号，放到正文最后（和桌面端 remark-rehype 一样）
  if (ctx.footnoteOrder.length > 0) {
    const items: { index: number; children: MdBlock[] }[] = []
    for (let i = 0; i < ctx.footnoteOrder.length; i++) {
      const key = ctx.footnoteOrder[i]
      items.push({ index: i + 1, children: finalizeBlocks(ctx.footnoteDefs.get(key) ?? [], ctx) })
    }
    blocks.push({ type: 'footnotes', items })
  }
  return blocks
}

// ── 给渲染层用的小工具 ──

/** 按字符估算文本宽度（中日韩 1em，其余约 0.56em） */
export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    width += isCjkCode(cp) || cp >= 0x1f000 ? fontSize : fontSize * 0.56
  }
  return width
}

export function inlinePlainText(nodes: readonly MdInline[]): string {
  return plainTextOf(nodes)
}

/**
 * 表格列宽：RN 没有表格布局，先按内容估出每列宽度，所有行共用，
 * 不需要等测量（流式时不抖）。超过上限的单元格在列宽内折行。
 */
export function tableColumnWidths(
  header: readonly MdInline[][],
  rows: readonly MdInline[][][],
  fontSize: number,
  horizontalPadding: number,
  minWidth = 48,
  maxWidth = 240,
): number[] {
  return header.map((cell, col) => {
    let widest = estimateTextWidth(plainTextOf(cell), fontSize)
    for (const row of rows) {
      const c = row[col]
      if (c) widest = Math.max(widest, estimateTextWidth(plainTextOf(c), fontSize))
    }
    return Math.min(maxWidth, Math.max(minWidth, Math.ceil(widest + horizontalPadding * 2)))
  })
}
