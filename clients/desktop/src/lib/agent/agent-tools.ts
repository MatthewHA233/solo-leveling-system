// ══════════════════════════════════════════════
// Agent Tools — Fairy 可调用的工具
// ══════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core'
import { fetchPerceptionSpans, fetchBiliSpans, fetchActivityBlocks, fetchActivityPalette, fetchContextFeed, fetchCardBindings, addContextCard, addBinding, updateContextCard, updateAnchorKeyword } from '../local-api'
import type { PerceptionSpan, BiliSpan, AnchorCategory } from '../local-api'
import { fetchBiliTranscriptSentences } from '../bili-transcript'
import type { ActivityPalette } from '../../types'
import type { ToolDefinition } from '../llm/types'

// ── 内部 Tool 接口 ──

interface Tool {
  readonly definition: ToolDefinition
  execute(args: Record<string, unknown>): Promise<string>
}

// ── 工具辅助函数 ──

/** YYYY-MM-DD → Date（当地时间 0:00），无效/缺省返回今天 */
function parseDateArg(dateArg: unknown): Date {
  if (typeof dateArg === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    return new Date(dateArg + 'T00:00:00')
  }
  return new Date()
}

/**
 * 将时间参数解析为可比较的字符串（"YYYY-MM-DD HH:MM"）。
 * 接受两种格式：
 *   "HH:MM"            → 补全今天日期，用于 date+days 场景的简单过滤
 *   "YYYY-MM-DD HH:MM" → 直接使用，用于跨天精确范围
 */
/**
 * 按时间段过滤 span，支持跨天范围。
 * span 与查询时间段有重叠即保留（而非完全包含）。
 * start/end 均为 "YYYY-MM-DD HH:MM" 或 null（表示无限制）。
 */
function filterByTime<T extends { start_at: string; end_at: string }>(
  spans: T[],
  fromDT: string | null,
  toDT: string | null,
): T[] {
  if (!fromDT && !toDT) return spans
  // span 的 start_at/end_at 格式是 "2026-04-09 14:32:00"，取前16位做字符串比较
  return spans.filter(s => {
    const spanStart = s.start_at.slice(0, 16)
    const spanEnd   = s.end_at.slice(0, 16)
    const afterFrom  = !fromDT || spanEnd   >= fromDT
    const beforeTo   = !toDT   || spanStart <= toDT
    return afterFrom && beforeTo
  })
}

/** keyword 参数 → 小写关键词列表。
 *  防御 Qwen 函数调用的双重编码毛病：数组会被序列化成字符串 '["a","b"]' 传进来，
 *  直接拿这串字面量做子串匹配永远查不到（曾导致 AI 误判"没有匹配的想法卡"而重复建卡）。*/
function normalizeKeywords(keyword: unknown): string[] {
  if (typeof keyword === 'string') {
    const t = keyword.trim()
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(t)
        if (Array.isArray(parsed)) return normalizeKeywords(parsed)
      } catch { /* 不是合法 JSON 数组就按普通子串处理 */ }
    }
    return t ? [t.toLowerCase()] : []
  }
  if (Array.isArray(keyword)) {
    return keyword.flatMap((k) => (typeof k === 'string' && k.trim() ? [k.trim().toLowerCase()] : []))
  }
  return []
}

/** 按关键词过滤（大小写不敏感子串匹配，支持单个字符串或字符串数组取并集） */
function filterByKeyword<T>(
  spans: T[],
  keyword: unknown,
  getFields: (s: T) => string[],
): T[] {
  const kws = normalizeKeywords(keyword)
  if (kws.length === 0) return spans
  return spans.filter(s => {
    const fields = getFields(s).map(f => f.toLowerCase())
    return kws.some(kw => fields.some(f => f.includes(kw)))
  })
}

/**
 * 根据 date/days 或 start_datetime/end_datetime 推导出需要查哪几天。
 * 返回需要查询的日期列表（升序）。
 */
