// ══════════════════════════════════════════════
// 微信 (com.tencent.mm) 洪流域 parser —— 还原卡片 / 还原动作
//
// 数据来自 a11y 全树 dump（collectTexts 的 text + contentDescription）。
// 真实采集观测（2026-06-13 录屏逐帧对照）得出的界面结构：
//
//  ① 公众号文章  window=…TmplWebViewMMUI
//       标题 / 「公众号·X」「收录于X」/ 阅读N / 赞N 分享N 在看N /
//       「上海」「2026年6月13日 10:41」/ 正文段落（多条长 TextView）
//  ② 订阅号消息流 window=…BizFlutterTLFlutterViewActivity（Flutter）
//       字间插零宽空格；纵向 feed =「公众号名\n相对时间」头 + 跟随文章标题；
//       「常看」「关注的贴图」「关注的视频」为分区头
//  ③ 聊天（文件传输助手等）  window=ScrollView/LauncherUI
//       输入栏 token（切换到按住说话/听写/更多功能按钮，已折叠）= 聊天强信号；
//       「聊天信息」按钮；「X头像」给发送者名；链接卡=标题+描述+来源公众号；
//       「图片」占位；「周四 17:37」「10:44」时间分隔
//  ④ 会话列表  window=LauncherUI
//       底部 tab（通讯录/发现/我）+「折叠置顶聊天」；
//       会话行 = View(名称) + TextView(时间) + View(预览)
//
// 设计原则：window_class 跨版本不稳，分类以内容信号为主、window 为辅。
// 第一版只还原高确定性信号，不强求端到端消息内容。
// ══════════════════════════════════════════════

import type { TorrentCapture, TorrentFormalAction, TorrentFormalCard } from '../../../lib/perception'
import type {
  TorrentFormalActionDraft,
  TorrentFormalCardDraft,
  TorrentParserModule,
} from '../types'
import { sourceRefsInRange } from '../types'

export const WECHAT_PACKAGE = 'com.tencent.mm'
const PARSER_ID = 'wechat'
const PARSER_VERSION = 1
const WECHAT_ACCENT = '#07C160' // 微信绿

// ── ListItem 变体（微信自有，不复用 B 站） ──

export type WxFeedEntry = { account: string; title: string; timeLabel?: string }
export type WxChatShare = { title: string; source?: string; desc?: string }
export type WxSession = { name: string; preview?: string; timeLabel?: string }
export type WxBlock =
  | { t: 'para'; text: string }
  | { t: 'heading'; text: string }
  | { t: 'image'; caption?: string }
  | { t: 'code'; text: string }
export type WxComment = { author: string; meta?: string; text: string; isAuthor?: boolean; isOA?: boolean }

export type WxActionKind = 'session_list' | 'chatting' | 'oa_article' | 'oa_feed'

export type WeChatListItem =
  | {
      kind: 'wx_article'
      key: string
      ts: number
      endTs: number
      title: string
      account?: string
      readCount?: string
      likeCount?: string
      shareCount?: string
      wowCount?: string
      publishLabel?: string
      location?: string
      album?: string
      bodyPreview?: string
      commentCount?: string
      body: WxBlock[]
      comments: WxComment[]
    }
  | {
      kind: 'wx_oa_feed'
      key: string
      tsStart: number
      tsEnd: number
      entries: WxFeedEntry[]
      sweepCount: number
    }
  | {
      kind: 'wx_chat'
      key: string
      tsStart: number
      tsEnd: number
      partner?: string
      shares: WxChatShare[]
      textCount: number
      imageCount: number
    }
  | {
      kind: 'wx_session_list'
      key: string
      ts: number
      endTs: number
      sessions: WxSession[]
    }
  | {
      kind: 'wx_action'
      key: string
      startTs: number
      endTs: number
      act: WxActionKind
      targetName?: string
      meta?: string
    }

// ── 文本清洗 ──

/** Flutter 在字间插零宽空格；统一清掉 + trim。 */
function clean(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/[​‌‍﻿]/g, '').trim()
}

// ── 噪声 / 信号词表（基于真实采集） ──

