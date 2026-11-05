// ══════════════════════════════════════════════
// 下拉选择（desktop HudSelect 的手机版）：点开底部弹层选一项
// 选项可带 hint（免费额度文案）和 meter（免费额度剩余百分比）
// ══════════════════════════════════════════════

import { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { alpha, theme } from '../../theme'
import { tone } from './model-utils'

export interface SelectOption {
  value: string
  label: string
  hint?: string
  meter?: number
}

export default function SelectField({ value, options, onChange, disabled, title }: {
  value: string
  options: readonly SelectOption[]
  onChange: (v: string) => void
  disabled?: boolean
  /** 弹层标题；不传就只显示列表 */
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)

  return (
    <>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[styles.field, disabled && styles.fieldOff]}
      >
        <View style={styles.fieldBody}>
          <Text style={styles.fieldText} numberOfLines={1}>{current?.label ?? value}</Text>
          {current?.hint && <Text style={styles.fieldHint} numberOfLines={1}>{current.hint}</Text>}
        </View>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.handle} />
            {title && <Text style={styles.title}>{title}</Text>}
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {options.map((o) => {
                const active = o.value === value
                return (
                  <Pressable
                    key={o.value}
                    style={[styles.row, active && styles.rowOn]}
                    onPress={() => { setOpen(false); onChange(o.value) }}
                  >
                    <View style={styles.rowBody}>
                      <Text style={[styles.rowLabel, active && styles.rowLabelOn]} numberOfLines={2}>{o.label}</Text>
                      {o.hint && <Text style={styles.rowHint}>{o.hint}</Text>}
                      {o.meter != null && (
                        <View style={styles.meter}>
                          <View style={[styles.meterFill, { width: `${o.meter}%` }]} />
                        </View>
                      )}
                    </View>
                    {active && <Text style={styles.check}>✓</Text>}
                  </Pressable>
                )
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: theme.sunk,
  },
  fieldOff: { opacity: 0.5 },
  fieldBody: { flex: 1, minWidth: 0 },
  fieldText: { fontSize: 14, color: theme.ink, fontWeight: '500' },
  fieldHint: { fontSize: 11, color: tone.green, marginTop: 1 },
  chevron: { fontSize: 12, color: theme.inkSoft },

  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingBottom: 24, maxHeight: '75%',
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.line, marginTop: 10, marginBottom: 12 },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink, marginBottom: 8 },
  list: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 10, marginBottom: 2 },
  rowOn: { backgroundColor: alpha(theme.accent, 0.07) },
  rowBody: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 14, color: theme.ink, fontWeight: '500' },
  rowLabelOn: { color: theme.accent, fontWeight: '700' },
  rowHint: { fontSize: 11, color: theme.inkSoft, marginTop: 2 },
  meter: { height: 3, backgroundColor: theme.sunk, borderRadius: 2, marginTop: 5, overflow: 'hidden' },
  meterFill: { height: 3, backgroundColor: tone.green, borderRadius: 2 },
  check: { fontSize: 14, color: theme.accent, fontWeight: '700' },
})
