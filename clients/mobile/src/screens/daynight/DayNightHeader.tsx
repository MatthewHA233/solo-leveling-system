import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import { fmtDateLabel } from '../../lib/time'
import type { DayNightSummary } from './types'

function fmtHM(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h > 0 && m > 0) return `${h} 小时 ${m} 分`
  if (h > 0) return `${h} 小时`
  return `${m} 分`
}

export function DayNightHeader({
  selectedDate,
  isToday,
  summary,
  compact = false,
  transitionProgress,
  onPrevDate,
  onNextDate,
  onOpenCalendar,
  onBackToday,
  onOpenStats,
}: {
  selectedDate: Date
  isToday: boolean
  summary: DayNightSummary
  compact?: boolean
  transitionProgress?: Animated.Value
  onPrevDate: () => void
  onNextDate: () => void
  onOpenCalendar: () => void
  onBackToday: () => void
  onOpenStats: () => void
}) {
  return (
    <>
      <View style={styles.dateRow}>
        <Pressable hitSlop={10} onPress={onPrevDate} style={styles.arrow}>
          <Text style={styles.arrowText}>‹</Text>
        </Pressable>
        <View style={styles.dateCenter}>
          <Pressable onPress={onOpenCalendar} hitSlop={6}>
            <Text style={styles.dateText}>{fmtDateLabel(selectedDate)}</Text>
          </Pressable>
          {!isToday && (
            <Pressable onPress={onBackToday} style={styles.backTodayChip} hitSlop={4}>
              <Text style={styles.backTodayChipText}>回到今天</Text>
            </Pressable>
          )}
        </View>
        <Pressable hitSlop={10} onPress={onNextDate} style={styles.arrow}>
          <Text style={styles.arrowText}>›</Text>
        </Pressable>
      </View>
      {(!compact || transitionProgress) && (
        <Animated.View
          style={[
            styles.summary,
            transitionProgress && {
              opacity: transitionProgress.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 0],
              }),
              maxHeight: transitionProgress.interpolate({
                inputRange: [0, 1],
                outputRange: [96, 0],
              }),
              marginBottom: transitionProgress.interpolate({
                inputRange: [0, 1],
                outputRange: [0, -8],
              }),
              overflow: 'hidden',
            },
          ]}
          pointerEvents={compact ? 'none' : 'auto'}
        >
          <Pressable onPress={() => summary.rows.length > 0 && onOpenStats()}>
            <Text style={styles.summaryText}>
              已记录 <Text style={styles.summaryStrong}>{fmtHM(summary.total)}</Text>
              {summary.rows.length > 0 ? ` · ${summary.rows.length} 类` : ''}
            </Text>
            <View style={styles.sumBar}>
              {summary.rows.map((r) => {
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
        </Animated.View>
      )}
    </>
  )
}

const styles = StyleSheet.create({
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
  backTodayChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(62,99,221,0.12)',
  },
  backTodayChipText: {
    fontSize: 11,
    color: theme.accent,
    fontWeight: '600',
    letterSpacing: 0.3,
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
})
