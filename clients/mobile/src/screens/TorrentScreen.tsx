// ══════════════════════════════════════════════
// 洪流域：用户在某 app 看到的文本时间线（Phase 1 raw 层）
// 当前只接 B 站主页（MainActivityV2 的 feed item contentDescription）
// 视频详情 / 评论区暂不接入（B 站这两个屏的核心文字多是 Canvas 绘制，
// AccessibilityNodeInfo 拿不到）
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import {
  clearTorrentCaptures,
  countTorrentCaptures,
  getRecentTorrentCaptures,
  isAccessibilityEnabled,
  openAccessibilitySettings,
  type TorrentCapture,
} from '../lib/perception'
import { alpha, theme } from '../theme'

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

// 视频内秒 → mm:ss / hh:mm:ss
function fmtVidSec(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

const PACKAGE_LABEL: Record<string, string> = {
  'tv.danmaku.bili': 'B 站',
}

function isA11ySnapshotCapture(captureType: string): boolean {
  return captureType === 'a11y-view' || captureType === 'a11y-poll'
}

type ViewMode = 'raw' | 'feed' | 'action'
type SortOrder = 'desc' | 'asc'
type JumpKind = 'home' | 'detail' | 'story' | 'fullscreen' | 'comments'
type JumpTarget = { ts: number; preferKind?: JumpKind }
type CrossJump = (targetViewMode: ViewMode, ts: number, preferKind?: JumpKind) => void

// 【DEV-only】卡片对照调试：把范围设成 ['HH:MM:SS', 'HH:MM:SS']
// 限定只看这段时间的 raw → 单独研究某一卡片，不污染 UI
// 提交前必须设回 null
const DEV_TIME_RANGE: [string, string] | null = null

// HH:MM:SS → 当天毫秒（用 items 中任意一条的本地日期作为基准日）
function hhmmssToMs(hhmmss: string, items: TorrentCapture[]): number {
  if (items.length === 0) return 0
  const ref = new Date(items[0].eventTimeMs)
  const [h, m, s] = hhmmss.split(':').map(Number)
  ref.setHours(h, m, s, 0)
  return ref.getTime()
}

// B 站 feed item 解析：从 contentDescription 聚合行抽出标题 / UP / 播放数 / 时长 / 弹幕
// 格式（无障碍读屏文本，B 站会主动暴露给 a11y）：
//   视频,《标题》,《X 观看》,《N 弹幕》,《时长 N 分 N 秒》,《UP主 xxx》,《已关注》
//   竖版视频,《标题》,1841 观看,-弹幕,时长 1 分钟 50 秒,UP主 xxx,竖屏,
//   会员购 / 专栏 / 动态 也是类似 pattern，但我们只关心视频
interface BiliFeedItem {
  rowId: number
  ts: number
  kind: '视频' | '竖版视频' | '横幅视频' | '直播' | '专栏' | '会员购' | '其他'
  title: string
  upName: string | null
  views: string | null
  danmaku: string | null
  duration: string | null
  followed: boolean
  raw: string
}

// 同时认半角 / 全角逗号（home feed 用半角，详情页相关推荐用全角）
const FEED_PATTERN = /^(视频|竖版视频|专栏|会员购|动态|直播)[,，]/

// 横幅广告 / 合作活动 banner 候选：a11y 抓到的【XXX】开头长文本
// （feed item 用 FEED_PATTERN 识别，已被 parseBiliFeedItem 进 set 排除掉）
function isBannerCandidate(t: string): boolean {
  if (!t) return false
  // 必须以 【 开头，至少含一个 】，且总长 > 10
  if (!/^【[^】]+】/.test(t)) return false
  if (t.length < 10) return false
  return true
}

// 视频详情页主视频解析（与 home feed 相关推荐区分）
// 关键：主视频卡的几个字段在整个详情页 a11y 树里都是唯一的指纹
interface BiliVideoDetail {
  title: string | null
  upName: string | null
  upFans: string | null
  upVideoCount: string | null
  duration: string | null
  views: string | null
  danmaku: string | null
  publishedAt: string | null
  watchingNow: string | null
  likes: string | null
  coins: string | null
  favorites: string | null
  shares: string | null
  category: string | null
  description: string | null
  isInteractive: boolean
  followed: boolean           // 已关注
  hasChargeBtn: boolean       // 主页有充电按钮
  // 视频集合
  collectionName: string | null     // "AI编程-2026"
  collectionProgress: string | null // "246/248"
  // 播放进度采样：[{ ts, currSec, totalSec }]，按 ts 升序
  playProgress: PlayProgressSample[]
  promos: { kind: string; text: string }[]
  related: BiliFeedItem[]
}

interface PlayProgressSample {
  ts: number       // 真实墙钟时间戳
  currSec: number  // 已播放秒数
  totalSec: number // 总长秒数
  raw: string      // "00:06/37:30"
}

// title 允许全角逗号（中文标题常用），只禁止半角逗号（avoid 与 "视频,标题,UP主xxx,..." home feed 冲突）
// B 站 detail 主视频标题前缀：
//   互动视频, XXX   — 老版（2026-05 之前）
//   活动,     XXX   — 新版（前缀后多空格）
//   视频, XXX / 竖版视频, XXX
// 标题本身可能含半角逗号（如"娜波摩木偶,不然少玩五毛"），用 .+ 而不是 [^,]+
// 但要避免误识 home feed 的 "视频,标题,UP主xxx,观看,弹幕..." 多字段格式
const TITLE_PATTERN = /^(互动视频|活动|视频|竖版视频),\s+(.+)$/
// detail 主标题 vs home feed item 区分：home feed 含 "UP主" / "观看" / "弹幕" 字段
function isDetailTitleMatch(t: string): RegExpMatchArray | null {
  const m = t.match(TITLE_PATTERN)
  if (!m) return null
  const body = m[2]
  if (body.includes('UP主') || body.includes('观看') || body.includes('弹幕')) return null
  return m
}
const UP_PATTERN = /^up主(.+?)[,，](.+?)粉丝[,，](\d+)视频/
const PLAYS_PATTERN = /^([\d.万亿千百]+)播放$/
const DANMAKU_PATTERN = /^(\d+)条弹幕$/
const WATCHING_PATTERN = /^([\d,]+)人正在看$/
const PUBLISHED_PATTERN = /^(\d{4}年\d{1,2}月\d{1,2}日( \d{1,2}:\d{2})?)$/
const LIKE_PATTERN = /^点赞[,，](.+?)个点赞$/
const COIN_PATTERN = /^投币[,，](.+?)个投币$/
const FAV_PATTERN = /^收藏[,，](.+?)个收藏$/
const SHARE_PATTERN = /^分享[,，](.+?)个分享$/
const CATEGORY_PATTERN = /^(\d+)\s*·\s*(.+)$/  // "775 · 科技·科学"

// 条形推送：".../xxx,xxx,轻点两下查看详情" 或 "广告,xxx,,轻点两下..." / "会员购,xxx,,轻点两下..."
const PROMO_TAIL = /[,，]轻点两下查看详情$/
const PROMO_KIND_TAGS = new Set(['广告', '会员购', '推广'])

function parsePromo(raw: string): { kind: string; text: string } | null {
  if (!PROMO_TAIL.test(raw)) return null
  const segs = raw.replace(PROMO_TAIL, '').split(/[,，]/).map(s => s.trim()).filter(Boolean)
  if (segs.length === 0) return null
  // 找首段标签（"广告" / "会员购"）+ 非标签的主体作为标题
  let kind = '推送'
  let text = ''
  for (const s of segs) {
    if (PROMO_KIND_TAGS.has(s)) { kind = s; continue }
    if (!text) text = s
  }
  return text ? { kind, text } : null
}

// 时间地点 pattern：评论锚点
//   "5月7日 重庆" / "5月10日 山西" / "1小时前 广东" / "刚刚" / "昨天 19:19 陕西"
const COMMENT_TIME_LOC = /^(刚刚|\d+分钟前|\d+小时前|昨天|前天|\d+天前|\d{1,2}月\d{1,2}日)(\s+\S+)?$/
const COMMENT_NOISE = new Set([
  '热门评论', '按热度', '按时间', '评论详情', '回复', '相关推荐',
  '展开', '收起', '添加表情', '文本栏', '说点什么吧', '评论',
  '简介', 'UP', '不喜欢', '更多', '更多操作', '相关回复',
])
// 楼层号 / 评论 ID："CD." + "数字"（多行）
function isCommentNoise(t: string): boolean {
  if (COMMENT_NOISE.has(t)) return true
  if (/^共\d+条回复$/.test(t)) return false  // 这个我们要保留作 replyCount
  if (/^UP主等人\s+共\d+条回复$/.test(t)) return false
  if (/^相关回复共\d+条$/.test(t)) return false
  if (/^CD\.$/.test(t)) return true
  if (/^\d+$/.test(t) && t.length <= 6) return false  // 数字可能是点赞数，不噪音
  return false
}

function parseBiliComments(
  rawLines: { rowId: number; text: string; ts: number }[],
): { comments: CommentItem[]; totalCount: number | null } | null {
  // 必须有评论 surface 标识
  const texts = rawLines.map((l) => l.text.trim()).filter(Boolean)
  // 评论 surface 检测：有明确 marker，或 raw 内含 ≥ 2 个"时间地点"锚点（评论列表特征）
  // 用户滚到深处时顶部 marker 滚出视野，靠多个锚点也能判定是评论 surface
  const hasMarker = texts.some((t) => t === '热门评论' || t === '评论详情' || t === '按热度')
  const anchorCount = texts.filter((t) => COMMENT_TIME_LOC.test(t)).length
  if (!hasMarker && anchorCount < 2) return null

  // 找 "评论 N" → totalCount（在 detail 页 tab "评论 88" 这种格式）
  // 实际抓到的是 "评论" 单行 + "88" 单行，没法精确关联。先空
  const totalCount: number | null = null

  // 用"时间地点行"作为评论锚点，向上找用户名/标签/正文，向下找点赞/回复数
  const comments: CommentItem[] = []
  const anchors: number[] = []
  // 找评论 surface 的起始行 — "热门评论" / "相关回复共N条" 等 marker
  // 在它之前的 raw 是视频信息 + 播放器控件，不能算 author/body 候选
  let commentSurfaceStart = 0
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].text.trim()
    if (t === '热门评论' || t === '按热度' || /^相关回复共\d+条$/.test(t)) {
      commentSurfaceStart = i
      break
    }
  }
  rawLines.forEach((ln, idx) => {
    if (idx < commentSurfaceStart) return  // 评论 surface 之前的不算锚点
    if (COMMENT_TIME_LOC.test(ln.text.trim())) anchors.push(idx)
  })
  // B 站评论正文都带 U+200B 零宽字符（如 "我先露个脸​"）；用户名不带
  const isBody = (t: string) => t.includes('​')
  // 评论分隔/边界信号：碰到任一种就停止向上扫，避免把非评论 raw 误归到当前评论
  // 包括：上一评论的尾巴（共N条回复 / 回复操作）、评论 surface 之外（wifi/输入栏/广告/up主行/视频信息/互动按钮）
  const isCommentBoundary = (t: string): boolean => {
    if (/^(?:UP主等人\s+)?共\d+条回复$/.test(t)) return true
    if (/^相关回复共\d+条$/.test(t)) return true
    if (t === '热门评论' || t === '按热度' || t === '评论详情') return true
    if (t === '展开更多评论' || t === '展开更多，按钮') return true
    if (t.startsWith('wifi连接中')) return true
    if (t === '文本栏' || t === '添加表情' || t === '点我发弹幕' || t === '弹幕输入框') return true
    if (t === '关闭弹幕' || t === '简介' || t === '评论' || t === '点赞' || t === '不喜欢' || t === '投币' || t === '收藏' || t === '分享') return true
    if (t.startsWith('up主') && t.includes('粉丝')) return true
    if (t.startsWith('视频，') || t.startsWith('视频,') || t.startsWith('互动视频,')) return true
    if (t.startsWith('广告,') || t.startsWith('广告，')) return true
    if (t === '充电' || t === '已关注' || t === '取消关注，按钮' || t === 'charge icon') return true
    if (/^合集\s*·/.test(t)) return true
    if (t === '更多操作' || t === '展开更多，按钮') return true
    return false
  }

  for (let i = 0; i < anchors.length; i++) {
    const ai = anchors[i]
    const prevAi = i > 0 ? anchors[i - 1] : commentSurfaceStart - 1
    // 上方非噪音文本（按 raw 顺序：author → badges → body → 时间）
    // 遇到 isCommentBoundary 立即停止上扫
    const upperLines: string[] = []
    for (let j = ai - 1; j > prevAi; j--) {
      const t = rawLines[j].text.trim()
      if (!t) continue
      if (isCommentBoundary(t)) break  // 评论边界 → 停止
      if (isCommentNoise(t)) continue
      if (/^\d+$/.test(t) && t.length >= 5) continue  // CD 楼层 ID
      if (/^\d+$/.test(t) && t.length <= 4) continue  // 点赞数（属上一条评论的下方，不归当前 upper）
      upperLines.unshift(t)
    }
    // 下方：点赞数（≤4 位数字）+ 共N条回复
    let likes: string | null = null
    let replyCount: string | null = null
    const nextAi = i + 1 < anchors.length ? anchors[i + 1] : rawLines.length
    for (let j = ai + 1; j < nextAi; j++) {
      const t = rawLines[j].text.trim()
      if (!t) continue
      const rcm = t.match(/^(?:UP主等人\s+)?共(\d+)条回复$/) || t.match(/^相关回复共(\d+)条$/)
      if (rcm) { replyCount = rcm[1]; continue }
      if (/^\d+$/.test(t) && t.length <= 4 && !likes) { likes = t; continue }
    }
    if (upperLines.length === 0) continue
    // body：第一个带零宽字符的行（U+200B 是 B 站评论正文稳定特征）
    // fallback：如果没找到，取最长一行
    let bodyIdx = upperLines.findIndex(isBody)
    if (bodyIdx < 0) {
      bodyIdx = 0
      for (let k = 1; k < upperLines.length; k++) {
        if (upperLines[k].length > upperLines[bodyIdx].length) bodyIdx = k
      }
    }
    const body = upperLines[bodyIdx].replace(/​/g, '')
    // body 之前的行：author + badges（按 raw 顺序）
    // body 之后的行：通常没了（时间在锚点上）— 算徽章
    const before = upperLines.slice(0, bodyIdx)
    const after = upperLines.slice(bodyIdx + 1)
    // before 第一行 = 用户名；其他 = 徽章（LV / 已投 等短标签）
    let author: string | null = null
    const badges: string[] = []
    for (const o of before) {
      if (!author && o.length <= 30) author = o
      else badges.push(o)
    }
    for (const o of after) badges.push(o)
    comments.push({
      rowId: rawLines[ai].rowId,
      author,
      badges,
      body,
      timeLocation: rawLines[ai].text.trim(),
      likes,
      replyCount,
    })
  }
  if (comments.length === 0) return null
  return { comments, totalCount }
}

// "合集 · AI编程-2026" + 下一行 "246/248"
const COLLECTION_PATTERN = /^合集\s*·\s*(.+)$/
const COLLECTION_PROGRESS_PATTERN = /^(\d+\/\d+)$/
// "00:06/37:30" 播放进度
const PROGRESS_PATTERN = /^(\d{1,2}):(\d{2})\/(\d{1,3}):(\d{2})$/

// Story 卡片块的 a11y 树结构（按观察）：
//   1. UP 名（短独立行）
//   2. N粉丝（"\d+(\.\d+)?[万亿千百]?粉丝"）
//   3. 标题 + 播放数（"标题  ‎N播放" 或 "标题  ‎N播放  创作推广/广告"）
//   4. (可选) tag 行（"搜索·..." / "热搜·..." / "合集 · ..."）
//   5. 5 个互动数字（点赞/评论/投币/收藏/分享 — 顺序固定）
//   6. "发弹幕" 收尾
const STORY_FANS = /^([\d.]+[万亿千百]?)粉丝$/
// 标题尾部：双空格 + U+200E + N播放（可选后跟 "创作推广" 或 "广告" 等推广标）
const STORY_TITLE_TAIL = /\s{2,}‎?([\d.]+[万亿千百]?播放)(?:\s+(创作推广|广告))?$/
const STORY_COMMENT_HEADER = /^评论[（(]([\d.万亿千百]+)[）)]$/
// 用一组 5 个数字 + 发弹幕 锁定一个完整 story item 块
function isStoryFans(t: string): boolean { return STORY_FANS.test(t) }
function isPlayCountLine(t: string): RegExpMatchArray | null {
  const m = t.match(STORY_TITLE_TAIL)
  return m
}
function findStoryCommentCount(rawLines: { text: string }[]): string | null {
  for (const l of rawLines) {
    const m = l.text.trim().match(STORY_COMMENT_HEADER)
    if (m) return m[1]
  }
  return null
}
function isShortNum(t: string): boolean {
  return /^[\d.]+[万亿千百]?$/.test(t) && t.length <= 8
}

