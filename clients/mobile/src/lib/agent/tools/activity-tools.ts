// ══════════════════════════════════════════════
// GetActivityTags
// 数据来源 ① 本地表：activity_* 走同步协议，手机本地就有，不需要桌面端在线。
// ══════════════════════════════════════════════

import {
  isSolevupDbAvailable,
  solevupListBlocksForDate,
  solevupListCategories,
  solevupListTags,
  type CategoryRow,
  type TagRow,
} from '../../solevupdb'
import { filterByKeyword, filterByTime, localDateKey, minuteToHHmm, resolveDatesToFetch, TIME_RANGE_PARAMS } from './helpers'
import type { Tool } from './types'

interface ActivityPalette {
  categories: CategoryRow[]
  tags: TagRow[]
}

// Activity blocks exposed as span-like records for the existing filters.
export interface ActivityTagSpan {
  start_at: string
  end_at: string
  title: string
  group_name: string | null
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

/**
 * desktop 对单日查询失败是 .catch(() => [])。手机端不吞：
 * 本地库读失败时吞掉会变成「无匹配的活动标签记录」，模型会告诉主人那天什么都没做。
 */
export async function fetchActivityTagSpansRange(dates: Date[]): Promise<ActivityTagSpan[]> {
  const [categories, tags] = await Promise.all([solevupListCategories(), solevupListTags()])
  const palette: ActivityPalette = { categories, tags }
  const blocksByDate = await Promise.all(dates.map(d => solevupListBlocksForDate(localDateKey(d))))
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

// ── GetActivityTags ──

export const getActivityTags: Tool = {
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
    // 没有原生模块（iOS 还没做）时桥接一律返回空，这里要说清楚，不能变成「无匹配」
    if (!isSolevupDbAvailable()) return '本机数据库不可用，查不到活动标签。这不代表没有记录，如实告诉主人。'

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
