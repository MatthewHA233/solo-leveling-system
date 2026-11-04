// 协议志 · 开局（梦想记事本）的数据：一次开局 = 一份文档（后端 protocol_genesis.rs 只管存取，结构在这里定）
//   两份清单（各 1~10 条，AI 誊成便利贴 / 愿望短笺）→ 系统照一遍 → 人生金字塔 → 未来车票（年表）→ 之后长出每周大石头、每天的协议

export const MAX_ITEMS = 10
/** 清单里一条最长多少字（存、誊、对号都按这个截） */
export const MAX_ITEM_LEN = 400

export type GenesisStage = 'frustrations' | 'wishes' | 'reflection' | 'pyramid' | 'timeline' | 'done'
export const STAGES: readonly GenesisStage[] = ['frustrations', 'wishes', 'reflection', 'pyramid', 'timeline', 'done']

/** 人生金字塔（照熊谷正寿的「梦想·人生金字塔」）：塔上一句人生理念，塔身三层六个领域，每个领域下面几个具体目标 */
export interface Pyramid {
  readonly mission: string
  readonly areas: Readonly<Record<AreaKey, readonly string[]>>
}

export type AreaKey = 'health' | 'spirit' | 'culture' | 'work' | 'family' | 'wealth'

export interface Area {
  readonly key: AreaKey
  /** 熊谷的编号：1 健康最要紧，6 资产是前面几层长出来的结果 */
  readonly no: number
  readonly name: string
  /** 这一格管什么（空着的时候写在格子里提示） */
  readonly scope: string
  /** 第几层：1 基本、2 实现、3 结果 */
  readonly tier: 1 | 2 | 3
}

export const AREAS: readonly Area[] = [
  { key: 'health', no: 1, name: '健康', scope: '身体', tier: 1 },
  { key: 'spirit', no: 2, name: '精神', scope: '心·精神', tier: 1 },
  { key: 'culture', no: 3, name: '教养', scope: '教养·知识', tier: 1 },
  { key: 'work', no: 4, name: '工作', scope: '社会·工作', tier: 2 },
  { key: 'family', no: 5, name: '家庭', scope: '私人·家庭', tier: 2 },
  { key: 'wealth', no: 6, name: '资产', scope: '经济·物·钱', tier: 3 },
]
export const AREA_KEYS: readonly AreaKey[] = AREAS.map((a) => a.key)
/** 一格最多几个目标（塔里的格子装不下太多） */
export const MAX_GOALS = 5

/** 记事本上 AI 誊好的一张纸（镜子上的便利贴、竹枝上的愿望短笺）：把一条原话誊短，做上手记标记；悬停看原话 */
export type MarkKind = 'highlight' | 'underline' | 'circle'
export const MARK_KINDS: readonly MarkKind[] = ['highlight', 'underline', 'circle']

export interface NoteMark {
  /** 便利贴那句话里原样的一段 */
  readonly text: string
  readonly kind: MarkKind
}

export interface InkNote {
  /** 对应的原话（清单里的那一条），按它对上号 */
  readonly source: string
  /** 誊短的那句话，AI 已经按语义停顿排好了行（竖写就是列） */
  readonly lines: readonly string[]
  readonly marks: readonly NoteMark[]
}

/** 纸上那句话连起来 */
export const noteText = (n: InkNote): string => n.lines.join('')

/** 未来年表上的一个锚点：when = YYYY-MM-DD 或 YYYY-MM */
export interface Milestone {
  readonly when: string
  readonly what: string
}

export interface GenesisDoc {
  readonly version: 1
  readonly stage: GenesisStage
  readonly frustrations: readonly string[]
  /** 责任之镜的便利贴，和 frustrations 一一对应（没誊好的那条就没有） */
  readonly notes: readonly InkNote[]
  readonly wishes: readonly string[]
  /** 悬着的愿：竹枝上的愿望短笺，和 wishes 一一对应 */
  readonly wishNotes: readonly InkNote[]
  readonly reflection: string | null
  readonly pyramid: Pyramid | null
  readonly timeline: readonly Milestone[] | null
}