// 拆 Story 段 raw → 多个 StoryItem
// 启发式状态机：连续抓到 [UP名, N粉丝, 标题+N播放] 视为新 item 起点
function parseStoryItems(rawLines: { rowId: number; text: string; ts: number }[]): StoryItem[] {
  const items: StoryItem[] = []
  // 块识别：用 "N粉丝" 锚点上下抓 author/title/tag/数字
  const trimmed = rawLines.map((l) => l.text.trim())
  for (let i = 0; i < trimmed.length; i++) {
    if (!isStoryFans(trimmed[i])) continue
    // 上一行是 UP 名
    const upName = i >= 1 ? trimmed[i - 1] : ''
    if (!upName || upName.length > 30) continue
    const upFans = trimmed[i].replace('粉丝', '')
    // 下一行：标题+播放
    const titleLn = i + 1 < trimmed.length ? trimmed[i + 1] : ''
    const playM = isPlayCountLine(titleLn)
    if (!playM) continue
    const title = titleLn.replace(STORY_TITLE_TAIL, '').trim()
    if (title.length < 2) continue
    const views = playM[1]
    const isAd = playM[2] === '创作推广' || playM[2] === '广告'
    // 下一行（可选）tag
    let cursor = i + 2
    let tag: string | null = null
    if (cursor < trimmed.length) {
      const t = trimmed[cursor]
      if (/^(搜索·|热搜·|合集\s*·)/.test(t)) { tag = t; cursor++ }
    }
    // 接下来收 5 个短数字（互动数据）
    const nums: string[] = []
    while (cursor < trimmed.length && nums.length < 5) {
      const t = trimmed[cursor]
      if (isShortNum(t)) { nums.push(t); cursor++ }
      else break
    }
    items.push({
      upName, upFans, title, views, isAd, tag,
      firstSeenTs: rawLines[i].ts, lastSeenTs: rawLines[i].ts, seenCount: 1,
      likes: nums[0] ?? null,
      comments: nums[1] ?? null,
      coins: nums[2] ?? null,
      favorites: nums[3] ?? null,
      shares: nums[4] ?? null,
    })
  }
  return items
}

function parseBiliVideoDetail(rawLines: { rowId: number; text: string; ts: number }[]): BiliVideoDetail | null {
  const v: BiliVideoDetail = {
    title: null, upName: null, upFans: null, upVideoCount: null,
    duration: null, views: null, danmaku: null, publishedAt: null,
    watchingNow: null, likes: null, coins: null, favorites: null,
    shares: null, category: null, description: null, isInteractive: false,
    followed: false, hasChargeBtn: false,
    collectionName: null, collectionProgress: null,
    playProgress: [],
    promos: [], related: [],
  }
  // 必须至少匹配 UP 行 + 标题行 = 才认为是 video-detail（避免误识 home feed）
  let foundUp = false
  let foundTitle = false
  const seenRelTitles = new Set<string>()
  const seenPromos = new Set<string>()
  for (const ln of rawLines) {
    const t = ln.text.trim()
    if (!t) continue
    // 主视频标题：detail 主标题（排除 home feed 那种 "视频,标题,UP主...观看,弹幕" 格式）
    if (!v.title) {
      const titleM = isDetailTitleMatch(t)
      if (titleM) {
        if (titleM[1] === '互动视频') v.isInteractive = true
        v.title = titleM[2].trim()
        foundTitle = true
        continue
      }
    }
    // 主 UP 信息（独特行：xxx 粉丝 + xxx 视频）
    const upM = t.match(UP_PATTERN)
    if (upM) {
      v.upName = upM[1].trim()
      v.upFans = upM[2].trim()
      v.upVideoCount = upM[3]
      foundUp = true
      continue
    }
    const playsM = t.match(PLAYS_PATTERN)
    if (playsM && !v.views) { v.views = playsM[1]; continue }
    const danM = t.match(DANMAKU_PATTERN)
    if (danM && !v.danmaku) { v.danmaku = danM[1]; continue }
    const watM = t.match(WATCHING_PATTERN)
    if (watM && !v.watchingNow) { v.watchingNow = watM[1]; continue }
    const pubM = t.match(PUBLISHED_PATTERN)
    if (pubM && !v.publishedAt) { v.publishedAt = pubM[1]; continue }
    const likeM = t.match(LIKE_PATTERN)
    if (likeM) { v.likes = likeM[1].trim(); continue }
    const coinM = t.match(COIN_PATTERN)
    if (coinM) { v.coins = coinM[1].trim(); continue }
    const favM = t.match(FAV_PATTERN)
    if (favM) { v.favorites = favM[1].trim(); continue }
    const shareM = t.match(SHARE_PATTERN)
    if (shareM) { v.shares = shareM[1].trim(); continue }
    const catM = t.match(CATEGORY_PATTERN)
    if (catM && !v.category && catM[2].includes('·')) { v.category = catM[2]; continue }
    // 合集 / 合集进度
    const colM = t.match(COLLECTION_PATTERN)
    if (colM && !v.collectionName) { v.collectionName = colM[1].trim(); continue }
    const colpM = t.match(COLLECTION_PROGRESS_PATTERN)
    if (colpM && !v.collectionProgress && v.collectionName) {
      v.collectionProgress = colpM[1]
      continue
    }
    // UP 主互动按钮态
    if (t === '已关注') { v.followed = true; continue }
    if (t === '充电') { v.hasChargeBtn = true; continue }
    // 播放进度采样 "00:06/37:30"
    const progM = t.match(PROGRESS_PATTERN)
    if (progM) {
      const cur = parseInt(progM[1]) * 60 + parseInt(progM[2])
      const tot = parseInt(progM[3]) * 60 + parseInt(progM[4])
      // 同 ts 内不重复 push
      const lastP = v.playProgress[v.playProgress.length - 1]
      if (!lastP || lastP.ts !== ln.ts) {
        v.playProgress.push({ ts: ln.ts, currSec: cur, totalSec: tot, raw: t })
      }
      continue
    }
    // 条形推送（"轻点两下查看详情"结尾）
    const promo = parsePromo(t)
    if (promo) {
      if (!seenPromos.has(promo.text)) {
        seenPromos.add(promo.text)
        v.promos.push(promo)
      }
      continue
    }
    // 相关推荐：用 parseBiliFeedItem，要 kind=视频/竖版视频/横幅视频 + 有 UP（避免广告）
    const rel = parseBiliFeedItem(ln.rowId, ln.ts, t)
    if (rel && (rel.kind === '视频' || rel.kind === '竖版视频' || rel.kind === '横幅视频')) {
      if (rel.upName && !seenRelTitles.has(rel.title)) {
        seenRelTitles.add(rel.title)
        v.related.push(rel)
      }
      continue
    }
  }
  if (!foundUp || !foundTitle) return null
  return v
}

function parseBiliFeedItem(rowId: number, ts: number, raw: string): BiliFeedItem | null {
  if (!FEED_PATTERN.test(raw)) return null
  const parts = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const kindRaw = parts[0]
  let kind: BiliFeedItem['kind'] =
    kindRaw === '视频' || kindRaw === '竖版视频' || kindRaw === '专栏' || kindRaw === '会员购'
      ? kindRaw : '其他'
  const title = parts[1]
  let upName: string | null = null
  let views: string | null = null
  let danmaku: string | null = null
  let duration: string | null = null
  let followed = false
  for (const p of parts.slice(2)) {
    // UP 主：大写 'UP主xxx'（首页）或小写 'up主xxx'（详情页相关推荐）
    const upM = p.match(/^[Uu][Pp]主(.+)$/)
    if (upM) { upName = upM[1].trim(); continue }
    // 播放数：'N观看'（首页）或 'N次播放'（相关推荐）
    if (p.endsWith('观看')) { views = p.slice(0, -2).trim(); continue }
    if (p.endsWith('次播放')) { views = p.slice(0, -3).trim(); continue }
    // 弹幕：'N弹幕' 或 'N条弹幕'
    if (p.endsWith('弹幕') && p !== '-弹幕') {
      const v = p.slice(0, -2).trim()
      danmaku = v.endsWith('条') ? v.slice(0, -1).trim() : v
      continue
    }
    if (p.startsWith('时长')) { duration = p.slice(2).trim(); continue }
    if (p === '已关注') { followed = true; continue }
  }
  // 视频但没 UP 主 → B 站主页推广位 / 联动横幅
  if ((kind === '视频' || kind === '竖版视频') && !upName) kind = '横幅视频'
  return { rowId, ts, kind, title, upName, views, danmaku, duration, followed, raw }
}

const HOME_ACCENT = '#FB7299'

export type TorrentScreenDevData = {
  items: TorrentCapture[]
  total: number
  a11yOn: boolean
}

export type TorrentScreenDevSource = {
  pollMs?: number
  load: () => Promise<TorrentScreenDevData>
  clear?: () => Promise<void>
  openAccessibilitySettings?: () => void
}

export default function TorrentScreen({ devSource }: { devSource?: TorrentScreenDevSource } = {}) {
  const [items, setItems] = useState<TorrentCapture[]>([])
  const [total, setTotal] = useState(0)
  const [a11yOn, setA11yOn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('feed')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | null>(null)
  const [highlightKey, setHighlightKey] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const liveRef = useRef(true)

  // 跨视图跳转：从动作行点 → 切到 feed 跳到对应卡片；从卡头点 → 切到 action 跳到对应行
  const onCrossJump = useCallback<CrossJump>((targetVm, ts, preferKind) => {
    setViewMode(targetVm)
    setTimeout(() => setJumpTarget({ ts, preferKind }), 50)
  }, [])

  // 闪烁高亮目标（jumpTarget 不为空 → 滚动结束后高亮 1.6s）
  const onJumpHighlight = useCallback((key: string) => {
    setHighlightKey(key)
    setTimeout(() => setHighlightKey(null), 1600)
  }, [])

  const refresh = useCallback(async () => {
    try {
      // 默认拉 5000 条（约几天数据）；FlatList virtualize 只渲染可见区，
      // 几千万条理论也不卡（实际需求加 cursor 分页再说）
      const [list, n, on] = devSource
        ? await devSource.load().then((data) => [data.items, data.total, data.a11yOn] as const)
        : await Promise.all([
            getRecentTorrentCaptures(50000),
            countTorrentCaptures(),
            isAccessibilityEnabled(),
          ])
      if (!liveRef.current) return
      setItems(list)
      setTotal(n)
      setA11yOn(on)
    } catch (e) {
      console.warn('[torrent] refresh failed', e)
    } finally {
      if (liveRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [devSource])

  useEffect(() => {
    liveRef.current = true
    refresh()
    const id = setInterval(refresh, devSource?.pollMs ?? 3000)
    return () => {
      liveRef.current = false
      clearInterval(id)
    }
  }, [refresh, devSource?.pollMs])

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>洪流域</Text>
            <Text style={styles.subtitle}>
              {a11yOn ? `已抓取 ${total} 条 · 当前显示 ${items.length}` : '辅助功能未开启'}
            </Text>
          </View>
          {total > 0 && (
            <Pressable
              onPress={async () => {
                if (devSource?.clear) await devSource.clear()
                else await clearTorrentCaptures()
                refresh()
              }}
              style={styles.clearBtn}
            >
              <Text style={styles.clearBtnText}>清空</Text>
            </Pressable>
          )}
          <Pressable onPress={() => setHelpOpen(true)} style={styles.helpBtn}>
            <Text style={styles.helpBtnText}>?</Text>
          </Pressable>
        </View>
        {!a11yOn && (
          <Pressable
            onPress={() => devSource?.openAccessibilitySettings ? devSource.openAccessibilitySettings() : openAccessibilitySettings()}
            style={styles.openA11yBtn}
          >
            <Text style={styles.openA11yText}>去系统设置开启 SLS 辅助功能</Text>
          </Pressable>
        )}
        <View style={styles.modeRow}>
          {(['action', 'feed', 'raw'] as ViewMode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => setViewMode(m)}
              style={[styles.modeChip, viewMode === m && styles.modeChipOn]}
            >
              <Text style={[styles.modeChipText, viewMode === m && styles.modeChipTextOn]}>
                {m === 'feed' ? '还原卡片' : m === 'action' ? '还原动作' : '原始 SLS 数据'}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => setSortOrder((s) => s === 'desc' ? 'asc' : 'desc')}
            style={styles.sortBtn}
          >
            <Text style={styles.sortBtnText}>
              {sortOrder === 'desc' ? '新→旧 ↓' : '旧→新 ↑'}
            </Text>
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View style={styles.empty}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyHint}>
            还没抓到文本{'\n\n'}
            打开哔哩哔哩 app，刷一刷首页{'\n'}
            这边会自动出现你看到过的视频卡片
          </Text>
        </View>
      ) : (
        <RenderList
          items={items}
          viewMode={viewMode}
          sortOrder={sortOrder}
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            refresh()
          }}
          jumpTarget={jumpTarget}
          onJumpDone={(targetKey) => {
            setJumpTarget(null)
            if (targetKey) onJumpHighlight(targetKey)
          }}
          onCrossJump={onCrossJump}
          highlightKey={highlightKey}
        />
      )}
      <Modal visible={helpOpen} transparent animationType="fade" onRequestClose={() => setHelpOpen(false)}>
        <Pressable style={styles.helpBackdrop} onPress={() => setHelpOpen(false)}>
          <Pressable style={styles.helpCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.helpTitle}>洪流域 · 使用说明</Text>
            <Text style={styles.helpSection}>三个视图</Text>
            <Text style={styles.helpText}>
              · <Text style={{fontWeight:'700'}}>还原卡片</Text>：把 a11y 抓到的文本聚合还原成 B 站界面卡（主页 / 视频播放 / 评论区）{'\n'}
              · <Text style={{fontWeight:'700'}}>还原动作</Text>：识别用户操作链（开屏 → 主页 → 进视频 → 评论…），含时间范围 + 停留时长{'\n'}
              · <Text style={{fontWeight:'700'}}>原始 SLS 数据</Text>：未加工的 a11y 文本快照
            </Text>
            <Text style={styles.helpSection}>互相跳转</Text>
            <Text style={styles.helpText}>
              · 点 <Text style={{fontWeight:'700'}}>卡片头</Text>（B 站主页/视频播放/评论区标题区）→ 切到对应动作行{'\n'}
              · 点 <Text style={{fontWeight:'700'}}>动作行</Text>整行 → 切到对应卡片{'\n'}
              · 跳转到的目标会高亮闪烁 1.6s
            </Text>
            <Text style={styles.helpSection}>排序</Text>
            <Text style={styles.helpText}>
              右上 "新→旧 ↓ / 旧→新 ↑" 按钮：三个视图共用；卡片内子项（视频 item / 评论 / raw 文本）也同步翻转
            </Text>
            <Text style={styles.helpSection}>清空</Text>
            <Text style={styles.helpText}>
              清掉本地 torrent_capture 表所有数据（不影响 perception 历史数据）
            </Text>
            <Pressable onPress={() => setHelpOpen(false)} style={styles.helpClose}>
              <Text style={styles.helpCloseText}>知道了</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}

