// Bilibili 洪流域解析：raw a11y 文本 → 卡片/动作模型
// UI 渲染留在 TorrentScreen；这里保持纯数据转换，方便后续并排新增其他 App parser。

import type { TorrentCapture } from '../../../lib/perception'
import type { TorrentFormalActionDraft, TorrentFormalCardDraft, TorrentParserModule } from '../types'
import { sourceRefsInRange } from '../types'

export const BILI_PACKAGE = 'tv.danmaku.bili'
export const BILI_APP_LABEL = 'B 站'
export const BILI_PARSER_ID = 'bilibili'
export const BILI_PARSER_VERSION = 1

export function getBiliPackageLabel(packageName: string | null | undefined): string {
  if (!packageName) return '应用'
  if (packageName === BILI_PACKAGE) return BILI_APP_LABEL
  return packageName.split('.').filter(Boolean).pop() ?? packageName
}

export function isA11ySnapshotCapture(captureType: string): boolean {
  return captureType === 'a11y-view' || captureType === 'a11y-poll'
}

// 列表 item 类型联合：FlatList 一次只渲染可见 + buffer，几万条不卡
type SubGroup = { ts: number; items: BiliFeedItem[] }
// 一个 home 段内出现过的视频卡（按 title 去重）；记录首末出现 + 次数
// firstSeenRowId：保留 a11y 原始位置作排序锚点（同秒内 ts 相等会乱）
export type HomeFeedItem = BiliFeedItem & { firstSeenTs: number; lastSeenTs: number; firstSeenRowId: number; seenCount: number }
export interface CommentItem {
  rowId: number
  author: string | null
  badges: string[]      // ["UP", "红方", "已投性格三观"] 等
  body: string          // 评论正文
  timeLocation: string  // "5月7日 重庆" / "1小时前 广东"
  likes: string | null
  replyCount: string | null
}
export interface CommentDetailThread {
  startTs: number
  endTs: number
  root: CommentItem | null
  replies: CommentItem[]
  replyTotal: string | null
}
// 竖屏 Story 视频卡 — windowClass = StoryVideoActivity，无 SeekBar
// 一个 Story 段 = 用户在 StoryVideoActivity 上的一段连续浏览
// 每段记录"看过"的视频列表（去重，按 firstSeenTs）+ 切换次数
export interface StoryItem {
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

export type ListItem =
  | { kind: 'home'; key: string; tsStart: number; tsEnd: number; feedItems: HomeFeedItem[]; sweepCount: number }
  | { kind: 'detail'; key: string; tsStart: number; tsEnd: number; detail: BiliVideoDetail }
  // Story 单视频父卡（每个独立视频一张），跟 detail 平级
  | { kind: 'story'; key: string; tsStart: number; tsEnd: number; story: StoryItem }
  | { kind: 'comments'; key: string; tsStart: number; tsEnd: number; comments: CommentItem[]; totalCount: number | null; videoTitle: string | null; videoUp: string | null; commentDetailSegs: { startTs: number; endTs: number }[]; commentDetails: CommentDetailThread[] }
  | { kind: 'fullscreen'; key: string; tsStart: number; tsEnd: number; watch: WatchSummary; samples: PlayProgressSample[]; videoTitle: string | null; videoUp: string | null }
  | { kind: 'actionLine'; key: string; ts: number; endTs?: number; act: BiliActionKind; title?: string; upName?: string; meta?: string; tabSeq?: VideoSubTabSeg[]; isStory?: boolean; packageName?: string; appLabel?: string }
  | { kind: 'rawSnapshot'; key: string; ts: number; packageName: string; windowClass: string; texts: { rowId: number; text: string; sourceClass: string }[] }

// 视频播放界面内的 tab 切换段（video_intro 父动作下的子序列）
export type VideoSubTab = 'intro' | 'comments' | 'comment_detail' | 'fullscreen'
export interface VideoSubTabSeg {
  tab: VideoSubTab
  startTs: number
  endTs: number
  displayDurationSec?: number
  watch?: WatchSummary   // 仅 fullscreen 段：summary（chip 紧凑显示用）
  watchSamples?: PlayProgressSample[]  // 仅 fullscreen 段：原始采样（PlayProgressStrip 用）
}

// 视频观看汇总（video_intro 动作行下的播放数据）
export interface WatchSummary {
  startTs: number       // 起播墙钟
  endTs: number         // 最后一次观察墙钟
  videoFromSec: number  // 起播时视频内秒
  videoToSec: number    // 末次视频内秒
  videoTotalSec: number // 视频总长
  watchedSec: number    // 视频内累计看了多少（段合计）
}

// "还原动作" — 从 raw 时间序列识别用户操作
export type BiliActionKind =
  | 'splash'         // 开屏广告（出现 "跳过 N" 倒计时）
  | 'home'           // B 站主页（MainActivityV2 + feed item 出现）
  | 'video_intro'    // 进入视频简介（新 UP 行 + 标题）
  | 'fullscreen'     // 进入全屏播放（windowClass = ViewGroup + "倍速" 控件）
  | 'comments'       // 评论 tab（"热门评论" 出现）
  | 'comment_detail' // 评论详情（"评论详情" 出现）

// B 站 feed item 解析：从 contentDescription 聚合行抽出标题 / UP / 播放数 / 时长 / 弹幕
// 格式（无障碍读屏文本，B 站会主动暴露给 a11y）：
//   视频,《标题》,《X 观看》,《N 弹幕》,《时长 N 分 N 秒》,《UP主 xxx》,《已关注》
//   竖版视频,《标题》,1841 观看,-弹幕,时长 1 分钟 50 秒,UP主 xxx,竖屏,
//   会员购 / 专栏 / 动态 也是类似 pattern，但我们只关心视频
export interface BiliFeedItem {
  rowId: number
  ts: number
  kind: '视频' | '竖版视频' | '大卡视频' | '横幅视频' | '直播' | '专栏' | '会员购' | '其他'
  title: string
  upName: string | null
  views: string | null
  danmaku: string | null
  duration: string | null
  followed: boolean
  raw: string
}

// 同时认半角 / 全角逗号（home feed 用半角，详情页相关推荐用全角）
export const FEED_PATTERN = /^(视频|竖版视频|专栏|会员购|动态|直播)[,，]/

// 横幅广告 / 合作活动 banner 候选：a11y 抓到的【XXX】开头长文本
// （feed item 用 FEED_PATTERN 识别，已被 parseBiliFeedItem 进 set 排除掉）
export function isBannerCandidate(t: string): boolean {
  if (!t) return false
  // 必须以 【 开头，至少含一个 】，且总长 > 10
  if (!/^【[^】]+】/.test(t)) return false
  if (t.length < 10) return false
  return true
}

function isHomeDurationText(t: string): boolean {
  return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(t) || /^\d+分钟\d+秒$/.test(t)
}

function isHomeMetricText(t: string): boolean {
  return /^[\d.]+[万亿千百]?$/.test(t)
}

export function parseLooseHomeVideoItem(
  rowId: number,
  ts: number,
  title: string,
  rawLines: { rowId: number; text: string }[],
): BiliFeedItem | null {
  if (!isBannerCandidate(title)) return null
  const idx = rawLines.findIndex((ln) => ln.rowId === rowId)
  if (idx < 0) return null
  const near = rawLines.slice(Math.max(0, idx - 4), Math.min(rawLines.length, idx + 8))
    .map((ln) => ln.text.trim())
    .filter(Boolean)

  const hasVideoCardEvidence =
    near.some((t) => t.includes('轻点两下查看详情'))
    || near.some((t) => t === title && near.indexOf(t) !== near.lastIndexOf(t))
    || near.some((t) => t === '更多')
    || near.some((t) => t === '已关注' || /^\d+已关注$/.test(t))
  if (!hasVideoCardEvidence) return null

  const idxInNear = near.findIndex((t) => t === title)
  const before = idxInNear >= 0 ? near.slice(0, idxInNear) : near
  const after = idxInNear >= 0 ? near.slice(idxInNear + 1) : near
  const afterDuplicateIdx = after.findIndex((t) => t === title)
  const afterMetricsRegion = afterDuplicateIdx >= 0 ? after.slice(0, afterDuplicateIdx) : after
  const beforeMetrics = before.filter(isHomeMetricText)
  const afterMetrics = afterMetricsRegion.filter(isHomeMetricText)
  const metrics = afterDuplicateIdx >= 0 ? afterMetrics : beforeMetrics
  const views = metrics[0] ?? null
  const danmaku = metrics[1] ?? null
  const duration = afterDuplicateIdx >= 0
    ? afterMetricsRegion.find(isHomeDurationText) ?? null
    : before.find(isHomeDurationText) ?? null
  const upRegion = afterDuplicateIdx >= 0 ? after.slice(afterDuplicateIdx + 1) : after
  const upName = afterDuplicateIdx >= 0
    ? upRegion.find((t) =>
        t !== title
        && t !== '更多'
        && t !== '已关注'
        && !/^\d+已关注$/.test(t)
        && !isHomeMetricText(t)
        && !isHomeDurationText(t)
        && !t.includes('轻点两下查看详情')
      ) ?? null
    : null
  return {
    rowId, ts, kind: '视频',
    title, upName, views, danmaku, duration,
    followed: afterDuplicateIdx >= 0 && upRegion.some((t) => t === '已关注' || /^\d+已关注$/.test(t)),
    raw: title,
  }
}

export function feedKindLabel(kind: BiliFeedItem['kind']): string {
  return kind === '大卡视频' ? '视频' : kind
}

// 视频详情页主视频解析（与 home feed 相关推荐区分）
// 关键：主视频卡的几个字段在整个详情页 a11y 树里都是唯一的指纹
export interface BiliVideoDetail {
  title: string | null
  kindLabel: string | null
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

export interface PlayProgressSample {
  ts: number       // 真实墙钟时间戳
  currSec: number  // 已播放秒数
  totalSec: number // 总长秒数
  raw: string      // "00:06/37:30"
}

export function parseBiliPlayProgressSample(ts: number, text: string): PlayProgressSample | null {
  const raw = text.trim()
  const m = raw.match(PROGRESS_PATTERN)
  if (!m) return null
  return {
    ts,
    currSec: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
    totalSec: parseInt(m[3], 10) * 60 + parseInt(m[4], 10),
    raw,
  }
}

// 按视频内时间回退切段：正常播放一段，拖回/回看后开始新段。
export function splitPlayProgressSegments(samples: readonly PlayProgressSample[]): PlayProgressSample[][] {
  const sorted = [...samples].sort((a, b) => a.ts - b.ts)
  const segments: PlayProgressSample[][] = []
  let cur: PlayProgressSample[] = []
  for (const s of sorted) {
    if (cur.length === 0) {
      cur.push(s)
      continue
    }
    const prev = cur[cur.length - 1]
    if (s.currSec < prev.currSec) {
      segments.push(cur)
      cur = [s]
    } else {
      cur.push(s)
    }
  }
  if (cur.length > 0) segments.push(cur)
  return segments
}

export function summarizePlayProgressSamples(samples: readonly PlayProgressSample[]): WatchSummary | null {
  const segments = splitPlayProgressSegments(samples)
  const ordered = segments.flat()
  if (ordered.length === 0) return null
  const watchedSec = segments.reduce((n, seg) => n + Math.max(seg[seg.length - 1].currSec - seg[0].currSec, 0), 0)
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  return {
    startTs: first.ts,
    endTs: last.ts,
    videoFromSec: first.currSec,
    videoToSec: last.currSec,
    videoTotalSec: last.totalSec,
    watchedSec,
  }
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
export function isDetailTitleMatch(t: string): RegExpMatchArray | null {
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

export function hasBiliVideoDetailEvidence(rawLines: { text: string }[]): boolean {
  return rawLines.some((ln) => {
    const t = ln.text.trim()
    if (!t) return false
    return !!isDetailTitleMatch(t)
      || UP_PATTERN.test(t)
      || PROGRESS_PATTERN.test(t)
      || t === '收起简介，按钮'
      || t === '展开全屏'
      || t === '返回首页按钮'
      || /^BV[A-Za-z0-9]+/.test(t)
      || /^合集\s*·/.test(t)
  })
}

export function hasBiliCommentSurfaceMarker(rawLines: { text: string }[]): boolean {
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].text.trim()
    if (t === '热门评论'
      || t === '按热度'
      || t === '评论详情'
      || /^相关回复共\d+条$/.test(t)) return true
    if (t === '评论' && /^\d+$/.test(rawLines[i + 1]?.text.trim() ?? '')) return true
  }
  return false
}

export function hasBiliFullscreenEvidence(rawLines: { text: string }[]): boolean {
  return rawLines.some((ln) => {
    const t = ln.text.trim()
    return t === '倍速' || t === '倍速调节' || t === '倍速播放中'
  })
}

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
//   "5月7日 重庆" / "2024年1月18日 福建" / "1小时前 广东" / "刚刚" / "昨天 19:19 陕西"
const COMMENT_TIME_LOC = /^(刚刚|\d+分钟前|\d+小时前|昨天|前天|\d+天前|(?:\d{4}年)?\d{1,2}月\d{1,2}日)(?:\s+\d{1,2}:\d{2})?(?:\s+\S+){0,2}$/
const COMMENT_NOISE = new Set([
  '热门评论', '按热度', '按时间', '评论详情', '回复', '相关推荐',
  '展开', '收起', '添加表情', '文本栏', '说点什么吧', '评论',
  '简介', 'UP', '不喜欢', '更多', '更多操作', '相关回复', '查看对话',
  '勇敢滴少年啊快去创造热评~', '评论千万条，等你发一条',
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
function isCommentBadgeLine(t: string): boolean {
  return t === 'UP主觉得很赞'
    || t === '红方'
    || /^已投/.test(t)
    || /^LV\d+$/i.test(t)
}

export function parseBiliComments(
  rawLines: { rowId: number; text: string; ts: number }[],
): { comments: CommentItem[]; totalCount: number | null } | null {
  // 必须有评论 surface 标识
  // 评论 surface 检测：有明确 marker，或 raw 内含 ≥ 2 个"时间地点"锚点（评论列表特征）
  // 用户滚到深处时顶部 marker 滚出视野，靠多个锚点也能判定是评论 surface
  const hasMarker = hasBiliCommentSurfaceMarker(rawLines)

  // 找 "评论 N" → totalCount（在 detail 页 tab "评论 88" 这种格式）
  // 实际抓到的是 "评论" 单行 + "88" 单行，没法精确关联。先空
  const totalCount: number | null = null

  // 用"时间地点行"作为评论锚点，向上找用户名/标签/正文，向下找点赞/回复数
  const comments: CommentItem[] = []
  // B 站评论正文都带 U+200B 零宽字符（如 "我先露个脸​"）；用户名不带
  const isBody = (t: string) => t.includes('​')
  // 评论分隔/边界信号：碰到任一种就停止向上扫，避免把非评论 raw 误归到当前评论
  // 包括：上一评论的尾巴（共N条回复 / 回复操作）、评论 surface 之外（wifi/输入栏/广告/up主行/视频信息/互动按钮）
  const isCommentBoundary = (t: string): boolean => {
    if (/^(?:UP主等人\s+)?共\d+条回复$/.test(t)) return true
    if (/^相关回复共\d+条$/.test(t)) return true
    if (t === '回复' || t === 'UP主觉得很赞') return true
    if (t === '热门评论' || t === '按热度' || t === '评论详情') return true
    if (t === '展开更多评论' || t === '展开更多，按钮') return true
    if (t.startsWith('wifi连接中')) return true
    if (t === '文本栏' || t === '添加表情' || t === '点我发弹幕' || t === '弹幕输入框') return true
    if (t === '关闭弹幕' || t === '简介' || t === '评论' || t === '点赞' || t === '不喜欢' || t === '投币' || t === '收藏' || t === '分享') return true
    if (t.startsWith('up主') && t.includes('粉丝')) return true
    if (t.startsWith('视频，') || t.startsWith('视频,') || t.startsWith('互动视频,')) return true
    if (isDetailTitleMatch(t)) return true
    if (t === '收起简介，按钮' || t === '关注up主，按钮' || t === '关注') return true
    if (PLAYS_PATTERN.test(t) || DANMAKU_PATTERN.test(t) || WATCHING_PATTERN.test(t) || PUBLISHED_PATTERN.test(t)) return true
    if (PROGRESS_PATTERN.test(t) || /^BV[A-Za-z0-9]+/.test(t)) return true
    if (/^\d+\/\d+$/.test(t)) return true
    if (t.startsWith('广告,') || t.startsWith('广告，')) return true
    if (t === '充电' || t === '已关注' || t === '取消关注，按钮' || t === 'charge icon') return true
    if (/^合集\s*·/.test(t)) return true
    if (t === '更多操作' || t === '展开更多，按钮') return true
    return false
  }
  // 找评论 surface 的起始行 — "热门评论" / "相关回复共N条" 等 marker
  // 在它之前的 raw 是视频信息 + 播放器控件，不能算 author/body 候选。
  let commentSurfaceStart = 0
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].text.trim()
    if (t === '热门评论' || t === '按热度' || t === '评论详情' || /^相关回复共\d+条$/.test(t)) {
      commentSurfaceStart = i
      break
    }
  }
  const hasBodyBeforeAnchor = (idx: number): boolean => {
    for (let j = idx - 1; j >= commentSurfaceStart; j--) {
      const t = rawLines[j].text.trim()
      if (!t) continue
      if (isCommentBoundary(t)) break
      if (isBody(t)) return true
    }
    return false
  }
  const anchors: number[] = []
  rawLines.forEach((ln, idx) => {
    if (idx < commentSurfaceStart) return
    const t = ln.text.trim()
    if (COMMENT_TIME_LOC.test(t) && hasBodyBeforeAnchor(idx)) anchors.push(idx)
  })
  // 没有明确 marker 时，至少要有两个真实评论锚点；防止视频发布日期 + 少量残留文本误判成评论区。
  if (!hasMarker && anchors.length < 2) return null

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
    const lowerBadges: string[] = []
    const nextAi = i + 1 < anchors.length ? anchors[i + 1] : rawLines.length
    for (let j = ai + 1; j < nextAi; j++) {
      const t = rawLines[j].text.trim()
      if (!t) continue
      const rcm = t.match(/^(?:UP主等人\s+)?共(\d+)条回复$/) || t.match(/^相关回复共(\d+)条$/)
      if (rcm) { replyCount = rcm[1]; continue }
      if (/^\d+$/.test(t) && t.length <= 4 && !likes) { likes = t; continue }
      if (isCommentBadgeLine(t)) lowerBadges.push(t)
    }
    if (upperLines.length === 0) continue
    // body：第一个带零宽字符的行（U+200B 是 B 站评论正文稳定特征）
    // fallback：如果没找到，取最长一行
    let bodyIdx = -1
    for (let k = upperLines.length - 1; k >= 0; k--) {
      if (isBody(upperLines[k])) { bodyIdx = k; break }
    }
    if (bodyIdx < 0) {
      bodyIdx = 0
      for (let k = 1; k < upperLines.length; k++) {
        if (upperLines[k].length > upperLines[bodyIdx].length) bodyIdx = k
      }
    }
    const body = upperLines[bodyIdx].replace(/​/g, '')
    if (body.trim().length === 0) continue
    // body 之前的行：author + badges（按 raw 顺序）
    // body 之后的行：通常没了（时间在锚点上）— 算徽章
    const before = upperLines.slice(0, bodyIdx).filter((o) => !isBody(o))
    const after = upperLines.slice(bodyIdx + 1).filter((o) => !isBody(o))
    // before 第一行 = 用户名；其他 = 徽章（LV / 已投 等短标签）
    let author: string | null = null
    const badges: string[] = []
    for (const o of before) {
      if (!author && o.length <= 30) author = o
      else badges.push(o)
    }
    for (const o of after) badges.push(o)
    for (const o of lowerBadges) badges.push(o)
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

export function parseBiliCommentDetails(
  rawLines: { rowId: number; text: string; ts: number }[],
): CommentDetailThread[] {
  const out: CommentDetailThread[] = []
  const starts: number[] = []
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].text.trim() === '评论详情') starts.push(i)
  }
  for (const start of starts) {
    let end = rawLines.length
    for (let j = start + 1; j < rawLines.length; j++) {
      const t = rawLines[j].text.trim()
      if (t === '评论详情') { end = j; break }
      // 横屏详情页会把评论详情和底层视频详情同秒抓在一起；遇到简介/评论 tab chrome 就收束。
      if (j > start + 3 && t === '简介') { end = j; break }
      if (j > start + 3 && t === '返回首页按钮') { end = j; break }
    }
    const lines = rawLines.slice(start, end)
    if (lines.length < 4) continue

    const replyMarker = lines.find((l) =>
      /^相关回复共\d+条$/.test(l.text.trim()) || /^共\d+条回复$/.test(l.text.trim()),
    )
    const replyTotal = replyMarker
      ? (replyMarker.text.trim().match(/^相关回复共(\d+)条$/)?.[1]
        ?? replyMarker.text.trim().match(/^共(\d+)条回复$/)?.[1]
        ?? null)
      : null

    const parsed = parseBiliComments(lines)
    if (!parsed || parsed.comments.length === 0) continue
    let root: CommentItem | null = null
    let replies: CommentItem[] = []
    if (replyMarker) {
      const before = parsed.comments.filter((c) => c.rowId < replyMarker.rowId)
      root = before[before.length - 1] ?? null
      replies = parsed.comments.filter((c) => c.rowId > replyMarker.rowId)
    } else {
      // 详情页滚动到中段时，根评论和 "相关回复" 标题可能已离屏；保留为回复流。
      replies = parsed.comments
    }
    if (!root && replies.length === 0) continue
    out.push({
      startTs: lines[0].ts,
      endTs: lines[lines.length - 1].ts,
      root,
      replies,
      replyTotal,
    })
  }
  return out
}

