// ══════════════════════════════════════════════
// 思考过程（思考模型的推理流，对应 desktop ChatPanel ReasoningBlock）
// 流式期间自动展开、只露最后几行（看着像在往下滚）；正文开始后自动折叠成一行，可手动展开回看
// 手机端不用可滚动的小框：聊天列表里套竖向滚动框，手指滑的是小框，整个列表就滚不动了。
// 展开回看时直接铺开，长的先显示前一段、点「展开全部」看完
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import { charLabel } from './fairy-format'

/** 流式时只渲染末尾这么多字（框只露最后几行，前面的渲染了也看不到） */
const TAIL_CHARS = 500
/** 展开回看时先显示这么多字 */
const PREVIEW_CHARS = 1500

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
  const [full, setFull] = useState(false)
  const long = text.length > PREVIEW_CHARS

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
      {expanded && !answered && (
        <View style={[styles.well, styles.tail]}>
          <Text style={styles.text}>{text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text}</Text>
        </View>
      )}
      {expanded && answered && (
        <View style={styles.well}>
          <Text style={styles.text}>{long && !full ? `${text.slice(0, PREVIEW_CHARS)}…` : text}</Text>
          {long && (
            <Pressable hitSlop={8} accessibilityRole="button" onPress={() => setFull(!full)}>
              <Text style={styles.more}>{full ? '收起' : `展开全部 · ${charLabel(text.length)} 字`}</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  toggleText: { fontSize: 12, color: theme.inkFaint },
  well: { marginTop: 6, backgroundColor: theme.sunk, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
  // 内容比框高时顶部被裁掉，露出的是最后几行
  tail: { maxHeight: 112, overflow: 'hidden', justifyContent: 'flex-end' },
  more: { fontSize: 11.5, color: theme.accent },
  text: { fontSize: 12, lineHeight: 20, color: theme.inkSoft },
})