// 列表 item 类型联合：FlatList 一次只渲染可见 + buffer，几万条不卡
type SubGroup = { ts: number; items: BiliFeedItem[] }
// 一个 home 段内出现过的视频卡（按 title 去重）；记录首末出现 + 次数
// firstSeenRowId：保留 a11y 原始位置作排序锚点（同秒内 ts 相等会乱）
type HomeFeedItem = BiliFeedItem & { firstSeenTs: number; lastSeenTs: number; firstSeenRowId: number; seenCount: number }
interface CommentItem {
  rowId: number
  author: string | null
  badges: string[]      // ["UP", "红方", "已投性格三观"] 等
  body: string          // 评论正文
  timeLocation: string  // "5月7日 重庆" / "1小时前 广东"
  likes: string | null
  replyCount: string | null
}
// 竖屏 Story 视频卡 — windowClass = StoryVideoActivity，无 SeekBar
// 一个 Story 段 = 用户在 StoryVideoActivity 上的一段连续浏览
// 每段记录"看过"的视频列表（去重，按 firstSeenTs）+ 切换次数
interface StoryItem {
  upName: string
  upFans: string
  title: string
  views: string | null      // "8.1万播放"
  isAd: boolean             // "创作推广" / "广告" 标识
  tag: string | null        // "搜索·xxx" / "热搜·xxx" / "合集·xxx"
  firstSeenTs: number
  lastSeenTs: number
  seenCount: number
  // 5 个互动数字（点赞/评论/投币/收藏/分享），存在性可能不全
  likes: string | null
  comments: string | null
  coins: string | null
  favorites: string | null
  shares: string | null
}

type ListItem =
  | { kind: 'home'; key: string; tsStart: number; tsEnd: number; feedItems: HomeFeedItem[]; sweepCount: number }
  | { kind: 'detail'; key: string; tsStart: number; tsEnd: number; detail: BiliVideoDetail }
  // Story 单视频父卡（每个独立视频一张），跟 detail 平级
  | { kind: 'story'; key: string; tsStart: number; tsEnd: number; story: StoryItem }
  | { kind: 'comments'; key: string; tsStart: number; tsEnd: number; comments: CommentItem[]; totalCount: number | null; videoTitle: string | null; videoUp: string | null; commentDetailSegs: { startTs: number; endTs: number }[] }
  | { kind: 'fullscreen'; key: string; tsStart: number; tsEnd: number; watch: WatchSummary; samples: PlayProgressSample[]; videoTitle: string | null; videoUp: string | null }
  | { kind: 'actionLine'; key: string; ts: number; endTs?: number; act: BiliActionKind; title?: string; upName?: string; meta?: string; tabSeq?: VideoSubTabSeg[]; isStory?: boolean }
  | { kind: 'rawSnapshot'; key: string; ts: number; packageName: string; windowClass: string; texts: { rowId: number; text: string; sourceClass: string }[] }

// 视频播放界面内的 tab 切换段（video_intro 父动作下的子序列）
type VideoSubTab = 'intro' | 'comments' | 'comment_detail' | 'fullscreen'
interface VideoSubTabSeg {
  tab: VideoSubTab
  startTs: number
  endTs: number
  watch?: WatchSummary   // 仅 fullscreen 段：summary（chip 紧凑显示用）
  watchSamples?: PlayProgressSample[]  // 仅 fullscreen 段：原始采样（PlayProgressStrip 用）
}

// 视频观看汇总（video_intro 动作行下的播放数据）
interface WatchSummary {
  startTs: number       // 起播墙钟
  endTs: number         // 最后一次观察墙钟
  videoFromSec: number  // 起播时视频内秒
  videoToSec: number    // 末次视频内秒
  videoTotalSec: number // 视频总长
  watchedSec: number    // 视频内累计看了多少（段合计）
}

// "还原动作" — 从 raw 时间序列识别用户操作
type BiliActionKind =
  | 'splash'         // 开屏广告（出现 "跳过 N" 倒计时）
  | 'home'           // B 站主页（MainActivityV2 + feed item 出现）
  | 'video_intro'    // 进入视频简介（新 UP 行 + 标题）
  | 'fullscreen'     // 进入全屏播放（windowClass = ViewGroup + "倍速" 控件）
  | 'comments'       // 评论 tab（"热门评论" 出现）
  | 'comment_detail' // 评论详情（"评论详情" 出现）

function buildFeedListItems(itemsIn: TorrentCapture[]): ListItem[] {
  // items 从 native 来是 ORDER BY id DESC（新→旧），按时间序处理前先排成 ASC
  const items = [...itemsIn].sort((a, b) => a.rowId - b.rowId)
  const storyRaw = items.filter((c) =>
    c.packageName === 'tv.danmaku.bili'
    && c.captureType !== 'a11y-click'
    && c.windowClass.includes('StoryVideoActivity'))
  const storyAllLines = storyRaw.map((c) => ({ rowId: c.rowId, text: c.text, ts: c.eventTimeMs }))
  const allStoryItems = parseStoryItems(storyAllLines)
  const storyByCommentCount = new Map<string, StoryItem>()
  for (const it of allStoryItems) {
    if (it.comments && !storyByCommentCount.has(it.comments)) {
      storyByCommentCount.set(it.comments, it)
    }
  }
  // pre-pass：收 feed item title 集合，避免 banner 识别误抓 feed item 的标题独立行
  const feedTitlesInHome = new Set<string>()
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    if (!isA11ySnapshotCapture(c.captureType)) continue
    const p = parseBiliFeedItem(c.rowId, c.eventTimeMs, c.text)
    if (p) feedTitlesInHome.add(p.title)
  }
  // 1a) 按秒分组 home feed items
  const homeSubs: SubGroup[] = []
  const pushHomeItem = (c: TorrentCapture, item: BiliFeedItem) => {
    const sec = Math.floor(c.eventTimeMs / 1000)
    const lastSub = homeSubs[homeSubs.length - 1]
    if (lastSub && Math.floor(lastSub.ts / 1000) === sec) {
      if (!lastSub.items.some((x) => x.title === item.title)) {
        lastSub.items.push(item)
      }
    } else {
      homeSubs.push({ ts: c.eventTimeMs, items: [item] })
    }
  }
  // home surface 严格过滤：windowClass 必须是 B 站主页相关
  // （MainActivityV2 / 主页 ScrollView），排除 UnitedBiz / Story 等 detail 页
  // detail 页相关推荐也是 '视频,XXX,UP主xxx,...' 格式，不过滤会被误识为 home
  const isHomeSurface = (wc: string): boolean => {
    if (wc.includes('UnitedBiz') || wc.includes('StoryVideo')) return false
    // ViewGroup 是 detail 内部 fullscreen/评论的 windowClass，不算 home
    return wc.includes('MainActivityV2') || wc.endsWith('ScrollView')
      || wc === 'android.widget.FrameLayout'  // splash 期开屏
  }
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    if (!isA11ySnapshotCapture(c.captureType)) continue
    if (!isHomeSurface(c.windowClass)) continue
    const parsed = parseBiliFeedItem(c.rowId, c.eventTimeMs, c.text)
    if (parsed && (parsed.kind === '视频' || parsed.kind === '竖版视频' || parsed.kind === '横幅视频')) {
      pushHomeItem(c, parsed)
      continue
    }
    const t = c.text.trim()
    if (isBannerCandidate(t) && !feedTitlesInHome.has(t)) {
      pushHomeItem(c, {
        rowId: c.rowId, ts: c.eventTimeMs, kind: '横幅视频',
        title: t, upName: null, views: null, danmaku: null,
        duration: null, followed: false, raw: t,
      })
    }
  }
  // 1b) 视频详情页 buckets（含 Story 浮层）
  const detailBuckets = new Map<number, { ts: number; lines: { rowId: number; text: string; ts: number }[] }>()
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    if (!isA11ySnapshotCapture(c.captureType)) continue
    const wc = c.windowClass
    // UnitedBiz / StoryVideo / 评论浮层 / 全屏 ViewGroup —— 都进 detail bucket
    const isDetail =
      wc.includes('UnitedBiz') || wc.includes('StoryVideo')
      || wc.includes('bilibili.video.story.view')  // Story 评论浮层
      || wc === 'android.view.ViewGroup'
    if (!isDetail) continue
    const sec = Math.floor(c.eventTimeMs / 1000)
    if (!detailBuckets.has(sec)) detailBuckets.set(sec, { ts: c.eventTimeMs, lines: [] })
    detailBuckets.get(sec)!.lines.push({ rowId: c.rowId, text: c.text, ts: c.eventTimeMs })
  }
  const detailItems: ListItem[] = []
  const commentItems: ListItem[] = []
  // 跟踪当前视频上下文（按 detail bucket 时间顺序传递）
  let recentVideoTitle: string | null = null
  let recentVideoUp: string | null = null
  // detail buckets 按时间顺序遍历
  const sortedBuckets = [...detailBuckets.values()].sort((a, b) => a.ts - b.ts)
  for (const b of sortedBuckets) {
    const d = parseBiliVideoDetail(b.lines)
    if (d) {
      detailItems.push({ kind: 'detail', key: `d-${b.ts}`, tsStart: b.ts, tsEnd: b.ts, detail: d })
      if (d.title) recentVideoTitle = d.title
      if (d.upName) recentVideoUp = d.upName
    }
    // Story 视频上下文：bucket 内 raw 命中 parseStoryItems → 取第一条作为 context
    // 比 detail 优先（同 bucket 同时有 detail+story raw 时以最新出现的为准）
    const sItems = parseStoryItems(b.lines)
    if (sItems.length > 0) {
      const top = sItems[0]
      recentVideoTitle = top.title
      recentVideoUp = top.upName
    }
    const storyCommentCount = findStoryCommentCount(b.lines)
    const storyByCount = storyCommentCount ? storyByCommentCount.get(storyCommentCount) : null
    if (storyByCount) {
      recentVideoTitle = storyByCount.title
      recentVideoUp = storyByCount.upName
    }
    const cm = parseBiliComments(b.lines)
    if (cm) {
      commentItems.push({
        kind: 'comments', key: `c-${b.ts}`, tsStart: b.ts, tsEnd: b.ts,
        comments: cm.comments, totalCount: cm.totalCount,
        videoTitle: recentVideoTitle, videoUp: recentVideoUp,
        commentDetailSegs: [],
      })
    }
  }
  // 评论按视频合并：同视频（videoTitle 一致）的所有 comments 项合一张卡
  // 跟 detail.related 同思路 — 每次进评论可能只抓到部分评论（滚动深度不同），
  // 跨多次进入累计所有不重复评论
  commentItems.sort((a, b) => (a.kind === 'comments' && b.kind === 'comments' ? a.tsStart - b.tsStart : 0))
  const mergedCommentItems: ListItem[] = []
  const byVideo = new Map<string, Extract<ListItem, { kind: 'comments' }>>()
  // 同 bucket 内 a11y 经常把评论列表重复抓 2 次（同 anchor 出现 2 次）
  // dedup body 跨所有 bucket（包括第一次 push）
  for (const ci of commentItems) {
    if (ci.kind !== 'comments') continue
    const key = ci.videoTitle ?? '__no_video__'
    let existing = byVideo.get(key)
    if (!existing) {
      // 首次：建空壳，下面统一去重 push
      existing = { ...ci, comments: [] }
      byVideo.set(key, existing)
      mergedCommentItems.push(existing)
    }
    const seen = new Set(existing.comments.map((c) => c.body))
    for (const c of ci.comments) {
      if (!seen.has(c.body)) {
        existing.comments.push(c)
        seen.add(c.body)
      }
    }
    existing.tsStart = Math.min(existing.tsStart, ci.tsStart)
    existing.tsEnd = Math.max(existing.tsEnd, ci.tsEnd)
  }
  // 2) home 相邻 < 60s = 同一段浏览：合并 subgroups 内 items
  //    按 title 去重 → 一个 home 段 = 一张大卡 + 范围内所有不重复视频
  //    每张视频 item 记 firstSeen / lastSeen / seenCount（刷过几次）
  const MERGE_WINDOW_MS = 60 * 1000
  type HomeAcc = { tsStart: number; tsEnd: number; map: Map<string, HomeFeedItem>; sweeps: number }
  const homeAccs: HomeAcc[] = []
  for (const sg of homeSubs) {
    if (sg.items.length === 0) continue
    const last = homeAccs[homeAccs.length - 1]
    let acc: HomeAcc
    if (last && sg.ts - last.tsEnd < MERGE_WINDOW_MS) {
      acc = last
      acc.tsEnd = Math.max(acc.tsEnd, sg.ts)
      acc.sweeps += 1
    } else {
      acc = { tsStart: sg.ts, tsEnd: sg.ts, map: new Map(), sweeps: 1 }
      homeAccs.push(acc)
    }
    for (const it of sg.items) {
      const existing = acc.map.get(it.title)
      if (existing) {
        existing.lastSeenTs = sg.ts
        existing.seenCount += 1
      } else {
        acc.map.set(it.title, { ...it, firstSeenTs: sg.ts, lastSeenTs: sg.ts, firstSeenRowId: it.rowId, seenCount: 1 })
      }
    }
  }
  const homeItems: ListItem[] = homeAccs.map((a) => ({
    kind: 'home',
    key: `h-${a.tsStart}`,
    tsStart: a.tsStart,
    tsEnd: a.tsEnd,
    // 按 firstSeenRowId ASC 排 — 保留 a11y 首帧的原始位置（banner 在最顶
    // 因为它 rowId 最小；feed 视频按真实自顶向下顺序）
    feedItems: Array.from(a.map.values()).sort((x, y) => x.firstSeenRowId - y.firstSeenRowId),
    sweepCount: a.sweeps,
  }))
  // detail ASC + 相邻同 title + < 60s 才合并（不同视频不合）
  // 合并时：related/promos/playProgress 全部合并去重，因为每次进入同一视频
  // 相关推荐列表 / 推送可能略有不同（滑动深度不一样，会暴露更多 item）
  detailItems.sort((a, b) => (a.kind === 'detail' && b.kind === 'detail' ? a.tsStart - b.tsStart : 0))
  const mergedDetailItems: ListItem[] = []
  for (const ds of detailItems) {
    if (ds.kind !== 'detail') continue
    const last = mergedDetailItems[mergedDetailItems.length - 1]
    if (last && last.kind === 'detail' && last.detail.title === ds.detail.title
      && ds.tsStart - last.tsEnd < MERGE_WINDOW_MS) {
      last.tsEnd = Math.max(last.tsEnd, ds.tsEnd)
      // 合并播放进度采样
      for (const p of ds.detail.playProgress) {
        last.detail.playProgress.push(p)
      }
      // 合并相关推荐（按 title 去重）
      const seenRelTitles = new Set(last.detail.related.map((r) => r.title))
      for (const r of ds.detail.related) {
        if (!seenRelTitles.has(r.title)) {
          last.detail.related.push(r)
          seenRelTitles.add(r.title)
        }
      }
      // 合并条形推送（按 text 去重）
      const seenPromos = new Set(last.detail.promos.map((p) => p.text))
      for (const p of ds.detail.promos) {
        if (!seenPromos.has(p.text)) {
          last.detail.promos.push(p)
          seenPromos.add(p.text)
        }
      }
      // 互动数据 / 关注态：取最新一次的（已是 last 之后 ds）
      if (ds.detail.likes) last.detail.likes = ds.detail.likes
      if (ds.detail.coins) last.detail.coins = ds.detail.coins
      if (ds.detail.favorites) last.detail.favorites = ds.detail.favorites
      if (ds.detail.shares) last.detail.shares = ds.detail.shares
      if (ds.detail.watchingNow) last.detail.watchingNow = ds.detail.watchingNow
      if (ds.detail.followed) last.detail.followed = true
      if (ds.detail.hasChargeBtn) last.detail.hasChargeBtn = true
      if (ds.detail.collectionName && !last.detail.collectionName) {
        last.detail.collectionName = ds.detail.collectionName
        last.detail.collectionProgress = ds.detail.collectionProgress
      }
    } else {
      mergedDetailItems.push(ds)
    }
  }
  // 2c) 补播放进度：全屏期 raw 在 ViewGroup 不属 detail bucket，单独扫一遍按 ts 落进对应 detail item
  // 每个 detail item 范围内（tsStart 到下一个 detail tsStart 之前）的所有 PROGRESS_PATTERN raw 都归属它
  const detailOnly = mergedDetailItems.filter((x): x is Extract<ListItem, { kind: 'detail' }> => x.kind === 'detail')
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    const t = c.text.trim()
    const progM = t.match(PROGRESS_PATTERN)
    if (!progM) continue
    // 找当前 ts 所属 detail（tsStart <= ts < 下一个 detail tsStart）
    let targetIdx = -1
    for (let i = 0; i < detailOnly.length; i++) {
      const next = detailOnly[i + 1]
      if (c.eventTimeMs >= detailOnly[i].tsStart && (!next || c.eventTimeMs < next.tsStart)) {
        targetIdx = i
        break
      }
    }
    if (targetIdx < 0) continue
    const target = detailOnly[targetIdx]
    // 去重：同 ts 只一次
    const last = target.detail.playProgress[target.detail.playProgress.length - 1]
    if (last && last.ts === c.eventTimeMs) continue
    const cur = parseInt(progM[1]) * 60 + parseInt(progM[2])
    const tot = parseInt(progM[3]) * 60 + parseInt(progM[4])
    target.detail.playProgress.push({ ts: c.eventTimeMs, currSec: cur, totalSec: tot, raw: t })
    // 同时把 tsEnd 扩展到这一刻（用户还在看这个视频）
    if (c.eventTimeMs > target.tsEnd) target.tsEnd = c.eventTimeMs
  }
  // 每个 detail item 内 playProgress 排好序
  for (const d of detailOnly) {
    d.detail.playProgress.sort((a, b) => a.ts - b.ts)
  }
  // 2d) 补相关推荐：用户切回简介滚 related 时 windowClass 是 ViewGroup（不进 detail bucket）
  // 单独扫所有 raw 的 feed item，按 ts 归属到对应 detail item，去重合并
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    // 只看 detail surface 候选：UnitedBiz / StoryVideo / ViewGroup（全屏 / 简介滚动）
    const wc = c.windowClass
    const isDetailLike = wc.includes('UnitedBiz') || wc.includes('StoryVideo') || wc === 'android.view.ViewGroup'
    if (!isDetailLike) continue
    // 必须是 feed item pattern 且有 UP（避免误识 home feed banner / 无 UP 推广）
    const parsed = parseBiliFeedItem(c.rowId, c.eventTimeMs, c.text)
    if (!parsed || !parsed.upName) continue
    if (parsed.kind !== '视频' && parsed.kind !== '竖版视频') continue
    // 找当前 ts 所属 detail
    let targetIdx = -1
    for (let i = 0; i < detailOnly.length; i++) {
      const next = detailOnly[i + 1]
      if (c.eventTimeMs >= detailOnly[i].tsStart && (!next || c.eventTimeMs < next.tsStart)) {
        targetIdx = i
        break
      }
    }
    if (targetIdx < 0) continue
    const target = detailOnly[targetIdx]
    // 跳过主视频本身（detail.title === parsed.title）
    if (target.detail.title === parsed.title) continue
    // 按 title 去重 push
    if (!target.detail.related.some((r) => r.title === parsed.title)) {
      target.detail.related.push(parsed)
    }
    // 扩展 tsEnd
    if (c.eventTimeMs > target.tsEnd) target.tsEnd = c.eventTimeMs
  }
  // 2d) Story 竖屏视频：windowClass = StoryVideoActivity
  // 每个 StoryItem（by title 去重）= 一张独立父卡，跟 detail 平级
  // 评论浮层 windowClass = bilibili.video.story.view.n，挂到对应 story 父卡作子卡
  // 全局聚合所有 story raw → 解析 → by title 合并
  const storyMap = new Map<string, StoryItem>()
  for (const it of allStoryItems) {
    const exist = storyMap.get(it.title)
    if (exist) {
      exist.lastSeenTs = Math.max(exist.lastSeenTs, it.firstSeenTs)
      exist.seenCount += 1
    } else {
      storyMap.set(it.title, it)
    }
  }
  const storyItems: ListItem[] = Array.from(storyMap.values()).map((it) => ({
    kind: 'story' as const,
    key: `story-${it.title}-${it.firstSeenTs}`,
    tsStart: it.firstSeenTs,
    tsEnd: it.lastSeenTs,
    story: it,
  }))

  // 2e) 从动作识别的 video_intro.tabSeq 里抽：
  //   - fullscreen 段 → 按视频 by-title 合并成一张 fullscreen 卡（多次全屏 = 多段 samples 拼起来）
  //   - comment_detail 段 → 不独立成卡，挂到同视频 comments 卡的 commentDetailSegs
  const actionItems = buildActionListItems(itemsIn)
  // fullscreen 按视频合并
  const fsByVideo = new Map<string, Extract<ListItem, { kind: 'fullscreen' }>>()
  for (const ai of actionItems) {
    if (ai.kind !== 'actionLine' || ai.act !== 'video_intro' || !ai.tabSeq) continue
    for (const seg of ai.tabSeq) {
      if (seg.tab === 'fullscreen' && seg.watch) {
        const titleKey = ai.title ?? '__no_title__'
        let card = fsByVideo.get(titleKey)
        if (!card) {
          card = {
            kind: 'fullscreen',
            key: `fs-${titleKey}-${seg.startTs}`,
            tsStart: seg.startTs, tsEnd: seg.endTs,
            watch: seg.watch,
            samples: seg.watchSamples ? [...seg.watchSamples] : [],
            videoTitle: ai.title ?? null,
            videoUp: ai.upName ?? null,
          }
          fsByVideo.set(titleKey, card)
        } else {
          // 合并：扩时间区间，append samples，watch 取最新一段（或重算累计）
          card.tsStart = Math.min(card.tsStart, seg.startTs)
          card.tsEnd = Math.max(card.tsEnd, seg.endTs)
          if (seg.watchSamples) card.samples.push(...seg.watchSamples)
          // watch summary 重算：first/last sample + 累计 watched
          if (card.samples.length > 0) {
            // 按 currSec 切段重算 watchedSec
            const segs: PlayProgressSample[][] = []
            let cur: PlayProgressSample[] = []
            for (const s of card.samples.sort((a, b) => a.ts - b.ts)) {
              if (cur.length === 0) { cur.push(s); continue }
              const prev = cur[cur.length - 1]
              if (s.currSec < prev.currSec) { segs.push(cur); cur = [s] }
              else cur.push(s)
            }
            if (cur.length > 0) segs.push(cur)
            const watchedSec = segs.reduce((n, sg) => n + (sg[sg.length - 1].currSec - sg[0].currSec), 0)
            card.watch = {
              startTs: card.samples[0].ts,
              endTs: card.samples[card.samples.length - 1].ts,
              videoFromSec: card.samples[0].currSec,
              videoToSec: card.samples[card.samples.length - 1].currSec,
              videoTotalSec: card.samples[card.samples.length - 1].totalSec,
              watchedSec,
            }
          }
        }
      }
      if (seg.tab === 'comment_detail') {
        const target = mergedCommentItems.find((x): x is Extract<ListItem, { kind: 'comments' }> =>
          x.kind === 'comments' && x.videoTitle === (ai.title ?? null),
        )
        if (target) {
          target.commentDetailSegs.push({ startTs: seg.startTs, endTs: seg.endTs })
          target.tsStart = Math.min(target.tsStart, seg.startTs)
          target.tsEnd = Math.max(target.tsEnd, seg.endTs)
        }
      }
    }
  }
  const subCards: ListItem[] = Array.from(fsByVideo.values())
  // 3) 父子层级编排：
  //    视频组 = detail (父) + 它的 fullscreen 子卡 + 它的 comments 子卡
  //    每组按 detail.tsStart 排在时间线上；组内固定 detail → fullscreen → comments
  //    home 卡独立成组
  //    每个 item 标 _groupTs / _groupIdx，RenderList 按 [groupTs, groupIdx] 排，
  //    asc 时只翻组级别，组内顺序保持
  type Group = { sortTs: number; items: ListItem[] }
  const groups: Group[] = []
  const storyActionByTitle = new Map<string, Extract<ListItem, { kind: 'actionLine' }>>()
  for (const ai of actionItems) {
    if (ai.kind === 'actionLine' && ai.act === 'video_intro' && ai.isStory && ai.title) {
      if (!storyActionByTitle.has(ai.title)) storyActionByTitle.set(ai.title, ai)
    }
  }
  for (const h of homeItems) {
    if (h.kind === 'home') groups.push({ sortTs: h.tsStart, items: [h] })
  }
  // 同 title detail/story 可能有多次进入，子卡只挂第一个 group 防重复
  const consumedFsKeys = new Set<string>()
  const consumedCmtKeys = new Set<string>()
  // Story 父卡 + 同标题 comments 子卡（先处理，避免被 detail 抢走）
  for (const sv of storyItems) {
    if (sv.kind !== 'story') continue
    const storyAction = storyActionByTitle.get(sv.story.title)
    if (!storyAction) continue
    sv.tsStart = storyAction.ts
    sv.tsEnd = storyAction.endTs ?? storyAction.ts
    const groupItems: ListItem[] = [sv]
    const cmts = mergedCommentItems.filter((c): c is Extract<ListItem, { kind: 'comments' }> =>
      c.kind === 'comments' && c.videoTitle === sv.story.title && !consumedCmtKeys.has(c.key))
    cmts.forEach((c) => consumedCmtKeys.add(c.key))
    groupItems.push(...cmts)
    groups.push({ sortTs: sv.tsStart, items: groupItems })
  }
  for (const d of mergedDetailItems) {
    if (d.kind !== 'detail') continue
    const groupItems: ListItem[] = [d]
    const fss = subCards.filter((s): s is Extract<ListItem, { kind: 'fullscreen' }> =>
      s.kind === 'fullscreen' && s.videoTitle === d.detail.title && !consumedFsKeys.has(s.key))
      .sort((a, b) => a.tsStart - b.tsStart)
    fss.forEach((s) => consumedFsKeys.add(s.key))
    groupItems.push(...fss)
    const cmts = mergedCommentItems.filter((c): c is Extract<ListItem, { kind: 'comments' }> =>
      c.kind === 'comments' && c.videoTitle === d.detail.title && !consumedCmtKeys.has(c.key))
    cmts.forEach((c) => consumedCmtKeys.add(c.key))
    groupItems.push(...cmts)
    groups.push({ sortTs: d.tsStart, items: groupItems })
  }
  // 默认 desc：新组在前
  groups.sort((a, b) => b.sortTs - a.sortTs)
  // 给每个 item 打上 group 锚点
  const out: ListItem[] = []
  for (const g of groups) {
    for (let i = 0; i < g.items.length; i++) {
      ;(g.items[i] as any)._groupTs = g.sortTs
      ;(g.items[i] as any)._groupIdx = i
      out.push(g.items[i])
    }
  }
  return out
}