function resolveDatesToFetch(args: Record<string, unknown>): Date[] {
  const startDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
  const endDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null

  if (startDT && endDT) {
    // 精确范围模式：从 start 日期到 end 日期，逐天列出
    const startDay = new Date(startDT.slice(0, 10) + 'T00:00:00')
    const endDay   = new Date(endDT.slice(0, 10) + 'T00:00:00')
    const dates: Date[] = []
    const cursor = new Date(startDay)
    while (cursor <= endDay) {
      dates.push(new Date(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }
    return dates
  }

  // 简单模式：date + days
  const baseDate = parseDateArg(args.date)
  const days = typeof args.days === 'number' && args.days > 1 ? Math.min(args.days, 30) : 1
  const dates: Date[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(baseDate)
    d.setDate(d.getDate() - i)
    dates.push(d)
  }
  return dates
}

/** 查询指定日期列表的所有 感知 spans，合并排序 */
async function fetchPerceptionSpansRange(dates: Date[]): Promise<PerceptionSpan[]> {
  const results = await Promise.all(dates.map(d => fetchPerceptionSpans(d).catch(() => [])))
  return results.flat().sort((a, b) => a.start_at.localeCompare(b.start_at))
}

// Activity blocks exposed as span-like records for the existing filters.
interface ActivityTagSpan {
  start_at: string
  end_at: string
  title: string
  group_name: string | null
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function minuteToHHmm(minute: number): string {
  const m = Math.max(0, Math.min(1440, minute))
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function activityLabelParts(tagId: number, palette: ActivityPalette): { title: string; groupName: string | null } {
  const tag = palette.tags.find((item) => item.id === tagId)
  const category = tag ? palette.categories.find((item) => item.id === tag.categoryId) : undefined
  const parts = tag?.fullPath.split(',').map((part) => part.trim()).filter(Boolean) ?? []
  const title = category?.name ?? parts[0] ?? tag?.leafName ?? `tag#${tagId}`
  const rest = parts.length > 1 ? parts.slice(1) : []
  const groupName = rest.length > 0
    ? rest.join(' / ')
    : tag?.leafName && tag.leafName !== title
      ? tag.leafName
      : null
  return { title, groupName }
}

async function fetchActivityTagSpansRange(dates: Date[]): Promise<ActivityTagSpan[]> {
  const palette = await fetchActivityPalette()
  const blocksByDate = await Promise.all(dates.map(d => fetchActivityBlocks(d).catch(() => [])))
  const out: ActivityTagSpan[] = []

  dates.forEach((date, index) => {
    const day = localDateKey(date)
    const blocks = blocksByDate[index]
      .filter((block) => block.minute >= 0 && block.minute < 1440)
      .sort((a, b) => a.minute - b.minute)
    const groups: Array<{ tagId: number; start: number; end: number }> = []

    for (const block of blocks) {
      const end = Math.min(1440, block.minute + 5)
      const last = groups[groups.length - 1]
      if (last && last.tagId === block.tagId && last.end === block.minute) {
        last.end = end
      } else {
        groups.push({ tagId: block.tagId, start: block.minute, end })
      }
    }

    for (const group of groups) {
      const labels = activityLabelParts(group.tagId, palette)
      out.push({
        start_at: `${day} ${minuteToHHmm(group.start)}:00`,
        end_at: `${day} ${minuteToHHmm(group.end)}:00`,
        title: labels.title,
        group_name: labels.groupName,
      })
    }
  })

  return out.sort((a, b) => a.start_at.localeCompare(b.start_at))
}

/** 查询指定日期列表的所有 BiliSpans，合并排序 */
async function fetchBiliSpansRange(dates: Date[]): Promise<BiliSpan[]> {
  const results = await Promise.all(dates.map(d => fetchBiliSpans(d).catch(() => [])))
  return results.flat().sort((a, b) => a.start_at.localeCompare(b.start_at))
}

// ── 三个 DB 工具共用的参数 schema ──

const TIME_RANGE_PARAMS = {
  date:           { type: 'string', description: '查询日期，格式 YYYY-MM-DD，默认今天。与 days 配合使用' },
  days:           { type: 'number', description: '往前查几天（含 date 当天），默认 1。查"这周"传 7' },
  start_datetime: { type: 'string', description: '精确起始时间，格式 "YYYY-MM-DD HH:MM"。提供此参数则忽略 date/days' },
  end_datetime:   { type: 'string', description: '精确结束时间，格式 "YYYY-MM-DD HH:MM"。与 start_datetime 配对使用，支持跨天（如昨晚18:00到今晨05:00）' },
} as const

// ── GetAppUsage ──

const getAppUsage: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetAppUsage',
      description:
        '查询本机自动记录的应用使用记录（哪个 app、哪个窗口标题、什么时间段）。' +
        '支持按日期、精确时间范围（含跨天）、关键词过滤。' +
        '适用于："今天下午用了什么软件""这周有没有打开 VSCode""昨晚在干嘛"等查询。' +
        ' keyword 可传字符串数组一次过滤多个候选词（取并集），优先用数组而不是多次调用本工具。' +
        '返回"无匹配的应用使用记录"即代表该时段内确实没有相关使用，请直接如实告知主人，不要换词重试或猜测——主人只是没用过。',
      parameters: {
        type: 'object',
        properties: {
          ...TIME_RANGE_PARAMS,
          keyword: {
            description: '按应用名或窗口标题过滤（大小写不敏感子串）。可以是字符串或字符串数组（数组取并集，一次查多个候选）',
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const dates = resolveDatesToFetch(args)
    const fromDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
    const toDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null

    const all = await fetchPerceptionSpansRange(dates)
    let apps = all.filter(s => s.track === 'apps')
    apps = filterByTime(apps, fromDT, toDT)
    apps = filterByKeyword(apps, args.keyword, s => [s.title, s.group_name ?? ''])

    if (apps.length === 0) return '无匹配的应用使用记录'
    return apps
      .map(s => `${s.start_at.slice(0, 16)} - ${s.end_at.slice(11, 16)}  [${s.title}] ${s.group_name ?? ''}`)
      .join('\n')
  },
}

// ── GetActivityTags ──

const getActivityTags: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetActivityTags',
      description:
        '查询本机活动标签（如"工作""学习""娱乐"等手动或 AI 生成的分类标签）。' +
        '支持按日期、精确时间范围（含跨天）、关键词过滤。' +
        '适用于："今天学习了多久""这周工作时间怎么分布"等查询。' +
        ' keyword 可传字符串数组一次过滤多个候选词（取并集），优先用数组而不是多次调用本工具。' +
        '返回"无匹配的活动标签记录"即代表该时段内确实没有相关标签，请直接如实告知主人，不要换词重试。',
      parameters: {
        type: 'object',
        properties: {
          ...TIME_RANGE_PARAMS,
          keyword: {
            description: '按标签名过滤（大小写不敏感子串）。可以是字符串或字符串数组（数组取并集，一次查多个候选）',
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const dates = resolveDatesToFetch(args)
    const fromDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
    const toDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null

    let tags = await fetchActivityTagSpansRange(dates)
    tags = filterByTime(tags, fromDT, toDT)
    tags = filterByKeyword(tags, args.keyword, s => [s.title, s.group_name ?? ''])

    if (tags.length === 0) return '无匹配的活动标签记录'
    return tags
      .map(s => `${s.start_at.slice(0, 16)} - ${s.end_at.slice(11, 16)}  [${s.title}]${s.group_name ? ` / ${s.group_name}` : ''}`)
      .join('\n')
  },
}

// ── GetComputerStatus ──

const getComputerStatus: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetComputerStatus',
      description:
        '查询本机自动记录的电脑状态记录（active/idle/afk，对应正在操作、短暂空闲、离开键鼠）。' +
        '支持按日期、精确时间范围（含跨天）过滤。' +
        '适用于："昨晚什么时候离开电脑""今天下午有多久没操作""刚才是不是空闲了"等查询。',
      parameters: {
        type: 'object',
        properties: {
          ...TIME_RANGE_PARAMS,
          status: {
            description: '可选状态过滤：active、idle、afk',
            type: 'string',
          },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const dates = resolveDatesToFetch(args)
    const fromDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
    const toDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null
    const status = typeof args.status === 'string' ? args.status.toLowerCase() : null

    const all = await fetchPerceptionSpansRange(dates)
    let statuses = all.filter(s => s.track === 'status')
    statuses = filterByTime(statuses, fromDT, toDT)
    if (status) statuses = statuses.filter(s => (s.group_name ?? s.title).toLowerCase() === status)

    if (statuses.length === 0) return '无匹配的电脑状态记录'
    return statuses
      .map(s => `${s.start_at.slice(0, 16)} - ${s.end_at.slice(11, 16)}  ${s.title}`)
      .join('\n')
  },
}

// ── GetBiliHistory ──

const getBiliHistory: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetBiliHistory',
      description:
        '查询主人 B 站观看历史（视频标题、URL、观看时间）。' +
        '支持按日期、精确时间范围（含跨天）、关键词过滤。' +
        '适用于："今晚看了什么视频""这周看过什么游戏视频""昨晚的B站记录"等查询。' +
        ' keyword 可传字符串数组一次过滤多个候选词（取并集），优先用数组而不是多次调用本工具。' +
        '返回"无匹配的 B 站观看记录"即代表该时段内确实没有相关视频，请直接如实告知主人，不要换词重试。',
      parameters: {
        type: 'object',
        properties: {
          ...TIME_RANGE_PARAMS,
          keyword: {
            description: '按视频标题过滤（大小写不敏感子串）。可以是字符串或字符串数组（数组取并集，一次查多个候选）',
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const dates = resolveDatesToFetch(args)
    const fromDT = typeof args.start_datetime === 'string' ? args.start_datetime : null
    const toDT   = typeof args.end_datetime   === 'string' ? args.end_datetime   : null

    const all = await fetchBiliSpansRange(dates)
    let spans = filterByTime(all, fromDT, toDT)
    spans = filterByKeyword(spans, args.keyword, s => [s.title])

    if (spans.length === 0) return '无匹配的 B 站观看记录'
    return spans
      .map(s => `${s.start_at.slice(0, 16)}  《${s.title}》  https://www.bilibili.com/video/${s.bvid}`)
      .join('\n')
  },
}

// ── GetThoughtCards ──

const getThoughtCards: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetThoughtCards',
      description:
        '查询主人的想法卡片（主人也可能叫它 memo / 想法 / 沉淀 / 卡片，都是同一个东西，存在洪流域里，不是文件）。' +
        '返回每张卡的 card_id、时间、来源、正文与锚点句。' +
        '主人说"改一下我那条想法/memo"时，先用这个找到目标卡，再用 UpdateThoughtCard 修改。' +
        '已知 card_id（如系统提示里"主人当前选中的卡片"）就传 card_id 直查，不要把 id 塞进 keyword。' +
        'keyword 可传字符串或字符串数组（取并集）。返回"没有匹配的想法卡"则换更宽泛的词试一次，仍没有就如实告知。',
      parameters: {
        type: 'object',
        properties: {
          card_id: {
            type: 'string',
            description: '按 card_id 直查单张卡（完整 id 或前缀）。已知 id 时优先用这个',
          },
          keyword: {
            description: '按正文/来源标签过滤（大小写不敏感子串）。可以是字符串或字符串数组（数组取并集）',
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          days: { type: 'number', description: '只看最近 N 天，缺省看全部' },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const feed = await fetchContextFeed()
    let cards = feed.filter(c => c.kind === 'thought')
    if (typeof args.days === 'number' && args.days > 0) {
      const cutoff = Date.now() - args.days * 86_400_000
      cards = cards.filter(c => {
        let v = c.created_at.includes('T') ? c.created_at : c.created_at.replace(' ', 'T')
        if (v.length > 10 && !/[Z+]/.test(v.slice(10))) v += 'Z'
        const t = new Date(v).getTime()
        return Number.isNaN(t) || t >= cutoff
      })
    }
    // card_id 直查（前缀容错）；模型有时仍会把 id 塞进 keyword，所以 keyword 匹配域也含 id 兜底
    const cardIdArg = typeof args.card_id === 'string' ? args.card_id.trim() : ''
    if (cardIdArg) cards = cards.filter(c => c.id.startsWith(cardIdArg))
    cards = filterByKeyword(cards, args.keyword, c => [c.text, c.source_label ?? '', c.id])
    if (cards.length === 0) return '没有匹配的想法卡'

    const lines = await Promise.all(cards.slice(0, 20).map(async c => {
      const bs = await fetchCardBindings(c.id).catch(() => [])
      const seen = new Set<string>()
      const anchors = bs.flatMap(b => b.anchors).filter(a => {
        if (seen.has(a.id)) return false
        seen.add(a.id)
        return true
      })
      const anchorText = anchors.length
        ? `\n  锚点：${anchors.map(a => `[${a.category}] ${a.keyword} (anchor_id: ${a.id})`).join('；')}`
        : ''
      return `card_id: ${c.id}\n  ${c.created_at.slice(0, 16)}${c.source_label ? ` · ${c.source_label}` : ''}\n  正文：${c.text}${anchorText}`
    }))
    const more = cards.length > 20 ? `\n\n（共 ${cards.length} 张，只显示前 20 张，可用 keyword 缩小范围）` : ''
    return lines.join('\n\n') + more
  },
}

// ── CreateThoughtCard ──

const createThoughtCard: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'CreateThoughtCard',
      description:
        '把主人刚说的某段值得长期记的话，主动沉淀成一张想法卡（存进洪流域）。' +
        '日常聊天里会有后台自动沉淀，但当主人明确要求"帮我记下来 / 总结成想法卡 / 沉淀一下"、' +
        '或主人追问为何没记时，用本工具主动创建。' +
        '正文保持主人的原话风格、贴近原意，不要替换术语或加你的评论。' +
        'anchors 是从这段话提取的锚点句：10~30 字带姿态的完整短句（不是名词碎片、不带触发条件前缀），' +
        '按说话姿态归三类——motive(刺激·动机) / view(观点·看法) / practice(教程·实践)。' +
        '只有真的调用本工具并收到"已创建"结果后，才能告诉主人记好了——绝不允许只口头宣称。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '想法卡正文（贴近主人原话，轻润色通顺即可）' },
          anchors: {
            type: 'array',
            description: '锚点句列表（0~3 条）',
            items: {
              type: 'object',
              properties: {
                keyword: { type: 'string', description: '10~30 字带姿态的完整锚点句' },
                category: { type: 'string', enum: ['motive', 'view', 'practice'], description: '锚点三类' },
              },
              required: ['keyword', 'category'],
            },
          },
          source_label: { type: 'string', description: '可选语境来源标签，格式 "语境·<来源短名>"。这段话源于某视频/文章时传' },
          source_card_id: { type: 'string', description: '可选来源语境卡 card_id（如主人当前选中的 B 站语境卡）。传了主人就能从想法卡一键跳回语境' },
        },
        required: ['text'],
      },
    },
  },
  async execute(args) {
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) return '缺少参数：text'
    const sourceLabel = typeof args.source_label === 'string' && args.source_label.trim()
      ? args.source_label.trim().slice(0, 24)
      : undefined
    const sourceCardId = typeof args.source_card_id === 'string' && args.source_card_id.trim()
      ? args.source_card_id.trim()
      : undefined
    const valid: AnchorCategory[] = ['motive', 'view', 'practice']
    const anchors = Array.isArray(args.anchors)
      ? args.anchors.flatMap((x) => {
          if (!x || typeof x !== 'object') return []
          const o = x as Record<string, unknown>
          const keyword = typeof o.keyword === 'string' ? o.keyword.trim() : ''
          const category = o.category as AnchorCategory
          return keyword && valid.includes(category) ? [{ keyword, category }] : []
        }).slice(0, 3)
      : []

    const cardId = await addContextCard(text, sourceLabel, undefined, sourceCardId)
    // 整卡绑定（start_pos=0），挂上锚点
    await addBinding({
      card_id: cardId,
      start_pos: 0,
      end_pos: text.length,
      selected_text: text,
      user_speech: text,
      anchors,
    })
    window.dispatchEvent(new CustomEvent('solevup:context-updated'))
    const kw = anchors.map((a) => a.keyword).join('、')
    return `已创建想法卡 ${cardId.slice(0, 8)}${sourceLabel ? `（语境标签：${sourceLabel}）` : ''}${kw ? `（锚点：${kw}）` : ''}，正文：\n${text}`
  },
}

// ── UpdateThoughtCard ──

const updateThoughtCard: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'UpdateThoughtCard',
      description:
        '修改一张想法卡的正文（全文替换），可选同时改语境来源标签。先用 GetThoughtCards 找到目标卡拿到 card_id，' +
        '然后提供修改后的完整新正文——保持主人的原话风格，只改主人要求改的部分，不要顺手润色其他内容。' +
        '修改正文不会自动更新锚点句。' +
        '重要：只有真的调用本工具并收到"已更新"结果后，才能告诉主人改好了——绝不允许只口头宣称已修改。',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'string', description: '目标想法卡的 card_id（GetThoughtCards 返回的完整 id 或其前缀）' },
          new_text: { type: 'string', description: '修改后的完整新正文（全文替换）' },
          source_label: { type: 'string', description: '语境来源标签，格式 "语境·<来源短名>"（如 "语境·UI去AI味视频"）。主人要求补语境来源时传这个' },
        },
        required: ['card_id', 'new_text'],
      },
    },
  },
  async execute(args) {
    const cardId = typeof args.card_id === 'string' ? args.card_id.trim() : ''
    const newText = typeof args.new_text === 'string' ? args.new_text.trim() : ''
    if (!cardId || !newText) return '缺少参数：card_id 或 new_text'
    const sourceLabel = typeof args.source_label === 'string' && args.source_label.trim()
      ? args.source_label.trim().slice(0, 24)
      : undefined

    // 容错：允许 id 前缀
    let id = cardId
    if (cardId.length < 36) {
      const feed = await fetchContextFeed()
      const hits = feed.filter(c => c.kind === 'thought' && c.id.startsWith(cardId))
      if (hits.length === 0) return `找不到 card_id 为 ${cardId} 的想法卡（先用 GetThoughtCards 查询）`
      if (hits.length > 1) return `card_id 前缀 ${cardId} 匹配到多张卡，请用完整 id`
      id = hits[0].id
    }
    await updateContextCard(id, newText, sourceLabel)
    window.dispatchEvent(new CustomEvent('solevup:context-updated'))
    return `已更新想法卡 ${id.slice(0, 8)}${sourceLabel ? `（语境标签：${sourceLabel}）` : ''}，新正文：\n${newText}`
  },
}

