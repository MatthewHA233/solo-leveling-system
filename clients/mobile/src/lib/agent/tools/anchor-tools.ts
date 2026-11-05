// ══════════════════════════════════════════════
// GetAnchors / UpdateAnchor
// 数据来源 ② 桌面端：锚点和绑定只在桌面端（不在同步协议里），手机端不存副本。
// ══════════════════════════════════════════════

import { DeviceEventEmitter } from 'react-native'
import {
  fetchAllBindings,
  fetchContextFeed,
  updateAnchorKeyword,
  type AnchorCategory,
} from '../../desktop-api'
import { CONTEXT_UPDATED_EVENT } from '../../ai/anchor-outbox'
import { filterByKeyword } from './helpers'
import type { Tool } from './types'

interface AnchorSummary {
  id: string
  keyword: string
  category: AnchorCategory
  bindings: number
}

/**
 * 汇总全部锚点（含想法卡与语境卡的绑定计数）。
 * desktop 按语境流逐卡请求绑定；手机端隔着局域网，上千张卡就是上千个请求，
 * 改用 all-bindings 一次取回，再按语境流过滤，结果和逐卡请求相同。
 */
async function collectAllAnchors(): Promise<AnchorSummary[]> {
  const [feed, bindings] = await Promise.all([fetchContextFeed(), fetchAllBindings()])
  const feedIds = new Set(feed.map(c => c.id))
  const map = new Map<string, AnchorSummary>()
  for (const b of bindings) {
    if (!feedIds.has(b.card_id)) continue
    for (const a of b.anchors) {
      const cur = map.get(a.id)
      if (cur) cur.bindings += 1
      else map.set(a.id, { id: a.id, keyword: a.keyword, category: a.category, bindings: 1 })
    }
  }
  return [...map.values()].sort((x, y) => y.bindings - x.bindings)
}

export const getAnchors: Tool = {
  desktop: { read: '锚点句' },
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

export const updateAnchor: Tool = {
  desktop: { write: '修改锚点句' },
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
    DeviceEventEmitter.emit(CONTEXT_UPDATED_EVENT)
    return `已更新锚点句 ${id.slice(0, 8)}：${newKeyword}\n（锚点域将自动重新嵌入与聚簇）`
  },
}