/**
 * "还原动作" — 从 raw 时间序列重建用户操作链
 * 识别信号：
 *  - "跳过 N" → splash
 *  - windowClass MainActivityV2 + feed item raw → home
 *  - 新出现的 `up主XXX，N粉丝，M视频` UP 行 → video_intro（标题取邻近 "互动视频/视频, XXX"）
 *  - "倍速" + windowClass ViewGroup → fullscreen（B 站全屏播放器特征）
 *  - "热门评论" → comments
 *  - "评论详情" → comment_detail
 * 合并：同 kind 在 3s 内合成一条；记录 endTs
 */
function buildActionListItems(itemsIn: TorrentCapture[]): ListItem[] {
  // items 默认 DESC，按时间序识别动作必须先排 ASC
  const items = [...itemsIn].sort((a, b) => a.rowId - b.rowId)

  // 信号推断：把单条 raw → 动作 kind + 上下文
  // 返回 null 表示该 raw 不携带动作信号（如标题独立行、空文本等）
  type Sig = { kind: BiliActionKind; title?: string; upName?: string; meta?: string }
  const inferSig = (c: TorrentCapture, ctx: { upName: string | null; title: string | null }): Sig | null => {
    const t = c.text.trim()
    if (!t) return null
    const wc = c.windowClass
    // splash 倒计时
    const splashM = t.match(/^跳过\s*(\d+)$/)
    if (splashM) return { kind: 'splash', meta: `跳过 ${splashM[1]}` }
    // 全屏：ViewGroup + 倍速控件
    if (wc === 'android.view.ViewGroup' && t === '倍速') {
      return { kind: 'fullscreen', title: ctx.title ?? undefined, upName: ctx.upName ?? undefined }
    }
    // 评论详情 / 评论 tab：永远是 video_intro 内的子段（不独立成动作）
    // 注：state machine 里 video_intro.tabSeq 会处理这些 signal；这里产生的 sig 不会
    // 单独 push 成动作行（Pass 3 内 video_intro 父在跑就被吸收成子段；不在跑则丢弃）
    if (t === '评论详情') return { kind: 'comment_detail', title: ctx.title ?? undefined, upName: ctx.upName ?? undefined }
    if (t === '热门评论') return { kind: 'comments', title: ctx.title ?? undefined, upName: ctx.upName ?? undefined }
    // 视频详情：UP 行（主视频指纹）
    const upM = t.match(/^up主(.+?)[,，](.+?)粉丝[,，](\d+)视频/)
    if (upM) return { kind: 'video_intro', upName: upM[1].trim() }
    // Story 不在 inferSig 触发 video_intro（每秒同时抓 3 个相邻 story 会反复切换）
    // Story 段单独 pass，按"当前在看视频"识别一次
    // 主页：home windowClass + feed item / banner
    if (wc.includes('MainActivityV2') || wc.endsWith('ScrollView')) {
      if (FEED_PATTERN.test(t) || isBannerCandidate(t)) return { kind: 'home' }
    }
    return null
  }

  // Pass 1：先扫所有 raw，回填 ctx.title + 收所有 signal events
  type EvSig = { ts: number; rowId: number; windowClass: string; sig: { kind: BiliActionKind; title?: string; upName?: string } }
  const events: EvSig[] = []
  const ctx = { upName: null as string | null, title: null as string | null }
  // Story raw 上下文：上一行 UP 名 + 当前行粉丝 = 锁定 ctx.upName
  // 下一行（含 STORY_TITLE_TAIL）= 锁定 ctx.title
  let prevStoryText = ''
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    const t = c.text.trim()
    // Story 上下文回填
    if (c.windowClass.includes('StoryVideoActivity')) {
      const fansM = t.match(STORY_FANS)
      if (fansM && prevStoryText && prevStoryText.length <= 30) {
        ctx.upName = prevStoryText
        ctx.title = null
      }
      const ptailM = t.match(STORY_TITLE_TAIL)
      if (ptailM) {
        const title = t.replace(STORY_TITLE_TAIL, '').trim()
        if (title.length >= 2) ctx.title = title
      }
      prevStoryText = t
    } else {
      prevStoryText = ''
    }
    // 标题行 → 更新 ctx（不入 events）
    const titleM = isDetailTitleMatch(t)
    if (titleM) {
      ctx.title = titleM[2].trim()
      continue
    }
    const sig = inferSig(c, ctx)
    if (!sig) continue
    if (sig.kind === 'video_intro' && sig.upName) {
      if (sig.upName !== ctx.upName) ctx.title = null
      ctx.upName = sig.upName
    }
    events.push({ ts: c.eventTimeMs, rowId: c.rowId, windowClass: c.windowClass, sig })
  }

  type Cur = {
    startTs: number; endTs: number;
    kind: BiliActionKind;
    title?: string; upName?: string; meta?: string;
    tabSeq?: VideoSubTabSeg[]  // 仅 video_intro 用：界面内 tab 切换序列
    isStory?: boolean          // 仅 video_intro 用：是否 Story 竖屏视频
    storyCommentCount?: string | null
  }
  const acts: Cur[] = []

  // Pass 2：splash 段独立识别
  const splashEvs = events.filter((e) => e.sig.kind === 'splash')
  const splashEnd = splashEvs.length > 0 ? splashEvs[splashEvs.length - 1].ts : 0
  if (splashEvs.length > 0) {
    acts.push({ startTs: splashEvs[0].ts, endTs: splashEnd, kind: 'splash' })
  }

  // Pass 3：剩余 signals
  // 关键变化：fullscreen/comments/comment_detail 都是 video_intro 父动作下的"界面内 tab 切换"
  // 不再独立成动作行，而是吸收为 video_intro 的 tabSeq 子段。
  // 评论详情虽然是新页面，但属于"在这个视频上的延伸操作"，仍归 video_intro。
  const SUB_TAB_KINDS = new Set<BiliActionKind>(['fullscreen', 'comments', 'comment_detail'])
  const kindToSubTab: Record<string, VideoSubTab> = {
    fullscreen: 'fullscreen', comments: 'comments', comment_detail: 'comment_detail',
  }
  const ACTION_MERGE_GAP_MS = 60_000
  // 在 video_intro 上追加子段（同子段连续就 extend，不同就 push 新段）
  const pushSubTab = (parent: Cur, tab: VideoSubTab, ts: number) => {
    if (!parent.tabSeq) parent.tabSeq = []
    const last = parent.tabSeq[parent.tabSeq.length - 1]
    if (last && last.tab === tab) { last.endTs = ts; return }
    parent.tabSeq.push({ tab, startTs: ts, endTs: ts })
  }
  // video_intro 默认开局是"简介"tab
  const initIntroTab = (parent: Cur) => {
    if (!parent.tabSeq || parent.tabSeq.length === 0) {
      parent.tabSeq = [{ tab: 'intro', startTs: parent.startTs, endTs: parent.startTs }]
    }
  }
  let cur: Cur | null = null
  for (const e of events) {
    if (e.sig.kind === 'splash') continue
    if (e.sig.kind === 'home' && e.ts <= splashEnd) continue
    const sig = e.sig

    // 子动作 → 吸收为父 video_intro 的 tabSeq
    if (cur && cur.kind === 'video_intro' && SUB_TAB_KINDS.has(sig.kind)) {
      initIntroTab(cur)
      const last = cur.tabSeq![cur.tabSeq!.length - 1]
      last.endTs = e.ts
      pushSubTab(cur, kindToSubTab[sig.kind], e.ts)
      cur.endTs = e.ts
      continue
    }
    // 不在 video_intro 父下：comments / comment_detail / fullscreen 信号一律丢弃
    // （它们只能作为 video_intro 的子段存在，不能独立成动作行）
    // Story 视频通过 Pass 3.6 单独识别，不在 event 流，这里没父也丢
    if (SUB_TAB_KINDS.has(sig.kind)) continue
    // 在 video_intro 下，遇到同 UP 的 video_intro 信号 = 用户切回简介 tab
    if (cur && cur.kind === 'video_intro' && sig.kind === 'video_intro'
        && sig.upName && sig.upName === cur.upName
        && e.ts - cur.endTs < ACTION_MERGE_GAP_MS) {
      initIntroTab(cur)
      const last = cur.tabSeq![cur.tabSeq!.length - 1]
      last.endTs = e.ts
      // 当前不是 intro 状态 → 推回 intro 段
      if (last.tab !== 'intro') {
        pushSubTab(cur, 'intro', e.ts)
      }
      cur.endTs = e.ts
      // 标题/upName 回填
      if (sig.title && !cur.title) cur.title = sig.title
      continue
    }
    // 其他：normal flow
    if (cur) {
      const sameKind = cur.kind === sig.kind
      const sameVideo = sig.kind !== 'video_intro' || !sig.upName || sig.upName === cur.upName
      const closeEnough = e.ts - cur.endTs < ACTION_MERGE_GAP_MS
      if (sameKind && sameVideo && closeEnough) {
        cur.endTs = e.ts
        if (sig.title && !cur.title) cur.title = sig.title
        if (sig.upName && !cur.upName) cur.upName = sig.upName
        continue
      }
      acts.push(cur)
    }
    cur = { startTs: e.ts, endTs: e.ts, kind: sig.kind, title: sig.title, upName: sig.upName }
  }
  if (cur) acts.push(cur)

  // Pass 3.6：Story 竖屏 video_intro 单独识别
  // Story 段 raw 每秒同时抓到当前 + 相邻预加载视频，不能把所有 title 都当成进入动作。
  // 用评论浮层的 "评论（N）" 做强证据；两个强证据标题夹住的中间标题视作划过；
  // 没有强证据的 Story 段，只取每段首个主块，避免同秒预加载导致成对重复。
  const parsedStoryItems = parseStoryItems(items
    .filter((c) => c.packageName === 'tv.danmaku.bili' && c.windowClass.includes('StoryVideoActivity'))
    .map((c) => ({ rowId: c.rowId, text: c.text, ts: c.eventTimeMs })))
  const storyMetaByTitle = new Map<string, StoryItem>()
  for (const it of parsedStoryItems) {
    if (!storyMetaByTitle.has(it.title)) storyMetaByTitle.set(it.title, it)
  }
  type StorySecond = { sec: number; ts: number; titles: string[] }
  const storySecs = new Map<number, { ts: number; lines: { rowId: number; text: string; ts: number }[] }>()
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    if (!c.windowClass.includes('StoryVideoActivity')) continue
    const sec = Math.floor(c.eventTimeMs / 1000)
    if (!storySecs.has(sec)) storySecs.set(sec, { ts: c.eventTimeMs, lines: [] })
    storySecs.get(sec)!.lines.push({ rowId: c.rowId, text: c.text, ts: c.eventTimeMs })
  }
  const storySeconds: StorySecond[] = []
  for (const [sec, g] of storySecs) {
    const titles: string[] = []
    const seen = new Set<string>()
    for (const it of parseStoryItems(g.lines)) {
      if (!seen.has(it.title)) {
        seen.add(it.title)
        titles.push(it.title)
      }
    }
    if (titles.length > 0) storySeconds.push({ sec, ts: g.ts, titles })
  }
  storySeconds.sort((a, b) => a.ts - b.ts)

  const storyTitleByCommentCount = new Map<string, StoryItem>()
  for (const it of parsedStoryItems) {
    if (it.comments && !storyTitleByCommentCount.has(it.comments)) {
      storyTitleByCommentCount.set(it.comments, it)
    }
  }
  const commentProofs: { count: string; title: string; firstTs: number; lastTs: number }[] = []
  const storyCommentCountBySec = new Map<number, string>()
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    if (!c.windowClass.includes('bilibili.video.story.view')) continue
    const count = findStoryCommentCount([{ text: c.text }])
    if (!count) continue
    storyCommentCountBySec.set(Math.floor(c.eventTimeMs / 1000), count)
    const meta = storyTitleByCommentCount.get(count)
    if (!meta) continue
    const lastProof = commentProofs[commentProofs.length - 1]
    if (lastProof && lastProof.count === count && c.eventTimeMs - lastProof.lastTs < 10_000) {
      lastProof.lastTs = c.eventTimeMs
    } else {
      commentProofs.push({ count, title: meta.title, firstTs: c.eventTimeMs, lastTs: c.eventTimeMs })
    }
  }
  commentProofs.sort((a, b) => a.firstTs - b.firstTs)

  const makeStoryAction = (title: string, startTs: number, endTs: number, storyCommentCount?: string | null): Cur | null => {
    const meta = storyMetaByTitle.get(title)
    if (!meta) return null
    return {
      startTs,
      endTs,
      kind: 'video_intro',
      title,
      upName: meta.upName,
      isStory: true,
      storyCommentCount: storyCommentCount ?? meta.comments,
      tabSeq: [{ tab: 'intro', startTs, endTs: startTs }],
    }
  }
  const storyActionsByKey = new Map<string, Cur>()
  const addStoryAction = (title: string, startTs: number, endTs: number, storyCommentCount?: string | null) => {
    for (const existing of storyActionsByKey.values()) {
      if (existing.title === title && startTs <= existing.endTs + 10_000 && endTs >= existing.startTs - 10_000) {
        existing.startTs = Math.min(existing.startTs, startTs)
        existing.endTs = Math.max(existing.endTs, endTs)
        if (storyCommentCount) existing.storyCommentCount = storyCommentCount
        const intro = existing.tabSeq?.[0]
        if (intro && intro.tab === 'intro') {
          intro.startTs = existing.startTs
          intro.endTs = Math.max(intro.endTs, existing.startTs)
        }
        return existing
      }
    }
    const key = `${title}@${Math.floor(startTs / 1000)}`
    const existing = storyActionsByKey.get(key)
    if (existing) {
      existing.endTs = Math.max(existing.endTs, endTs)
      if (storyCommentCount) existing.storyCommentCount = storyCommentCount
      return existing
    }
    const act = makeStoryAction(title, startTs, endTs, storyCommentCount)
    if (!act) return null
    storyActionsByKey.set(key, act)
    return act
  }
  const earliestPrimaryTs = (title: string, beforeTs: number): number | null => {
    for (const s of storySeconds) {
      if (s.ts > beforeTs) break
      if (s.titles[0] === title) return s.ts
    }
    return null
  }
  for (let i = 0; i < commentProofs.length; i++) {
    const p = commentProofs[i]
    const primaryTs = earliestPrimaryTs(p.title, p.firstTs)
    const startTs = primaryTs != null && p.firstTs - primaryTs < 30_000 ? primaryTs : p.firstTs
    addStoryAction(p.title, startTs, p.lastTs, p.count)
  }
  for (let i = 0; i < commentProofs.length - 1; i++) {
    const prev = commentProofs[i]
    const next = commentProofs[i + 1]
    for (const s of storySeconds) {
      if (s.ts <= prev.lastTs || s.ts >= next.firstTs) continue
      const prevIdx = s.titles.indexOf(prev.title)
      const nextIdx = s.titles.indexOf(next.title)
      if (prevIdx < 0 || nextIdx <= prevIdx + 1) continue
      for (const title of s.titles.slice(prevIdx + 1, nextIdx)) {
        addStoryAction(title, s.ts, next.firstTs)
      }
    }
  }
  // 没有评论强证据的 Story 段，保留每段首个主块；这类段无法从 a11y 判断相邻预加载。
  let segStartIdx = 0
  for (let i = 0; i <= storySeconds.length; i++) {
    const prev = storySeconds[i - 1]
    const curSec = storySeconds[i]
    const isBreak = i === storySeconds.length || (prev && curSec && curSec.ts - prev.ts > 10_000)
    if (!isBreak) continue
    const seg = storySeconds.slice(segStartIdx, i)
    segStartIdx = i
    if (seg.length === 0) continue
    const segStart = seg[0].ts
    const segEnd = seg[seg.length - 1].ts
    const overlapsExisting = Array.from(storyActionsByKey.values()).some((a) =>
      a.startTs <= segEnd && a.endTs >= segStart)
    const nearCommentProof = commentProofs.some((p) =>
      segStart >= p.firstTs && segStart <= p.lastTs + 10_000)
    if (!overlapsExisting && !nearCommentProof) addStoryAction(seg[0].titles[0], segStart, segEnd)
  }

  const storyVideoActs = Array.from(storyActionsByKey.values()).sort((a, b) => a.startTs - b.startTs)
  for (const v of storyVideoActs) {
    initIntroTab(v)
  }
  for (const e of events) {
    if (!e.windowClass.includes('bilibili.video.story.view')) continue
    if (!SUB_TAB_KINDS.has(e.sig.kind)) continue
    if (e.sig.kind === 'fullscreen') continue
    const count = storyCommentCountBySec.get(Math.floor(e.ts / 1000))
    let target: Cur | undefined
    if (count) {
      for (const v of storyVideoActs) {
        if (v.storyCommentCount === count && e.ts >= v.startTs && (!target || v.startTs > target.startTs)) {
          target = v
        }
      }
    }
    if (!target) {
      for (const v of storyVideoActs) {
        if (e.ts >= v.startTs && (!target || v.startTs > target.startTs)) target = v
      }
    }
    if (!target) continue
    const last = target.tabSeq![target.tabSeq!.length - 1]
    last.endTs = e.ts
    pushSubTab(target, kindToSubTab[e.sig.kind], e.ts)
    target.endTs = Math.max(target.endTs, e.ts)
  }
  for (const v of storyVideoActs) {
    delete v.storyCommentCount
    acts.push(v)
  }

  // 动作是时间段，"新→旧"按结束时间更符合视觉时间线：
  // 例如 home 19:33→19:42 应排在 19:33→19:34 的视频之上。
  acts.sort((a, b) => a.endTs - b.endTs || a.startTs - b.startTs)

  // Pass 3.5：video_intro 标题回填
  // UP 行先于标题行出现，inferSig 的 sig.title 永远 undefined
  // 每个 video_intro 段在它的 startTs~endTs 范围内找第一个匹配 TITLE_PATTERN 的 raw
  // 通用规则：同段同 UP 主，标题取该段内首个出现的"视频/互动视频/竖版视频, X" 标题
  for (const va of acts.filter((a) => a.kind === 'video_intro')) {
    if (va.title) continue
    for (const c of items) {
      if (c.packageName !== 'tv.danmaku.bili') continue
      if (c.eventTimeMs < va.startTs || c.eventTimeMs > va.endTs) continue
      const m = isDetailTitleMatch(c.text.trim())
      if (m) { va.title = m[2].trim(); break }
    }
  }

  // Pass 4：播放进度只在全屏（SeekBar）期采样
  // 归属到 video_intro.tabSeq 内的 fullscreen 子段（按 startTs~endTs 范围匹配）
  const videoActs = acts.filter((a) => a.kind === 'video_intro')
  for (const va of videoActs) {
    if (!va.tabSeq) continue
    for (const seg of va.tabSeq) {
      if (seg.tab !== 'fullscreen') continue
      const samples: { ts: number; cur: number; tot: number }[] = []
      for (const c of items) {
        if (c.packageName !== 'tv.danmaku.bili') continue
        if (c.eventTimeMs < seg.startTs || c.eventTimeMs > seg.endTs) continue
        const m = c.text.trim().match(PROGRESS_PATTERN)
        if (!m) continue
        const cur = parseInt(m[1]) * 60 + parseInt(m[2])
        const tot = parseInt(m[3]) * 60 + parseInt(m[4])
        const last = samples[samples.length - 1]
        if (last && last.ts === c.eventTimeMs) continue
        samples.push({ ts: c.eventTimeMs, cur, tot })
      }
      if (samples.length === 0) continue
      // 切段（cur 回退算新段）+ 段累计 watched
      const segs: { ts: number; cur: number; tot: number }[][] = []
      let segCur: typeof samples = []
      for (const s of samples) {
        if (segCur.length === 0) { segCur.push(s); continue }
        const prev = segCur[segCur.length - 1]
        if (s.cur < prev.cur) { segs.push(segCur); segCur = [s] }
        else segCur.push(s)
      }
      if (segCur.length > 0) segs.push(segCur)
      const watchedSec = segs.reduce((n, seg2) => n + (seg2[seg2.length - 1].cur - seg2[0].cur), 0)
      seg.watch = {
        startTs: samples[0].ts,
        endTs: samples[samples.length - 1].ts,
        videoFromSec: samples[0].cur,
        videoToSec: samples[samples.length - 1].cur,
        videoTotalSec: samples[samples.length - 1].tot,
        watchedSec,
      }
      seg.watchSamples = samples.map((s) => ({
        ts: s.ts, currSec: s.cur, totalSec: s.tot,
        raw: `${Math.floor(s.cur / 60).toString().padStart(2, '0')}:${(s.cur % 60).toString().padStart(2, '0')}/${Math.floor(s.tot / 60).toString().padStart(2, '0')}:${(s.tot % 60).toString().padStart(2, '0')}`,
      }))
    }
  }

  // 转 ListItem
  return acts.map((a, i) => ({
    kind: 'actionLine' as const,
    key: `act-${a.startTs}-${i}`,
    ts: a.startTs,
    endTs: a.endTs,
    act: a.kind,
    title: a.title,
    upName: a.upName,
    meta: a.meta,
    tabSeq: a.tabSeq,
    isStory: a.isStory,
  })).reverse()
}

