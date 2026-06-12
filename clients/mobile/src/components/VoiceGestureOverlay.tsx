// ══════════════════════════════════════════════
// VoiceGestureOverlay — 全局按住说话手势浮层（微信「按住说话」式布局）
// 中央按钮长按触发；原位松手 = 发送，上滑到取消钮带 = 取消
// 底部大弧形录音面板（声波 + 计时），取消钮悬在面板上方拇指可达处
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import FairyStateIndicator from './FairyStateIndicator'
import FairyOrb from './FairyOrb'

export type VoiceZone = 'send' | 'cancel'

interface Props {
  readonly visible: boolean
  readonly zone: VoiceZone
  readonly recordMs: number
  /** 游走 fairy 跑回中央按钮原位后回调（TabBar 球此刻再现身） */
  readonly onReturnedHome?: () => void
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ── 录音时的游走 fairy：从中央按钮原位跑出来，先看向目标再跑过去；
//    退出长按时先看向家的方向、跑回原位并缩回 TabBar 球尺寸 ──
const ROAM_SIZE = 64
const HOME_ORB_SIZE = 46 // TabBar 中央 FairyOrb 尺寸

function RoamingFairy({
  W,
  H,
  returning,
  onReturned,
}: {
  W: number
  H: number
  returning: boolean
  onReturned: () => void
}) {
  // 家 = TabBar 中央按钮处的球心（约距屏幕底 105）
  const homeX = W / 2 - ROAM_SIZE / 2
  const homeY = H - 105 - ROAM_SIZE / 2
  const pos = useRef(new Animated.ValueXY({ x: homeX, y: homeY })).current
  const scale = useRef(new Animated.Value(HOME_ORB_SIZE / ROAM_SIZE)).current
  const curRef = useRef({ x: homeX, y: homeY })
  const [gaze, setGaze] = useState<{ x: number; y: number }>({ x: 0, y: -40 })
  // 回调 ref 化：松手后父组件还会因 recordMs 归零/面板弹出而重渲染，
  // 不稳定的函数引用会反复重启回家 effect
  const onReturnedRef = useRef(onReturned)
  onReturnedRef.current = onReturned

  useEffect(() => {
    if (returning) return
    // 出场放大到游走尺寸
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 6 }).start()
    let alive = true
    const timers: ReturnType<typeof setTimeout>[] = []
    const hop = () => {
      if (!alive) return
      // 游走范围：屏幕上中部（避开底部弧形面板与取消钮带）
      const tx = W * 0.08 + Math.random() * (W * 0.84 - ROAM_SIZE)
      const ty = H * 0.10 + Math.random() * H * 0.42
      const cur = curRef.current
      const dx = tx - cur.x
      const dy = ty - cur.y
      const len = Math.hypot(dx, dy) || 1
      // 1) 眼睛先看向要去的方向（400 体系幅度）
      setGaze({ x: (dx / len) * 42, y: (dy / len) * 30 })
      // 2) 看了一拍再起步跑过去，远的跑久一点
      timers.push(setTimeout(() => {
        if (!alive) return
        curRef.current = { x: tx, y: ty }
        Animated.timing(pos, {
          toValue: { x: tx, y: ty },
          duration: 520 + len * 0.9,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }).start()
      }, 240))
      timers.push(setTimeout(hop, 1500 + Math.random() * 1300))
    }
    hop()
    return () => {
      alive = false
      timers.forEach(clearTimeout)
    }
  }, [W, H, pos, scale, returning])

  // 回家：看向家的方向 → 跑回原位 + 缩回 TabBar 球尺寸 → 通知现身
  useEffect(() => {
    if (!returning) return
    const cur = curRef.current
    const dx = homeX - cur.x
    const dy = homeY - cur.y
    const len = Math.hypot(dx, dy) || 1
    setGaze({ x: (dx / len) * 42, y: (dy / len) * 30 })
    const run = Animated.parallel([
      Animated.timing(pos, {
        toValue: { x: homeX, y: homeY },
        duration: 560,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: HOME_ORB_SIZE / ROAM_SIZE,
        duration: 560,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    ])
    run.start(({ finished }) => {
      if (finished) {
        curRef.current = { x: homeX, y: homeY }
        onReturnedRef.current()
      }
    })
    return () => run.stop()
  }, [returning, homeX, homeY, pos, scale])

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: ROAM_SIZE,
        height: ROAM_SIZE,
        transform: [{ translateX: pos.x }, { translateY: pos.y }, { scale }],
      }}
    >
      <FairyOrb size={ROAM_SIZE} state="listening" gazeTarget={gaze} />
    </Animated.View>
  )
}