const NOISE = new Set([
  '浮窗', '退出浮窗', '删除', '链接', '聊天信息', 'progressBar', '更多信息',
  '原创', '搜一搜', '复制', '写留言', '留言', '收藏', '分享给朋友', '更多',
  '切换到按住说话', '切换到键盘', '听写', '表情', '更多功能按钮，已折叠', '更多功能按钮，已展开', '发送',
  '搜索小程序', '搜索小程序 搜索栏', '最近', '最近使用的小程序', '我的小程序', '常用的小程序',
  '微信', '通讯录', '发现', '我', '折叠置顶聊天',
  '返回', '公众号', '搜索', '菜单', '直播中', '常看', '关注的贴图', '关注的视频', '全文', '广告',
])

const CHAT_INPUT_TOKENS = ['切换到按住说话', '切换到键盘', '更多功能按钮，已折叠', '更多功能按钮，已展开', '听写']
const RELATIVE_TIME = /(\d+\s*(分钟|小时|天|个月)前|刚刚|昨天|前天|今天|周[一二三四五六日天])/
const TIME_SEP = /^(周[一二三四五六日天]\s*)?\d{1,2}:\d{2}$|^(昨天|前天|今天|星期[一二三四五六日天])/
const READ_RE = /^阅读\s*([\d.]+[万亿]?\+?)\s*$/
const LIKE_RE = /^赞\s*(\d+)/
const SHARE_RE = /^分享\s*(\d+)/
const WOW_RE = /^在看\s*(\d+)/
const OA_PREFIX_RE = /^公众号[·•]\s*(.+)$/
const ALBUM_RE = /^收录于\s*(.+)$/
const DATE_RE = /\d{4}年\d{1,2}月\d{1,2}日(\s*\d{1,2}:\d{2})?/
const AVATAR_RE = /^(.+?)头像$/
const REMAIN_RE = /^余下\s*\d+\s*篇$/
const NEW_NOTICE_RE = /^\d+\s*条新通知$/

function isNoise(t: string): boolean {
  if (!t) return true
  if (NOISE.has(t)) return true
  if (REMAIN_RE.test(t) || NEW_NOTICE_RE.test(t)) return true
  if (/^[\s,，·•]+$/.test(t)) return true
  return false
}

const COMMENT_SPLIT = /\s，\s/ // 评论用全角「 ， 」分隔；阅读聚合行用半角「 , 」，不会误判
const ARTICLE_CHROME = new Set([
  '分享', '在看', '留言', '写留言', '复制', '搜一搜', '从当前听', '从当前', '赞', '阅读',
  '更多信息', 'progressBar', '回复', '展开', '收起', 'AI · 目录', '已无更多数据', '听过',
])
const LIKE_N_RE = /^赞\s*\d+$/
const SHARE_N_RE = /^分享\s*\d+$/
const WOW_N_RE = /^在看\s*\d+$/
const COMMENT_N_RE = /^留言\s*(\d+)$/
const REPLY_N_RE = /^\d+\s*条回复$/
const PEOPLE_RE = /^\d+\s*人(\s*听过)?$/
const PREV_NEXT_RE = /^(上一篇|下一篇)\s*[·•]/

function hasChinese(t: string): boolean { return /[一-龥]/.test(t) }

/** 文章页 chrome / 头部 meta / 计数 / 导航 —— 不进正文。 */
function isArticleChrome(t: string): boolean {
  if (ARTICLE_CHROME.has(t)) return true
  if (LIKE_N_RE.test(t) || SHARE_N_RE.test(t) || WOW_N_RE.test(t) || COMMENT_N_RE.test(t)) return true
  if (REPLY_N_RE.test(t) || PEOPLE_RE.test(t) || PREV_NEXT_RE.test(t)) return true
  if (READ_RE.test(t) || /^阅读\s*[\d.]/.test(t)) return true
  return false
}

/** 评论行：「昵称 ， 地区 时间 ， 正文 ， ，」全角分隔，≥3 段且首段像昵称。 */
function parseComment(t: string): WxComment | null {
  if (!COMMENT_SPLIT.test(t)) return null
  const parts = t.split(COMMENT_SPLIT).map((p) => p.trim())
  if (parts.length < 3) return null
  const author = parts[0]
  if (!author || author.length > 18) return null
  const meta = parts[1]
  const text = parts.slice(2).filter((p) => p.length > 0).join(' ').replace(/[，、\s]+$/u, '').trim()
  if (!text) return null
  return {
    author,
    meta: meta || undefined,
    text,
    isAuthor: /作者/.test(meta),
    isOA: /公众号/.test(meta),
  }
}

