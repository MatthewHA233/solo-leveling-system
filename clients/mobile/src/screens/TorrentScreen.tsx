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

const PACKAGE_LABEL: Record<string, string> = {
  'tv.danmaku.bili': 'B 站',
}

type ViewMode = 'raw' | 'feed'

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
  description: string | null  // 简介摘要
  isInteractive: boolean      // 是否互动视频
  promos: { kind: string; text: string }[]  // 条形推送（"广告" / "会员购" / 无标识 等）
  related: BiliFeedItem[]     // 主视频下方相关推荐列表
}

// title 允许全角逗号（中文标题常用），只禁止半角逗号（avoid 与 "视频,标题,UP主xxx,..." home feed 冲突）
const TITLE_PATTERN = /^(互动视频|视频|竖版视频), ([^,]+)$/
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
  const hasMarker = texts.some((t) => t === '热门评论' || t === '评论详情' || t === '按热度')
  if (!hasMarker) return null

  // 找 "评论 N" → totalCount（在 detail 页 tab "评论 88" 这种格式）
  // 实际抓到的是 "评论" 单行 + "88" 单行，没法精确关联。先空
  const totalCount: number | null = null

  // 用"时间地点行"作为评论锚点，向上找用户名/标签/正文，向下找点赞/回复数
  const comments: CommentItem[] = []
  const anchors: number[] = []
  rawLines.forEach((ln, idx) => {
    if (COMMENT_TIME_LOC.test(ln.text.trim())) anchors.push(idx)
  })
  for (let i = 0; i < anchors.length; i++) {
    const ai = anchors[i]
    const prevAi = i > 0 ? anchors[i - 1] : -1
    // 上方非噪音文本：用户名 + 标签 + 正文
    const upperLines: string[] = []
    for (let j = ai - 1; j > prevAi; j--) {
      const t = rawLines[j].text.trim()
      if (!t) continue
      if (isCommentNoise(t)) continue
      // 跳过 CD.XXXX（数字楼层）
      if (/^\d+$/.test(t) && t.length >= 5) continue  // CD ID 一般 5-7 位
      upperLines.unshift(t)
    }
    // 下方：找点赞数（数字 ≤ 4 位）和 共N条回复
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
    // 把 upperLines 中最长的当正文，其他短的当 author/badges
    if (upperLines.length === 0) continue
    // 找最长一行作为 body
    let bodyIdx = 0
    for (let k = 1; k < upperLines.length; k++) {
      if (upperLines[k].length > upperLines[bodyIdx].length) bodyIdx = k
    }
    const body = upperLines[bodyIdx]
    const others = upperLines.filter((_, k) => k !== bodyIdx)
    // 第一行通常是用户名（短）；其他短的是徽章
    let author: string | null = null
    const badges: string[] = []
    for (const o of others) {
      if (!author && o.length <= 30 && !o.startsWith('已投') && !o.includes('LV')) {
        author = o
      } else {
        badges.push(o)
      }
    }
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

function parseBiliVideoDetail(rawLines: { rowId: number; text: string; ts: number }[]): BiliVideoDetail | null {
  const v: BiliVideoDetail = {
    title: null, upName: null, upFans: null, upVideoCount: null,
    duration: null, views: null, danmaku: null, publishedAt: null,
    watchingNow: null, likes: null, coins: null, favorites: null,
    shares: null, category: null, description: null, isInteractive: false,
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
    // 主视频标题：只 1 个半角逗号 + 不含其他半角逗号（中文逗号 OK）
    if (!v.title) {
      const titleM = t.match(TITLE_PATTERN)
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

export default function TorrentScreen() {
  const [items, setItems] = useState<TorrentCapture[]>([])
  const [total, setTotal] = useState(0)
  const [a11yOn, setA11yOn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('feed')
  const liveRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      // 默认拉 5000 条（约几天数据）；FlatList virtualize 只渲染可见区，
      // 几千万条理论也不卡（实际需求加 cursor 分页再说）
      const [list, n, on] = await Promise.all([
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
  }, [])

  useEffect(() => {
    liveRef.current = true
    refresh()
    const id = setInterval(refresh, 3000)
    return () => {
      liveRef.current = false
      clearInterval(id)
    }
  }, [refresh])

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
                await clearTorrentCaptures()
                refresh()
              }}
              style={styles.clearBtn}
            >
              <Text style={styles.clearBtnText}>清空</Text>
            </Pressable>
          )}
        </View>
        {!a11yOn && (
          <Pressable
            onPress={() => openAccessibilitySettings()}
            style={styles.openA11yBtn}
          >
            <Text style={styles.openA11yText}>去系统设置开启 SLS 辅助功能</Text>
          </Pressable>
        )}
        <View style={styles.modeRow}>
          {(['feed', 'raw'] as ViewMode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => setViewMode(m)}
              style={[styles.modeChip, viewMode === m && styles.modeChipOn]}
            >
              <Text style={[styles.modeChipText, viewMode === m && styles.modeChipTextOn]}>
                {m === 'feed' ? '还原卡片' : '原始时间线'}
              </Text>
            </Pressable>
          ))}
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
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            refresh()
          }}
        />
      )}
    </View>
  )
}

