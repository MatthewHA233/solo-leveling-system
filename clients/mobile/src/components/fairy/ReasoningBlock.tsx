// ══════════════════════════════════════════════
// 思考过程（思考模型的推理流，对应 desktop ChatPanel ReasoningBlock）
// 流式期间自动展开、贴底滚动；正文开始后自动折叠成一行，可手动展开回看
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import { charLabel } from './fairy-format'

function ThinkingDots() {
  const pulse = useRef(new Animated.Value(0.35)).current
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 500, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [pulse])
  return <Animated.Text style={[styles.toggleText, { opacity: pulse }]}>…</Animated.Text>
}

export default function ReasoningBlock({ text, answered }: {
  text: string
  /** 正文已经开始（或这轮已经结束）：折叠成一行 */
  answered: boolean
}) {
  const [userToggle, setUserToggle] = useState<boolean | null>(null)
  const expanded = userToggle ?? !answered
  const scrollRef = useRef<ScrollView>(null)

  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.toggle}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setUserToggle(!expanded)}
      >
        {answered ? (
          <Text style={styles.toggleText}>思考过程 · {charLabel(text.length)} 字 {expanded ? '▾' : '▸'}</Text>
        ) : (
          <>
            <Text style={styles.toggleText}>正在思考</Text>
            <ThinkingDots />
          </>
        )}
      </Pressable>
      {expanded && (
        <ScrollView
          ref={scrollRef}
          style={styles.well}
          contentContainerStyle={styles.wellContent}
          nestedScrollEnabled
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          <Text style={styles.text}>{text}</Text>
        </ScrollView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  toggleText: { fontSize: 12, color: theme.inkFaint },
  well: { marginTop: 6, maxHeight: 170, backgroundColor: theme.sunk, borderRadius: 8 },
  wellContent: { paddingHorizontal: 12, paddingVertical: 8 },
  text: { fontSize: 12, lineHeight: 20, color: theme.inkSoft },
})