/** 小标题：含「：」且短且中文（计算：…/进化：…），或夹在段落间的短中文标题。 */
function isHeadingText(t: string): boolean {
  if (/[：:]$/.test(t)) return false // 以冒号结尾 = 引导句（"另外还有两个自动化过程："），非标题
  if (t.length <= 20 && /[：:]/.test(t) && hasChinese(t)) return true // 冒号在中间（"计算：每次决策都更准"）
  if (t.length <= 14 && hasChinese(t) && !/[。！？，、；]$/.test(t) && !COMMENT_SPLIT.test(t)) return true
  return false
}

function isJunkImageAlt(alt: string): boolean {
  return !alt || /wx_fmt|svg|^\d+\?|%|^https?:|^图片$|^插图$|^\d+$/.test(alt)
}

function isMeta(t: string): boolean {
  return (
    READ_RE.test(t) || LIKE_RE.test(t) || SHARE_RE.test(t) || WOW_RE.test(t) ||
    OA_PREFIX_RE.test(t) || ALBUM_RE.test(t) || DATE_RE.test(t) || TIME_SEP.test(t) ||
    AVATAR_RE.test(t) || RELATIVE_TIME.test(t)
  )
}

// ── screen run 分段 ──

type Cap = { rowId: number; ts: number; wc: string; text: string; sc: string }

type ScreenType = 'article' | 'oa_feed' | 'chat' | 'session_list' | 'unknown'

type Run = { type: ScreenType; startTs: number; endTs: number; caps: Cap[] }

function toCaps(items: TorrentCapture[]): Cap[] {
  return items
    .map((it) => ({
      rowId: it.rowId,
      ts: it.eventTimeMs,
      wc: it.windowClass || '',
      text: clean(it.text),
      sc: it.sourceClass || '',
    }))
    .filter((c) => c.text.length > 0)
    .sort((a, b) => a.rowId - b.rowId)
}

/** 某段 caps 的去重文本集合（判断信号用）。 */
function textSet(caps: Cap[]): Set<string> {
  const s = new Set<string>()
  for (const c of caps) s.add(c.text)
  return s
}

function classify(wc: string, texts: Set<string>): ScreenType {
  if (/BizFlutterTL/.test(wc) || texts.has('关注的贴图') || texts.has('常看')) return 'oa_feed'
  for (const t of CHAT_INPUT_TOKENS) if (texts.has(t)) return 'chat'
  if (/TmplWebView/.test(wc)) return 'article'
  for (const t of texts) if (READ_RE.test(t) || OA_PREFIX_RE.test(t)) return 'article'
  // 会话列表：底 tab 同时出现 + 折叠置顶聊天
  if ((texts.has('通讯录') && texts.has('发现') && texts.has('我')) || texts.has('折叠置顶聊天')) return 'session_list'
  return 'unknown'
}

/** 按单帧快照(event_time_ms)分类 → 合并连续同类型为 run。
 *  关键：微信文章与聊天共用 window_class=ScrollView，只能靠每帧内容信号区分。 */
function segment(caps: Cap[]): Run[] {
  if (caps.length === 0) return []
  // 1) 按 event_time_ms 分帧（一帧 = 一次 a11y 全树 dump，内容自洽）
  const byTs = new Map<number, Cap[]>()
  for (const c of caps) {
    if (!byTs.has(c.ts)) byTs.set(c.ts, [])
    byTs.get(c.ts)!.push(c)
  }
  const snaps = [...byTs.entries()]
    .map(([ts, cs]) => ({ ts, cs, type: classify(cs[0].wc, textSet(cs)) }))
    .sort((a, b) => a.ts - b.ts)
  // 2) 合并连续同类型；孤立 unknown 帧吸收进前一个已知 run（过渡帧），丢弃开头的 unknown
  //    时间间隙 > GAP_SPLIT_MS（息屏/切走再回来）即使同类型也断成新 run，
  //    避免"11:16 看一眼 + 11:36 又看"被并成一张跨 20 分钟的卡
  const GAP_SPLIT_MS = 60_000
  const runs: Run[] = []
  for (const s of snaps) {
    const last = runs[runs.length - 1]
    const contiguous = last && s.ts - last.endTs <= GAP_SPLIT_MS
    if (last && contiguous && (last.type === s.type || s.type === 'unknown')) {
      last.caps.push(...s.cs)
      last.endTs = s.ts
    } else if (s.type === 'unknown') {
      continue
    } else {
      runs.push({ type: s.type, startTs: s.ts, endTs: s.ts, caps: [...s.cs] })
    }
  }
  return runs
}

