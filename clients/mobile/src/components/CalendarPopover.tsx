// ══════════════════════════════════════════════
// 日期选择面板 —— 月历，每个 cell 背景画环显示当日记录时段
// 抄 desktop DatePickerPopover 的 DayRing 逻辑：正午在顶部、午夜在底部，
// 顺时针推进；每个 tag 时段 = 一段弧。
// ══════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, G } from 'react-native-svg'
import { fetchBlocks } from '../lib/api'
import { isSameDay, toLocalDateStr } from '../lib/time'
import { alpha, theme } from '../theme'
import type { ActivityBlock, ActivityCategory, ActivityTag } from '../types'

interface Props {
  open: boolean
  selectedDate: Date
  /** tag/category 用于 ring 取色（按 tag 所属 category 的颜色画弧） */
  tagById: ReadonlyMap<number, ActivityTag>
  categoryById: ReadonlyMap<number, ActivityCategory>
  /** 外部直接传入的日历环。洪流域用它展示动作区间，不读取昼夜表 blocks。 */
  externalRangesByDay?: Record<string, DayRangeColored[]>
  loadActivityRanges?: boolean
  onSelect: (date: Date) => void
  onClose: () => void
}

export interface DayRangeColored {
  /** 起始分钟 [0,1440) */
  startMin: number
  /** 结束分钟 (0,1440] */
  endMin: number
  color: string
}

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

// 返回 6 周 = 42 天，从 monthStart 所在周的周日开始
function buildMonthGrid(viewMonth: Date): Date[] {
  const first = startOfMonth(viewMonth)
  const startWeekday = first.getDay() // 0..6, 0=Sunday
  const grid: Date[] = []
  for (let i = 0; i < 42; i++) {
    grid.push(new Date(first.getFullYear(), first.getMonth(), 1 + i - startWeekday))
  }
  return grid
}

function mergeRanges(
  blocks: readonly ActivityBlock[],
  tagById: ReadonlyMap<number, ActivityTag>,
  categoryById: ReadonlyMap<number, ActivityCategory>,
): DayRangeColored[] {
  // 同 desktop spans：相邻同 tag 5min block 合并；着色按 category
  const sorted = [...blocks].sort((a, b) => a.minute - b.minute)
  const out: DayRangeColored[] = []
  for (const b of sorted) {
    const tag = tagById.get(b.tagId)
    const cat = tag ? categoryById.get(tag.categoryId) : undefined
    const color = cat?.color ?? theme.inkSoft
    const last = out[out.length - 1]
    if (last && last.color === color && b.minute === last.endMin) {
      last.endMin = b.minute + 5
    } else {
      out.push({ startMin: b.minute, endMin: b.minute + 5, color })
    }
  }
  return out
}

const RING_SIZE = 36
const RING_STROKE = 2
const RING_R = (RING_SIZE - RING_STROKE) / 2
const RING_C = 2 * Math.PI * RING_R

/** 单日 cell 背景环。复刻 desktop DayRing：24h 钟表，0:00（午夜）在正北顶部，
 *  12:00（正午）在底部，顺时针推进 → 06:00 在右、18:00 在左。
 *  SVG 默认起点在 3 点钟；用内层 <G rotate -90> 让起点跑到 12 点钟。
 *  （RN 端不能用 View transform —— 那只旋转 View 不旋转 SVG 内部坐标系） */
function DayRing({ ranges }: { ranges: readonly DayRangeColored[] }) {
  const minToOffset = (m: number) => (m / 1440) * RING_C
  const center = RING_SIZE / 2
  return (
    <View pointerEvents="none" style={ringStyles.wrap}>
      <Svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      >
        <G transform={`rotate(-90, ${center}, ${center})`}>
          {/* 底环淡灰 */}
          <Circle
            cx={center}
            cy={center}
            r={RING_R}
            fill="none"
            stroke={alpha(theme.ink, 0.08)}
            strokeWidth={RING_STROKE * 0.6}
          />
          {ranges.map((r, i) => {
            const arcLen = (r.endMin - r.startMin) / 1440 * RING_C
            const off = minToOffset(r.startMin)
            return (
              <Circle
                key={i}
                cx={center}
                cy={center}
                r={RING_R}
                fill="none"
                stroke={r.color}
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={`${arcLen} ${RING_C}`}
                strokeDashoffset={-off}
              />
            )
          })}
        </G>
      </Svg>
    </View>
  )
}

const ringStyles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    marginLeft: -RING_SIZE / 2,
    marginTop: -RING_SIZE / 2,
  },
})