function buildRawListItems(itemsIn: TorrentCapture[]): ListItem[] {
  // items 默认 DESC，但要按"同秒同窗 → 同 group"分组必须按 rowId ASC 处理，
  // 让 group.texts[0] 是该秒最早 = a11y 树最顶端 = 视觉自顶向下顺序
  const items = [...itemsIn].sort((a, b) => a.rowId - b.rowId)
  type Group = ListItem & { kind: 'rawSnapshot' }
  const groups: Group[] = []
  for (const c of items) {
    const secKey = Math.floor(c.eventTimeMs / 1000)
    const last = groups[groups.length - 1]
    if (
      last
      && Math.floor(last.ts / 1000) === secKey
      && last.packageName === c.packageName
      && last.windowClass === c.windowClass
    ) {
      last.texts.push({ rowId: c.rowId, text: c.text, sourceClass: c.sourceClass })
    } else {
      groups.push({
        kind: 'rawSnapshot',
        key: `r-${c.rowId}`,
        ts: c.eventTimeMs,
        packageName: c.packageName,
        windowClass: c.windowClass,
        texts: [{ rowId: c.rowId, text: c.text, sourceClass: c.sourceClass }],
      })
    }
  }
  return groups.reverse()  // 默认 desc，跟 feed/action 语义一致；UI 可切 asc
}

