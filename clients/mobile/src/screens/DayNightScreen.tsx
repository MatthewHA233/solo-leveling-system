// ══════════════════════════════════════════════
// 昼夜表 — 鱼眼焦点网格
// 18 完整行（12×5min）+ 上下缩进行（1hr/格）
// 同一事件的格子连为一体 · 编辑模式拖拽涂色（可跨行）
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { LayoutChangeEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import ConfirmDialog from '../components/ConfirmDialog'
import { alpha, theme } from '../theme'
import type {
  ActivityBlock,
  ActivityCategory,
  ActivityPalette,
  ActivityTag,
} from '../types'
import { createTag, deleteCategory, deleteTag, eraseBlocks, fetchBlocks, fetchPalette, paintBlocks } from '../lib/api'
import { addDays, fmtDateLabel, fmtMinute, isSameDay, toLocalDateStr } from '../lib/time'
import { getAppIcons, getWindowEventsInRange, type WindowEvent } from '../lib/perception'

const GUTTER = 46
const GAP = 4
const R_ACTIVITY = 14
const R_EMPTY = 5

// 4 档 zoom：cols = 每个 full row 的格子数（cell 永远 5min）
//   12 → 1 行 60 分钟 / focus 18h / 上下各 1 层 compressed
//    6 → 1 行 30 分钟 / focus 8h  / 上下各 2 层
//    4 → 1 行 20 分钟 / focus 6h  / 上下各 3 层
//    3 → 1 行 15 分钟 / focus 5h  / 上下各 3 层
// focus 总是整小时（rows 跟 cols 联动调整）
type ZoomCols = 12 | 6 | 4 | 3
const ZOOM_LEVELS: readonly ZoomCols[] = [12, 6, 4, 3] as const
const ZOOM_CONFIG: Record<ZoomCols, { rows: number; tiers: number }> = {
  12: { rows: 18, tiers: 1 },
  6:  { rows: 16, tiers: 2 },
  4:  { rows: 18, tiers: 3 },
  3:  { rows: 20, tiers: 3 },
}
function zoomFocusHours(cols: ZoomCols): number {
  const cfg = ZOOM_CONFIG[cols]
  return Math.round((cfg.rows * cols * 5) / 60)
}
function totalRowCount(cols: ZoomCols): number {
  // 全屏 grid 总行数 = focus 行 + 上下 compressed tier；用于 axisPan rowH 推算
  const cfg = ZOOM_CONFIG[cols]
  const focusH = zoomFocusHours(cols)
  // 上下 compressed tier 行数（注意：实际可能因 focusStart 边界减少；用最大值估算行高即可）
  const restHours = 24 - focusH
  const topTiers = restHours > 0 ? cfg.tiers : 0
  const botTiers = restHours > 0 ? cfg.tiers : 0
  return cfg.rows + topTiers + botTiers
}

interface Span {
  startMin: number
  endMin: number
  tagId: number
  note: string | null
}

type Row =
  | { kind: 'full'; startMin: number; cols: number }
  | { kind: 'compressed'; hours: number[] }

type HitCell =
  | { kind: 'full'; hour: number; col: number; minute: number }
  | { kind: 'compressed'; hour: number }

interface PlannedTask {
  id: string
  title: string
  icon: string
  color: string
  durationMin: number
  scheduledStartMin: number | null
}

interface PlanMeta {
  icon: string
  color: string
  label: string
}

const PLAN_SUGGESTIONS = ['复盘今天', '写论文初稿', 'React Native 动效', '整理收件箱']

const PLAN_PRESETS: { pattern: RegExp; meta: PlanMeta }[] = [
  { pattern: /邮件|消息|沟通|回复|email|mail/i, meta: { icon: '@', color: '#4C86E0', label: '沟通' } },
  { pattern: /跑|健身|运动|训练|workout|run/i, meta: { icon: '>', color: '#3FA86A', label: '运动' } },
  { pattern: /写|论文|文章|文档|draft|write/i, meta: { icon: '#', color: '#8A63C9', label: '写作' } },
  { pattern: /读|阅读|书|read/i, meta: { icon: 'R', color: '#BE8A4A', label: '阅读' } },
  { pattern: /学|课程|复习|学习|study|learn/i, meta: { icon: 'A', color: '#3FA86A', label: '学习' } },
  { pattern: /设计|交互|动画|动效|ui|ux/i, meta: { icon: '*', color: '#46A86B', label: '设计' } },
  { pattern: /bug|测试|紧急|风险|test|fix/i, meta: { icon: '!', color: '#D26591', label: '警戒' } },
  { pattern: /会|会议|同步|meeting/i, meta: { icon: 'M', color: '#7E8590', label: '会议' } },
]

const DEFAULT_PLAN_META: PlanMeta = { icon: '+', color: '#3E63DD', label: '任务' }

function buildSpans(blocks: ActivityBlock[]): Span[] {
  const sorted = [...blocks].sort((a, b) => a.minute - b.minute)
  const spans: Span[] = []
  for (const b of sorted) {
    const last = spans[spans.length - 1]
    if (last && last.tagId === b.tagId && b.minute === last.endMin) {
      last.endMin = b.minute + 5
      if (!last.note && b.note) last.note = b.note
    } else {
      spans.push({ startMin: b.minute, endMin: b.minute + 5, tagId: b.tagId, note: b.note })
    }
  }
  return spans
}

function buildRows(focusStart: number, zoomCols: ZoomCols): Row[] {
  const cfg = ZOOM_CONFIG[zoomCols]
  const focusH = zoomFocusHours(zoomCols)
  const safeStart = clamp(focusStart, 0, 24 - focusH)
  const rows: Row[] = []

  // 上方 compressed：[0, safeStart) hour 均分到 cfg.tiers 行
  const topHours: number[] = []
  for (let h = 0; h < safeStart; h++) topHours.push(h)
  if (topHours.length > 0) {
    const chunk = Math.ceil(topHours.length / cfg.tiers)
    for (let i = 0; i < cfg.tiers; i++) {
      const slice = topHours.slice(i * chunk, (i + 1) * chunk)
      if (slice.length > 0) rows.push({ kind: 'compressed', hours: slice })
    }
  }

  // focus：cfg.rows 行，每行 zoomCols * 5 分钟（5min/cell × zoomCols cols）
  const startMin = safeStart * 60
  const minutesPerRow = zoomCols * 5
  for (let i = 0; i < cfg.rows; i++) {
    rows.push({ kind: 'full', startMin: startMin + i * minutesPerRow, cols: zoomCols })
  }

  // 下方 compressed：[safeStart + focusH, 24) hour 均分到 cfg.tiers 行
  const botHours: number[] = []
  for (let h = safeStart + focusH; h < 24; h++) botHours.push(h)
  if (botHours.length > 0) {
    const chunk = Math.ceil(botHours.length / cfg.tiers)
    for (let i = 0; i < cfg.tiers; i++) {
      const slice = botHours.slice(i * chunk, (i + 1) * chunk)
      if (slice.length > 0) rows.push({ kind: 'compressed', hours: slice })
    }
  }
  return rows
}

function fmtHM(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h > 0 && m > 0) return `${h} 小时 ${m} 分`
  if (h > 0) return `${h} 小时`
  return `${m} 分`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function snapMinute(minute: number): number {
  return clamp(Math.round(minute / 5) * 5, 0, 1435)
}

// 标签树节点：fullPath 按 "," 分层，category 名是 level0，逐层往下
type TagTreeNode = {
  segment: string
  fullPath: string
  tag: ActivityTag | null  // 自己是不是个实标签（branch + 自身都有可能命中）
  children: TagTreeNode[]
  catColor: string
}

function buildTagTree(
  tags: ActivityTag[],
  categories: ActivityCategory[],
): TagTreeNode[] {
  const catByName = new Map(categories.map((c) => [c.name, c]))
  const roots: TagTreeNode[] = []
  const rootByName = new Map<string, TagTreeNode>()
  for (const cat of categories) {
    const r: TagTreeNode = {
      segment: cat.name,
      fullPath: cat.name,
      tag: null,
      children: [],
      catColor: cat.color,
    }
    roots.push(r)
    rootByName.set(cat.name, r)
  }
  for (const tag of tags) {
    const parts = tag.fullPath.split(',')
    const cat = catByName.get(parts[0])
    if (!cat) continue
    let node = rootByName.get(parts[0])!
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i]
      let child = node.children.find((c) => c.segment === seg)
      if (!child) {
        child = {
          segment: seg,
          fullPath: parts.slice(0, i + 1).join(','),
          tag: null,
          children: [],
          catColor: cat.color,
        }
        node.children.push(child)
      }
      node = child
    }
    node.tag = tag
  }
  // 每层 children 按"新旧"排序：取自身或后代里最大的 lastUsedAt，倒序
  const recencyOf = (n: TagTreeNode): string => {
    let best = n.tag?.lastUsedAt ?? ''
    for (const c of n.children) {
      const r = recencyOf(c)
      if (r > best) best = r
    }
    return best
  }
  const sortRec = (n: TagTreeNode) => {
    n.children.sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)))
    for (const c of n.children) sortRec(c)
  }
  for (const r of roots) sortRec(r)
  // 过滤空 root（无命中 tag 的 category），并按 root 的最新度排序
  return roots
    .filter((r) => r.children.length > 0)
    .sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)))
}

