// ══════════════════════════════════════════════
// FairyOrb — desktop FairyHUD 球体等比缩小版（逐值对照 desktop CSS）
// 统一用 desktop 的 px 体系（400 容器，中心 200）：
//   glow-halo  d360: radial 78%→93%, 峰值 82.6% rgba(36,102,157,.95), base op .70
//   glow-halo2 d350: radial 77%→91%, 峰值 83%  rgba(40,110,165,.50), op .7×.7
//   glow-ring  d300: radial 91%→100%, 峰值 95% rgba(60,140,200,1),   base op .75
//   bg-disc d280 rgb(11,46,104) / thin-ring border #3d78b9
//   gyro 罗盘: 340 viewBox path 显示为 280px（×280/340 缩放）
//   thick-white d180 / inner d136 / boundary d106 / iris d100
//   / outline d74 / void d70 / pupil d92+d64 / ball d44 轨道36 角142°
// 球外透明（desktop 为透明窗口，无任何底色）。
// ══════════════════════════════════════════════

import { useEffect, useRef } from 'react'
import { Animated, Easing, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'

export type FairyOrbState = 'idle' | 'listening' | 'thinking' | 'speaking'

interface Props {
  /** 球面（280 盘）的显示直径；光晕按比例向外溢出 */
  readonly size?: number
  readonly state?: FairyOrbState
}

const VB = 400
const C = 200
const GYRO_SCALE = 280 / 340 // desktop: svg width 280 viewBox 340

const GYRO_PATH =
  'M 151.7 27.4 L 170 5 L 188.3 27.4 ' +
  'A 145 145 0 0 1 312.6 151.7 ' +
  'L 335 170 L 312.6 188.3 ' +
  'A 145 145 0 0 1 188.3 312.6 ' +
  'L 170 335 L 151.7 312.6 ' +
  'A 145 145 0 0 1 27.4 188.3 ' +
  'L 5 170 L 27.4 151.7 ' +
  'A 145 145 0 0 1 151.7 27.4 Z'

export default function FairyOrb({ size = 46, state = 'idle' }: Props) {
  // size 指球面(280)直径 → 画布按 400 体系放大，光晕溢出按钮
  const canvas = (size * VB) / 280
  const stateRef = useRef(state)
  stateRef.current = state

  const breath = useRef(new Animated.Value(0)).current
  const gyroDeg = useRef(new Animated.Value(0)).current
  const ballDeg = useRef(new Animated.Value(142)).current
  const eyeX = useRef(new Animated.Value(0)).current
  const eyeY = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const b = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: 1250, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: 1250, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    )
    b.start()
    return () => b.stop()
  }, [breath])

  // gyro：desktop gyroSpeed 0.3°/帧(60fps)；speaking + audioPeak 提速
  useEffect(() => {
    let angle = 0
    const timer = setInterval(() => {
      const speed = stateRef.current === 'speaking' ? 0.9 : 0.3
      angle = (angle + speed * 3) % 360 // 50ms tick ≈ 3 帧
      gyroDeg.setValue(angle)
    }, 50)
    return () => clearInterval(timer)
  }, [gyroDeg])

  // ball：142° + desktop 同款三正弦漂移
  useEffect(() => {
    let t = 0
    const timer = setInterval(() => {
      t += 0.05
      const drift = Math.sin(t * 0.3) * 4 + Math.sin(t * 0.47) * 2.5 + Math.sin(t * 0.71) * 1.5
      ballDeg.setValue(142 + drift)
    }, 50)
    return () => clearInterval(timer)
  }, [ballDeg])

  // listening：saccade（600~2000ms 随机注视点，半径 18~43px desktop 体系）
  useEffect(() => {
    if (state !== 'listening') {
      Animated.parallel([
        Animated.timing(eyeX, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(eyeY, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start()
      return
    }
    const k = canvas / VB
    let alive = true
    const move = () => {
      if (!alive) return
      const angle = Math.random() * Math.PI * 2
      const radius = (18 + Math.random() * 25) * k
      Animated.parallel([
        Animated.spring(eyeX, { toValue: Math.cos(angle) * radius * 1.3, useNativeDriver: true, speed: 6, bounciness: 4 }),
        Animated.spring(eyeY, { toValue: Math.sin(angle) * radius * 0.8, useNativeDriver: true, speed: 6, bounciness: 4 }),
      ]).start()
      setTimeout(() => move(), 600 + Math.random() * 1400)
    }
    move()
    return () => { alive = false }
  }, [state, eyeX, eyeY, canvas])

  const scale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1, state === 'listening' || state === 'speaking' ? 1.06 : 1.03],
  })
  const gyroRotate = gyroDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] })
  const ballRotate = ballDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] })

  const k = canvas / VB
  const ballD = 44 * k
  const orbit = 36 * k
  const off = (canvas - size) / 2 // 画布相对按钮的溢出偏移

  return (
    <View style={{ width: size, height: size }}>
      <Animated.View
        style={{
          position: 'absolute',
          left: -off,
          top: -off,
          width: canvas,
          height: canvas,
          transform: [{ scale }],
        }}
      >
        {/* 底层：glow 三层 + bg-disc + thin-ring（gradient stop 逐值对照 desktop） */}
        <Svg width={canvas} height={canvas} viewBox={`0 0 ${VB} ${VB}`} style={{ position: 'absolute' }}>
          {/* HUD 蓝色光环（干净单圈 + 窄柔边） */}
          <Circle cx={C} cy={C} r={147} fill="none" stroke="rgba(60,160,235,0.40)" strokeWidth={13} />
          <Circle cx={C} cy={C} r={146} fill="none" stroke="rgba(80,200,255,1)" strokeWidth={7} />
          {/* bg-disc d280 */}
          <Circle cx={C} cy={C} r={140} fill="rgb(11,46,104)" />
          {/* 罗盘外侧相邻环带：提亮一档，深色四角在其上转动时清晰可辨 */}
          <Circle cx={C} cy={C} r={129.5} fill="none" stroke="rgb(22,70,138)" strokeWidth={21} />
          {/* thin-ring：border 2 #3d78b9 + 外发光近似(desktop 多重 box-shadow) */}
          <Circle cx={C} cy={C} r={141.5} fill="none" stroke="rgba(50,120,175,0.85)" strokeWidth={5} />
          <Circle cx={C} cy={C} r={140} fill="none" stroke="#3d78b9" strokeWidth={2} />
        </Svg>

        {/* gyro 罗盘（340 体系 path 显示为 280px，旋转层） */}
        <Animated.View
          pointerEvents="none"
          style={{ position: 'absolute', width: canvas, height: canvas, transform: [{ rotate: gyroRotate }] }}
        >
          <Svg width={canvas} height={canvas} viewBox={`0 0 ${VB} ${VB}`}>
            <Path
              d={GYRO_PATH}
              fill="rgb(7,22,72)"
              transform={`translate(${C - 170 * GYRO_SCALE} ${C - 170 * GYRO_SCALE}) scale(${GYRO_SCALE})`}
            />
          </Svg>
        </Animated.View>

        {/* 眼组（saccade 平移层） */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute', width: canvas, height: canvas,
            transform: [{ translateX: eyeX }, { translateY: eyeY }],
          }}
        >
          <Svg width={canvas} height={canvas} viewBox={`0 0 ${VB} ${VB}`}>
            <Circle cx={C} cy={C} r={90} fill="#ffffff" />
            <Circle cx={C} cy={C} r={68} fill="rgb(166,182,219)" />
            <Circle cx={C} cy={C} r={53} fill="rgb(182,216,242)" />
            <Circle cx={C} cy={C} r={50} fill="rgb(12,97,162)" />
            <Circle cx={C} cy={C} r={37} fill="rgb(160,185,220)" />
            <Circle cx={C} cy={C} r={35} fill="rgb(6,53,120)" />
            <Circle cx={C} cy={C} r={46} fill="none" stroke="rgba(100,180,255,0.15)" strokeWidth={1} />
            <Circle cx={C} cy={C} r={32} fill="none" stroke="rgba(100,180,255,0.25)" strokeWidth={2} />
          </Svg>

          {/* 卫星白球 d44，轨道 36 */}
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute', width: canvas, height: canvas,
              alignItems: 'center',
              transform: [{ rotate: ballRotate }],
            }}
          >
            <View
              style={{
                position: 'absolute',
                top: canvas / 2 - orbit - ballD / 2,
                width: ballD,
                height: ballD,
                borderRadius: ballD / 2,
                backgroundColor: '#ffffff',
                shadowColor: '#7fc4ff',
                shadowOpacity: 0.9,
                shadowRadius: 3,
                shadowOffset: { width: 0, height: 0 },
                elevation: 2,
              }}
            />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  )
}