export const EMPTY_DOC: GenesisDoc = {
  version: 1, stage: 'frustrations', frustrations: [], notes: [], wishes: [], wishNotes: [], reflection: null, pyramid: null, timeline: null,
}

/** 文本框 → 清单：一行一条，去掉空行和行首编号（「1.」「1、」「- 」）；一样的两行只留一行 */
export function toItems(text: string): string[] {
  const items = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^(\d+[.、．)）]\s*|[-*•·]\s+)/, '').trim().slice(0, MAX_ITEM_LEN))
    .filter((l) => l !== '')
  return items.filter((l, i) => items.indexOf(l) === i)
}

export const stageIndex = (s: GenesisStage) => STAGES.indexOf(s)

const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const strList = (v: unknown, maxItems: number, maxLen = 200): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter((x) => x !== '').slice(0, maxItems) : []

/** 旧版金字塔是自己起名的几根柱子：按名字归进六格（认不出的先放进「工作」），目标原样留着 */
const LEGACY_HINTS: Readonly<Record<AreaKey, RegExp>> = {
  health: /身体|健康|运动|健身|跑|睡|饮食|体能/,
  spirit: /心|精神|情绪|习惯|自律|信念/,
  culture: /学|读|知识|教养|讲究|审美|艺术|技能|语言/,
  work: /工作|事业|开发|产品|作品|公司|创业|职业/,
  family: /家|伴侣|朋友|恋|父母|孩子|感情/,
  wealth: /钱|资产|财|收入|存款|经济/,
}

function legacyAreas(pillars: unknown): Record<string, unknown> {
  if (!Array.isArray(pillars)) return {}
  return pillars.reduce<Record<string, string[]>>((acc, p) => {
    const pp = p as { name?: unknown; goals?: unknown }
    const name = str(pp?.name, 24)
    const key = AREA_KEYS.find((k) => LEGACY_HINTS[k].test(name)) ?? 'work'
    return { ...acc, [key]: [...(acc[key] ?? []), ...strList(pp?.goals, MAX_GOALS, 60)] }
  }, {})
}

export function normalizePyramid(v: unknown): Pyramid | null {
  const raw = v as { mission?: unknown; areas?: unknown; pillars?: unknown } | null
  if (!raw || typeof raw !== 'object') return null
  const mission = str(raw.mission, 120)
  const given = (raw.areas && typeof raw.areas === 'object' ? raw.areas : legacyAreas(raw.pillars)) as Record<string, unknown>
  const areas = Object.fromEntries(AREA_KEYS.map((k) => [k, strList(given[k], MAX_GOALS, 60)])) as Record<AreaKey, string[]>
  return mission || AREA_KEYS.some((k) => areas[k].length > 0) ? { mission, areas } : null
}

/** 金字塔里一共写了几个目标 */
export const goalCount = (p: Pyramid): number => AREA_KEYS.reduce((n, k) => n + p.areas[k].length, 0)

const MAX_MARKS = 3
const MAX_LINES = 4

/** 排好的行；没排行的（只给了一整句 short）就当一行，交给浏览器折 */
function noteLines(nn: { lines?: unknown; short?: unknown }): string[] {
  const raw = Array.isArray(nn.lines) ? nn.lines : [nn.short]
  return raw.map((x) => str(x, 30)).filter(Boolean).slice(0, MAX_LINES)
}

export function normalizeNotes(v: unknown): InkNote[] {
  if (!Array.isArray(v)) return []
  return v
    .map((n) => {
      const nn = n as { source?: unknown; lines?: unknown; short?: unknown; marks?: unknown }
      const lines = nn ? noteLines(nn) : []
      const short = lines.join('')
      const marks = Array.isArray(nn?.marks)
        ? nn.marks
          .map((m) => {
            const mm = m as { text?: unknown; kind?: unknown }
            return { text: str(mm?.text, 30), kind: mm?.kind as MarkKind }
          })
          // 标记必须是那句话里原样的一段，对不上的不画
          .filter((m) => m.text !== '' && MARK_KINDS.includes(m.kind) && short.includes(m.text))
          .slice(0, MAX_MARKS)
        : []
      return { source: str(nn?.source, MAX_ITEM_LEN), lines, marks }
    })
    .filter((n) => n.source !== '' && n.lines.length > 0)
    .slice(0, MAX_ITEMS)
}

