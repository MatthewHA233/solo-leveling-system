// ══════════════════════════════════════════════
// GetThoughtCards / CreateThoughtCard / UpdateThoughtCard /
// ListBrokenThoughtCards / GetVideoTranscript / RepairBrokenThoughtCard
// 数据来源 ② 桌面端：想法卡、语境流、绑定、转录都只在桌面端（不在同步协议里），手机端不存副本。
//
// 和 desktop 的不同都是因为隔着局域网，可能中途断开：
//   · desktop 查绑定失败时 .catch(() => [])，手机端连不上要往外抛（cardBindingsOrEmpty），
//     否则模型会把「连不上」说成「这张卡没有锚点」，或者跳过查重写出重复绑定
//   · CreateThoughtCard 两步之间断开时明确告诉模型卡已经建好，别再建一张
// ══════════════════════════════════════════════

import { DeviceEventEmitter } from 'react-native'
import {
  addBinding,
  addContextCard,
  fetchCardBindings,
  fetchContextFeed,
  isDesktopUnreachable,
  updateContextCard,
  type AnchorBinding,
  type AnchorCategory,
} from '../../desktop-api'
import { CONTEXT_UPDATED_EVENT } from '../../ai/anchor-outbox'
import { timestampMs } from '../agent-memory'
import { fetchBiliTranscriptSentences } from './bili-transcript'
import { filterByKeyword } from './helpers'
import type { Tool } from './types'

async function cardBindingsOrEmpty(cardId: string): Promise<AnchorBinding[]> {
  try {
    return await fetchCardBindings(cardId)
  } catch (e) {
    if (isDesktopUnreachable(e)) throw e
    return []
  }
}

// ── GetThoughtCards ──

export const getThoughtCards: Tool = {
  desktop: { read: '想法卡' },
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
        // created_at 是 to_rfc3339（9 位小数），Hermes 的 Date 不保证能解析；NaN 会让 days 过滤失效
        const t = timestampMs(v)
        return Number.isNaN(t) || t >= cutoff
      })
    }
    // card_id 直查（前缀容错）；模型有时仍会把 id 塞进 keyword，所以 keyword 匹配域也含 id 兜底
    const cardIdArg = typeof args.card_id === 'string' ? args.card_id.trim() : ''
    if (cardIdArg) cards = cards.filter(c => c.id.startsWith(cardIdArg))
    cards = filterByKeyword(cards, args.keyword, c => [c.text, c.source_label ?? '', c.id])
    if (cards.length === 0) return '没有匹配的想法卡'

    const lines = await Promise.all(cards.slice(0, 20).map(async c => {
      const bs = await cardBindingsOrEmpty(c.id)
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

export const createThoughtCard: Tool = {
  desktop: { write: '创建想法卡' },
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
    try {
      await addBinding({
        card_id: cardId,
        start_pos: 0,
        end_pos: text.length,
        selected_text: text,
        user_speech: text,
        anchors,
      })
    } catch (e) {
      // 卡已经建好了。这里按普通失败返回的话，模型会以为没记上再建一张
      DeviceEventEmitter.emit(CONTEXT_UPDATED_EVENT)
      const reason = e instanceof Error ? e.message : String(e)
      return `已创建想法卡 ${cardId.slice(0, 8)}，但挂锚点时失败（${reason}），锚点可能没有挂上。不要重复创建这张卡，如实告诉主人。正文：\n${text}`
    }
    DeviceEventEmitter.emit(CONTEXT_UPDATED_EVENT)
    const kw = anchors.map((a) => a.keyword).join('、')
    return `已创建想法卡 ${cardId.slice(0, 8)}${sourceLabel ? `（语境标签：${sourceLabel}）` : ''}${kw ? `（锚点：${kw}）` : ''}，正文：\n${text}`
  },
}

// ── UpdateThoughtCard ──

export const updateThoughtCard: Tool = {
  desktop: { write: '修改想法卡' },
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
    DeviceEventEmitter.emit(CONTEXT_UPDATED_EVENT)
    return `已更新想法卡 ${id.slice(0, 8)}${sourceLabel ? `（语境标签：${sourceLabel}）` : ''}，新正文：\n${newText}`
  },
}

// ── ListBrokenThoughtCards（列出断链/损坏的想法卡）──

export const listBrokenThoughtCards: Tool = {
  desktop: { read: '损坏的想法卡' },
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
      const bs = await cardBindingsOrEmpty(c.id)
      const seen = new Set<string>()
      const anchors = bs.flatMap(b => b.anchors).filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true })
      const vid = feed.find(v => v.kind === 'bili_transcript' && v.id === c.source_card_id)
      const vidLabel = vid ? `《${vid.title ?? vid.id}》` : `${c.source_card_id}（视频可能已删 / 未转录）`
      const anchorText = anchors.length ? anchors.map(a => `[${a.category}] ${a.keyword}`).join('；') : '（无锚点句）'
      return `card_id: ${c.id}\n  ${c.created_at.slice(0, 16)} · 指向视频：${vidLabel}\n  正文：${c.text.slice(0, 50)}…\n  锚点句：${anchorText}`
    }))
    return `共 ${broken.length} 张损坏想法卡。修每一张就照这三步（全程只用下面每张的 card_id，不用再找 BV 号 / 不用 GetThoughtCards / 不用查 B 站历史）：\n` +
      `① GetVideoTranscript(card_id=该卡 card_id, keyword=它锚点句里的一个关键词) → 读它来源视频的转录；\n` +
      `② 从转录里挑出和锚点句语义最贴的一整句；\n` +
      `③ RepairBrokenThoughtCard(thought_card_id=该卡 card_id, video_sentence=挑中的那句原文)。\n` +
      `重要：想法卡常是主人看完视频后的主观发挥，转录里不一定有字面对应句——挑语义"最接近"的一整句就行，不必完美。` +
      `同一张卡用 GetVideoTranscript 换关键词最多 2 次，再找不到就拿目前读到的最相关一句直接 RepairBrokenThoughtCard，绝不要为一张卡反复搜十几次。\n\n${lines.join('\n\n')}`
  },
}

