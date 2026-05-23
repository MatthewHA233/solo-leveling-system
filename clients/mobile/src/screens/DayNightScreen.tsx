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
import { alpha, theme } from '../theme'
import type {
  ActivityBlock,
  ActivityCategory,
  ActivityPalette,
  ActivityTag,
} from '../types'
import { createTag, eraseBlocks, fetchBlocks, fetchPalette, paintBlocks } from '../lib/api'
import { addDays, fmtDateLabel, fmtMinute, isSameDay, toLocalDateStr } from '../lib/time'
import { getAppIcons, getWindowEventsInRange, type WindowEvent } from '../lib/perception'

const FULL_ROWS = 18
const FULL_COLS = 12
const GUTTER = 46
const GAP = 4
const R_ACTIVITY = 14
const R_EMPTY = 5

interface Span {
  startMin: number
  endMin: number
  tagId: number
  note: string | null
}

type Row =
  | { kind: 'full'; hour: number }
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

function buildRows(focusStart: number): Row[] {
  const rows: Row[] = []
  const top: number[] = []
  for (let h = 0; h < focusStart; h++) top.push(h)
  if (top.length > 0) rows.push({ kind: 'compressed', hours: top })
  for (let h = focusStart; h < focusStart + FULL_ROWS; h++) rows.push({ kind: 'full', hour: h })
  const bot: number[] = []
  for (let h = focusStart + FULL_ROWS; h < 24; h++) bot.push(h)
  if (bot.length > 0) rows.push({ kind: 'compressed', hours: bot })
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
}: {
  node: TagTreeNode
  depth: number
  selectedId: number | null
  onPick: (id: number) => void
}) {
  // 叶子：无 children 且有 tag → 单 chip
  if (node.children.length === 0 && node.tag) {
    const on = node.tag.id === selectedId
    const c = node.catColor
    return (
      <Pressable
        onPress={() => onPick(node.tag!.id)}
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
        disabled={node.tag == null}
        onPress={() => node.tag && onPick(node.tag.id)}
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
  mode: 'paint' | 'erase'
  startMin: number | null      // 拖拽起点（5min 对齐）
  lastMin: number | null       // 上一次 move 命中的 minute
  painted: Set<number>         // 本次拖拽最终涂过的 mins（按目标区间，每次 move 重算）
  snapshot: ActivityBlock[]    // 拖拽前的 blocks 快照，用于"区间反向"时恢复
  moved: boolean
  tapCell: HitCell | null
}

export default function DayNightScreen() {
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const [palette, setPalette] = useState<ActivityPalette | null>(null)
  const [blocks, setBlocks] = useState<ActivityBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null)
  const [recentTagIds, setRecentTagIds] = useState<number[]>([])
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [tagQuery, setTagQuery] = useState('')
  const [detail, setDetail] = useState<Span | null>(null)
  const [probeEvents, setProbeEvents] = useState<WindowEvent[]>([])
  const [probeLoading, setProbeLoading] = useState(false)
  const [iconCache, setIconCache] = useState<Record<string, string>>({})
  const [focusStart, setFocusStart] = useState(3)
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
    snapshot: [],
    moved: false,
    tapCell: null,
  })
  const plannedTasksRef = useRef<PlannedTask[]>([])

  focusStartRef.current = focusStart
  plannedTasksRef.current = plannedTasks

  useEffect(() => {
    let alive = true
    fetchPalette().then((p) => {
      if (!alive) return
      setPalette(p)
      setSelectedTagId(p.tags[0]?.id ?? null)
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

  // detail span 打开时，按时段拉对应窗口切换事件
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

  // 选标签 + LRU 推进 + 更新 lastUsedAt + 关闭 picker
  const pickTag = (id: number) => {
    setSelectedTagId(id)
    setRecentTagIds((prev) => [id, ...prev.filter((x) => x !== id)].slice(0, 8))
    if (palette) {
      const now = new Date().toISOString()
      let changed = false
      const nextTags = palette.tags.map((t) => {
        if (t.id === id) {
          changed = true
          return { ...t, lastUsedAt: now }
        }
        return t
      })
      if (changed) setPalette({ ...palette, tags: nextTags })
    }
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

  const recentTags = useMemo(() => {
    if (!palette) return []
    return recentTagIds
      .map((id) => palette.tags.find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .slice(0, 5)
  }, [palette, recentTagIds])

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
  const rows = useMemo(() => buildRows(focusStart), [focusStart])

  // 同步 refs
  interactionRef.current = { editMode, selectedTagId, rows, blocks, blockByMinute, spans, selectedDate }

  // ── 点 → 命中格子 ──
  const cellFromPoint = (px: number, py: number): HitCell | null => {
    const area = areaRef.current
    const rs = interactionRef.current.rows
    if (area.h <= 0 || rs.length === 0) return null
    const lx = px - area.x
    const ly = py - area.y
    if (lx < 0 || ly < 0 || lx > area.w || ly > area.h) return null
    const rowH = area.h / rs.length
    const row = rs[clamp(Math.floor(ly / rowH), 0, rs.length - 1)]
    if (row.kind === 'full') {
      const col = clamp(Math.floor(lx / (area.w / FULL_COLS)), 0, FULL_COLS - 1)
      return { kind: 'full', hour: row.hour, col, minute: row.hour * 60 + col * 5 }
    }
    const col = clamp(Math.floor(lx / (area.w / row.hours.length)), 0, row.hours.length - 1)
    return { kind: 'compressed', hour: row.hours[col] }
  }

  // 把"起点 minute → 当前 minute"区间内所有 5min 格按拖拽模式应用
  // 始终基于 snapshot 重建，反向拖能自然回退
  const applyRange = (currMin: number) => {
    const d = dragRef.current
    if (d.startMin == null) return
    const { selectedTagId: tagId, selectedDate: date } = interactionRef.current
    if (d.mode === 'paint' && tagId == null) return

    const lo = Math.min(d.startMin, currMin)
    const hi = Math.max(d.startMin, currMin)
    const target = new Set<number>()
    for (let m = lo; m <= hi; m += 5) target.add(m)

    if (d.mode === 'paint') {
      const next = d.snapshot.filter((b) => !target.has(b.minute))
      const stamp = new Date().toISOString()
      const dateStr = toLocalDateStr(date)
      target.forEach((m) => {
        next.push({ date: dateStr, minute: m, tagId: tagId as number, note: null, createdAt: stamp })
      })
      setBlocks(next)
    } else {
      // erase：删除区间内所有原有 block（不限 tag）
      setBlocks(d.snapshot.filter((b) => !target.has(b.minute)))
    }
    d.painted = target
  }

  // ── 格子区手势：编辑拖拽涂色 / 查看点按详情 ──
  const cellPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const cell = cellFromPoint(e.nativeEvent.pageX, e.nativeEvent.pageY)
        const { editMode: em, blockByMinute: bm, selectedTagId: tagId } = interactionRef.current
        const d: DragState = {
          mode: 'paint',
          startMin: cell && cell.kind === 'full' ? cell.minute : null,
          lastMin: cell && cell.kind === 'full' ? cell.minute : null,
          painted: new Set(),
          snapshot: interactionRef.current.blocks,
          moved: false,
          tapCell: cell,
        }
        dragRef.current = d
        if (em && cell && cell.kind === 'full') {
          // 起点同色 → 整段擦除；空格或异色 → 整段覆盖成当前画笔色
          const existing = bm.get(cell.minute)
          d.mode = existing != null && existing === tagId ? 'erase' : 'paint'
          applyRange(cell.minute)
        }
      },
      onPanResponderMove: (e, g) => {
        if (Math.abs(g.dx) + Math.abs(g.dy) > 8) dragRef.current.moved = true
        if (!interactionRef.current.editMode) return
        const d = dragRef.current
        if (d.startMin == null) return
        const cell = cellFromPoint(e.nativeEvent.pageX, e.nativeEvent.pageY)
        if (!cell || cell.kind !== 'full') return
        if (cell.minute === d.lastMin) return
        d.lastMin = cell.minute
        applyRange(cell.minute)
      },
      onPanResponderRelease: () => {
        const d = dragRef.current
        const { editMode: em, selectedTagId: tagId, spans: sp, selectedDate: date } =
          interactionRef.current
        if (em) {
          const mins = Array.from(d.painted)
          if (mins.length === 0) return
          if (d.mode === 'paint' && tagId != null) {
            paintBlocks(date, mins, tagId)
          } else if (d.mode === 'erase') {
            eraseBlocks(date, mins)
          }
          return
        }
        if (d.moved || !d.tapCell) return
        if (d.tapCell.kind === 'full') {
          const min = d.tapCell.minute
          const span = sp.find((s) => min >= s.startMin && min < s.endMin)
          if (span) setDetail(span)
        } else {
          const h = d.tapCell.hour
          setFocusStart(clamp(h > 17 ? h - 17 : h, 0, 6))
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
        const rowH = gridHRef.current > 0 ? gridHRef.current / 20 : 40
        const next = clamp(focusBaseRef.current + Math.round(-g.dy / rowH), 0, 6)
        setFocusStart((cur) => (cur === next ? cur : next))
      },
    }),
  ).current

  const measureArea = () => {
    cellAreaRef.current?.measureInWindow((x, y, w, h) => {
      areaRef.current = { x, y, w, h }
    })
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
    const cell = cellFromPoint(pageX, pageY)
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
        <View style={styles.actionSlot}>
          {!editMode ? (
            <Pressable onPress={() => setEditMode(true)} style={styles.editFullBtn}>
              <SlidersGlyph color="#FFF" size={15} />
              <Text style={styles.editFullText}>编辑昼夜表</Text>
            </Pressable>
          ) : (
            <View style={styles.editingChips}>
              <Pressable
                onPress={() => setTagPickerOpen(true)}
                style={styles.searchPillBtn}
              >
                <SearchGlyph color={theme.inkSoft} size={13} />
                <Text style={styles.searchPillText} numberOfLines={1}>
                  {selectedTagId != null
                    ? tagById.get(selectedTagId)?.leafName ?? '选标签'
                    : '选标签'}
                </Text>
              </Pressable>
              {recentTags.slice(0, 4).map((tag) => {
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
              <Pressable
                onPress={() => setEditMode(false)}
                style={[styles.donePillBtn, { marginLeft: 'auto' }]}
              >
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
            {rows.map((row, i) => (
              <View key={i} style={styles.axisCell}>
                <Text style={styles.axisText}>
                  {row.kind === 'full'
                    ? `${row.hour}:00`
                    : `${row.hours[0]}~${row.hours[row.hours.length - 1]}`}
                </Text>
              </View>
            ))}
          </View>

          {/* 格子区 */}
          <View
            ref={cellAreaRef}
            style={styles.cellArea}
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
              // 按 horizontal run 渲染色块：12 个 cellSlot 撑 layout + 空格背景，
              // tag run 叠加为整段色块（标签居中，宽度按段调整）
              const runs: { l: number; r: number; tag: number }[] = []
              for (let col = 0; col < FULL_COLS; col++) {
                const t = tagAt(row.hour, col)
                if (t == null) continue
                const last = runs[runs.length - 1]
                if (last && last.tag === t && last.r === col - 1) last.r = col
                else runs.push({ l: col, r: col, tag: t })
              }
              const planRuns = scheduledTasks
                .filter((task): task is PlannedTask & { scheduledStartMin: number } => {
                  if (task.scheduledStartMin == null) return false
                  return task.scheduledStartMin < row.hour * 60 + 60
                    && task.scheduledStartMin + task.durationMin > row.hour * 60
                })
                .map((task) => {
                  const rowStart = row.hour * 60
                  const start = Math.max(task.scheduledStartMin, rowStart)
                  const end = Math.min(task.scheduledStartMin + task.durationMin, rowStart + 60)
                  return { task, start, end }
                })
              return (
                <View key={i} style={styles.cellRow}>
                  {Array.from({ length: FULL_COLS }, (_, col) => (
                    <View key={col} style={styles.cellSlot}>
                      <View style={styles.emptyInner} />
                    </View>
                  ))}
                  {runs.map((run) => {
                    const span = run.r - run.l + 1
                    const leftPct = (run.l / FULL_COLS) * 100
                    const widthPct = (span / FULL_COLS) * 100
                    const tagName = tagById.get(run.tag)?.leafName ?? ''
                    // 段太窄（≤1 cell = 5min）放标签会被压成竖排，干脆不显示
                    const showLabel = span >= 2
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

      {/* 编辑模式 · 标签云浮层（顶部展开 + 蒙版盖住下方昼夜表） */}
      {editMode && tagPickerOpen && palette && (
        <Pressable
          style={styles.pickerBackdrop}
          onPress={() => {
            setTagPickerOpen(false)
            setTagQuery('')
          }}
        >
          <Pressable style={styles.pickerCloud} onPress={() => {}}>
            {/* 标签云顶部内嵌搜索框 */}
            <View style={styles.searchBoxInCloud}>
              <SearchGlyph color={theme.inkSoft} />
              <TextInput
                value={tagQuery}
                onChangeText={setTagQuery}
                placeholder="搜索标签 / 分类..."
                placeholderTextColor={theme.inkSoft}
                autoFocus
                style={styles.searchInput}
              />
              <Pressable
                hitSlop={10}
                onPress={() => {
                  setTagPickerOpen(false)
                  setTagQuery('')
                }}
                style={styles.searchClose}
              >
                <Text style={styles.searchCloseText}>×</Text>
              </Pressable>
            </View>
            <Text style={styles.pickerHint}>
              {tagQuery
                ? `匹配 ${filteredTags.length} / ${palette.tags.length} 个`
                : `全部 ${palette.tags.length} 个标签 · 输入即过滤 · 含 , 可新建`}
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
              contentContainerStyle={styles.treeScroll}
              keyboardShouldPersistTaps="always"
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
                  />
                ))
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
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
  pickerBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(245,246,248,0.85)',
  },
  pickerCloud: {
    position: 'absolute',
    top: 140,
    left: 10,
    right: 10,
    maxHeight: '70%',
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 14,
    borderWidth: 1,
    borderColor: theme.line,
  },
  pickerHint: {
    fontSize: 11,
    color: theme.inkSoft,
    marginBottom: 10,
    letterSpacing: 0.3,
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