/** 递归渲染标签树节点。叶子 = chip；分支 = 嵌套 box；分支自身有 tag 时 box 头部可点击。 */
function TagTreeView({
  node,
  depth,
  selectedId,
  onPick,
  onLongPressTag,
  onLongPressCategory,
}: {
  node: TagTreeNode
  depth: number
  selectedId: number | null
  onPick: (id: number) => void
  onLongPressTag: (tag: ActivityTag) => void
  onLongPressCategory: (categoryName: string) => void
}) {
  // 叶子：无 children 且有 tag → 单 chip
  if (node.children.length === 0 && node.tag) {
    const on = node.tag.id === selectedId
    const c = node.catColor
    return (
      <Pressable
        onPress={() => onPick(node.tag!.id)}
        onLongPress={() => onLongPressTag(node.tag!)}
        delayLongPress={400}
        style={[
          treeStyles.leafChip,
          {
            backgroundColor: on ? alpha(c, 0.38) : alpha(c, 0.22),
            borderColor: on ? c : alpha(c, 0.55),
          },
          on && treeStyles.leafChipOn,
        ]}
      >
        <Text style={[treeStyles.leafText, on && treeStyles.leafTextOn]}>
          {node.segment}
        </Text>
      </Pressable>
    )
  }
  // 分支：嵌套 box；先 leaf 子节点行内 chip，再 branch 子节点垂直堆叠
  const leafKids = node.children.filter((c) => c.children.length === 0 && c.tag)
  const branchKids = node.children.filter((c) => c.children.length > 0)
  const onHeader = node.tag != null && node.tag.id === selectedId
  return (
    <View
      style={[
        treeStyles.box,
        {
          // 浅深底色 + 边框承担 category 识别，文字保持 ink
          backgroundColor: alpha(node.catColor, depth === 0 ? 0.1 : 0.06),
          borderColor: alpha(node.catColor, depth === 0 ? 0.55 : 0.35),
          borderLeftWidth: depth === 0 ? 4 : 2,
        },
      ]}
    >
      <Pressable
        onPress={() => node.tag && onPick(node.tag.id)}
        onLongPress={() => {
          if (node.tag) onLongPressTag(node.tag)
          else if (depth === 0) onLongPressCategory(node.segment)
          // 中间分支节点（非 root 也无 tag）= 虚拟段，没法删，不响应长按
        }}
        delayLongPress={400}
        style={treeStyles.headerRow}
      >
        <View
          style={[
            treeStyles.headerDot,
            { backgroundColor: node.catColor },
          ]}
        />
        <Text
          style={[
            depth === 0 ? treeStyles.catHeader : treeStyles.branchHeader,
            onHeader && { fontWeight: '800', textDecorationLine: 'underline' },
          ]}
        >
          {node.segment}
        </Text>
        {node.tag != null && <Text style={treeStyles.selfMark}>（可选）</Text>}
      </Pressable>
      {leafKids.length > 0 && (
        <View style={treeStyles.leafRow}>
          {leafKids.map((c) => (
            <TagTreeView
              key={c.fullPath}
              node={c}
              depth={depth + 1}
              selectedId={selectedId}
              onPick={onPick}
              onLongPressTag={onLongPressTag}
              onLongPressCategory={onLongPressCategory}
            />
          ))}
        </View>
      )}
      {branchKids.map((c) => (
        <TagTreeView
          key={c.fullPath}
          node={c}
          depth={depth + 1}
          selectedId={selectedId}
          onPick={onPick}
          onLongPressTag={onLongPressTag}
          onLongPressCategory={onLongPressCategory}
        />
      ))}
    </View>
  )
}

const treeStyles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 9,
    marginBottom: 8,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  headerDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  catHeader: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: theme.ink,
  },
  branchHeader: {
    fontSize: 12.5,
    fontWeight: '600',
    color: theme.ink,
  },
  selfMark: {
    fontSize: 10.5,
    color: theme.inkSoft,
  },
  leafRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  leafChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 13,
    borderWidth: 1,
  },
  leafChipOn: {
    borderWidth: 1.5,
  },
  leafText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.ink,
  },
  leafTextOn: {
    fontWeight: '700',
  },
})

/** 撤回/前进 弯箭头（U 形 + 箭头头），direction=left 是撤回，right 是前进。 */
function UndoGlyph({
  color = '#23242A',
  size = 14,
  direction = 'left',
}: { color?: string; size?: number; direction?: 'left' | 'right' }) {
  const stroke = Math.max(1.2, Math.round(size * 0.12))
  const arc = Math.round(size * 0.6)
  const head = Math.round(size * 0.32)
  const flip = direction === 'right' ? { transform: [{ scaleX: -1 as const }] } : null
  return (
    <View style={[{ width: size, height: size, justifyContent: 'center' }, flip]}>
      {/* 弧线 - 用一个半圆替代：上半圈 */}
      <View
        style={{
          width: arc,
          height: arc / 2,
          borderTopLeftRadius: arc / 2,
          borderTopRightRadius: arc / 2,
          borderWidth: stroke,
          borderBottomWidth: 0,
          borderColor: color,
          alignSelf: 'center',
          marginTop: 1,
        }}
      />
      {/* 箭头尾部短竖线 */}
      <View
        style={{
          position: 'absolute',
          left: (size - arc) / 2 + 1,
          top: size / 2 - 1,
          width: stroke,
          height: head * 0.8,
          backgroundColor: color,
          borderRadius: stroke / 2,
        }}
      />
      {/* 箭头头部斜线 */}
      <View
        style={{
          position: 'absolute',
          left: (size - arc) / 2 - head / 2 + 2,
          top: size / 2 + head * 0.3,
          width: head,
          height: stroke,
          backgroundColor: color,
          borderRadius: stroke / 2,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  )
}

/** 软件风调节器图标 —— 3 条水平滑条 + 圆形滑块，纯 RN 几何，无依赖。 */
function SlidersGlyph({ color = '#FFF', size = 14 }: { color?: string; size?: number }) {
  const knob = Math.max(3, Math.round(size * 0.22))
  const lineH = Math.max(1, Math.round(size * 0.08))
  const rowGap = (size - knob * 3) / 2
  const knobPositions = [0.18, 0.62, 0.34] // 三条滑条上滑块的水平位置百分比
  return (
    <View style={{ width: size, height: size, justifyContent: 'space-between' }}>
      {knobPositions.map((leftPct, i) => (
        <View key={i} style={{ height: knob, justifyContent: 'center', marginTop: i === 0 ? 0 : rowGap }}>
          <View
            style={{
              height: lineH,
              backgroundColor: color,
              opacity: 0.55,
              borderRadius: lineH / 2,
            }}
          />
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: `${leftPct * 100}%`,
              width: knob,
              height: knob,
              borderRadius: knob / 2,
              backgroundColor: color,
              marginLeft: -knob / 2,
            }}
          />
        </View>
      ))}
    </View>
  )
}

/** 纯 RN 几何三角 caret（▾ / ▴）。Unicode ▾ 在 RN Text 里偏小且基线不稳，
 *  改用 border-trick 画稳定的实心三角。 */
function CaretGlyph({
  color = '#888',
  size = 8,
  direction = 'down',
}: { color?: string; size?: number; direction?: 'down' | 'up' }) {
  const w = size
  const h = Math.round(size * 0.6)
  if (direction === 'down') {
    return (
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: w / 2,
          borderRightWidth: w / 2,
          borderTopWidth: h,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderTopColor: color,
        }}
      />
    )
  }
  return (
    <View
      style={{
        width: 0,
        height: 0,
        borderLeftWidth: w / 2,
        borderRightWidth: w / 2,
        borderBottomWidth: h,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        borderBottomColor: color,
      }}
    />
  )
}