// ── GetAnchors / UpdateAnchor ──

interface AnchorSummary {
  id: string
  keyword: string
  category: AnchorCategory
  bindings: number
}

/** 汇总全部锚点（含想法卡与语境卡的绑定计数） */
async function collectAllAnchors(): Promise<AnchorSummary[]> {
  const feed = await fetchContextFeed()
  const map = new Map<string, AnchorSummary>()
  const perCard = await Promise.all(feed.map(c => fetchCardBindings(c.id).catch(() => [])))
  for (const bindings of perCard) {
    for (const b of bindings) {
      for (const a of b.anchors) {
        const cur = map.get(a.id)
        if (cur) cur.bindings += 1
        else map.set(a.id, { id: a.id, keyword: a.keyword, category: a.category, bindings: 1 })
      }
    }
  }
  return [...map.values()].sort((x, y) => y.bindings - x.bindings)
}

const getAnchors: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetAnchors',
      description:
        '查询主人的锚点句（锚点域地图上的球；一句带姿态的完整短句，分 motive动机/view观点/practice实践 三类）。' +
        '返回 anchor_id、分类、锚点句、被锚定次数。主人说"改一下那个锚点/锚点句"时先用这个找到目标，再用 UpdateAnchor 修改。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            description: '按锚点句内容过滤（大小写不敏感子串）。可以是字符串或字符串数组（数组取并集）',
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    let anchors = await collectAllAnchors()
    anchors = filterByKeyword(anchors, args.keyword, a => [a.keyword])
    if (anchors.length === 0) return '没有匹配的锚点句'
    return anchors
      .map(a => `anchor_id: ${a.id}\n  [${a.category}] ${a.keyword}（${a.bindings} 处绑定）`)
      .join('\n\n')
  },
}

