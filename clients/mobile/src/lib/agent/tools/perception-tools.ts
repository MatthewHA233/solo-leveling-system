// ══════════════════════════════════════════════
// GetAppUsage / GetComputerStatus
// 数据来源 ③ 感知：手机感知层 + 桌面端 span，两边合并，结果里标明「手机」「电脑」。
//
// desktop 的「本机」就是那台电脑。手机上主人问「今天下午用了什么软件」可能指任何一台设备，
// 所以两边都查：
//   · 手机：应用段来自 getAppMonitorSegmentsInRange（kind='app'），
//           状态由亮灭屏事件换算：解锁 = active，亮屏未解锁 = idle，熄屏 = afk
//   · 电脑：/api/perception/spans 的 apps / status 轨道
// 只有两边都确认没有才返回「无匹配...」（工具描述承诺了它代表确实没有）；
// 某一边查不到时把原因写进结果，让模型如实说明。
// ══════════════════════════════════════════════

import { desktopRequest, DesktopApiError, isDesktopUnreachable, resolveDesktopBase } from '../../desktop-api'
import {
  getAppMonitorSegmentsInRange,
  getPowerEventsInRange,
  isAccessibilityEnabled,
  isPerceptionAvailable,
  type PowerEvent,
} from '../../perception'
import { filterByKeyword, filterByTime, localDateKey, resolveDatesToFetch, TIME_RANGE_PARAMS } from './helpers'
import { desktopPartMissingText, type Tool } from './types'

// ── Perception Timeline（desktop local-api 的 PerceptionSpan）──

export interface PerceptionSpan {
  id: number
  track: string         // "apps" | "tags"
  start_at: string      // "2026-04-04 13:00:00"
  end_at: string
  title: string
  group_name: string | null
  color: string | null  // "#F9BA00"
  platform?: 'mac' | 'win' | 'desktop' | string | null
  /** 手机端多的字段：一段里出现过的其他窗口标题和包名，只参与关键词匹配 */
  search_text?: string[]
}

/** 查询某天桌面端的感知 spans（apps + tags/status）。连不上抛 DesktopUnreachableError */
export async function fetchPerceptionSpans(date: Date): Promise<PerceptionSpan[]> {
  const json = await desktopRequest<PerceptionSpan[]>('GET', `/api/perception/spans?date=${localDateKey(date)}`)
  if (!json.success || !json.data) throw new DesktopApiError(json.error || '获取感知数据失败')
  return json.data
}

/** 查询指定日期列表的所有 感知 spans，合并排序 */
async function fetchDesktopSpansRange(dates: Date[]): Promise<PerceptionSpan[]> {
  // 先确认一次地址：离线时直接失败，也避免每天的请求各探测一遍
  await resolveDesktopBase()
  const results = await Promise.all(dates.map(fetchPerceptionSpans))
  return results.flat().sort((a, b) => a.start_at.localeCompare(b.start_at))
}

// ── 手机端 ──

function dayRangeMs(date: Date): { startMs: number; endMs: number } {
  const startMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const endMs = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
  return { startMs, endMs }
}