// 列表 item 类型联合：FlatList 一次只渲染可见 + buffer，几万条不卡
type SubGroup = { ts: number; items: BiliFeedItem[] }
interface CommentItem {
  rowId: number
  author: string | null
  badges: string[]      // ["UP", "红方", "已投性格三观"] 等
  body: string          // 评论正文
  timeLocation: string  // "5月7日 重庆" / "1小时前 广东"
  likes: string | null
  replyCount: string | null
}
type ListItem =
  | { kind: 'home'; key: string; tsStart: number; tsEnd: number; subgroups: SubGroup[] }
  | { kind: 'detail'; key: string; tsStart: number; tsEnd: number; detail: BiliVideoDetail }
  | { kind: 'comments'; key: string; tsStart: number; tsEnd: number; comments: CommentItem[]; totalCount: number | null }
  | { kind: 'rawSnapshot'; key: string; ts: number; packageName: string; windowClass: string; texts: { rowId: number; text: string; sourceClass: string }[] }

function buildFeedListItems(items: TorrentCapture[]): ListItem[] {
  // 1a) 按秒分组 home feed items
  const homeSubs: SubGroup[] = []
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    if (c.captureType !== 'a11y-view') continue
    const parsed = parseBiliFeedItem(c.rowId, c.eventTimeMs, c.text)
    if (!parsed) continue
    if (parsed.kind !== '视频' && parsed.kind !== '竖版视频' && parsed.kind !== '横幅视频') continue
    const sec = Math.floor(c.eventTimeMs / 1000)
    const lastSub = homeSubs[homeSubs.length - 1]
    if (lastSub && Math.floor(lastSub.ts / 1000) === sec) {
      if (!lastSub.items.some((x) => x.title === parsed.title)) {
        lastSub.items.push(parsed)
      }
    } else {
      homeSubs.push({ ts: c.eventTimeMs, items: [parsed] })
    }
  }
  // 1b) 视频详情页 buckets
  const detailBuckets = new Map<number, { ts: number; lines: { rowId: number; text: string; ts: number }[] }>()
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    if (c.captureType !== 'a11y-view') continue
    const isDetail = c.windowClass.includes('UnitedBiz') || c.windowClass.includes('StoryVideo')
    if (!isDetail) continue
    const sec = Math.floor(c.eventTimeMs / 1000)
    if (!detailBuckets.has(sec)) detailBuckets.set(sec, { ts: c.eventTimeMs, lines: [] })
    detailBuckets.get(sec)!.lines.push({ rowId: c.rowId, text: c.text, ts: c.eventTimeMs })
  }
  const detailItems: ListItem[] = []
  const commentItems: ListItem[] = []
  for (const b of detailBuckets.values()) {
    const d = parseBiliVideoDetail(b.lines)
    if (d) {
      detailItems.push({ kind: 'detail', key: `d-${b.ts}`, tsStart: b.ts, tsEnd: b.ts, detail: d })
    }
    // 评论独立解析（一个 bucket 可能同时有视频详情 + 评论标识）
    const cm = parseBiliComments(b.lines)
    if (cm) {
      commentItems.push({
        kind: 'comments', key: `c-${b.ts}`, tsStart: b.ts, tsEnd: b.ts,
        comments: cm.comments, totalCount: cm.totalCount,
      })
    }
  }
  // 评论也按 < 60s 合并（评论内容用 author+body 去重）
  commentItems.sort((a, b) => (b.kind === 'comments' && a.kind === 'comments' ? b.tsEnd - a.tsEnd : 0))
  const mergedCommentItems: ListItem[] = []
  for (const ci of commentItems) {
    if (ci.kind !== 'comments') continue
    const last = mergedCommentItems[mergedCommentItems.length - 1]
    if (last && last.kind === 'comments' && last.tsStart - ci.tsEnd < 60_000) {
      // 合并 comments（按 body 去重）
      const seen = new Set(last.comments.map((c) => c.body))
      for (const c of ci.comments) {
        if (!seen.has(c.body)) {
          last.comments.push(c)
          seen.add(c.body)
        }
      }
      last.tsStart = Math.min(last.tsStart, ci.tsStart)
    } else {
      mergedCommentItems.push(ci)
    }
  }
  // 2) home 相邻 < 60s 合并
  const MERGE_WINDOW_MS = 60 * 1000
  const homeItems: ListItem[] = []
  for (const sg of homeSubs) {
    if (sg.items.length === 0) continue
    const last = homeItems[homeItems.length - 1]
    if (last && last.kind === 'home' && last.tsStart - sg.ts < MERGE_WINDOW_MS) {
      last.subgroups.push(sg)
      last.tsStart = Math.min(last.tsStart, sg.ts)
    } else {
      homeItems.push({ kind: 'home', key: `h-${sg.ts}`, tsStart: sg.ts, tsEnd: sg.ts, subgroups: [sg] })
    }
  }
  // detail 同 title + < 60s 合并
  detailItems.sort((a, b) => (b.kind === 'detail' && a.kind === 'detail' ? b.tsEnd - a.tsEnd : 0))
  const mergedDetailItems: ListItem[] = []
  for (const ds of detailItems) {
    if (ds.kind !== 'detail') continue
    const last = mergedDetailItems[mergedDetailItems.length - 1]
    if (last && last.kind === 'detail' && last.detail.title === ds.detail.title
      && last.tsStart - ds.tsEnd < MERGE_WINDOW_MS) {
      last.tsStart = Math.min(last.tsStart, ds.tsStart)
    } else {
      mergedDetailItems.push(ds)
    }
  }
  // 3) 合并到统一时间线
  return [...homeItems, ...mergedDetailItems, ...mergedCommentItems].sort((a, b) => {
    const at = a.kind === 'home' || a.kind === 'detail' || a.kind === 'comments' ? a.tsEnd : 0
    const bt = b.kind === 'home' || b.kind === 'detail' || b.kind === 'comments' ? b.tsEnd : 0
    return bt - at
  })
}