export default function CalendarPopover({
  open,
  selectedDate,
  tagById,
  categoryById,
  externalRangesByDay,
  loadActivityRanges = true,
  onSelect,
  onClose,
}: Props) {
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(selectedDate))
  // 月份 → date_key → blocks 缓存
  const [rangesByDay, setRangesByDay] = useState<Record<string, DayRangeColored[]>>({})

  // 打开 / 切月 → 拉这 42 天的 blocks，按天聚合 ranges
  // 不复用缓存：用户在 picker 外刚改了 blocks（拖拽 / 同步 / 删标签），
  // 再打开月历必须看到最新；reopen 时间开销几十 ms 可接受
  useEffect(() => {
    if (!open) return
    if (!loadActivityRanges) {
      setRangesByDay({})
      return
    }
    const grid = buildMonthGrid(viewMonth)
    let alive = true
    Promise.all(
      grid.map(async (d) => {
        const key = toLocalDateStr(d)
        try {
          const blocks = await fetchBlocks(d)
          return { key, ranges: mergeRanges(blocks, tagById, categoryById) }
        } catch {
          return { key, ranges: [] as DayRangeColored[] }
        }
      }),
    ).then((rows) => {
      if (!alive) return
      const next: Record<string, DayRangeColored[]> = {}
      for (const r of rows) next[r.key] = r.ranges
      setRangesByDay(next)
    })
    return () => { alive = false }
  }, [open, viewMonth, tagById, categoryById, loadActivityRanges])

  // 打开时把视图月对齐到当前 selectedDate 的月份（不重置已切的视图）
  useEffect(() => {
    if (open) setViewMonth(startOfMonth(selectedDate))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const grid = useMemo(() => buildMonthGrid(viewMonth), [viewMonth])
  const today = new Date()
  const monthLabel = `${viewMonth.getFullYear()} · ${String(viewMonth.getMonth() + 1).padStart(2, '0')}`

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          {/* 月份导航 */}
          <View style={styles.headRow}>
            <Pressable
              onPress={() => setViewMonth((m) => addMonths(m, -1))}
              hitSlop={8}
              style={styles.headBtn}
            >
              <Text style={styles.headBtnText}>‹</Text>
            </Pressable>
            <Text style={styles.headTitle}>{monthLabel}</Text>
            <Pressable
              onPress={() => setViewMonth((m) => addMonths(m, 1))}
              hitSlop={8}
              style={styles.headBtn}
            >
              <Text style={styles.headBtnText}>›</Text>
            </Pressable>
          </View>

          {/* 星期表头 */}
          <View style={styles.weekRow}>
            {WEEK_LABELS.map((w) => (
              <Text key={w} style={styles.weekLabel}>{w}</Text>
            ))}
          </View>

          {/* 日期网格 6×7 */}
          <View style={styles.grid}>
            {grid.map((d) => {
              const inMonth = d.getMonth() === viewMonth.getMonth()
              const isSelected = isSameDay(d, selectedDate)
              const isCurToday = isSameDay(d, today)
              const key = toLocalDateStr(d)
              const ranges = externalRangesByDay?.[key] ?? rangesByDay[key] ?? []
              return (
                <Pressable
                  key={d.toISOString()}
                  onPress={() => { onSelect(d); onClose() }}
                  style={styles.cell}
                >
                  <DayRing ranges={ranges} />
                  <View
                    style={[
                      styles.cellDot,
                      isSelected && styles.cellDotSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.cellNum,
                        !inMonth && styles.cellNumDim,
                        isSelected && styles.cellNumSelected,
                        isCurToday && !isSelected && styles.cellNumToday,
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                  </View>
                </Pressable>
              )
            })}
          </View>

          {/* 底部：回今天 + 关闭 */}
          <View style={styles.footRow}>
            <Pressable
              onPress={() => { onSelect(today); onClose() }}
              style={styles.footBtn}
            >
              <Text style={styles.footBtnText}>回到今天</Text>
            </Pressable>
            <Pressable onPress={onClose} style={[styles.footBtn, styles.footBtnGhost]}>
              <Text style={[styles.footBtnText, styles.footBtnGhostText]}>关闭</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const CELL_SIZE = 44

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,24,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#FFF',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 14,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  headBtnText: {
    fontSize: 22,
    color: theme.inkSoft,
    lineHeight: 22,
  },
  headTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.ink,
    letterSpacing: 0.6,
    fontVariant: ['tabular-nums'],
  },
  weekRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  weekLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    color: theme.inkSoft,
    paddingVertical: 4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  cell: {
    width: `${100 / 7}%`,
    height: CELL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 中央数字小圆，加 padding 让数字看起来跟环间距合理
  cellDot: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    zIndex: 1,
  },
  cellDotSelected: {
    backgroundColor: theme.accent,
  },
  cellNum: {
    fontSize: 12,
    color: theme.ink,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  cellNumDim: {
    color: theme.inkFaint,
    fontWeight: '400',
  },
  cellNumSelected: {
    color: '#FFF',
  },
  cellNumToday: {
    color: theme.accent,
  },
  footRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line,
  },
  footBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: theme.accent,
  },
  footBtnGhost: {
    backgroundColor: 'transparent',
  },
  footBtnText: {
    fontSize: 12.5,
    color: '#FFF',
    fontWeight: '700',
  },
  footBtnGhostText: {
    color: theme.inkSoft,
  },
})