function RenderList({
  items, viewMode, sortOrder, refreshing, onRefresh, jumpTarget, onJumpDone, onCrossJump, highlightKey,
}: {
  items: TorrentCapture[]
  viewMode: ViewMode
  sortOrder: SortOrder
  refreshing: boolean
  onRefresh: () => void
  jumpTarget: JumpTarget | null
  onJumpDone: (targetKey: string | null) => void
  onCrossJump: CrossJump
  highlightKey: string | null
}) {
  // 【DEV-only】按时间戳范围过滤 raw items（卡片对照调试）
  const filteredItems = useMemo(() => {
    if (!DEV_TIME_RANGE) return items
    const [from, to] = DEV_TIME_RANGE.map((t) => hhmmssToMs(t, items))
    return items.filter((c) => c.eventTimeMs >= from && c.eventTimeMs <= to)
  }, [items])
  const listItems = useMemo(() => {
    let base: ListItem[]
    if (viewMode === 'feed') base = buildFeedListItems(filteredItems)
    else if (viewMode === 'action') base = buildActionListItems(filteredItems)
    else base = buildRawListItems(filteredItems)
    // build 函数们默认 desc（新→旧）；切 asc 时整体 reverse
    // feed 视图按 [_groupTs(sortOrder), _groupIdx ASC] 排：组级别翻转，组内顺序保持
    // 其他视图整体 reverse 即可
    if (viewMode === 'feed') {
      const sorted = [...base].sort((a, b) => {
        const aGTs = (a as any)._groupTs ?? ('tsEnd' in a ? a.tsEnd : 0)
        const bGTs = (b as any)._groupTs ?? ('tsEnd' in b ? b.tsEnd : 0)
        if (aGTs !== bGTs) return sortOrder === 'asc' ? aGTs - bGTs : bGTs - aGTs
        const aIdx = (a as any)._groupIdx ?? 0
        const bIdx = (b as any)._groupIdx ?? 0
        return aIdx - bIdx
      })
      return sorted
    }
    return sortOrder === 'asc' ? [...base].reverse() : base
  }, [filteredItems, viewMode, sortOrder])

  // AUDIT-038：useRef / useEffect 必须无条件调用（React Hooks rules）。
  // 之前 listItems.length===0 提前 return 会让 Hooks 在空列表→非空切换时顺序错乱。
  const listRef = useRef<FlatList<ListItem>>(null)
  useEffect(() => {
    if (jumpTarget == null) return
    if (listItems.length === 0) { onJumpDone(null); return }
    const targetTs = jumpTarget.ts
    const preferKind = jumpTarget.preferKind
    const getTs = (it: ListItem) => {
      if ('tsStart' in it) return it.tsStart
      if ('ts' in it) return it.ts
      return 0
    }
    // 1) 优先匹配 preferKind 且 ts 在范围内的 item（用于动作子段精确跳到对应卡）
    let bestIdx = -1, bestDelta = Infinity
    if (preferKind) {
      for (let i = 0; i < listItems.length; i++) {
        const it = listItems[i]
        if (it.kind !== preferKind) continue
        const tsStart = 'tsStart' in it ? it.tsStart : getTs(it)
        const tsEnd = 'tsEnd' in it ? it.tsEnd : tsStart
        // ts 落在范围内直接命中
        if (targetTs >= tsStart && targetTs <= tsEnd) { bestIdx = i; break }
        // 否则按距离最近 pref item
        const d = Math.min(Math.abs(tsStart - targetTs), Math.abs(tsEnd - targetTs))
        if (d < bestDelta) { bestDelta = d; bestIdx = i }
      }
    }
    // 2) 兜底：找 ts 最近的任意 item
    if (bestIdx < 0) {
      bestDelta = Infinity
      for (let i = 0; i < listItems.length; i++) {
        const d = Math.abs(getTs(listItems[i]) - targetTs)
        if (d < bestDelta) { bestDelta = d; bestIdx = i }
      }
    }
    if (bestIdx >= 0) {
      try {
        listRef.current?.scrollToIndex({ index: bestIdx, animated: true, viewPosition: 0.1 })
      } catch {}
      onJumpDone(listItems[bestIdx].key)
    } else {
      onJumpDone(null)
    }
  }, [jumpTarget, listItems, onJumpDone])

  if (listItems.length === 0) {
    return (
      <View style={styles.emptyInline}>
        <Text style={styles.emptyHint}>
          暂无{viewMode === 'feed' ? '视频卡片' : '快照'}{'\n\n'}
          打开 B 站刷一刷，这里会列出当时看到的内容
        </Text>
      </View>
    )
  }

  return (
    <FlatList
      ref={listRef}
      data={listItems}
      keyExtractor={(it) => it.key}
      renderItem={({ item }) => (
        <ListItemView
          item={item}
          sortOrder={sortOrder}
          onCrossJump={onCrossJump}
          highlighted={highlightKey === item.key}
        />
      )}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />
      }
      initialNumToRender={8}
      maxToRenderPerBatch={6}
      windowSize={11}
      removeClippedSubviews
      onScrollToIndexFailed={(info) => {
        // 列表还没渲染到目标位置，等一帧再尝试
        setTimeout(() => {
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })
        }, 100)
      }}
    />
  )
}

function StorySnapView({ item: s, highlighted }: { item: Extract<ListItem, { kind: 'story' }>; highlighted: boolean }) {
  const it = s.story
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  return (
    <View style={[styles.snapCard, highlighted && styles.snapCardHighlight]}>
      <View style={[styles.snapCardHead, styles.snapCardHeadDetail]}>
        <View style={[styles.snapCardAccentBar, { backgroundColor: '#00AEEC' }]} />
        <View style={styles.snapCardHeadText}>
          <Text style={styles.snapCardTitle}>视频播放界面（竖屏）</Text>
          <Text style={styles.snapCardSubtitle}>{tsLabel}{it.seenCount > 1 ? ` · 看 ${it.seenCount} 次` : ''}</Text>
        </View>
      </View>
      <View style={styles.snapCardBody}>
        <View style={styles.detailMainBlock}>
          <View style={styles.storyTitleRow}>
            {it.isAd && <Text style={styles.storyAdTag}>广告</Text>}
            <Text style={styles.detailTitle}>{it.title}</Text>
          </View>
          <View style={styles.detailUpRow}>
            <Text style={styles.detailUp}>@{it.upName}</Text>
            <Text style={styles.detailUpMeta}>{it.upFans} 粉丝</Text>
            {it.views && <Text style={styles.detailUpMeta}>{it.views}</Text>}
          </View>
          {it.tag && <Text style={styles.storyTag} numberOfLines={1}>{it.tag}</Text>}
          {(it.likes || it.comments || it.coins || it.favorites || it.shares) && (
            <View style={styles.detailStatsRow}>
              {it.likes && <Text style={styles.detailStat}>👍 {it.likes}</Text>}
              {it.comments && <Text style={styles.detailStat}>💬 {it.comments}</Text>}
              {it.coins && <Text style={styles.detailStat}>🪙 {it.coins}</Text>}
              {it.favorites && <Text style={styles.detailStat}>⭐ {it.favorites}</Text>}
              {it.shares && <Text style={styles.detailStat}>↗ {it.shares}</Text>}
            </View>
          )}
        </View>
      </View>
    </View>
  )
}

function ListItemView({ item, sortOrder, onCrossJump, highlighted }: { item: ListItem; sortOrder: SortOrder; onCrossJump: CrossJump; highlighted: boolean }) {
  // 视频组子卡：fullscreen / comments 且 _groupIdx > 0 = 子层级
  const groupIdx = (item as any)._groupIdx ?? 0
  const isChild = groupIdx > 0 && (item.kind === 'fullscreen' || item.kind === 'comments')

  let inner: React.ReactNode
  if (item.kind === 'home') {
    inner = <HomeSnapView item={item} sortOrder={sortOrder} onCrossJump={onCrossJump} highlighted={highlighted} />
  } else if (item.kind === 'detail') {
    inner = <DetailSnapView item={item} onCrossJump={onCrossJump} highlighted={highlighted} />
  } else if (item.kind === 'story') {
    inner = <StorySnapView item={item} highlighted={highlighted} />
  } else if (item.kind === 'comments') {
    inner = <CommentsSnapView item={item} sortOrder={sortOrder} onCrossJump={onCrossJump} highlighted={highlighted} />
  } else if (item.kind === 'fullscreen') {
    inner = <FullscreenSnapView item={item} onCrossJump={onCrossJump} highlighted={highlighted} />
  } else if (item.kind === 'actionLine') {
    inner = <ActionLineView item={item} onCrossJump={onCrossJump} highlighted={highlighted} />
  } else if (item.kind === 'rawSnapshot') {
    inner = <RawSnapshotView item={item} sortOrder={sortOrder} />
  } else {
    return null
  }

  if (isChild) {
    // 缩进 + 左侧蓝色连接线（视觉上表明子卡归属父 detail）
    return (
      <View style={styles.childRow}>
        <View style={styles.childConnector} />
        <View style={{ flex: 1 }}>{inner}</View>
      </View>
    )
  }
  return inner
}

function HomeSnapView({ item: s, sortOrder, onCrossJump, highlighted }: { item: Extract<ListItem, { kind: 'home' }>; sortOrder: SortOrder; onCrossJump: CrossJump; highlighted: boolean }) {
  // 卡头点击 → 跳到对应动作
  const onHeadPress = () => onCrossJump('action', s.tsStart)
  // feedItems 默认按 firstSeenTs ASC（视觉自顶向下）；desc 时反转
  const orderedItems = sortOrder === 'desc' ? [...s.feedItems].reverse() : s.feedItems
  // 拆行：横幅独占；视频/竖版视频 2 列瀑布流
  type Row = { kind: 'banner'; item: HomeFeedItem } | { kind: 'pair'; items: HomeFeedItem[] }
  const rows: Row[] = []
  let pairBuf: HomeFeedItem[] = []
  const flushPair = () => {
    if (pairBuf.length > 0) { rows.push({ kind: 'pair', items: pairBuf }); pairBuf = [] }
  }
  for (const it of orderedItems) {
    if (it.kind === '横幅视频') { flushPair(); rows.push({ kind: 'banner', item: it }) }
    else { pairBuf.push(it); if (pairBuf.length === 2) flushPair() }
  }
  flushPair()
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  const dur = Math.round((s.tsEnd - s.tsStart) / 1000)
  return (
    <View style={[styles.snapCard, highlighted && styles.snapCardHighlight]}>
      <Pressable onPress={onHeadPress}>
      <View style={styles.snapCardHead}>
        <View style={styles.snapCardAccentBar} />
        <View style={styles.snapCardHeadText}>
          <View style={styles.snapCardTitleRow}>
            <Text style={styles.snapCardTitle}>B 站主页</Text>
            <Text style={styles.jumpHint}>→ 动作</Text>
          </View>
          <Text style={styles.snapCardSubtitle}>
            {tsLabel}{dur > 0 ? ` · 停留 ${dur}s` : ''} · 看到 {s.feedItems.length} 条视频
            {s.sweepCount > 1 ? ` · 刷 ${s.sweepCount} 次` : ''}
          </Text>
        </View>
      </View>
      </Pressable>
      <View style={styles.snapCardBody}>
        {rows.map((r, ri) => {
          if (r.kind === 'banner') {
            const f = r.item
            return (
              <View key={`b${ri}-${f.rowId}`} style={styles.gridBanner}>
                <View style={styles.feedKindRow}>
                  <Text style={styles.feedKindTag}>{f.kind}</Text>
                  {f.seenCount > 1 && <Text style={styles.feedSeenCount}>×{f.seenCount}</Text>}
                </View>
                <Text style={styles.feedTitle}>{f.title}</Text>
                <View style={styles.feedMeta}>
                  {f.duration && <Text style={styles.feedMetaText}>{f.duration}</Text>}
                  {f.views && <Text style={styles.feedDot}>·</Text>}
                  {f.views && <Text style={styles.feedMetaText}>{f.views} 播放</Text>}
                </View>
              </View>
            )
          }
          return (
            <View key={`p${ri}`} style={styles.gridRow}>
              {r.items.map((f) => (
                <View key={f.rowId} style={styles.gridCell}>
                  <View style={styles.feedKindRow}>
                    <Text style={styles.feedKindTag}>{f.kind}</Text>
                    {f.seenCount > 1 && <Text style={styles.feedSeenCount}>×{f.seenCount}</Text>}
                  </View>
                  <Text style={styles.feedTitleCompact} numberOfLines={2}>{f.title}</Text>
                  <View style={styles.feedUpRowCompact}>
                    {f.followed && <Text style={styles.followedCheck}>✓ 已关注</Text>}
                    {f.upName && <Text style={styles.feedUpName} numberOfLines={1}>{f.upName}</Text>}
                  </View>
                  <View style={styles.feedMetaCompact}>
                    {f.duration && <Text style={styles.feedMetaTextSm}>{f.duration}</Text>}
                    {f.views && <Text style={styles.feedMetaTextSm}>{f.views}播</Text>}
                    {f.danmaku && <Text style={styles.feedMetaTextSm}>{f.danmaku}弹</Text>}
                  </View>
                </View>
              ))}
              {r.items.length === 1 && <View style={styles.gridCell} />}
            </View>
          )
        })}
      </View>
    </View>
  )
}