/** 本地时间，格式同 desktop span："2026-04-04 13:00:00" */
function formatLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${localDateKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 按天切开（同 desktop clip_dt），跨午夜的段在两天里各出现一次 */
async function fetchPhoneAppSpans(dates: Date[]): Promise<PerceptionSpan[]> {
  const now = Date.now()
  const perDay = await Promise.all(dates.map(async (date) => {
    const { startMs, endMs } = dayRangeMs(date)
    const segments = await getAppMonitorSegmentsInRange(startMs, endMs, 5000)
    return segments
      .filter((s) => s.kind === 'app')
      .map((s): PerceptionSpan => ({
        id: s.rowId,
        track: 'apps',
        start_at: formatLocal(Math.max(s.startMs, startMs)),
        // 正式表还没有数据时走原始事件回退，今天最后一段的结束是次日零点，不能报成将来的时间
        end_at: formatLocal(Math.min(s.endMs, endMs, now)),
        title: s.windowTitle || s.appLabel || s.packageName,
        group_name: s.appLabel || s.packageName,
        color: null,
        platform: 'android',
        search_text: [...s.titles, s.packageName],
      }))
  }))
  return perDay.flat().sort((a, b) => a.start_at.localeCompare(b.start_at))
}

const POWER_LOOKBACK_MS = 24 * 3600 * 1000
/** 亮屏到解锁通常只有几秒，这种 idle 没有信息量，一天几十次还会把结果撑得很长 */
const MIN_IDLE_MS = 60_000

type PhoneStatus = 'active' | 'idle' | 'afk'

const POWER_TO_STATUS: Record<string, PhoneStatus> = {
  unlocked: 'active',
  screen_on: 'idle',
  screen_off: 'afk',
}

/**
 * 亮灭屏事件 → 状态段。事件之间状态不变，所以一段的结束是下一个事件的时刻。
 * service_stopped：感知服务停了，之后的状态未知，段到此为止。
 * service_started：说明此前有监控断档（服务被杀时连 screen_off 都收不到），
 *   上一段实际持续到什么时候不知道，直接丢掉，不能算成一直持续到现在。
 */
export function powerEventsToStatusSpans(
  events: readonly PowerEvent[],
  rangeStartMs: number,
  rangeEndMs: number,
  nowMs: number,
): PerceptionSpan[] {
  const sorted = [...events].sort((a, b) => a.eventTimeMs - b.eventTimeMs || a.rowId - b.rowId)
  const spans: PerceptionSpan[] = []
  // 用 as 声明：闭包里改 open，TS 按声明时的 null 收窄会把循环里的判断算成 never
  let open = null as { status: PhoneStatus; startMs: number; rowId: number } | null

  const close = (endMs: number) => {
    if (!open) return
    const start = Math.max(open.startMs, rangeStartMs)
    const end = Math.min(endMs, rangeEndMs)
    if (end > start && !(open.status === 'idle' && end - start < MIN_IDLE_MS)) {
      spans.push({
        id: open.rowId,
        track: 'status',
        start_at: formatLocal(start),
        end_at: formatLocal(end),
        title: open.status,
        group_name: open.status,
        color: null,
        platform: 'android',
      })
    }
    open = null
  }

  for (const ev of sorted) {
    if (ev.event === 'service_started') {
      open = null
      continue
    }
    if (ev.event === 'service_stopped') {
      close(ev.eventTimeMs)
      continue
    }
    const status = POWER_TO_STATUS[ev.event]
    if (!status) continue
    if (open?.status === status) continue
    close(ev.eventTimeMs)
    open = { status, startMs: ev.eventTimeMs, rowId: ev.rowId }
  }
  // 最后一段还开着：今天算到现在，过去的日子算到当天结束
  close(Math.min(nowMs, rangeEndMs))
  return spans
}

async function fetchPhoneStatusSpans(dates: Date[]): Promise<PerceptionSpan[]> {
  const now = Date.now()
  const perDay = await Promise.all(dates.map(async (date) => {
    const { startMs, endMs } = dayRangeMs(date)
    // 多查前一天：当天第一个事件之前的状态由前一天最后一个事件决定（比如昨晚熄屏睡到今早）
    const events = await getPowerEventsInRange(startMs - POWER_LOOKBACK_MS, endMs, 2000)
    return powerEventsToStatusSpans(events, startMs, endMs, now)
  }))
  return perDay.flat().sort((a, b) => a.start_at.localeCompare(b.start_at))
}

// ── 合并两边 ──

interface MergedSpans {
  phone: PerceptionSpan[]
  desktop: PerceptionSpan[]
  /** 某一边查不到或可能不全的说明；有内容时不能说「确实没有」 */
  notes: string[]
}

async function fetchMerged(
  dates: Date[],
  what: string,
  fetchPhone: (dates: Date[]) => Promise<PerceptionSpan[]>,
  track: string,
): Promise<MergedSpans> {
  const notes: string[] = []

  const phoneTask = (async (): Promise<PerceptionSpan[]> => {
    if (!isPerceptionAvailable()) {
      notes.push(`这台设备没有感知模块，查不到手机上的${what}`)
      return []
    }
    try {
      const [spans, accessibility] = await Promise.all([fetchPhone(dates), isAccessibilityEnabled()])
      if (!accessibility) notes.push(`手机的无障碍权限没有开启，手机上的${what}可能不全`)
      return spans
    } catch (e) {
      notes.push(`读取手机上的${what}失败（${e instanceof Error ? e.message : String(e)}）`)
      return []
    }
  })()

  const desktopTask = (async (): Promise<PerceptionSpan[]> => {
    try {
      const all = await fetchDesktopSpansRange(dates)
      return all.filter((s) => s.track === track)
    } catch (e) {
      notes.push(desktopPartMissingText(what, e, isDesktopUnreachable(e)))
      return []
    }
  })()

  const [phone, desktop] = await Promise.all([phoneTask, desktopTask])
  return { phone, desktop, notes }
}

function renderMerged(
  phoneLines: string[],
  desktopLines: string[],
  notes: string[],
  emptyText: string,
): string {
  const noteText = notes.join('；')
  if (phoneLines.length === 0 && desktopLines.length === 0) {
    if (notes.length === 0) return emptyText
    // 不能用 emptyText：工具描述承诺了它代表确实没有
    return `能查到的部分没有匹配的记录，但${noteText}。这不代表确实没有，如实告诉主人，不要换词重试。`
  }
  const sections: string[] = []
  if (phoneLines.length > 0) sections.push(`手机：\n${phoneLines.join('\n')}`)
  if (desktopLines.length > 0) sections.push(`电脑：\n${desktopLines.join('\n')}`)
  const body = sections.join('\n\n')
  return notes.length === 0 ? body : `${body}\n\n（注意：${noteText}。上面不是全部记录，如实告诉主人。）`
}

// ── GetAppUsage ──

export const getAppUsage: Tool = {
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

    const { phone, desktop, notes } = await fetchMerged(dates, '应用使用记录', fetchPhoneAppSpans, 'apps')
    const select = (spans: PerceptionSpan[]) => filterByKeyword(
      filterByTime(spans, fromDT, toDT),
      args.keyword,
      s => [s.title, s.group_name ?? '', ...(s.search_text ?? [])],
    ).map(s => `${s.start_at.slice(0, 16)} - ${s.end_at.slice(11, 16)}  [${s.title}] ${s.group_name ?? ''}`)

    return renderMerged(select(phone), select(desktop), notes, '无匹配的应用使用记录')
  },
}

// ── GetComputerStatus ──

export const getComputerStatus: Tool = {
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

    const { phone, desktop, notes } = await fetchMerged(dates, '状态记录', fetchPhoneStatusSpans, 'status')
    const select = (spans: PerceptionSpan[]) => {
      let statuses = filterByTime(spans, fromDT, toDT)
      if (status) statuses = statuses.filter(s => (s.group_name ?? s.title).toLowerCase() === status)
      return statuses.map(s => `${s.start_at.slice(0, 16)} - ${s.end_at.slice(11, 16)}  ${s.title}`)
    }

    return renderMerged(select(phone), select(desktop), notes, '无匹配的电脑状态记录')
  },
}