const updateAnchor: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'UpdateAnchor',
      description:
        '修改一条锚点句。先用 GetAnchors 或 GetThoughtCards 拿到 anchor_id。' +
        '锚点句应是 10~30 字、带姿态的完整短句（读得出主人的冲动/判断/做法），不是压缩关键词；' +
        '且不带触发条件/来源（"看完视频后"这类前缀去掉——锚点要跨语境共享，触发语境由绑定单独记录）。' +
        '修改后锚点域会自动重新嵌入、重新聚簇、重新起山名。改完把新锚点句复述给主人确认。',
      parameters: {
        type: 'object',
        properties: {
          anchor_id: { type: 'string', description: '目标锚点的 anchor_id（完整 id 或其前缀）' },
          new_keyword: { type: 'string', description: '修改后的完整锚点句' },
        },
        required: ['anchor_id', 'new_keyword'],
      },
    },
  },
  async execute(args) {
    const anchorId = typeof args.anchor_id === 'string' ? args.anchor_id.trim() : ''
    const newKeyword = typeof args.new_keyword === 'string' ? args.new_keyword.trim() : ''
    if (!anchorId || !newKeyword) return '缺少参数：anchor_id 或 new_keyword'

    // 容错：允许 id 前缀
    let id = anchorId
    if (anchorId.length < 36) {
      const anchors = await collectAllAnchors()
      const hits = anchors.filter(a => a.id.startsWith(anchorId))
      if (hits.length === 0) return `找不到 anchor_id 为 ${anchorId} 的锚点（先用 GetAnchors 查询）`
      if (hits.length > 1) return `anchor_id 前缀 ${anchorId} 匹配到多条锚点，请用完整 id`
      id = hits[0].id
    }
    await updateAnchorKeyword(id, newKeyword)
    window.dispatchEvent(new CustomEvent('solevup:context-updated'))
    return `已更新锚点句 ${id.slice(0, 8)}：${newKeyword}\n（锚点域将自动重新嵌入与聚簇）`
  },
}