// ── 各类型还原 ──

function recoverArticle(run: Run): WeChatListItem | null {
  const caps = run.caps
  let account: string | undefined
  let album: string | undefined
  let readCount: string | undefined
  let likeCount: string | undefined
  let shareCount: string | undefined
  let wowCount: string | undefined
  let publishLabel: string | undefined
  let location: string | undefined
  let bodyPreview: string | undefined

  // 计数/正文/收录：跨整段扫（不同滚动位置才出现）
  const seen = new Set<string>()
  for (const c of caps) {
    const t = c.text
    if (seen.has(t)) continue
    seen.add(t)
    let m
    if ((m = OA_PREFIX_RE.exec(t))) { account = account ?? clean(m[1]) }
    if ((m = ALBUM_RE.exec(t))) { album = album ?? clean(m[1]) }
    if ((m = READ_RE.exec(t))) { readCount = readCount ?? m[1] }
    if ((m = LIKE_RE.exec(t))) { likeCount = likeCount ?? m[1] }
    if ((m = SHARE_RE.exec(t))) { shareCount = shareCount ?? m[1] }
    if ((m = WOW_RE.exec(t))) { wowCount = wowCount ?? m[1] }
    if (/阅读\s*[\d.]+.*\d{4}年/.test(t)) { // 聚合行「阅读 N , 城市 , 日期」
      for (const p of t.split(/\s*[,，]\s*/)) {
        if (READ_RE.test(p)) readCount = readCount ?? READ_RE.exec(p)![1]
        else if (DATE_RE.test(p)) publishLabel = publishLabel ?? p.trim()
        else if (p.trim() && !location) location = p.trim()
      }
    } else if (DATE_RE.test(t) && !publishLabel) {
      publishLabel = t
    }
    if (!bodyPreview && t.length > 40 && !isMeta(t) && !isNoise(t)) bodyPreview = t.slice(0, 80)
  }

  // 标题 + 公众号：从「文章头可见」的快照里按 document 序取。
  // 头快照特征 = 含发布日期(DATE_RE)；标题 = 首条实文本，公众号 = 日期前紧邻一条。
  const byTs = new Map<number, Cap[]>()
  for (const c of caps) {
    if (!byTs.has(c.ts)) byTs.set(c.ts, [])
    byTs.get(c.ts)!.push(c)
  }
  let title: string | undefined
  const headSnaps = [...byTs.entries()]
    .filter(([, cs]) => cs.some((c) => DATE_RE.test(c.text)))
    .sort((a, b) => a[0] - b[0])
  const headCs = (headSnaps[0]?.[1] ?? caps).slice().sort((a, b) => a.rowId - b.rowId)
  for (let i = 0; i < headCs.length; i++) {
    const t = headCs[i].text
    if (isNoise(t) || isMeta(t)) continue
    if (t.length >= 5 && t.length <= 80 && !title) { title = t; break }
  }
  // 公众号：优先「公众号·X」；否则日期前紧邻的短 View 文本
  const dateIdx = headCs.findIndex((c) => DATE_RE.test(c.text))
  if (!account && dateIdx >= 0) {
    for (let j = dateIdx - 1; j >= 0 && j >= dateIdx - 3; j--) {
      const p = headCs[j]
      if (!isNoise(p.text) && !isMeta(p.text) && p.text !== title && p.text.length <= 20 && /View$/.test(p.sc)) {
        account = p.text
        break
      }
    }
  }
  // 地点：日期后紧邻的短 View（"河南"），不进正文
  if (!location && dateIdx >= 0) {
    for (let j = dateIdx + 1; j <= dateIdx + 2 && j < headCs.length; j++) {
      const p = headCs[j]
      if (/View$/.test(p.sc) && /^[一-龥]{2,6}$/.test(p.text) && !PEOPLE_RE.test(p.text)) { location = p.text; break }
    }
  }
  if (!title) return null

  // ── 正文块 + 评论：按 min-rowid(≈文档序) 走唯一元素 ──
  const firstRow = new Map<string, { sc: string; row: number }>()
  for (const c of caps) {
    const ex = firstRow.get(c.text)
    if (!ex || c.rowId < ex.row) firstRow.set(c.text, { sc: c.sc, row: c.rowId })
  }
  const ordered = [...firstRow.entries()]
    .map(([text, v]) => ({ text, sc: v.sc, row: v.row }))
    .sort((a, b) => a.row - b.row)

  const headerExclude = new Set([title, account, album, publishLabel, location, '原创'].filter(Boolean) as string[])
  const origIdx = ordered.findIndex((o) => o.text === '原创')
  if (origIdx >= 0 && ordered[origIdx + 1]) headerExclude.add(ordered[origIdx + 1].text) // 作者名

  const body: WxBlock[] = []
  const comments: WxComment[] = []
  let commentCount: string | undefined
  for (const o of ordered) {
    const t = o.text
    const cm = COMMENT_N_RE.exec(t)
    if (cm) { commentCount = commentCount ?? cm[1]; continue }
    if (headerExclude.has(t) || DATE_RE.test(t)) continue
    if (isArticleChrome(t) || isNoise(t)) continue
    if (/^\d[\d.万亿]*$/.test(t)) continue // 纯数字（阅读数残留等）
    const comment = parseComment(t)
    if (comment) { comments.push(comment); continue }
    if (/Image/.test(o.sc)) {
      body.push({ t: 'image', caption: isJunkImageAlt(t) ? undefined : t })
      continue
    }
    if (t.includes('\n') && /(curl|https?:|npm |yarn |bash|^#)/.test(t)) { body.push({ t: 'code', text: t }); continue }
    if (isHeadingText(t)) { body.push({ t: 'heading', text: t }); continue }
    // 尾部重排碎片：已是某段子串的短碎片跳过
    if (t.length < 30 && body.some((b) => b.t === 'para' && b.text.includes(t))) continue
    // 短内联碎片(英文产品名等)并入上一段；长文本独立成段
    const last = body[body.length - 1]
    if (t.length < 12 && last && last.t === 'para') last.text += t
    else body.push({ t: 'para', text: t })
  }

  return {
    kind: 'wx_article',
    key: `wx-art-${title.slice(0, 16)}-${run.startTs}`,
    ts: run.startTs,
    endTs: run.endTs,
    title, account, readCount, likeCount, shareCount, wowCount,
    publishLabel, location, album, bodyPreview, commentCount, body, comments,
  }
}

function recoverOaFeed(run: Run): WeChatListItem | null {
  const caps = run.caps
  // 去重并保留首见顺序
  const seq: Array<{ text: string; sc: string }> = []
  const seen = new Set<string>()
  for (const c of caps) {
    if (seen.has(c.text)) continue
    seen.add(c.text)
    seq.push({ text: c.text, sc: c.sc })
  }
  const entries: WxFeedEntry[] = []
  const pushEntry = (account: string, title: string, timeLabel?: string) => {
    account = clean(account); title = clean(title)
    if (!account || !title) return
    if (entries.some((e) => e.account === account && e.title === title)) return
    entries.push({ account, title, timeLabel })
  }
  // 纵向 feed：节点形如「公众号名\n相对时间」，其后第一条非分区/非噪声长文本 = 标题
  let pendingAccount: string | null = null
  let pendingTime: string | undefined
  for (let i = 0; i < seq.length; i++) {
    const t = seq[i].text
    if (isNoise(t)) continue
    const lines = t.split('\n').map((x) => x.trim()).filter(Boolean)
    if (lines.length === 2 && RELATIVE_TIME.test(lines[1]) && lines[0].length <= 20) {
      // 账号+时间头
      pendingAccount = lines[0]
      pendingTime = lines[1]
      continue
    }
    if (lines.length === 1 && RELATIVE_TIME.test(t) && t.length <= 8) {
      pendingTime = t
      continue
    }
    // 标题候选
    if (pendingAccount && t.length >= 4 && !RELATIVE_TIME.test(t)) {
      pushEntry(pendingAccount, t.split('\n')[0], pendingTime)
      pendingAccount = null
      pendingTime = undefined
      continue
    }
  }
  if (entries.length === 0) return null
  // sweepCount：粗略 = 快照数
  const snaps = new Set(caps.map((c) => c.ts))
  return {
    kind: 'wx_oa_feed',
    key: `wx-oafeed-${run.startTs}`,
    tsStart: run.startTs,
    tsEnd: run.endTs,
    entries,
    sweepCount: snaps.size,
  }
}

function recoverChat(run: Run, priorSessions: WxSession[] = []): WeChatListItem | null {
  const caps = run.caps
  const seq: string[] = []
  const seen = new Set<string>()
  for (const c of caps) {
    if (seen.has(c.text)) continue
    seen.add(c.text)
    seq.push(c.text)
  }
  // partner 跨段推断：聊天标题栏 a11y 采不到，用"刚才会话列表里某会话的预览 ⊆ 聊天内容"锁定被点开的会话
  let partner: string | undefined
  const hay = seq.join('  ')
  for (const s of priorSessions) {
    const core = (s.preview || '').replace(/^\[[^\]]*\]\s*/, '').trim()
    if (core.length >= 2 && hay.includes(core)) { partner = s.name; break }
  }
  // 分享链接卡：长标题(TextView) 后跟短来源(公众号名)。
  const shares: WxChatShare[] = []
  let textCount = 0
  let imageCount = 0
  for (let i = 0; i < seq.length; i++) {
    const t = seq[i]
    if (t === '图片') { imageCount++; continue }
    if (isNoise(t) || isMeta(t)) continue
    // 浮窗保留的链接：标题后紧跟「链接」标签 —— 是悬浮窗内容不是聊天消息，跳过
    if (seq[i + 1] === '链接') { i += 1; continue }
    if (/https?:\/\//.test(t)) { textCount++; continue }
    // 链接卡标题：较长(>10)，下一条短(<=14 且非 meta) = 来源公众号
    if (t.length > 10) {
      const next = seq[i + 1]
      const nnext = seq[i + 2]
      let desc: string | undefined
      let source: string | undefined
      if (next && next.length > 10 && !isMeta(next) && next !== '链接') {
        desc = next
        if (nnext && nnext.length <= 14 && !isMeta(nnext)) { source = nnext; i += 2 } else { i += 1 }
      } else if (next && next.length <= 14 && !isMeta(next) && next !== '链接') {
        source = next; i += 1
      }
      if (source && !isNoise(source)) shares.push({ title: t, source, desc: desc?.slice(0, 60) })
      else textCount++
      continue
    }
    textCount++
  }
  // partner：标题栏未必采到；尝试从「X头像」反推（自聊场景拿不到对方）。留空由 UI 兜底。
  return {
    kind: 'wx_chat',
    key: `wx-chat-${run.startTs}`,
    tsStart: run.startTs,
    tsEnd: run.endTs,
    partner,
    shares,
    textCount,
    imageCount,
  }
}

function recoverSessionList(run: Run): WeChatListItem | null {
  const caps = run.caps
  // 会话行：View(名称) → TextView(时间) → View(预览)。
  // 用 sourceClass + 顺序重建：遇到 TextView 是时间(短)，前一个 View 是名称，后一个 View 是预览。
  const seq = caps.filter((c, i) => i === 0 || caps[i - 1].text !== c.text) // 压相邻重复
  const sessions: WxSession[] = []
  const seenNames = new Set<string>()
  for (let i = 0; i < seq.length; i++) {
    const c = seq[i]
    // 时间锚点：TextView 且形如 10:45 / 昨天 / 周四 / 6月5日
    if (/TextView$/.test(c.sc) && (TIME_SEP.test(c.text) || /^\d{1,2}月\d{1,2}日$/.test(c.text) || RELATIVE_TIME.test(c.text)) && c.text.length <= 6) {
      // 名称 = 往前找最近的 View 文本（非噪声、非小程序）
      let name: string | undefined
      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        const p = seq[j]
        if (/View$/.test(p.sc) && !isNoise(p.text) && p.text.length <= 24) { name = p.text; break }
      }
      let preview: string | undefined
      const n = seq[i + 1]
      // n 是预览 还是下一会话的名称？名称必紧跟时间(seq[i+2] 为时间)；若如此则当前会话无预览
      const afterN = seq[i + 2]
      const nIsNextName = afterN && /TextView$/.test(afterN.sc) &&
        (TIME_SEP.test(afterN.text) || /^\d{1,2}月\d{1,2}日$/.test(afterN.text) || RELATIVE_TIME.test(afterN.text)) && afterN.text.length <= 6
      if (n && /View$/.test(n.sc) && !isNoise(n.text) && !nIsNextName) preview = n.text
      if (name && !seenNames.has(name) && !isNoise(name)) {
        seenNames.add(name)
        sessions.push({ name, preview: preview?.slice(0, 30), timeLabel: c.text })
      }
    }
  }
  if (sessions.length === 0) return null
  return {
    kind: 'wx_session_list',
    key: `wx-sess-${run.startTs}`,
    ts: run.startTs,
    endTs: run.endTs,
    sessions,
  }
}

// ── 卡片 / 动作 构建 ──

/** 走一遍 runs，逐段还原成 card；chat 段带入"最近一次会话列表"上下文推断 partner。 */
function walkRuns(items: TorrentCapture[]): Array<{ run: Run; card: WeChatListItem | null }> {
  const runs = segment(toCaps(items))
  let lastSessions: WxSession[] = []
  const out: Array<{ run: Run; card: WeChatListItem | null }> = []
  for (const run of runs) {
    let card: WeChatListItem | null = null
    if (run.type === 'article') card = recoverArticle(run)
    else if (run.type === 'oa_feed') card = recoverOaFeed(run)
    else if (run.type === 'chat') card = recoverChat(run, lastSessions)
    else if (run.type === 'session_list') {
      card = recoverSessionList(run)
      if (card && card.kind === 'wx_session_list') lastSessions = card.sessions
    }
    out.push({ run, card })
  }
  return out
}

function buildCards(items: TorrentCapture[]): WeChatListItem[] {
  // 会话列表属隐私：仅内部用于聊天 partner 推断（walkRuns 内消费），不产出卡片、不持久化
  const out = walkRuns(items)
    .map((x) => x.card)
    .filter((c): c is WeChatListItem => c != null && c.kind !== 'wx_session_list')
  // 文章合并：仅"相邻同标题"(时间间隔 < 120s)才并；隔很久的同篇 = 两次独立浏览，各成一张
  const merged: WeChatListItem[] = []
  for (const c of out) {
    if (c.kind === 'wx_article') {
      const ex = [...merged].reverse().find(
        (m) => m.kind === 'wx_article' && m.title === c.title && c.ts - m.endTs < 120_000,
      ) as Extract<WeChatListItem, { kind: 'wx_article' }> | undefined
      if (ex) {
        ex.endTs = Math.max(ex.endTs, c.endTs)
        ex.readCount = ex.readCount ?? c.readCount
        ex.likeCount = ex.likeCount ?? c.likeCount
        ex.shareCount = ex.shareCount ?? c.shareCount
        ex.wowCount = ex.wowCount ?? c.wowCount
        ex.account = ex.account ?? c.account
        ex.publishLabel = ex.publishLabel ?? c.publishLabel
        ex.location = ex.location ?? c.location
        ex.album = ex.album ?? c.album
        ex.bodyPreview = ex.bodyPreview ?? c.bodyPreview
        continue
      }
    }
    merged.push(c)
  }
  merged.forEach((it, i) => {
    ;(it as any)._groupTs = ('ts' in it ? (it as any).ts : (it as any).tsStart)
    ;(it as any)._groupIdx = i
  })
  return merged
}

function buildActions(items: TorrentCapture[]): WeChatListItem[] {
  const out: WeChatListItem[] = []
  let i = 0
  for (const { run, card } of walkRuns(items)) {
    let act: WxActionKind | null = null
    let targetName: string | undefined
    let meta: string | undefined
    if (run.type === 'article' && card && card.kind === 'wx_article') {
      act = 'oa_article'; targetName = card.account; meta = card.title
    } else if (run.type === 'oa_feed') {
      act = 'oa_feed'
      meta = card && card.kind === 'wx_oa_feed' ? `浏览 ${card.entries.length} 条订阅号文章` : '浏览订阅号消息'
    } else if (run.type === 'chat' && card && card.kind === 'wx_chat') {
      act = 'chatting'; targetName = card.partner
      meta = [card.shares.length ? `${card.shares.length} 条分享` : '', card.imageCount ? `${card.imageCount} 张图` : '']
        .filter(Boolean).join(' · ') || undefined
    }
    // 会话列表属隐私：不产出动作（walkRuns 内部仍用它推断聊天 partner）
    if (!act) continue
    out.push({ kind: 'wx_action', key: `wx-act-${run.startTs}-${i}`, startTs: run.startTs, endTs: run.endTs, act, targetName, meta })
    i++
  }
  out.forEach((it, idx) => {
    ;(it as any)._groupTs = (it as any).startTs
    ;(it as any)._groupIdx = idx
  })
  return out
}

// ── 正式表 draft ──

function buildFormalCards(items: TorrentCapture[]): TorrentFormalCardDraft[] {
  return buildCards(items).map((c) => {
    const startTs = ('ts' in c ? (c as any).ts : (c as any).tsStart) as number
    const endTs = ('endTs' in c ? (c as any).endTs : (c as any).tsEnd) as number
    const { kind, key, ...rest } = c as any
    return {
      parserId: PARSER_ID,
      parserVersion: PARSER_VERSION,
      key,
      packageName: WECHAT_PACKAGE,
      appLabel: '微信',
      cardKind: kind,
      startTs,
      endTs,
      title: (c as any).title,
      upName: (c as any).account ?? (c as any).partner,
      payload: rest,
      sourceRefs: sourceRefsInRange(items, startTs, endTs),
    }
  })
}

function buildFormalActions(items: TorrentCapture[]): TorrentFormalActionDraft[] {
  return buildActions(items).flatMap((a) => {
    if (a.kind !== 'wx_action') return []
    return [{
      parserId: PARSER_ID,
      parserVersion: PARSER_VERSION,
      key: a.key,
      packageName: WECHAT_PACKAGE,
      appLabel: '微信',
      kind: a.act,
      startTs: a.startTs,
      endTs: a.endTs,
      title: a.meta,
      upName: a.targetName,
      payload: { act: a.act, targetName: a.targetName, meta: a.meta },
      sourceRefs: sourceRefsInRange(items, a.startTs, a.endTs),
    }]
  })
}

// ── formal 表反向还原成 UI ListItem（formal 读模式下用） ──

function safeParse(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown> } catch { return {} }
}

