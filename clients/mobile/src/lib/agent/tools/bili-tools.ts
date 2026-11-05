// ══════════════════════════════════════════════
// GetBiliHistory
// 数据来源 ② 桌面端：B 站历史由桌面端的内嵌 WebView 抓取入库，手机本地没有这张表。
// 连不上时 executeAgentTool 按 desktop 字段返回明确文字，不会变成「无匹配」。
// ══════════════════════════════════════════════

import { desktopRequest, DesktopApiError, resolveDesktopBase } from '../../desktop-api'
import { filterByKeyword, filterByTime, localDateKey, resolveDatesToFetch, TIME_RANGE_PARAMS } from './helpers'
import type { Tool } from './types'

// ── Bilibili 时间轴 Span ──

export interface BiliSpan {
  bvid: string
  oid: number
  title: string
  author_name: string
  cover: string       // 封面 URL
  start_at: string    // "2026-04-06 13:30:00"
  end_at: string
  duration: number    // 总时长（秒）
  progress: number    // 已看（秒）
  view_at: number     // unix 秒
  event_id: string | null
  downloaded: boolean // bili_video_assets 中存在 done 状态
  file_size_bytes: number | null // 已下载时 = 文件字节数；未下载 = null
  transcribed: boolean // bili_video_assets 中存在 visual 或 audio 转录
  favorite: boolean // bili_video_assets 中存在 is_favorite=1（转录后自动收藏）
}

export async function fetchBiliSpans(date: Date): Promise<BiliSpan[]> {
  const json = await desktopRequest<BiliSpan[]>('GET', `/api/bilibili/spans/day?date=${localDateKey(date)}`)
  if (!json.success || !json.data) throw new DesktopApiError(json.error || '获取B站Span失败')
  return json.data
}

/**
 * 查询指定日期列表的所有 BiliSpans，合并排序。
 * desktop 对单日失败是 .catch(() => [])，手机端不吞：吞掉就成了「无匹配的 B 站观看记录」。
 */
async function fetchBiliSpansRange(dates: Date[]): Promise<BiliSpan[]> {
  // 先确认一次地址：离线时直接失败，也避免每天的请求各探测一遍
  await resolveDesktopBase()
  const results = await Promise.all(dates.map(fetchBiliSpans))
  return results.flat().sort((a, b) => a.start_at.localeCompare(b.start_at))
}

// ── GetBiliHistory ──

export const getBiliHistory: Tool = {
  desktop: { read: 'B 站观看记录' },
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
