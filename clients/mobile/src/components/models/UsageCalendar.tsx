// ══════════════════════════════════════════════
// 用量日历（对齐 desktop UsageCalendar）：左右步进 + 点开选日期 / 周 / 月，格子带每日成本热力
// 桌面端按触发器定位的 Popover 换成居中 Modal，外部点击关闭换成点背景关闭
// ══════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { alpha, theme } from '../../theme'
import { aggregateCallLog } from '../../lib/models/model-audit'
import {
  CAL_WEEK_LABELS,
  anchorLabel,
  buildMonthGrid,
  calDayKey,
  formatCny,
  tone,
  viewWindow,
  type ViewMode,
} from './model-utils'

export default function UsageCalendar({ viewMode, anchorDate, onSelect }: {
  viewMode: ViewMode
  anchorDate: Date
  onSelect: (d: Date) => void
}) {
  const [open, setOpen] = useState(false)
  const [calMonth, setCalMonth] = useState(() => ({ y: anchorDate.getFullYear(), m: anchorDate.getMonth() }))
  const [dayCosts, setDayCosts] = useState<Map<string, number>>(new Map())

  // 打开时拉取当前展示月的每日成本（按月视图的 12 格要整年的数据）
  useEffect(() => {
    if (!open) return
    const from = new Date(calMonth.y, viewMode === 'month' ? 0 : calMonth.m, 1).toISOString()
    const to = new Date(viewMode === 'month' ? calMonth.y + 1 : calMonth.y, viewMode === 'month' ? 0 : calMonth.m + 1, 1).toISOString()
    aggregateCallLog({ timeFrom: from, timeTo: to, granularity: 'day' }).then((rows) => {
      const m = new Map<string, number>()
      for (const r of rows) m.set(r.bucket.slice(0, 10), r.cost_cny_total)
      setDayCosts(m)
    }).catch(() => {})
  }, [open, calMonth, viewMode])

  // anchorDate 变了同步月份
  useEffect(() => {
    setCalMonth({ y: anchorDate.getFullYear(), m: anchorDate.getMonth() })
  }, [anchorDate])

  const step = (delta: number) => {
    const d = new Date(anchorDate)
    if (viewMode === 'day') d.setDate(d.getDate() + delta)
    else if (viewMode === 'week') d.setDate(d.getDate() + delta * 7)
    else d.setMonth(d.getMonth() + delta)
    onSelect(d)
  }

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }, [])
  const cells = useMemo(() => buildMonthGrid(calMonth.y, calMonth.m), [calMonth])

  const isSelected = (d: Date): boolean => {
    if (viewMode === 'day') return calDayKey(d) === calDayKey(anchorDate)
    if (viewMode === 'week') {
      const { from, to } = viewWindow('week', anchorDate)
      return d >= new Date(from) && d < new Date(to)
    }
    return d.getFullYear() === anchorDate.getFullYear() && d.getMonth() === anchorDate.getMonth()
  }

  // 月成本热力色（有成本时淡红底）
  const costHeatColor = (cost: number): string => {
    if (cost <= 0) return 'transparent'
    const intensity = Math.min(1, cost / 2)
    return alpha(tone.danger, Number((intensity * 0.25).toFixed(2)))
  }

  return (
    <>
      <View style={styles.bar}>
        <Pressable style={styles.arrow} hitSlop={6} onPress={() => step(-1)}><Text style={styles.arrowText}>‹</Text></Pressable>
        <Pressable style={styles.trigger} onPress={() => setOpen((v) => !v)}>
          <Text style={styles.triggerText} numberOfLines={1}>{anchorLabel(viewMode, anchorDate)}</Text>
          <Text style={styles.chevron}>▾</Text>
        </Pressable>
        <Pressable style={styles.arrow} hitSlop={6} onPress={() => step(1)}><Text style={styles.arrowText}>›</Text></Pressable>
      </View>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.pop} onPress={() => {}}>
            {/* 月份导航 */}
            <View style={styles.navRow}>
              <Pressable style={styles.nav} onPress={() => setCalMonth(({ y, m }) => m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 })}>
                <Text style={styles.arrowText}>‹</Text>
              </Pressable>
              <Text style={styles.navTitle}>{calMonth.y} · {String(calMonth.m + 1).padStart(2, '0')}</Text>
              <Pressable style={styles.nav} onPress={() => setCalMonth(({ y, m }) => m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 })}>
                <Text style={styles.arrowText}>›</Text>
              </Pressable>
            </View>

            {viewMode === 'month' ? (
              <View style={styles.monthGrid}>
                {Array.from({ length: 12 }, (_, mi) => {
                  const sel = anchorDate.getFullYear() === calMonth.y && anchorDate.getMonth() === mi
                  const monthCost = Array.from(dayCosts.entries())
                    .filter(([k]) => k.startsWith(`${calMonth.y}-${String(mi + 1).padStart(2, '0')}`))
                    .reduce((s, [, v]) => s + v, 0)
                  return (
                    <Pressable
                      key={mi}
                      style={[styles.monthCell, sel && styles.cellOn]}
                      onPress={() => { onSelect(new Date(calMonth.y, mi, 1)); setOpen(false) }}
                    >
                      <Text style={[styles.cellText, sel && styles.cellTextOn]}>{mi + 1} 月</Text>
                      {monthCost > 0 && <Text style={[styles.cellCost, sel && styles.cellTextOn]} numberOfLines={1}>{formatCny(monthCost)}</Text>}
                    </Pressable>
                  )
                })}
              </View>
            ) : (
              <>
                <View style={styles.weekRow}>
                  {CAL_WEEK_LABELS.map((w, i) => (
                    <Text key={w} style={[styles.weekLabel, i >= 5 && styles.weekend]}>{w}</Text>
                  ))}
                </View>
                <View style={styles.dayGrid}>
                  {cells.map((d, i) => {
                    const isCurMonth = d.getMonth() === calMonth.m
                    const isToday = d.getTime() === today.getTime()
                    const sel = isSelected(d)
                    const cost = dayCosts.get(calDayKey(d)) ?? 0
                    return (
                      <Pressable
                        key={i}
                        style={[styles.dayCell, { backgroundColor: sel ? theme.accent : costHeatColor(cost) }]}
                        onPress={() => { onSelect(new Date(d)); setOpen(false) }}
                      >
                        <Text style={[
                          styles.cellText,
                          !isCurMonth && styles.cellTextMuted,
                          isToday && styles.cellTextToday,
                          sel && styles.cellTextOn,
                        ]}>{d.getDate()}</Text>
                        {cost > 0 && isCurMonth && (
                          <Text style={[styles.cellCost, sel && styles.cellTextOn]} numberOfLines={1} adjustsFontSizeToFit>{formatCny(cost)}</Text>
                        )}
                      </Pressable>
                    )
                  })}
                </View>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  arrow: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.sunk },
  arrowText: { fontSize: 18, lineHeight: 20, color: theme.ink },
  trigger: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 32, minWidth: 124, paddingHorizontal: 10, borderRadius: 8, backgroundColor: theme.sunk,
  },
  triggerText: { fontSize: 13, fontWeight: '600', color: theme.ink, fontVariant: ['tabular-nums'] },
  chevron: { fontSize: 11, color: theme.inkSoft },

  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  pop: { width: '100%', maxWidth: 360, backgroundColor: theme.surface, borderRadius: 16, padding: 14 },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  nav: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.sunk },
  navTitle: { fontSize: 15, fontWeight: '700', color: theme.ink, fontVariant: ['tabular-nums'] },

  monthGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  monthCell: { width: '33.33%', height: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },

  weekRow: { flexDirection: 'row', paddingBottom: 6, marginBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  weekLabel: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '600', color: theme.inkSoft },
  weekend: { color: theme.accent },
  dayGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: `${100 / 7}%`, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 6, paddingHorizontal: 1 },

  cellOn: { backgroundColor: theme.accent },
  cellText: { fontSize: 13, fontWeight: '500', color: theme.ink, fontVariant: ['tabular-nums'] },
  cellTextMuted: { color: theme.inkFaint },
  cellTextToday: { color: theme.accent, fontWeight: '700' },
  cellTextOn: { color: '#FFFFFF', fontWeight: '700' },
  cellCost: { fontSize: 9, fontWeight: '600', color: tone.danger, fontVariant: ['tabular-nums'] },
})