export default function VoiceGestureOverlay({ visible, zone, recordMs, onReturnedHome }: Props) {
  const { width: W, height: H } = useWindowDimensions()
  // 松手后浮层 UI 立即消失，但 fairy 留下来跑回原位（mounted 延迟到回家完成）
  const [mounted, setMounted] = useState(visible)
  useEffect(() => {
    if (visible) setMounted(true)
  }, [visible])
  if (!mounted) return null
  const returning = !visible

  const cancelOn = zone === 'cancel'
  // 弧形面板：超宽圆角矩形伸出屏幕底，只露出顶部一段弧
  const arcW = W * 1.5
  const arcH = 300
  const arcVisible = 132

  // 注意：RoamingFairy 必须在同一树位置渲染（returning 切换不卸载重建），
  // 否则位置/注视状态丢失，回家动画会原地闪现
  return (
    <View style={returning ? styles.rootClear : styles.root} pointerEvents="none">
      {/* 游走 fairy：从中央按钮原位跑出来，看哪跑哪；松手跑回原位 */}
      <RoamingFairy
        W={W}
        H={H}
        returning={returning}
        onReturned={() => {
          setMounted(false)
          onReturnedHome?.()
        }}
      />

      {!returning && (
        <>
          {/* 提示文字（取消钮上方） */}
          <Text style={[styles.hint, cancelOn && styles.hintCancel]}>
            {cancelOn ? '松开 取消' : '松开 发送 · 上滑 取消'}
          </Text>

          {/* 取消钮：屏幕中下部居中，拇指上滑可达 */}
          <View style={[styles.cancelBtn, cancelOn && styles.cancelBtnOn]}>
            <Text style={[styles.cancelIcon, cancelOn && styles.cancelIconOn]}>×</Text>
          </View>

          {/* 底部弧形录音面板 */}
          <View
            style={[
              styles.arc,
              {
                width: arcW,
                height: arcH,
                left: (W - arcW) / 2,
                bottom: arcVisible - arcH,
                borderTopLeftRadius: arcW / 2,
                borderTopRightRadius: arcW / 2,
              },
              cancelOn && styles.arcCancel,
            ]}
          >
            <View style={styles.arcInner}>
              {cancelOn ? (
                <Text style={styles.arcCancelText}>松开手指取消发送</Text>
              ) : (
                <>
                  <FairyStateIndicator state="listening" scale={0.75} />
                  <Text style={styles.time}>{fmtMs(recordMs)}</Text>
                </>
              )}
            </View>
          </View>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 90,
    backgroundColor: 'rgba(10, 12, 18, 0.55)',
  },
  rootClear: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 90,
  },
  hint: {
    position: 'absolute',
    bottom: '41%',
    alignSelf: 'center',
    fontSize: 13,
    color: 'rgba(255,255,255,0.65)',
  },
  hintCancel: { color: 'rgba(255,120,120,0.95)' },
  cancelBtn: {
    position: 'absolute',
    bottom: '30%',
    alignSelf: 'center',
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnOn: {
    backgroundColor: '#E5484D',
    transform: [{ scale: 1.18 }],
  },
  cancelIcon: { fontSize: 30, color: 'rgba(255,255,255,0.85)', fontWeight: '600', lineHeight: 34 },
  cancelIconOn: { color: '#FFFFFF' },
  arc: {
    position: 'absolute',
    backgroundColor: 'rgb(13, 30, 64)',
    borderWidth: 1.5,
    borderColor: 'rgba(80, 200, 255, 0.35)',
    alignItems: 'center',
  },
  arcCancel: {
    backgroundColor: 'rgb(36, 18, 24)',
    borderColor: 'rgba(255, 110, 110, 0.35)',
  },
  arcInner: {
    marginTop: 34,
    alignItems: 'center',
    gap: 10,
  },
  time: { fontSize: 16, fontWeight: '700', color: 'rgba(160, 215, 255, 0.95)', fontVariant: ['tabular-nums'] },
  arcCancelText: { marginTop: 14, fontSize: 13, color: 'rgba(255, 150, 150, 0.85)' },
})