export function parseBiliCommentDetailFallback(
  rawLines: { rowId: number; text: string; ts: number }[],
  startTs: number,
  endTs: number,
): CommentDetailThread | null {
  const parsed = parseBiliComments(rawLines)
  if (!parsed || parsed.comments.length === 0) return null
  // 旧版 B 站 / 某些浮层下，进入详情只抓到一次 "评论详情"，
  // 随后几秒只有评论正文，没有详情 marker。用户点击的楼层通常是
  // 进入前可见列表里最后一个带回复数的评论；没有回复数时取最后一条。
  const withReplies = parsed.comments.filter((c) => c.replyCount)
  const root = withReplies[withReplies.length - 1] ?? parsed.comments[parsed.comments.length - 1] ?? null
  if (!root) return null
  return {
    startTs,
    endTs: rawLines.length > 0 ? Math.max(endTs, rawLines[rawLines.length - 1].ts) : endTs,
    root,
    replies: [],
    replyTotal: root.replyCount,
  }
}

// "合集 · AI编程-2026" + 下一行 "246/248"
const COLLECTION_PATTERN = /^合集\s*·\s*(.+)$/
const COLLECTION_PROGRESS_PATTERN = /^(\d+\/\d+)$/
// "00:06/37:30" 播放进度
export const PROGRESS_PATTERN = /^(\d{1,2}):(\d{2})\/(\d{1,3}):(\d{2})$/