/** 纯 RN 画的 search 图标（圆环 + 把手），无第三方 SVG 依赖。 */
function SearchGlyph({ color = '#888', size = 14 }: { color?: string; size?: number }) {
  const ringSize = Math.round(size * 0.78)
  const handleLen = Math.round(size * 0.4)
  const handleWidth = Math.max(1, Math.round(size * 0.13))
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: ringSize,
          height: ringSize,
          borderRadius: ringSize / 2,
          borderWidth: handleWidth,
          borderColor: color,
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      />
      <View
        style={{
          width: handleLen,
          height: handleWidth,
          backgroundColor: color,
          borderRadius: handleWidth / 2,
          position: 'absolute',
          bottom: 0,
          right: 0,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  )
}

function fmtHHMMms(ms: number): string {
  if (!ms || ms <= 0) return '--:--'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function inferPlanMeta(title: string): PlanMeta {
  const hit = PLAN_PRESETS.find((p) => p.pattern.test(title))
  return hit?.meta ?? DEFAULT_PLAN_META
}

function nextPlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

interface Interaction {
  editMode: boolean
  selectedTagId: number | null
  rows: Row[]
  blocks: ActivityBlock[]
  blockByMinute: Map<number, ActivityBlock>
  spans: Span[]
  selectedDate: Date
}

interface DragState {
  mode: 'paint' | 'erase'      // 仅起点判定的"主导意图"，commit 仍按每 cell 独立判断
  startMin: number | null      // 拖拽起点（5min 对齐）
  lastMin: number | null       // 上一次 move 命中的 minute
  painted: Set<number>         // 本次拖拽覆盖的全部 mins（含 paint + erase + replace）
  paintMins: Set<number>       // 本次拖拽中需要 paint 的 mins（commit 分批用）
  eraseMins: Set<number>       // 本次拖拽中需要 erase 的 mins
  snapshot: ActivityBlock[]    // 拖拽前的 blocks 快照，用于"区间反向"时恢复 + undo
  moved: boolean
  tapCell: HitCell | null
  grantTs: number              // grant 时间戳，release 时算时长用于 long-press 防误触
}

export default function DayNightScreen() {
  // SafeArea inset 是异步算的 —— 第一次 mount 时 top=0，几 ms 后变成
  // 状态栏 + 刘海高度。App.tsx 用 paddingTop: insets.top 推开整个 root，
  // 所以 insets.top 变化时 cellArea 的屏幕 y 偏移也跟着变，必须重 measure，
  // 否则 measureInWindow 拿到的是 inset=0 时的旧值 → 拖拽落点漂移到上方。
  const insets = useSafeAreaInsets()
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const [palette, setPalette] = useState<ActivityPalette | null>(null)
  const [blocks, setBlocks] = useState<ActivityBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null)
  // null = picker 关闭；'browse' = 点中间标签按钮（不自动 focus 输入框）；
  // 'search' = 点搜索按钮（自动 focus 输入框）
  const [pickerMode, setPickerMode] = useState<null | 'browse' | 'search'>(null)
  const tagPickerOpen = pickerMode != null
  const setTagPickerOpen = (open: boolean) => setPickerMode(open ? 'browse' : null)
  // picker 浮层贴在 toolbar 下方，需要知道 toolbar 底部 y 坐标
  const [actionSlotBottom, setActionSlotBottom] = useState(0)
  const [tagQuery, setTagQuery] = useState('')
  const [detail, setDetail] = useState<Span | null>(null)
  const [probeEvents, setProbeEvents] = useState<WindowEvent[]>([])
  const [probeLoading, setProbeLoading] = useState(false)
  const [iconCache, setIconCache] = useState<Record<string, string>>({})
  const [focusStart, setFocusStart] = useState(3)
  // 非编辑模式下双指 pinch 切换：12 / 6 / 4 / 3 cols（cell 永远 5min）
  const [zoomCols, setZoomCols] = useState<ZoomCols>(12)
  // 撤回/前进栈：每个元素是 blocks 数组快照，最多 30 个；点"完成"不清记忆
  const [undoStack, setUndoStack] = useState<readonly ActivityBlock[][]>([])
  const [redoStack, setRedoStack] = useState<readonly ActivityBlock[][]>([])
  const UNDO_LIMIT = 30
  const [planOpen, setPlanOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerStage, setComposerStage] = useState<'quick' | 'details'>('quick')
  const [composerTitle, setComposerTitle] = useState('')
  const [composerDuration, setComposerDuration] = useState(25)
  const [plannedTasks, setPlannedTasks] = useState<PlannedTask[]>([])

  // ── refs（供手势回调读取最新值）──
  const gridHRef = useRef(0)
  const focusBaseRef = useRef(3)
  const focusStartRef = useRef(3)
  const areaRef = useRef({ x: 0, y: 0, w: 0, h: 0 })
  const cellAreaRef = useRef<View>(null)
  const interactionRef = useRef<Interaction>({
    editMode: false,
    selectedTagId: null,
    rows: [],
    blocks: [],
    blockByMinute: new Map(),
    spans: [],
    selectedDate: new Date(),
  })
  const dragRef = useRef<DragState>({
    mode: 'paint',
    startMin: null,
    lastMin: null,
    painted: new Set(),
    paintMins: new Set(),
    eraseMins: new Set(),
    snapshot: [],
    moved: false,
    tapCell: null,
    grantTs: 0,
  })
  const plannedTasksRef = useRef<PlannedTask[]>([])

  focusStartRef.current = focusStart
  plannedTasksRef.current = plannedTasks

  // palette 走 ref —— PanResponder 闭包里查 tag 名要拿最新 palette，
  // 不能直接读闭包外的 tagById（那是首次 render 时的空 Map）
  const paletteRef = useRef<ActivityPalette | null>(null)
  paletteRef.current = palette

  // zoom 同步 ref（PanResponder 回调拿最新值）
  const zoomColsRef = useRef<ZoomCols>(12)
  zoomColsRef.current = zoomCols
  // pinch 手势状态：起始两指距离 + 起始 zoom 档
  const pinchRef = useRef({ initialDist: 0, startCols: 12 as ZoomCols })

  // zoom toast：每次切换显示 "cols × rows"，2s 自动淡出
  const [zoomToast, setZoomToast] = useState<string | null>(null)
  const zoomToastOpacity = useRef(new Animated.Value(0)).current
  const zoomToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 长按标签 / 分类 → 弹确认框删除
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'tag' | 'category'; id: number; label: string } | null
  >(null)
  const doConfirmDelete = async () => {
    if (!confirmDelete) return
    const item = confirmDelete
    setConfirmDelete(null)
    try {
      const next = item.kind === 'tag' ? await deleteTag(item.id) : await deleteCategory(item.id)
      setPalette(next)
      // 删的是当前选中标签 → 清掉 selected
      if (item.kind === 'tag' && selectedTagId === item.id) setSelectedTagId(null)
      // recent 列表从 next.tags 重算（被删的 tag/category 不会出现在 next 里）
      // 当日 blocks 引用了被删 tag 的部分需要刷新（mock 不刷会显示空）
      const refreshed = await fetchBlocks(selectedDate)
      setBlocks(refreshed)
    } catch (e) {
      // 失败静默
    }
  }

  // paint span toast：拖拽涂色完成后底部显示新段起止时间
  // 拆 name / time 两段，让 name 太长能 ellipsize 而时间始终完整可见
  const [paintToast, setPaintToast] = useState<{ name: string; time: string } | null>(null)
  const paintToastOpacity = useRef(new Animated.Value(0)).current
  const paintToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showPaintToast = (msg: { name: string; time: string }) => {
    setPaintToast(msg)
    if (paintToastTimer.current) clearTimeout(paintToastTimer.current)
    Animated.timing(paintToastOpacity, {
      toValue: 1, duration: 140, useNativeDriver: true,
    }).start()
    paintToastTimer.current = setTimeout(() => {
      Animated.timing(paintToastOpacity, {
        toValue: 0, duration: 320, useNativeDriver: true,
      }).start(() => setPaintToast(null))
    }, 1600)
  }

  // zoom 切换：尽量保持 focus 屏幕中心不变（新 focusHours 对称裹原中心 hour）
  const applyZoom = (newCols: ZoomCols) => {
    if (newCols === zoomColsRef.current) return
    const oldCols = zoomColsRef.current
    const oldFocusH = zoomFocusHours(oldCols)
    const newFocusH = zoomFocusHours(newCols)
    const center = focusStartRef.current + oldFocusH / 2
    const newStart = clamp(Math.round(center - newFocusH / 2), 0, 24 - newFocusH)
    zoomColsRef.current = newCols
    setZoomCols(newCols)
    setFocusStart(newStart)
    // toast
    const cfg = ZOOM_CONFIG[newCols]
    setZoomToast(`${newCols} × ${cfg.rows}`)
    if (zoomToastTimer.current) clearTimeout(zoomToastTimer.current)
    Animated.timing(zoomToastOpacity, {
      toValue: 1, duration: 120, useNativeDriver: true,
    }).start()
    zoomToastTimer.current = setTimeout(() => {
      Animated.timing(zoomToastOpacity, {
        toValue: 0, duration: 280, useNativeDriver: true,
      }).start(() => setZoomToast(null))
    }, 1400)
  }

  useEffect(() => {
    let alive = true
    fetchPalette().then((p) => {
      if (!alive) return
      setPalette(p)
      // 默认选最近用过的 tag；都没用过就不选（让用户主动点选标签按钮）
      // 不再用 p.tags[0]（那是按 category_id, id 排的最早 tag，不是用户意图）
      const mostRecent = [...p.tags]
        .filter((t) => !!t.lastUsedAt)
        .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0]
      setSelectedTagId(mostRecent?.id ?? null)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchBlocks(selectedDate).then((bs) => {
      if (!alive) return
      setBlocks(bs)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [selectedDate])

  // 重 measure cellArea 的屏幕坐标 —— 三种触发：
  //   editMode / focusStart 变化 → 上方 toolbar 内容变化
  //   insets.top / insets.bottom 异步更新 → root paddingTop 变化（cellArea 全局下移）
  // onLayout 在 cellArea 自身尺寸不变时不会触发，必须手动兜底。
  useEffect(() => {
    const t = setTimeout(measureArea, 80)
    return () => clearTimeout(t)
  }, [editMode, focusStart, insets.top, insets.bottom])

  useEffect(() => {
    if (!detail) {
      setProbeEvents([])
      return
    }
    const midnight = new Date(selectedDate)
    midnight.setHours(0, 0, 0, 0)
    const startMs = midnight.getTime() + detail.startMin * 60_000
    const endMs = midnight.getTime() + detail.endMin * 60_000
    let alive = true
    setProbeLoading(true)
    getWindowEventsInRange(startMs, endMs, 200)
      .then(async (evs) => {
        if (!alive) return
        setProbeEvents(evs)
        // 异步把还没缓存的 pkg 图标拉过来
        const needed = Array.from(new Set(evs.map((e) => e.packageName))).filter(
          (p) => p && !(p in iconCache),
        )
        if (needed.length > 0) {
          const fetched = await getAppIcons(needed)
          if (alive) setIconCache((prev) => ({ ...prev, ...fetched }))
        }
      })
      .catch(() => {
        if (alive) setProbeEvents([])
      })
      .finally(() => {
        if (alive) setProbeLoading(false)
      })
    return () => {
      alive = false
    }
  }, [detail, selectedDate])

  const categoryById = useMemo(() => {
    const m = new Map<number, ActivityCategory>()
    palette?.categories.forEach((c) => m.set(c.id, c))
    return m
  }, [palette])

  const tagById = useMemo(() => {
    const m = new Map<number, ActivityTag>()
    palette?.tags.forEach((t) => m.set(t.id, t))
    return m
  }, [palette])

  const blockByMinute = useMemo(() => {
    const m = new Map<number, ActivityBlock>()
    blocks.forEach((b) => m.set(b.minute, b))
    return m
  }, [blocks])

  const spans = useMemo(() => buildSpans(blocks), [blocks])

  // 每个时间段的开始 minute → tag 名，作为标签锚点（每段只显示一次）
  const labelByMinute = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of spans) {
      const name = tagById.get(s.tagId)?.leafName
      if (name) m.set(s.startMin, name)
    }
    return m
  }, [spans, tagById])

  const colorOf = (tagId: number): string => {
    const tag = tagById.get(tagId)
    const cat = tag ? categoryById.get(tag.categoryId) : undefined
    return cat?.color ?? theme.inkSoft
  }

  // 选标签 = 仅切换 selected，不算"使用过"（使用过=拖拽涂色，由 paint commit 维护）
  const pickTag = (id: number) => {
    setSelectedTagId(id)
    setTagPickerOpen(false)
    setTagQuery('')
  }

  // 过滤后的标签列表 —— fuzzy 评分对齐 desktop ActivityTagPalette：
  // 100 精确等 query / 80 路径某段精确等 / 60 子串 / 40 分类名子串
  const filteredTags = useMemo(() => {
    if (!palette) return []
    const q = tagQuery.trim().toLowerCase()
    if (!q) {
      return [...palette.tags].sort((a, b) =>
        (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''),
      )
    }
    type Scored = { tag: typeof palette.tags[number]; score: number }
    const scored: Scored[] = []
    for (const t of palette.tags) {
      const path = t.fullPath.toLowerCase()
      const cat = categoryById.get(t.categoryId)
      const catName = (cat?.name ?? '').toLowerCase()
      let score = 0
      if (path === q) score = 100
      else if (path.split(',').some((s) => s.trim() === q)) score = 80
      else if (path.includes(q)) score = 60
      else if (catName.includes(q)) score = 40
      if (score > 0) scored.push({ tag: t, score })
    }
    scored.sort((a, b) =>
      b.score - a.score || (b.tag.lastUsedAt ?? '').localeCompare(a.tag.lastUsedAt ?? ''),
    )
    return scored.map((s) => s.tag)
  }, [palette, tagQuery, categoryById])

  // 最近用过 = 按 tag.lastUsedAt 倒序取前 3
  // lastUsedAt 由 paintBlocks 内部事务更新（对齐 desktop），LWW 跨设备同步
  // 不再单独维护 recentTagIds state —— 持久化和单一来源
  const recentTags = useMemo(() => {
    if (!palette) return []
    return [...palette.tags]
      .filter((t) => !!t.lastUsedAt)
      .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
      .slice(0, 3)
  }, [palette])

  const tagAt = (hour: number, col: number): number | null =>
    blockByMinute.get(hour * 60 + col * 5)?.tagId ?? null

  const hourColor = (hour: number): string | null => {
    const counts = new Map<number, number>()
    for (let m = hour * 60; m < hour * 60 + 60; m += 5) {
      const b = blockByMinute.get(m)
      if (b) counts.set(b.tagId, (counts.get(b.tagId) ?? 0) + 1)
    }
    let bestTag = -1
    let best = 0
    counts.forEach((c, t) => {
      if (c > best) {
        best = c
        bestTag = t
      }
    })
    return bestTag >= 0 ? colorOf(bestTag) : null
  }

  const summary = useMemo(() => {
    const perCat = new Map<number, number>()
    blocks.forEach((b) => {
      const tag = tagById.get(b.tagId)
      if (!tag) return
      perCat.set(tag.categoryId, (perCat.get(tag.categoryId) ?? 0) + 5)
    })
    const rows = Array.from(perCat.entries())
      .map(([catId, mins]) => ({ cat: categoryById.get(catId), mins }))
      .filter((r): r is { cat: ActivityCategory; mins: number } => !!r.cat)
      .sort((a, b) => b.mins - a.mins)
    return { total: blocks.length * 5, rows }
  }, [blocks, tagById, categoryById])

  const inboxTasks = useMemo(
    () => plannedTasks.filter((task) => task.scheduledStartMin == null),
    [plannedTasks],
  )

  const scheduledTasks = useMemo(
    () => plannedTasks.filter((task) => task.scheduledStartMin != null),
    [plannedTasks],
  )

  const composerMeta = useMemo(() => inferPlanMeta(composerTitle), [composerTitle])

  const isToday = isSameDay(new Date(), selectedDate)
  const rows = useMemo(() => buildRows(focusStart, zoomCols), [focusStart, zoomCols])

  // 同步 refs
  interactionRef.current = { editMode, selectedTagId, rows, blocks, blockByMinute, spans, selectedDate }

  // ── 点 → 命中格子 ──
  // cellArea 自己的手势使用本地坐标 locationX/locationY，不再依赖
  // measureInWindow 的异步 x/y 缓存，避免 SafeArea / toolbar 改变后落点漂移。
  const cellFromLocalPoint = (lx: number, ly: number): HitCell | null => {
    const area = areaRef.current
    const rs = interactionRef.current.rows
    if (area.w <= 0 || area.h <= 0 || rs.length === 0) return null
    if (lx < 0 || ly < 0 || lx > area.w || ly > area.h) return null
    const rowH = area.h / rs.length
    const row = rs[clamp(Math.floor(ly / rowH), 0, rs.length - 1)]
    if (row.kind === 'full') {
      const col = clamp(Math.floor(lx / (area.w / row.cols)), 0, row.cols - 1)
      const minute = row.startMin + col * 5
      return { kind: 'full', hour: Math.floor(minute / 60), col, minute }
    }
    const col = clamp(Math.floor(lx / (area.w / row.hours.length)), 0, row.hours.length - 1)
    return { kind: 'compressed', hour: row.hours[col] }
  }

  // 外部拖放仍然拿 pageX/pageY，这里才用 measureInWindow 的 x/y 转成本地坐标。
  const cellFromPagePoint = (px: number, py: number): HitCell | null => {
    const area = areaRef.current
    return cellFromLocalPoint(px - area.x, py - area.y)
  }

  // 经过旧色块的逻辑（对齐 desktop DayNightChart commitDragOrCancel）：
  //   每个 5min cell 基于 snapshot 独立判断 paint / erase / replace ——
  //     空 + 有 brush       → paint
  //     同 brush 色         → erase（再点一次取消）
  //     异色 + 有 brush     → replace（paint，UPSERT 覆盖）
  //     任何 + 无 brush     → erase
  //   不再用整段统一 mode；混色拖拽会智能地擦同色 + 覆盖异色
  const applyRange = (currMin: number) => {
    const d = dragRef.current
    if (d.startMin == null) return
    const { selectedTagId: tagId, selectedDate: date } = interactionRef.current
    const lo = Math.min(d.startMin, currMin)
    const hi = Math.max(d.startMin, currMin)
    const inRange = new Set<number>()
    for (let m = lo; m <= hi; m += 5) inRange.add(m)

    const initial = new Map<number, number>()
    d.snapshot.forEach((b) => initial.set(b.minute, b.tagId))

    const paintMins = new Set<number>()
    const eraseMins = new Set<number>()
    for (const m of inRange) {
      const existing = initial.get(m)
      if (existing === undefined) {
        if (tagId != null) paintMins.add(m)
      } else if (existing === tagId) {
        eraseMins.add(m)
      } else if (tagId != null) {
        paintMins.add(m)
      } else {
        eraseMins.add(m)
      }
    }

    const stamp = new Date().toISOString()
    const dateStr = toLocalDateStr(date)
    const out: ActivityBlock[] = []
    d.snapshot.forEach((b) => {
      if (!inRange.has(b.minute)) out.push(b)
    })
    paintMins.forEach((m) => {
      out.push({ date: dateStr, minute: m, tagId: tagId as number, note: null, createdAt: stamp })
    })
    setBlocks(out)
    // 记到 dragRef 给 release 时分批 commit
    d.paintMins = paintMins
    d.eraseMins = eraseMins
    d.painted = inRange
  }

  // ── 格子区手势：编辑拖拽涂色 / 查看点按详情 ──
  const cellPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        pinchRef.current.initialDist = 0
        const cell = cellFromLocalPoint(e.nativeEvent.locationX, e.nativeEvent.locationY)
        const { editMode: em, blockByMinute: bm, selectedTagId: tagId } = interactionRef.current
        const d: DragState = {
          mode: 'paint',
          startMin: cell && cell.kind === 'full' ? cell.minute : null,
          lastMin: cell && cell.kind === 'full' ? cell.minute : null,
          painted: new Set(),
          paintMins: new Set(),
          eraseMins: new Set(),
          snapshot: interactionRef.current.blocks,
          moved: false,
          tapCell: cell,
          grantTs: Date.now(),
        }
        dragRef.current = d
        if (em && cell && cell.kind === 'full') {
          // 仅记录起点主导意图（保留旧字段，commit 时仍按每 cell 独立判断）
          const existing = bm.get(cell.minute)
          d.mode = existing != null && existing.tagId === tagId ? 'erase' : 'paint'
          applyRange(cell.minute)
        }
      },
      onPanResponderMove: (e, g) => {
        // pinch 检测：非编辑模式 + 至少 2 根活动手指
        // 用 gestureState.numberActiveTouches（RN 0.85 Fabric 下比 nativeEvent.touches 稳）
        const numTouches = g.numberActiveTouches
        const touches = e.nativeEvent.touches
        // 一旦本次手势曾出现过双指，就永久锁住 multiTouch 标志：
        // 后续即使第二指先抬起 numTouches=1，剩下那根继续动也不能走 tap/paint 路径
        // （否则放手后会误触发"详情"/"编辑"）
        if (numTouches >= 2) {
          dragRef.current.moved = true       // 阻断 tap commit
          dragRef.current.startMin = null    // 阻断 paint commit
        }
        if (!interactionRef.current.editMode && numTouches >= 2 && touches && touches.length >= 2) {
          const [a, b] = [touches[0], touches[1]]
          const dist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY)
          // 第一次进 pinch：记录起始距离 + 起始 zoom 档
          if (pinchRef.current.initialDist === 0) {
            pinchRef.current = { initialDist: dist, startCols: zoomColsRef.current }
            return
          }
          const scale = dist / pinchRef.current.initialDist
          const startIdx = ZOOM_LEVELS.indexOf(pinchRef.current.startCols)
          // 渐进式：scale ≥ 1.25 进 1 档；≥ 1.7 进 2 档；≤ 0.8 / ≤ 0.6 反向
          // 阈值收紧让用户更快感觉到反应
          let delta = 0
          if (scale >= 1.7) delta = 2
          else if (scale >= 1.25) delta = 1
          else if (scale <= 0.6) delta = -2
          else if (scale <= 0.8) delta = -1
          const targetIdx = clamp(startIdx + delta, 0, ZOOM_LEVELS.length - 1)
          const target = ZOOM_LEVELS[targetIdx]
          if (target !== zoomColsRef.current) applyZoom(target)
          return
        }
        if (Math.abs(g.dx) + Math.abs(g.dy) > 8) dragRef.current.moved = true
        if (!interactionRef.current.editMode) return
        const d = dragRef.current
        if (d.startMin == null) return
        const cell = cellFromLocalPoint(e.nativeEvent.locationX, e.nativeEvent.locationY)
        if (!cell || cell.kind !== 'full') return
        if (cell.minute === d.lastMin) return
        d.lastMin = cell.minute
        applyRange(cell.minute)
      },
      onPanResponderRelease: () => {
        // pinch 抬手 → 重置；不走 tap/paint commit 路径
        if (pinchRef.current.initialDist > 0) {
          pinchRef.current.initialDist = 0
          return
        }
        const d = dragRef.current
        const { editMode: em, selectedTagId: tagId, spans: sp, selectedDate: date } =
          interactionRef.current
        if (em) {
          const paintArr = Array.from(d.paintMins)
          const eraseArr = Array.from(d.eraseMins)
          if (paintArr.length === 0 && eraseArr.length === 0) return
          // 推 undo（snapshot = 操作前的 blocks），清空 redo
          setUndoStack((prev) => [...prev.slice(-(UNDO_LIMIT - 1)), d.snapshot])
          setRedoStack([])
          // 分批写后端：paint 走 tagId / erase 不带 tagId
          if (paintArr.length > 0 && tagId != null) {
            // SoloDb.paintBlocks 内部事务会同时 bump tag/category 的 last_used_at
            // （对齐 desktop paint_blocks），LWW 同步到对端，"最近"自动跨设备
            paintBlocks(date, paintArr, tagId).then(() => {
              // 拉回真值刷新 palette，让 recentTags useMemo 能感知新 lastUsedAt
              fetchPalette().then(setPalette).catch(() => {})
            })
            // 底部 toast：找出本次 paint 覆盖区间在 post-paint blocks 里的合并段，
            // 显示连片段（含相邻同色已有 block）的起止时间
            // post-paint blocks 已通过 setBlocks 写过；这里用 d.snapshot + paintArr + tagId
            // 重建 nextBlockByMinute 找连片
            const next = new Map<number, number>()
            d.snapshot.forEach((b) => next.set(b.minute, b.tagId))
            d.eraseMins.forEach((m) => next.delete(m))
            paintArr.forEach((m) => next.set(m, tagId))
            const paintSorted = [...paintArr].sort((a, b) => a - b)
            const firstM = paintSorted[0]
            const lastM = paintSorted[paintSorted.length - 1]
            // 向左扩：起点之前还有同色 → 起点前移
            let start = firstM
            while (start - 5 >= 0 && next.get(start - 5) === tagId) start -= 5
            // 向右扩：终点之后还有同色 → 终点后移
            let endExcl = lastM + 5
            while (endExcl < 1440 && next.get(endExcl) === tagId) endExcl += 5
            // 走 paletteRef 拿最新 palette；tagById 是闭包变量永远是首次 render 的空 Map
            const tagName = paletteRef.current?.tags.find((t) => t.id === tagId)?.leafName ?? '标签'
            showPaintToast({
              name: tagName,
              time: `${fmtMinute(start)} – ${fmtMinute(endExcl)}`,
            })
          }
          if (eraseArr.length > 0) {
            eraseBlocks(date, eraseArr)
          }
          return
        }
        if (d.moved || !d.tapCell) return
        // long-press 防误触：按住超过 350ms 抬起不视为 tap（用户可能在思考 / 准备 pinch）
        if (Date.now() - d.grantTs > 350) return
        if (d.tapCell.kind === 'full') {
          const min = d.tapCell.minute
          const span = sp.find((s) => min >= s.startMin && min < s.endMin)
          if (span) setDetail(span)
        } else {
          // tap compressed hour → 把该 hour 拉到 focus 上沿；focus 高度跟 zoom 走
          const h = d.tapCell.hour
          const focusH = zoomFocusHours(zoomColsRef.current)
          setFocusStart(clamp(h > 24 - focusH ? 24 - focusH : h, 0, 24 - focusH))
        }
      },
    }),
  ).current

  // ── 时间轴拨动 ──
  const axisPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6,
      onPanResponderGrant: () => {
        focusBaseRef.current = focusStartRef.current
      },
      onPanResponderMove: (_, g) => {
        const total = totalRowCount(zoomColsRef.current)
        const rowH = gridHRef.current > 0 ? gridHRef.current / total : 40
        const focusH = zoomFocusHours(zoomColsRef.current)
        const next = clamp(focusBaseRef.current + Math.round(-g.dy / rowH), 0, 24 - focusH)
        setFocusStart((cur) => (cur === next ? cur : next))
      },
    }),
  ).current

  // onLayout 同步拿 width/height 立刻给 areaRef（避免 measureInWindow 异步
  // 回调前用户已开始拖拽，area.h=0 导致命中函数一直返回 null、
  // PanResponder 拿不到 startMin、move 全部 early return —— 表现为"完全拖不动"）。
  // x/y 仍异步由 measureInWindow 拿（监听 insets/editMode/focusStart 变化重测）。
  const measureArea = (e?: LayoutChangeEvent) => {
    if (e) {
      const { width, height } = e.nativeEvent.layout
      areaRef.current = { ...areaRef.current, w: width, h: height }
    }
    cellAreaRef.current?.measureInWindow((x, y) => {
      // 只更新 x/y（onLayout 给的 w/h 才是权威；measureInWindow 偶尔返 0
      // 会把同步设好的 w/h 清掉，导致命中函数 area.h<=0 全部 return null）
      areaRef.current = { ...areaRef.current, x, y }
    })
  }

  // 算 from → to 的差异，转成 paint/erase 调用（对齐 desktop applyBlocksDelta）
  const applyBlocksDelta = async (fromBlocks: ActivityBlock[], toBlocks: ActivityBlock[]) => {
    const fromMap = new Map(fromBlocks.map((b) => [b.minute, b.tagId]))
    const toMap = new Map(toBlocks.map((b) => [b.minute, b.tagId]))
    const paintByTag = new Map<number, number[]>()
    const eraseMinutes: number[] = []
    for (const [m, fromTag] of fromMap) {
      const toTag = toMap.get(m)
      if (toTag === undefined) {
        eraseMinutes.push(m)
      } else if (toTag !== fromTag) {
        if (!paintByTag.has(toTag)) paintByTag.set(toTag, [])
        paintByTag.get(toTag)!.push(m)
      }
    }
    for (const [m, toTag] of toMap) {
      if (!fromMap.has(m)) {
        if (!paintByTag.has(toTag)) paintByTag.set(toTag, [])
        paintByTag.get(toTag)!.push(m)
      }
    }
    if (eraseMinutes.length > 0) await eraseBlocks(selectedDate, eraseMinutes)
    for (const [tagId, mins] of paintByTag) {
      if (mins.length > 0) await paintBlocks(selectedDate, mins, tagId)
    }
  }

  const handleUndo = () => {
    if (undoStack.length === 0) return
    const popped = undoStack[undoStack.length - 1]
    const current = blocks
    setRedoStack((prev) => [...prev.slice(-(UNDO_LIMIT - 1)), current])
    setUndoStack((prev) => prev.slice(0, -1))
    setBlocks(popped)
    void applyBlocksDelta(current, popped)
  }

  const handleRedo = () => {
    if (redoStack.length === 0) return
    const popped = redoStack[redoStack.length - 1]
    const current = blocks
    setUndoStack((prev) => [...prev.slice(-(UNDO_LIMIT - 1)), current])
    setRedoStack((prev) => prev.slice(0, -1))
    setBlocks(popped)
    void applyBlocksDelta(current, popped)
  }

  const eraseSpan = (span: Span) => {
    const mins: number[] = []
    for (let m = span.startMin; m < span.endMin; m += 5) mins.push(m)
    setBlocks((prev) => prev.filter((b) => b.minute < span.startMin || b.minute >= span.endMin))
    eraseBlocks(selectedDate, mins)
  }

  const hasActivityInRange = (start: number, end: number): boolean => {
    for (let m = start; m < end; m += 5) {
      if (blockByMinute.has(m)) return true
    }
    return false
  }

  const hasPlanInRange = (taskId: string, start: number, end: number): boolean =>
    plannedTasksRef.current.some((task) => {
      if (task.id === taskId || task.scheduledStartMin == null) return false
      const taskEnd = task.scheduledStartMin + task.durationMin
      return start < taskEnd && end > task.scheduledStartMin
    })

  const findPlanSlot = (task: PlannedTask): number => {
    const startBase = snapMinute(Math.max(focusStart * 60, isToday ? new Date().getHours() * 60 : 8 * 60))
    const latest = 23 * 60
    for (let m = startBase; m <= latest; m += 5) {
      const end = m + task.durationMin
      if (end > 1440) break
      if (!hasActivityInRange(m, end) && !hasPlanInRange(task.id, m, end)) return m
    }
    return clamp(startBase, 0, 1440 - task.durationMin)
  }

  const scheduleTaskAt = (taskId: string, startMin: number | null) => {
    setPlannedTasks((prev) =>
      prev.map((task) => {
        if (task.id !== taskId) return task
        const start = startMin == null ? findPlanSlot(task) : snapMinute(startMin)
        return {
          ...task,
          scheduledStartMin: clamp(start, 0, 1440 - task.durationMin),
        }
      }),
    )
  }

  const scheduleTaskFromPoint = (taskId: string, pageX: number, pageY: number) => {
    const cell = cellFromPagePoint(pageX, pageY)
    if (cell?.kind === 'full') scheduleTaskAt(taskId, cell.minute)
    else scheduleTaskAt(taskId, null)
  }

  const openComposer = (seed = '') => {
    setComposerTitle(seed)
    setComposerDuration(25)
    setComposerStage('quick')
    setComposerOpen(true)
  }

  const createInboxTask = () => {
    const title = composerTitle.trim()
    if (!title) return
    const meta = inferPlanMeta(title)
    setPlannedTasks((prev) => [
      {
        id: nextPlanId(),
        title,
        icon: meta.icon,
        color: meta.color,
        durationMin: composerDuration,
        scheduledStartMin: null,
      },
      ...prev,
    ])
    setComposerOpen(false)
    setPlanOpen(true)
  }

  const detailTag = detail ? tagById.get(detail.tagId) : undefined
  const detailCat = detailTag ? categoryById.get(detailTag.categoryId) : undefined

  return (
    <View style={styles.root}>
      {/* 日期行 */}
      <View style={styles.dateRow}>
        <Pressable hitSlop={10} onPress={() => setSelectedDate((d) => addDays(d, -1))} style={styles.arrow}>
          <Text style={styles.arrowText}>‹</Text>
        </Pressable>
        <Pressable onPress={() => setSelectedDate(new Date())} style={styles.dateCenter}>
          <Text style={styles.dateText}>{fmtDateLabel(selectedDate)}</Text>
          {!isToday && <Text style={styles.backToday}>回到今天</Text>}
        </Pressable>
        <Pressable hitSlop={10} onPress={() => setSelectedDate((d) => addDays(d, 1))} style={styles.arrow}>
          <Text style={styles.arrowText}>›</Text>
        </Pressable>
      </View>

      {/* 概览 */}
      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          已记录 <Text style={styles.summaryStrong}>{fmtHM(summary.total)}</Text>
          {summary.rows.length > 0 ? ` · ${summary.rows.length} 类` : ''}
        </Text>
        <View style={styles.sumBar}>
          {summary.rows.map((r) => (
            <View key={r.cat.id} style={{ flex: r.mins, backgroundColor: r.cat.color }} />
          ))}
          {summary.total < 1440 && (
            <View style={{ flex: 1440 - summary.total, backgroundColor: theme.line }} />
          )}
        </View>
      </View>

      {/* 整行按钮：idle 状态显示居中的"编辑"主按钮；编辑模式下同位置一组小按钮 */}
      {palette && (
        <View
          style={styles.actionSlot}
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout
            setActionSlotBottom(y + height)
          }}
        >
          {!editMode ? (
            <Pressable onPress={() => setEditMode(true)} style={styles.editFullBtn}>
              <SlidersGlyph color="#FFF" size={15} />
              <Text style={styles.editFullText}>编辑昼夜表</Text>
            </Pressable>
          ) : (
            <View style={styles.editingChips}>
              {/* 搜索按钮：单独入口，点开后自动 focus 输入框 */}
              <Pressable
                onPress={() =>
                  setPickerMode((m) => (m === 'search' ? null : 'search'))
                }
                style={[
                  styles.iconBtn,
                  pickerMode === 'search' && styles.iconBtnActive,
                ]}
              >
                <SearchGlyph
                  color={pickerMode === 'search' ? theme.accent : theme.ink}
                  size={14}
                />
              </Pressable>
              {/* 当前标签按钮：点开浏览模式（不 focus 输入框，直接看标签云） */}
              <Pressable
                onPress={() =>
                  setPickerMode((m) => (m === 'browse' ? null : 'browse'))
                }
                style={[
                  styles.currentTagBtn,
                  pickerMode === 'browse' && styles.currentTagBtnActive,
                ]}
              >
                <Text style={styles.currentTagText} numberOfLines={1}>
                  {selectedTagId != null
                    ? tagById.get(selectedTagId)?.leafName ?? '选标签'
                    : '选标签'}
                </Text>
                <CaretGlyph
                  color={theme.inkSoft}
                  size={9}
                  direction={pickerMode === 'browse' ? 'up' : 'down'}
                />
              </Pressable>
              <Pressable
                onPress={handleUndo}
                disabled={undoStack.length === 0}
                style={[
                  styles.iconBtn,
                  { marginLeft: 'auto' },
                  undoStack.length === 0 && styles.iconBtnDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.iconBtnText,
                    undoStack.length === 0 && styles.iconBtnTextDisabled,
                  ]}
                >↶</Text>
              </Pressable>
              <Pressable
                onPress={handleRedo}
                disabled={redoStack.length === 0}
                style={[
                  styles.iconBtn,
                  redoStack.length === 0 && styles.iconBtnDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.iconBtnText,
                    redoStack.length === 0 && styles.iconBtnTextDisabled,
                  ]}
                >↷</Text>
              </Pressable>
              <Pressable onPress={() => setEditMode(false)} style={styles.donePillBtn}>
                <Text style={styles.donePillText}>完成</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}


      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <View
          style={styles.grid}
          onLayout={(e: LayoutChangeEvent) => {
            gridHRef.current = e.nativeEvent.layout.height
          }}
        >
          {/* 时间轴 */}
          <View style={styles.axis} {...axisPan.panHandlers}>
            {rows.map((row, i) => {
              // 整点 → 加粗 + 更黑（compressed 一定整点；full 行只 startMin % 60 === 0）
              const isHourMark = row.kind === 'compressed' || row.startMin % 60 === 0
              return (
                <View key={i} style={styles.axisCell}>
                  <Text style={[styles.axisText, isHourMark && styles.axisTextHour]}>
                    {row.kind === 'full'
                      ? fmtMinute(row.startMin)
                      : `${row.hours[0]}~${row.hours[row.hours.length - 1]}`}
                  </Text>
                </View>
              )
            })}
          </View>

          {/* 格子区 */}
          <View
            ref={cellAreaRef}
            style={styles.cellArea}
            pointerEvents="box-only"
            onLayout={measureArea}
            {...cellPan.panHandlers}
          >
            {rows.map((row, i) => {
              if (row.kind === 'compressed') {
                return (
                  <View key={i} style={styles.cellRow}>
                    {row.hours.map((h) => {
                      // hour 内按 5min 块合并成 runs，按时间比例铺色
                      const hourRuns: { mins: number; tag: number | null }[] = []
                      for (let m = h * 60; m < h * 60 + 60; m += 5) {
                        const t = blockByMinute.get(m)?.tagId ?? null
                        const last = hourRuns[hourRuns.length - 1]
                        if (last && last.tag === t) last.mins += 5
                        else hourRuns.push({ mins: 5, tag: t })
                      }
                      return (
                        <View key={h} style={styles.cellSlot}>
                          <View style={styles.compressedInner}>
                            {hourRuns.map((run, idx) => {
                              const widthPct = (run.mins / 60) * 100
                              if (run.tag == null) {
                                return (
                                  <View
                                    key={idx}
                                    style={{
                                      width: `${widthPct}%`,
                                      backgroundColor: theme.sunk,
                                    }}
                                  />
                                )
                              }
                              const tagName = tagById.get(run.tag)?.leafName ?? ''
                              const showLabel = run.mins >= 15
                              return (
                                <View
                                  key={idx}
                                  style={{
                                    width: `${widthPct}%`,
                                    backgroundColor: colorOf(run.tag),
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    paddingHorizontal: 4,
                                  }}
                                >
                                  {showLabel ? (
                                    <Text style={styles.cellLabel} numberOfLines={1}>
                                      {tagName}
                                    </Text>
                                  ) : null}
                                </View>
                              )
                            })}
                          </View>
                        </View>
                      )
                    })}
                  </View>
                )
              }
              // 按 horizontal run 渲染色块：row.cols 个 cellSlot 撑 layout + 空格背景，
              // tag run 叠加为整段色块（标签居中，宽度按段调整）。
              // zoom 后 cell 仍 5min；行总分钟 = row.cols * 5（zoom=12 时 60min, zoom=3 时 15min）
              const rowCols = row.cols
              const rowMinutes = rowCols * 5
              const rowStart = row.startMin
              const runs: { l: number; r: number; tag: number }[] = []
              for (let col = 0; col < rowCols; col++) {
                const m = rowStart + col * 5
                const t = blockByMinute.get(m)?.tagId ?? null
                if (t == null) continue
                const last = runs[runs.length - 1]
                if (last && last.tag === t && last.r === col - 1) last.r = col
                else runs.push({ l: col, r: col, tag: t })
              }
              const planRuns = scheduledTasks
                .filter((task): task is PlannedTask & { scheduledStartMin: number } => {
                  if (task.scheduledStartMin == null) return false
                  return task.scheduledStartMin < rowStart + rowMinutes
                    && task.scheduledStartMin + task.durationMin > rowStart
                })
                .map((task) => {
                  const start = Math.max(task.scheduledStartMin, rowStart)
                  const end = Math.min(task.scheduledStartMin + task.durationMin, rowStart + rowMinutes)
                  return { task, start, end }
                })
              return (
                <View key={i} style={styles.cellRow}>
                  {Array.from({ length: rowCols }, (_, col) => (
                    <View key={col} style={styles.cellSlot}>
                      <View style={styles.emptyInner} />
                    </View>
                  ))}
                  {runs.map((run) => {
                    const span = run.r - run.l + 1
                    const leftPct = (run.l / rowCols) * 100
                    const widthPct = (span / rowCols) * 100
                    const tagName = tagById.get(run.tag)?.leafName ?? ''
                    // 段太窄放标签会被压成竖排：12 cols 时单 cell 屏宽 ≈ 50px 不够，
                    // 6/4/3 cols 时单 cell ≥ 100px，单 cell 也能塞下标签
                    const showLabel = span >= 2 || rowCols <= 6
                    return (
                      <View
                        key={`t${run.l}`}
                        style={{
                          position: 'absolute',
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          top: 0,
                          bottom: 0,
                          paddingHorizontal: GAP / 2,
                          paddingVertical: GAP / 2,
                        }}
                        pointerEvents="none"
                      >
                        <View
                          style={{
                            flex: 1,
                            backgroundColor: colorOf(run.tag),
                            borderRadius: R_ACTIVITY,
                            alignItems: 'center',
                            justifyContent: 'center',
                            paddingHorizontal: 8,
                          }}
                        >
                          {showLabel ? (
                            <Text style={styles.cellLabel} numberOfLines={1}>
                              {tagName}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    )
                  })}
                </View>
              )
            })}
          </View>
        </View>
      )}


      {/* composer Modal 已删除（收件箱机制弃用） */}
      <Modal
        visible={false}
        transparent
        animationType="fade"
        onRequestClose={() => setComposerOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setComposerOpen(false)}>
          <Pressable style={styles.composer} onPress={() => {}}>
            <View style={[styles.composerHero, { backgroundColor: alpha(composerMeta.color, 0.88) }]}>
              <Pressable onPress={() => setComposerOpen(false)} style={styles.composerClose}>
                <Text style={styles.composerCloseText}>×</Text>
              </Pressable>
              <View style={styles.composerMain}>
                <View style={styles.composerIconShell}>
                  <Text style={[styles.composerIcon, { color: composerMeta.color }]}>
                    {composerMeta.icon}
                  </Text>
                </View>
                <View style={styles.composerInputWrap}>
                  <Text style={styles.composerMeta}>{composerMeta.label}</Text>
                  <TextInput
                    value={composerTitle}
                    onChangeText={setComposerTitle}
                    placeholder="输入一个计划..."
                    placeholderTextColor="rgba(255,255,255,0.72)"
                    autoFocus
                    style={styles.composerInput}
                    returnKeyType={composerStage === 'quick' ? 'next' : 'done'}
                    onSubmitEditing={() => {
                      if (composerStage === 'quick') setComposerStage('details')
                      else createInboxTask()
                    }}
                  />
                </View>
              </View>
            </View>

            {composerStage === 'quick' ? (
              <View style={styles.suggestionPanel}>
                <Text style={styles.suggestionTitle}>建议</Text>
                {PLAN_SUGGESTIONS.map((item) => {
                  const meta = inferPlanMeta(item)
                  return (
                    <Pressable
                      key={item}
                      style={styles.suggestionRow}
                      onPress={() => {
                        setComposerTitle(item)
                        setComposerStage('details')
                      }}
                    >
                      <View style={[styles.suggestionIcon, { backgroundColor: alpha(meta.color, 0.14) }]}>
                        <Text style={{ color: meta.color, fontWeight: '800' }}>{meta.icon}</Text>
                      </View>
                      <Text style={styles.suggestionText}>{item}</Text>
                      <Text style={styles.suggestionDur}>25 分钟</Text>
                    </Pressable>
                  )
                })}
                <Pressable
                  disabled={!composerTitle.trim()}
                  onPress={() => setComposerStage('details')}
                  style={[styles.composerPrimary, !composerTitle.trim() && styles.composerPrimaryDisabled]}
                >
                  <Text style={styles.composerPrimaryText}>继续</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.detailsPanel}>
                <Text style={styles.detailsTitle}>预计时长</Text>
                <View style={styles.durationRow}>
                  {[15, 25, 45, 60].map((min) => {
                    const on = composerDuration === min
                    return (
                      <Pressable
                        key={min}
                        onPress={() => setComposerDuration(min)}
                        style={[styles.durationChip, on && { backgroundColor: alpha(composerMeta.color, 0.14) }]}
                      >
                        <Text style={[styles.durationText, on && { color: composerMeta.color, fontWeight: '700' }]}>
                          {min} 分钟
                        </Text>
                      </Pressable>
                    )
                  })}
                </View>
                <View style={styles.detailsCard}>
                  <Text style={styles.detailsCardTitle}>创建后先进收件箱</Text>
                  <Text style={styles.detailsCardText}>你可以拖到昼夜表，或者让系统自动找到今天的空档。</Text>
                </View>
                <Pressable
                  disabled={!composerTitle.trim()}
                  onPress={createInboxTask}
                  style={[styles.composerPrimary, !composerTitle.trim() && styles.composerPrimaryDisabled]}
                >
                  <Text style={styles.composerPrimaryText}>创建到收件箱</Text>
                </Pressable>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* 时段详情 */}
      <Modal visible={!!detail} transparent animationType="fade" onRequestClose={() => setDetail(null)}>
        <Pressable style={styles.backdrop} onPress={() => setDetail(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            {detail && (
              <>
                <View style={styles.sheetTop}>
                  <View style={[styles.sheetDot, { backgroundColor: colorOf(detail.tagId) }]} />
                  <Text style={styles.sheetName}>{detailTag?.leafName ?? '活动'}</Text>
                  <Text style={styles.sheetDur}>{fmtHM(detail.endMin - detail.startMin)}</Text>
                </View>
                <Text style={styles.sheetTime}>
                  {fmtMinute(detail.startMin)} – {fmtMinute(detail.endMin)}
                </Text>
                <Text style={styles.sheetPath}>
                  {detailCat?.name ?? ''}
                  {detailTag ? ` · ${detailTag.fullPath}` : ''}
                </Text>
                {detail.note && <Text style={styles.sheetNote}>{detail.note}</Text>}

                <View style={styles.sheetProbe}>
                  <Text style={styles.sheetProbeLabel}>在这段时间手机</Text>
                  {probeLoading ? (
                    <Text style={styles.sheetProbeEmpty}>读取中…</Text>
                  ) : probeEvents.length === 0 ? (
                    <Text style={styles.sheetProbeEmpty}>
                      没有窗口切换记录（可能 Service 未启用、或当时没切 app）
                    </Text>
                  ) : (
                    <>
                      {probeEvents.slice(0, 12).map((ev) => {
                        const label = ev.appLabel || ev.packageName
                        // 标题等于 app 名（或包名）就不重复显示
                        const subtitle =
                          ev.windowTitle && ev.windowTitle !== label && ev.windowTitle !== ev.packageName
                            ? ev.windowTitle
                            : ''
                        const b64 = iconCache[ev.packageName]
                        const initial = (label || '?').slice(0, 1).toUpperCase()
                        return (
                          <View key={ev.rowId} style={styles.sheetProbeRow}>
                            <Text style={styles.sheetProbeTime}>{fmtHHMMms(ev.eventTimeMs)}</Text>
                            {b64 ? (
                              <Image
                                style={styles.sheetProbeIcon}
                                source={{ uri: `data:image/png;base64,${b64}` }}
                              />
                            ) : (
                              <View style={styles.sheetProbeIconFallback}>
                                <Text style={styles.sheetProbeIconText}>{initial}</Text>
                              </View>
                            )}
                            <View style={styles.sheetProbeBody}>
                              <Text style={styles.sheetProbeApp} numberOfLines={1}>{label}</Text>
                              {!!subtitle && (
                                <Text style={styles.sheetProbeSub} numberOfLines={1}>
                                  {subtitle}
                                </Text>
                              )}
                            </View>
                          </View>
                        )
                      })}
                      {probeEvents.length > 12 && (
                        <Text style={styles.sheetProbeMore}>
                          … 还有 {probeEvents.length - 12} 条
                        </Text>
                      )}
                    </>
                  )}
                </View>

                <Pressable
                  style={styles.sheetDelete}
                  onPress={() => {
                    eraseSpan(detail)
                    setDetail(null)
                  }}
                >
                  <Text style={styles.sheetDeleteText}>删除这段记录</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* zoom toast：pinch 切档时屏幕正中悬浮显示 cols × rows */}
      {zoomToast && (
        <View pointerEvents="none" style={styles.zoomToastWrap}>
          <Animated.View style={[styles.zoomToast, { opacity: zoomToastOpacity }]}>
            <Text style={styles.zoomToastText}>{zoomToast}</Text>
          </Animated.View>
        </View>
      )}
      {/* paint toast：拖拽涂色完成后底部显示新合并段起止时间 */}
      {paintToast && (
        <View pointerEvents="none" style={styles.paintToastWrap}>
          <Animated.View style={[styles.paintToast, { opacity: paintToastOpacity }]}>
            <Text style={styles.paintToastName} numberOfLines={1} ellipsizeMode="tail">
              {paintToast.name}
            </Text>
            <Text style={styles.paintToastTime}>{paintToast.time}</Text>
          </Animated.View>
        </View>
      )}
      {/* 删除确认框 */}
      <ConfirmDialog
        open={confirmDelete != null}
        title={confirmDelete?.kind === 'category' ? '删除分类' : '删除标签'}
        body={
          confirmDelete?.kind === 'category'
            ? `分类「${confirmDelete.label}」及其下所有子标签、关联的活动记录都会被删除（软删，可通过 LAN 同步从其他端找回）。`
            : confirmDelete
              ? `标签「${confirmDelete.label}」及关联的活动记录都会被删除（软删，可通过 LAN 同步从其他端找回）。`
              : ''
        }
        confirmText="删除"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={doConfirmDelete}
      />

      {/* 标签云浮层：absolute 紧贴 toolbar 下方 + 自适应贴 DayNightScreen 底部
          DayNightScreen 是 flex:1 占 TabBar 以上空间，bottom:8 即贴近 TabBar 上沿 */}
      {editMode && tagPickerOpen && palette && (
        <View
          style={[
            styles.pickerFloat,
            { top: actionSlotBottom + 4 },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.pickerCloud}>
            {/* 搜索框常驻；search 模式时自动 focus（弹出输入法）；
                × 只清空 query，不关 picker —— 关 picker 由 toolbar 上的按钮负责 */}
            <View style={styles.searchBoxInCloud}>
              <SearchGlyph color={theme.inkSoft} />
              <TextInput
                value={tagQuery}
                onChangeText={setTagQuery}
                placeholder="搜索标签 / 分类..."
                placeholderTextColor={theme.inkSoft}
                autoFocus={pickerMode === 'search'}
                style={styles.searchInput}
              />
              {tagQuery.length > 0 && (
                <Pressable
                  hitSlop={10}
                  onPress={() => setTagQuery('')}
                  style={styles.searchClose}
                >
                  <Text style={styles.searchCloseText}>×</Text>
                </Pressable>
              )}
            </View>
            {/* recent 5 个常用，单独一行常驻在标签云顶部，给"老用户回到熟悉标签"用 */}
            {recentTags.length > 0 && (
              <View style={styles.recentRowInCloud}>
                <Text style={styles.recentLabel}>最近</Text>
                {recentTags.map((tag) => {
                  const on = tag.id === selectedTagId
                  const c = colorOf(tag.id)
                  return (
                    <Pressable
                      key={tag.id}
                      onPress={() => pickTag(tag.id)}
                      style={[
                        styles.recentChip,
                        {
                          backgroundColor: on ? alpha(c, 0.38) : alpha(c, 0.22),
                          borderColor: on ? c : alpha(c, 0.55),
                        },
                      ]}
                    >
                      <Text style={styles.recentChipText} numberOfLines={1}>
                        {tag.leafName}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            )}
            <Text style={styles.pickerHint}>
              {palette.tags.length === 0 ? (
                <>
                  还没有标签 · 在搜索框输入 <Text style={styles.pickerHintStrong}>分类,标签</Text> 创建第一个{'\n'}
                  例：<Text style={styles.pickerHintStrong}>编程,氛围编程</Text> · 或 LAN 同步从 desktop 拉过来
                </>
              ) : tagQuery
                ? `匹配 ${filteredTags.length} / ${palette.tags.length} 个`
                : `全部 ${palette.tags.length} 个标签 · 输入即过滤 · 含 , 可新建 · 长按标签删除`}
            </Text>
            {(() => {
              const trimmed = tagQuery.trim().replace(/^,+|,+$/g, '')
              const segs = trimmed.split(',').map((s) => s.trim()).filter(Boolean)
              if (segs.length < 2) return null
              const normalized = segs.join(',')
              const exists = palette.tags.some((t) => t.fullPath === normalized)
              if (exists) return null
              const isNewCat = !palette.categories.some((c) => c.name === segs[0])
              return (
                <Pressable
                  style={styles.createRow}
                  onPress={async () => {
                    const updated = await createTag(normalized)
                    setPalette(updated)
                    const created = updated.tags.find((t) => t.fullPath === normalized)
                    if (created) pickTag(created.id)
                  }}
                >
                  <Text style={styles.createPlus}>+</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.createMain}>新建标签 「{segs[segs.length - 1]}」</Text>
                    <Text style={styles.createPath}>
                      {segs.slice(0, -1).join(' › ')}
                      {isNewCat && <Text style={styles.createNewCat}>  · 含新分类「{segs[0]}」</Text>}
                    </Text>
                  </View>
                </Pressable>
              )
            })()}
            <ScrollView
              style={styles.treeScrollWrap}
              contentContainerStyle={styles.treeScroll}
              keyboardShouldPersistTaps="always"
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {filteredTags.length === 0 ? (
                <Text style={styles.pickerNoMatch}>没找到匹配的标签</Text>
              ) : (
                buildTagTree(filteredTags, palette.categories).map((root) => (
                  <TagTreeView
                    key={root.fullPath}
                    node={root}
                    depth={0}
                    selectedId={selectedTagId}
                    onPick={pickTag}
                    onLongPressTag={(t) =>
                      setConfirmDelete({ kind: 'tag', id: t.id, label: t.fullPath })
                    }
                    onLongPressCategory={(name) => {
                      const cat = palette.categories.find((c) => c.name === name)
                      if (cat) setConfirmDelete({ kind: 'category', id: cat.id, label: name })
                    }}
                  />
                ))
              )}
            </ScrollView>
          </View>
        </View>
      )}
    </View>
  )
}

function PlanTaskCard({
  task,
  onSchedule,
  onDrop,
}: {
  task: PlannedTask
  onSchedule: () => void
  onDrop: (pageX: number, pageY: number) => void
}) {
  const drag = useRef(new Animated.ValueXY()).current
  const scale = useRef(new Animated.Value(1)).current
  const lastPoint = useRef({ x: 0, y: 0 })

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
      onPanResponderGrant: () => {
        Animated.spring(scale, {
          toValue: 1.04,
          useNativeDriver: true,
          speed: 28,
          bounciness: 6,
        }).start()
      },
      onPanResponderMove: (e, g) => {
        drag.setValue({ x: g.dx, y: g.dy })
        lastPoint.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }
      },
      onPanResponderRelease: () => {
        Animated.parallel([
          Animated.spring(drag, {
            toValue: { x: 0, y: 0 },
            useNativeDriver: true,
            speed: 30,
            bounciness: 7,
          }),
          Animated.spring(scale, {
            toValue: 1,
            useNativeDriver: true,
            speed: 28,
            bounciness: 6,
          }),
        ]).start()
        onDrop(lastPoint.current.x, lastPoint.current.y)
      },
      onPanResponderTerminate: () => {
        drag.setValue({ x: 0, y: 0 })
        scale.setValue(1)
      },
    }),
  ).current

  return (
    <Animated.View
      {...pan.panHandlers}
      style={[
        styles.planCard,
        {
          transform: [{ translateX: drag.x }, { translateY: drag.y }, { scale }],
        },
      ]}
    >
      <View style={[styles.planCardIcon, { backgroundColor: alpha(task.color, 0.14) }]}>
        <Text style={[styles.planCardIconText, { color: task.color }]}>{task.icon}</Text>
      </View>
      <View style={styles.planCardBody}>
        <Text style={styles.planCardMeta}>{task.durationMin} 分钟</Text>
        <Text style={styles.planCardTitle} numberOfLines={1}>{task.title}</Text>
      </View>
      <Pressable onPress={onSchedule} hitSlop={8} style={styles.planCardAdd}>
        <Text style={[styles.planCardAddText, { color: task.color }]}>+</Text>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
  },
  arrow: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowText: {
    fontSize: 24,
    color: theme.inkFaint,
  },
  dateCenter: {
    flex: 1,
    alignItems: 'center',
  },
  dateText: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.ink,
  },
  backToday: {
    fontSize: 11,
    color: theme.accent,
    marginTop: 1,
  },
  editBtn: {
    paddingLeft: 6,
    minWidth: 34,
    alignItems: 'flex-end',
  },
  editText: {
    fontSize: 14,
    color: theme.inkSoft,
  },
  summary: {
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 7,
  },
  summaryText: {
    fontSize: 12.5,
    color: theme.inkSoft,
  },
  summaryStrong: {
    color: theme.ink,
    fontWeight: '600',
  },
  sumBar: {
    height: 6,
    borderRadius: 3,
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: theme.line,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: {
    flex: 1,
    flexDirection: 'row',
    paddingRight: 12,
    paddingBottom: 12,
  },
  axis: {
    width: GUTTER,
  },
  axisCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  axisText: {
    fontSize: 12,
    color: theme.inkSoft,
    letterSpacing: 0.3,
    fontWeight: '500',
  },
  // 整点（含 compressed 区间）加粗 + 更黑，让 zoom=6/4/3 时半点/三分点更弱
  axisTextHour: {
    color: theme.ink,
    fontWeight: '700',
  },
  cellArea: {
    flex: 1,
  },
  cellRow: {
    flex: 1,
    flexDirection: 'row',
  },
  cellSlot: {
    flex: 1,
    position: 'relative',
  },
  emptyInner: {
    position: 'absolute',
    left: GAP / 2,
    right: GAP / 2,
    top: GAP / 2,
    bottom: GAP / 2,
    borderRadius: R_EMPTY,
    backgroundColor: theme.surface,
  },
  compressedInner: {
    position: 'absolute',
    left: GAP / 2,
    right: GAP / 2,
    top: GAP / 2,
    bottom: GAP / 2,
    borderRadius: R_EMPTY,
    overflow: 'hidden',
    flexDirection: 'row',
    backgroundColor: theme.sunk,
  },
  cellLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  // —— 顶部操作槽位：固定高度，idle = 整行居中编辑按钮，editing = 横排小按钮 ——
  actionSlot: {
    height: 56,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  // 主操作按钮（idle）—— 整行宽度，文字居中，深色 + 阴影
  editFullBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 42,
    borderRadius: 12,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOpacity: 0.28,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  editFullText: {
    fontSize: 14.5,
    color: '#FFF',
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  // 编辑模式下的小按钮们（横排）
  editingChips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  searchPillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.line,
    maxWidth: 160,
  },
  searchPillText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: theme.ink,
  },
  // 与右侧 donePillBtn 风格一致：同圆角、同 padding，仅颜色更次要
  iconBtn: {
    width: 38,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: alpha(theme.ink, 0.08),
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnActive: {
    backgroundColor: alpha(theme.accent, 0.16),
  },
  iconBtnDisabled: {
    backgroundColor: alpha(theme.ink, 0.03),
  },
  currentTagBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: alpha(theme.ink, 0.08),
    // flexShrink + minWidth:0 让长标签被截断而不是把右侧 undo/redo/完成挤出屏幕
    // RN View 默认 flexShrink:0，必须显式声明
    flexShrink: 1,
    minWidth: 0,
  },
  currentTagBtnActive: {
    backgroundColor: alpha(theme.accent, 0.16),
  },
  currentTagText: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
    color: theme.ink,
  },
  currentTagChev: {
    fontSize: 10,
    color: theme.inkSoft,
    marginTop: -1,
  },
  iconBtnText: {
    fontSize: 18,
    lineHeight: 18,
    fontWeight: '700',
    color: theme.ink,
    includeFontPadding: false,
    textAlignVertical: 'center',
    // ↶ ↷ unicode glyph 基线偏下，向上推 2px 让视觉中心对齐
    transform: [{ translateY: -2 }],
  },
  iconBtnTextDisabled: {
    color: theme.inkFaint,
  },
  donePillBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  donePillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFF',
  },
  pickerInline: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    maxWidth: 160,
  },
  pickerInlineText: {
    fontSize: 13.5,
    color: theme.ink,
    fontWeight: '600',
  },
  searchBoxInCloud: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 19,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.accent,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: theme.ink,
    padding: 0,
    margin: 0,
  },
  searchClose: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchCloseText: {
    fontSize: 18,
    color: theme.inkSoft,
    lineHeight: 18,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
  },
  recentEmpty: {
    fontSize: 11,
    color: theme.inkSoft,
    fontStyle: 'italic',
  },
  recentChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    maxWidth: 90,
    borderWidth: 1,
  },
  recentChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.ink,
  },
  // 标签云浮层容器：absolute 紧贴 toolbar 下方，左右贴边，bottom:8 贴 DayNightScreen 底
  // pickerCloud 用 flex:1 撑满，让标签列表 ScrollView 自适应剩余高度（不再固定 460）
  // box-none 让点击穿透到下方昼夜表（仅 pickerCloud 自己接事件）
  pickerFloat: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 8,
  },
  zoomToastWrap: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomToast: {
    paddingHorizontal: 22,
    paddingVertical: 12,
    backgroundColor: 'rgba(20,22,28,0.78)',
    borderRadius: 14,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  zoomToastText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#FFF',
    letterSpacing: 1.2,
    fontVariant: ['tabular-nums'],
  },
  paintToastWrap: {
    position: 'absolute',
    left: 0, right: 0, bottom: 24,
    alignItems: 'center',
  },
  paintToast: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: 'rgba(20,22,28,0.85)',
    borderRadius: 18,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
    maxWidth: '88%',     // 留 12% 给两边屏边距，避免顶到边缘
    gap: 10,
  },
  paintToastName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFF',
    letterSpacing: 0.3,
    flexShrink: 1,        // 太长允许缩并 ellipsize
    minWidth: 0,
  },
  paintToastTime: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: 0.3,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,        // 时间永远完整可见
  },
  pickerCloud: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 14,
    borderWidth: 1,
    borderColor: theme.line,
  },
  // ScrollView 自己撑满 pickerCloud 内剩余空间（搜索框 + recents + hint 之下）
  // 不给固定 flex 的 ScrollView 在 Android 偶发不响应触摸 / 不滚动
  treeScrollWrap: {
    flex: 1,
  },
  recentRowInCloud: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line,
  },
  recentLabel: {
    fontSize: 11,
    color: theme.inkSoft,
    marginRight: 4,
    letterSpacing: 0.3,
  },
  pickerHint: {
    fontSize: 11,
    color: theme.inkSoft,
    marginBottom: 10,
    letterSpacing: 0.3,
    lineHeight: 18,
  },
  pickerHintStrong: {
    color: theme.accent,
    fontWeight: '700',
  },
  pickerWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    paddingBottom: 14,
  },
  treeScroll: {
    paddingBottom: 14,
  },
  createRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: alpha(theme.accent, 0.08),
    borderWidth: 1,
    borderColor: alpha(theme.accent, 0.35),
    borderStyle: 'dashed',
    borderRadius: 11,
    marginBottom: 10,
  },
  createPlus: {
    fontSize: 18,
    color: theme.accent,
    fontWeight: '700',
  },
  createMain: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.ink,
  },
  createPath: {
    fontSize: 11,
    color: theme.inkSoft,
    marginTop: 1,
  },
  createNewCat: {
    color: theme.accent,
    fontWeight: '600',
  },
  pickerChip: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 13,
    borderWidth: 1,
  },
  pickerChipText: {
    fontSize: 12.5,
    fontWeight: '600',
  },
  pickerNoMatch: {
    fontSize: 13,
    color: theme.inkSoft,
    paddingVertical: 12,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,24,0.18)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: 'rgba(255,255,255,0.94)',
    marginHorizontal: 10,
    marginBottom: 14,
    borderRadius: 22,
    paddingHorizontal: 22,
    paddingBottom: 24,
    paddingTop: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.line,
    marginBottom: 18,
  },
  sheetTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  sheetDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
  },
  sheetName: {
    fontSize: 18,
    fontWeight: '600',
    color: theme.ink,
  },
  sheetDur: {
    marginLeft: 'auto',
    fontSize: 13,
    color: theme.inkSoft,
  },
  sheetTime: {
    fontSize: 22,
    fontWeight: '600',
    color: theme.ink,
    marginTop: 12,
  },
  sheetPath: {
    fontSize: 13,
    color: theme.inkSoft,
    marginTop: 5,
  },
  sheetNote: {
    fontSize: 14,
    color: theme.ink,
    marginTop: 12,
    lineHeight: 21,
  },
  sheetDelete: {
    marginTop: 22,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: theme.bg,
    alignItems: 'center',
  },
  sheetDeleteText: {
    fontSize: 14,
    color: theme.danger,
    fontWeight: '500',
  },
  sheetProbe: {
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.08)',
  },
  sheetProbeLabel: {
    fontSize: 11,
    color: theme.inkSoft,
    marginBottom: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  sheetProbeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    gap: 10,
  },
  sheetProbeTime: {
    fontSize: 12,
    color: theme.inkSoft,
    width: 44,
    fontVariant: ['tabular-nums'],
  },
  sheetProbeIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  sheetProbeIconFallback: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetProbeIconText: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.inkSoft,
  },
  sheetProbeBody: {
    flex: 1,
  },
  sheetProbeApp: {
    fontSize: 14,
    color: theme.ink,
    fontWeight: '500',
  },
  sheetProbeSub: {
    fontSize: 11,
    color: theme.inkSoft,
    marginTop: 1,
  },
  sheetProbeEmpty: {
    fontSize: 12,
    color: theme.inkSoft,
    fontStyle: 'italic',
  },
  sheetProbeMore: {
    fontSize: 11,
    color: theme.inkSoft,
    marginTop: 6,
  },
})