/** 清单里还没誊上纸的那几条 */
export function missingNotes(items: readonly string[], notes: readonly InkNote[]): string[] {
  return items.filter((s) => !notes.some((n) => n.source === s))
}

/** 按清单的顺序排好纸：新誊的优先，清单里已经删掉的那条的纸不要了 */
export function mergeNotes(items: readonly string[], kept: readonly InkNote[], fresh: readonly InkNote[]): InkNote[] {
  return items.flatMap((s) => {
    const n = fresh.find((x) => x.source === s) ?? kept.find((x) => x.source === s)
    return n ? [n] : []
  })
}

export interface MarkSegment {
  readonly text: string
  readonly kind: MarkKind | null
}

/** 便利贴那句话切成段：每个标记取它在句中第一次出现的位置，和前面的重叠就不画 */
export function markSegments(short: string, marks: readonly NoteMark[]): MarkSegment[] {
  const ranges = marks
    .map((m) => ({ start: short.indexOf(m.text), end: short.indexOf(m.text) + m.text.length, kind: m.kind }))
    .filter((r) => r.start >= 0 && r.end > r.start)
    .reduce<{ start: number; end: number; kind: MarkKind }[]>(
      (acc, r) => (acc.some((a) => r.start < a.end && a.start < r.end) ? acc : [...acc, r]),
      [],
    )
    .sort((a, b) => a.start - b.start)
  const segments: MarkSegment[] = []
  let at = 0
  for (const r of ranges) {
    if (r.start > at) segments.push({ text: short.slice(at, r.start), kind: null })
    segments.push({ text: short.slice(r.start, r.end), kind: r.kind })
    at = r.end
  }
  if (at < short.length) segments.push({ text: short.slice(at), kind: null })
  return segments
}

/** 按行切开的手记段：标记跨了行就在行尾断成两截，各画各的 */
export function markLines(lines: readonly string[], marks: readonly NoteMark[]): MarkSegment[][] {
  const segments = markSegments(lines.join(''), marks)
  return lines.map((line, li) => {
    const start = lines.slice(0, li).join('').length
    const end = start + line.length
    let at = 0
    return segments.flatMap((s) => {
      const from = Math.max(at, start)
      const to = Math.min(at + s.text.length, end)
      const piece = to > from ? [{ text: s.text.slice(from - at, to - at), kind: s.kind }] : []
      at += s.text.length
      return piece
    })
  })
}

const WHEN = /^\d{4}-\d{2}(-\d{2})?$/

export function normalizeTimeline(v: unknown): Milestone[] | null {
  if (!Array.isArray(v)) return null
  const items = v
    .map((m) => {
      const mm = m as { when?: unknown; what?: unknown }
      return { when: str(mm?.when, 10), what: str(mm?.what, 80) }
    })
    .filter((m) => m.what !== '' && WHEN.test(m.when))
    .sort((a, b) => a.when.localeCompare(b.when))
    .slice(0, 12)
  return items
}

/** 后端拿回来的文档不可全信：逐字段校验，不认识的就当没有 */
export function normalizeDoc(v: unknown): GenesisDoc {
  const raw = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const stage = STAGES.includes(raw.stage as GenesisStage) ? (raw.stage as GenesisStage) : 'frustrations'
  return {
    version: 1,
    stage,
    frustrations: strList(raw.frustrations, MAX_ITEMS, MAX_ITEM_LEN),
    notes: normalizeNotes(raw.notes),
    wishes: strList(raw.wishes, MAX_ITEMS, MAX_ITEM_LEN),
    wishNotes: normalizeNotes(raw.wishNotes),
    reflection: typeof raw.reflection === 'string' && raw.reflection.trim() ? raw.reflection.trim() : null,
    pyramid: normalizePyramid(raw.pyramid),
    timeline: normalizeTimeline(raw.timeline),
  }
}

/** 年表上的日子还有多久（天）；只到月份的按当月 1 号算 */
export function daysUntil(when: string, now = new Date()): number {
  const [y, m, d] = when.split('-').map(Number)
  const target = new Date(y, (m || 1) - 1, d || 1)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}
