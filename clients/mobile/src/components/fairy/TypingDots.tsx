// ══════════════════════════════════════════════
// 正在回复：三颗逐个亮起的点（对应 desktop ChatPanel TypingLeds，动画沿用 ChatScreen 的 TypingDots）
// ══════════════════════════════════════════════

import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import { theme } from '../../theme'

export default function TypingDots() {
  const d0 = useRef(new Animated.Value(0)).current
  const d1 = useRef(new Animated.Value(0)).current
  const d2 = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const dots = [d0, d1, d2]
    const loops = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 180),
          Animated.timing(d, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(d, { toValue: 0, duration: 300, useNativeDriver: true }),
          Animated.delay(360 - i * 180),
        ]),
      ),
    )
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
  }, [d0, d1, d2])

  return (
    <View style={styles.row} accessibilityLabel="正在回复">
      {[d0, d1, d2].map((d, i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            { opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
          ]}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 2 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.inkSoft },
})
