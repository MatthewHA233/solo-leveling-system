// ══════════════════════════════════════════════
// 模型中心的小零件（对齐 desktop ModelDialog 里的 Segmented / Metric / MetricBreakdown / MiniMetric / Empty / StatusBadge）
// 视觉走手机端浅色主题，不搬桌面端钛合金
// ══════════════════════════════════════════════

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { fonts, theme } from '../../theme'
import { formatCny, formatTokens, tone } from './model-utils'

export function Segmented({ value, options, onChange, scroll }: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  /** 选项多、一行放不下时横向滚动，不压缩字 */
  scroll?: boolean
}) {
  const body = (
    <View style={styles.seg}>
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(opt.value)}
            style={[styles.segBtn, active && styles.segBtnOn]}
          >
            <Text style={[styles.segText, active && styles.segTextOn]} numberOfLines={1}>{opt.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
  if (!scroll) return body
  return <ScrollView horizontal showsHorizontalScrollIndicator={false}>{body}</ScrollView>
}

export function TabButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable style={[styles.tab, active && styles.tabOn]} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextOn]}>{label}</Text>
    </Pressable>
  )
}

export function StatusBadge({ color, label }: { color: string; label: string }) {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  )
}

export function Metric({ label, value, accent, note, secondary }: { label: string; value: string; accent?: string; note?: string; secondary?: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, accent ? { color: accent } : null]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {secondary && <Text style={[styles.metricSecondary, accent ? { color: accent } : null]} numberOfLines={1}>{secondary}</Text>}
      {note && <Text style={styles.metricNote}>{note}</Text>}
    </View>
  )
}

export function MetricBreakdown({ label, total, accent, parts }: {
  label: string
  total: number
  accent?: string
  parts: { label: string; value: number; cost?: number }[]
}) {
  const visible = parts.filter((p) => p.value > 0)
  const totalCost = parts.reduce((s, p) => s + (p.cost ?? 0), 0)
  const hasCost = parts.some((p) => p.cost != null)
  return (
    <View style={styles.card}>
      <Text style={styles.metricLabel}>{label}</Text>
      <View style={styles.metricRow}>
        <Text style={[styles.metricValue, accent ? { color: accent } : null]} numberOfLines={1}>{formatTokens(total)}</Text>
        {hasCost && totalCost > 0 && <Text style={styles.metricCost}>{formatCny(totalCost)}</Text>}
      </View>
      {visible.length > 0 && (
        <View style={styles.breakdown}>
          {visible.map((p) => (
            <View key={p.label} style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>{p.label}</Text>
              <Text style={styles.breakdownValue}>{formatTokens(p.value)}</Text>
              {p.cost != null && (
                <Text style={[styles.breakdownCost, p.cost > 0 ? styles.costOn : styles.costOff]}>
                  {p.cost > 0 ? formatCny(p.cost) : '不计费'}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

export function MiniMetric({ label, value, sub, accent, money = formatCny }: {
  label: string
  value: string
  sub?: { label: string; value: number; cost?: number }[]
  accent?: string
  money?: (n: number) => string
}) {
  const visible = (sub ?? []).filter((p) => p.value > 0 || (p.cost ?? 0) > 0)
  const totalCost = sub?.reduce((s, p) => s + (p.cost ?? 0), 0) ?? 0
  const hasCost = sub?.some((p) => p.cost != null) ?? false
  return (
    <View style={styles.mini}>
      <View style={styles.metricRow}>
        <Text style={styles.metricLabel}>{label}</Text>
        {hasCost && totalCost > 0 && <Text style={styles.miniCost}>{money(totalCost)}</Text>}
      </View>
      <Text style={[styles.miniValue, accent ? { color: accent } : null]}>{value}</Text>
      {visible.length > 0 && (
        <View style={styles.miniList}>
          {visible.map((p) => (
            <View key={p.label} style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>{p.label}</Text>
              <Text style={styles.breakdownValue}>{formatTokens(p.value)}</Text>
              {p.cost != null && (
                <Text style={[styles.breakdownCost, p.cost > 0 ? styles.costOn : styles.costOff]}>
                  {p.cost > 0 ? money(p.cost) : '不计费'}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

export function Empty({ text, tall }: { text: string; tall?: boolean }) {
  return (
    <View style={[styles.empty, tall && styles.emptyTall]}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  seg: { flexDirection: 'row', backgroundColor: theme.sunk, borderRadius: 9, padding: 2, alignSelf: 'flex-start' },
  segBtn: { height: 32, paddingHorizontal: 12, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  segBtnOn: { backgroundColor: theme.surface },
  segText: { fontSize: 13, color: theme.inkSoft, fontWeight: '500' },
  segTextOn: { color: theme.ink, fontWeight: '700' },

  tab: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: theme.accent },
  tabText: { fontSize: 14, color: theme.inkSoft, fontWeight: '500' },
  tabTextOn: { color: theme.ink, fontWeight: '700' },

  badge: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { fontSize: 10, fontWeight: '700' },

  card: { flex: 1, minWidth: 0, backgroundColor: theme.surface, borderRadius: 12, padding: 12 },
  metricLabel: { fontSize: 12, color: theme.inkSoft, fontWeight: '500' },
  metricRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 },
  metricValue: { fontSize: 22, fontWeight: '700', color: theme.ink, marginTop: 4, fontVariant: ['tabular-nums'] },
  metricSecondary: { fontSize: 15, fontWeight: '700', color: theme.ink, marginTop: 2, fontVariant: ['tabular-nums'] },
  metricNote: { fontSize: 11, color: tone.green, marginTop: 6 },
  metricCost: { fontSize: 12, color: tone.danger, fontWeight: '700', fontVariant: ['tabular-nums'] },

  breakdown: { gap: 3, marginTop: 8, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
  breakdownRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  breakdownLabel: { fontSize: 11, color: theme.inkSoft },
  breakdownValue: { flex: 1, fontSize: 11, color: theme.ink, textAlign: 'right', fontVariant: ['tabular-nums'] },
  breakdownCost: { fontSize: 10, minWidth: 44, textAlign: 'right', fontVariant: ['tabular-nums'] },
  costOn: { color: tone.danger },
  costOff: { color: theme.inkFaint },

  mini: { flex: 1, minWidth: 0, backgroundColor: theme.bg, borderRadius: 8, padding: 8 },
  miniCost: { fontSize: 11, fontWeight: '700', color: tone.danger, fontVariant: ['tabular-nums'] },
  miniValue: { fontSize: 14, fontWeight: '700', color: theme.ink, marginTop: 1, fontFamily: fonts.mono },
  miniList: { gap: 2, marginTop: 4 },

  empty: { height: 120, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: theme.sunk },
  emptyTall: { height: 240 },
  emptyText: { fontSize: 13, color: theme.inkSoft },
})
