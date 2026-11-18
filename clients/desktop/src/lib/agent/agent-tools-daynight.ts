// ══════════════════════════════════════════════
// Fairy 的昼夜表工具：快捷记录、浮岛与日程、计划任务
//   写完都会通知主窗口重新取数（聊天可能跑在 Fairy 自己的窗口里）
//   手机端 src/lib/agent/tools/daynight-tools.ts 导入之外逐字一致，改工具要两端一起改
// ══════════════════════════════════════════════

import { addPlanNode, fetchActivityBlocks, fetchActivityPalette, paintActivityBlocks, setActivityTagAliases } from '../local-api'
import type { ActivityPalette, ActivityTag } from '../../types'
import type { ToolDefinition } from '../llm/types'
import {
  createIsland, deleteIsland, fetchActivityBlocksRange, fetchIslandChecks, fetchIslands, notifyDayNightChanged,
  setIslandCheck, updateIsland,
} from '../islands/island-api'
import {
  BLOCK_MINUTES, DAY_MINUTES, ESTIMATE_LOOKBACK_DAYS, WHOLE_ITEM_ID, addDays, computePlacements, describePlacementTime,
  describeLock, describeRule, minuteToHHmm, normalizeRule, parseHHmm, toDateKey,
} from '../islands/island-model'
import type { Island, IslandItem, IslandLock, IslandPlacement, IslandRule } from '../islands/island-model'
import { LOCK_PLATFORM } from '../islands/lock-platform'

export interface DayNightTool {
  readonly definition: ToolDefinition
  execute(args: Record<string, unknown>): Promise<string>
}

/** 不说时长时，最多自动往回填这么久的空档；再长就要主人说清楚 */
const MAX_AUTO_FILL_MIN = 180
const TAG_CANDIDATE_LIMIT = 6
/** 每个标签最多记几种说法；对话背景里最多带几条 */
const MAX_ALIASES_PER_TAG = 8
const ALIAS_CONTEXT_LIMIT = 30
const STATUS_TEXT: Record<IslandPlacement['status'], string> = { done: '做完了', active: '进行中', upcoming: '还没到', missed: '没做' }

// ── 小工具 ──

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function roundToBlock(minute: number): number {
  return Math.round(minute / BLOCK_MINUTES) * BLOCK_MINUTES
}