// ── GetVideoTranscript（读视频语境卡的转录句子，供修复时选句）──

export const getVideoTranscript: Tool = {
  desktop: { read: '视频转录' },
  definition: {
    type: 'function',
    function: {
      name: 'GetVideoTranscript',
      description:
        '读取某张损坏想法卡「来源视频」的转录句子（修复时用来挑对应原文句）。' +
        'card_id 直接传那张损坏想法卡的 card_id 即可——工具会自动找到它指向的视频（也可传视频语境卡 BV id）。不用你自己去找 BV 号。' +
        '强烈建议带 keyword（锚点句里的一个关键词，不要传整句）过滤——长视频句子很多。挑好后把整句原文传给 RepairBrokenThoughtCard 的 video_sentence。',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'string', description: '损坏想法卡 card_id（推荐，自动找来源视频）；也可传视频语境卡 BV id' },
          keyword: { type: 'string', description: '锚点句里的一个关键词（单词，别传整句），缩小范围' },
        },
        required: ['card_id'],
      },
    },
  },
  async execute(args) {
    const cid = typeof args.card_id === 'string' ? args.card_id.trim() : ''
    if (!cid) return '请提供 card_id（损坏想法卡 id，或视频语境卡 BV id）'
    const feed = await fetchContextFeed()
    // 先按视频卡 id 找；找不到就按想法卡找 → 取它 source_card_id 指向的来源视频
    let v = feed.find(c => c.kind === 'bili_transcript' && c.id.startsWith(cid))
    if (!v) {
      const th = feed.find(c => c.kind === 'thought' && c.id.startsWith(cid))
      if (th?.source_card_id) v = feed.find(c => c.kind === 'bili_transcript' && c.id === th.source_card_id)
    }
    if (!v || !v.ref_path) return `未找到对应视频或它没有转录：${cid}`
    const sents = (await fetchBiliTranscriptSentences(v.ref_path)) ?? []
    if (sents.length === 0) return '该视频没有转录句子'
    const kw = typeof args.keyword === 'string' ? args.keyword.trim() : ''
    const hit = kw ? sents.filter(s => s.text.includes(kw)) : sents
    if (hit.length === 0) return `转录里没有包含「${kw}」的句子，换个词或不带 keyword 再试`
    const shown = hit.slice(0, 40)
    const more = hit.length > 40 ? `\n\n（共 ${hit.length} 句匹配，只显示前 40 句；用更具体的 keyword 缩小）` : ''
    return `视频《${v.title ?? v.id}》转录${kw ? `（含「${kw}」）` : ''}：\n${shown.map(s => `- ${s.text}`).join('\n')}${more}` +
      `\n\n（挑和锚点句语义最接近的一整句即可，不必字面完全匹配；找不到完美的就选目前最相关一句去 RepairBrokenThoughtCard，别再反复换词搜这一张）`
  },
}

// ── RepairBrokenThoughtCard（把断链想法卡的锚点句回填到视频选中句）──

export const repairBrokenThoughtCard: Tool = {
  desktop: { write: '修复想法卡' },
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
    const bs = await cardBindingsOrEmpty(thought.id)
    const seen = new Set<string>()
    const anchors = bs.flatMap(b => b.anchors).filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true })
    if (anchors.length === 0) return `想法卡 ${thought.id} 自己没有锚点句，没有可回填的内容`
    const sents = (await fetchBiliTranscriptSentences(video.ref_path)) ?? []
    const target = sents.find(s => s.text.includes(needle)) ?? sents.find(s => needle.includes(s.text))
    if (!target) return `视频转录里没有匹配「${needle.slice(0, 20)}…」的句子，请用 GetVideoTranscript 确认原文后重试`
    const existing = await cardBindingsOrEmpty(video.id)
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
    DeviceEventEmitter.emit(CONTEXT_UPDATED_EVENT)
    return `已修复：想法卡「${thought.text.slice(0, 16)}…」的 ${anchors.length} 条锚点句，已回填到视频《${video.title ?? video.id}》的「${target.text.slice(0, 20)}…」一句上。这张卡不再损坏。`
  },
}