function buildRawListItems(items: TorrentCapture[]): ListItem[] {
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
  return groups
}

function RenderList({
  items, viewMode, refreshing, onRefresh,
}: {
  items: TorrentCapture[]
  viewMode: ViewMode
  refreshing: boolean
  onRefresh: () => void
}) {
  const listItems = useMemo(() => {
    return viewMode === 'feed' ? buildFeedListItems(items) : buildRawListItems(items)
  }, [items, viewMode])

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
      data={listItems}
      keyExtractor={(it) => it.key}
      renderItem={({ item }) => <ListItemView item={item} />}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />
      }
      initialNumToRender={8}
      maxToRenderPerBatch={6}
      windowSize={11}
      removeClippedSubviews
    />
  )
}

function ListItemView({ item }: { item: ListItem }) {
  if (item.kind === 'home') {
    return <HomeSnapView item={item} />
  }
  if (item.kind === 'detail') {
    return <DetailSnapView item={item} />
  }
  if (item.kind === 'comments') {
    return <CommentsSnapView item={item} />
  }
  return <RawSnapshotView item={item} />
}

function HomeSnapView({ item: s }: { item: Extract<ListItem, { kind: 'home' }> }) {
  const totalItems = s.subgroups.reduce((n, g) => n + g.items.length, 0)
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  return (
                  <View style={styles.snapCard}>
                    <View style={styles.snapCardHead}>
                      <View style={styles.snapCardAccentBar} />
                      <View style={styles.snapCardHeadText}>
                        <Text style={styles.snapCardTitle}>B 站主页</Text>
                        <Text style={styles.snapCardSubtitle}>
                          {tsLabel} · {totalItems} 条视频
                          {s.subgroups.length > 1 ? ` · 滑动 ${s.subgroups.length} 屏` : ''}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.snapCardBody}>
                      {s.subgroups.map((g, gi) => {
                        // B 站首页布局：横幅视频单列铺满；视频/竖版视频 2 列瀑布流
                        // 把 items 按 kind 切成行：横幅独占一行，其他俩俩成对
                        type Row =
                          | { kind: 'banner'; item: BiliFeedItem }
                          | { kind: 'pair'; items: BiliFeedItem[] }
                        const rows: Row[] = []
                        let pairBuf: BiliFeedItem[] = []
                        const flushPair = () => {
                          if (pairBuf.length > 0) {
                            rows.push({ kind: 'pair', items: pairBuf })
                            pairBuf = []
                          }
                        }
                        for (const it of g.items) {
                          if (it.kind === '横幅视频') {
                            flushPair()
                            rows.push({ kind: 'banner', item: it })
                          } else {
                            pairBuf.push(it)
                            if (pairBuf.length === 2) flushPair()
                          }
                        }
                        flushPair()
                        return (
                          <View key={g.ts} style={[styles.subGroupBlock, gi > 0 && styles.subGroupBlockGap]}>
                            {s.subgroups.length > 1 && (
                              <View style={styles.subGroupHead}>
                                <View style={styles.subGroupDot} />
                                <Text style={styles.subGroupTime}>{fmtTime(g.ts)}</Text>
                                <Text style={styles.subGroupCount}>{g.items.length} 条</Text>
                              </View>
                            )}
                            {rows.map((r, ri) => {
                              if (r.kind === 'banner') {
                                const f = r.item
                                return (
                                  <View key={`b${ri}-${f.rowId}`} style={styles.gridBanner}>
                                    <View style={styles.feedKindRow}>
                                      <Text style={styles.feedKindTag}>{f.kind}</Text>
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
                                        {f.followed && <Text style={styles.feedFollowedTag}>已关注</Text>}
                                      </View>
                                      <Text style={styles.feedTitleCompact} numberOfLines={2}>{f.title}</Text>
                                      <Text style={styles.feedUpCompact} numberOfLines={1}>
                                        {f.upName ? `@${f.upName}` : ''}
                                      </Text>
                                      <View style={styles.feedMetaCompact}>
                                        {f.duration && <Text style={styles.feedMetaTextSm}>{f.duration}</Text>}
                                        {f.views && <Text style={styles.feedMetaTextSm}>{f.views}播</Text>}
                                        {f.danmaku && <Text style={styles.feedMetaTextSm}>{f.danmaku}弹</Text>}
                                      </View>
                                    </View>
                                  ))}
                                  {/* 落单时占位让左侧不撑满 */}
                                  {r.items.length === 1 && <View style={styles.gridCell} />}
                                </View>
                              )
                            })}
                          </View>
                        )
                      })}
                    </View>
                  </View>
  )
}