function DetailSnapView({ item: s, onCrossJump, highlighted }: { item: Extract<ListItem, { kind: 'detail' }>; onCrossJump: CrossJump; highlighted: boolean }) {
  const onHeadPress = () => onCrossJump('action', s.tsStart)
  // 相关推荐目前按 a11y 抓取顺序，跟时间顺序无关 — 不跟 sortOrder 翻
  // 评论数用 d.related 自身；主视频信息没有时间维度
  const d = s.detail
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  return (
    <View style={[styles.snapCard, highlighted && styles.snapCardHighlight]}>
      <Pressable onPress={onHeadPress}>
      <View style={[styles.snapCardHead, styles.snapCardHeadDetail]}>
        <View style={[styles.snapCardAccentBar, { backgroundColor: '#00AEEC' }]} />
        <View style={styles.snapCardHeadText}>
          <View style={styles.snapCardTitleRow}>
            <Text style={styles.snapCardTitle}>视频播放界面</Text>
            <Text style={styles.jumpHint}>→ 动作</Text>
          </View>
          <Text style={styles.snapCardSubtitle}>
            {tsLabel} · 在看
            {d.related.length > 0 ? ` · 相关推荐 ${d.related.length} 条` : ''}
          </Text>
        </View>
      </View>
      </Pressable>
      <View style={styles.snapCardBody}>
        {/* 主视频 */}
        <View style={styles.detailMainBlock}>
          {d.title && <Text style={styles.detailTitle}>{d.title}</Text>}
          {/* UP 主 + 关注/充电 按钮态（同行模拟真实 B 站布局） */}
          {d.upName && (
            <View style={styles.detailUpRow}>
              <Text style={styles.detailUp}>@{d.upName}</Text>
              {d.upFans && <Text style={styles.detailUpMeta}>{d.upFans} 粉丝</Text>}
              {d.upVideoCount && <Text style={styles.detailUpMeta}>{d.upVideoCount} 视频</Text>}
              {d.hasChargeBtn && <Text style={styles.upActionCharge}>⚡ 充电</Text>}
              {d.followed && <Text style={styles.upActionFollowed}>✓ 已关注</Text>}
            </View>
          )}
          <View style={styles.detailMetaRow}>
            {d.views && <Text style={styles.detailMeta}>{d.views} 播放</Text>}
            {d.danmaku && <Text style={styles.detailMeta}>{d.danmaku} 弹幕</Text>}
            {d.watchingNow && <Text style={styles.detailMeta}>{d.watchingNow} 人正在看</Text>}
            {d.publishedAt && <Text style={styles.detailMeta}>{d.publishedAt}</Text>}
            {d.category && <Text style={styles.detailMeta}>{d.category}</Text>}
          </View>
          {/* 互动按钮栏（按钮永远显示，对应 B 站底部 4 按钮）*/}
          <View style={styles.detailStatsRow}>
            <Text style={styles.detailStat}>👍 {d.likes ?? '0'}</Text>
            <Text style={styles.detailStat}>🪙 {d.coins ?? '0'}</Text>
            <Text style={styles.detailStat}>⭐ {d.favorites ?? '0'}</Text>
            <Text style={styles.detailStat}>↗ {d.shares ?? '0'}</Text>
          </View>
          {/* 合集 */}
          {d.collectionName && (
            <View style={styles.collectionStrip}>
              <Text style={styles.collectionIcon}>≡</Text>
              <Text style={styles.collectionName} numberOfLines={1}>合集 · {d.collectionName}</Text>
              {d.collectionProgress && <Text style={styles.collectionProgress}>{d.collectionProgress}</Text>}
            </View>
          )}
          {/* 播放进度时间线（用户在这段时间播到哪里）*/}
          {/* 播放进度移到全屏播放子卡里展示（只有全屏才有 SeekBar 采样） */}
        </View>
        {/* 条形推送：紧凑单行 */}
        {d.promos.length > 0 && (
          <View style={styles.promoStripCompact}>
            {d.promos.map((p, i) => (
              <Text key={i} style={styles.promoLine} numberOfLines={1}>
                <Text style={styles.promoKindInline}>{p.kind}</Text>
                {'  '}{p.text}
              </Text>
            ))}
          </View>
        )}
        {/* 相关推荐列表 */}
        {d.related.length > 0 && (
          <View style={styles.relatedBlock}>
            <Text style={styles.relatedHead}>相关推荐</Text>
            {d.related.map((f) => (
              <View key={f.rowId} style={styles.relatedItem}>
                <View style={styles.feedKindRow}>
                  <Text style={[styles.feedKindTag, { backgroundColor: '#00AEEC' }]}>{f.kind}</Text>
                </View>
                <Text style={styles.relatedTitle} numberOfLines={2}>{f.title}</Text>
                <View style={styles.feedMeta}>
                  {f.upName && <Text style={styles.feedUp}>@{f.upName}</Text>}
                  {f.duration && <Text style={styles.feedDot}>·</Text>}
                  {f.duration && <Text style={styles.feedMetaText}>{f.duration}</Text>}
                  {f.views && <Text style={styles.feedDot}>·</Text>}
                  {f.views && <Text style={styles.feedMetaText}>{f.views} 播放</Text>}
                  {f.danmaku && <Text style={styles.feedDot}>·</Text>}
                  {f.danmaku && <Text style={styles.feedMetaText}>{f.danmaku} 弹幕</Text>}
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  )
}

// 播放进度条：按 currSec 回退切段（一次完整播放 / 回看 → 多段）
function PlayProgressStrip({ samples }: { samples: PlayProgressSample[] }) {
  const totalSec = samples[samples.length - 1].totalSec
  // 切段：currSec 回退（< 上一个） → 新段；同一段内 currSec 单调不降
  const segments: PlayProgressSample[][] = []
  let cur: PlayProgressSample[] = []
  for (const s of samples) {
    if (cur.length === 0) { cur.push(s); continue }
    const prev = cur[cur.length - 1]
    if (s.currSec < prev.currSec) {  // 跳回更早位置 = 新段（回看 / 拖动）
      segments.push(cur)
      cur = [s]
    } else {
      cur.push(s)
    }
  }
  if (cur.length > 0) segments.push(cur)

  const fmt = (s: number) => `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`
  // 总观看时长（每段 last.cur - first.cur 之和）
  const totalWatchedSec = segments.reduce((n, seg) => n + (seg[seg.length - 1].currSec - seg[0].currSec), 0)
  const first = samples[0]
  const last = samples[samples.length - 1]
  return (
    <View style={styles.progressWrap}>
      <View style={styles.progressHeader}>
        <Text style={styles.progressLabel}>
          播放进度{segments.length > 1 ? ` · ${segments.length} 段` : ''}
        </Text>
        <Text style={styles.progressMeta}>{fmt(totalSec)}</Text>
      </View>
      <View style={styles.progressBar}>
        {segments.map((seg, i) => {
          const segStart = seg[0].currSec
          const segEnd = seg[seg.length - 1].currSec
          return (
            <View
              key={i}
              style={[
                styles.progressFillSeen,
                {
                  left: `${(segStart / totalSec) * 100}%`,
                  width: `${(Math.max(segEnd - segStart, 0.5) / totalSec) * 100}%`,
                  opacity: 0.5 + 0.5 * (i + 1) / segments.length,
                },
              ]}
            />
          )
        })}
        {segments.map((seg, i) => (
          <View key={`m${i}-start`} style={[styles.progressMarker, { left: `${(seg[0].currSec / totalSec) * 100}%` }]} />
        ))}
      </View>
      {/* 段详情：仅 ≥ 2 段时展开 */}
      {segments.length > 1 ? (
        <View style={styles.progressSegList}>
          {segments.map((seg, i) => {
            const s0 = seg[0], sN = seg[seg.length - 1]
            return (
              <Text key={i} style={styles.progressSegLine}>
                <Text style={styles.progressSegIdx}>#{i + 1}</Text>
                {'  '}{fmtTime(s0.ts)}–{fmtTime(sN.ts)}
                {'  '}{fmt(s0.currSec)} → {fmt(sN.currSec)}
              </Text>
            )
          })}
          <Text style={styles.progressNote}>共看了 {totalWatchedSec}s</Text>
        </View>
      ) : (
        <Text style={styles.progressNote}>
          {fmtTime(first.ts)} 起播 → {fmtTime(last.ts)} · 实际看了 {totalWatchedSec}s
        </Text>
      )}
    </View>
  )
}

const COMMENTS_ACCENT = '#FBB04C'

function CommentsSnapView({ item: s, sortOrder, onCrossJump, highlighted }: { item: Extract<ListItem, { kind: 'comments' }>; sortOrder: SortOrder; onCrossJump: CrossJump; highlighted: boolean }) {
  const onHeadPress = () => onCrossJump('action', s.tsStart)
  // 评论默认按 raw 出现顺序（视觉自顶向下）；desc 时反转
  const comments: CommentItem[] = sortOrder === 'desc' ? [...s.comments].reverse() : s.comments
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  // 评论详情：默认收缩，跨视图跳转（highlighted）时自动展开
  const [cdOpen, setCdOpen] = useState(false)
  const detailsToShow = highlighted ? true : cdOpen
  const CD_COLOR = SUB_TAB_LABEL.comment_detail.color
  return (
    <View style={[styles.subCard, highlighted && styles.snapCardHighlight, { borderColor: alpha(COMMENTS_ACCENT, 0.3) }]}>
      <Pressable onPress={onHeadPress} style={[styles.subCardHead, { backgroundColor: alpha(COMMENTS_ACCENT, 0.06) }]}>
        <View style={[styles.subCardDot, { backgroundColor: COMMENTS_ACCENT }]} />
        <Text style={[styles.subCardLabel, { color: COMMENTS_ACCENT }]}>评论区</Text>
        <Text style={styles.subCardMeta}>{tsLabel} · {comments.length} 条</Text>
        <Text style={styles.jumpHint}>→ 动作</Text>
      </Pressable>
      <View style={styles.subCardBody}>
        {comments.map((c, i) => (
          <View key={`${c.rowId}-${i}`} style={[styles.commentItem, i === comments.length - 1 && s.commentDetailSegs.length === 0 && { borderBottomWidth: 0, marginBottom: 0, paddingBottom: 0 }]}>
            <View style={styles.commentHead}>
              {c.author && <Text style={styles.commentAuthor}>{c.author}</Text>}
              {c.badges.map((b, bi) => (
                <Text key={bi} style={styles.commentBadge}>{b}</Text>
              ))}
              <Text style={styles.commentTime}>{c.timeLocation}</Text>
            </View>
            <Text style={styles.commentBody}>{c.body}</Text>
            {(c.likes || c.replyCount) && (
              <View style={styles.commentFoot}>
                {c.likes && <Text style={styles.commentFootText}>👍 {c.likes}</Text>}
                {c.replyCount && <Text style={styles.commentFootText}>💬 {c.replyCount} 条回复</Text>}
              </View>
            )}
          </View>
        ))}
        {/* 评论详情：默认收缩；点头开/关；跨视图跳转过来自动展开 */}
        {s.commentDetailSegs.length > 0 && (
          <View style={styles.cdInline}>
            <Pressable onPress={() => setCdOpen((x) => !x)} style={styles.cdHead}>
              <Text style={[styles.cdLabel, { color: CD_COLOR }]}>评论详情</Text>
              <Text style={[styles.cdCount, { color: CD_COLOR }]}>× {s.commentDetailSegs.length}</Text>
              <Text style={styles.cdToggle}>{detailsToShow ? '收起 ▴' : '展开 ▾'}</Text>
            </Pressable>
            {detailsToShow && (
              <View style={styles.cdBody}>
                {s.commentDetailSegs.map((seg, i) => {
                  const dur = Math.round((seg.endTs - seg.startTs) / 1000)
                  return (
                    <View key={i} style={[styles.cdSeg, { borderLeftColor: CD_COLOR, backgroundColor: alpha(CD_COLOR, 0.06) }]}>
                      <Text style={styles.cdSegTime}>
                        {fmtTime(seg.startTs)} → {fmtTime(seg.endTs)}{dur >= 1 ? ` · 停留 ${dur}s` : ''}
                      </Text>
                      <Text style={styles.cdSegPlaceholder}>
                        进入评论详情页（具体回复内容 a11y 抓不到 — 浮层 Canvas 渲染）
                      </Text>
                    </View>
                  )
                })}
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  )
}

function getActionJumpKind(a: Extract<ListItem, { kind: 'actionLine' }>): JumpKind | null {
  if (a.act === 'home') return 'home'
  if (a.act === 'video_intro') return a.isStory ? 'story' : 'detail'
  if (a.act === 'fullscreen') return 'fullscreen'
  if (a.act === 'comments' || a.act === 'comment_detail') return 'comments'
  return null
}

// 全屏播放子卡 — video_intro 的 fullscreen 段独立成卡
function FullscreenSnapView({ item: s, onCrossJump, highlighted }: { item: Extract<ListItem, { kind: 'fullscreen' }>; onCrossJump: CrossJump; highlighted: boolean }) {
  const onHeadPress = () => onCrossJump('action', s.tsStart)
  const tsLabel = s.tsStart === s.tsEnd ? fmtTime(s.tsEnd) : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  const FS_COLOR = SUB_TAB_LABEL.fullscreen.color
  return (
    <View style={[styles.subCard, highlighted && styles.snapCardHighlight, { borderColor: alpha(FS_COLOR, 0.3) }]}>
      <Pressable onPress={onHeadPress} style={[styles.subCardHead, { backgroundColor: alpha(FS_COLOR, 0.06) }]}>
        <View style={[styles.subCardDot, { backgroundColor: FS_COLOR }]} />
        <Text style={[styles.subCardLabel, { color: FS_COLOR }]}>全屏播放</Text>
        <Text style={styles.subCardMeta}>{tsLabel}</Text>
        <Text style={styles.jumpHint}>→ 动作</Text>
      </Pressable>
      <View style={styles.subCardBody}>
        {s.samples.length > 0
          ? <PlayProgressStrip samples={s.samples} />
          : (
            <Text style={styles.placeholderHint}>
              该全屏段无播放进度采样（可能用户未触发 SeekBar 显示）
            </Text>
          )}
      </View>
    </View>
  )
}

// 评论详情子卡 — video_intro 的 comment_detail 段独立成卡
function ActionLineView({ item: a, onCrossJump, highlighted }: { item: Extract<ListItem, { kind: 'actionLine' }>; onCrossJump: CrossJump; highlighted: boolean }) {
  const cfg = ACTION_CFG[a.act]
  const lasted = a.endTs ? Math.round((a.endTs - a.ts) / 1000) : 0
  const timeRange = lasted >= 1
    ? `${fmtTime(a.ts)} → ${fmtTime(a.endTs!)}`
    : fmtTime(a.ts)
  const jumpKind = getActionJumpKind(a)
  const canJump = jumpKind != null
  return (
    <Pressable
      onPress={jumpKind ? () => onCrossJump('feed', a.ts, jumpKind) : undefined}
      disabled={!canJump}
      style={[styles.actionRow, highlighted && styles.actionRowHighlight]}
    >
      <View style={[styles.actionDot, { backgroundColor: cfg.color }]} />
      <View style={styles.actionBody}>
        <View style={styles.actionHead}>
          <Text style={[styles.actionKind, { color: cfg.color }]}>{a.act === 'video_intro' ? `进入视频播放界面${a.isStory ? '（竖屏）' : ''}` : cfg.label}</Text>
          {canJump && <Text style={styles.jumpHint}>→ 卡片</Text>}
          {lasted >= 1 && <Text style={styles.actionLasted}>停留 {lasted}s</Text>}
        </View>
        <Text style={styles.actionTime}>{timeRange}</Text>
        {(a.title || a.upName || a.meta) && (
          <Text style={styles.actionDetail} numberOfLines={2}>
            {a.title ? `《${a.title}》` : ''}
            {a.upName ? ` @${a.upName}` : ''}
            {a.meta ? `  ${a.meta}` : ''}
          </Text>
        )}
        {/* video_intro 子段：原 chip 横排序列（简介→全屏→评论→...）
            - intro：普通 chip（无跳转）
            - fullscreen/comments/comment_detail：特殊 chip（带 ↗ 跳转标 + 可点 → 对应卡片）
            - 全屏 chip 额外行显示播放进度紧凑摘要 */}
        {a.act === 'video_intro' && a.tabSeq && a.tabSeq.length > 0 && (
          <View style={styles.subTabRow}>
            {a.tabSeq.map((seg, i) => {
              const sub = SUB_TAB_LABEL[seg.tab]
              const dur = Math.round((seg.endTs - seg.startTs) / 1000)
              const hasCard = seg.tab !== 'intro'
              const segJumpKind: JumpKind = seg.tab === 'fullscreen' ? 'fullscreen' : 'comments'
              const onSegPress = hasCard ? (e: any) => {
                e?.stopPropagation?.()
                onCrossJump('feed', seg.startTs, segJumpKind)
              } : undefined
              const w = seg.tab === 'fullscreen' ? seg.watch : null
              return (
                <View key={i} style={styles.subTabSegRow}>
                  {i > 0 && <Text style={styles.subTabArrow}>→</Text>}
                  <Pressable
                    onPress={onSegPress}
                    disabled={!hasCard}
                    style={[styles.subTabChip, { backgroundColor: alpha(sub.color, 0.12), borderColor: alpha(sub.color, 0.35) }]}
                  >
                    <Text style={[styles.subTabChipText, { color: sub.color }]}>{sub.label}</Text>
                    {dur >= 1 && <Text style={[styles.subTabChipDur, { color: sub.color }]}>{dur}s</Text>}
                    {hasCard && <Text style={[styles.subTabChipJump, { color: sub.color }]}>↗</Text>}
                    {w && (
                      <Text style={[styles.subTabChipWatch, { color: sub.color }]}>
                        {fmtVidSec(w.videoFromSec)}→{fmtVidSec(w.videoToSec)}/{fmtVidSec(w.videoTotalSec)} · 看 {w.watchedSec}s
                      </Text>
                    )}
                  </Pressable>
                </View>
              )
            })}
          </View>
        )}
      </View>
    </Pressable>
  )
}

const SUB_TAB_LABEL: Record<VideoSubTab, { label: string; color: string }> = {
  intro:          { label: '简介',     color: '#00AEEC' },
  comments:       { label: '评论',     color: '#FBB04C' },
  comment_detail: { label: '评论详情', color: '#F59E0B' },
  fullscreen:     { label: '全屏播放', color: '#6366F1' },
}

const ACTION_CFG: Record<BiliActionKind, { label: string; color: string }> = {
  splash:         { label: '开屏广告',     color: '#9CA3AF' },
  home:           { label: '进入主页',     color: '#FB7299' },
  video_intro:    { label: '进入视频播放界面', color: '#00AEEC' },
  fullscreen:     { label: '进入全屏播放', color: '#6366F1' },
  comments:       { label: '进入评论',     color: '#FBB04C' },
  comment_detail: { label: '进入评论详情', color: '#F59E0B' },
}

function RawSnapshotView({ item: g, sortOrder }: { item: Extract<ListItem, { kind: 'rawSnapshot' }>; sortOrder: SortOrder }) {
  const winShort = g.windowClass ? g.windowClass.split('.').pop() : ''
  // raw 文本按 rowId 顺序（自顶向下）；desc 反转
  const texts = sortOrder === 'desc' ? [...g.texts].reverse() : g.texts
  return (
    <View style={styles.snapshot}>
      <View style={styles.snapshotHead}>
        <Text style={styles.snapshotTime}>{fmtTime(g.ts)}</Text>
        <Text style={styles.snapshotMeta} numberOfLines={1}>
          {PACKAGE_LABEL[g.packageName] ?? g.packageName}
          {winShort ? ` · ${winShort}` : ''}
          {' · '}{texts.length} 条
        </Text>
      </View>
      <View style={styles.snapshotBody}>
        {texts.map((t) => (
          <Text key={t.rowId} style={styles.snapshotText} numberOfLines={3}>
            {t.text}
          </Text>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line,
    backgroundColor: theme.surface,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 18, fontWeight: '700', color: theme.ink },
  subtitle: { fontSize: 12, color: theme.inkSoft, marginTop: 4 },
  clearBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.line,
    backgroundColor: theme.surface,
  },
  clearBtnText: { fontSize: 12, color: theme.inkSoft, fontWeight: '500' },
  helpBtn: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 1, borderColor: theme.line,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.surface,
  },
  helpBtnText: { fontSize: 14, color: theme.inkSoft, fontWeight: '700' },
  helpBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
    padding: 24,
  },
  helpCard: {
    backgroundColor: theme.surface, borderRadius: 12, padding: 20,
    width: '100%', maxWidth: 420,
  },
  helpTitle: { fontSize: 16, fontWeight: '700', color: theme.ink, marginBottom: 12 },
  helpSection: { fontSize: 13, fontWeight: '700', color: theme.accent, marginTop: 10, marginBottom: 4 },
  helpText: { fontSize: 12, color: theme.ink, lineHeight: 20 },
  helpClose: {
    marginTop: 16, alignSelf: 'flex-end',
    paddingHorizontal: 14, paddingVertical: 6,
    backgroundColor: theme.accent, borderRadius: 6,
  },
  helpCloseText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  snapCardHighlight: {
    borderWidth: 2, borderColor: theme.accent,
    shadowColor: theme.accent, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  actionRowHighlight: {
    backgroundColor: alpha(theme.accent, 0.12),
    borderLeftWidth: 3, borderLeftColor: theme.accent,
  },
  snapCardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  jumpHint: {
    fontSize: 9,
    color: theme.accent,
    fontWeight: '700',
    backgroundColor: alpha(theme.accent, 0.12),
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  openA11yBtn: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: theme.accent,
    alignSelf: 'flex-start',
  },
  openA11yText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  modeRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  modeChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.line,
    backgroundColor: theme.bg,
  },
  modeChipOn: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  modeChipText: { fontSize: 12, color: theme.inkSoft, fontWeight: '500' },
  modeChipTextOn: { color: '#FFF', fontWeight: '600' },
  sortBtn: {
    marginLeft: 'auto',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.lineSoft,
    backgroundColor: theme.bg,
  },
  sortBtnText: { fontSize: 11, color: theme.inkSoft, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyInline: { paddingTop: 60, alignItems: 'center', paddingHorizontal: 24 },
  emptyHint: { fontSize: 13, color: theme.inkSoft, textAlign: 'center', lineHeight: 22 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 20 },
  // 主页快照大卡
  // 子卡片层级容器：缩进 + 左侧粗色连接线（视觉归属父 detail）
  childRow: {
    flexDirection: 'row',
    paddingLeft: 10,
    marginTop: -6,
    marginBottom: 0,
  },
  childConnector: {
    width: 2,
    backgroundColor: alpha('#00AEEC', 0.35),
    marginRight: 8,
    marginTop: -8,  // 顶往上贴父卡
    marginBottom: 14,
  },
  // 子卡片本体：比父卡更轻量（无 head 大字 + 紧凑 chip 头）
  subCard: {
    backgroundColor: theme.surface,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  subCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  subCardDot: { width: 6, height: 6, borderRadius: 3 },
  subCardLabel: { fontSize: 12, fontWeight: '700' },
  subCardMeta: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'], marginLeft: 'auto', marginRight: 6 },
  subCardBody: { padding: 12 },
  snapCard: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    marginBottom: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.line,
    overflow: 'hidden',
  },
  snapCardHead: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: alpha(HOME_ACCENT, 0.06),
    borderBottomWidth: 1,
    borderBottomColor: alpha(HOME_ACCENT, 0.15),
  },
  snapCardAccentBar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: HOME_ACCENT,
    marginRight: 10,
  },
  snapCardHeadText: { flex: 1, justifyContent: 'center', gap: 3 },
  snapCardTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: theme.ink,
    letterSpacing: 0.3,
  },
  snapCardSubtitle: {
    fontSize: 12,
    color: theme.inkSoft,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  snapCardBody: { padding: 12 },
  subGroupBlock: {},
  subGroupBlockGap: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line,
  },
  subGroupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  subGroupDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: HOME_ACCENT,
  },
  subGroupTime: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.ink,
    fontVariant: ['tabular-nums'],
  },
  subGroupCount: { fontSize: 11, color: theme.inkFaint },
  snapFeedItem: {
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  snapFeedItemLast: {
    paddingBottom: 0,
    marginBottom: 0,
    borderBottomWidth: 0,
  },
  // 视频详情大卡
  snapCardHeadDetail: {
    backgroundColor: alpha('#00AEEC', 0.06),
    borderBottomColor: alpha('#00AEEC', 0.15),
  },
  detailMainBlock: {},
  detailKindTag: {
    alignSelf: 'flex-start',
    fontSize: 10,
    color: '#FFF',
    backgroundColor: '#00AEEC',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontWeight: '600',
    overflow: 'hidden',
    marginBottom: 6,
  },
  detailTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.ink,
    lineHeight: 22,
    marginBottom: 8,
  },
  detailUpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  detailUp: {
    fontSize: 13,
    color: theme.accent,
    fontWeight: '600',
  },
  detailUpMeta: {
    fontSize: 11,
    color: theme.inkSoft,
  },
  detailMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 8,
  },
  detailMeta: {
    fontSize: 11,
    color: theme.inkSoft,
    fontVariant: ['tabular-nums'],
  },
  detailStatsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
  },
  detailStat: {
    fontSize: 12,
    color: theme.ink,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  // 主视频下方条形推送
  promoStrip: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
    gap: 6,
  },
  promoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.bg,
    borderRadius: 6,
    padding: 8,
  },
  promoKind: {
    fontSize: 10,
    color: theme.inkSoft,
    backgroundColor: theme.line,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    fontWeight: '600',
    overflow: 'hidden',
  },
  promoText: { flex: 1, fontSize: 12, color: theme.ink, lineHeight: 17 },
  // 紧凑 promo（单行）
  promoStripCompact: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
    gap: 3,
  },
  promoLine: { fontSize: 11, color: theme.inkSoft, lineHeight: 16 },
  promoKindInline: {
    fontSize: 10, color: theme.inkFaint,
    fontWeight: '700',
  },
  // UP 主互动按钮（同行内联）
  upActionCharge: {
    fontSize: 10, fontWeight: '700',
    color: '#FF6699', backgroundColor: alpha('#FF6699', 0.1),
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8,
    overflow: 'hidden',
  },
  upActionFollowed: {
    fontSize: 10, fontWeight: '700',
    color: '#F69900', backgroundColor: alpha('#F69900', 0.1),
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8,
    overflow: 'hidden',
  },
  // 合集条
  collectionStrip: {
    marginTop: 10,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: alpha('#00AEEC', 0.08),
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 6,
  },
  collectionIcon: { fontSize: 14, color: '#00AEEC', fontWeight: '700' },
  collectionName: { flex: 1, fontSize: 12, color: '#0090C7', fontWeight: '600' },
  collectionProgress: { fontSize: 11, color: '#00AEEC', fontVariant: ['tabular-nums'], fontWeight: '700' },
  // 播放进度条
  progressWrap: {
    marginTop: 10, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
  },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressLabel: { fontSize: 11, color: theme.inkSoft, fontWeight: '600' },
  progressMeta: { fontSize: 11, color: theme.ink, fontVariant: ['tabular-nums'], fontWeight: '600' },
  progressBar: {
    height: 6, backgroundColor: theme.line, borderRadius: 3,
    position: 'relative', overflow: 'visible',
  },
  progressFillSeen: {
    position: 'absolute', top: 0, bottom: 0,
    backgroundColor: '#00AEEC', borderRadius: 3,
  },
  progressMarker: {
    position: 'absolute', top: -2, bottom: -2,
    width: 2, marginLeft: -1, backgroundColor: '#0090C7',
    borderRadius: 1,
  },
  progressNote: {
    marginTop: 8, fontSize: 13, color: theme.ink, fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  progressSegList: { marginTop: 6, gap: 2 },
  progressSegLine: { fontSize: 10, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  progressSegIdx: { color: '#00AEEC', fontWeight: '700' },
  // 相关推荐列表
  relatedBlock: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.lineSoft,
  },
  relatedHead: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.ink,
    marginBottom: 8,
  },
  relatedItem: {
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  relatedTitle: {
    fontSize: 13,
    color: theme.ink,
    fontWeight: '600',
    lineHeight: 18,
    marginBottom: 6,
  },
  // 评论项
  commentItem: {
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  commentHead: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  },
  commentAuthor: {
    fontSize: 12,
    color: COMMENTS_ACCENT,
    fontWeight: '700',
  },
  commentBadge: {
    fontSize: 9,
    color: theme.inkSoft,
    backgroundColor: theme.line,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    fontWeight: '500',
    overflow: 'hidden',
  },
  commentTime: {
    fontSize: 10,
    color: theme.inkFaint,
    marginLeft: 'auto',
  },
  commentBody: {
    fontSize: 13,
    color: theme.ink,
    lineHeight: 19,
    marginBottom: 4,
  },
  commentFoot: { flexDirection: 'row', gap: 12, marginTop: 2 },
  commentFootText: { fontSize: 11, color: theme.inkSoft },
  commentVideoContext: {
    fontSize: 11, color: COMMENTS_ACCENT, fontWeight: '600', marginTop: 2,
  },
  placeholderHint: { fontSize: 12, color: theme.inkSoft, fontStyle: 'italic', lineHeight: 18 },
  // 评论详情内嵌小卡（默认收缩）
  cdInline: {
    marginTop: 10, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.lineSoft,
  },
  cdHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cdLabel: { fontSize: 12, fontWeight: '700' },
  cdCount: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  cdToggle: { fontSize: 11, color: theme.inkSoft, marginLeft: 'auto' },
  cdBody: { marginTop: 8, gap: 6 },
  cdSeg: {
    paddingHorizontal: 10, paddingVertical: 6,
    borderLeftWidth: 3, borderRadius: 4,
  },
  cdSegTime: { fontSize: 11, color: theme.ink, fontVariant: ['tabular-nums'], fontWeight: '600' },
  cdSegPlaceholder: { fontSize: 11, color: theme.inkSoft, fontStyle: 'italic', marginTop: 2 },
  // 还原动作 — 时间线行
  actionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  actionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    marginRight: 12,
  },
  actionBody: { flex: 1 },
  actionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginBottom: 4 },
  actionTime: {
    fontSize: 11,
    color: theme.inkFaint,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
    marginBottom: 2,
  },
  actionKind: {
    fontSize: 14,
    fontWeight: '700',
  },
  actionLasted: {
    fontSize: 11,
    color: theme.inkSoft,
    fontVariant: ['tabular-nums'],
    marginLeft: 'auto',
  },
  actionDetail: {
    fontSize: 12,
    color: theme.ink,
    lineHeight: 16,
  },
  actionWatch: {
    marginTop: 6,
    paddingTop: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: alpha('#00AEEC', 0.08),
    borderLeftWidth: 3, borderLeftColor: '#00AEEC',
    borderRadius: 4,
  },
  actionWatchMain: {
    fontSize: 13, fontWeight: '700', color: theme.ink,
    fontVariant: ['tabular-nums'],
  },
  actionWatchSub: {
    fontSize: 11, color: theme.inkSoft, marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  subTabRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 6 },
  // 子段竖排：横向 chip + fullscreen 整段块混排
  subTabCol: { gap: 6, marginTop: 6 },
  subTabChipInner: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  // fullscreen 子段块（带播放进度）
  fsBlock: {
    paddingHorizontal: 10, paddingVertical: 8,
    borderLeftWidth: 3, borderRadius: 4,
  },
  fsHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  fsLabel: { fontSize: 12, fontWeight: '700' },
  fsDur: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'], marginLeft: 'auto' },
  jumpHintSm: { fontSize: 10, color: theme.accent, fontWeight: '700' },
  fsWatchMain: { fontSize: 11, fontWeight: '600', color: theme.ink, fontVariant: ['tabular-nums'] },
  fsWatchSub: { fontSize: 11, color: theme.inkSoft, marginTop: 2, fontVariant: ['tabular-nums'] },
  subTabSegRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  subTabArrow: { fontSize: 10, color: theme.inkFaint },
  subTabChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4, borderWidth: 1,
  },
  subTabChipText: { fontSize: 10, fontWeight: '700' },
  subTabChipDur: { fontSize: 10, fontVariant: ['tabular-nums'], fontWeight: '500' },
  subTabChipJump: { fontSize: 10, fontWeight: '700', opacity: 0.7 },
  subTabChipWatch: { fontSize: 10, fontVariant: ['tabular-nums'], fontWeight: '500', marginLeft: 4 },
  feedKindRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  feedKindTag: {
    fontSize: 10,
    color: '#FFF',
    backgroundColor: HOME_ACCENT,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontWeight: '600',
    overflow: 'hidden',
  },
  feedFollowedTag: {
    fontSize: 10,
    color: theme.accent,
    backgroundColor: '#E9EDFB',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontWeight: '600',
    overflow: 'hidden',
  },
  feedTitle: {
    fontSize: 14,
    color: theme.ink,
    fontWeight: '600',
    lineHeight: 20,
    marginBottom: 6,
  },
  feedMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
  feedUp: { fontSize: 11, color: theme.accent, fontWeight: '500' },
  feedDot: { fontSize: 11, color: theme.inkFaint },
  feedMetaText: { fontSize: 11, color: theme.inkSoft },
  feedSeenCount: { fontSize: 10, color: theme.inkFaint, marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  // Story 竖屏视频卡
  storyRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  storyTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  storyAdTag: {
    fontSize: 10, fontWeight: '700', color: '#F59E0B',
    backgroundColor: alpha('#F59E0B', 0.12),
    paddingHorizontal: 4, paddingVertical: 1,
    borderRadius: 3, overflow: 'hidden',
  },
  storyTitle: { flex: 1, fontSize: 13, color: theme.ink, fontWeight: '600', lineHeight: 18 },
  storyUp: { fontSize: 11, color: theme.inkSoft, marginBottom: 4 },
  storyTag: { fontSize: 11, color: '#8B5CF6', marginBottom: 4 },
  storyStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 2 },
  storyStat: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  // 2 列瀑布流网格
  gridRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  gridCell: {
    flex: 1,
    backgroundColor: theme.bg,
    borderRadius: 8,
    padding: 8,
  },
  gridBanner: {
    backgroundColor: theme.bg,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  feedTitleCompact: {
    fontSize: 12,
    color: theme.ink,
    fontWeight: '600',
    lineHeight: 17,
    marginBottom: 4,
  },
  feedUpCompact: {
    fontSize: 10,
    color: theme.accent,
    marginBottom: 4,
  },
  feedUpRowCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  followedCheck: {
    fontSize: 10,
    color: '#F69900',
    fontWeight: '700',
  },
  feedUpName: {
    fontSize: 10,
    color: theme.inkSoft,
    flexShrink: 1,
  },
  feedMetaCompact: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  feedMetaTextSm: {
    fontSize: 10,
    color: theme.inkSoft,
  },
  // 原始时间线
  snapshot: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.line,
  },
  snapshotHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 8,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  snapshotTime: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.ink,
    fontVariant: ['tabular-nums'],
  },
  snapshotMeta: {
    fontSize: 11,
    color: theme.inkFaint,
    flex: 1,
  },
  snapshotBody: { gap: 6 },
  snapshotText: {
    fontSize: 13,
    color: theme.ink,
    lineHeight: 19,
  },
})
