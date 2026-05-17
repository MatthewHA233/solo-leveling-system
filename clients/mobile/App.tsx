/**
 * Solo Leveling System — 手机端
 * 昼夜表 + 暗影多模态聊天
 */

import { useState } from 'react'
import { StatusBar, StyleSheet, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import TabBar from './src/components/TabBar'
import type { TabKey } from './src/components/TabBar'
import DayNightScreen from './src/screens/DayNightScreen'
import ChatScreen from './src/screens/ChatScreen'
import { theme } from './src/theme'

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={theme.bg} />
      <AppContent />
    </SafeAreaProvider>
  )
}

function AppContent() {
  const insets = useSafeAreaInsets()
  const [tab, setTab] = useState<TabKey>('daynight')

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.body}>
        {tab === 'daynight' ? <DayNightScreen /> : <ChatScreen />}
      </View>
      <View style={{ paddingBottom: insets.bottom, backgroundColor: theme.surface }}>
        <TabBar active={tab} onChange={setTab} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  body: {
    flex: 1,
    backgroundColor: theme.bg,
  },
})

export default App
