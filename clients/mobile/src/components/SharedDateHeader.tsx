import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { addDays, fmtDateLabel, isSameDay } from '../lib/time'
import { alpha, theme } from '../theme'

type SharedDateHeaderProps = {
  selectedDate: Date
  onChangeDate: (date: Date) => void
  onOpenCalendar?: () => void
  right?: ReactNode
}

export default function SharedDateHeader({
  selectedDate,
  onChangeDate,
  onOpenCalendar,
  right,
}: SharedDateHeaderProps) {
  const isToday = isSameDay(new Date(), selectedDate)
  return (
    <View style={styles.row}>
      <Pressable
        hitSlop={10}
        onPress={() => onChangeDate(addDays(selectedDate, -1))}
        style={styles.arrow}
      >
        <Text style={styles.arrowText}>‹</Text>
      </Pressable>
      <View style={styles.center}>
        <Pressable
          onPress={onOpenCalendar}
          disabled={!onOpenCalendar}
          hitSlop={6}
        >
          <Text style={styles.dateText}>{fmtDateLabel(selectedDate)}</Text>
        </Pressable>
        {!isToday && (
          <Pressable
            onPress={() => onChangeDate(new Date())}
            style={styles.todayChip}
            hitSlop={4}
          >
            <Text style={styles.todayChipText}>回到今天</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.rightSlot}>
        {right}
        <Pressable
          hitSlop={10}
          onPress={() => onChangeDate(addDays(selectedDate, 1))}
          style={styles.arrow}
        >
          <Text style={styles.arrowText}>›</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
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
  center: {
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
  todayChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: alpha(theme.accent, 0.12),
  },
  todayChipText: {
    fontSize: 11,
    color: theme.accent,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  rightSlot: {
    minWidth: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    justifyContent: 'center',
  },
})
