// ══════════════════════════════════════════════
// 底部 Tab 栏 — 极简
// ══════════════════════════════════════════════

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../theme'

export type TabKey = 'daynight' | 'chat'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'daynight', label: '昼夜表' },
  { key: 'chat', label: '暗影聊天' },
]

export default function TabBar({
  active,
  onChange,
}: {
  active: TabKey
  onChange: (key: TabKey) => void
}) {
  return (
    <View style={styles.bar}>
      {TABS.map((tab) => {
        const on = tab.key === active
        return (
          <Pressable key={tab.key} style={styles.tab} onPress={() => onChange(tab.key)}>
            <View
              style={[
                styles.mark,
                { backgroundColor: on ? theme.accent : 'transparent' },
              ]}
            />
            <Text
              style={[
                styles.label,
                { color: on ? theme.accent : theme.inkFaint, fontWeight: on ? '600' : '500' },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderTopColor: theme.line,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 9,
    paddingBottom: 11,
  },
  mark: {
    width: 22,
    height: 3,
    borderRadius: 2,
    marginBottom: 7,
  },
  label: {
    fontSize: 13,
  },
})