// ── Read ──

const readFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'Read',
      description: '读取本地文件内容，返回文本。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件的绝对路径' },
        },
        required: ['file_path'],
      },
    },
  },
  async execute(args) {
    const path = args.file_path as string
    if (!path) return '缺少参数：file_path'
    return await invoke<string>('read_file', { path })
  },
}

// ── Write ──

const writeFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'Write',
      description: '将内容写入本地文件（完全覆盖）。写入前确认路径正确。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件的绝对路径' },
          content:   { type: 'string', description: '要写入的文件内容' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  async execute(args) {
    const path = args.file_path as string
    const content = args.content as string
    if (!path) return '缺少参数：file_path'
    await invoke('write_file', { path, content })
    return `已写入：${path}`
  },
}

// ── Edit ──

const editFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'Edit',
      description: '在文件中执行精确字符串替换。old_string 必须在文件中唯一存在，否则报错。',
      parameters: {
        type: 'object',
        properties: {
          file_path:  { type: 'string', description: '文件的绝对路径' },
          old_string: { type: 'string', description: '要替换的原始字符串（必须唯一存在）' },
          new_string: { type: 'string', description: '替换后的新字符串' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  async execute(args) {
    const path = args.file_path as string
    const oldStr = args.old_string as string
    const newStr = args.new_string as string
    if (!path || oldStr === undefined) return '缺少参数：file_path 或 old_string'

    const content = await invoke<string>('read_file', { path })
    const count = content.split(oldStr).length - 1
    if (count === 0) return `未找到要替换的字符串：${oldStr.slice(0, 80)}`
    if (count > 1) return `字符串不唯一（出现 ${count} 次），请提供更多上下文`

    const newContent = content.replace(oldStr, newStr)
    await invoke('write_file', { path, content: newContent })
    return `已替换：${path}`
  },
}

// ── ListBrokenThoughtCards（列出断链/损坏的想法卡）──

const listBrokenThoughtCards: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'ListBrokenThoughtCards',
      description:
        '列出所有「断链/损坏」的想法卡：这些卡指向了某个视频（有 source_card_id）、自己也有锚点句，但锚点句没有回填到那个视频（语境库视频侧没标记）。' +
        '返回每张的 card_id、时间、指向的视频标题、正文预览、锚点句。' +
        '主人说"修一下损坏的卡 / 把断链的都修了"时先用这个列出，再对每张用 GetVideoTranscript 读视频转录选句、用 RepairBrokenThoughtCard 回填。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  async execute() {
    const feed = await fetchContextFeed()
    const broken = feed.filter(c => c.kind === 'thought' && c.link_broken)
    if (broken.length === 0) return '没有损坏的想法卡——所有指向视频的想法卡，锚点都已正常标记到对应视频。'
    const lines = await Promise.all(broken.slice(0, 30).map(async c => {
      const bs = await fetchCardBindings(c.id).catch(() => [])
      const seen = new Set<string>()
      const anchors = bs.flatMap(b => b.anchors).filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true })
      const vid = feed.find(v => v.kind === 'bili_transcript' && v.id === c.source_card_id)
      const vidLabel = vid ? `《${vid.title ?? vid.id}》` : `${c.source_card_id}（视频可能已删 / 未转录）`
      const anchorText = anchors.length ? anchors.map(a => `[${a.category}] ${a.keyword}`).join('；') : '（无锚点句）'
      return `card_id: ${c.id}\n  ${c.created_at.slice(0, 16)} · 指向视频：${vidLabel}\n  正文：${c.text.slice(0, 50)}…\n  锚点句：${anchorText}`
    }))
    return `共 ${broken.length} 张损坏想法卡：\n\n${lines.join('\n\n')}`
  },
}

