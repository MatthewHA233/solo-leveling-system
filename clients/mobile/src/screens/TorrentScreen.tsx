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

const PACKAGE_LABEL: Record<string, string> = {
  'tv.danmaku.bili': 'B 站',
}

type ViewMode = 'raw' | 'feed' | 'action'
type SortOrder = 'desc' | 'asc'

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
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [jumpTarget, setJumpTarget] = useState<number | null>(null)
  const [highlightKey, setHighlightKey] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const liveRef = useRef(true)

  // 跨视图跳转：从动作行点 → 切到 feed 跳到对应卡片；从卡头点 → 切到 action 跳到对应行
  const onCrossJump = useCallback((targetVm: ViewMode, ts: number) => {
    setViewMode(targetVm)
    // 切 viewMode 后下一帧 listItems 会重新计算，effect 监听 jumpTarget 触发 scroll
    setTimeout(() => setJumpTarget(ts), 50)
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
          <Pressable onPress={() => setHelpOpen(true)} style={styles.helpBtn}>
            <Text style={styles.helpBtnText}>?</Text>
          </Pressable>
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
          {(['feed', 'action', 'raw'] as ViewMode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => setViewMode(m)}
              style={[styles.modeChip, viewMode === m && styles.modeChipOn]}
            >
              <Text style={[styles.modeChipText, viewMode === m && styles.modeChipTextOn]}>
                {m === 'feed' ? '还原卡片' : m === 'action' ? '还原动作' : '原始时间线'}
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
              · <Text style={{fontWeight:'700'}}>原始时间线</Text>：未加工的 a11y 文本快照
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
type ListItem =
  | { kind: 'home'; key: string; tsStart: number; tsEnd: number; feedItems: HomeFeedItem[]; sweepCount: number }
  | { kind: 'detail'; key: string; tsStart: number; tsEnd: number; detail: BiliVideoDetail }
  | { kind: 'comments'; key: string; tsStart: number; tsEnd: number; comments: CommentItem[]; totalCount: number | null }
  | { kind: 'actionLine'; key: string; ts: number; endTs?: number; act: BiliActionKind; title?: string; upName?: string; meta?: string }
  | { kind: 'rawSnapshot'; key: string; ts: number; packageName: string; windowClass: string; texts: { rowId: number; text: string; sourceClass: string }[] }

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
  // pre-pass：收 feed item title 集合，避免 banner 识别误抓 feed item 的标题独立行
  const feedTitlesInHome = new Set<string>()
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    if (c.captureType !== 'a11y-view') continue
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
    if (c.captureType !== 'a11y-view') continue
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
  // 评论 ASC + 相邻 < 60s 合并（合并时按 body 去重）
  commentItems.sort((a, b) => (a.kind === 'comments' && b.kind === 'comments' ? a.tsStart - b.tsStart : 0))
  const mergedCommentItems: ListItem[] = []
  for (const ci of commentItems) {
    if (ci.kind !== 'comments') continue
    const last = mergedCommentItems[mergedCommentItems.length - 1]
    if (last && last.kind === 'comments' && ci.tsStart - last.tsEnd < 60_000) {
      const seen = new Set(last.comments.map((c) => c.body))
      for (const c of ci.comments) {
        if (!seen.has(c.body)) {
          last.comments.push(c)
          seen.add(c.body)
        }
      }
      last.tsEnd = Math.max(last.tsEnd, ci.tsEnd)
    } else {
      mergedCommentItems.push(ci)
    }
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
  detailItems.sort((a, b) => (a.kind === 'detail' && b.kind === 'detail' ? a.tsStart - b.tsStart : 0))
  const mergedDetailItems: ListItem[] = []
  for (const ds of detailItems) {
    if (ds.kind !== 'detail') continue
    const last = mergedDetailItems[mergedDetailItems.length - 1]
    if (last && last.kind === 'detail' && last.detail.title === ds.detail.title
      && ds.tsStart - last.tsEnd < MERGE_WINDOW_MS) {
      last.tsEnd = Math.max(last.tsEnd, ds.tsEnd)
    } else {
      mergedDetailItems.push(ds)
    }
  }
  // 3) 合并到统一时间线（默认倒序：新→旧；UI 可切换正序）
  return [...homeItems, ...mergedDetailItems, ...mergedCommentItems].sort((a, b) => {
    const at = a.kind === 'home' || a.kind === 'detail' || a.kind === 'comments' ? a.tsEnd : 0
    const bt = b.kind === 'home' || b.kind === 'detail' || b.kind === 'comments' ? b.tsEnd : 0
    return bt - at
  })
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
    // 评论详情
    if (t === '评论详情') return { kind: 'comment_detail', title: ctx.title ?? undefined, upName: ctx.upName ?? undefined }
    // 评论 tab
    if (t === '热门评论') return { kind: 'comments', title: ctx.title ?? undefined, upName: ctx.upName ?? undefined }
    // 视频详情：UP 行（主视频指纹）
    const upM = t.match(/^up主(.+?)[,，](.+?)粉丝[,，](\d+)视频/)
    if (upM) return { kind: 'video_intro', upName: upM[1].trim() }
    // 主页：home windowClass + feed item / banner
    if (wc.includes('MainActivityV2') || wc.endsWith('ScrollView')) {
      if (FEED_PATTERN.test(t) || isBannerCandidate(t)) return { kind: 'home' }
    }
    return null
  }

  // Pass 1：先扫所有 raw，回填 ctx.title + 收所有 signal events
  type EvSig = { ts: number; rowId: number; sig: { kind: BiliActionKind; title?: string; upName?: string } }
  const events: EvSig[] = []
  const ctx = { upName: null as string | null, title: null as string | null }
  for (const c of items) {
    if (c.packageName !== 'tv.danmaku.bili') continue
    // 标题行 → 更新 ctx（不入 events）
    const titleM = c.text.trim().match(/^(?:互动视频|视频|竖版视频), ([^,]+)$/)
    if (titleM) {
      ctx.title = titleM[1].trim()
      continue
    }
    const sig = inferSig(c, ctx)
    if (!sig) continue
    if (sig.kind === 'video_intro' && sig.upName) {
      if (sig.upName !== ctx.upName) ctx.title = null
      ctx.upName = sig.upName
    }
    events.push({ ts: c.eventTimeMs, rowId: c.rowId, sig })
  }

  type Cur = { startTs: number; endTs: number; kind: BiliActionKind; title?: string; upName?: string; meta?: string }
  const acts: Cur[] = []

  // Pass 2：splash 段独立识别（splash 期间 home feed 已 layout，但 splash 才是主体）
  const splashEvs = events.filter((e) => e.sig.kind === 'splash')
  const splashEnd = splashEvs.length > 0 ? splashEvs[splashEvs.length - 1].ts : 0
  if (splashEvs.length > 0) {
    acts.push({
      startTs: splashEvs[0].ts,
      endTs: splashEnd,
      kind: 'splash',
    })
  }

  // Pass 3：剩余非 splash signals 走状态机
  let cur: Cur | null = null
  for (const e of events) {
    if (e.sig.kind === 'splash') continue
    // splash 期间的 home 信号丢弃（splash 段已覆盖）
    if (e.sig.kind === 'home' && e.ts <= splashEnd) continue
    const sig = e.sig
    if (cur) {
      // detail 页内部 tab/层（fullscreen / comments / comment_detail）期间，
      // 同 UP 主的 video_intro 信号属于"detail tree 还在被抓"，吸收
      const DETAIL_INNER: BiliActionKind[] = ['fullscreen', 'comments', 'comment_detail']
      if (DETAIL_INNER.includes(cur.kind) && sig.kind === 'video_intro'
          && sig.upName && sig.upName === cur.upName) {
        cur.endTs = e.ts
        continue
      }
      const sameKind = cur.kind === sig.kind
      const sameVideo = sig.kind !== 'video_intro' || !sig.upName || sig.upName === cur.upName
      if (sameKind && sameVideo) {
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
    }
  }
  if (cur) acts.push(cur)
  acts.sort((a, b) => a.startTs - b.startTs)

  // 转 ListItem（默认 desc：新→旧；UI 可切 asc）
  return acts.map((a, i) => ({
    kind: 'actionLine' as const,
    key: `act-${a.startTs}-${i}`,
    ts: a.startTs,
    endTs: a.endTs,
    act: a.kind,
    title: a.title,
    upName: a.upName,
    meta: a.meta,
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
  jumpTarget: number | null
  onJumpDone: (targetKey: string | null) => void
  onCrossJump: (targetViewMode: ViewMode, ts: number) => void
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
    return sortOrder === 'asc' ? [...base].reverse() : base
  }, [filteredItems, viewMode, sortOrder])

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

  const listRef = useRef<FlatList<ListItem>>(null)
  // 跳转：找到 ts 最近的 item index 并 scrollToIndex
  useEffect(() => {
    if (jumpTarget == null) return
    const getTs = (it: ListItem) => {
      if (it.kind === 'home' || it.kind === 'detail' || it.kind === 'comments') return it.tsStart
      if (it.kind === 'actionLine') return it.ts
      return it.ts
    }
    let bestIdx = -1, bestDelta = Infinity
    for (let i = 0; i < listItems.length; i++) {
      const d = Math.abs(getTs(listItems[i]) - jumpTarget)
      if (d < bestDelta) { bestDelta = d; bestIdx = i }
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

function ListItemView({ item, sortOrder, onCrossJump, highlighted }: { item: ListItem; sortOrder: SortOrder; onCrossJump: (vm: ViewMode, ts: number) => void; highlighted: boolean }) {
  if (item.kind === 'home') {
    return <HomeSnapView item={item} sortOrder={sortOrder} onCrossJump={onCrossJump} highlighted={highlighted} />
  }
  if (item.kind === 'detail') {
    return <DetailSnapView item={item} onCrossJump={onCrossJump} highlighted={highlighted} />
  }
  if (item.kind === 'comments') {
    return <CommentsSnapView item={item} sortOrder={sortOrder} onCrossJump={onCrossJump} highlighted={highlighted} />
  }
  if (item.kind === 'actionLine') {
    return <ActionLineView item={item} onCrossJump={onCrossJump} highlighted={highlighted} />
  }
  return <RawSnapshotView item={item} sortOrder={sortOrder} />
}

function HomeSnapView({ item: s, sortOrder, onCrossJump, highlighted }: { item: Extract<ListItem, { kind: 'home' }>; sortOrder: SortOrder; onCrossJump: (vm: ViewMode, ts: number) => void; highlighted: boolean }) {
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

function DetailSnapView({ item: s, onCrossJump, highlighted }: { item: Extract<ListItem, { kind: 'detail' }>; onCrossJump: (vm: ViewMode, ts: number) => void; highlighted: boolean }) {
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

function CommentsSnapView({ item: s, sortOrder, onCrossJump, highlighted }: { item: Extract<ListItem, { kind: 'comments' }>; sortOrder: SortOrder; onCrossJump: (vm: ViewMode, ts: number) => void; highlighted: boolean }) {
  const onHeadPress = () => onCrossJump('action', s.tsStart)
  // 评论默认按 raw 出现顺序（视觉自顶向下）；desc 时反转
  const comments: CommentItem[] = sortOrder === 'desc' ? [...s.comments].reverse() : s.comments
  const tsLabel = s.tsStart === s.tsEnd
    ? fmtTime(s.tsEnd)
    : `${fmtTime(s.tsStart)} – ${fmtTime(s.tsEnd)}`
  return (
    <View style={[styles.snapCard, highlighted && styles.snapCardHighlight]}>
      <Pressable onPress={onHeadPress}>
      <View style={[styles.snapCardHead, { backgroundColor: alpha(COMMENTS_ACCENT, 0.08), borderBottomColor: alpha(COMMENTS_ACCENT, 0.2) }]}>
        <View style={[styles.snapCardAccentBar, { backgroundColor: COMMENTS_ACCENT }]} />
        <View style={styles.snapCardHeadText}>
          <View style={styles.snapCardTitleRow}>
            <Text style={styles.snapCardTitle}>评论区</Text>
            <Text style={styles.jumpHint}>→ 动作</Text>
          </View>
          <Text style={styles.snapCardSubtitle}>
            {tsLabel} · 看到 {comments.length} 条评论
          </Text>
        </View>
      </View>
      </Pressable>
      <View style={styles.snapCardBody}>
        {comments.map((c, i) => (
          <View key={`${c.rowId}-${i}`} style={[styles.commentItem, i === comments.length - 1 && { borderBottomWidth: 0, marginBottom: 0, paddingBottom: 0 }]}>
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

// 哪些动作有对应卡片可跳：home → home 卡 / video_intro → detail 卡 / comments, comment_detail → comments 卡
const ACTION_HAS_CARD: Record<BiliActionKind, boolean> = {
  splash: false, home: true, video_intro: true, fullscreen: false,
  comments: true, comment_detail: true,
}

function ActionLineView({ item: a, onCrossJump, highlighted }: { item: Extract<ListItem, { kind: 'actionLine' }>; onCrossJump: (vm: ViewMode, ts: number) => void; highlighted: boolean }) {
  const cfg = ACTION_CFG[a.act]
  const lasted = a.endTs ? Math.round((a.endTs - a.ts) / 1000) : 0
  const timeRange = lasted >= 1
    ? `${fmtTime(a.ts)} → ${fmtTime(a.endTs!)}`
    : fmtTime(a.ts)
  const canJump = ACTION_HAS_CARD[a.act]
  return (
    <Pressable
      onPress={canJump ? () => onCrossJump('feed', a.ts) : undefined}
      disabled={!canJump}
      style={[styles.actionRow, highlighted && styles.actionRowHighlight]}
    >
      <View style={[styles.actionDot, { backgroundColor: cfg.color }]} />
      <View style={styles.actionBody}>
        <View style={styles.actionHead}>
          <Text style={[styles.actionKind, { color: cfg.color }]}>{cfg.label}</Text>
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
      </View>
    </Pressable>
  )
}

const ACTION_CFG: Record<BiliActionKind, { label: string; color: string }> = {
  splash:         { label: '开屏广告',     color: '#9CA3AF' },
  home:           { label: '进入主页',     color: '#FB7299' },
  video_intro:    { label: '进入视频简介', color: '#00AEEC' },
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