function parseDate(value: unknown): Date {
  const s = text(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const day = new Date(`${s}T00:00:00`)
    if (!Number.isNaN(day.getTime())) return day
  }
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** 时刻参数：没给 = undefined，写错抛错 */
function timeArg(value: unknown, name: string): number | undefined {
  if (value == null || value === '') return undefined
  const minute = parseHHmm(value)
  if (minute == null) throw new Error(`${name} 要写成 HH:mm，例如 07:30`)
  return minute
}

function numberArg(value: unknown, name: string): number | undefined {
  if (value == null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} 要是不小于 0 的数字`)
  return n
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** 0 = 对不上。分档见 resolveTag：≥ 90 是叫法对上，≥ 50 是名字里有这几个字，再低只是字面沾边 */
function scoreTag(tag: ActivityTag, query: string): number {
  const q = query.trim().toLowerCase().replace(/\s*[,，]\s*/g, ',')
  const path = tag.fullPath.toLowerCase()
  const leaf = tag.leafName.toLowerCase()
  const aliases = (tag.aliases ?? []).map((a) => a.toLowerCase())
  if (aliases.includes(q)) return 110
  if (path === q) return 100
  if (leaf === q) return 90
  if (leaf.includes(q)) return 70
  if (aliases.some((a) => a.includes(q) || q.includes(a))) return 60
  if (path.includes(q)) return 50
  const tokens = q.split(/[\s,，、/]+/).filter(Boolean)
  if (tokens.length > 1 && tokens.every((t) => path.includes(t))) return 40
  // 字面上沾边：说法里一半以上的汉字出现在叶子名或记过的说法里（「跑步」和「晨跑」），只当候选
  const chars = [...new Set(q.match(/[\u4e00-\u9fff]/g) ?? [])]
  const pool = leaf + aliases.join('')
  const hits = chars.filter((c) => pool.includes(c)).length
  return chars.length >= 2 && hits * 2 >= chars.length ? 20 + hits : 0
}

function recentTagList(palette: ActivityPalette): string {
  const recent = [...palette.tags].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)).slice(0, TAG_CANDIDATE_LIMIT)
  return recent.map((t) => t.fullPath).join(' / ') || '（空）'
}

/** 对话背景里带的标签说法：最近用过的标签在前，最多 ALIAS_CONTEXT_LIMIT 条 */
export function tagAliasRecords(palette: ActivityPalette): { alias: string; fullPath: string }[] {
  return [...palette.tags]
    .filter((t) => (t.aliases ?? []).length > 0)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .flatMap((t) => (t.aliases ?? []).map((alias) => ({ alias, fullPath: t.fullPath })))
    .slice(0, ALIAS_CONTEXT_LIMIT)
}

interface TagMatch {
  readonly tag: ActivityTag
  readonly score: number
  /**
   * sure：主人记过的说法、完整路径，或者只有一个标签叶子名对上
   * likely：只有这一个标签名字里有这几个字，可以记，但要跟主人说记到了哪
   * unsure：好几个都像，或者只是字面沾边，不写，先问主人
   */
  readonly level: 'sure' | 'likely' | 'unsure'
  readonly others: ActivityTag[]
}

/** 按主人的说法找标签：分数最高的那个；同分取最近用过的。一个都对不上就抛错，让模型去问主人 */
function resolveTag(query: string, palette: ActivityPalette): TagMatch {
  const ranked = palette.tags
    .map((tag) => ({ tag, score: scoreTag(tag, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.tag.lastUsedAt.localeCompare(a.tag.lastUsedAt))
  if (ranked.length === 0) {
    throw new Error(
      `标签库里没有和「${query}」对得上的标签。最近用过的：${recentTagList(palette)}。` +
      '按意思挑一两个最像的问主人是不是，主人说了算；还没有这个标签就请主人先在昼夜表里建。主人定了以后用完整路径重新调用，再用 RememberTagAlias 记下这个说法',
    )
  }
  const [best, next] = ranked
  const level = best.score >= 100 || (best.score >= 90 && (next == null || next.score < best.score))
    ? 'sure'
    : best.score >= 50 && (next == null || next.score < 40) ? 'likely' : 'unsure'
  return { tag: best.tag, score: best.score, level, others: ranked.slice(1, TAG_CANDIDATE_LIMIT).map((entry) => entry.tag) }
}

/** 没把握时不写：列出候选，要模型先问主人 */
function unsureMessage(query: string, match: TagMatch): string {
  const candidates = [match.tag, ...match.others].map((t) => t.fullPath).join(' / ')
  return `没把握「${query}」指哪个标签，这次没有写。可能是：${candidates}。` +
    `先问主人是哪一个（也可能都不是），不要自己挑；主人定了以后用完整路径重新调用，再用 RememberTagAlias 记下「${query}」这个说法`
}

/** 要写进库的地方用：好几个都像就抛错 */
function requireTag(query: string, palette: ActivityPalette): TagMatch {
  const match = resolveTag(query, palette)
  if (match.level === 'unsure') throw new Error(unsureMessage(query, match))
  return match
}

async function loadPlacements(date: Date, palette: ActivityPalette, islands?: readonly Island[]): Promise<IslandPlacement[]> {
  const [rules, blocks, history, checks] = await Promise.all([
    islands ? Promise.resolve(islands) : fetchIslands(),
    fetchActivityBlocks(date),
    fetchActivityBlocksRange(addDays(date, -ESTIMATE_LOOKBACK_DAYS), addDays(date, -1)),
    fetchIslandChecks(date),
  ])
  const now = new Date()
  const dateKey = toDateKey(date)
  const todayKey = toDateKey(now)
  return computePlacements({
    islands: rules,
    palette,
    blocks,
    historyByDate: history,
    checks,
    dayOffset: dateKey < todayKey ? -1 : dateKey > todayKey ? 1 : 0,
    nowMinute: now.getHours() * 60 + now.getMinutes(),
  })
}

function placementLines(p: IslandPlacement, palette: ActivityPalette): string {
  const { rule } = p.island
  const head = `- ${rule.name}（${rule.kind === 'fixed' ? '日程' : '浮岛'}，id ${p.island.id}）：${describePlacementTime(p)}，${STATUS_TEXT[p.status]}`
  const notes = [
    `规则：${describeRule(rule, palette)}`,
    describeLock(rule.lock),
    p.basis === 'estimated' ? `位置是按近 ${p.sampleDays} 天估的` : '',
    p.late ? '锚拖晚了，卡在最晚开始时刻' : '',
  ].filter(Boolean)
  const items = rule.items.map((item) => `    [${p.doneItemIds.includes(item.id) ? 'x' : ' '}] ${item.title}`)
  return [head, `  ${notes.join('；')}`, ...items].join('\n')
}

function findIsland(islands: readonly Island[], ref: string): Island {
  const exact = islands.find((i) => i.id === ref) ?? islands.find((i) => i.rule.name === ref)
  if (exact) return exact
  const partial = islands.filter((i) => i.rule.name.includes(ref))
  if (partial.length === 1) return partial[0]
  throw new Error(`找不到叫「${ref}」的浮岛或日程。现有：${islands.map((i) => i.rule.name).join(' / ') || '（一条都没有）'}`)
}

// ── RecordActivity ──

const recordActivity: DayNightTool = {
  definition: {
    type: 'function',
    function: {
      name: 'RecordActivity',
      description:
        '把主人刚做完的事记到昼夜表上。主人说「我刚洗完澡了」「刚吃完饭」「健身回来了」这类话时用。' +
        '默认做法：结束时刻取现在，按 5 分钟四舍五入；开始时刻取当天上一段记录的结尾，把中间空着的格子填上，已有记录的格子不动。' +
        '主人说了做了多久就传 minutes，说了几点开始或结束就传 start_time / end_time。' +
        '空档超过 3 小时又没说时长时不会乱填，会回来要你问主人。' +
        '标签好几个都像或对不上时不会写，会列出候选要你问主人；只对上一个但不完全一样时会记上，并提醒你跟主人说记到了哪。主人定了标签就用完整路径重记，再用 RememberTagAlias 记下主人的说法，下次就不用再问。' +
        '主人纠正标签（「不对，是 XX」）时带 overwrite=true 重记这一段，同样记下说法。' +
        '只有收到「已记录」的结果才算记上了。',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '做的是什么，用来在标签库里找标签。写主人的说法即可，例如「洗澡」「吃饭」「夜晚睡眠」，会先查主人记过的说法；也可以写完整路径' },
          minutes: { type: 'number', description: '持续了多少分钟（主人说了才传）' },
          start_time: { type: 'string', description: '开始时刻 HH:mm（主人说了才传）' },
          end_time: { type: 'string', description: '结束时刻 HH:mm，不传 = 现在' },
          date: { type: 'string', description: '日期 YYYY-MM-DD，不传 = 今天' },
          overwrite: { type: 'boolean', description: '是否盖掉这段时间里已有的记录，默认不盖' },
        },
        required: ['tag'],
      },
    },
  },
  async execute(args) {
    const query = text(args.tag)
    if (!query) return '缺少参数：tag'
    const date = parseDate(args.date)
    const isToday = toDateKey(date) === toDateKey(new Date())
    const now = new Date()
    const endArg = timeArg(args.end_time, 'end_time')
    if (endArg == null && !isToday) return '记的不是今天时要给 end_time'
    const end = Math.min(DAY_MINUTES, roundToBlock(endArg ?? now.getHours() * 60 + now.getMinutes()))
    const startArg = timeArg(args.start_time, 'start_time')
    const minutes = numberArg(args.minutes, 'minutes')

    const [palette, blocks] = await Promise.all([fetchActivityPalette(), fetchActivityBlocks(date)])
    const match = resolveTag(query, palette)
    if (match.level === 'unsure') return unsureMessage(query, match)
    const { tag, others } = match
    const taken = new Set(blocks.map((b) => b.minute))

    let start: number
    if (startArg != null) {
      start = roundToBlock(startArg)
    } else if (minutes != null) {
      start = end - Math.max(BLOCK_MINUTES, roundToBlock(minutes))
    } else {
      const before = blocks.filter((b) => b.minute < end).map((b) => b.minute + BLOCK_MINUTES)
      if (before.length === 0) return `今天 ${minuteToHHmm(end)} 之前还没有任何记录，不知道从哪开始填。问主人「${tag.leafName}」做了多久，再带 minutes 调一次`
      start = Math.max(...before)
      if (end - start > MAX_AUTO_FILL_MIN) {
        return `上一段记录到 ${minuteToHHmm(start)} 为止，离 ${minuteToHHmm(end)} 空了 ${end - start} 分钟，不像都是「${tag.leafName}」。问主人做了多久，再带 minutes 或 start_time 调一次`
      }
    }
    start = Math.max(0, start)
    if (end <= start) return `${minuteToHHmm(end)} 之前已经记满了（上一段记到 ${minuteToHHmm(start)}），没有空格子可填。要改已有的记录就带 start_time 和 overwrite=true`

    const overwrite = args.overwrite === true
    const slots: number[] = []
    for (let m = start; m < end; m += BLOCK_MINUTES) {
      if (overwrite || !taken.has(m)) slots.push(m)
    }
    if (slots.length === 0) return `${minuteToHHmm(start)}–${minuteToHHmm(end)} 已经都有记录了，没有改动。要盖掉就带 overwrite=true`

    await paintActivityBlocks(date, slots, tag.id)
    notifyDayNightChanged()

    const skipped = (end - start) / BLOCK_MINUTES - slots.length
    const lines = [`已记录「${tag.fullPath}」${minuteToHHmm(start)}–${minuteToHHmm(end)}，填了 ${slots.length * BLOCK_MINUTES} 分钟`]
    if (match.score > 100) lines.push(`「${query}」是按主人记过的说法对上的`)
    if (skipped > 0) lines.push(`其中 ${skipped * BLOCK_MINUTES} 分钟已有别的记录，没有动`)
    if (match.level === 'likely') {
      lines.push(`「${query}」没有完全对上，是按名字记到「${tag.fullPath}」的。跟主人说一声记到了哪：主人认了就用 RememberTagAlias 记下「${query}」，不对就带 overwrite=true 改记`)
    } else if (others.length > 0 && match.score < 100) {
      lines.push(`对得上的标签还有：${others.map((t) => t.fullPath).join(' / ')}。如果该用别的，告诉主人并重记`)
    }
    return lines.join('\n')
  },
}

// ── GetIslands ──

const getIslands: DayNightTool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetIslands',
      description:
        '看昼夜表上的浮岛与日程：某一天各条排在几点、里面的事勾没勾、规则是什么。' +
        '浮岛 = 不钉死钟点、跟在某件事后面的规划区块（比如「睡醒后」「吃完饭两小时后」）；日程 = 钉在钟点上的（比如到点早睡）。' +
        '改规则、勾事项之前先用它拿到 id 和现状。',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: '日期 YYYY-MM-DD，不传 = 今天' } },
      },
    },
  },
  async execute(args) {
    const date = parseDate(args.date)
    const [palette, islands] = await Promise.all([fetchActivityPalette(), fetchIslands()])
    if (islands.length === 0) return '还没有任何浮岛或日程'
    const placements = await loadPlacements(date, palette, islands)
    const disabled = islands.filter((i) => !i.rule.enabled)
    const lines = [`${toDateKey(date)} 的浮岛与日程：`, ...placements.map((p) => placementLines(p, palette))]
    if (disabled.length > 0) lines.push(`已停用：${disabled.map((i) => `${i.rule.name}（id ${i.id}）`).join(' / ')}`)
    return lines.join('\n')
  },
}

// ── SaveIsland ──

/** 改清单时标题没变的沿用原 id，这样当天已经勾掉的不会丢 */
/** SaveIsland 的锁参数并进原来的锁名单：没传的保持原样；应用只动这台设备的那几项 */
function mergeLock(args: Record<string, unknown>, previous: IslandLock | null): unknown {
  const list = (value: unknown): string[] | null => (Array.isArray(value) ? value.map(text).filter(Boolean) : null)
  const apps = list(args.lock_apps)
  const sites = list(args.lock_sites)
  const grays = list(args.lock_gray)
  const prompt = typeof args.lock_judge_prompt === 'string' ? args.lock_judge_prompt : null
  const untilDone = typeof args.lock_until_done === 'boolean' ? args.lock_until_done : null
  if (!apps && !sites && !grays && prompt == null && untilDone == null) return previous

  const graySet = grays ? new Set(grays.map((g) => g.toLowerCase())) : null
  const wasGray = new Set(
    [...(previous?.apps ?? []), ...(previous?.sites ?? [])].filter((e) => e.gray).map((e) => e.rule.toLowerCase()),
  )
  const isGray = (rule: string) => (graySet ?? wasGray).has(rule.toLowerCase())
  const mine = previous?.apps.filter((e) => e.platform === LOCK_PLATFORM) ?? []
  const others = previous?.apps.filter((e) => e.platform !== LOCK_PLATFORM) ?? []
  return {
    apps: [
      ...others,
      ...(apps ?? mine.map((e) => e.rule)).map((rule) => ({ rule, gray: isGray(rule), platform: LOCK_PLATFORM })),
    ],
    sites: (sites ?? previous?.sites.map((e) => e.rule) ?? []).map((rule) => ({ rule, gray: isGray(rule) })),
    intent: prompt ?? previous?.intent ?? '',
    untilDone: untilDone ?? previous?.untilDone ?? false,
  }
}

function mergeItems(titles: readonly string[], previous: readonly IslandItem[]): Array<{ id?: string; title: string }> {
  const pool = [...previous]
  return titles.map((title) => {
    const index = pool.findIndex((item) => item.title === title)
    if (index < 0) return { title }
    const [kept] = pool.splice(index, 1)
    return { id: kept.id, title }
  })
}

const saveIsland: DayNightTool = {
  definition: {
    type: 'function',
    function: {
      name: 'SaveIsland',
      description:
        '新建或修改一条浮岛 / 日程。不传 id = 新建；传 id（或已有的名字）= 修改，只改传了的字段。' +
        'kind=after 是浮岛：跟在 anchor_tag 那个标签的记录结束之后 offset_minutes 分钟开始，持续 duration_minutes。' +
        '同一个标签一天出现好几次时，用 window_start / window_end 限定只认「结束时刻落在这个时段里」的那一次——' +
        '比如睡眠标签写 04:00–15:00（排除半夜刚睡下的那段），午饭写 11:00–17:00。当天那件事还没记时，位置按近 7 天的平均估。' +
        'latest_start 是最晚开始时刻，那件事拖得再晚也不再往后排。' +
        'kind=fixed 是日程：每天 start_time 开始。' +
        'items 是里面要做的几件事（全勾完算做完）。' +
        '这一条进行期间可以锁住一些应用和网站（lock_apps / lock_sites）：到了时间自动锁，做完或到点解开。' +
        '拿不准该不该一刀切的写进 lock_gray，这些不直接拦，交给判断模型按 lock_judge_prompt 判这段内容算不算跑偏。' +
        'lock_judge_prompt 是你替主人写给判断模型的一段话：这段时间是为了什么、哪些内容算正事、哪些算跑偏，写具体。' +
        '主人只说了大概时，时长和时段按常理给个合理的值，建完把规则念给主人听，让主人改。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要修改的那条的 id 或名字；新建不传' },
          name: { type: 'string', description: '名字，例如「起床后」「健身」「早睡」' },
          kind: { type: 'string', enum: ['after', 'fixed'], description: 'after 浮岛 / fixed 日程' },
          anchor_tag: { type: 'string', description: 'after：跟在哪个标签后面，写主人的说法，例如「夜晚睡眠」「吃饭」' },
          window_start: { type: 'string', description: 'after：时段开始 HH:mm，默认 00:00' },
          window_end: { type: 'string', description: 'after：时段结束 HH:mm，默认 24:00' },
          offset_minutes: { type: 'number', description: 'after：结束后隔多少分钟开始，默认 0' },
          latest_start: { type: 'string', description: 'after：最晚开始时刻 HH:mm；传空字符串 = 不限' },
          start_time: { type: 'string', description: 'fixed：开始时刻 HH:mm' },
          duration_minutes: { type: 'number', description: '占多少分钟' },
          items: { type: 'array', items: { type: 'string' }, description: '里面要做的事，按顺序。传了就整份替换' },
          enabled: { type: 'boolean', description: 'false = 停用（不出现在昼夜表上）' },
          lock_apps: { type: 'array', items: { type: 'string' }, description: '这台设备上要锁的应用（电脑写 exe 名，手机写包名）。传了就整份替换这台设备的；传空数组 = 这台设备不锁应用' },
          lock_sites: { type: 'array', items: { type: 'string' }, description: '要锁的网站域名，例如 bilibili.com。传了就整份替换；传空数组 = 不锁网站' },
          lock_gray: { type: 'array', items: { type: 'string' }, description: 'lock_apps / lock_sites 里哪几项是灰色地带（不直接拦，交给判断模型）。传了就整份替换' },
          lock_judge_prompt: { type: 'string', description: '给判断模型看的判断标准，一段话；传空字符串 = 清掉（只按名字判）' },
          lock_until_done: { type: 'boolean', description: 'true = 里面的事全勾完才解开；false = 到这一条的结束时刻自动解开' },
        },
      },
    },
  },
  async execute(args) {
    const [palette, islands] = await Promise.all([fetchActivityPalette(), fetchIslands()])
    const ref = text(args.id)
    const existing = ref ? findIsland(islands, ref) : null
    const base: Partial<IslandRule> = existing?.rule ?? {}

    const anchorQuery = text(args.anchor_tag)
    const anchorTagId = anchorQuery ? requireTag(anchorQuery, palette).tag.id : base.anchorTagId ?? null
    const latestArg = args.latest_start === '' ? null : timeArg(args.latest_start, 'latest_start')
    const titles = Array.isArray(args.items) ? args.items.map(text).filter(Boolean) : null

    const rule = normalizeRule({
      name: text(args.name) || base.name,
      kind: args.kind === 'fixed' || args.kind === 'after' ? args.kind : base.kind ?? (anchorTagId != null ? 'after' : 'fixed'),
      anchorTagId,
      windowStart: timeArg(args.window_start, 'window_start') ?? base.windowStart,
      windowEnd: timeArg(args.window_end, 'window_end') ?? base.windowEnd,
      offsetMin: numberArg(args.offset_minutes, 'offset_minutes') ?? base.offsetMin,
      latestStart: latestArg === undefined ? base.latestStart : latestArg,
      startMinute: timeArg(args.start_time, 'start_time') ?? base.startMinute,
      durationMin: numberArg(args.duration_minutes, 'duration_minutes') ?? base.durationMin,
      items: titles ? mergeItems(titles, base.items ?? []) : base.items,
      color: base.color ?? null,
      enabled: typeof args.enabled === 'boolean' ? args.enabled : base.enabled,
      lock: mergeLock(args, base.lock ?? null),
    })

    const saved = existing ? await updateIsland(existing.id, rule) : await createIsland(rule)
    notifyDayNightChanged()

    const today = parseDate(undefined)
    const placement = (await loadPlacements(today, palette)).find((p) => p.island.id === saved.id)
    const lines = [`${existing ? '已修改' : '已新建'}${saved.rule.kind === 'fixed' ? '日程' : '浮岛'}「${saved.rule.name}」（id ${saved.id}）`]
    if (placement) lines.push(`今天的情况：\n${placementLines(placement, palette)}`)
    else lines.push(`规则：${describeRule(saved.rule, palette)}（已停用，不出现在昼夜表上）`)
    return lines.join('\n')
  },
}

// ── DeleteIsland ──

const deleteIslandTool: DayNightTool = {
  definition: {
    type: 'function',
    function: {
      name: 'DeleteIsland',
      description: '删掉一条浮岛 / 日程，以后的昼夜表上不再出现。只是暂时不用就用 SaveIsland 传 enabled=false。删之前要主人明确说过要删。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '那条的 id 或名字' } },
        required: ['id'],
      },
    },
  },
  async execute(args) {
    const ref = text(args.id)
    if (!ref) return '缺少参数：id'
    const island = findIsland(await fetchIslands(), ref)
    await deleteIsland(island.id)
    notifyDayNightChanged()
    return `已删除「${island.rule.name}」`
  },
}

// ── CheckIslandItem ──

const checkIslandItem: DayNightTool = {
  definition: {
    type: 'function',
    function: {
      name: 'CheckIslandItem',
      description:
        '勾掉（或取消勾）某条浮岛 / 日程里的一件事。主人说「水烧上了」「刷完酸了」这类话，而那正好是某条浮岛里的事时用。' +
        '不传 item = 整条算做完（清单里的事全勾上）。',
      parameters: {
        type: 'object',
        properties: {
          island: { type: 'string', description: '那条的 id 或名字' },
          item: { type: 'string', description: '事项的标题（或其中几个字）；不传 = 全部' },
          done: { type: 'boolean', description: '默认 true；false = 取消勾' },
          date: { type: 'string', description: '日期 YYYY-MM-DD，不传 = 今天' },
        },
        required: ['island'],
      },
    },
  },
  async execute(args) {
    const ref = text(args.island)
    if (!ref) return '缺少参数：island'
    const date = parseDate(args.date)
    const done = args.done !== false
    const island = findIsland(await fetchIslands(), ref)
    const { items } = island.rule
    const query = text(args.item)

    let targets: readonly IslandItem[]
    if (!query) {
      targets = items.length > 0 ? items : [{ id: WHOLE_ITEM_ID, title: '整条' }]
    } else {
      const hit = items.find((i) => i.title === query) ?? items.find((i) => i.title.includes(query) || query.includes(i.title))
      if (!hit) return `「${island.rule.name}」里没有和「${query}」对得上的事。里面有：${items.map((i) => i.title).join(' / ') || '（没有列清单，不传 item 就是整条做完）'}`
      targets = [hit]
    }
    await Promise.all(targets.map((item) => setIslandCheck(date, island.id, item.id, done)))
    notifyDayNightChanged()

    const palette = await fetchActivityPalette()
    const placement = (await loadPlacements(date, palette)).find((p) => p.island.id === island.id)
    const head = `已${done ? '勾掉' : '取消勾'}「${island.rule.name}」的${targets.map((t) => `「${t.title}」`).join('')}`
    return placement ? `${head}\n${placementLines(placement, palette)}` : head
  },
}

// ── CreatePlanTask ──

const createPlanTask: DayNightTool = {
  definition: {
    type: 'function',
    function: {
      name: 'CreatePlanTask',
      description:
        '往「计划安排」里加一条待办任务，挂在某个项目标签下面（和协议志清单是同一份数据）。' +
        '主人说「帮我记个待办」「把 XX 加到计划里」时用。它只是清单里的一条，不占昼夜表的时间；要排到时间上，是浮岛或日程的事（SaveIsland）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题' },
          project_tag: { type: 'string', description: '挂在哪个标签下面，写主人的说法，例如「solevup」「饮食」' },
          due_date: { type: 'string', description: '截止日期 YYYY-MM-DD，可选' },
        },
        required: ['title', 'project_tag'],
      },
    },
  },
  async execute(args) {
    const title = text(args.title)
    const query = text(args.project_tag)
    if (!title) return '缺少参数：title'
    if (!query) return '缺少参数：project_tag'
    const dueDate = text(args.due_date)
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return 'due_date 要写成 YYYY-MM-DD'
    const { tag } = requireTag(query, await fetchActivityPalette())
    const node = await addPlanNode(tag.id, title, null, { dueDate: dueDate || null })
    notifyDayNightChanged()
    return `已新建任务「${node.title}」，挂在「${tag.fullPath}」下面${dueDate ? `，截止 ${dueDate}` : ''}`
  },
}

// ── RememberTagAlias ──

const rememberTagAlias: DayNightTool = {
  definition: {
    type: 'function',
    function: {
      name: 'RememberTagAlias',
      description:
        '记住主人对某个活动标签的说法，例如主人说「跑步」指的是「运动,晨跑」。记下后 RecordActivity 等工具按这个说法直接找到标签，对话背景里也会带上。' +
        '只在主人确认或纠正过标签之后记，自己猜的不要记。这个说法已经记在别的标签上时会改过来；主人说记错了就带 forget=true 删掉。',
      parameters: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: '主人的说法，照主人的原话写' },
          tag: { type: 'string', description: '对应标签的完整路径，例如「运动,晨跑」。forget 时不用写' },
          forget: { type: 'boolean', description: '删掉这个说法' },
        },
        required: ['alias'],
      },
    },
  },
  async execute(args) {
    const alias = text(args.alias)
    if (!alias) return '缺少参数：alias'
    const palette = await fetchActivityPalette()
    const holders = palette.tags.filter((t) => (t.aliases ?? []).some((a) => sameText(a, alias)))
    const without = (t: ActivityTag) => (t.aliases ?? []).filter((a) => !sameText(a, alias))

    if (args.forget === true) {
      if (holders.length === 0) return `没有记过「${alias}」这个说法`
      for (const t of holders) await setActivityTagAliases(t.id, without(t))
      return `已忘掉「${alias}」（原来指「${holders.map((t) => t.fullPath).join(' / ')}」）`
    }

    const query = text(args.tag)
    if (!query) return '缺少参数：tag'
    // 找目标标签时不看已记的说法：要改的正是它们，记错的那条会把目标带偏
    const target = requireTag(query, { ...palette, tags: palette.tags.map((t) => ({ ...t, aliases: [] })) }).tag
    const tag = palette.tags.find((t) => t.id === target.id) ?? target
    if (sameText(alias, tag.fullPath)) return `「${alias}」就是这个标签的完整路径，不用记`
    const moved = holders.filter((t) => t.id !== tag.id)
    for (const t of moved) await setActivityTagAliases(t.id, without(t))
    if (!holders.some((t) => t.id === tag.id)) {
      await setActivityTagAliases(tag.id, [...(tag.aliases ?? []), alias].slice(-MAX_ALIASES_PER_TAG))
    }
    const note = moved.length > 0 ? `（原来记在「${moved.map((t) => t.fullPath).join(' / ')}」上，已改过来）` : ''
    return `记住了：主人说「${alias}」就是「${tag.fullPath}」${note}`
  },
}

export const DAYNIGHT_TOOLS: readonly DayNightTool[] = [
  recordActivity,
  getIslands,
  saveIsland,
  deleteIslandTool,
  checkIslandItem,
  createPlanTask,
  rememberTagAlias,
]