function DetailSnapView({ item: s }: { item: Extract<ListItem, { kind: 'detail' }> }) {
  const d = s.detail
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  return (
    <View style={styles.snapCard}>
      <View style={[styles.snapCardHead, styles.snapCardHeadDetail]}>
        <View style={[styles.snapCardAccentBar, { backgroundColor: '#00AEEC' }]} />
        <View style={styles.snapCardHeadText}>
          <Text style={styles.snapCardTitle}>视频播放界面</Text>
          <Text style={styles.snapCardSubtitle}>
            {tsLabel} · 在看
            {d.related.length > 0 ? ` · 相关推荐 ${d.related.length} 条` : ''}
          </Text>
        </View>
      </View>
      <View style={styles.snapCardBody}>
        {/* 主视频 */}
        <View style={styles.detailMainBlock}>
          {d.title && <Text style={styles.detailTitle}>{d.title}</Text>}
          {d.upName && (
            <View style={styles.detailUpRow}>
              <Text style={styles.detailUp}>@{d.upName}</Text>
              {d.upFans && <Text style={styles.detailUpMeta}>{d.upFans} 粉丝</Text>}
              {d.upVideoCount && <Text style={styles.detailUpMeta}>{d.upVideoCount} 视频</Text>}
            </View>
          )}
          <View style={styles.detailMetaRow}>
            {d.views && <Text style={styles.detailMeta}>{d.views} 播放</Text>}
            {d.danmaku && <Text style={styles.detailMeta}>{d.danmaku} 弹幕</Text>}
            {d.watchingNow && <Text style={styles.detailMeta}>{d.watchingNow} 人正在看</Text>}
            {d.publishedAt && <Text style={styles.detailMeta}>{d.publishedAt}</Text>}
            {d.category && <Text style={styles.detailMeta}>{d.category}</Text>}
          </View>
          {(d.likes || d.coins || d.favorites || d.shares) && (
            <View style={styles.detailStatsRow}>
              {d.likes && <Text style={styles.detailStat}>👍 {d.likes}</Text>}
              {d.coins && <Text style={styles.detailStat}>🪙 {d.coins}</Text>}
              {d.favorites && <Text style={styles.detailStat}>⭐ {d.favorites}</Text>}
              {d.shares && <Text style={styles.detailStat}>↗ {d.shares}</Text>}
            </View>
          )}
        </View>
        {/* 条形推送（"轻点两下查看详情"，主视频下方一段广告/会员购小条） */}
        {d.promos.length > 0 && (
          <View style={styles.promoStrip}>
            {d.promos.map((p, i) => (
              <View key={i} style={styles.promoItem}>
                <Text style={styles.promoKind}>{p.kind}</Text>
                <Text style={styles.promoText} numberOfLines={2}>{p.text}</Text>
              </View>
            ))}
          </View>
        )}
        {/* 相关推荐列表（主视频卡片下方的推荐 feed） */}
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

const COMMENTS_ACCENT = '#FBB04C'

function CommentsSnapView({ item: s }: { item: Extract<ListItem, { kind: 'comments' }> }) {
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  return (
    <View style={styles.snapCard}>
      <View style={[styles.snapCardHead, { backgroundColor: alpha(COMMENTS_ACCENT, 0.08), borderBottomColor: alpha(COMMENTS_ACCENT, 0.2) }]}>
        <View style={[styles.snapCardAccentBar, { backgroundColor: COMMENTS_ACCENT }]} />
        <View style={styles.snapCardHeadText}>
          <Text style={styles.snapCardTitle}>评论区</Text>
          <Text style={styles.snapCardSubtitle}>
            {tsLabel} · 看到 {s.comments.length} 条评论
          </Text>
        </View>
      </View>
      <View style={styles.snapCardBody}>
        {s.comments.map((c, i) => (
          <View key={`${c.rowId}-${i}`} style={[styles.commentItem, i === s.comments.length - 1 && { borderBottomWidth: 0, marginBottom: 0, paddingBottom: 0 }]}>
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
      </View>
    </View>
  )
}

function RawSnapshotView({ item: g }: { item: Extract<ListItem, { kind: 'rawSnapshot' }> }) {
  const winShort = g.windowClass ? g.windowClass.split('.').pop() : ''
  return (
    <View style={styles.snapshot}>
      <View style={styles.snapshotHead}>
        <Text style={styles.snapshotTime}>{fmtTime(g.ts)}</Text>
        <Text style={styles.snapshotMeta} numberOfLines={1}>
          {PACKAGE_LABEL[g.packageName] ?? g.packageName}
          {winShort ? ` · ${winShort}` : ''}
          {' · '}{g.texts.length} 条
        </Text>
      </View>
      <View style={styles.snapshotBody}>
        {g.texts.map((t) => (
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyInline: { paddingTop: 60, alignItems: 'center', paddingHorizontal: 24 },
  emptyHint: { fontSize: 13, color: theme.inkSoft, textAlign: 'center', lineHeight: 22 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 20 },
  // 主页快照大卡
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