// ── GetVideoTranscript（读视频语境卡的转录句子，供修复时选句）──

const getVideoTranscript: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'GetVideoTranscript',
      description:
        '读取某个 B 站视频语境卡的转录句子（修复断链想法卡时用来挑选对应原文句）。' +
        'card_id 传视频语境卡 id（也就是想法卡的 source_card_id，BV 开头）。' +
        '强烈建议带 keyword（与锚点句相关的词）过滤——长视频句子很多。挑好后把整句原文传给 RepairBrokenThoughtCard 的 video_sentence。',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'string', description: '视频语境卡 id（BV 开头，= 想法卡的 source_card_id）' },
          keyword: { type: 'string', description: '按句子文本过滤的关键词（建议传，缩小范围）' },
        },
        required: ['card_id'],
      },
    },
  },
  async execute(args) {
    const cid = typeof args.card_id === 'string' ? args.card_id.trim() : ''
    if (!cid) return '请提供视频语境卡 card_id（想法卡的 source_card_id）'
    const feed = await fetchContextFeed()
    const v = feed.find(c => c.kind === 'bili_transcript' && c.id.startsWith(cid))
    if (!v || !v.ref_path) return `未找到该视频语境卡或它没有转录：${cid}`
    const sents = (await fetchBiliTranscriptSentences(v.ref_path)) ?? []
    if (sents.length === 0) return '该视频没有转录句子'
    const kw = typeof args.keyword === 'string' ? args.keyword.trim() : ''
    const hit = kw ? sents.filter(s => s.text.includes(kw)) : sents
    if (hit.length === 0) return `转录里没有包含「${kw}」的句子，换个词或不带 keyword 再试`
    const shown = hit.slice(0, 40)
    const more = hit.length > 40 ? `\n\n（共 ${hit.length} 句匹配，只显示前 40 句；用更具体的 keyword 缩小）` : ''
    return `视频《${v.title ?? v.id}》转录${kw ? `（含「${kw}」）` : ''}：\n${shown.map(s => `- ${s.text}`).join('\n')}${more}`
  },
}

