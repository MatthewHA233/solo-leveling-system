// ══════════════════════════════════════════════
// 昼夜表 — 鱼眼焦点网格
// 18 完整行（12×5min）+ 上下缩进行（1hr/格）
// 同一事件的格子连为一体 · 编辑模式拖拽涂色（可跨行）
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  AppState,
  DeviceEventEmitter,
  Image,
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native'
import type { LayoutChangeEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, Line, Path, Pattern, Rect } from 'react-native-svg'
import CalendarPopover from '../components/CalendarPopover'
import ConfirmDialog from '../components/ConfirmDialog'
import SharedDateHeader from '../components/SharedDateHeader'
import { alpha, theme } from '../theme'
import type {
  ActivityBlock,
  ActivityCategory,
  ActivityPalette,
  ActivityTag,
  PlanNode,
  PlannedBlock,
  RecordLayer,
} from '../types'
import {
  CATEGORY_PALETTE_COLORS, createTag, deleteCategory, deleteTag, eraseBlocks, erasePlannedBlocks, fetchAllPlanNodes,
  fetchBlocks, fetchPalette, fetchPlannedBlocks, paintBlocks, paintPlannedBlocks, renameCategory, renameTagPath,
} from '../lib/api'
import PlanSheet from '../components/daynight/PlanSheet'
import { DAYNIGHT_CHANGED_EVENT } from '../lib/islands/island-api'
import { islandColor } from '../lib/islands/island-model'
import type { IslandPlacement } from '../lib/islands/island-model'
import { useIslands } from '../lib/islands/use-islands'
import { DAY_PERIOD_START_HOURS, dayPeriodForHour, type DayPeriodInfo } from '../lib/dayPeriods'
import { loadDayNightZoomPrefs, saveDayNightZoomPrefs } from '../lib/prefs'
import { fmtMinute, isSameDay, toLocalDateStr } from '../lib/time'
import { getAppIcons, getAppMonitorSegmentsInRange, type AppMonitorSegment } from '../lib/perception'

const GUTTER = 46
const GAP = 4
const R_ACTIVITY = 14
const R_EMPTY = 5

// zoom 双轴矩阵：
//   cols（横向放大，pinch 双指水平展开）：12 / 6 / 4 / 3 → 一行 60/30/20/15 min
//   totalRows（纵向放大，pinch 双指垂直展开）：24..14 → 屏上行数 = 行高反比
//
// 每个 (cols, totalRows) 组合自动算 (focusRows, topTiers, botTiers)：
//   focusRows × cols / 12 必须是整数 hour（约束 1）
//   focusRows + topTiers + botTiers = totalRows（约束 2）
//   topTiers + botTiers ≥ 1 仅当 rest > 0（约束 3：有 hour 要装才需要 tier）
type ZoomCols = 12 | 6 | 4 | 3
const ZOOM_LEVELS: readonly ZoomCols[] = [12, 6, 4, 3] as const
// totalRows 候选：24 默认（最稀疏），14 最紧凑。从稀疏到紧凑排
const TOTAL_ROWS_LEVELS = [24, 22, 20, 18, 16, 14] as const
type TotalRows = typeof TOTAL_ROWS_LEVELS[number]
// cols=12 → 1（focus rows 任意），6 → 2，4 → 3，3 → 4
const COLS_R_FACTOR: Record<ZoomCols, number> = { 12: 1, 6: 2, 4: 3, 3: 4 }

const MAX_HOURS_PER_TIER = 6  // 每个 compressed 行最多装 6 小时

interface RowConfig { focusRows: number }

// 用 totalRows 反推 focusRows：枚举所有合法 focusStart 取最坏 tier 总数
// （AUDIT-027：之前用单边 ceil(rest/6) 估算，居中场景 top+bot 两边非整 6 时
// 实际 ceil(top/6) + ceil(bot/6) 可能比单边多 1，导致 buildRows().length > totalRows）
function computeRowConfig(cols: ZoomCols, totalRows: number): RowConfig {
  const rFactor = COLS_R_FACTOR[cols]
  const rMax = Math.floor((24 * 12) / cols / rFactor) * rFactor
  for (let R = rMax; R >= 0; R -= rFactor) {
    const focusH = (R * cols) / 12
    const rest = 24 - focusH
    let worstTier = 0
    if (rest > 0) {
      // 枚举 top = k hour, bot = (rest - k) hour，k ∈ [0, rest]
      for (let k = 0; k <= rest; k++) {
        const topTiers = k > 0 ? Math.ceil(k / MAX_HOURS_PER_TIER) : 0
        const botTiers = rest - k > 0 ? Math.ceil((rest - k) / MAX_HOURS_PER_TIER) : 0
        const sum = topTiers + botTiers
        if (sum > worstTier) worstTier = sum
      }
    }
    if (R + worstTier <= totalRows) {
      return { focusRows: R }
    }
  }
  return { focusRows: 0 }
}

function zoomFocusHours(cols: ZoomCols, totalRows: number): number {
  return (computeRowConfig(cols, totalRows).focusRows * cols) / 12
}

interface Span {
  startMin: number
  endMin: number
  tagId: number
  note: string | null
}

type ProbeAppRun = {
  key: string
  packageName: string
  appLabel: string
  startMs: number
  endMs: number
  eventCount: number
  titles: string[]
}

type Row =
  | { kind: 'full'; startMin: number; cols: number }
  | { kind: 'compressed'; hours: number[] }

type DayPeriodSegment = DayPeriodInfo & {
  key: string
  hours: number
}

type HitCell =
  | { kind: 'full'; hour: number; col: number; minute: number }
  | { kind: 'compressed'; hour: number }

// SolevupDbChanged 的 changed 里这几项有变化才重读昼夜表（名字见 SyncServerModule.onDbChanged）
const DAYNIGHT_SYNC_KEYS = [
  'activityCategories', 'activityTags', 'activityBlocks',
  'planNodes', 'plannedBlocks', 'planIslands', 'planIslandChecks',
] as const

// 空 palette 时一键初始化的默认分类 + 标签（与 desktop ActivityTagPalette
// DEFAULT_PALETTE 一致，让 desktop / mobile 用户初次体验对齐）
// 不预置"编程"分类 — 不是所有人都适合
const DEFAULT_PALETTE: ReadonlyArray<{ name: string; color: string; tags: ReadonlyArray<string> }> = [
  { name: '工作', color: '#38BDF8', tags: ['会议', '写文档', '日报周报', '沟通协调'] },
  { name: '学习', color: '#2DD4BF', tags: ['看书', '看视频课', '做笔记', '复盘'] },
  { name: '生活', color: '#F97316', tags: ['做饭', '吃饭', '洗漱', '采购', '通勤'] },
  { name: '运动', color: '#14B8A6', tags: ['跑步', '健身', '散步'] },
  { name: '休息', color: '#84CC16', tags: ['睡觉', '午休', '小憩', '冥想'] },
  { name: '娱乐', color: '#FB7185', tags: ['看视频', '玩游戏', '刷手机'] },
  { name: '杂项', color: '#F97316', tags: ['临时事项', '等待', '整理'] },
]

function suggestCategoryColor(categories: ActivityCategory[]): string {
  const used = new Set(categories.map((c) => c.color))
  return CATEGORY_PALETTE_COLORS.find((c) => !used.has(c)) ??
    CATEGORY_PALETTE_COLORS[categories.length % CATEGORY_PALETTE_COLORS.length]
}

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

