// ══════════════════════════════════════════════
// FairyStateIndicator — 状态指示动画（desktop FairyHUD 同款）
//   listening: 9 条声波柱起伏（scaleY .25→1, 0.9s, 梯次 0.08s）
//   thinking : 7 个圆点呼吸（scale .45→1.15 + opacity, 1.2s, 梯次 0.12s）
//   speaking : 流动波形（dash 流动, 1.1s linear）
// 动画参数逐项对齐 desktop FairyHUD.tsx 的 CSS keyframes。
// ══════════════════════════════════════════════

import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'

export type FairyIndicatorState = 'listening' | 'thinking' | 'speaking'

interface Props {
  readonly state: FairyIndicatorState
  /** 主色（深色浮层用 desktop 同款青蓝，浅色表面用主题 accent） */
  readonly color?: string
  /** 等比缩放：desktop 原始尺寸(96×14, bar 3px, dot 5px, stroke 1.4) × scale */
  readonly scale?: number
}

const FAIRY_CYAN = 'rgba(80, 200, 255, 0.95)'

// ── listening: 声波柱 ──

function Bars({ color, height, scale }: { color: string; height: number; scale: number }) {
  const anims = useRef(Array.from({ length: 9 }, () => new Animated.Value(0.25))).current

  useEffect(() => {
    // 对齐 desktop si-bar-pulse：0.9s ease-in-out infinite，delay 0.08s 递增
    const loops = anims.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 80),
          Animated.timing(v, { toValue: 1, duration: 450, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.25, duration: 450, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]),
      ),
    )
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
  }, [anims])

  return (
    <View style={[styles.row, { height }]}>
      {anims.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              height,
              width: 3 * scale,
              borderRadius: 2 * scale,
              backgroundColor: color,
              transform: [{ scaleY: v }],
              opacity: v.interpolate({ inputRange: [0.25, 1], outputRange: [0.65, 1] }),
            },
          ]}
        />
      ))}
    </View>
  )
}

// ── thinking: 呼吸点 ──

function Dots({ color, height, scale }: { color: string; height: number; scale: number }) {
  const anims = useRef(Array.from({ length: 7 }, () => new Animated.Value(0))).current

  useEffect(() => {
    // 对齐 desktop si-dot-blink：1.2s，40% 处峰值，delay 0.12s 递增
    const loops = anims.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 120),
          Animated.timing(v, { toValue: 1, duration: 480, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 480, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.delay(240),
        ]),
      ),
    )
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
  }, [anims])

  return (
    <View style={[styles.row, { height }]}>
      {anims.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            {
              width: 5 * scale,
              height: 5 * scale,
              borderRadius: 2.5 * scale,
              backgroundColor: color,
              transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1.15] }) }],
              opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
            },
          ]}
        />
      ))}
    </View>
  )
}

// ── speaking: 流动波形 ──

const AnimatedPath = Animated.createAnimatedComponent(Path)

function Wave({ color, width, height, scale }: { color: string; width: number; height: number; scale: number }) {
  const offset = useRef(new Animated.Value(0)).current

  useEffect(() => {
    // 对齐 desktop si-wave-flow：dasharray 6 4，offset 0→-20，1.1s linear infinite
    const loop = Animated.loop(
      Animated.timing(offset, { toValue: -20, duration: 1100, easing: Easing.linear, useNativeDriver: false }),
    )
    loop.start()
    return () => loop.stop()
  }, [offset])

  // 正弦波 path（等比拼接铺满，不形变）
  const mid = height / 2
  const amp = height * 0.36
  const seg = 14 * scale
  let d = `M 0 ${mid}`
  for (let x = 0; x <= width; x += seg) {
    const up = (x / seg) % 2 === 0
    d += ` Q ${x + seg / 2} ${up ? mid - amp * 2 : mid + amp * 2} ${x + seg} ${mid}`
  }

  return (
    <Svg width={width} height={height}>
      <AnimatedPath
        d={d}
        stroke={color}
        strokeDasharray={`${6 * scale} ${4 * scale}`}
        strokeWidth={1.4 * scale}
        strokeLinecap="round"
        fill="none"
        strokeDashoffset={offset as unknown as number}
      />
    </Svg>
  )
}

export default function FairyStateIndicator({
  state,
  color = FAIRY_CYAN,
  scale = 0.6, // 手机端等比缩小（desktop 96×14 → 约 58×8.4）
}: Props) {
  const width = 96 * scale
  const height = 14 * scale
  return (
    <View style={{ width, height, justifyContent: 'center' }}>
      {state === 'listening' && <Bars color={color} height={height} scale={scale} />}
      {state === 'thinking' && <Dots color={color} height={height} scale={scale} />}
      {state === 'speaking' && <Wave color={color} width={width} height={height} scale={scale} />}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  bar: {},
  dot: {},
})