function buildFeedListItemsFromFormal(cards: TorrentFormalCard[]): WeChatListItem[] {
  const out = cards
    .slice()
    .filter((c) => c.cardKind !== 'wx_session_list') // 会话列表属隐私，即便旧库残留也不渲染
    .sort((a, b) => a.startTs - b.startTs || a.rowId - b.rowId)
    .map((c) => ({ kind: c.cardKind, key: c.key, ...safeParse(c.payloadJson) }) as unknown as WeChatListItem)
  out.forEach((it, i) => {
    ;(it as any)._groupTs = ('ts' in it ? (it as any).ts : (it as any).tsStart)
    ;(it as any)._groupIdx = i
  })
  return out
}

function buildActionListItemsFromFormal(actions: TorrentFormalAction[]): WeChatListItem[] {
  const out = actions
    .slice()
    .filter((a) => a.kind !== 'session_list') // 会话列表属隐私
    .sort((a, b) => a.startTs - b.startTs || a.rowId - b.rowId)
    .map((a) => {
      const p = safeParse(a.payloadJson)
      return {
        kind: 'wx_action',
        key: a.key,
        startTs: a.startTs,
        endTs: a.endTs,
        act: (p.act as WxActionKind) ?? (a.kind as WxActionKind),
        targetName: (p.targetName as string) ?? a.upName ?? undefined,
        meta: (p.meta as string) ?? a.title ?? undefined,
      } as WeChatListItem
    })
  out.forEach((it, i) => {
    ;(it as any)._groupTs = (it as any).startTs
    ;(it as any)._groupIdx = i
  })
  return out
}

export const wechatTorrentParser: TorrentParserModule<WeChatListItem> = {
  id: PARSER_ID,
  version: PARSER_VERSION,
  displayName: '微信',
  packages: [WECHAT_PACKAGE],
  accent: WECHAT_ACCENT,
  canParse: (item) => item.packageName === WECHAT_PACKAGE,
  getPackageLabel: () => '微信',
  buildFeedListItems: buildCards,
  buildActionListItems: buildActions,
  buildFormalActions,
  buildFormalCards,
  buildActionListItemsFromFormal,
  buildFeedListItemsFromFormal,
}