function buildRows(focusStart: number, zoomCols: ZoomCols, totalRows: number): Row[] {
  const cfg = computeRowConfig(zoomCols, totalRows)
  const focusH = (cfg.focusRows * zoomCols) / 12
  const safeStart = clamp(focusStart, 0, 24 - focusH)
  const rows: Row[] = []

  // 上方 compressed：tier 行数 = ceil(topHours / 6)，每行装 ≤ 6 hour（自动新建行）
  const topHours: number[] = []
  for (let h = 0; h < safeStart; h++) topHours.push(h)
  if (topHours.length > 0) {
    const topTiers = Math.ceil(topHours.length / MAX_HOURS_PER_TIER)
    const chunk = Math.ceil(topHours.length / topTiers)
    for (let i = 0; i < topTiers; i++) {
      const slice = topHours.slice(i * chunk, (i + 1) * chunk)
      if (slice.length > 0) rows.push({ kind: 'compressed', hours: slice })
    }
  }

  // focus
  const startMin = safeStart * 60
  const minutesPerRow = zoomCols * 5
  for (let i = 0; i < cfg.focusRows; i++) {
    rows.push({ kind: 'full', startMin: startMin + i * minutesPerRow, cols: zoomCols })
  }

  // 下方 compressed：同上规则
  const botHours: number[] = []
  for (let h = safeStart + focusH; h < 24; h++) botHours.push(h)
  if (botHours.length > 0) {
    const botTiers = Math.ceil(botHours.length / MAX_HOURS_PER_TIER)
    const chunk = Math.ceil(botHours.length / botTiers)
    for (let i = 0; i < botTiers; i++) {
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

function fmtMsDuration(ms: number): string {
  if (ms < 60_000) return '<1 分'
  return fmtHM(Math.max(1, Math.round(ms / 60_000)))
}

function buildProbeAppRuns(segments: AppMonitorSegment[], segmentEndMs: number): ProbeAppRun[] {
  return segments
    .filter((seg) => seg.kind === 'app')
    .sort((a, b) => a.startMs - b.startMs || a.rowId - b.rowId)
    .map((seg) => ({
      key: `run-${seg.rowId}`,
      packageName: seg.packageName,
      appLabel: seg.appLabel || seg.packageName,
      startMs: seg.startMs,
      endMs: Math.max(seg.startMs, Math.min(seg.endMs || seg.startMs, segmentEndMs)),
      eventCount: Math.max(1, seg.eventCount || 1),
      titles: Array.isArray(seg.titles) ? seg.titles : [],
    }))
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function rowStartHour(row: Row): number {
  return row.kind === 'full' ? Math.floor(row.startMin / 60) : row.hours[0]
}

function shouldShowPeriodLabel(row: Row): boolean {
  if (row.kind === 'compressed') {
    return row.hours.some((h) => DAY_PERIOD_START_HOURS.includes(h as typeof DAY_PERIOD_START_HOURS[number]))
  }
  const h = Math.floor(row.startMin / 60)
  return row.startMin % 60 === 0 && DAY_PERIOD_START_HOURS.includes(h as typeof DAY_PERIOD_START_HOURS[number])
}

function rowPeriodSegments(row: Row): DayPeriodSegment[] {
  const hours = row.kind === 'full' ? [Math.floor(row.startMin / 60)] : row.hours
  const segs: DayPeriodSegment[] = []
  for (const h of hours) {
    const info = dayPeriodForHour(h)
    const last = segs[segs.length - 1]
    if (last && last.label === info.label) {
      last.hours += 1
    } else {
      segs.push({ ...info, key: `${info.label}-${h}`, hours: 1 })
    }
  }
  return segs
}

function periodLabelSegmentsForRow(row: Row): DayPeriodSegment[] {
  if (row.kind === 'compressed') return rowPeriodSegments(row)
  return shouldShowPeriodLabel(row) ? rowPeriodSegments(row) : []
}

function paletteSignature(p: ActivityPalette): string {
  const cats = [...p.categories]
    .sort((a, b) => a.id - b.id)
    .map((c) => `${c.id}:${c.name}:${c.color}:${c.sortOrder}:${c.lastUsedAt}`)
    .join('|')
  const tags = [...p.tags]
    .sort((a, b) => a.id - b.id)
    .map((t) => `${t.id}:${t.categoryId}:${t.fullPath}:${t.leafName}:${t.depth}:${t.lastUsedAt}`)
    .join('|')
  return `${cats}#${tags}`
}

function blocksSignature(bs: ActivityBlock[]): string {
  return [...bs]
    .sort((a, b) => a.minute - b.minute)
    .map((b) => `${b.date}:${b.minute}:${b.tagId}:${b.note ?? ''}:${b.createdAt}`)
    .join('|')
}

function mostRecentTagId(p: ActivityPalette): number | null {
  const mostRecent = [...p.tags]
    .filter((t) => !!t.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0]
  return mostRecent?.id ?? null
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
  // 过滤空 root（无命中 tag 的 category），并按 root 的最新度排序。
  // 只有一段的标签（用户只建了分类名）也保留为 root 行，方便继续加子节点/改色。
  return roots
    .filter((r) => r.children.length > 0 || r.tag != null)
    .sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)))
}

/** 递归渲染标签树节点。叶子 = chip；分支 = 嵌套 box；分支自身有 tag 时 box 头部可点击。 */
function TagTreeView({
  node,
  depth,
  selectedId,
  onPick,
  onPickPath,
  onOpenCategoryColor,
  onLongPressTag,
  onLongPressCategory,
}: {
  node: TagTreeNode
  depth: number
  selectedId: number | null
  onPick: (id: number) => void
  onPickPath?: (fullPath: string) => void
  onOpenCategoryColor?: (categoryName: string) => void
  onLongPressTag: (tag: ActivityTag) => void
  onLongPressCategory: (categoryName: string) => void
}) {
  // 叶子：无 children 且有 tag → 单 chip
  if (depth > 0 && node.children.length === 0 && node.tag) {
    const on = node.tag.id === selectedId
    const c = node.catColor
    return (
      <Pressable
        onPress={() => {
          if (onPickPath) onPickPath(node.fullPath)
          else onPick(node.tag!.id)
        }}
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
  // 分支：嵌套 box；children 按使用新旧统一排序混合渲染 —— leaf 是流式
  // chip，branch box 占整行（width 100% 在 wrap 容器里自动断行），
  // 有无子节点不再分组分开排
  const onHeader = node.tag != null && node.tag.id === selectedId
  // 深层折叠：三级 box（depth>=2）内的子标签超过 ~4 行时默认裁断，
  // 点省略提示展开。整高由内层 wrap 的 onLayout 报告（外层裁不影响内层布局）
  const [kidsExpanded, setKidsExpanded] = useState(false)
  const [kidsFullH, setKidsFullH] = useState(0)
  const KIDS_COLLAPSE_H = 4 * 32 + 3 * 5 + 1 // 恰好 4 行 chip（含底边框）
  const collapsible = depth >= 2 && kidsFullH > KIDS_COLLAPSE_H + 36 // 至少多出一行才折
  const kidsClipped = collapsible && !kidsExpanded
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
      <View style={treeStyles.headerRow}>
        <Pressable
          onPress={() => {
            if (onPickPath) onPickPath(node.fullPath)
            else if (node.tag) onPick(node.tag.id)
          }}
          onLongPress={() => {
            if (depth === 0) onLongPressCategory(node.segment)
            else if (node.tag) onLongPressTag(node.tag)
            // 中间分支节点（非 root 也无 tag）= 虚拟段，没法删，不响应长按
          }}
          delayLongPress={400}
          style={treeStyles.headerPickArea}
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
        </Pressable>
        {depth === 0 && onOpenCategoryColor && (
          <Pressable
            hitSlop={8}
            onPress={() => onOpenCategoryColor(node.segment)}
            style={[treeStyles.paletteBtn, { borderColor: alpha(node.catColor, 0.45), backgroundColor: alpha(node.catColor, 0.1) }]}
          >
            <PaletteGlyph color={node.catColor} size={14} />
          </Pressable>
        )}
      </View>
      {node.children.length > 0 && (
        <View style={kidsClipped ? { maxHeight: KIDS_COLLAPSE_H, overflow: 'hidden' } : null}>
          <View
            style={treeStyles.kidsWrap}
            onLayout={(e) => {
              const h = Math.ceil(e.nativeEvent.layout.height)
              if (Math.abs(h - kidsFullH) > 2) setKidsFullH(h)
            }}
          >
            {node.children.map((c) => (
              <TagTreeView
                key={c.fullPath}
                node={c}
                depth={depth + 1}
                selectedId={selectedId}
                onPick={onPick}
                onPickPath={onPickPath}
                onOpenCategoryColor={onOpenCategoryColor}
                onLongPressTag={onLongPressTag}
                onLongPressCategory={onLongPressCategory}
              />
            ))}
          </View>
        </View>
      )}
      {kidsClipped && (
        <Pressable onPress={() => setKidsExpanded(true)} hitSlop={6} style={treeStyles.expandHint}>
          <Text style={[treeStyles.expandHintText, { color: node.catColor }]}>⋯ 展开全部</Text>
        </Pressable>
      )}
    </View>
  )
}

const treeStyles = StyleSheet.create({
  box: {
    width: '100%',
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
  headerPickArea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 1,
    minWidth: 0,
  },
  headerDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  paletteBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
  kidsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    alignItems: 'flex-start',
  },
  expandHint: {
    alignSelf: 'center',
    paddingHorizontal: 14,
    marginTop: -2,
  },
  expandHintText: {
    fontSize: 12,
    fontWeight: '600',
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
    lineHeight: 18, // 显式行高 → chip 总高固定 32，深层折叠的裁断线才能对齐行底
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
/** "启动 / 激活"图标：lucide Zap（闪电），由 react-native-svg 渲染。
 *  "一键初始化"的标准 UX 隐喻。 */
function ZapGlyph({ color = '#FFF', size = 18 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

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

function PaletteGlyph({ color = '#888', size = 14 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3a9 9 0 0 0 0 18h1.3a1.7 1.7 0 0 0 1.2-2.9 1.7 1.7 0 0 1 1.2-2.9H17a4 4 0 0 0 0-8z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M7.5 10h.01M10 7.5h.01M14 7.5h.01M6.8 14h.01" stroke={color} strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  )
}

function fmtHHMMms(ms: number): string {
  if (!ms || ms <= 0) return '--:--'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 计划块、计划画笔的默认色（清单标签没有分类色时；desktop 用 warningOrange） */
const PLAN_COLOR = '#D9822B'
/** 计划块虚线框、浮岛框相对格子的内缩（desktop PLAN_INSET 2.5 / ISLAND_INSET 4，手机格子小，收一点） */
const PLAN_INSET = 1
const ISLAND_INSET = 3
const R_PLAN = 9
const R_ISLAND = 7
/** 日程的斜纹间距（desktop ISLAND_HATCH_STEP） */
const ISLAND_HATCH_STEP = 7
/** 浮岛过了没做 */
const ISLAND_MISSED_COLOR = '#8E8982'
const EMPTY_PALETTE: ActivityPalette = { categories: [], tags: [] }

/** 计划块按「格子 → 任务 id」借用 ActivityBlock 的形状，拖拽 / 撤销两层共用一套 */
function plannedAsBlocks(pbs: readonly PlannedBlock[]): ActivityBlock[] {
  return pbs.map((b) => ({ date: b.date, minute: b.minute, tagId: b.planNodeId, note: b.note, createdAt: b.createdAt }))
}

function blocksAsPlanned(bs: readonly ActivityBlock[]): PlannedBlock[] {
  return bs.map((b) => ({ date: b.date, minute: b.minute, planNodeId: b.tagId, note: b.note, createdAt: b.createdAt }))
}

function plannedSignature(pbs: readonly PlannedBlock[]): string {
  return [...pbs].sort((a, b) => a.minute - b.minute).map((b) => `${b.minute}:${b.planNodeId}`).join('|')
}

function planNodesSignature(nodes: readonly PlanNode[]): string {
  return nodes.map((n) => `${n.id}:${n.updatedAt}:${n.status}`).join('|')
}

interface Interaction {
  layer: RecordLayer
  editMode: boolean
  selectedTagId: number | null
  rows: Row[]
  blocks: ActivityBlock[]
  blockByMinute: Map<number, ActivityBlock>
  spans: Span[]
  selectedDate: Date
}

interface DragState {
  /** 按下时所在的层：拖到一半切层也写回原来那层（对齐 desktop dragRef 的 layer 戳） */
  layer: RecordLayer
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

type PaintCommit = {
  layer: RecordLayer
  date: Date
  tagId: number | null
  paintArr: number[]
  eraseArr: number[]
  snapshot: ActivityBlock[]
}

type FullRowReplaceWarning = {
  commit: PaintCommit
  body: string
}

export default function DayNightScreen() {
  // SafeArea inset 是异步算的 —— 第一次 mount 时 top=0，几 ms 后变成
  // 状态栏 + 刘海高度。App.tsx 用 paddingTop: insets.top 推开整个 root，
  // 所以 insets.top 变化时 cellArea 的屏幕 y 偏移也跟着变，必须重 measure，
  // 否则 measureInWindow 拿到的是 inset=0 时的旧值 → 拖拽落点漂移到上方。
  const insets = useSafeAreaInsets()
  const { height: winH } = useWindowDimensions()
  // sheet 顶部除了 status bar，还要给顶部"已记录"统计条留出 ~150px 露出空间
  // （日期行 50 + summary 100，让用户能看到当前在哪个日期）。
  // maxHeight 用百分比在 RN flex/Modal 下计算不稳；改用绝对像素更可靠。
  const sheetMaxHeight = winH - insets.top - 150
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
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
  // 新建模式：左侧"+"按钮切换；进入后搜索框语义变成"新标签完整路径"，
  // 下方 tag 列表作为模糊提示，点击 = 回填路径到输入框（节省手打父节点）
  const [addMode, setAddMode] = useState(false)
  // 一键初始化默认 7 分类 + 26 标签（空状态时使用，对齐 desktop）
  const [seeding, setSeeding] = useState(false)
  const seedDefaults = async () => {
    if (seeding) return
    setSeeding(true)
    try {
      let next: ActivityPalette | null = null
      for (const c of DEFAULT_PALETTE) {
        for (const t of c.tags) {
          next = await createTag(`${c.name},${t}`, c.color)
        }
      }
      if (next) setPalette(next)
    } catch (e: any) {
      // 失败静默 — 用户可以再点；UI 上保留按钮
      console.warn('[seed default palette] failed:', e?.message ?? e)
    } finally {
      setSeeding(false)
    }
  }
  const [detail, setDetail] = useState<Span | null>(null)
  const [probeSegments, setProbeSegments] = useState<AppMonitorSegment[]>([])
  const [probeLoading, setProbeLoading] = useState(false)
  const [iconCache, setIconCache] = useState<Record<string, string>>({})
  // focusStart/zoomCols/totalRows 启动时从 SharedPreferences 加载
  // prefsLoadedRef：避免首帧默认值被 useEffect 立刻 save 回去覆盖刚读到的偏好
  const prefsLoadedRef = useRef(false)
  const [focusStart, setFocusStart] = useState(3)
  // 非编辑模式下双指 pinch 切换：12 / 6 / 4 / 3 cols（cell 永远 5min）
  const [zoomCols, setZoomCols] = useState<ZoomCols>(12)
  const [totalRows, setTotalRows] = useState<TotalRows>(24)
  // 撤回/前进栈：每个元素是 blocks 数组快照，最多 30 个；点"完成"不清记忆
  const [undoStack, setUndoStack] = useState<readonly ActivityBlock[][]>([])
  const [redoStack, setRedoStack] = useState<readonly ActivityBlock[][]>([])
  const UNDO_LIMIT = 30
  // ── 计划层（对齐 desktop App.tsx）：实际 / 计划两层同屏，编辑时选一层涂 ──
  const [recordLayer, setRecordLayer] = useState<RecordLayer>('actual')
  const [plannedBlocks, setPlannedBlocks] = useState<PlannedBlock[]>([])
  // 全部任务：画计划块要按任务找标题和颜色，不止当前清单的（desktop 只取当前清单，别的清单的块会没名字）
  const [allPlanNodes, setAllPlanNodes] = useState<PlanNode[]>([])
  const [selectedProjectTagId, setSelectedProjectTagId] = useState<number | null>(null)
  const [selectedPlanNodeId, setSelectedPlanNodeId] = useState<number | null>(null)
  const [planUndoStack, setPlanUndoStack] = useState<readonly PlannedBlock[][]>([])
  const [planRedoStack, setPlanRedoStack] = useState<readonly PlannedBlock[][]>([])
  // 计划弹窗：null = 关；打开时停在哪一页
  const [planSheet, setPlanSheet] = useState<null | 'islands' | 'todo'>(null)

  // ── refs（供手势回调读取最新值）──
  const gridHRef = useRef(0)
  const focusBaseRef = useRef(3)
  const focusStartRef = useRef(3)
  const areaRef = useRef({ x: 0, y: 0, w: 0, h: 0 })
  const cellAreaRef = useRef<View>(null)
  const interactionRef = useRef<Interaction>({
    layer: 'actual',
    editMode: false,
    selectedTagId: null,
    rows: [],
    blocks: [],
    blockByMinute: new Map(),
    spans: [],
    selectedDate: new Date(),
  })
  const dragRef = useRef<DragState>({
    layer: 'actual',
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
  const plannedBlocksRef = useRef<PlannedBlock[]>([])
  const allPlanNodesRef = useRef<PlanNode[]>([])
  const reloadIslandsRef = useRef<() => void>(() => {})
  const selectedDateRef = useRef(selectedDate)
  const selectedTagIdRef = useRef(selectedTagId)
  const blocksRef = useRef<ActivityBlock[]>([])

  focusStartRef.current = focusStart
  plannedBlocksRef.current = plannedBlocks
  allPlanNodesRef.current = allPlanNodes
  selectedDateRef.current = selectedDate
  selectedTagIdRef.current = selectedTagId
  blocksRef.current = blocks

  // palette 走 ref —— PanResponder 闭包里查 tag 名要拿最新 palette，
  // 不能直接读闭包外的 tagById（那是首次 render 时的空 Map）
  const paletteRef = useRef<ActivityPalette | null>(null)
  paletteRef.current = palette

  // 标签 picker 搜索输入 ref —— AUDIT-014：autoFocus 只 mount 时生效，
  // 从 browse 切到 search 时 TextInput 已挂载，必须显式 focus()
  const searchInputRef = useRef<TextInput>(null)

  // zoom 同步 ref（PanResponder 回调拿最新值）
  const zoomColsRef = useRef<ZoomCols>(12)
  zoomColsRef.current = zoomCols
  const totalRowsRef = useRef<TotalRows>(24)
  totalRowsRef.current = totalRows

  // 启动时一次性 load 偏好；prefsLoadedRef 标记完成后才允许 save 回去
  // 避免初值的 useEffect 把刚 load 的值覆盖成 useState 默认值
  useEffect(() => {
    let alive = true
    loadDayNightZoomPrefs().then((p) => {
      if (!alive) return
      // 校验值在合法档位内（避免老存的值跟新 ZOOM_LEVELS 不匹配）
      const cols = (ZOOM_LEVELS as readonly number[]).includes(p.zoomCols)
        ? (p.zoomCols as ZoomCols) : 12
      const rows = (TOTAL_ROWS_LEVELS as readonly number[]).includes(p.totalRows)
        ? (p.totalRows as TotalRows) : 24
      const focusH = zoomFocusHours(cols, rows)
      const fs = clamp(p.focusStart, 0, 24 - focusH)
      setZoomCols(cols)
      setTotalRows(rows)
      setFocusStart(fs)
      prefsLoadedRef.current = true
    })
    return () => { alive = false }
  }, [])

  // save 偏好（防抖 400ms），仅当 prefsLoadedRef=true 之后才生效
  useEffect(() => {
    if (!prefsLoadedRef.current) return
    const id = setTimeout(() => {
      saveDayNightZoomPrefs({ zoomCols, totalRows, focusStart })
    }, 400)
    return () => clearTimeout(id)
  }, [zoomCols, totalRows, focusStart])
  // 真实 rows.length（focusStart 贴边时 tier 行少 push）；axisPan 用它算 rowH 才准
  // 用 totalRowCount() 估算最大值会导致拖动步进偏小（AUDIT-025）
  const rowsLenRef = useRef(24)
  // pinch 手势状态：起始两指距离 + 起始 zoom 档
  // pinch 状态：grant 时同时记录初始 dx/dy + cols/rows，运行时根据主导轴判定
  // 调横向 cols 还是纵向 totalRows（两指连线接近横向 → cols；接近纵向 → totalRows）
  const pinchRef = useRef({
    initialDx: 0,
    initialDy: 0,
    axis: null as null | 'horizontal' | 'vertical',
    startCols: 12 as ZoomCols,
    startRows: 24 as TotalRows,
  })

  // zoom toast：每次切换显示 "cols × rows"，2s 自动淡出
  const [zoomToast, setZoomToast] = useState<string | null>(null)
  const zoomToastOpacity = useRef(new Animated.Value(0)).current
  const zoomToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 长按标签 / 分类 → 先弹"操作菜单"（修改 / 删除），用户选了再走对应路径
  const [tagAction, setTagAction] = useState<
    | { kind: 'tag'; id: number; label: string; leafName: string }
    | { kind: 'category'; id: number; label: string; color: string }
    | null
  >(null)
  // 分类行调色板按钮：直接切换分类共享色。
  const [categoryColorEdit, setCategoryColorEdit] = useState<
    { id: number; name: string; color: string } | null
  >(null)
  // 新建标签时首段不存在：先确认是否创建新分类，并选择分类色。
  const [pendingCreateCategory, setPendingCreateCategory] = useState<
    { fullPath: string; categoryName: string; color: string } | null
  >(null)
  const [pendingColorConflict, setPendingColorConflict] = useState<
    { color: string; usedBy: string; apply: () => void | Promise<void> } | null
  >(null)
  // "修改"路径：编辑完整路径 / 名字 + 颜色（标签编辑 fullPath 可换分类；分类才有 color）
  const [tagEdit, setTagEdit] = useState<
    | { kind: 'tag'; id: number; name: string; original: string }
    | { kind: 'category'; id: number; name: string; color: string; original: string; originalColor: string }
    | null
  >(null)
  // 修改保存前再确认一次（避免误改重要标签 / 分类）
  const [pendingRename, setPendingRename] = useState<
    | { kind: 'tag'; id: number; original: string; newFullPath: string; descendants: number }
    | { kind: 'category'; id: number; original: string; newName: string; newColor: string; childTags: number }
    | null
  >(null)
  // 拖拽涂色碰到"原本已填满的一整行"时，先二次确认再真正写库。
  const [pendingFullRowReplace, setPendingFullRowReplace] = useState<FullRowReplaceWarning | null>(null)
  // 长按标签 / 分类 → 弹确认框删除
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'tag' | 'category'; id: number; label: string } | null
  >(null)
  const doConfirmDelete = async () => {
    if (!confirmDelete) return
    const item = confirmDelete
    setConfirmDelete(null)
    try {
      // AUDIT-016: 算出本次删除会软删哪些 tagId（删 category 时连带其全部 tag）
      // 用删除前 palette 的快照，删除后再判断 selectedTagId 是否在内
      const deletedTagIds = new Set<number>()
      if (palette) {
        if (item.kind === 'tag') {
          deletedTagIds.add(item.id)
        } else {
          for (const t of palette.tags) {
            if (t.categoryId === item.id) deletedTagIds.add(t.id)
          }
        }
      }
      const next = item.kind === 'tag' ? await deleteTag(item.id) : await deleteCategory(item.id)
      setPalette(next)
      // 删到当前选中 tag（含 category 删带走的子 tag）→ 清掉 selected，
      // 防止编辑模式继续用已软删 tagId 涂色写回 activity_blocks
      if (selectedTagId != null && deletedTagIds.has(selectedTagId)) {
        setSelectedTagId(null)
      }
      // AUDIT-016: 同时清 undo/redo 栈 —— 旧快照里的 blocks 引用了已删除 tagId，
      // 撤回会把这些 block 重新写回，LWW 同步会传播出去导致引用孤儿 tag
      setUndoStack([])
      setRedoStack([])
      // 当日 blocks 刷新（DB 已对 tag/category 软删，关联 blocks 也软删）
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

  // zoom 切换：cols 或 totalRows 任一变化都走这里
  // 切换后保持 focus 屏幕中心不变（新 focusHours 对称裹原中心 hour）
  const applyZoom = (newCols: ZoomCols, newRows: TotalRows) => {
    if (newCols === zoomColsRef.current && newRows === totalRowsRef.current) return
    const oldFocusH = zoomFocusHours(zoomColsRef.current, totalRowsRef.current)
    const newFocusH = zoomFocusHours(newCols, newRows)
    const center = focusStartRef.current + oldFocusH / 2
    const newStart = clamp(Math.round(center - newFocusH / 2), 0, 24 - newFocusH)
    zoomColsRef.current = newCols
    totalRowsRef.current = newRows
    setZoomCols(newCols)
    setTotalRows(newRows)
    setFocusStart(newStart)
    // toast：横向粒度 + 纵向密度（一行 cells × 每格分钟 · 总行数）
    setZoomToast(`一行 ${newCols} × 5min · 共 ${newRows} 行`)
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
      setSelectedTagId(mostRecentTagId(p))
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    // 撤回栈是当日 blocks 的快照，带到别的日期撤回会写错日期（对齐 desktop App.tsx）
    setUndoStack([])
    setRedoStack([])
    setPlanUndoStack([])
    setPlanRedoStack([])
    fetchBlocks(selectedDate).then((bs) => {
      if (!alive) return
      setBlocks(bs)
      setLoading(false)
    })
    fetchPlannedBlocks(selectedDate)
      .then((pbs) => { if (alive) setPlannedBlocks(pbs) })
      .catch((e: any) => console.warn('[daynight] 读计划块失败:', e?.message ?? e))
    return () => {
      alive = false
    }
  }, [selectedDate])

  // 任务列表：启动取一次；之后由同步 / 计划面板 / Fairy 工具触发刷新
  const refreshPlanNodes = () => {
    fetchAllPlanNodes()
      .then((nodes) => {
        setAllPlanNodes((cur) => (planNodesSignature(cur) === planNodesSignature(nodes) ? cur : nodes))
        setSelectedPlanNodeId((id) => (id != null && nodes.some((n) => n.id === id && n.status !== 'archived') ? id : null))
      })
      .catch((e: any) => console.warn('[daynight] 读计划任务失败:', e?.message ?? e))
  }
  const refreshPlanNodesRef = useRef(refreshPlanNodes)
  refreshPlanNodesRef.current = refreshPlanNodes
  useEffect(() => { refreshPlanNodesRef.current() }, [])

  // 桌面端推同步时，native SolevupDb 已经写库，但当前 mounted 的昼夜表不会自动重读。
  // 同步 HTTP server 在 import 成功后发 SolevupDbChanged；这里只在事件到达/回前台时重读。
  useEffect(() => {
    let alive = true
    let inFlight = false
    let again = false
    const refreshVisibleData = async () => {
      // 正在读时又来一次：读完再读一遍，免得漏掉后来的改动
      if (inFlight) { again = true; return }
      inFlight = true
      const date = selectedDateRef.current
      const dateKey = toLocalDateStr(date)
      try {
        const [nextPalette, nextBlocks, nextPlanned] = await Promise.all([
          fetchPalette(), fetchBlocks(date), fetchPlannedBlocks(date),
        ])
        if (!alive) return
        refreshPlanNodesRef.current()
        reloadIslandsRef.current()
        if (toLocalDateStr(selectedDateRef.current) === dateKey &&
            plannedSignature(nextPlanned) !== plannedSignature(plannedBlocksRef.current)) {
          setPlannedBlocks(nextPlanned)
          setPlanUndoStack([])
          setPlanRedoStack([])
        }
        const currentPalette = paletteRef.current
        if (!currentPalette || paletteSignature(nextPalette) !== paletteSignature(currentPalette)) {
          setPalette(nextPalette)
          setSelectedTagId((cur) => {
            if (cur != null && nextPalette.tags.some((t) => t.id === cur)) return cur
            return selectedTagIdRef.current == null ? mostRecentTagId(nextPalette) : null
          })
        }
        // 请求回来时用户可能已经切了日期；只刷新发起时对应的那一天。
        if (toLocalDateStr(selectedDateRef.current) === dateKey &&
            blocksSignature(nextBlocks) !== blocksSignature(blocksRef.current)) {
          setBlocks(nextBlocks)
          // AUDIT-001（对齐 desktop）：旧快照按同步前的数据拍的，撤回会把同步进来的改动盖掉
          setUndoStack([])
          setRedoStack([])
        }
      } catch (e: any) {
        console.warn('[daynight-refresh] failed:', e?.message ?? e)
      } finally {
        inFlight = false
        if (again && alive) { again = false; void refreshVisibleData() }
      }
    }
    const dbSub = DeviceEventEmitter.addListener(
      'SolevupDbChanged',
      (e: { changed?: Record<string, number | undefined> } | null) => {
        // 只有聊天、模型、设置变了（聊天现在每条消息都直推）就不重读昼夜表（同 desktop App.tsx sync:pushed）
        const changed = e?.changed
        if (changed && !DAYNIGHT_SYNC_KEYS.some((k) => (changed[k] ?? 0) > 0)) return
        void refreshVisibleData()
      },
    )
    // Fairy 的昼夜表工具、计划面板写完发这个（desktop 同名 Tauri 事件）
    const dayNightSub = DeviceEventEmitter.addListener(DAYNIGHT_CHANGED_EVENT, () => {
      void refreshVisibleData()
    })
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshVisibleData()
    })
    return () => {
      alive = false
      dbSub.remove()
      dayNightSub.remove()
      sub.remove()
    }
  }, [])

  // 重 measure cellArea 的屏幕坐标 —— 三种触发：
  //   editMode / focusStart 变化 → 上方 toolbar 内容变化
  //   insets.top / insets.bottom 异步更新 → root paddingTop 变化（cellArea 全局下移）
  // onLayout 在 cellArea 自身尺寸不变时不会触发，必须手动兜底。
  useEffect(() => {
    const t = setTimeout(measureArea, 80)
    return () => clearTimeout(t)
  }, [editMode, focusStart, insets.top, insets.bottom])

  // AUDIT-014: 切到 search 模式时显式 focus 搜索框（autoFocus 只 mount 时生效，
  // 已挂载 TextInput 改 prop 不会重新聚焦）。小延迟避免与 picker 渲染竞态
  useEffect(() => {
    if (pickerMode !== 'search') return
    const t = setTimeout(() => searchInputRef.current?.focus(), 40)
    return () => clearTimeout(t)
  }, [pickerMode, recordLayer])

  useEffect(() => {
    if (!detail) {
      setProbeSegments([])
      return
    }
    const midnight = new Date(selectedDate)
    midnight.setHours(0, 0, 0, 0)
    const startMs = midnight.getTime() + detail.startMin * 60_000
    const endMs = midnight.getTime() + detail.endMin * 60_000
    let alive = true
    setProbeLoading(true)
    getAppMonitorSegmentsInRange(startMs, endMs, 500)
      .then(async (segments) => {
        if (!alive) return
        setProbeSegments(segments)
        // 异步把还没缓存的 pkg 图标拉过来
        const needed = Array.from(new Set(segments.map((e) => e.packageName))).filter(
          (p) => p && !(p in iconCache),
        )
        if (needed.length > 0) {
          const fetched = await getAppIcons(needed)
          if (alive) setIconCache((prev) => ({ ...prev, ...fetched }))
        }
      })
      .catch(() => {
        if (alive) setProbeSegments([])
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

  const tagLabelForConfirm = (tagId: number | null): string => {
    if (tagId == null) return '空白'
    const tag = paletteRef.current?.tags.find((t) => t.id === tagId)
    return tag?.leafName ?? tag?.fullPath ?? '标签'
  }

  // 选标签 = 仅切换 selected，不算"使用过"（使用过=拖拽涂色，由 paint commit 维护）
  const pickTag = (id: number) => {
    setSelectedTagId(id)
    setTagPickerOpen(false)
    setTagQuery('')
  }

  const createAndPickTag = async (fullPath: string, categoryColor?: string) => {
    try {
      const updated = await createTag(fullPath, categoryColor)
      setPalette(updated)
      const created = updated.tags.find((t) => t.fullPath === fullPath)
      if (created) {
        pickTag(created.id)
        setAddMode(false)
      }
    } catch (e) {
      console.warn('[create tag] failed', e)
    }
  }

  const colorUsedBy = (color: string, excludeCategoryId?: number): string | null => {
    const used = palette?.categories.find((c) => c.color === color && c.id !== excludeCategoryId)
    return used?.name ?? null
  }

  const pickCategoryColor = (
    color: string,
    excludeCategoryId: number | undefined,
    apply: () => void | Promise<void>,
  ) => {
    const usedBy = colorUsedBy(color, excludeCategoryId)
    if (usedBy) {
      setPendingColorConflict({ color, usedBy, apply })
      return
    }
    apply()
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
    const perTag = new Map<number, Map<number, number>>() // catId → tagId → mins
    blocks.forEach((b) => {
      const tag = tagById.get(b.tagId)
      if (!tag) return
      perCat.set(tag.categoryId, (perCat.get(tag.categoryId) ?? 0) + 5)
      let tagMap = perTag.get(tag.categoryId)
      if (!tagMap) {
        tagMap = new Map()
        perTag.set(tag.categoryId, tagMap)
      }
      tagMap.set(b.tagId, (tagMap.get(b.tagId) ?? 0) + 5)
    })
    const rows = Array.from(perCat.entries())
      .map(([catId, mins]) => {
        const cat = categoryById.get(catId)
        if (!cat) return null
        const tagRows = Array.from(perTag.get(catId)?.entries() ?? [])
          .map(([tid, m]) => ({ tag: tagById.get(tid), mins: m }))
          .filter((r): r is { tag: ActivityTag; mins: number } => !!r.tag)
          .sort((a, b) => b.mins - a.mins)
        return { cat, mins, tags: tagRows }
      })
      .filter((r): r is { cat: ActivityCategory; mins: number; tags: { tag: ActivityTag; mins: number }[] } => !!r)
      .sort((a, b) => b.mins - a.mins)
    return { total: blocks.length * 5, rows }
  }, [blocks, tagById, categoryById])

  // ── 计划层派生数据 ──
  const { islands, placements: islandPlacements, error: islandsError, reload: reloadIslands } =
    useIslands(selectedDate, blocks, palette ?? EMPTY_PALETTE)
  reloadIslandsRef.current = reloadIslands

  const planNodeById = useMemo(() => new Map(allPlanNodes.map((n) => [n.id, n])), [allPlanNodes])
  const projectPlanNodes = useMemo(
    () => allPlanNodes.filter((n) => n.projectTagId === selectedProjectTagId),
    [allPlanNodes, selectedProjectTagId],
  )
  const plannedByMinute = useMemo(() => {
    const m = new Map<number, number>()
    plannedBlocks.forEach((b) => m.set(b.minute, b.planNodeId))
    return m
  }, [plannedBlocks])

  // 默认清单：最近改过的任务所在的清单；还没有任务时用最近用过的标签（desktop 取第一个标签）
  useEffect(() => {
    if (selectedProjectTagId != null || !palette || palette.tags.length === 0) return
    const latest = [...allPlanNodes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    const fallback = latest?.projectTagId ?? mostRecentTagId(palette) ?? palette.tags[0].id
    setSelectedProjectTagId(fallback)
  }, [selectedProjectTagId, palette, allPlanNodes])

  /** 任务的颜色 = 它所在清单标签的分类色 */
  const planColorOf = (nodeId: number): string => {
    const node = planNodeById.get(nodeId)
    const tag = node ? tagById.get(node.projectTagId) : undefined
    const cat = tag ? categoryById.get(tag.categoryId) : undefined
    return cat?.color ?? PLAN_COLOR
  }

  const islandColorOf = (p: IslandPlacement): string =>
    p.status === 'missed' ? ISLAND_MISSED_COLOR : islandColor(p.island.rule, palette ?? EMPTY_PALETTE, PLAN_COLOR)

  const selectedPlanNode = selectedPlanNodeId != null ? planNodeById.get(selectedPlanNodeId) ?? null : null
  const activeUndo = recordLayer === 'plan' ? planUndoStack : undoStack
  const activeRedo = recordLayer === 'plan' ? planRedoStack : redoStack

  const isToday = isSameDay(new Date(), selectedDate)

  // 实时游标：当天才显示。每秒 tick 一次（cell 内按秒级偏移 = 5min × 60s = 300 刻度）
  // 编辑模式也要继续走时钟；否则用户涂格时会看到当前时间指针停住。
  const [nowTs, setNowTs] = useState(Date.now())
  useEffect(() => {
    if (!isToday) return
    setNowTs(Date.now())
    const id = setInterval(() => setNowTs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isToday])
  // nowTotalSec = 0..86399；cell 内偏移 = (nowTotalSec % 300) / 300
  const nowDate = new Date(nowTs)
  const nowTotalSec = nowDate.getHours() * 3600 + nowDate.getMinutes() * 60 + nowDate.getSeconds()
  const nowMinute = Math.floor(nowTotalSec / 60)
  const rows = useMemo(() => buildRows(focusStart, zoomCols, totalRows), [focusStart, zoomCols, totalRows])
  rowsLenRef.current = rows.length

  // 同步 refs
  if (recordLayer === 'plan') {
    const planBlocks = plannedAsBlocks(plannedBlocks)
    interactionRef.current = {
      layer: 'plan', editMode, selectedTagId: selectedPlanNodeId, rows,
      blocks: planBlocks, blockByMinute: new Map(planBlocks.map((b) => [b.minute, b])), spans, selectedDate,
    }
  } else {
    interactionRef.current = { layer: 'actual', editMode, selectedTagId, rows, blocks, blockByMinute, spans, selectedDate }
  }

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
    if (d.layer === 'plan') setPlannedBlocks(blocksAsPlanned(out))
    else setBlocks(out)
    // 记到 dragRef 给 release 时分批 commit
    d.paintMins = paintMins
    d.eraseMins = eraseMins
    d.painted = inRange
  }

  const buildFullRowReplaceWarning = (commit: PaintCommit): FullRowReplaceWarning | null => {
    // 计划层改的是打算，不是记录，盖掉不用确认（desktop 两层都不确认）
    if (commit.layer === 'plan') return null
    if (commit.tagId == null || commit.paintArr.length === 0) return null
    const paintSet = new Set(commit.paintArr)
    const before = new Map<number, number>()
    commit.snapshot.forEach((b) => before.set(b.minute, b.tagId))
    const replacingTagName = tagLabelForConfirm(commit.tagId)
    const rows = interactionRef.current.rows
    const lines: string[] = []

    for (const row of rows) {
      if (row.kind !== 'full') continue
      const rowMins = Array.from({ length: row.cols }, (_, col) => row.startMin + col * 5)
      // "本来填充满一行"按拖拽前快照判断：这一行每个 5min cell 都已有活动。
      if (!rowMins.every((m) => before.has(m))) continue
      const touched = rowMins.filter((m) => {
        const oldTag = before.get(m)
        return paintSet.has(m) && oldTag != null && oldTag !== commit.tagId
      })
      if (touched.length === 0) continue

      let runStart = touched[0]
      let prev = touched[0]
      let runTag = before.get(touched[0])!
      const flush = () => {
        const from = fmtMinute(runStart)
        const to = fmtMinute(prev + 5)
        const oldName = tagLabelForConfirm(runTag)
        lines.push(`${from} – ${to}「${oldName}」→「${replacingTagName}」`)
      }
      for (let i = 1; i < touched.length; i++) {
        const m = touched[i]
        const t = before.get(m)!
        if (m === prev + 5 && t === runTag) {
          prev = m
          continue
        }
        flush()
        runStart = m
        prev = m
        runTag = t
      }
      flush()
    }

    if (lines.length === 0) return null
    const shown = lines.slice(0, 6)
    const more = lines.length > shown.length ? `\n…另有 ${lines.length - shown.length} 段` : ''
    return {
      commit,
      body: `本次拖拽碰到了原本已经填满的一整行。\n\n会被替代的段落：\n${shown.map((l) => `- ${l}`).join('\n')}${more}\n\n请确认这是有意覆盖。`,
    }
  }

  // 注意：cellPan 是 useRef(PanResponder.create(...))，这里拿到的是首帧的函数，只能读 ref 和 setState
  const commitPlanEdit = (commit: PaintCommit) => {
    const { date, tagId, paintArr, eraseArr } = commit
    const snapshot = blocksAsPlanned(commit.snapshot)
    setPlanUndoStack((prev) => [...prev.slice(-(UNDO_LIMIT - 1)), snapshot])
    setPlanRedoStack([])
    const tasks: Promise<unknown>[] = []
    if (paintArr.length > 0 && tagId != null) tasks.push(paintPlannedBlocks(date, paintArr, tagId))
    if (eraseArr.length > 0) tasks.push(erasePlannedBlocks(date, eraseArr))
    Promise.all(tasks)
      .then(() => { if (tagId != null) fetchPalette().then(setPalette).catch(() => {}) })
      .catch((e: any) => {
        console.warn('[plan paint] 写入失败，回滚:', e?.message ?? e)
        setPlannedBlocks(snapshot)
        fetchPlannedBlocks(date).then(setPlannedBlocks).catch(() => {})
      })
    if (paintArr.length > 0 && tagId != null) {
      const sorted = [...paintArr].sort((a, b) => a - b)
      const node = allPlanNodesRef.current.find((n) => n.id === tagId)
      const tag = node ? paletteRef.current?.tags.find((t) => t.id === node.projectTagId) : undefined
      showPaintToast({
        name: `计划：${node?.title ?? '任务'}${tag ? ` · ${tag.leafName}` : ''}`,
        time: `${fmtMinute(sorted[0])} – ${fmtMinute(sorted[sorted.length - 1] + 5)}`,
      })
    }
  }

  const commitPaintEdit = (commit: PaintCommit) => {
    if (commit.layer === 'plan') {
      commitPlanEdit(commit)
      return
    }
    const { date, tagId, paintArr, eraseArr, snapshot } = commit
    // 推 undo（snapshot = 操作前的 blocks），清空 redo
    setUndoStack((prev) => [...prev.slice(-(UNDO_LIMIT - 1)), snapshot])
    setRedoStack([])
    // 分批写后端：paint 走 tagId / erase 不带 tagId
    if (paintArr.length > 0 && tagId != null) {
      // SolevupDb.paintBlocks 内部事务会同时 bump tag/category 的 last_used_at
      // （对齐 desktop paint_blocks），LWW 同步到对端，"最近"自动跨设备
      paintBlocks(date, paintArr, tagId).then(() => {
        // 拉回真值刷新 palette，让 recentTags useMemo 能感知新 lastUsedAt
        fetchPalette().then(setPalette).catch(() => {})
      })
      // 底部 toast：找出本次 paint 覆盖区间在 post-paint blocks 里的合并段，
      // 显示连片段（含相邻同色已有 block）的起止时间
      // post-paint blocks 已通过 setBlocks 写过；这里用 snapshot + paintArr + tagId
      // 重建 nextBlockByMinute 找连片
      const next = new Map<number, number>()
      snapshot.forEach((b) => next.set(b.minute, b.tagId))
      eraseArr.forEach((m) => next.delete(m))
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
      const tagName = tagLabelForConfirm(tagId)
      showPaintToast({
        name: tagName,
        time: `${fmtMinute(start)} – ${fmtMinute(endExcl)}`,
      })
    }
    if (eraseArr.length > 0) {
      eraseBlocks(date, eraseArr)
    }
  }

  // ── 格子区手势：编辑拖拽涂色 / 查看点按详情 ──
  const cellPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        // pinch 状态全部重置（axis=null → 下次双指触摸时重新锁主导轴）
        pinchRef.current.initialDx = 0
        pinchRef.current.initialDy = 0
        pinchRef.current.axis = null
        const cell = cellFromLocalPoint(e.nativeEvent.locationX, e.nativeEvent.locationY)
        const { editMode: em, blockByMinute: bm, selectedTagId: tagId } = interactionRef.current
        const d: DragState = {
          layer: interactionRef.current.layer,
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
          const dx = Math.abs(a.pageX - b.pageX)
          const dy = Math.abs(a.pageY - b.pageY)
          // 第一次进 pinch：锁定主导轴 + 记录起始
          // 两指连线 |dx| 大于 |dy| → 横向 → 改 cols；反之 → 纵向 → 改 totalRows
          if (pinchRef.current.axis == null) {
            pinchRef.current.axis = dx >= dy ? 'horizontal' : 'vertical'
            pinchRef.current.initialDx = dx
            pinchRef.current.initialDy = dy
            pinchRef.current.startCols = zoomColsRef.current
            pinchRef.current.startRows = totalRowsRef.current
            return
          }
          const scale = pinchRef.current.axis === 'horizontal'
            ? dx / Math.max(pinchRef.current.initialDx, 1)
            : dy / Math.max(pinchRef.current.initialDy, 1)
          let delta = 0
          if (scale >= 1.7) delta = 2
          else if (scale >= 1.25) delta = 1
          else if (scale <= 0.6) delta = -2
          else if (scale <= 0.8) delta = -1
          if (pinchRef.current.axis === 'horizontal') {
            // 横向：cols 越大 = 越粗（一行 60min），index 0 = 12 cols（最粗）
            // 张开（scale↑）应该让 cols 变小（更细）→ index 增大 → delta 正号
            const startIdx = ZOOM_LEVELS.indexOf(pinchRef.current.startCols)
            const targetIdx = clamp(startIdx + delta, 0, ZOOM_LEVELS.length - 1)
            const target = ZOOM_LEVELS[targetIdx]
            if (target !== zoomColsRef.current) applyZoom(target, totalRowsRef.current)
          } else {
            // 纵向：rows 越大 = 屏上行数越多（行高越矮）。index 0 = 24 行（最稀疏，行最高）
            // 张开（scale↑）= 想让行更高 → totalRows 变少 → index 增大 → delta 正号
            const startIdx = TOTAL_ROWS_LEVELS.indexOf(pinchRef.current.startRows)
            const targetIdx = clamp(startIdx + delta, 0, TOTAL_ROWS_LEVELS.length - 1)
            const target = TOTAL_ROWS_LEVELS[targetIdx]
            if (target !== totalRowsRef.current) applyZoom(zoomColsRef.current, target)
          }
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
        if (pinchRef.current.axis !== null) {
          pinchRef.current.axis = null
          pinchRef.current.initialDx = 0
          pinchRef.current.initialDy = 0
          return
        }
        const d = dragRef.current
        const { editMode: em, selectedTagId: tagId, spans: sp, selectedDate: date } =
          interactionRef.current
        if (em) {
          const paintArr = Array.from(d.paintMins)
          const eraseArr = Array.from(d.eraseMins)
          if (paintArr.length === 0 && eraseArr.length === 0) return
          const commit: PaintCommit = { layer: d.layer, date, tagId, paintArr, eraseArr, snapshot: d.snapshot }
          const warning = buildFullRowReplaceWarning(commit)
          if (warning) {
            setPendingFullRowReplace(warning)
            return
          }
          commitPaintEdit(commit)
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
          const focusH = zoomFocusHours(zoomColsRef.current, totalRowsRef.current)
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
        // 用真实渲染 rows.length 算 rowH（AUDIT-025）—— 之前用 totalRowCount() 估算
        // 最大值，focusStart 贴边时实际行数更少，rowH 算偏小导致拖动步进慢
        const total = rowsLenRef.current || 1
        const rowH = gridHRef.current > 0 ? gridHRef.current / total : 40
        const focusH = zoomFocusHours(zoomColsRef.current, totalRowsRef.current)
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

  // 计划层的差异写回（desktop applyPlannedBlocksDelta）
  const applyPlannedBlocksDelta = async (fromBlocks: PlannedBlock[], toBlocks: PlannedBlock[]) => {
    const fromMap = new Map(fromBlocks.map((b) => [b.minute, b.planNodeId]))
    const toMap = new Map(toBlocks.map((b) => [b.minute, b.planNodeId]))
    const paintByNode = new Map<number, number[]>()
    const eraseMinutes: number[] = []
    for (const [m, fromNode] of fromMap) {
      const toNode = toMap.get(m)
      if (toNode === undefined) eraseMinutes.push(m)
      else if (toNode !== fromNode) paintByNode.set(toNode, [...(paintByNode.get(toNode) ?? []), m])
    }
    for (const [m, toNode] of toMap) {
      if (!fromMap.has(m)) paintByNode.set(toNode, [...(paintByNode.get(toNode) ?? []), m])
    }
    if (eraseMinutes.length > 0) await erasePlannedBlocks(selectedDate, eraseMinutes)
    for (const [nodeId, mins] of paintByNode) {
      if (mins.length > 0) await paintPlannedBlocks(selectedDate, mins, nodeId)
    }
  }

  const stepPlanHistory = (from: readonly PlannedBlock[][], kind: 'undo' | 'redo') => {
    if (from.length === 0) return
    const popped = from[from.length - 1]
    const current = plannedBlocks
    const pushTo = kind === 'undo' ? setPlanRedoStack : setPlanUndoStack
    const popFrom = kind === 'undo' ? setPlanUndoStack : setPlanRedoStack
    pushTo((prev) => [...prev.slice(-(UNDO_LIMIT - 1)), current])
    popFrom((prev) => prev.slice(0, -1))
    setPlannedBlocks(popped)
    applyPlannedBlocksDelta(current, popped).catch((e: any) => {
      console.warn('[plan undo] 写入失败:', e?.message ?? e)
      fetchPlannedBlocks(selectedDate).then(setPlannedBlocks).catch(() => {})
    })
  }

  const handleUndo = () => {
    if (recordLayer === 'plan') { stepPlanHistory(planUndoStack, 'undo'); return }
    if (undoStack.length === 0) return
    const popped = undoStack[undoStack.length - 1]
    const current = blocks
    setRedoStack((prev) => [...prev.slice(-(UNDO_LIMIT - 1)), current])
    setUndoStack((prev) => prev.slice(0, -1))
    setBlocks(popped)
    void applyBlocksDelta(current, popped)
  }

  const handleRedo = () => {
    if (recordLayer === 'plan') { stepPlanHistory(planRedoStack, 'redo'); return }
    if (redoStack.length === 0) return
    const popped = redoStack[redoStack.length - 1]
    const current = blocks
    setUndoStack((prev) => [...prev.slice(-(UNDO_LIMIT - 1)), current])
    setRedoStack((prev) => prev.slice(0, -1))
    setBlocks(popped)
    void applyBlocksDelta(current, popped)
  }

  // ── 展开面板的计划页：进行中的任务按清单分组，点一条当画笔 ──
  const [taskQuery, setTaskQuery] = useState('')
  const pickerTaskGroups = useMemo(() => {
    const q = taskQuery.trim().toLowerCase()
    const active = allPlanNodes.filter((n) => n.status === 'active')
    const byId = new Map(active.map((n) => [n.id, n]))
    const children = new Map<number | null, PlanNode[]>()
    for (const n of active) {
      const parent = n.parentId != null && byId.has(n.parentId) ? n.parentId : null
      children.set(parent, [...(children.get(parent) ?? []), n])
    }
    // 树序：父任务在前，子任务缩进跟在后面
    const ordered: { node: PlanNode; depth: number; parentTitle: string | null }[] = []
    const walk = (parent: number | null, depth: number, parentTitle: string | null) => {
      const list = [...(children.get(parent) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      for (const n of list) {
        ordered.push({ node: n, depth, parentTitle })
        walk(n.id, depth + 1, n.title)
      }
    }
    walk(null, 0, null)
    const groups = new Map<number, { tag: ActivityTag | undefined; items: typeof ordered; latest: string }>()
    for (const item of ordered) {
      const tag = tagById.get(item.node.projectTagId)
      if (q && !item.node.title.toLowerCase().includes(q) && !(tag?.fullPath.toLowerCase().includes(q) ?? false)) continue
      const g = groups.get(item.node.projectTagId) ?? { tag, items: [], latest: '' }
      g.items.push(item)
      if (item.node.updatedAt > g.latest) g.latest = item.node.updatedAt
      groups.set(item.node.projectTagId, g)
    }
    // 当前清单排第一，其余按最近改动
    return [...groups.entries()]
      .sort(([a, ga], [b, gb]) =>
        (a === selectedProjectTagId ? -1 : 0) - (b === selectedProjectTagId ? -1 : 0) || gb.latest.localeCompare(ga.latest))
      .map(([projectTagId, g]) => ({ projectTagId, ...g }))
  }, [allPlanNodes, tagById, taskQuery, selectedProjectTagId])

  const pickTask = (node: PlanNode) => {
    setSelectedPlanNodeId(node.id)
    setSelectedProjectTagId(node.projectTagId)
    setPickerMode(null)
    setTaskQuery('')
    Keyboard.dismiss()
  }

  const openPlanManager = () => {
    Keyboard.dismiss()
    setPickerMode(null)
    setPlanSheet('todo')
  }

  const renderTaskPicker = () => (
    <>
      <Pressable style={styles.searchBoxInCloud} onPress={() => searchInputRef.current?.focus()}>
        <View style={styles.taskSearchIcon}>
          <SearchGlyph color={theme.inkSoft} />
        </View>
        <TextInput
          ref={searchInputRef}
          value={taskQuery}
          onChangeText={setTaskQuery}
          placeholder="搜索任务 / 清单..."
          placeholderTextColor={theme.inkSoft}
          autoFocus={pickerMode === 'search'}
          style={styles.searchInput}
        />
        {taskQuery.length > 0 && (
          <Pressable hitSlop={10} onPress={() => setTaskQuery('')} style={styles.searchClose}>
            <Text style={styles.searchCloseText}>×</Text>
          </Pressable>
        )}
      </Pressable>
      <View style={styles.taskHintRow}>
        <Text style={styles.pickerHint}>点一条任务当画笔，涂到时间上</Text>
        <Pressable hitSlop={8} onPress={openPlanManager}>
          <Text style={styles.taskManageLink}>管理任务与浮岛</Text>
        </Pressable>
      </View>
      <ScrollView
        style={styles.treeScrollWrap}
        contentContainerStyle={styles.treeScroll}
        keyboardShouldPersistTaps="always"
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        {pickerTaskGroups.length === 0 ? (
          taskQuery.trim() ? (
            <Text style={styles.pickerNoMatch}>没找到匹配的任务</Text>
          ) : (
            <View style={styles.taskEmpty}>
              <Text style={styles.pickerNoMatch}>还没有进行中的任务</Text>
              <Pressable onPress={openPlanManager} style={styles.taskEmptyBtn}>
                <Text style={styles.taskEmptyBtnText}>去计划安排新建</Text>
              </Pressable>
            </View>
          )
        ) : (
          pickerTaskGroups.map((g) => {
            const cat = g.tag ? categoryById.get(g.tag.categoryId) : undefined
            const color = cat?.color ?? PLAN_COLOR
            return (
              <View key={g.projectTagId} style={styles.taskGroup}>
                <View style={styles.taskGroupHead}>
                  <View style={[styles.taskGroupDot, { backgroundColor: color }]} />
                  <Text style={styles.taskGroupName} numberOfLines={1}>{g.tag?.fullPath ?? '清单'}</Text>
                  <Text style={styles.taskGroupCount}>{g.items.length}</Text>
                </View>
                {g.items.map(({ node, depth, parentTitle }) => {
                  const on = node.id === selectedPlanNodeId
                  return (
                    <Pressable
                      key={node.id}
                      onPress={() => pickTask(node)}
                      style={[
                        styles.taskRow,
                        { marginLeft: depth * 14 },
                        on && { backgroundColor: alpha(color, 0.14), borderColor: alpha(color, 0.7) },
                      ]}
                    >
                      <View style={[styles.planBrushDot, { borderColor: color }]} />
                      <Text style={styles.taskTitle} numberOfLines={1}>{node.title}</Text>
                      {taskQuery.trim() && parentTitle ? (
                        <Text style={styles.taskParent} numberOfLines={1}>{parentTitle}</Text>
                      ) : null}
                    </Pressable>
                  )
                })}
              </View>
            )
          })
        )}
      </ScrollView>
    </>
  )

  // 折叠行（1 小时 1 格）放不下框：计划块和浮岛画成格子底部的两条细条，只表示「这一小时里有安排」
  const renderCompressedPlanMarks = (h: number) => {
    const from = h * 60
    const to = from + 60
    const planBars: { left: number; width: number; color: string }[] = []
    for (let m = from; m < to;) {
      const id = plannedByMinute.get(m)
      if (id == null) { m += 5; continue }
      let end = m + 5
      while (end < to && plannedByMinute.get(end) === id) end += 5
      planBars.push({ left: (m - from) / 60, width: (end - m) / 60, color: planColorOf(id) })
      m = end
    }
    const islandBars = islandPlacements.flatMap((p) => {
      if (p.start == null || p.end == null) return []
      const s = Math.max(p.start, from)
      const e = Math.min(p.end, to)
      return e > s ? [{ left: (s - from) / 60, width: (e - s) / 60, color: islandColorOf(p) }] : []
    })
    if (planBars.length === 0 && islandBars.length === 0) return null
    return (
      <View pointerEvents="none" style={styles.compressedMarks}>
        {islandBars.map((b, i) => (
          <View
            key={`i${i}`}
            style={[styles.compressedIslandBar, { left: `${b.left * 100}%`, width: `${b.width * 100}%`, backgroundColor: alpha(b.color, 0.75) }]}
          />
        ))}
        {planBars.map((b, i) => (
          <View
            key={`p${i}`}
            style={[styles.compressedPlanBar, { left: `${b.left * 100}%`, width: `${b.width * 100}%`, backgroundColor: alpha(b.color, 0.9) }]}
          />
        ))}
      </View>
    )
  }

  const detailTag = detail ? tagById.get(detail.tagId) : undefined
  const detailCat = detailTag ? categoryById.get(detailTag.categoryId) : undefined

  return (
    <View style={styles.root}>
      <SharedDateHeader
        selectedDate={selectedDate}
        onChangeDate={setSelectedDate}
        onOpenCalendar={() => setCalendarOpen(true)}
      />

      {/* 概览 —— 文字 + 条形点击弹明细；chips 是横向 ScrollView 滑动看更多分类 */}
      <View style={styles.summary}>
        <Pressable
          onPress={() => summary.rows.length > 0 && setStatsOpen(true)}
        >
        <Text style={styles.summaryText}>
          已记录 <Text style={styles.summaryStrong}>{fmtHM(summary.total)}</Text>
          {summary.rows.length > 0 ? ` · ${summary.rows.length} 类` : ''}
        </Text>
        <View style={styles.sumBar}>
          {summary.rows.map((r) => {
            // 段落占总日 1440 的比例：太窄（<5%）不放字（直接看下方 chips）
            const showLabel = r.mins / 1440 >= 0.05
            return (
              <View
                key={r.cat.id}
                style={[styles.sumSeg, { flex: r.mins, backgroundColor: r.cat.color }]}
              >
                {showLabel && (
                  <Text style={styles.sumSegText} numberOfLines={1}>
                    {r.cat.name}
                  </Text>
                )}
              </View>
            )
          })}
          {summary.total < 1440 && (
            <View style={{ flex: 1440 - summary.total, backgroundColor: theme.line }} />
          )}
        </View>
        </Pressable>
        {/* 兜底分类 chips：横向滚（分类多时一行装不下也不换行，左右滑动看） */}
        {summary.rows.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.sumChips}
          >
            {summary.rows.map((r) => (
              <View key={r.cat.id} style={styles.sumChip}>
                <View style={[styles.sumChipDot, { backgroundColor: r.cat.color }]} />
                <Text style={styles.sumChipText}>
                  {r.cat.name}
                  <Text style={styles.sumChipMins}> {fmtHM(r.mins)}</Text>
                </Text>
              </View>
            ))}
          </ScrollView>
        )}
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
            <View style={styles.idleRow}>
              <Pressable onPress={() => setEditMode(true)} style={[styles.editFullBtn, styles.idleEditBtn]}>
                <SlidersGlyph color="#FFF" size={15} />
                <Text style={styles.editFullText}>编辑昼夜表</Text>
              </Pressable>
              {/* 浮岛与日程、计划安排（desktop 右侧栏的「计划」） */}
              <Pressable onPress={() => setPlanSheet('islands')} style={styles.planOpenBtn}>
                <Text style={styles.planOpenText}>计划</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.editingChips}>
              {/* 搜索按钮：单独入口，点开后自动 focus 输入框（记录、计划两页通用） */}
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
              {/* 当前画笔：记录层是标签，计划层是任务（前面带虚线小框）。
                  点开展开面板，记录 / 计划在面板顶上切（编辑栏寸土寸金，不放两段切换） */}
              <Pressable
                onPress={() =>
                  setPickerMode((m) => (m === 'browse' ? null : 'browse'))
                }
                style={[
                  styles.currentTagBtn,
                  pickerMode === 'browse' && styles.currentTagBtnActive,
                ]}
              >
                {recordLayer === 'plan' ? (
                  <View
                    style={[
                      styles.planBrushDot,
                      { borderColor: selectedPlanNode ? planColorOf(selectedPlanNode.id) : theme.inkSoft },
                    ]}
                  />
                ) : null}
                <Text style={styles.currentTagText} numberOfLines={1}>
                  {recordLayer === 'plan'
                    ? selectedPlanNode?.title ?? '选任务'
                    : selectedTagId != null
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
                disabled={activeUndo.length === 0}
                style={[
                  styles.iconBtn,
                  { marginLeft: 'auto' },
                  activeUndo.length === 0 && styles.iconBtnDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.iconBtnText,
                    activeUndo.length === 0 && styles.iconBtnTextDisabled,
                  ]}
                >↶</Text>
              </Pressable>
              <Pressable
                onPress={handleRedo}
                disabled={activeRedo.length === 0}
                style={[
                  styles.iconBtn,
                  activeRedo.length === 0 && styles.iconBtnDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.iconBtnText,
                    activeRedo.length === 0 && styles.iconBtnTextDisabled,
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
              const isCompressed = row.kind === 'compressed'
              const period = dayPeriodForHour(rowStartHour(row))
              const periodSegments = rowPeriodSegments(row)
              const labelSegments = periodLabelSegmentsForRow(row)
              return (
                <View
                  key={i}
                  style={[
                    styles.axisCell,
                    isCompressed && styles.axisCellCompressed,
                  ]}
                >
                  <View pointerEvents="none" style={styles.axisPeriodLayers}>
                    {periodSegments.map((seg) => (
                      <View
                        key={seg.key}
                        style={{
                          flex: seg.hours,
                          backgroundColor: alpha(seg.accent, isCompressed ? 0.18 : 0.07),
                        }}
                      />
                    ))}
                  </View>
                  <View pointerEvents="none" style={styles.axisPeriodStrip}>
                    {periodSegments.map((seg) => (
                      <View
                        key={`${seg.key}-strip`}
                        style={{ flex: seg.hours, backgroundColor: seg.accent }}
                      />
                    ))}
                  </View>
                  {labelSegments.length > 0 && (
                    <Text style={styles.axisPeriodLabel} numberOfLines={1}>
                      {labelSegments.map((seg, idx) => (
                        <Text key={seg.key} style={{ color: seg.text }}>
                          {idx > 0 ? '/' : ''}{seg.label}
                        </Text>
                      ))}
                    </Text>
                  )}
                  <Text
                    style={[
                      styles.axisText,
                      isHourMark && styles.axisTextHour,
                      isCompressed && styles.axisTextCompressed,
                      { color: period.text },
                    ]}
                  >
                    {row.kind === 'full'
                      ? fmtMinute(row.startMin)
                      : row.hours.length === 1
                        ? fmtMinute(row.hours[0] * 60)
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
              // chipBelow：focus 第一行（前面没 full row）时 chip 朝下，避免顶到屏幕外
              const chipBelow = row.kind === 'full' && !rows.slice(0, i).some((r) => r.kind === 'full')
              if (row.kind === 'compressed') {
                const period = dayPeriodForHour(rowStartHour(row))
                return (
                  <View
                    key={i}
                    style={[
                      styles.cellRow,
                      styles.cellRowCompressed,
                      { backgroundColor: alpha(period.accent, 0.08) },
                    ]}
                  >
                    {row.hours.map((h) => {
                      const hourPeriod = dayPeriodForHour(h)
                      // hour 内按 5min 块合并成 runs，按时间比例铺色
                      const hourRuns: { mins: number; tag: number | null }[] = []
                      for (let m = h * 60; m < h * 60 + 60; m += 5) {
                        const t = blockByMinute.get(m)?.tagId ?? null
                        const last = hourRuns[hourRuns.length - 1]
                        if (last && last.tag === t) last.mins += 5
                        else hourRuns.push({ mins: 5, tag: t })
                      }
                      return (
                        <View key={h} style={[styles.cellSlot, { backgroundColor: alpha(hourPeriod.accent, 0.035) }]}>
                          <View
                            style={[
                              styles.compressedInner,
                              { backgroundColor: alpha(hourPeriod.accent, 0.1) },
                            ]}
                          >
                            {hourRuns.map((run, idx) => {
                              const widthPct = (run.mins / 60) * 100
                              if (run.tag == null) {
                                return (
                                  <View
                                    key={idx}
                                    style={{
                                      width: `${widthPct}%`,
                                      backgroundColor: alpha(hourPeriod.accent, 0.1),
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
                                    // compressed 折叠预览：色块半透明，跟 focus 区饱和色块对比
                                    // 一眼区分"这是折叠预览不是主舞台"
                                    backgroundColor: alpha(colorOf(run.tag), 0.5),
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    paddingHorizontal: 4,
                                  }}
                                >
                                  {showLabel ? (
                                    <Text style={[styles.cellLabel, styles.cellLabelCompressed]} numberOfLines={1}>
                                      {tagName}
                                    </Text>
                                  ) : null}
                                </View>
                              )
                            })}
                          </View>
                          {renderCompressedPlanMarks(h)}
                          {/* 折叠 hour 标记：左上角"N点"，告诉用户每格代表第几小时 */}
                          <Text style={styles.compressedHourMark}>{h}点</Text>
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
              const period = dayPeriodForHour(Math.floor(rowStart / 60))
              const runs: { l: number; r: number; tag: number }[] = []
              for (let col = 0; col < rowCols; col++) {
                const m = rowStart + col * 5
                const t = blockByMinute.get(m)?.tagId ?? null
                if (t == null) continue
                const last = runs[runs.length - 1]
                if (last && last.tag === t && last.r === col - 1) last.r = col
                else runs.push({ l: col, r: col, tag: t })
              }
              // 计划块：同一任务连着的格子合成一段，画虚线框（desktop drawPlanOutlines）
              const planRowRuns: { l: number; r: number; nodeId: number }[] = []
              for (let col = 0; col < rowCols; col++) {
                const id = plannedByMinute.get(rowStart + col * 5)
                if (id == null) continue
                const last = planRowRuns[planRowRuns.length - 1]
                if (last && last.nodeId === id && last.r === col - 1) last.r = col
                else planRowRuns.push({ l: col, r: col, nodeId: id })
              }
              // 浮岛与日程落在这一行的部分（desktop drawIslands）
              const islandSegs = islandPlacements.flatMap((p) => {
                if (p.start == null || p.end == null || p.end <= p.start) return []
                const s = Math.max(p.start, rowStart)
                const e = Math.min(p.end, rowStart + rowMinutes)
                return e > s ? [{ p, s, e, isFirst: s === p.start }] : []
              })
              return (
                <View key={i} style={[styles.cellRow, { backgroundColor: alpha(period.accent, 0.04) }]}>
                  {Array.from({ length: rowCols }, (_, col) => (
                    <View key={col} style={styles.cellSlot}>
                      <View style={[styles.emptyInner, { backgroundColor: alpha(period.accent, 0.1) }]} />
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
                    // 跨行连接：run 触左边 / 右边时检查相邻行同分钟邻接是否同 tag
                    // 同色 → 该侧不画圆角（看起来像"换行延续"，而不是孤立色块）
                    // 左侧延续：run.l === 0 AND 上一行同列时刻 = 同 tag
                    // 右侧延续：run.r === rowCols-1 AND 下一行 col 0 时刻 = 同 tag
                    const continuesLeft =
                      run.l === 0 &&
                      blockByMinute.get(rowStart - 5)?.tagId === run.tag
                    const continuesRight =
                      run.r === rowCols - 1 &&
                      blockByMinute.get(rowStart + rowMinutes)?.tagId === run.tag
                    return (
                      <View
                        key={`t${run.l}`}
                        style={{
                          position: 'absolute',
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          top: 0,
                          bottom: 0,
                          // 上下间距 GAP/2 保留（行间分隔），同色连接时让左/右触边
                          paddingTop: GAP / 2,
                          paddingBottom: GAP / 2,
                          paddingLeft: continuesLeft ? 0 : GAP / 2,
                          paddingRight: continuesRight ? 0 : GAP / 2,
                        }}
                        pointerEvents="none"
                      >
                        <View
                          style={{
                            flex: 1,
                            backgroundColor: colorOf(run.tag),
                            // 同色延续侧：两个角各自不圆，看起来是同段"换行"
                            borderTopLeftRadius: continuesLeft ? 0 : R_ACTIVITY,
                            borderBottomLeftRadius: continuesLeft ? 0 : R_ACTIVITY,
                            borderTopRightRadius: continuesRight ? 0 : R_ACTIVITY,
                            borderBottomRightRadius: continuesRight ? 0 : R_ACTIVITY,
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
                  {planRowRuns.map((run) => {
                    const color = planColorOf(run.nodeId)
                    const active = recordLayer === 'plan'
                    // 上一行末尾是同一任务 = 换行延续，标题只在开头那段写
                    const continues = run.l === 0 && plannedByMinute.get(rowStart - 5) === run.nodeId
                    const showLabel = !continues && (active || !blockByMinute.has(rowStart + run.l * 5))
                    return (
                      <View
                        key={`p${run.l}`}
                        pointerEvents="none"
                        style={[
                          styles.planRunWrap,
                          {
                            left: `${(run.l / rowCols) * 100}%`,
                            width: `${((run.r - run.l + 1) / rowCols) * 100}%`,
                          },
                        ]}
                      >
                        <View
                          style={[
                            styles.planRun,
                            {
                              borderColor: alpha(color, active ? 0.95 : 0.7),
                              backgroundColor: alpha(color, active ? 0.14 : 0.07),
                              borderWidth: active ? 1.5 : 1.2,
                            },
                          ]}
                        >
                          {showLabel ? (
                            <Text numberOfLines={1} style={[styles.planLabel, { color }]}>
                              {planNodeById.get(run.nodeId)?.title ?? '计划'}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    )
                  })}
                  {islandSegs.map(({ p, s, e, isFirst }) => {
                    const color = islandColorOf(p)
                    const fixed = p.island.rule.kind === 'fixed'
                    const estimated = p.basis === 'estimated'
                    const strength = p.status === 'active' ? 1 : p.status === 'done' ? 0.5
                      : p.status === 'missed' ? 0.6 : estimated ? 0.65 : 0.85
                    const label = `${p.status === 'done' ? '✓ ' : estimated ? '≈ ' : ''}${p.island.rule.name}`
                    const hatchId = `hatch-${p.island.id}-${rowStart}`
                    return (
                      <View
                        key={`i${p.island.id}`}
                        pointerEvents="none"
                        style={[
                          styles.islandWrap,
                          {
                            left: `${((s - rowStart) / rowMinutes) * 100}%`,
                            width: `${((e - s) / rowMinutes) * 100}%`,
                          },
                        ]}
                      >
                        <View
                          style={[
                            styles.islandBox,
                            {
                              // 浮岛圆角、日程直角；位置是估的画虚线
                              borderRadius: fixed ? 2 : R_ISLAND,
                              borderColor: alpha(color, 0.95 * strength),
                              borderStyle: estimated ? 'dashed' : 'solid',
                              borderWidth: p.status === 'active' ? 1.6 : 1.1,
                              backgroundColor: alpha(color, (p.status === 'active' ? 0.18 : 0.08) * strength),
                            },
                          ]}
                        >
                          {fixed ? (
                            // 日程：钉在钟点上，加斜纹（desktop 同样）
                            <Svg style={StyleSheet.absoluteFill}>
                              <Defs>
                                <Pattern
                                  id={hatchId}
                                  width={ISLAND_HATCH_STEP}
                                  height={ISLAND_HATCH_STEP}
                                  patternUnits="userSpaceOnUse"
                                  patternTransform="rotate(45)"
                                >
                                  <Line x1="0" y1="0" x2="0" y2={ISLAND_HATCH_STEP} stroke={alpha(color, 0.22 * strength)} strokeWidth="1" />
                                </Pattern>
                              </Defs>
                              <Rect width="100%" height="100%" fill={`url(#${hatchId})`} />
                            </Svg>
                          ) : null}
                          {isFirst ? (
                            <Text
                              numberOfLines={1}
                              style={[styles.islandLabel, { color: alpha(color, Math.min(1, strength + 0.15)) }]}
                            >
                              {label}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    )
                  })}
                  {/* 当前时间游标：锤子型，chip 紧贴色块上沿 + I 形 cap，
                      位置按秒级精度 = (nowMin - rowStart) + sec/60，占行宽比例
                      仅 isToday + nowMinute 落在本 row 内才画；不响应手势 */}
                  {isToday && nowMinute >= rowStart && nowMinute < rowStart + rowMinutes && (() => {
                    const subSec = nowDate.getSeconds()
                    const offsetMin = (nowMinute - rowStart) + subSec / 60
                    const leftPct = (offsetMin / rowMinutes) * 100
                    const hh = String(nowDate.getHours()).padStart(2, '0')
                    const mm = String(nowDate.getMinutes()).padStart(2, '0')
                    return (
                      <View
                        pointerEvents="none"
                        style={[
                          styles.nowCursorWrap,
                          chipBelow && styles.nowCursorWrapBelow,
                          { left: `${leftPct}%` },
                        ]}
                      >
                        {chipBelow ? (
                          <>
                            <View style={styles.nowCursorCap} />
                            <View style={styles.nowCursorStem} />
                            <View style={styles.nowCursorTimeChip}>
                              <Text style={styles.nowCursorTime}>{hh}:{mm}</Text>
                            </View>
                          </>
                        ) : (
                          <>
                            <View style={styles.nowCursorTimeChip}>
                              <Text style={styles.nowCursorTime}>{hh}:{mm}</Text>
                            </View>
                            <View style={styles.nowCursorStem} />
                            <View style={styles.nowCursorCap} />
                          </>
                        )}
                      </View>
                    )
                  })()}
                </View>
              )
            })}
          </View>
        </View>
      )}


      {/* 浮岛与日程 / 计划安排（desktop 昼夜表右侧栏的「计划」） */}
      <PlanSheet
        visible={planSheet != null}
        initialPage={planSheet ?? 'islands'}
        onClose={() => setPlanSheet(null)}
        selectedDate={selectedDate}
        palette={palette ?? EMPTY_PALETTE}
        islands={islands}
        placements={islandPlacements}
        islandsError={islandsError}
        onIslandsChanged={reloadIslands}
        planNodes={projectPlanNodes}
        selectedProjectTagId={selectedProjectTagId}
        selectedPlanNodeId={selectedPlanNodeId}
        onSelectProject={setSelectedProjectTagId}
        onSelectNode={setSelectedPlanNodeId}
        onPickNode={(id) => {
          // 点了任务卡片 = 要拿它去涂计划：直接进计划层的编辑
          setSelectedPlanNodeId(id)
          setRecordLayer('plan')
          setEditMode(true)
          setPickerMode(null)
        }}
        onNodesChange={() => refreshPlanNodes()}
        onPlanBlocksMayChange={() => {
          // 删任务会连带软删它的计划块：重读，旧快照不能再撤回（AUDIT-022，同 desktop）
          fetchPlannedBlocks(selectedDate).then(setPlannedBlocks).catch(() => {})
          setPlanUndoStack([])
          setPlanRedoStack([])
        }}
      />

      {/* 时段详情 */}
      <Modal visible={!!detail} transparent animationType="fade" onRequestClose={() => setDetail(null)}>
        {/* 结构：backdrop 普通 View（不抢手势）；点空白关闭挪到下层 absoluteFill
            Pressable；sheet 普通 View 在 Pressable 之上 → 命中 sheet 区域时 touch
            直达 ScrollView，ScrollView 能正常滚动 */}
        <View style={styles.backdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setDetail(null)}
          />
          <View style={[styles.sheet, { maxHeight: sheetMaxHeight }]}>
            {detail && (
              <>
                {/* 头部固定 —— handle + dot/name/dur + time + path + note */}
                <View style={styles.sheetHead}>
                  <View style={styles.sheetHandle} />
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
                </View>

                {/* 中部可滚 probe 列表 —— 不再 slice(0,12)，全量可滚 */}
                <ScrollView
                  style={styles.sheetScroll}
                  contentContainerStyle={styles.sheetScrollContent}
                  showsVerticalScrollIndicator
                >
                  <View style={styles.sheetProbe}>
                    {(() => {
                      const midnight = new Date(selectedDate)
                      midnight.setHours(0, 0, 0, 0)
                      const detailEndMs = midnight.getTime() + detail.endMin * 60_000
                      const appRuns = buildProbeAppRuns(probeSegments, detailEndMs)
                      const powerSegments = probeSegments.filter((seg) => seg.kind === 'power')
                      // 合并 app run + power，按正式段 startMs 正序展示
                      type Merged =
                        | { kind: 'app'; key: string; ts: number; run: ProbeAppRun }
                        | { kind: 'power'; key: string; ts: number; ev: AppMonitorSegment }
                      const merged: Merged[] = [
                        ...appRuns.map((run) => ({
                          kind: 'app' as const, key: run.key, ts: run.startMs, run,
                        })),
                        ...powerSegments.map((ev) => ({
                          kind: 'power' as const, key: `p${ev.rowId}`, ts: ev.startMs, ev,
                        })),
                      ].sort((a, b) => a.ts - b.ts)
                      return (
                        <>
                          <Text style={styles.sheetProbeLabel}>
                            在这段时间手机
                            {appRuns.length > 0 ? ` · ${appRuns.length} 段应用` : ''}
                            {appRuns.length > 0 ? ` / ${appRuns.reduce((sum, run) => sum + run.eventCount, 0)} 次窗口信号` : ''}
                            {powerSegments.length > 0 ? ` （含 ${powerSegments.length} 条屏幕事件）` : ''}
                          </Text>
                          {probeLoading ? (
                            <Text style={styles.sheetProbeEmpty}>读取中…</Text>
                          ) : merged.length === 0 ? (
                            <Text style={styles.sheetProbeEmpty}>
                              没有窗口切换 / 屏幕事件（可能 Service 未启用、或当时没动手机）
                            </Text>
                          ) : (
                            merged.map((row) => {
                              if (row.kind === 'power') {
                                const e = row.ev
	                                const label =
	                                  e.eventType === 'screen_off' ? '屏幕关闭'
	                                  : e.eventType === 'screen_on' ? '屏幕亮起'
	                                  : e.eventType === 'unlocked' ? '解锁'
	                                  : e.eventType === 'service_started' ? '感知 Service 启动'
	                                  : e.eventType
	                                const dim = e.eventType === 'screen_off'
	                                return (
	                                  <View key={row.key} style={styles.sheetPowerRow}>
	                                    <Text style={styles.sheetProbeTime}>{fmtHHMMms(e.startMs)}</Text>
	                                    <Text style={[styles.sheetPowerText, dim && { color: theme.inkSoft }]}>
	                                      {label}
	                                    </Text>
	                                  </View>
	                                )
                              }
                              const run = row.run
                              const label = run.appLabel || run.packageName
                              const subtitle = run.titles[run.titles.length - 1] ?? ''
                              const b64 = iconCache[run.packageName]
                              const initial = (label || '?').slice(0, 1).toUpperCase()
                              const dur = fmtMsDuration(run.endMs - run.startMs)
                              return (
                                <View key={row.key} style={styles.sheetProbeRow}>
                                  <Text style={styles.sheetProbeTime}>
                                    {fmtHHMMms(run.startMs)}
                                    {run.endMs > run.startMs ? `\n${fmtHHMMms(run.endMs)}` : ''}
                                  </Text>
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
                                    <View style={styles.sheetProbeAppHead}>
                                      <Text style={styles.sheetProbeApp} numberOfLines={1}>{label}</Text>
                                      <Text style={styles.sheetProbeMeta}>
                                        {dur}{run.eventCount > 1 ? ` · ${run.eventCount} 次变化` : ''}
                                      </Text>
                                    </View>
                                    {!!subtitle && (
                                      <Text style={styles.sheetProbeSub} numberOfLines={1}>
                                        {subtitle}
                                      </Text>
                                    )}
                                  </View>
                                </View>
                              )
                            })
                          )}
                        </>
                      )
                    })()}
                  </View>
                </ScrollView>

              </>
            )}
          </View>
        </View>
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
      {/* 当日分类/标签统计 —— 点击顶部条形图弹出 */}
      <Modal
        visible={statsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setStatsOpen(false)}
      >
        <View style={styles.backdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setStatsOpen(false)}
          />
          <View style={[styles.sheet, { maxHeight: sheetMaxHeight }]}>
            <View style={styles.sheetHead}>
              <View style={styles.sheetHandle} />
              <View style={styles.sheetTop}>
                <Text style={styles.sheetName}>当日统计</Text>
                <Text style={styles.sheetDur}>{fmtHM(summary.total)}</Text>
              </View>
              <Text style={styles.sheetTime}>
                {summary.rows.length} 个分类 ·{' '}
                {summary.rows.reduce((n, r) => n + r.tags.length, 0)} 个标签
              </Text>
            </View>
            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetScrollContent}
              showsVerticalScrollIndicator
            >
              {summary.rows.map((row) => {
                const catPct = summary.total > 0 ? (row.mins / summary.total) * 100 : 0
                return (
                  <View key={row.cat.id} style={styles.statsCatBlock}>
                    <View style={styles.statsCatHead}>
                      <View
                        style={[styles.statsCatDot, { backgroundColor: row.cat.color }]}
                      />
                      <Text style={styles.statsCatName}>{row.cat.name}</Text>
                      <Text style={styles.statsCatMins}>{fmtHM(row.mins)}</Text>
                      <Text style={styles.statsCatPct}>{catPct.toFixed(1)}%</Text>
                    </View>
                    {row.tags.map((t) => {
                      const tagPct =
                        summary.total > 0 ? (t.mins / summary.total) * 100 : 0
                      const tagCatPct = row.mins > 0 ? (t.mins / row.mins) * 100 : 0
                      return (
                        <View key={t.tag.id} style={styles.statsTagRow}>
                          <View
                            style={[
                              styles.statsTagBarBg,
                              { backgroundColor: alpha(row.cat.color, 0.18) },
                            ]}
                          >
                            <View
                              style={[
                                styles.statsTagBarFill,
                                {
                                  width: `${tagCatPct}%`,
                                  backgroundColor: row.cat.color,
                                },
                              ]}
                            />
                          </View>
                          <Text style={styles.statsTagName} numberOfLines={1}>
                            {t.tag.leafName}
                          </Text>
                          <Text style={styles.statsTagMins}>{fmtHM(t.mins)}</Text>
                          <Text style={styles.statsTagPct}>{tagPct.toFixed(1)}%</Text>
                        </View>
                      )
                    })}
                  </View>
                )
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 月历选日期面板 —— 每个 cell 背景环显示当日记录时段 */}
      <CalendarPopover
        open={calendarOpen}
        selectedDate={selectedDate}
        tagById={tagById}
        categoryById={categoryById}
        onSelect={setSelectedDate}
        onClose={() => setCalendarOpen(false)}
      />
      {/* 标签 / 分类长按 → 操作菜单（修改 / 删除） */}
      <Modal
        visible={tagAction != null}
        transparent
        animationType="fade"
        onRequestClose={() => setTagAction(null)}
      >
        <View style={styles.actionBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setTagAction(null)}
          />
          {tagAction && (
            <View style={styles.actionSheet}>
              <Text style={styles.actionSheetTitle} numberOfLines={1}>
                {tagAction.kind === 'category' ? '分类' : '标签'}「{tagAction.label}」
              </Text>
              <Pressable
                style={styles.actionItem}
                onPress={() => {
                  if (tagAction.kind === 'tag') {
                    // 用 fullPath 做初值，让用户能改前面的部分（包括换分类）
                    setTagEdit({ kind: 'tag', id: tagAction.id, name: tagAction.label, original: tagAction.label })
                  } else {
                    setTagEdit({ kind: 'category', id: tagAction.id, name: tagAction.label, color: tagAction.color, original: tagAction.label, originalColor: tagAction.color })
                  }
                  setTagAction(null)
                }}
              >
                <Text style={styles.actionItemText}>修改</Text>
              </Pressable>
              <Pressable
                style={[styles.actionItem, styles.actionItemDanger]}
                onPress={() => {
                  setConfirmDelete({ kind: tagAction.kind, id: tagAction.id, label: tagAction.label })
                  setTagAction(null)
                }}
              >
                <Text style={[styles.actionItemText, styles.actionItemTextDanger]}>删除</Text>
              </Pressable>
              <Pressable
                style={[styles.actionItem, styles.actionItemCancel]}
                onPress={() => setTagAction(null)}
              >
                <Text style={styles.actionItemTextCancel}>取消</Text>
              </Pressable>
            </View>
	          )}
	        </View>
	      </Modal>

	      {/* 分类行调色板：点分类文本后的按钮直接切换共享色 */}
	      <Modal
	        visible={categoryColorEdit != null}
	        transparent
	        animationType="fade"
	        onRequestClose={() => setCategoryColorEdit(null)}
	      >
	        <View style={styles.actionBackdrop}>
	          <Pressable
	            style={StyleSheet.absoluteFill}
	            onPress={() => setCategoryColorEdit(null)}
	          />
	          {categoryColorEdit && (
	            <View style={styles.editSheet}>
	              <Text style={styles.editSheetTitle}>分类颜色</Text>
	              <Text style={styles.colorSheetSub}>
	                「{categoryColorEdit.name}」下所有标签共享这个颜色
	              </Text>
	              <View style={styles.colorCurrentRow}>
	                <Text style={styles.colorCurrentLabel}>当前</Text>
	                <View
	                  style={[
	                    styles.editColorChip,
	                    { backgroundColor: categoryColorEdit.color },
	                    styles.editColorChipActive,
	                    colorUsedBy(categoryColorEdit.color, categoryColorEdit.id) && styles.editColorChipUsed,
	                  ]}
	                />
	              </View>
	              <View style={styles.editColorRow}>
	                {CATEGORY_PALETTE_COLORS.map((c) => (
	                  <Pressable
	                    key={c}
	                    onPress={() => {
	                      const item = categoryColorEdit
	                      pickCategoryColor(c, item.id, async () => {
	                        try {
	                          const next = await renameCategory(item.id, null, c)
	                          setPalette(next)
	                          setCategoryColorEdit(null)
	                        } catch (e) {
	                          console.warn('[category color] failed', e)
	                        }
	                      })
	                    }}
	                    style={[
	                      styles.editColorChip,
	                      { backgroundColor: c },
	                      categoryColorEdit.color === c && styles.editColorChipActive,
	                      colorUsedBy(c, categoryColorEdit.id) && styles.editColorChipUsed,
	                    ]}
	                  />
	                ))}
	              </View>
	              <View style={styles.editActions}>
	                <Pressable style={styles.editBtnGhost} onPress={() => setCategoryColorEdit(null)}>
	                  <Text style={styles.editBtnGhostText}>取消</Text>
	                </Pressable>
	              </View>
	            </View>
	          )}
	        </View>
	      </Modal>

	      {/* 新建标签遇到新分类：先确认分类 + 选颜色 */}
	      <Modal
	        visible={pendingCreateCategory != null}
	        transparent
	        animationType="fade"
	        onRequestClose={() => setPendingCreateCategory(null)}
	      >
	        <View style={styles.actionBackdrop}>
	          <Pressable
	            style={StyleSheet.absoluteFill}
	            onPress={() => setPendingCreateCategory(null)}
	          />
	          {pendingCreateCategory && (
	            <View style={styles.editSheet}>
	              <Text style={styles.editSheetTitle}>新建分类</Text>
	              <Text style={styles.colorSheetSub}>
	                将创建分类「{pendingCreateCategory.categoryName}」，并新建标签「{pendingCreateCategory.fullPath}」
	              </Text>
	              <Text style={styles.editFieldLabel}>分类颜色</Text>
	              <View style={styles.colorCurrentRow}>
	                <Text style={styles.colorCurrentLabel}>当前</Text>
	                <View
	                  style={[
	                    styles.editColorChip,
	                    { backgroundColor: pendingCreateCategory.color },
	                    styles.editColorChipActive,
	                    colorUsedBy(pendingCreateCategory.color) && styles.editColorChipUsed,
	                  ]}
	                />
	              </View>
	              <View style={styles.editColorRow}>
	                {CATEGORY_PALETTE_COLORS.map((c) => (
	                  <Pressable
	                    key={c}
	                    onPress={() =>
	                      pickCategoryColor(c, undefined, () =>
	                        setPendingCreateCategory((cur) => cur ? { ...cur, color: c } : cur),
	                      )
	                    }
	                    style={[
	                      styles.editColorChip,
	                      { backgroundColor: c },
	                      pendingCreateCategory.color === c && styles.editColorChipActive,
	                      colorUsedBy(c) && styles.editColorChipUsed,
	                    ]}
	                  />
	                ))}
	              </View>
	              <View style={styles.editActions}>
	                <Pressable style={styles.editBtnGhost} onPress={() => setPendingCreateCategory(null)}>
	                  <Text style={styles.editBtnGhostText}>取消</Text>
	                </Pressable>
	                <Pressable
	                  style={styles.editBtnPrimary}
	                  onPress={() => {
	                    const item = pendingCreateCategory
	                    pickCategoryColor(item.color, undefined, () => {
	                      setPendingCreateCategory(null)
	                      createAndPickTag(item.fullPath, item.color)
	                    })
	                  }}
	                >
	                  <Text style={styles.editBtnPrimaryText}>创建</Text>
	                </Pressable>
	              </View>
	            </View>
	          )}
	        </View>
	      </Modal>

	      {/* 标签 / 分类 修改 modal */}
	      <Modal
        visible={tagEdit != null}
        transparent
        animationType="fade"
        onRequestClose={() => setTagEdit(null)}
      >
        <View style={styles.actionBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setTagEdit(null)}
          />
          {tagEdit && (
            <View style={styles.editSheet}>
              <Text style={styles.editSheetTitle}>
                修改{tagEdit.kind === 'category' ? '分类' : '标签'}
              </Text>
              <Text style={styles.editFieldLabel}>
                {tagEdit.kind === 'category' ? '名称' : '完整路径（含分类，逗号分隔）'}
              </Text>
              <TextInput
                style={styles.editInput}
                value={tagEdit.name}
                onChangeText={(v) =>
                  setTagEdit((cur) => (cur ? { ...cur, name: v.replace(/，/g, ',') } as typeof cur : cur))
                }
                placeholder={tagEdit.kind === 'category' ? '分类名' : '如 学习,英语,新概念3'}
                placeholderTextColor={theme.inkFaint}
              />
              {tagEdit.kind === 'category' && (
	                <>
		                  <Text style={styles.editFieldLabel}>颜色</Text>
		                  <View style={styles.colorCurrentRow}>
		                    <Text style={styles.colorCurrentLabel}>当前</Text>
		                    <View
		                      style={[
		                        styles.editColorChip,
		                        { backgroundColor: tagEdit.color },
		                        styles.editColorChipActive,
		                        colorUsedBy(tagEdit.color, tagEdit.id) && styles.editColorChipUsed,
		                      ]}
		                    />
		                  </View>
		                  <View style={styles.editColorRow}>
		                    {CATEGORY_PALETTE_COLORS.map((c) => (
		                      <Pressable
		                        key={c}
	                        onPress={() =>
	                          pickCategoryColor(c, tagEdit.id, () =>
	                            setTagEdit((cur) =>
	                              cur && cur.kind === 'category' ? { ...cur, color: c } : cur,
	                            ),
	                          )
	                        }
	                        style={[
	                          styles.editColorChip,
	                          { backgroundColor: c },
	                          tagEdit.color === c && styles.editColorChipActive,
	                          colorUsedBy(c, tagEdit.id) && styles.editColorChipUsed,
	                        ]}
	                      />
                    ))}
                  </View>
                </>
              )}
              <View style={styles.editActions}>
                <Pressable style={styles.editBtnGhost} onPress={() => setTagEdit(null)}>
                  <Text style={styles.editBtnGhostText}>取消</Text>
                </Pressable>
                <Pressable
                  style={styles.editBtnPrimary}
                  onPress={() => {
                    if (!tagEdit) return
                    const trimmed = tagEdit.name.trim()
                    if (!trimmed) return
                    // 没改动 → 直接关闭，不弹确认（避免无意义二次点击）
                    const noChange = tagEdit.kind === 'tag'
                      ? trimmed === tagEdit.original
                      : trimmed === tagEdit.original && tagEdit.color === tagEdit.originalColor
                    if (noChange) {
                      setTagEdit(null)
                      return
                    }
                    if (tagEdit.kind === 'tag') {
                      // 后代 = 路径以「原路径,」开头的其它标签（父节点改名要问是否级联）
                      const descendants = palette
                        ? palette.tags.filter((t) => t.id !== tagEdit.id && t.fullPath.startsWith(tagEdit.original + ',')).length
                        : 0
                      setPendingRename({ kind: 'tag', id: tagEdit.id, original: tagEdit.original, newFullPath: trimmed, descendants })
                    } else {
                      const childTags = palette
                        ? palette.tags.filter((t) => t.fullPath === tagEdit.original || t.fullPath.startsWith(tagEdit.original + ',')).length
                        : 0
                      setPendingRename({ kind: 'category', id: tagEdit.id, original: tagEdit.original, newName: trimmed, newColor: tagEdit.color, childTags })
                    }
                    setTagEdit(null)
                  }}
                >
                  <Text style={styles.editBtnPrimaryText}>保存</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </Modal>

      {/* 修改确认（rename 保存前再问一次，避免误改 LWW 同步会传到其他端）
          父节点标签（有后代）三键：取消放弃 / 仅此节点（后代独立留原路径）/ 全部跟随（级联前缀替换） */}
	      <ConfirmDialog
	        open={pendingRename != null}
	        title={
	          pendingRename?.kind === 'category'
	            ? '修改分类'
	            : pendingRename && pendingRename.descendants > 0
	              ? '修改父节点标签'
	              : '修改标签'
	        }
        body={
          pendingRename?.kind === 'category'
            ? `分类「${pendingRename.original}」→「${pendingRename.newName}」\n颜色 ${pendingRename.newColor}${
                pendingRename.childTags > 0 && pendingRename.newName !== pendingRename.original
                  ? `\n\n分类下 ${pendingRename.childTags} 个标签路径将跟随更新`
                  : ''
              }`
            : pendingRename
              ? `标签「${pendingRename.original}」→「${pendingRename.newFullPath}」${
                  pendingRename.descendants > 0
                    ? `\n\n该节点下有 ${pendingRename.descendants} 个子标签：\n「全部跟随」= 子标签路径一并改名\n「仅此节点」= 只改本节点（含其时间段），子标签保持原路径独立`
                    : ''
                }`
              : ''
        }
        confirmText={pendingRename?.kind === 'tag' && pendingRename.descendants > 0 ? '全部跟随' : '保存'}
        cancelText="取消"
        secondaryText={pendingRename?.kind === 'tag' && pendingRename.descendants > 0 ? '仅此节点' : undefined}
        onSecondary={
          pendingRename?.kind === 'tag' && pendingRename.descendants > 0
            ? async () => {
                const item = pendingRename
                setPendingRename(null)
                try {
                  setPalette(await renameTagPath(item.id, item.newFullPath, false))
                } catch (e) {
                  console.warn('[rename] failed', e)
                }
              }
            : undefined
        }
        onCancel={() => setPendingRename(null)}
        onConfirm={async () => {
          if (!pendingRename) return
          const item = pendingRename
          setPendingRename(null)
          try {
            const next = item.kind === 'tag'
              ? await renameTagPath(item.id, item.newFullPath, item.descendants > 0)
              : await renameCategory(item.id, item.newName, item.newColor)
            setPalette(next)
          } catch (e) {
            console.warn('[rename] failed', e)
	          }
	        }}
	      />

	      <ConfirmDialog
	        open={pendingColorConflict != null}
	        title="颜色已被使用"
	        body={
	          pendingColorConflict
	            ? `这个颜色已在「${pendingColorConflict.usedBy}」分类使用。\n真的要选择这个颜色吗？`
	            : ''
	        }
	        confirmText="仍然选择"
	        cancelText="换一个"
	        onCancel={() => setPendingColorConflict(null)}
	        onConfirm={() => {
	          const item = pendingColorConflict
	          setPendingColorConflict(null)
	          item?.apply()
	        }}
	      />

      <ConfirmDialog
        open={pendingFullRowReplace != null}
        title="确认覆盖整行活动"
        body={pendingFullRowReplace?.body ?? ''}
        confirmText="覆盖"
        cancelText="取消"
        danger
        onCancel={() => {
          const item = pendingFullRowReplace
          setPendingFullRowReplace(null)
          if (item) setBlocks(item.commit.snapshot)
        }}
        onConfirm={() => {
          const item = pendingFullRowReplace
          setPendingFullRowReplace(null)
          if (item) commitPaintEdit(item.commit)
        }}
      />

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
          DayNightScreen 是 flex:1 占 TabBar 以上空间，bottom:8 即贴近 TabBar 上沿
          全屏 backdrop Pressable：点 picker 外区域 = dismiss 键盘 + 关 picker */}
      {editMode && tagPickerOpen && palette && (
        <>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              Keyboard.dismiss()
              setPickerMode(null)
            }}
          />
          <View
            style={[
              styles.pickerFloat,
              { top: actionSlotBottom + 4 },
            ]}
            pointerEvents="box-none"
          >
          <View style={styles.pickerCloud}>
            {/* 涂哪一层：记录（实际）/ 计划（desktop DayNightToolbar 的两段切换，手机端放在展开面板里） */}
            <View style={styles.pickerTabs}>
              {(['actual', 'plan'] as const).map((layer) => {
                const on = recordLayer === layer
                return (
                  <Pressable
                    key={layer}
                    onPress={() => setRecordLayer(layer)}
                    style={[styles.pickerTab, on && styles.pickerTabOn]}
                  >
                    <Text style={[styles.pickerTabText, on && styles.pickerTabTextOn]}>
                      {layer === 'actual' ? '记录' : '计划'}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
            {recordLayer === 'plan' ? renderTaskPicker() : (
            <>
            {/* 搜索框 + 左侧 "+" 按钮 = 新建模式入口（对齐 desktop）。
                addMode=true 时同一输入框语义变成"新标签完整路径"，下方 tag 列表
                点击 = 回填路径，节省手打父节点。
                onChangeText 把中文逗号 → 英文逗号 normalize，避免用户输入法切换烦。
                × 只清空 query，不关 picker —— 关 picker 由 toolbar 上的按钮负责 */}
            <Pressable
              style={styles.searchBoxInCloud}
              onPress={() => searchInputRef.current?.focus()}
            >
              <Pressable
                hitSlop={8}
                onPress={() => {
                  setAddMode((m) => !m)
                  // 进入新建模式聚焦输入框方便直接打
                  setTimeout(() => searchInputRef.current?.focus(), 30)
                }}
                style={[
                  styles.searchAddBtn,
                  addMode && styles.searchAddBtnOn,
                ]}
              >
                <Text style={[styles.searchAddText, addMode && styles.searchAddTextOn]}>
                  {addMode ? '×' : '+'}
                </Text>
              </Pressable>
              {!addMode && <SearchGlyph color={theme.inkSoft} />}
              <TextInput
                ref={searchInputRef}
                value={tagQuery}
                onChangeText={(t) => setTagQuery(t.replace(/，/g, ','))}
                placeholder={addMode ? '新标签完整路径，如「编程,氛围编程,xxx」' : '搜索标签 / 分类...'}
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
            </Pressable>
            {/* recent 5 个常用，单独一行常驻在标签云顶部，给"老用户回到熟悉标签"用。
                addMode 下点击 = 回填 fullPath+ "," 到搜索框（当父路径） */}
            {recentTags.length > 0 && (
              <View style={styles.recentRowInCloud}>
                <Text style={styles.recentLabel}>{addMode ? '父路径' : '最近'}</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.recentChips}
                >
                {recentTags.map((tag) => {
                  const on = tag.id === selectedTagId
                  const c = colorOf(tag.id)
                  return (
                    <Pressable
                      key={tag.id}
                      onPress={() => {
                        if (addMode) {
                          setTagQuery(tag.fullPath + ',')
                          searchInputRef.current?.focus()
                        } else {
                          pickTag(tag.id)
                        }
                      }}
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
                </ScrollView>
              </View>
            )}
            {palette.tags.length === 0 ? (
              <View style={styles.emptyHintBox}>
                <Text style={styles.emptyHintTitle}>还没有标签 ·  以下任一方式开始：</Text>
                <Pressable
                  style={[styles.seedBtn, seeding && styles.seedBtnDisabled]}
                  onPress={seeding ? undefined : seedDefaults}
                  disabled={seeding}
                >
                  <ZapGlyph color="#FFF" size={14} />
                  <Text style={styles.seedBtnTitle} numberOfLines={1}>
                    {seeding ? '初始化中…' : '一键初始化'}
                    {!seeding && (
                      <Text style={styles.seedBtnSub}>  (7 分类 + 26 标签)</Text>
                    )}
                  </Text>
                </Pressable>
                <Text style={styles.emptyHintSub}>
                  也可以从电脑端 / 旧手机的<Text style={styles.pickerHintStrong}>局域网同步</Text>过来{'\n'}
                  或点左侧 <Text style={styles.pickerHintStrong}>+</Text> 自己输入 <Text style={styles.pickerHintStrong}>分类,标签</Text> 新建
                </Text>
              </View>
            ) : (
              <Text style={styles.pickerHint}>
                {addMode
                  ? '新建模式 · 点下方标签 = 把它当父路径回填到输入框，再续写子节点'
                  : tagQuery
                    ? `匹配 ${filteredTags.length} / ${palette.tags.length} 个`
                    : `全部 ${palette.tags.length} 个标签 · 输入过滤 · 点 + 新建 · 长按 修改 / 删除`}
              </Text>
            )}
            {(() => {
              // 中文逗号 onChangeText 已 normalize；这里再兜底一次 + 去首尾逗号
              const trimmed = tagQuery.replace(/，/g, ',').trim().replace(/^,+|,+$/g, '')
              const segs = trimmed.split(',').map((s) => s.trim()).filter(Boolean)
              // addMode 下：1 段也允许（用户准备打首段分类名时也展示创建按钮）
              // 非 addMode：保留旧行为，至少 2 段才出"新建"按钮
              const minSegs = addMode ? 1 : 2
              if (segs.length < minSegs) return null
              const normalized = segs.join(',')
              const exists = palette.tags.some((t) => t.fullPath === normalized)
              if (exists) return null
              const isNewCat = !palette.categories.some((c) => c.name === segs[0])
              const leaf = segs[segs.length - 1]
              const parent = segs.slice(0, -1).join(' › ')
              return (
	                <Pressable
	                  style={styles.createRow}
	                  onPress={() => {
	                    if (isNewCat) {
	                      setPendingCreateCategory({
	                        fullPath: normalized,
	                        categoryName: segs[0],
	                        color: suggestCategoryColor(palette.categories),
	                      })
	                      return
	                    }
	                    createAndPickTag(normalized)
	                  }}
	                >
                  <Text style={styles.createPlus}>+</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.createMain}>
                      新建{segs.length === 1 ? '分类' : '标签'} 「{leaf}」
                    </Text>
                    {segs.length >= 2 && (
                      <Text style={styles.createPath}>
                        {parent}
                        {isNewCat && <Text style={styles.createNewCat}>  · 含新分类「{segs[0]}」</Text>}
                      </Text>
                    )}
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
                    onPickPath={addMode
                      ? (fullPath) => {
                          setTagQuery(fullPath + ',')
                          searchInputRef.current?.focus()
                        }
                      : undefined}
                    onOpenCategoryColor={(name) => {
                      const cat = palette.categories.find((c) => c.name === name)
                      if (cat) setCategoryColorEdit({ id: cat.id, name: cat.name, color: cat.color })
                    }}
                    onLongPressTag={(t) =>
                      setTagAction({ kind: 'tag', id: t.id, label: t.fullPath, leafName: t.leafName })
                    }
                    onLongPressCategory={(name) => {
                      const cat = palette.categories.find((c) => c.name === name)
                      if (cat) setTagAction({ kind: 'category', id: cat.id, label: name, color: cat.color })
                    }}
                  />
                ))
              )}
            </ScrollView>
            </>
            )}
          </View>
          </View>
        </>
      )}
    </View>
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
  // 中部一行：日期 + 可选"回到今天"chip 并列
  dateCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  dateText: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.ink,
  },
  // 回到今天 chip：跟在日期右侧，非今天才显示
  backTodayChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: alpha(theme.accent, 0.12),
  },
  backTodayChipText: {
    fontSize: 11,
    color: theme.accent,
    fontWeight: '600',
    letterSpacing: 0.3,
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
    paddingBottom: 4,
    gap: 7,
  },
  summaryText: {
    fontSize: 13,
    color: theme.ink,
    fontWeight: '500',
  },
  summaryStrong: {
    color: theme.ink,
    fontWeight: '700',
  },
  sumBar: {
    height: 20,
    borderRadius: 5,
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: theme.line,
  },
  sumSeg: {
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  sumSegText: {
    fontSize: 11,
    color: '#FFF',
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  sumChips: {
    flexDirection: 'row',
    gap: 12,
    paddingRight: 18,
    paddingVertical: 2,
  },
  sumChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  sumChipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  sumChipText: {
    fontSize: 12,
    color: theme.ink,
    fontWeight: '500',
  },
  sumChipMins: {
    color: theme.inkSoft,
    fontWeight: '400',
  },
  // 当日统计 modal
  statsCatBlock: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.lineSoft,
  },
  statsCatHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 8,
  },
  statsCatDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statsCatName: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.ink,
    flex: 1,
  },
  statsCatMins: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.ink,
  },
  statsCatPct: {
    fontSize: 12,
    color: theme.inkSoft,
    minWidth: 48,
    textAlign: 'right',
  },
  statsTagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
    paddingLeft: 18,
  },
  statsTagBarBg: {
    width: 60,
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  statsTagBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  statsTagName: {
    flex: 1,
    fontSize: 13,
    color: theme.ink,
  },
  statsTagMins: {
    fontSize: 12,
    color: theme.inkSoft,
  },
  statsTagPct: {
    fontSize: 12,
    color: theme.inkSoft,
    minWidth: 48,
    textAlign: 'right',
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
    position: 'relative',
    overflow: 'hidden',
  },
  axisPeriodLayers: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'column',
  },
  axisPeriodStrip: {
    position: 'absolute',
    left: 0,
    top: 3,
    bottom: 3,
    width: 3,
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
    overflow: 'hidden',
    opacity: 0.72,
  },
  axisPeriodLabel: {
    fontSize: 8,
    fontWeight: '800',
    lineHeight: 10,
    includeFontPadding: false,
  },
  // compressed 行 axis 加浅灰底，跟 cellRowCompressed 视觉对齐
  axisCellCompressed: {
    backgroundColor: theme.lineSoft,
  },
  axisText: {
    fontSize: 10,
    color: theme.inkSoft,
    letterSpacing: 0.3,
    fontWeight: '500',
  },
  // compressed 行 axis 文字弱化（提示"折叠预览，不可编辑"）
  axisTextCompressed: {
    color: theme.inkFaint,
    fontWeight: '400',
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
    position: 'relative',
  },
  // 锤子形游标 wrap：chip 紧贴色块上沿，cap 紧贴色块下沿
  // 色块视觉边沿 = cellRow 上下各内缩 GAP/2 (= 2px)
  // wrap top = -(chipH - GAP/2) ≈ -12，让 chip 底落在色块上沿
  // wrap bottom = -(capH - GAP/2) = 0，让 cap 顶落在色块下沿
  nowCursorWrap: {
    position: 'absolute',
    top: -12,
    bottom: 0,
    width: 50,
    marginLeft: -25,
    alignItems: 'center',
    zIndex: 10,
  },
  // focus 第一行：chip 朝下，cap 朝上，上下偏移反过来
  nowCursorWrapBelow: {
    top: 0,
    bottom: -12,
  },
  nowCursorTimeChip: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: theme.accent,
  },
  nowCursorTime: {
    fontSize: 10,
    fontWeight: '700',
    color: '#FFF',
    letterSpacing: 0.3,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
  },
  nowCursorCap: {
    width: 10,
    height: 2,
    backgroundColor: theme.accent,
    borderRadius: 1,
  },
  nowCursorStem: {
    flex: 1,
    width: 2,
    backgroundColor: theme.accent,
  },
  // compressed 行整行浅灰底，提示"折叠预览区，不响应编辑"
  cellRowCompressed: {
    backgroundColor: theme.lineSoft,
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
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  // compressed 行 cell 文字弱化（alpha 色块上白字对比变弱时切深字反而清楚）
  cellLabelCompressed: {
    color: 'rgba(255,255,255,0.92)',
    fontWeight: '500',
  },
  // compressed 行：每个 hour cell 左上角的"N 点"标记，黑色半透明
  compressedHourMark: {
    position: 'absolute',
    left: 4,
    top: 1,
    fontSize: 10,
    color: 'rgba(0,0,0,0.5)',
    fontWeight: '500',
  },
  // —— 计划层：计划块虚线框、浮岛 / 日程框、折叠行细条 ——
  planRunWrap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    paddingVertical: PLAN_INSET,
    paddingHorizontal: PLAN_INSET,
  },
  planRun: {
    flex: 1,
    borderRadius: R_PLAN,
    borderStyle: 'dashed',
    overflow: 'hidden',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
  },
  // 标签贴左上角，白底小条：底下压着实际色块时也看得清（浮岛标签在右上角，互不挡）
  planLabel: {
    marginTop: 2,
    marginLeft: 3,
    maxWidth: '92%',
    paddingHorizontal: 3,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.86)',
    fontSize: 9,
    fontWeight: '700',
    includeFontPadding: false,
  },
  islandWrap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    padding: ISLAND_INSET,
  },
  islandBox: {
    flex: 1,
    overflow: 'hidden',
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
  },
  islandLabel: {
    marginTop: 2,
    marginRight: 3,
    maxWidth: '92%',
    paddingHorizontal: 3,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.86)',
    fontSize: 9,
    fontWeight: '700',
    includeFontPadding: false,
  },
  compressedMarks: {
    position: 'absolute',
    left: GAP / 2 + 2,
    right: GAP / 2 + 2,
    bottom: GAP / 2 + 2,
    height: 6,
  },
  compressedIslandBar: {
    position: 'absolute',
    top: 0,
    height: 2.5,
    borderRadius: 1.25,
  },
  compressedPlanBar: {
    position: 'absolute',
    bottom: 0,
    height: 2.5,
    borderRadius: 1.25,
  },
  // 非编辑时：编辑按钮占满，右边一个「计划」次级按钮
  idleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  idleEditBtn: {
    flex: 1,
  },
  planOpenBtn: {
    height: 42,
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.line,
  },
  planOpenText: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.ink,
    letterSpacing: 0.6,
  },
  // 展开面板顶上的「记录 / 计划」页签
  pickerTabs: {
    flexDirection: 'row',
    padding: 2,
    borderRadius: 12,
    backgroundColor: theme.sunk,
    marginBottom: 10,
  },
  pickerTab: {
    flex: 1,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerTabOn: {
    backgroundColor: theme.surface,
  },
  pickerTabText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.inkSoft,
  },
  pickerTabTextOn: {
    color: theme.ink,
  },
  // 计划页：任务列表
  taskSearchIcon: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskHintRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  taskManageLink: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.accent,
    letterSpacing: 0.3,
  },
  taskGroup: {
    marginBottom: 10,
  },
  taskGroupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  taskGroupDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  taskGroupName: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '600',
    color: theme.inkSoft,
  },
  taskGroupCount: {
    fontSize: 11,
    color: theme.inkFaint,
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: theme.bg,
  },
  taskTitle: {
    flexShrink: 1,
    fontSize: 13.5,
    fontWeight: '600',
    color: theme.ink,
  },
  taskParent: {
    marginLeft: 'auto',
    flexShrink: 1,
    fontSize: 11,
    color: theme.inkFaint,
  },
  taskEmpty: {
    alignItems: 'flex-start',
    gap: 8,
  },
  taskEmptyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: theme.accentSoft,
  },
  taskEmptyBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: theme.accent,
  },
  planBrushDot: {
    width: 10,
    height: 10,
    borderRadius: 3,
    borderWidth: 1.5,
    borderStyle: 'dashed',
  },
  // —— 顶部操作槽位：固定高度，idle = 整行居中编辑按钮，editing = 横排小按钮 ——
  actionSlot: {
    height: 46,
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
    paddingHorizontal: 6,  // 左侧 + 按钮自己有 padding，外层给小一点
    paddingRight: 12,
    borderRadius: 19,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.accent,
    marginBottom: 10,
  },
  // 左侧"+"按钮：addMode 开关，对齐 desktop ActivityTagPalette 的 + 按钮
  searchAddBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: alpha(theme.accent, 0.12),
  },
  searchAddBtnOn: {
    backgroundColor: theme.accent,
  },
  searchAddText: {
    fontSize: 20,
    fontWeight: '600',
    lineHeight: 22,
    color: theme.accent,
    includeFontPadding: false,
  },
  searchAddTextOn: {
    color: '#FFF',
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: theme.ink,
    padding: 0,
    margin: 0,
  },
  searchClose: {
    width: 28,
    height: 28,
    marginLeft: 10,             // 跟 input 右沿留 10px 空隙，防误触
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: alpha(theme.inkSoft, 0.08),  // 微底色让 × 看起来是独立按钮
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
    gap: 6,
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line,
  },
  // chips 在 ScrollView 内横向排列 + padding 右留 + 不 wrap
  recentChips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 12,
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
  // 空 palette 引导块：稍大 padding + 圆角浅底，比普通 hint 更醒目
  emptyHintBox: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderRadius: 10,
    backgroundColor: alpha(theme.accent, 0.06),
    gap: 10,
  },
  emptyHintTitle: {
    fontSize: 12,
    color: theme.ink,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  emptyHintSub: {
    fontSize: 11,
    color: theme.inkSoft,
    letterSpacing: 0.3,
    lineHeight: 18,
  },
  // 醒目的初始化按钮：实心 accent + 白字，跟下方说明文字明确区分
  seedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  seedBtnDisabled: {
    opacity: 0.55,
  },
  // 主标题 + 括号副字同一 Text，确保单行排列；副字小一号 + 半透明白
  seedBtnTitle: {
    fontSize: 16,
    color: '#FFF',
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  seedBtnSub: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.78)',
    fontWeight: '500',
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
  // 操作菜单 / 编辑 modal：居中显示（跟从底弹的 sheet 区分）
  actionBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,24,0.32)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  actionSheet: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    width: '100%',
    maxWidth: 340,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 14,
  },
  actionSheetTitle: {
    fontSize: 12,
    color: theme.inkSoft,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line,
  },
  actionItem: {
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  actionItemDanger: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line,
  },
  actionItemCancel: {
    borderTopWidth: 6,
    borderTopColor: theme.bg,
    backgroundColor: theme.surface,
  },
  actionItemText: {
    fontSize: 15,
    color: theme.ink,
    fontWeight: '500',
    textAlign: 'center',
  },
  actionItemTextDanger: {
    color: '#D14848',
  },
  actionItemTextCancel: {
    fontSize: 15,
    color: theme.inkSoft,
    textAlign: 'center',
    fontWeight: '500',
  },
  // 修改 modal
  editSheet: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    width: '100%',
    maxWidth: 360,
    padding: 18,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 14,
  },
  editSheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.ink,
    marginBottom: 14,
  },
  colorSheetSub: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.inkSoft,
    marginBottom: 10,
  },
  colorCurrentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line,
  },
  colorCurrentLabel: {
    fontSize: 12,
    color: theme.inkSoft,
    fontWeight: '600',
  },
  editFieldLabel: {
    fontSize: 12,
    color: theme.inkSoft,
    marginBottom: 6,
    marginTop: 8,
  },
  editInput: {
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: theme.ink,
  },
  editColorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  editColorChip: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  editColorChipActive: {
    borderColor: theme.ink,
  },
  editColorChipUsed: {
    borderColor: '#D14848',
  },
  editActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 18,
  },
  editBtnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  editBtnGhostText: {
    fontSize: 14,
    color: theme.inkSoft,
    fontWeight: '500',
  },
  editBtnPrimary: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: theme.accent,
  },
  editBtnPrimaryText: {
    fontSize: 14,
    color: '#FFF',
    fontWeight: '600',
  },
  sheet: {
    backgroundColor: 'rgba(255,255,255,0.94)',
    marginHorizontal: 10,
    marginBottom: 14,
    borderRadius: 22,
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
    // 三段布局：固定头 + ScrollView 中部 + 固定删除按钮
    maxHeight: '82%',
    flexDirection: 'column',
  },
  sheetHead: {
    flexShrink: 0,
  },
  sheetScroll: {
    flexShrink: 1,
    marginTop: 4,
  },
  sheetScrollContent: {
    paddingBottom: 10,
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
  sheetProbe: {
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.08)',
  },
  sheetPowerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    gap: 10,
  },
  sheetPowerText: {
    fontSize: 13,
    color: theme.ink,
    fontWeight: '500',
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
  sheetProbeAppHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sheetProbeApp: {
    flex: 1,
    fontSize: 14,
    color: theme.ink,
    fontWeight: '500',
  },
  sheetProbeMeta: {
    fontSize: 11,
    color: theme.inkSoft,
    fontVariant: ['tabular-nums'],
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