// Story 卡片块的 a11y 树结构（按观察）：
//   1. UP 名（短独立行）
//   2. N粉丝（"\d+(\.\d+)?[万亿千百]?粉丝"）
//   3. 标题 + 播放数（"标题  ‎N播放" 或 "标题  ‎N播放  创作推广/广告"）
//   4. (可选) tag 行（"搜索·..." / "热搜·..." / "合集 · ..."）
//   5. 5 个互动数字（点赞/评论/投币/收藏/分享 — 顺序固定）
//   6. "发弹幕" 收尾
export const STORY_FANS = /^([\d.]+[万亿千百]?)粉丝$/
// 标题尾部：双空格 + U+200E + N播放（可选后跟 "创作推广" 或 "广告" 等推广标）
export const STORY_TITLE_TAIL = /\s{2,}‎?([\d.]+[万亿千百]?播放)(?:\s+(创作推广|广告))?$/
const STORY_COMMENT_HEADER = /^评论[（(]([\d.万亿千百]+)[）)]$/
// 用一组 5 个数字 + 发弹幕 锁定一个完整 story item 块
function isStoryFans(t: string): boolean { return STORY_FANS.test(t) }
function isPlayCountLine(t: string): RegExpMatchArray | null {
  const m = t.match(STORY_TITLE_TAIL)
  return m
}
export function findStoryCommentCount(rawLines: { text: string }[]): string | null {
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
export function parseStoryItems(rawLines: { rowId: number; text: string; ts: number }[]): StoryItem[] {
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

export function parseBiliVideoDetail(rawLines: { rowId: number; text: string; ts: number }[]): BiliVideoDetail | null {
  const v: BiliVideoDetail = {
    title: null, kindLabel: null, upName: null, upFans: null, upVideoCount: null,
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
        v.kindLabel = titleM[1].trim()
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
    const prog = parseBiliPlayProgressSample(ln.ts, t)
    if (prog) {
      // 同 ts 内不重复 push
      const lastP = v.playProgress[v.playProgress.length - 1]
      if (!lastP || lastP.ts !== ln.ts) {
        v.playProgress.push(prog)
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

export function parseBiliFeedItem(rowId: number, ts: number, raw: string): BiliFeedItem | null {
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
  // 首页顶部大图经常没有 UP 主字段；它仍是视频，不是横幅广告。
  if (kind === '视频' && !upName) kind = '大卡视频'
  return { rowId, ts, kind, title, upName, views, danmaku, duration, followed, raw }
}

export const BILI_ACCENT = '#FB7299'

export function buildBiliFeedListItems(itemsIn: TorrentCapture[]): ListItem[] {
  // items 从 native 来是 ORDER BY id DESC（新→旧），按时间序处理前先排成 ASC
  const items = [...itemsIn].sort((a, b) => a.rowId - b.rowId)
  const storyRaw = items.filter((c) =>
    c.packageName === BILI_PACKAGE
    && c.captureType !== 'a11y-click'
    && c.windowClass.includes('StoryVideoActivity'))
  const storyAllLines = storyRaw.map((c) => ({ rowId: c.rowId, text: c.text, ts: c.eventTimeMs }))
  const allStoryItems = parseStoryItems(storyAllLines)
  const storyCandidatesByCommentCount = new Map<string, StoryItem[]>()
  for (const it of allStoryItems) {
    if (it.comments) {
      const arr = storyCandidatesByCommentCount.get(it.comments)
      if (arr) arr.push(it)
      else storyCandidatesByCommentCount.set(it.comments, [it])
    }
  }
  const pickStoryByCommentCount = (count: string, ts: number, currentTitle: string | null): StoryItem | null => {
    const candidates = storyCandidatesByCommentCount.get(count) ?? []
    if (candidates.length === 0) return null
    const byTitle = new Map<string, { item: StoryItem; dist: number }>()
    for (const it of candidates) {
      const dist = Math.abs(it.firstSeenTs - ts)
      const prev = byTitle.get(it.title)
      if (!prev || dist < prev.dist) byTitle.set(it.title, { item: it, dist })
    }
    if (currentTitle) {
      const current = byTitle.get(currentTitle)
      if (current && current.dist <= 30_000) return current.item
    }
    const ranked = Array.from(byTitle.values()).sort((a, b) => a.dist - b.dist)
    const best = ranked[0]
    if (!best) return null
    if (ranked.length === 1 && best.dist <= 120_000) return best.item
    const second = ranked[1]
    if (best.dist <= 30_000 && (!second || best.dist + 1000 < second.dist)) return best.item
    return null
  }
  // pre-pass：收 feed item title 集合，避免 banner 识别误抓 feed item 的标题独立行
  const feedTitlesInHome = new Set<string>()
  for (const c of items) {
    if (c.packageName !== BILI_PACKAGE) continue
    if (!isA11ySnapshotCapture(c.captureType)) continue
    const p = parseBiliFeedItem(c.rowId, c.eventTimeMs, c.text)
    if (p) feedTitlesInHome.add(p.title)
  }
  // 1a) 按秒分组 home feed items
  const homeSubs: SubGroup[] = []
  const detailSurfaceSecs = new Set<number>()
  const biliLinesBySec = new Map<number, { rowId: number; text: string }[]>()
  for (const c of items) {
    if (c.packageName !== BILI_PACKAGE) continue
    if (!isA11ySnapshotCapture(c.captureType)) continue
    const sec = Math.floor(c.eventTimeMs / 1000)
    const lines = biliLinesBySec.get(sec)
    if (lines) lines.push({ rowId: c.rowId, text: c.text })
    else biliLinesBySec.set(sec, [{ rowId: c.rowId, text: c.text }])
  }
  for (const [sec, lines] of biliLinesBySec) {
    if (hasBiliVideoDetailEvidence(lines)) detailSurfaceSecs.add(sec)
  }
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
  const isHomeSurface = (wc: string, sec: number): boolean => {
    if (wc.includes('UnitedBiz') || wc.includes('StoryVideo')) return false
    // ViewGroup 是 detail 内部 fullscreen/评论的 windowClass，不算 home
    if (wc.includes('MainActivityV2')) return true
    // android.widget.ScrollView 同时会出现在 B 站详情页展开简介/相关推荐里；
    // 同秒已有详情证据时不能当主页，否则会把视频详情误还原成主页。
    if (wc.endsWith('ScrollView')) return !detailSurfaceSecs.has(sec)
    return false
  }
  for (const c of items) {
    if (c.packageName !== BILI_PACKAGE) continue
    if (!isA11ySnapshotCapture(c.captureType)) continue
    if (!isHomeSurface(c.windowClass, Math.floor(c.eventTimeMs / 1000))) continue
    const parsed = parseBiliFeedItem(c.rowId, c.eventTimeMs, c.text)
    if (parsed && (parsed.kind === '视频' || parsed.kind === '竖版视频' || parsed.kind === '大卡视频' || parsed.kind === '横幅视频')) {
      pushHomeItem(c, parsed)
      continue
    }
    const t = c.text.trim()
    if (isBannerCandidate(t) && !feedTitlesInHome.has(t)) {
      const secLines = biliLinesBySec.get(Math.floor(c.eventTimeMs / 1000)) ?? []
      const looseVideo = parseLooseHomeVideoItem(c.rowId, c.eventTimeMs, t, secLines)
      if (looseVideo) {
        pushHomeItem(c, looseVideo)
        continue
      }
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
    if (c.packageName !== BILI_PACKAGE) continue
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
    const storyByCount: StoryItem | null = storyCommentCount ? pickStoryByCommentCount(storyCommentCount, b.ts, recentVideoTitle) : null
    if (storyByCount) {
      recentVideoTitle = storyByCount.title
      recentVideoUp = storyByCount.upName
    }
    const commentDetails = parseBiliCommentDetails(b.lines)
    const cm = parseBiliComments(b.lines)
    if (cm && commentDetails.length === 0) {
      commentItems.push({
        kind: 'comments', key: `c-${b.ts}`, tsStart: b.ts, tsEnd: b.ts,
        comments: cm.comments, totalCount: cm.totalCount,
        videoTitle: recentVideoTitle, videoUp: recentVideoUp,
        commentDetailSegs: [], commentDetails: [],
      })
    } else if (commentDetails.length > 0) {
      commentItems.push({
        kind: 'comments', key: `cd-${b.ts}`, tsStart: b.ts, tsEnd: b.ts,
        comments: [], totalCount: null,
        videoTitle: recentVideoTitle, videoUp: recentVideoUp,
        commentDetailSegs: [], commentDetails,
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
  const mergeCommentDetail = (target: Extract<ListItem, { kind: 'comments' }>, detail: CommentDetailThread) => {
    const rootKey = detail.root?.body ?? null
    let existing = rootKey
      ? target.commentDetails.find((d) => d.root?.body === rootKey)
      : target.commentDetails[target.commentDetails.length - 1]
    if (!existing || (!rootKey && detail.startTs - existing.endTs > 15_000)) {
      target.commentDetails.push({
        ...detail,
        replies: [...detail.replies],
      })
      return
    }
    existing.startTs = Math.min(existing.startTs, detail.startTs)
    existing.endTs = Math.max(existing.endTs, detail.endTs)
    if (!existing.root && detail.root) existing.root = detail.root
    if (!existing.replyTotal && detail.replyTotal) existing.replyTotal = detail.replyTotal
    const seenReplies = new Set(existing.replies.map((r) => `${r.author ?? ''}|${r.body}|${r.timeLocation}`))
    for (const r of detail.replies) {
      const key = `${r.author ?? ''}|${r.body}|${r.timeLocation}`
      if (!seenReplies.has(key)) {
        existing.replies.push(r)
        seenReplies.add(key)
      }
    }
  }
  for (const ci of commentItems) {
    if (ci.kind !== 'comments') continue
    const key = ci.videoTitle ?? '__no_video__'
    let existing = byVideo.get(key)
    if (!existing) {
      // 首次：建空壳，下面统一去重 push
      existing = { ...ci, comments: [], commentDetails: [] }
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
    for (const detail of ci.commentDetails) mergeCommentDetail(existing, detail)
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
      if (ds.detail.kindLabel && !last.detail.kindLabel) last.detail.kindLabel = ds.detail.kindLabel
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
  for (const d of detailOnly) {
    if (!d.detail.title) continue
    for (const c of items) {
      if (c.packageName !== BILI_PACKAGE) continue
      if (c.eventTimeMs < d.tsStart - 5_000 || c.eventTimeMs >= d.tsStart) continue
      const m = isDetailTitleMatch(c.text.trim())
      if (m && m[2].trim() === d.detail.title) {
        d.tsStart = c.eventTimeMs
        break
      }
    }
  }
  for (const c of items) {
    if (c.packageName !== BILI_PACKAGE) continue
    const t = c.text.trim()
    const prog = parseBiliPlayProgressSample(c.eventTimeMs, t)
    if (!prog) continue
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
    target.detail.playProgress.push(prog)
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
    if (c.packageName !== BILI_PACKAGE) continue
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
  const actionItems = buildBiliActionListItems(itemsIn)
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
          const summary = summarizePlayProgressSamples(card.samples)
          if (summary) card.watch = summary
        }
      }
      if (seg.tab === 'comment_detail') {
        const target = mergedCommentItems.find((x): x is Extract<ListItem, { kind: 'comments' }> =>
          x.kind === 'comments' && x.videoTitle === (ai.title ?? null),
        )
        if (target) {
          target.commentDetailSegs.push({ startTs: seg.startTs, endTs: seg.endTs })
          const detailWindowLines = items
            .filter((c) =>
              c.packageName === BILI_PACKAGE
              && c.captureType !== 'a11y-click'
              && c.eventTimeMs >= seg.startTs
              && c.eventTimeMs <= seg.endTs + 5_000)
            .map((c) => ({ rowId: c.rowId, text: c.text, ts: c.eventTimeMs }))
          const parsedDetails = parseBiliCommentDetails(detailWindowLines)
          if (parsedDetails.length > 0) {
            for (const detail of parsedDetails) mergeCommentDetail(target, detail)
          } else {
            const fallback = parseBiliCommentDetailFallback(detailWindowLines, seg.startTs, seg.endTs)
            if (fallback) mergeCommentDetail(target, fallback)
          }
          target.tsStart = Math.min(target.tsStart, seg.startTs)
          target.tsEnd = Math.max(target.tsEnd, seg.endTs, detailWindowLines[detailWindowLines.length - 1]?.ts ?? seg.endTs)
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
export function buildBiliActionListItems(itemsIn: TorrentCapture[]): ListItem[] {
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
  type ActionBucketLine = { rowId: number; text: string; ts: number; windowClass: string; packageName: string }
  type EvSig = { ts: number; rowId: number; windowClass: string; packageName: string; sig: { kind: BiliActionKind; title?: string; upName?: string; meta?: string } }
  let events: EvSig[] = []
  const secondBuckets = new Map<number, { ts: number; rowId: number; windowClass: string; packageName: string; lines: ActionBucketLine[] }>()
  const ctx = { upName: null as string | null, title: null as string | null }
  // Story raw 上下文：上一行 UP 名 + 当前行粉丝 = 锁定 ctx.upName
  // 下一行（含 STORY_TITLE_TAIL）= 锁定 ctx.title
  let prevStoryText = ''
  for (const c of items) {
    if (c.packageName !== BILI_PACKAGE) continue
    const t = c.text.trim()
    if (isA11ySnapshotCapture(c.captureType)) {
      const sec = Math.floor(c.eventTimeMs / 1000)
      const existing = secondBuckets.get(sec)
      const line = { rowId: c.rowId, text: c.text, ts: c.eventTimeMs, windowClass: c.windowClass, packageName: c.packageName }
      if (existing) {
        existing.lines.push(line)
        if (c.rowId < existing.rowId) {
          existing.rowId = c.rowId
          existing.ts = c.eventTimeMs
          existing.windowClass = c.windowClass
          existing.packageName = c.packageName
        }
      } else {
        secondBuckets.set(sec, { ts: c.eventTimeMs, rowId: c.rowId, windowClass: c.windowClass, packageName: c.packageName, lines: [line] })
      }
    }
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
    events.push({ ts: c.eventTimeMs, rowId: c.rowId, windowClass: c.windowClass, packageName: c.packageName, sig })
  }

  const SUB_TAB_KINDS = new Set<BiliActionKind>(['fullscreen', 'comments', 'comment_detail'])
  const kindToSubTab: Record<string, VideoSubTab> = {
    fullscreen: 'fullscreen', comments: 'comments', comment_detail: 'comment_detail',
  }
  const eventSec = (ts: number) => Math.floor(ts / 1000)
  const ACTION_MERGE_GAP_MS = 60_000
  const actionDetailSurfaceSecs = new Set<number>()
  for (const [sec, b] of secondBuckets) {
    if (hasBiliVideoDetailEvidence(b.lines)) actionDetailSurfaceSecs.add(sec)
  }
  events = events.filter((e) =>
    !(e.sig.kind === 'home' && e.windowClass.endsWith('ScrollView') && actionDetailSurfaceSecs.has(eventSec(e.ts))))
  const existingSubTabSecKind = new Set(events
    .filter((e) => SUB_TAB_KINDS.has(e.sig.kind))
    .map((e) => `${eventSec(e.ts)}:${e.sig.kind}`))
  const subTabKindBySec = new Map<number, BiliActionKind>()
  for (const [sec, b] of secondBuckets) {
    let kind: BiliActionKind | null = null
    const hasDetailEvidence = actionDetailSurfaceSecs.has(sec)
    if (parseBiliCommentDetails(b.lines).length > 0) kind = 'comment_detail'
    else if ((!hasDetailEvidence || hasBiliCommentSurfaceMarker(b.lines)) && parseBiliComments(b.lines)) kind = 'comments'
    else if (hasBiliFullscreenEvidence(b.lines)) kind = 'fullscreen'
    if (!kind) continue
    subTabKindBySec.set(sec, kind)
    const key = `${sec}:${kind}`
    if (!existingSubTabSecKind.has(key)) {
      events.push({ ts: b.ts, rowId: b.rowId, windowClass: b.windowClass, packageName: b.packageName, sig: { kind } })
      existingSubTabSecKind.add(key)
    }
  }
  // 同一秒 a11y 树常同时包含视频头部和评论列表/全屏控件；此时后续 poll 里的 up 主行
  // 只是父页面残留，不能反复当成"切回简介"。但首次进入视频时也可能同秒混入评论列表，
  // 不能一刀切删掉 video_intro，否则会漏掉开头的视频播放界面。
  events = events.sort((a, b) => a.rowId - b.rowId)
  const recentIntroByUp = new Map<string, number>()
  events = events.filter((e) => {
    if (e.sig.kind !== 'video_intro') return true
    const up = e.sig.upName
    if (!up) return true
    const recentTs = recentIntroByUp.get(up)
    recentIntroByUp.set(up, e.ts)
    return !(subTabKindBySec.has(eventSec(e.ts)) && recentTs != null && e.ts - recentTs < ACTION_MERGE_GAP_MS)
  })

  type Cur = {
    startTs: number; endTs: number;
    kind: BiliActionKind;
    title?: string; upName?: string; meta?: string;
    packageName?: string; appLabel?: string;
    tabSeq?: VideoSubTabSeg[]  // 仅 video_intro 用：界面内 tab 切换序列
    isStory?: boolean          // 仅 video_intro 用：是否 Story 竖屏视频
    storyCommentCount?: string | null
  }
  const acts: Cur[] = []

  // Pass 2：splash 段独立识别。只按临近倒计时合段；detail/Launcher 里的"跳过 5"不是开屏。
  const splashSegments: { startTs: number; endTs: number; packageName: string }[] = []
  const isSplashSurface = (wc: string): boolean =>
    wc === 'android.widget.FrameLayout'
    || wc.includes('MainActivityV2')
    || wc.includes('UnitedBiz')
    || wc.endsWith('ScrollView')
  const hasSplashContext = (e: EvSig): boolean => {
    const sec = eventSec(e.ts)
    if (actionDetailSurfaceSecs.has(sec)) return false
    const lines = secondBuckets.get(sec)?.lines ?? []
    const hasSkip = lines.some((l) => /^跳过\s*\d+$/.test(l.text.trim()))
    const hasAdCue = lines.some((l) => {
      const t = l.text.trim()
      return t === '广告' || t === '扭一扭' || t === '进入淘宝app'
    })
    return hasSkip && (hasAdCue || e.windowClass === 'android.widget.FrameLayout' || e.windowClass.includes('MainActivityV2'))
  }
  const splashEvs = events.filter((e) =>
    e.sig.kind === 'splash'
    && isSplashSurface(e.windowClass)
    && hasSplashContext(e))
  for (const e of splashEvs) {
    const last = splashSegments[splashSegments.length - 1]
    if (last && e.ts - last.endTs < 15_000) last.endTs = e.ts
    else splashSegments.push({ startTs: e.ts, endTs: e.ts, packageName: e.packageName })
  }
  for (const s of splashSegments) {
    acts.push({
      startTs: s.startTs,
      endTs: s.endTs,
      kind: 'splash',
      packageName: s.packageName,
      appLabel: getBiliPackageLabel(s.packageName),
    })
  }
  const isDuringSplash = (ts: number) => splashSegments.some((s) => ts >= s.startTs && ts <= s.endTs + 1_000)

  // Pass 3：剩余 signals
  // 关键变化：fullscreen/comments/comment_detail 都是 video_intro 父动作下的"界面内 tab 切换"
  // 不再独立成动作行，而是吸收为 video_intro 的 tabSeq 子段。
  // 评论详情虽然是新页面，但属于"在这个视频上的延伸操作"，仍归 video_intro。
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
    if (e.sig.kind === 'home' && isDuringSplash(e.ts)) continue
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
    cur = {
      startTs: e.ts,
      endTs: e.ts,
      kind: sig.kind,
      title: sig.title,
      upName: sig.upName,
      packageName: e.packageName,
      appLabel: getBiliPackageLabel(e.packageName),
    }
  }
  if (cur) acts.push(cur)

  // Pass 3.6：Story 竖屏 video_intro 单独识别
  // Story 段 raw 每秒同时抓到当前 + 相邻预加载视频，不能把所有 title 都当成进入动作。
  // 用评论浮层的 "评论（N）" 做强证据；两个强证据标题夹住的中间标题视作划过；
  // 没有强证据的 Story 段，只取每段首个主块，避免同秒预加载导致成对重复。
  const parsedStoryItems = parseStoryItems(items
    .filter((c) => c.packageName === BILI_PACKAGE && c.windowClass.includes('StoryVideoActivity'))
    .map((c) => ({ rowId: c.rowId, text: c.text, ts: c.eventTimeMs })))
  const storyMetaByTitle = new Map<string, StoryItem>()
  for (const it of parsedStoryItems) {
    if (!storyMetaByTitle.has(it.title)) storyMetaByTitle.set(it.title, it)
  }
  type StorySecond = { sec: number; ts: number; titles: string[] }
  const storySecs = new Map<number, { ts: number; lines: { rowId: number; text: string; ts: number }[] }>()
  for (const c of items) {
    if (c.packageName !== BILI_PACKAGE) continue
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

  const storyCandidatesByCommentCount = new Map<string, StoryItem[]>()
  for (const it of parsedStoryItems) {
    if (it.comments) {
      const arr = storyCandidatesByCommentCount.get(it.comments)
      if (arr) arr.push(it)
      else storyCandidatesByCommentCount.set(it.comments, [it])
    }
  }
  const pickStoryTitleByCommentCount = (count: string, ts: number): string | null => {
    const candidates = storyCandidatesByCommentCount.get(count) ?? []
    if (candidates.length === 0) return null
    const candidateTitles = new Set(candidates.map((it) => it.title))
    const priorSecs = storySeconds
      .filter((s) => s.ts <= ts && ts - s.ts <= 30_000)
      .sort((a, b) => b.ts - a.ts)
    for (const s of priorSecs) {
      const title = s.titles.find((t) => candidateTitles.has(t))
      if (title) return title
    }
    const byTitle = new Map<string, { title: string; dist: number }>()
    for (const it of candidates) {
      const dist = Math.abs(it.firstSeenTs - ts)
      const prev = byTitle.get(it.title)
      if (!prev || dist < prev.dist) byTitle.set(it.title, { title: it.title, dist })
    }
    const ranked = Array.from(byTitle.values()).sort((a, b) => a.dist - b.dist)
    const best = ranked[0]
    if (!best) return null
    if (ranked.length === 1 && best.dist <= 120_000) return best.title
    const second = ranked[1]
    if (best.dist <= 30_000 && (!second || best.dist + 1000 < second.dist)) return best.title
    return null
  }
  const commentProofs: { count: string; title: string; firstTs: number; lastTs: number }[] = []
  const storyCommentCountBySec = new Map<number, string>()
  const storyTitleByCommentSec = new Map<number, string>()
  for (const c of items) {
    if (c.packageName !== BILI_PACKAGE) continue
    if (!c.windowClass.includes('bilibili.video.story.view')) continue
    const count = findStoryCommentCount([{ text: c.text }])
    if (!count) continue
    const title = pickStoryTitleByCommentCount(count, c.eventTimeMs)
    if (!title) continue
    const sec = Math.floor(c.eventTimeMs / 1000)
    storyCommentCountBySec.set(sec, count)
    storyTitleByCommentSec.set(sec, title)
    const lastProof = commentProofs[commentProofs.length - 1]
    if (lastProof && lastProof.count === count && lastProof.title === title && c.eventTimeMs - lastProof.lastTs < 10_000) {
      lastProof.lastTs = c.eventTimeMs
    } else {
      commentProofs.push({ count, title, firstTs: c.eventTimeMs, lastTs: c.eventTimeMs })
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
      packageName: BILI_PACKAGE,
      appLabel: getBiliPackageLabel(BILI_PACKAGE),
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
    const sec = Math.floor(e.ts / 1000)
    const title = storyTitleByCommentSec.get(sec)
    const count = storyCommentCountBySec.get(sec)
    let target: Cur | undefined
    if (title) {
      for (const v of storyVideoActs) {
        if (v.title === title && e.ts >= v.startTs && (!target || v.startTs > target.startTs)) {
          target = v
        }
      }
    }
    if (!target && count) {
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
      if (c.packageName !== BILI_PACKAGE) continue
      if (c.eventTimeMs < va.startTs || c.eventTimeMs > va.endTs) continue
      const m = isDetailTitleMatch(c.text.trim())
      if (m) { va.title = m[2].trim(); break }
    }
  }
  for (const va of acts.filter((a) => a.kind === 'video_intro' && !a.isStory && a.title)) {
    let startTs = va.startTs
    for (const c of items) {
      if (c.packageName !== BILI_PACKAGE) continue
      if (c.eventTimeMs < va.startTs - 5_000 || c.eventTimeMs >= va.startTs) continue
      if (isDuringSplash(c.eventTimeMs)) continue
      const m = isDetailTitleMatch(c.text.trim())
      if (m && m[2].trim() === va.title) {
        startTs = c.eventTimeMs
        break
      }
    }
    if (startTs < va.startTs) {
      va.startTs = startTs
      if (va.tabSeq?.[0]?.tab === 'intro') {
        va.tabSeq[0].startTs = startTs
        va.tabSeq[0].endTs = Math.max(va.tabSeq[0].endTs, startTs)
      }
    }
  }
  // Pass 3.6：从上一个视频的相关推荐进入下一个视频。
  // 关键证据是：新 video_intro 出现前几秒，detail-like surface 里出现了同标题的 feed item。
  for (const va of acts.filter((a) => a.kind === 'video_intro' && !a.isStory && a.title)) {
    const fromRelated = items.some((c) => {
      if (c.packageName !== BILI_PACKAGE) return false
      if (c.eventTimeMs < va.startTs - 15_000 || c.eventTimeMs >= va.startTs) return false
      const wc = c.windowClass
      const isDetailLike = wc.includes('UnitedBiz') || wc.includes('StoryVideo') || wc === 'android.view.ViewGroup'
      if (!isDetailLike) return false
      const parsed = parseBiliFeedItem(c.rowId, c.eventTimeMs, c.text)
      return !!parsed && parsed.title === va.title && (parsed.kind === '视频' || parsed.kind === '竖版视频')
    })
    if (fromRelated && !(va.meta ?? '').includes('来自推荐列表')) {
      va.meta = va.meta ? `${va.meta} · 来自推荐列表` : '来自推荐列表'
    }
  }

  // Pass 4：播放进度只在全屏（SeekBar）期采样
  // B 站全屏刚进入时经常只暴露 SeekBar 进度，不暴露 "倍速" 控件；
  // 后续用户轻触出现控制条时才抓到 "倍速"。用首次 fullscreen 信号前的
  // 临近进度采样回填子段起点，避免漏掉真正开始的几秒。
  // 归属到 video_intro.tabSeq 内的 fullscreen 子段（按 startTs~endTs 范围匹配）
  const videoActs = acts.filter((a) => a.kind === 'video_intro')
  const FULLSCREEN_BACKFILL_MS = 15_000
  for (const va of videoActs) {
    if (!va.tabSeq) continue
    for (let i = 0; i < va.tabSeq.length; i++) {
      const seg = va.tabSeq[i]
      if (seg.tab !== 'fullscreen') continue
      let lastPreControlProgressTs: number | null = null
      for (const c of items) {
        if (c.packageName !== BILI_PACKAGE) continue
        if (c.eventTimeMs < va.startTs || c.eventTimeMs >= seg.startTs) continue
        if (seg.startTs - c.eventTimeMs > FULLSCREEN_BACKFILL_MS) continue
        if (!PROGRESS_PATTERN.test(c.text.trim())) continue
        if (lastPreControlProgressTs == null || c.eventTimeMs > lastPreControlProgressTs) {
          lastPreControlProgressTs = c.eventTimeMs
        }
      }
      if (lastPreControlProgressTs != null && lastPreControlProgressTs < seg.startTs) {
        seg.startTs = lastPreControlProgressTs
        const prev = va.tabSeq[i - 1]
        if (prev && prev.endTs > seg.startTs) prev.endTs = seg.startTs
      }
      const samples: PlayProgressSample[] = []
      for (const c of items) {
        if (c.packageName !== BILI_PACKAGE) continue
        if (c.eventTimeMs < seg.startTs || c.eventTimeMs > seg.endTs) continue
        const sample = parseBiliPlayProgressSample(c.eventTimeMs, c.text)
        if (!sample) continue
        const last = samples[samples.length - 1]
        if (last && last.ts === c.eventTimeMs) continue
        samples.push(sample)
      }
      if (samples.length === 0) continue
      seg.watchSamples = samples
      const summary = summarizePlayProgressSamples(samples)
      if (summary) seg.watch = summary
    }
  }

  for (const a of acts) {
    if (!a.tabSeq) continue
    for (const seg of a.tabSeq) {
      seg.displayDurationSec = seg.tab === 'fullscreen' && seg.watch
        ? seg.watch.watchedSec
        : Math.round((seg.endTs - seg.startTs) / 1000)
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
    packageName: a.packageName,
    appLabel: a.appLabel,
  })).reverse()
}

type BiliCardItem = Extract<ListItem, { kind: 'home' | 'detail' | 'story' | 'comments' | 'fullscreen' }>

function actionPayload(item: Extract<ListItem, { kind: 'actionLine' }>): Record<string, unknown> {
  return {
    act: item.act,
    title: item.title,
    upName: item.upName,
    meta: item.meta,
    tabSeq: item.tabSeq,
    isStory: item.isStory,
  }
}

function cardTitle(item: BiliCardItem): string | undefined {
  if (item.kind === 'detail') return item.detail.title ?? undefined
  if (item.kind === 'story') return item.story.title
  if (item.kind === 'comments') return item.videoTitle ?? undefined
  if (item.kind === 'fullscreen') return item.videoTitle ?? undefined
  if (item.kind === 'home') return 'B 站主页'
  return undefined
}

function cardUpName(item: BiliCardItem): string | undefined {
  if (item.kind === 'detail') return item.detail.upName ?? undefined
  if (item.kind === 'story') return item.story.upName
  if (item.kind === 'comments') return item.videoUp ?? undefined
  if (item.kind === 'fullscreen') return item.videoUp ?? undefined
  return undefined
}

function cardPayload(item: BiliCardItem): Record<string, unknown> {
  if (item.kind === 'home') {
    return {
      kind: item.kind,
      sweepCount: item.sweepCount,
      feedItems: item.feedItems,
    }
  }
  if (item.kind === 'detail') return { kind: item.kind, detail: item.detail }
  if (item.kind === 'story') return { kind: item.kind, story: item.story }
  if (item.kind === 'comments') {
    return {
      kind: item.kind,
      totalCount: item.totalCount,
      videoTitle: item.videoTitle,
      videoUp: item.videoUp,
      comments: item.comments,
      commentDetailSegs: item.commentDetailSegs,
      commentDetails: item.commentDetails,
    }
  }
  return {
    kind: item.kind,
    watch: item.watch,
    videoTitle: item.videoTitle,
    videoUp: item.videoUp,
    samples: item.samples,
  }
}

export function buildBiliFormalActionDrafts(itemsIn: TorrentCapture[]): TorrentFormalActionDraft[] {
  return buildBiliActionListItems(itemsIn)
    .filter((item): item is Extract<ListItem, { kind: 'actionLine' }> => item.kind === 'actionLine')
    .map((item) => ({
      parserId: BILI_PARSER_ID,
      parserVersion: BILI_PARSER_VERSION,
      key: item.key,
      packageName: item.packageName ?? BILI_PACKAGE,
      appLabel: item.appLabel ?? BILI_APP_LABEL,
      kind: item.act,
      startTs: item.ts,
      endTs: item.endTs ?? item.ts,
      title: item.title,
      upName: item.upName,
      isStory: item.isStory,
      payload: actionPayload(item),
      sourceRefs: sourceRefsInRange(itemsIn, item.ts, item.endTs ?? item.ts),
    }))
}

export function buildBiliFormalCardDrafts(itemsIn: TorrentCapture[]): TorrentFormalCardDraft[] {
  return buildBiliFeedListItems(itemsIn)
    .filter((item): item is BiliCardItem =>
      item.kind === 'home'
      || item.kind === 'detail'
      || item.kind === 'story'
      || item.kind === 'comments'
      || item.kind === 'fullscreen')
    .map((item) => ({
      parserId: BILI_PARSER_ID,
      parserVersion: BILI_PARSER_VERSION,
      key: item.key,
      packageName: BILI_PACKAGE,
      appLabel: BILI_APP_LABEL,
      cardKind: item.kind,
      startTs: item.tsStart,
      endTs: item.tsEnd,
      title: cardTitle(item),
      upName: cardUpName(item),
      payload: cardPayload(item),
      sourceRefs: sourceRefsInRange(itemsIn, item.tsStart, item.tsEnd),
    }))
}

export const bilibiliTorrentParser: TorrentParserModule<ListItem> = {
  id: BILI_PARSER_ID,
  version: BILI_PARSER_VERSION,
  displayName: BILI_APP_LABEL,
  packages: [BILI_PACKAGE],
  accent: BILI_ACCENT,
  canParse: (item) => item.packageName === BILI_PACKAGE,
  getPackageLabel: getBiliPackageLabel,
  buildFeedListItems: buildBiliFeedListItems,
  buildActionListItems: buildBiliActionListItems,
  buildFormalActions: buildBiliFormalActionDrafts,
  buildFormalCards: buildBiliFormalCardDrafts,
}