// ── RepairBrokenThoughtCard（把断链想法卡的锚点句回填到视频选中句）──

const repairBrokenThoughtCard: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'RepairBrokenThoughtCard',
      description:
        '修复一张断链想法卡：把它现有的锚点句回填到它指向的视频里你挑的那一句上（视频侧建绑定 → 视频被标记、卡不再损坏）。' +
        '先用 GetVideoTranscript 读视频转录、挑出与锚点句语义对应的整句，把那句原文（可只给有辨识度的一段子串）传给 video_sentence。锚点句用想法卡现有的，不用你重写。',
      parameters: {
        type: 'object',
        properties: {
          thought_card_id: { type: 'string', description: '要修复的想法卡 card_id' },
          video_sentence: { type: 'string', description: '在目标视频转录里挑中的那一句（原文，或其中一段有辨识度的子串，用于定位）' },
        },
        required: ['thought_card_id', 'video_sentence'],
      },
    },
  },
  async execute(args) {
    const tid = typeof args.thought_card_id === 'string' ? args.thought_card_id.trim() : ''
    const needle = typeof args.video_sentence === 'string' ? args.video_sentence.trim() : ''
    if (!tid || !needle) return '需要 thought_card_id 和 video_sentence 两个参数'
    const feed = await fetchContextFeed()
    const thought = feed.find(c => c.kind === 'thought' && c.id.startsWith(tid))
    if (!thought) return `未找到想法卡：${tid}`
    if (!thought.source_card_id) return `想法卡 ${thought.id} 没有指向任何视频（source_card_id 为空），无法回填`
    const video = feed.find(c => c.kind === 'bili_transcript' && c.id === thought.source_card_id)
    if (!video || !video.ref_path) return `想法卡指向的视频未找到或没有转录：${thought.source_card_id}`
    const bs = await fetchCardBindings(thought.id).catch(() => [])
    const seen = new Set<string>()
    const anchors = bs.flatMap(b => b.anchors).filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true })
    if (anchors.length === 0) return `想法卡 ${thought.id} 自己没有锚点句，没有可回填的内容`
    const sents = (await fetchBiliTranscriptSentences(video.ref_path)) ?? []
    const target = sents.find(s => s.text.includes(needle)) ?? sents.find(s => needle.includes(s.text))
    if (!target) return `视频转录里没有匹配「${needle.slice(0, 20)}…」的句子，请用 GetVideoTranscript 确认原文后重试`
    const existing = await fetchCardBindings(video.id).catch(() => [])
    if (existing.some(b => b.start_pos === target.offset && b.end_pos === target.offset + target.text.length)) {
      return '该句已有锚点绑定，无需重复回填（换一句，或这张卡可能已修复）'
    }
    await addBinding({
      card_id: video.id,
      start_pos: target.offset,
      end_pos: target.offset + target.text.length,
      selected_text: target.text,
      user_speech: target.text,
      anchors: anchors.map(a => ({ keyword: a.keyword, category: a.category })),
      source_card_id: thought.id,
    })
    window.dispatchEvent(new CustomEvent('solevup:context-updated'))
    return `已修复：想法卡「${thought.text.slice(0, 16)}…」的 ${anchors.length} 条锚点句，已回填到视频《${video.title ?? video.id}》的「${target.text.slice(0, 20)}…」一句上。这张卡不再损坏。`
  },
}

// ── Registry ──

const ALL_TOOLS: readonly Tool[] = [
  getAppUsage,
  getActivityTags,
  getComputerStatus,
  getBiliHistory,
  getThoughtCards,
  createThoughtCard,
  updateThoughtCard,
  getAnchors,
  updateAnchor,
  listBrokenThoughtCards,
  getVideoTranscript,
  repairBrokenThoughtCard,
  readFile,
  writeFile,
  editFile,
]

/** 发给 AI 的工具定义列表（OpenAI function calling 格式） */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = ALL_TOOLS.map(t => t.definition)

/** 按名称执行工具，返回结果字符串 */
export async function executeAgentTool(name: string, argsJson: string): Promise<string> {
  const tool = ALL_TOOLS.find(t => t.definition.function.name === name)
  if (!tool) return `未知工具：${name}`

  try {
    const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    return await tool.execute(args)
  } catch (err) {
    return `工具执行失败：${err instanceof Error ? err.message : String(err)}`
  }
}
