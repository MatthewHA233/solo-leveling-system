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
//
// 状态机对齐 desktop FairyHUD 主循环（常量逐个照搬）：罗盘目标转速、音量→峰值、起音检测触发涟漪、
// 水滴波形。差异：tick 是 50ms（约 3 帧），每帧的插值系数换算成每 tick；
// 手机端整个眼组画在一个 SVG 里，涟漪按两组缩放（眼组 / 外圈），不是逐层错开；
// 光晕透明度随状态变化不搬（外观），voice://level 只有录音时才有，朗读时只有定时涟漪（和桌面端一样）。
// ══════════════════════════════════════════════

import { useEffect, useRef } from 'react'
import { Animated, DeviceEventEmitter, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'

export type FairyOrbState = 'idle' | 'listening' | 'thinking' | 'speaking'

interface Props {
  /** 球面（280 盘）的显示直径；光晕按比例向外溢出 */
  readonly size?: number
  readonly state?: FairyOrbState
  /** 受控注视方向（400 体系球心偏移）：提供时 listening 不再随机扫视，
   *  眼组 spring 看向该方向 —— 录音游走时「往哪跑就往哪看」用 */
  readonly gazeTarget?: { x: number; y: number } | null
}

// ── 状态机常量（desktop FairyHUD）──
const GYRO_TARGET: Record<FairyOrbState, number> = { idle: 0.3, listening: -0.6, thinking: 4.5, speaking: 1.2 }
const FRAMES_PER_TICK = 3 // 50ms tick ≈ 3 帧
const perTick = (framePull: number) => 1 - (1 - framePull) ** FRAMES_PER_TICK
const GYRO_PULL = perTick(0.05)
const PEAK_RISE = perTick(0.6)
const PEAK_DECAY = 0.95 ** FRAMES_PER_TICK
const LEVEL_STALE_MS = 400 // 音量事件超过这么久没更新就当静音

/** 录音 RMS → 动画用的 0~1 音量：先减底噪再放大 */
function levelToVolume(rms: number): number {
  return Math.min(1, Math.max(0, rms - 0.012) * 6)
}

/** 水滴波形：先收缩、再弹起、再衰减振荡 */
function dropletWave(age: number, delay: number): number {
  const t = (age - delay) / 1000
  if (t < 0) return 0
  if (t < 0.40) {
    const p = t / 0.40
    return -(1 - Math.cos(Math.PI * p)) * 0.5 * 0.40
  }
  if (t < 0.55) return -0.40
  if (t < 0.75) {
    const p = (t - 0.55) / 0.20
    return -0.40 + 1.40 * Math.sin(Math.PI * 0.5 * p)
  }
  if (t < 1.50) {
    const dt = t - 0.75
    return Math.exp(-4.5 * dt) * Math.cos(2 * Math.PI * 1.3 * dt)
  }
  return 0
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

export default function FairyOrb({ size = 46, state = 'idle', gazeTarget = null }: Props) {
  // size 指球面(280)直径 → 画布按 400 体系放大，光晕溢出按钮
  const canvas = (size * VB) / 280
  const stateRef = useRef(state)
  stateRef.current = state

  const eyeWave = useRef(new Animated.Value(1)).current
  const ringWave = useRef(new Animated.Value(1)).current
  const gyroDeg = useRef(new Animated.Value(0)).current
  const ballDeg = useRef(new Animated.Value(142)).current
  const eyeX = useRef(new Animated.Value(0)).current
  const eyeY = useRef(new Animated.Value(0)).current

  // 录音方广播的实时音量
  const levelRef = useRef({ value: 0, at: 0 })
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('voice://level', (payload: { level?: number }) => {
      if (typeof payload?.level === 'number') levelRef.current = { value: payload.level, at: Date.now() }
    })
    return () => sub.remove()
  }, [])

  // 主循环：罗盘转速（状态目标 + 说话时音量峰值）+ 起音涟漪
  useEffect(() => {
    let angle = 0
    let gyroSpeed = GYRO_TARGET.idle
    let audioPeak = 0
    let prevRawVol = 0
    let lastRippleTime = 0
    let ripples: { time: number; intensity: number }[] = []

    const timer = setInterval(() => {
      const current = stateRef.current
      const now = Date.now()
      gyroSpeed += (GYRO_TARGET[current] - gyroSpeed) * GYRO_PULL

      let rawVol = 0
      if ((current === 'listening' || current === 'speaking') && now - levelRef.current.at < LEVEL_STALE_MS) {
        rawVol = levelToVolume(levelRef.current.value)
      }
      if (rawVol > audioPeak) audioPeak += (rawVol - audioPeak) * PEAK_RISE
      else audioPeak *= PEAK_DECAY

      // 起音检测 + 涟漪
      const onset = rawVol > 0.08 && rawVol > prevRawVol * 1.15 + 0.015
      prevRawVol = rawVol
      if (current === 'listening' && onset && now - lastRippleTime > 180) {
        ripples.push({ time: now, intensity: Math.min(rawVol * 3.5, 1) })
        lastRippleTime = now
      }
      if (current === 'speaking' && onset && now - lastRippleTime > 120) {
        ripples.push({ time: now, intensity: Math.min(rawVol * 4.5, 1) })
        lastRippleTime = now
      }
      if ((current === 'listening' || current === 'speaking') && now - lastRippleTime > 2000) {
        ripples.push({ time: now, intensity: 0.5 })
        lastRippleTime = now
      }
      ripples = ripples.filter((r) => now - r.time < 2000)

      const stateMul = current === 'listening' ? 2.0 : current === 'speaking' ? 3.0 : 1.0
      const computeWave = (delay: number, amp: number): number => {
        if (current === 'idle' || current === 'thinking') return dropletWave(now % 2500, delay) * amp
        let total = 0
        for (const rip of ripples) total += dropletWave(now - rip.time, delay) * rip.intensity
        return total * amp * stateMul
      }
      eyeWave.setValue(1 + computeWave(70, 0.07))
      ringWave.setValue(1 + computeWave(260, 0.03))

      const effectiveSpeed = gyroSpeed + (current === 'speaking' ? audioPeak * 1.5 : 0)
      angle = (angle + effectiveSpeed * FRAMES_PER_TICK) % 360
      gyroDeg.setValue(angle)
    }, 50)
    return () => clearInterval(timer)
  }, [gyroDeg, eyeWave, ringWave])

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
  // gazeTarget 提供时改为受控注视（移动方向 = 注视方向）
  useEffect(() => {
    if (state !== 'listening') {
      Animated.parallel([
        Animated.timing(eyeX, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(eyeY, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start()
      return
    }
    if (gazeTarget) {
      const kk = canvas / VB
      Animated.parallel([
        Animated.spring(eyeX, { toValue: gazeTarget.x * kk, useNativeDriver: true, speed: 9, bounciness: 5 }),
        Animated.spring(eyeY, { toValue: gazeTarget.y * kk, useNativeDriver: true, speed: 9, bounciness: 5 }),
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
  }, [state, eyeX, eyeY, canvas, gazeTarget])

  const gyroRotate = gyroDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] })
  const ballRotate = ballDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] })

  const k = canvas / VB
  const ballD = 44 * k
  const orbit = 36 * k
  const off = (canvas - size) / 2 // 画布相对按钮的溢出偏移

  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: 'absolute',
          left: -off,
          top: -off,
          width: canvas,
          height: canvas,
        }}
      >
        {/* 底层：glow 三层 + bg-disc + thin-ring（gradient stop 逐值对照 desktop） */}
        <Animated.View
          pointerEvents="none"
          style={{ position: 'absolute', width: canvas, height: canvas, transform: [{ scale: ringWave }] }}
        >
        <Svg width={canvas} height={canvas} viewBox={`0 0 ${VB} ${VB}`}>
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
        </Animated.View>

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
            transform: [{ translateX: eyeX }, { translateY: eyeY }, { scale: eyeWave }],
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
      </View>
    </View>
  )
}
